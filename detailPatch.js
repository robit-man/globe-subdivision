import * as THREE from 'three';
import { EARTH_RADIUS_M } from './constants.js';
import { transformGeometryToLocal } from './precision.js';

// ──────────────────────── Detail Patch Architecture ────────────────────────
// Separate high-precision mesh for terrain near player
// Base Globe: Simple icosahedron at 6.37M (some jitter acceptable, distant)
// Detail Patch: Local coordinates (0-10km from center) for perfect precision
//
// Why: GPU float32 has ~6-7 significant digits (~999,999 units max)
// At 6.37M meters, precision ≈ 0.76m causing jitter
// Solution: Detail patch in local coords (0-10km) = 0.00012m precision!

const PATCH_RECREATION_THRESHOLD_M = 5000; // Recreate patch when player moves 5km from center
const PATCH_RADIUS_M = 10000; // 10km patch radius

// Detail patch state
let detailPatchMesh = null;
let detailPatchGeometry = null;
let detailPatchMaterial = null;
let detailPatchCenter = new THREE.Vector3(); // World position of patch center
let detailPatchWireframe = null;
let detailPatchWireframeGeometry = null;
let detailPatchVisible = true;
let detailPatchMaterialOpacity = 1;
let detailPatchWireframeOpacity = 0.45;

function applyDetailPatchVisibility() {
  if (detailPatchMesh) {
    detailPatchMesh.visible = detailPatchVisible;
    const mat = detailPatchMesh.material;
    if (mat) {
      if (mat.opacity != null) {
        detailPatchMaterialOpacity = detailPatchMaterialOpacity ?? (mat.opacity ?? 1);
        mat.transparent = true;
        mat.opacity = detailPatchVisible ? detailPatchMaterialOpacity : 0;
        mat.needsUpdate = true;
      }
    }
  }
  if (detailPatchWireframe) {
    detailPatchWireframe.visible = detailPatchVisible;
    const wmat = detailPatchWireframe.material;
    if (wmat) {
      detailPatchWireframeOpacity = detailPatchWireframeOpacity ?? (wmat.opacity ?? 1);
      wmat.opacity = detailPatchVisible ? detailPatchWireframeOpacity : 0;
      wmat.needsUpdate = true;
    }
  }
}

/**
 * Create a new detail patch centered at the given world position
 * The patch geometry will be in LOCAL coordinates (0-10km from center)
 */
export function createDetailPatch(scene, centerWorldPos) {
  // Dispose existing patch if any
  disposeDetailPatch(scene);

  // Store patch center in world coordinates
  detailPatchCenter.copy(centerWorldPos);

  console.log('🎯 Creating detail patch at center:',
    (centerWorldPos.length() / 1000).toFixed(1) + 'km',
    centerWorldPos.toArray().map(v => (v / 1000).toFixed(2) + 'km'));

  // Create material for detail patch
  detailPatchMaterial = new THREE.MeshBasicMaterial({
    color: 0x808080,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    wireframe: false
  });

  // Start with empty geometry - will be populated by worker
  detailPatchGeometry = new THREE.BufferGeometry();

  // Create mesh
  detailPatchMesh = new THREE.Mesh(detailPatchGeometry, detailPatchMaterial);
  detailPatchMesh.name = 'detail-patch';
  detailPatchMesh.frustumCulled = false;
  detailPatchMesh.visible = detailPatchVisible;
  detailPatchMaterialOpacity = detailPatchMaterial?.opacity ?? 1;
  scene.add(detailPatchMesh);

  // Create wireframe material
  const wireframeMaterial = new THREE.LineBasicMaterial({
    color: 0x00ff00,
    transparent: true,
    opacity: 0.45,
    depthTest: true,
    depthWrite: false
  });

  // Create wireframe geometry
  detailPatchWireframeGeometry = new THREE.BufferGeometry();
  detailPatchWireframe = new THREE.LineSegments(detailPatchWireframeGeometry, wireframeMaterial);
  detailPatchWireframe.name = 'detail-patch-wireframe';
  detailPatchWireframe.frustumCulled = false;
  detailPatchWireframe.visible = detailPatchVisible;
  detailPatchWireframeOpacity = detailPatchWireframe.material?.opacity ?? 1;
  scene.add(detailPatchWireframe);

  applyDetailPatchVisibility();
  console.log('✅ Detail patch mesh created (empty - awaiting worker subdivision)');

  return {
    mesh: detailPatchMesh,
    geometry: detailPatchGeometry,
    center: detailPatchCenter.clone()
  };
}

/**
 * Update detail patch geometry from worker subdivision results
 * Creates a yarmulke/dome shape - extracts vertices near player and transforms to local coords
 */
