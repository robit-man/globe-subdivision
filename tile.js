import * as THREE from 'three';
import { EARTH_RADIUS_M } from './constants.js';
import {
  createHighLowPositionAttributes
} from './precision.js';

/**
 * Terrain Tile - Cesium-style quadtree tile
 *
 * Each tile:
 * - Has geographic bounds (west, south, east, north in radians)
 * - Has a level (0 = root, increases with subdivision)
 * - Stores vertices in LOCAL coordinates relative to tile center
 * - Has its own mesh positioned at tile center
 * - Can subdivide into 4 children (NW, NE, SW, SE)
 */

export const TileState = {
  UNLOADED: 'UNLOADED',     // No geometry yet
  LOADING: 'LOADING',       // Requesting geometry
  READY: 'READY',           // Geometry loaded, ready to render
  RENDERED: 'RENDERED',     // Currently visible
  UPSAMPLED: 'UPSAMPLED'    // Using parent data temporarily
};

export class Tile {
  constructor(options = {}) {
    // Geographic bounds (radians)
    this.west = options.west ?? 0;
    this.south = options.south ?? 0;
    this.east = options.east ?? 0;
    this.north = options.north ?? 0;

    // Tile level (0 = root)
    this.level = options.level ?? 0;

    // Tile x,y within level
    this.x = options.x ?? 0;
    this.y = options.y ?? 0;

    // Parent and children tiles
    this.parent = options.parent ?? null;
    this.children = null; // [NW, NE, SW, SE]

    // Tile state
    this.state = TileState.UNLOADED;

    // Three.js mesh and geometry
    this.mesh = null;
    this.geometry = null;
    this.material = null;
    this.wireframe = null;

    // Tile center in world coordinates (computed once)
    this.center = this._computeCenter();

    // Bounding sphere for culling
    this.boundingSphere = new THREE.Sphere(this.center, this._computeRadius());

    // Screen-space error (computed per frame)
    this.sse = 0;

    // Distance from camera (computed per frame)
    this.distance = Infinity;

    // Elevation data
    this.elevationData = null;
    this.elevationMin = 0;
    this.elevationMax = 0;
    this.hasElevation = false;

    // Vertex lat/lon data (for elevation fetching)
    this.latLons = null; // Float32Array of [lat, lon, lat, lon, ...]

    // Vertex metadata
    this.vertexData = new Map();

    // Frame tracking
    this.lastVisibleFrame = 0;
    this.lastUpdateFrame = 0;
  }

  /**
   * Compute tile center in world Cartesian coordinates
   */
  _computeCenter() {
    const centerLon = (this.west + this.east) / 2;
    const centerLat = (this.south + this.north) / 2;

    const center = this._latLonToCartesian(centerLat, centerLon, 0);

    // Validate center
    if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(center.z)) {
      console.error('[Tile] Invalid center computed:', {
        west: this.west, south: this.south, east: this.east, north: this.north,
        centerLon, centerLat, center
      });
    }

