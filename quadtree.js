import * as THREE from 'three';
import { Tile, TileState } from './tile.js';
import { injectCameraRelativeShader } from './precision.js';
import { requestTileWithElevation } from './tileElevation.js';
import { EARTH_RADIUS_M } from './constants.js';

/**
 * QuadtreeManager - Cesium-style terrain tile quadtree
 *
 * Manages:
 * - Root tiles (level 0)
 * - Tile selection based on screen-space error
 * - Tile visibility and rendering
 * - Tile geometry requests
 */

export class QuadtreeManager {
  constructor(scene, options = {}) {
    this.scene = scene;

    // Tile selection parameters (VERY conservative for performance)
    this.sseThreshold = options.sseThreshold ?? 32; // Screen-space error threshold (higher = less subdivision, better performance)
    this.maxLevel = options.maxLevel ?? 18; // Maximum tile level
    this.maxVisibleTiles = options.maxVisibleTiles ?? 300; // Limit tiles for performance
    this.maxTileLoadsPerFrame = options.maxTileLoadsPerFrame ?? 2; // Limit geometry requests per frame
    this.maxElevationFetchesPerFrame = options.maxElevationFetchesPerFrame ?? 1; // Limit elevation fetches per frame
    this.enableElevation = options.enableElevation ?? true; // Fetch elevation data over NKN
    this.tileUnloadDistance = options.tileUnloadDistance ?? 3; // Unload tiles beyond this many levels from camera

    // Root tiles (level 0)
    this.rootTiles = [];

    // All active tiles (flat map for quick lookup)
    this.allTiles = new Map(); // key -> Tile

    // Tiles to render this frame
    this.tilesToRender = [];

    // Tiles to load this frame
    this.tilesToLoad = [];

    // Frame counter
    this.frameNumber = 0;

    // Camera for selection
    this.camera = null;

    // Statistics
    this.stats = {
      visibleTiles: 0,
      loadedTiles: 0,
      renderingTiles: 0,
      totalTiles: 0,
      maxLevel: 0
    };

    // Material for tiles (NO RTE shader needed - tiles use mesh.position + local coords)
    this.tileMaterial = new THREE.MeshBasicMaterial({
      color: 0x808080,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      wireframe: false
    });

    // NO RTE shader injection for tiles!
    // Tiles already use local coordinates (mesh.position + local vertices = world position)
    // Applying RTE would double-transform and collapse everything to origin

    // Worker for tile generation
    this.worker = null;
    this.workerReady = false;
    this.pendingRequests = new Map(); // tileKey -> {tile, callback}

    // Elevation fetch tracking
    this.pendingElevationFetches = new Set(); // tileKey -> actively fetching elevation
    this.elevationFetchesThisFrame = 0;

    // Initialize root tiles
    this._createRootTiles();
  }

  /**
   * Create root level tiles (level 0)
   * Using simple lat/lon grid: 2x1 tiles (west/east hemispheres)
   */
  _createRootTiles() {
    const PI = Math.PI;

    // Create 2 root tiles (west and east hemispheres)
    const rootConfigs = [
      // Western hemisphere
      { west: -PI, south: -PI/2, east: 0, north: PI/2, x: 0, y: 0 },
      // Eastern hemisphere
      { west: 0, south: -PI/2, east: PI, north: PI/2, x: 1, y: 0 }
    ];

    for (const config of rootConfigs) {
      const tile = new Tile({
        west: config.west,
        south: config.south,
        east: config.east,
        north: config.north,
        level: 0,
        x: config.x,
        y: config.y
      });

      tile.createMesh(this.scene, this.tileMaterial);
      this.rootTiles.push(tile);
      this.allTiles.set(tile.getKey(), tile);
    }

    console.log(`✅ Quadtree initialized with ${this.rootTiles.length} root tiles`);
  }

  /**
   * Initialize terrain worker for tile generation
   */
  initWorker(workerUrl) {
    if (typeof Worker === 'undefined') {
      console.warn('[quadtree] Web Workers not supported');
      return;
    }

    try {
      this.worker = new Worker(workerUrl, { type: 'module' });
      this.worker.onmessage = (e) => this._handleWorkerMessage(e);
      this.worker.onerror = (e) => console.error('[quadtree] Worker error:', e);
    } catch (err) {
      console.error('[quadtree] Failed to create worker:', err);
    }
  }

  /**
   * Handle worker messages
   */
  _handleWorkerMessage(event) {
    const { type, payload } = event.data;

    switch (type) {
      case 'ready':
        this.workerReady = true;
        console.log('✅ Quadtree worker ready');
        break;

      case 'tile:geometry':
        this._handleTileGeometry(payload);
        break;

      case 'error':
        console.error('[quadtree] Worker error:', payload);
        break;
    }
  }

