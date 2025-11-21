import * as THREE from 'three';

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
// Cached world-space vertex buffer for snapping/placement
let detailPatchWorldPositions = null;

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
  detailPatchWorldPositions = null;

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
 * Update detail patch geometry by cloning directly from the current globe geometry.
 * - Uses current globe positions/indices (post-elevation)
 * - Keeps original base indices/ordering for retained vertices
 * - Splits boundary triangles so patch shares the border loop
 */
export function updateDetailPatchFromGlobe(globeGeometry, radiusOverride = PATCH_RADIUS_M) {
  if (!globeGeometry) return { includedBaseIndices: [] };
  if (!detailPatchGeometry || !detailPatchMesh) {
    console.warn('⚠️ Cannot update detail patch - not created yet');
    return { includedBaseIndices: [] };
  }

  const posAttr = globeGeometry.getAttribute('position');
  if (!posAttr?.array) return { includedBaseIndices: [] };
  const positions = posAttr.array;
  const idxAttr = globeGeometry.getIndex();
  const indices = idxAttr?.array;
  const radiusSq = radiusOverride * radiusOverride;

  const vertexCount = positions.length / 3;
  const includedVertexSet = new Set();
  const includedTriangles = [];
  const newVerts = [];

  const getPos = (idx) => ({
    x: positions[idx * 3],
    y: positions[idx * 3 + 1],
    z: positions[idx * 3 + 2]
  });

  const inside = (p) => {
    const dx = p.x - detailPatchCenter.x;
    const dy = p.y - detailPatchCenter.y;
    const dz = p.z - detailPatchCenter.z;
    return (dx * dx + dy * dy + dz * dz) <= radiusSq;
  };

  // Sphere-line segment intersection (returns t in [0,1] and point)
  const intersectSegmentSphere = (a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const fx = a.x - detailPatchCenter.x;
    const fy = a.y - detailPatchCenter.y;
    const fz = a.z - detailPatchCenter.z;
    const aCoeff = dx * dx + dy * dy + dz * dz;
    const bCoeff = 2 * (fx * dx + fy * dy + fz * dz);
    const cCoeff = fx * fx + fy * fy + fz * fz - radiusSq;
    const disc = bCoeff * bCoeff - 4 * aCoeff * cCoeff;
    if (disc < 0 || aCoeff === 0) return null;
    const sqrtDisc = Math.sqrt(disc);
    const t1 = (-bCoeff - sqrtDisc) / (2 * aCoeff);
    const t2 = (-bCoeff + sqrtDisc) / (2 * aCoeff);
    // pick any valid in [0,1]
    const candidates = [t1, t2].filter(t => t >= 0 && t <= 1);
    if (!candidates.length) return null;
    const t = candidates[0];
    return {
      t,
      x: a.x + dx * t,
      y: a.y + dy * t,
      z: a.z + dz * t
    };
  };

  const triCount = indices ? indices.length / 3 : vertexCount / 3;
  for (let f = 0; f < triCount; f++) {
    const i0 = indices ? indices[f * 3] : f * 3;
    const i1 = indices ? indices[f * 3 + 1] : f * 3 + 1;
    const i2 = indices ? indices[f * 3 + 2] : f * 3 + 2;
    const p0 = getPos(i0);
    const p1 = getPos(i1);
    const p2 = getPos(i2);
    const in0 = inside(p0);
    const in1 = inside(p1);
    const in2 = inside(p2);
    const inCount = (in0 ? 1 : 0) + (in1 ? 1 : 0) + (in2 ? 1 : 0);

    if (inCount === 3) {
      includedTriangles.push([i0, i1, i2]);
      includedVertexSet.add(i0).add(i1).add(i2);
      continue;
    }
    if (inCount === 0) continue;

    // Clip triangle against sphere by edge-walking
    const poly = [];
    const tri = [
      { idx: i0, p: p0, inside: in0 },
      { idx: i1, p: p1, inside: in1 },
      { idx: i2, p: p2, inside: in2 }
    ];
    for (let e = 0; e < 3; e++) {
      const curr = tri[e];
      const next = tri[(e + 1) % 3];
      if (curr.inside) {
        poly.push({ idx: curr.idx, p: curr.p, base: true });
      }
      if (curr.inside !== next.inside) {
        const inter = intersectSegmentSphere(curr.p, next.p);
        if (inter) {
          const newIdx = vertexCount + newVerts.length;
          newVerts.push(inter);
          poly.push({ idx: newIdx, p: inter, base: false });
        }
      }
    }
    if (poly.length >= 3) {
      for (let k = 1; k + 1 < poly.length; k++) {
        includedTriangles.push([poly[0].idx, poly[k].idx, poly[k + 1].idx]);
        includedVertexSet.add(poly[0].idx, poly[k].idx, poly[k + 1].idx);
      }
    }
  }

  if (!includedTriangles.length) {
    console.warn('⚠️ Detail patch extraction produced no triangles within radius');
    return { includedBaseIndices: [] };
  }

  // Build patch vertex buffers (base vertices keep original ordering)
  const orderedBase = Array.from(includedVertexSet).filter(i => i < vertexCount).sort((a, b) => a - b);
  const vertexMap = new Map();
  let next = 0;
  for (const idx of orderedBase) {
    vertexMap.set(idx, next++);
  }
  const newBaseStart = next;
  newVerts.forEach((v, offset) => {
    vertexMap.set(vertexCount + offset, newBaseStart + offset);
  });

  const totalVerts = orderedBase.length + newVerts.length;
  const localPositions = new Float32Array(totalVerts * 3);
  const worldPositions = new Float32Array(totalVerts * 3);
  const baseIndexAttr = new Int32Array(totalVerts);

  for (const idx of orderedBase) {
    const mapIdx = vertexMap.get(idx);
    const p = getPos(idx);
    localPositions[mapIdx * 3] = p.x - detailPatchCenter.x;
    localPositions[mapIdx * 3 + 1] = p.y - detailPatchCenter.y;
    localPositions[mapIdx * 3 + 2] = p.z - detailPatchCenter.z;
    worldPositions[mapIdx * 3] = p.x;
    worldPositions[mapIdx * 3 + 1] = p.y;
    worldPositions[mapIdx * 3 + 2] = p.z;
    baseIndexAttr[mapIdx] = idx;
  }
  newVerts.forEach((v, offset) => {
    const mapIdx = newBaseStart + offset;
    localPositions[mapIdx * 3] = v.x - detailPatchCenter.x;
    localPositions[mapIdx * 3 + 1] = v.y - detailPatchCenter.y;
    localPositions[mapIdx * 3 + 2] = v.z - detailPatchCenter.z;
    worldPositions[mapIdx * 3] = v.x;
    worldPositions[mapIdx * 3 + 1] = v.y;
    worldPositions[mapIdx * 3 + 2] = v.z;
    baseIndexAttr[mapIdx] = -1; // intersection vertex
  });

  const localIndices = new Uint32Array(includedTriangles.length * 3);
  for (let i = 0; i < includedTriangles.length; i++) {
    const [a, b, c] = includedTriangles[i];
    localIndices[i * 3] = vertexMap.get(a);
    localIndices[i * 3 + 1] = vertexMap.get(b);
    localIndices[i * 3 + 2] = vertexMap.get(c);
  }

  detailPatchWorldPositions = worldPositions;

  detailPatchGeometry.setAttribute('position', new THREE.BufferAttribute(localPositions, 3));
  detailPatchGeometry.setAttribute('baseIndex', new THREE.BufferAttribute(baseIndexAttr, 1));
  detailPatchGeometry.setIndex(new THREE.BufferAttribute(localIndices, 1));
  detailPatchGeometry.computeVertexNormals();
  detailPatchGeometry.computeBoundingSphere();
  detailPatchGeometry.computeBoundingBox();
  detailPatchMesh.position.copy(detailPatchCenter);

  if (detailPatchWireframeGeometry && detailPatchWireframe) {
    detailPatchWireframeGeometry.setAttribute('position', new THREE.BufferAttribute(localPositions, 3));
    detailPatchWireframeGeometry.setAttribute('baseIndex', new THREE.BufferAttribute(baseIndexAttr, 1));
    detailPatchWireframeGeometry.setIndex(new THREE.BufferAttribute(localIndices, 1));
    detailPatchWireframeGeometry.computeBoundingSphere();
    detailPatchWireframeGeometry.computeBoundingBox();
    detailPatchWireframe.position.copy(detailPatchCenter);
  }

  const includedBaseIndices = orderedBase;
  console.log(`✅ Yarmulke cloned: ${localPositions.length / 3} verts (${includedBaseIndices.length} base) / ${includedTriangles.length} tris`);
  return { includedBaseIndices };
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
  detailPatchWorldPositions = null;
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

export function getDetailPatchWorldPositions() {
  return detailPatchWorldPositions;
}

export function getPatchRadiusMeters() {
  return PATCH_RADIUS_M;
}

/**
 * Transform detail patch - no-op in world-centered system
 */
export function transformDetailPatchForOriginChange(originDelta) {
  if (!originDelta) return;
  if (detailPatchCenter) {
    detailPatchCenter.sub(originDelta);
  }
  if (detailPatchMesh) {
    detailPatchMesh.position.copy(detailPatchCenter);
  }
  if (detailPatchWireframe) {
    detailPatchWireframe.position.copy(detailPatchCenter);
  }
  if (detailPatchWorldPositions) {
    for (let i = 0; i < detailPatchWorldPositions.length; i += 3) {
      detailPatchWorldPositions[i] -= originDelta.x;
      detailPatchWorldPositions[i + 1] -= originDelta.y;
      detailPatchWorldPositions[i + 2] -= originDelta.z;
    }
  }
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