    return center;
  }

  /**
   * Compute tile bounding sphere radius
   */
  _computeRadius() {
    // Sample tile corners to find max distance from center
    const corners = [
      this._latLonToCartesian(this.south, this.west, 0),
      this._latLonToCartesian(this.south, this.east, 0),
      this._latLonToCartesian(this.north, this.west, 0),
      this._latLonToCartesian(this.north, this.east, 0)
    ];

    let maxDist = 0;
    for (const corner of corners) {
      const dist = corner.distanceTo(this.center);
      maxDist = Math.max(maxDist, dist);
    }

    // Add buffer for elevation
    return maxDist + 10000; // +10km for elevation
  }

  /**
   * Convert lat/lon/height to Cartesian coordinates
   */
  _latLonToCartesian(lat, lon, height) {
    const radius = EARTH_RADIUS_M + height;
    const x = radius * Math.cos(lat) * Math.cos(lon);
    const y = radius * Math.cos(lat) * Math.sin(lon);
    const z = radius * Math.sin(lat);
    return new THREE.Vector3(x, y, z);
  }

  /**
   * Create tile mesh with local coordinates
   */
  createMesh(scene, material) {
    if (this.mesh) return; // Already created

    // Create empty geometry (will be populated by worker)
    this.geometry = new THREE.BufferGeometry();

    // Use provided material or create default
    this.material = material || new THREE.MeshBasicMaterial({
      color: 0x808080,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1
    });

    // Create mesh
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = `tile-${this.level}-${this.x}-${this.y}`;
    this.mesh.position.copy(this.center);
    this.mesh.frustumCulled = false; // We do custom culling
    this.mesh.userData.tile = this; // Back-reference

    // Create wireframe
    const wireframeMaterial = new THREE.LineBasicMaterial({
      color: 0x00ff00,
      transparent: true,
      opacity: 0.3,
      depthTest: true,
      depthWrite: false
    });

    const wireframeGeometry = new THREE.BufferGeometry();
    this.wireframe = new THREE.LineSegments(wireframeGeometry, wireframeMaterial);
    this.wireframe.name = `tile-wireframe-${this.level}-${this.x}-${this.y}`;
    this.wireframe.position.copy(this.center);
    this.wireframe.frustumCulled = false;

    scene.add(this.mesh);
    scene.add(this.wireframe);

    this.mesh.visible = false;
    this.wireframe.visible = false;
  }

  /**
   * Update tile geometry with vertex data
   * Vertices should be FLAT ARRAY in WORLD coordinates [x,y,z,x,y,z,...], will be converted to LOCAL
   */
  updateGeometry(vertices, indices) {
    if (!this.geometry) return;

    // Validate tile center
    if (!Number.isFinite(this.center.x) || !Number.isFinite(this.center.y) || !Number.isFinite(this.center.z)) {
      console.error(`[Tile ${this.getKey()}] Invalid tile center:`, this.center);
      return;
    }

    const vertexCount = vertices.length / 3;
    const localPositions = new Float32Array(vertices.length);

    // Convert world positions to local (relative to tile center)
    for (let i = 0; i < vertexCount; i++) {
      const wx = vertices[i * 3];
      const wy = vertices[i * 3 + 1];
      const wz = vertices[i * 3 + 2];

      // Check for NaN in input vertices
      if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) {
        console.error(`[Tile ${this.getKey()}] NaN in input vertices at index ${i}:`, { wx, wy, wz });
        return;
      }

      localPositions[i * 3] = wx - this.center.x;
      localPositions[i * 3 + 1] = wy - this.center.y;
      localPositions[i * 3 + 2] = wz - this.center.z;
    }

    // Set geometry attributes
    this.geometry.setAttribute('position', new THREE.BufferAttribute(localPositions, 3));

    // NO high/low attributes needed - we're using mesh.position + local coords, not RTE shaders

    if (indices) {
      this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    }

    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
    this.geometry.computeBoundingBox();

    // Update wireframe
    if (this.wireframe?.geometry) {
      this.wireframe.geometry.setAttribute('position', new THREE.BufferAttribute(localPositions, 3));
      if (indices) {
        this.wireframe.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      }
      this.wireframe.geometry.computeBoundingSphere();
      this.wireframe.geometry.computeBoundingBox();
    }

    this.state = TileState.READY;
  }

  /**
   * Compute screen-space error for this tile
   */
  computeSSE(camera) {
    // Distance from camera to tile center
    this.distance = camera.position.distanceTo(this.center);

    // Geometric error (how much detail we're missing)
    // Higher levels have lower error (more detail)
    const geometricError = this._getGeometricError();

    // Screen-space error = (error * viewport_height) / (distance * 2 * tan(fov/2))
    const fovY = camera.fov * Math.PI / 180;
    const viewportHeight = window.innerHeight || 1080;

    this.sse = (geometricError * viewportHeight) / (this.distance * 2 * Math.tan(fovY / 2));

    return this.sse;
  }

  /**
   * Get geometric error for this tile level
   * Lower levels (coarser) have higher error
   *
   * Cesium uses much more conservative geometric error to prevent over-subdivision
   */
  _getGeometricError() {
    // Root tile geometric error (Cesium typically uses much smaller values)
    // Using circumference-based error similar to Cesium
    const rootError = EARTH_RADIUS_M * Math.PI / 4; // Quarter of Earth's circumference at equator
    return rootError / Math.pow(2, this.level);
  }

  /**
   * Should this tile be refined (split into children)?
   *
   * Cesium-style LOD with VERY conservative distance-based culling to prevent over-subdivision in orbit
   */
  shouldRefine(sseThreshold = 16) {
    // Calculate camera altitude first for adaptive SSE threshold
    const cameraAltitude = this.distance - EARTH_RADIUS_M;
    const altitudeRatio = cameraAltitude / EARTH_RADIUS_M;

    // Apply MUCH stricter SSE threshold when in orbit to prevent excessive subdivision
    // The farther away, the higher the threshold (less subdivision)
    let adaptiveSSE = sseThreshold;
    if (altitudeRatio > 3) {
      adaptiveSSE = sseThreshold * 4; // 4x stricter in very high orbit
    } else if (altitudeRatio > 2) {
      adaptiveSSE = sseThreshold * 3; // 3x stricter in high orbit
    } else if (altitudeRatio > 1) {
      adaptiveSSE = sseThreshold * 2; // 2x stricter in medium orbit
    } else if (altitudeRatio > 0.5) {
      adaptiveSSE = sseThreshold * 1.5; // 1.5x stricter in low orbit
    }

    // Don't refine if SSE is below adaptive threshold
    if (this.sse <= adaptiveSSE) {
      return false;
    }

    // VERY strict altitude-based level limits to prevent excessive subdivision in orbit
    // These are HARD caps - tiles will NOT subdivide beyond these levels at each altitude
    let maxLevelForAltitude;

    if (altitudeRatio > 5) {
      maxLevelForAltitude = 2;  // Very far orbit - only 2 levels of detail
    } else if (altitudeRatio > 3) {
      maxLevelForAltitude = 3;  // Far orbit - only 3 levels
    } else if (altitudeRatio > 2) {
      maxLevelForAltitude = 4;  // High orbit - only 4 levels
    } else if (altitudeRatio > 1) {
      maxLevelForAltitude = 6;  // Medium orbit - 6 levels
    } else if (altitudeRatio > 0.5) {
      maxLevelForAltitude = 8;  // Low orbit - 8 levels
    } else if (altitudeRatio > 0.2) {
      maxLevelForAltitude = 12; // Very low orbit - 12 levels
    } else if (altitudeRatio > 0.05) {
      maxLevelForAltitude = 15; // Near surface - 15 levels
    } else {
      maxLevelForAltitude = 18; // Surface level - full detail
    }

    // Don't refine if we're beyond the max level for this altitude
    if (this.level >= maxLevelForAltitude) {
      return false;
    }

    return true;
  }

  /**
   * Subdivide tile into 4 children
   */
  subdivide() {
    if (this.children) return this.children; // Already subdivided

    const midLon = (this.west + this.east) / 2;
    const midLat = (this.south + this.north) / 2;
    const childLevel = this.level + 1;

    // Create 4 children: SW, SE, NW, NE
    this.children = [
      // Southwest
      new Tile({
        west: this.west,
        south: this.south,
        east: midLon,
        north: midLat,
        level: childLevel,
        x: this.x * 2,
        y: this.y * 2,
        parent: this
      }),
      // Southeast
      new Tile({
        west: midLon,
        south: this.south,
        east: this.east,
        north: midLat,
        level: childLevel,
        x: this.x * 2 + 1,
        y: this.y * 2,
        parent: this
      }),
      // Northwest
      new Tile({
        west: this.west,
        south: midLat,
        east: midLon,
        north: this.north,
        level: childLevel,
        x: this.x * 2,
        y: this.y * 2 + 1,
        parent: this
      }),
      // Northeast
      new Tile({
        west: midLon,
        south: midLat,
        east: this.east,
        north: this.north,
        level: childLevel,
        x: this.x * 2 + 1,
        y: this.y * 2 + 1,
        parent: this
      })
    ];

    return this.children;
  }

  /**
   * Check if tile is visible in camera frustum
   */
  isVisible(camera) {
    // For now, disable culling to debug - Three.js will handle it automatically
    // TODO: Implement proper Cesium-style culling with horizon and frustum checks
    return true;

    /* DISABLED CULLING - causing issues
    // Frustum culling
    const frustum = new THREE.Frustum();
    const projScreenMatrix = new THREE.Matrix4();
    projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreenMatrix);

    if (!frustum.intersectsSphere(this.boundingSphere)) {
      return false;
    }

    // Horizon culling (tile behind planet horizon)
    const cameraDistance = camera.position.length();
    const horizonDistance = Math.sqrt(cameraDistance * cameraDistance - EARTH_RADIUS_M * EARTH_RADIUS_M);

    if (this.distance > horizonDistance + this.boundingSphere.radius) {
      return false;
    }

    return true;
    */
  }

  /**
   * Show this tile
   */
  show() {
    if (this.mesh) this.mesh.visible = true;
    if (this.wireframe) this.wireframe.visible = true;
    this.state = TileState.RENDERED;
  }

  /**
   * Hide this tile
   */
  hide() {
    if (this.mesh) this.mesh.visible = false;
    if (this.wireframe) this.wireframe.visible = false;
    if (this.state === TileState.RENDERED) {
      this.state = TileState.READY;
    }
  }

  /**
   * Dispose tile resources
   */
  dispose(scene) {
    if (this.mesh) {
      scene.remove(this.mesh);
      this.mesh = null;
    }
    if (this.wireframe) {
      scene.remove(this.wireframe);
      this.wireframe = null;
    }
    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }

    // Dispose children
    if (this.children) {
      for (const child of this.children) {
        child.dispose(scene);
      }
      this.children = null;
    }
  }

  /**
   * Get tile identifier string
   */
  getKey() {
    return `${this.level}-${this.x}-${this.y}`;
  }
}