  /**
   * Handle tile geometry from worker
   */
  _handleTileGeometry(payload) {
    const { tileKey, vertices, indices, latLons, hasElevation } = payload;
    const request = this.pendingRequests.get(tileKey);

    if (!request) {
      console.warn(`[quadtree] Received geometry for unknown tile: ${tileKey}`);
      return;
    }

    const { tile, callback } = request;

    // Store lat/lon data for elevation fetching
    if (latLons) {
      tile.latLons = latLons;
    }

    // Update elevation status
    tile.hasElevation = hasElevation || false;

    // Update tile geometry (vertices and indices are already typed arrays from worker)
    tile.updateGeometry(vertices, indices);

    // Cleanup
    this.pendingRequests.delete(tileKey);

    // Callback
    if (callback) callback(tile);

    // Fetch elevation data if enabled and not already present
    // Throttle elevation fetches to prevent overwhelming the system
    if (this.enableElevation && !hasElevation && tile.latLons) {
      if (this.elevationFetchesThisFrame < this.maxElevationFetchesPerFrame &&
          !this.pendingElevationFetches.has(tileKey)) {

        this.elevationFetchesThisFrame++;
        this.pendingElevationFetches.add(tileKey);

        // Trigger async elevation fetch (fire and forget)
        requestTileWithElevation(tile, this).catch(err => {
          console.warn(`[quadtree] Failed to fetch elevation for tile ${tileKey}:`, err.message);
        }).finally(() => {
          this.pendingElevationFetches.delete(tileKey);
        });
      }
    }
  }

  /**
   * Request geometry for a tile
   */
  requestTileGeometry(tile, callback) {
    if (!this.worker || !this.workerReady) {
      console.warn('[quadtree] Worker not ready, cannot request tile geometry');
      return;
    }

    const tileKey = tile.getKey();

    // Don't request if already pending
    if (this.pendingRequests.has(tileKey)) {
      return;
    }

    // Mark as loading
    tile.state = TileState.LOADING;
    this.pendingRequests.set(tileKey, { tile, callback });

    // Send request to worker
    this.worker.postMessage({
      type: 'tile:request',
      payload: {
        tileKey,
        west: tile.west,
        south: tile.south,
        east: tile.east,
        north: tile.north,
        level: tile.level
      }
    });
  }

  /**
   * Update quadtree - select tiles to render based on camera
   */
  update(camera) {
    this.camera = camera;
    this.frameNumber++;

    // Reset per-frame counters
    this.elevationFetchesThisFrame = 0;

    // Clear previous frame selection
    this.tilesToRender = [];
    this.tilesToLoad = [];

    // Traverse quadtree and select tiles
    for (const rootTile of this.rootTiles) {
      this._traverseTile(rootTile, camera);
    }

    // Update visibility
    this._updateTileVisibility();

    // Unload distant tiles to free memory
    this._unloadDistantTiles(camera);

    // Update statistics
    this._updateStats();

    // Request geometry for tiles that need it (with priority)
    this._processLoadQueue();
  }

  /**
   * Traverse tile tree and select tiles to render
   */
  _traverseTile(tile, camera) {
    // Check visibility
    if (!tile.isVisible(camera)) {
      tile.hide();
      return;
    }

    // Compute screen-space error
    tile.computeSSE(camera);

    // Check if we should refine
    const shouldRefine = tile.shouldRefine(this.sseThreshold) && tile.level < this.maxLevel;

    if (shouldRefine) {
      // Need to subdivide
      if (!tile.children) {
        tile.subdivide();

        // Create meshes for children
        for (const child of tile.children) {
          child.createMesh(this.scene, this.tileMaterial);
          this.allTiles.set(child.getKey(), child);
        }
      }

      // Check if children are ready
      let allChildrenReady = true;
      for (const child of tile.children) {
        if (child.state === TileState.UNLOADED || child.state === TileState.LOADING) {
          allChildrenReady = false;
          break;
        }
      }

      if (allChildrenReady) {
        // Render children, hide parent
        tile.hide();
        for (const child of tile.children) {
          this._traverseTile(child, camera);
        }
      } else {
        // Children not ready, render parent and request children
        if (tile.state === TileState.READY || tile.state === TileState.RENDERED) {
          this.tilesToRender.push(tile);
        } else if (tile.state === TileState.UNLOADED) {
          this.tilesToLoad.push(tile);
        }

        // Request children
        for (const child of tile.children) {
          if (child.state === TileState.UNLOADED) {
            this.tilesToLoad.push(child);
          }
        }
      }
    } else {
      // Don't refine, render this tile
      if (tile.state === TileState.READY || tile.state === TileState.RENDERED) {
        this.tilesToRender.push(tile);
      } else if (tile.state === TileState.UNLOADED) {
        this.tilesToLoad.push(tile);
      }

      // Hide children if they exist
      if (tile.children) {
        for (const child of tile.children) {
          child.hide();
        }
      }
    }
  }