export function updateDetailPatchGeometry(positions, indices, normals) {
  if (!detailPatchGeometry || !detailPatchMesh) {
    console.warn('⚠️ Cannot update detail patch - not created yet');
    return;
  }

  // Extract yarmulke: vertices within PATCH_RADIUS_M of patch center
  const vertexCount = positions.length / 3;
  const vertexMap = new Map(); // old index -> new index
  const localPositions = [];

  // Pass 1: Filter vertices and transform to patch-local coordinates
  for (let i = 0; i < vertexCount; i++) {
    const vx = positions[i * 3];
    const vy = positions[i * 3 + 1];
    const vz = positions[i * 3 + 2];

    // Calculate distance from patch center
    const dx = vx - detailPatchCenter.x;
    const dy = vy - detailPatchCenter.y;
    const dz = vz - detailPatchCenter.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Include vertices within patch radius
    if (dist <= PATCH_RADIUS_M) {
      const newIndex = vertexMap.size;
      vertexMap.set(i, newIndex);

      // Store in patch-local coordinates (0-10km range for perfect precision!)
      localPositions.push(dx, dy, dz);
    }
  }

  // Pass 2: Filter triangles (only include if all vertices are in the patch)
  const localIndices = [];
  if (indices) {
    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i];
      const i1 = indices[i + 1];
      const i2 = indices[i + 2];

      if (vertexMap.has(i0) && vertexMap.has(i1) && vertexMap.has(i2)) {
        localIndices.push(vertexMap.get(i0), vertexMap.get(i1), vertexMap.get(i2));
      }
    }
  }

  const patchPositions = new Float32Array(localPositions);
  const patchIndices = new Uint32Array(localIndices);

  // Update geometry attributes with LOCAL coordinates
  detailPatchGeometry.setAttribute('position', new THREE.BufferAttribute(patchPositions, 3));

  if (patchIndices.length > 0) {
    detailPatchGeometry.setIndex(new THREE.BufferAttribute(patchIndices, 1));
  }

  // Compute normals from local geometry
  detailPatchGeometry.computeVertexNormals();
  detailPatchGeometry.computeBoundingSphere();
  detailPatchGeometry.computeBoundingBox();

  // Position mesh at patch center on globe surface
  detailPatchMesh.position.copy(detailPatchCenter);

  // Update wireframe with filtered geometry
  if (detailPatchWireframeGeometry && detailPatchWireframe) {
    detailPatchWireframeGeometry.setAttribute('position', new THREE.BufferAttribute(patchPositions, 3));

    if (patchIndices.length > 0) {
      detailPatchWireframeGeometry.setIndex(new THREE.BufferAttribute(patchIndices, 1));
    }

    detailPatchWireframeGeometry.computeBoundingSphere();
    detailPatchWireframeGeometry.computeBoundingBox();

    // Position wireframe at patch center too
    detailPatchWireframe.position.copy(detailPatchCenter);
  }

  const yarmulkeVertCount = vertexMap.size;
  const yarmulkeTriCount = patchIndices.length / 3;
  const totalVertCount = positions.length / 3;

  console.log(`✅ Yarmulke extracted: ${yarmulkeVertCount}/${totalVertCount} vertices, ${yarmulkeTriCount} triangles`);
  console.log(`   Local coords: 0-${(PATCH_RADIUS_M/1000).toFixed(1)}km from patch center (perfect precision!)`);
}

/**
 * Check if detail patch should be recreated (player moved too far from center)
 */
export function shouldRecreateDetailPatch(currentWorldPos) {
  if (!detailPatchMesh || !detailPatchCenter) {
    return true; // No patch exists, need to create
  }

  const distanceFromCenter = currentWorldPos.distanceTo(detailPatchCenter);
  return distanceFromCenter > PATCH_RECREATION_THRESHOLD_M;
}

/**
 * Dispose current detail patch and clean up resources
 */
export function disposeDetailPatch(scene) {
  if (detailPatchMesh) {
    scene.remove(detailPatchMesh);
    if (detailPatchGeometry) {
      detailPatchGeometry.dispose();
      detailPatchGeometry = null;
    }
    if (detailPatchMaterial) {
      detailPatchMaterial.dispose();
      detailPatchMaterial = null;
    }
    detailPatchMesh = null;
    console.log('🗑️ Detail patch mesh disposed');
  }

  if (detailPatchWireframe) {
    scene.remove(detailPatchWireframe);
    if (detailPatchWireframeGeometry) {
      detailPatchWireframeGeometry.dispose();
      detailPatchWireframeGeometry = null;
    }
    detailPatchWireframe = null;
    console.log('🗑️ Detail patch wireframe disposed');
  }
}

/**
 * Get detail patch mesh (for raycasting, etc.)
 */
export function getDetailPatchMesh() {
  return detailPatchMesh;
}

/**
 * Get detail patch geometry (for subdivision worker)
 */
export function getDetailPatchGeometry() {
  return detailPatchGeometry;
}

/**
 * Get detail patch center in world coordinates
 */
export function getDetailPatchCenter() {
  return detailPatchCenter.clone();
}

/**
 * Transform detail patch - no-op in world-centered system
 */
export function transformDetailPatchForOriginChange(originDelta) {
  // No transform needed - globe and patch both at world center
  return;
}

/**
 * Helper: Get geometry bounds for debugging
 */
function getGeometryBounds(positions) {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]);
    maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]);
    maxY = Math.max(maxY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]);
    maxZ = Math.max(maxZ, positions[i + 2]);
  }

  const rangeX = (maxX - minX) / 1000;
  const rangeY = (maxY - minY) / 1000;
  const rangeZ = (maxZ - minZ) / 1000;

  return `x:${rangeX.toFixed(2)}km, y:${rangeY.toFixed(2)}km, z:${rangeZ.toFixed(2)}km`;
}

export {
  detailPatchMesh,
  detailPatchGeometry,
  detailPatchCenter,
  PATCH_RECREATION_THRESHOLD_M,
  PATCH_RADIUS_M
};

export function setDetailPatchVisibility(visible) {
  detailPatchVisible = !!visible;
  applyDetailPatchVisibility();
}

export function getDetailPatchVisibility() {
  return detailPatchVisible;
}