  /**
   * Update tile visibility based on selection
   */
  _updateTileVisibility() {
    // Hide all tiles first
    for (const [key, tile] of this.allTiles) {
      tile.hide();
    }

    // Show selected tiles
    for (const tile of this.tilesToRender) {
      tile.show();
    }
  }

  /**
   * Unload tiles that are too far from camera to conserve memory
   * Cesium-style tile memory management
   */
  _unloadDistantTiles(camera) {
    const tilesToUnload = [];

    for (const [key, tile] of this.allTiles) {
      // Don't unload root tiles
      if (tile.level === 0) continue;

      // Don't unload tiles that are currently visible
      if (tile.state === TileState.RENDERED) continue;

      // Calculate distance from camera
      const distance = camera.position.distanceTo(tile.center);
      const cameraAltitude = camera.position.length() - EARTH_RADIUS_M;

      // Determine max level that should be kept based on altitude
      // Match the shouldRefine() limits exactly
      const altitudeRatio = cameraAltitude / EARTH_RADIUS_M;
      let maxLevelToKeep;

      if (altitudeRatio > 5) {
        maxLevelToKeep = 2;  // Very far orbit
      } else if (altitudeRatio > 3) {
        maxLevelToKeep = 3;  // Far orbit
      } else if (altitudeRatio > 2) {
        maxLevelToKeep = 4;  // High orbit
      } else if (altitudeRatio > 1) {
        maxLevelToKeep = 6;  // Medium orbit
      } else if (altitudeRatio > 0.5) {
        maxLevelToKeep = 8;  // Low orbit
      } else if (altitudeRatio > 0.2) {
        maxLevelToKeep = 12; // Very low orbit
      } else if (altitudeRatio > 0.05) {
        maxLevelToKeep = 15; // Near surface
      } else {
        maxLevelToKeep = 18; // Surface level
      }

      // Unload tiles beyond the appropriate level for current altitude
      if (tile.level > maxLevelToKeep + this.tileUnloadDistance) {
        tilesToUnload.push(tile);
      }
    }

    // Dispose and remove tiles
    for (const tile of tilesToUnload) {
      tile.dispose(this.scene);
      this.allTiles.delete(tile.getKey());
    }

    if (tilesToUnload.length > 0) {
      console.log(`[quadtree] Unloaded ${tilesToUnload.length} distant tiles (altitude-based cleanup)`);
    }
  }

  /**
   * Process load queue - request geometry for tiles with priority
   */
  _processLoadQueue() {
    // Sort tiles by priority (closest tiles first)
    this.tilesToLoad.sort((a, b) => {
      // Primary: distance (closer is higher priority)
      if (Math.abs(a.distance - b.distance) > 100) {
        return a.distance - b.distance;
      }
      // Secondary: level (higher detail is higher priority at same distance)
      return b.level - a.level;
    });

    // Limit requests per frame for performance
    let requestCount = 0;

    for (const tile of this.tilesToLoad) {
      if (requestCount >= this.maxTileLoadsPerFrame) break;
      if (tile.state === TileState.UNLOADED) {
        this.requestTileGeometry(tile);
        requestCount++;
      }
    }
  }

  /**
   * Update statistics
   */
  _updateStats() {
    this.stats.visibleTiles = this.tilesToRender.length;
    this.stats.totalTiles = this.allTiles.size;
    this.stats.renderingTiles = this.tilesToRender.length;

    let maxLevel = 0;
    let loadedTiles = 0;

    for (const [key, tile] of this.allTiles) {
      if (tile.state === TileState.READY || tile.state === TileState.RENDERED) {
        loadedTiles++;
      }
      maxLevel = Math.max(maxLevel, tile.level);
    }

    this.stats.loadedTiles = loadedTiles;
    this.stats.maxLevel = maxLevel;
  }

  /**
   * Get statistics
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Dispose all tiles
   */
  dispose() {
    for (const rootTile of this.rootTiles) {
      rootTile.dispose(this.scene);
    }

    this.rootTiles = [];
    this.allTiles.clear();
    this.tilesToRender = [];
    this.tilesToLoad = [];

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  /**
   * Find tile at position (for raycasting)
   */
  findTileAtPosition(position) {
    // Convert position to lat/lon
    const lat = Math.asin(position.z / position.length());
    const lon = Math.atan2(position.y, position.x);

    // Find tile containing this position
    for (const tile of this.tilesToRender) {
      if (lon >= tile.west && lon <= tile.east &&
          lat >= tile.south && lat <= tile.north) {
        return tile;
      }
    }

    return null;
  }
}
