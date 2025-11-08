// ──────────────────────── Terrain Worker (Module Worker) ────────────────────────
// This worker handles all CPU-heavy terrain operations off the main thread

import * as THREE from 'three';
import {
  EARTH_RADIUS_M,
  CAMERA_FOV,
  FOCUS_BARY_EPS,
  WORKER_SUBDIVISION_SLICE_MS,
  BASE_PENDING_MAX_DEPTH,
  BASE_PENDING_MAX_VERTICES,
  MOVEMENT_MAX_SPLITS,
  MOVEMENT_PROPAGATION_DEPTH
} from './constants.js';
import { geohashEncode, cartesianToLatLon } from './utils.js';

// ──────────────────────── Worker-Local State ────────────────────────
const state = {
  // Geometry state
  subdividedGeometry: {
    vertices: [],
    originalVertices: [],
    faces: [],
    vertexData: new Map(),
    edgeCache: new Map(),
    uvCoords: [],
    faceBaseIndex: [],
    vertexDepths: []
  },

  // Base icosahedron
  baseIcosahedron: {
    vertices: [],
    originalVertices: [],
    faces: []
  },
  baseVertexCount: 0,
  baseElevationsReady: false,

  // Elevation cache
  elevationCache: new Map(),

  // Settings
  settings: {
    maxRadius: 50000,
    minSpacingM: 50,
    maxSpacingM: 5000,
    fineDetailRadius: 4000,
    fineDetailFalloff: 12000,
    sseNearThreshold: 2.0,
    sseFarThreshold: 2.0,
    elevExag: 1.0,
    maxVertices: 50000,
    dataset: 'copernicus30'
  },

  // Focus state
  focusedBaseFaceIndex: null,
  focusedFaceBary: new THREE.Vector3(1/3, 1/3, 1/3),
  hasFocusedBary: false,

  // Processing state
  isProcessing: false,

  // Three.js helpers
  triangleHelper: new THREE.Triangle(),
  tmpProjected: new THREE.Vector3(),
  tmpBary: new THREE.Vector3(),
  tmpPlane: new THREE.Plane(),
  tmpCenter: new THREE.Vector3(),
  tmpChildCenter: new THREE.Vector3(),
  tmpFocusDir: new THREE.Vector3(),
  tmpFocusEnd: new THREE.Vector3(),
  tmpRayHit: new THREE.Vector3(),
  tmpClosestPoint: new THREE.Vector3(),
  tmpClosestOnSphere: new THREE.Vector3(),
  focusRay: new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(1, 0, 0))
};

// ──────────────────────── Helper Functions ────────────────────────
function getViewportHeight() {
  // In worker, we don't have window, so we use a default
  return 1080;
}

function ensureVertexMetadata(idx) {
  if (idx == null) return null;
  let data = state.subdividedGeometry.vertexData.get(idx);
  if (!data) {
    const origin = state.subdividedGeometry.originalVertices[idx] || state.subdividedGeometry.vertices[idx];
    if (!origin) return null;

    const { latDeg, lonDeg } = cartesianToLatLon(origin);
    const lat = Number(latDeg.toFixed(6));
    const lon = Number(lonDeg.toFixed(6));
    const geohash = geohashEncode(lat, lon, 9);

    data = {
      lat,
      lon,
      geohash,
      elevation: null,
      approxElevation: null,
      fetching: false
    };
    state.subdividedGeometry.vertexData.set(idx, data);
  }

  const cached = state.elevationCache.get(data.geohash);
  if (cached && Number.isFinite(cached.height)) {
    if (data.elevation == null) data.elevation = cached.height;
  }

  if (data.elevation != null) {
    applyElevationToVertex(idx, data.elevation, true);
  } else if (data.approxElevation != null) {
    applyElevationToVertex(idx, data.approxElevation, false);
  }

  return data;
}

function applyElevationToVertex(idx, height, isFinal) {
  if (height == null) return;
  const originalPos = state.subdividedGeometry.originalVertices[idx] || state.subdividedGeometry.vertices[idx];
  if (!originalPos) return;
  const baseRadius = originalPos.length();
  const radialDir = originalPos.clone().normalize();
  const targetRadius = baseRadius + height * state.settings.elevExag;
  state.subdividedGeometry.vertices[idx].copy(radialDir.multiplyScalar(targetRadius));
}

function getMidpointVertex(v1Idx, v2Idx) {
  const key = v1Idx < v2Idx ? `${v1Idx}_${v2Idx}` : `${v2Idx}_${v1Idx}`;

  if (state.subdividedGeometry.edgeCache.has(key)) {
    return state.subdividedGeometry.edgeCache.get(key);
  }

  const v1 = state.subdividedGeometry.vertices[v1Idx];
  const v2 = state.subdividedGeometry.vertices[v2Idx];
  if (!v1 || !v2) {
    return null;
  }

  const mid = new THREE.Vector3().addVectors(v1, v2).multiplyScalar(0.5);
  mid.normalize().multiplyScalar(EARTH_RADIUS_M);

  const newIdx = state.subdividedGeometry.vertices.length;
  state.subdividedGeometry.vertices.push(mid.clone());
  state.subdividedGeometry.originalVertices.push(mid.clone());

  const normalized = mid.clone().normalize();
  let u = 0.5 - Math.atan2(normalized.z, normalized.x) / (2 * Math.PI);
  u = (u + 0.5) % 1.0;
  const v_coord = 0.5 + Math.asin(normalized.y) / Math.PI;
  state.subdividedGeometry.uvCoords.push([u, v_coord]);

  if (!state.subdividedGeometry.vertexDepths) {
    state.subdividedGeometry.vertexDepths = new Array(state.subdividedGeometry.vertices.length).fill(0);
  }
  const parentDepth = Math.max(
    state.subdividedGeometry.vertexDepths[v1Idx] ?? 0,
    state.subdividedGeometry.vertexDepths[v2Idx] ?? 0
  );
  state.subdividedGeometry.vertexDepths[newIdx] = parentDepth + 1;

  const parentMetaA = ensureVertexMetadata(v1Idx);
  const parentMetaB = ensureVertexMetadata(v2Idx);
  const childMeta = ensureVertexMetadata(newIdx);
  const parentHeights = [];
  const addHeight = (meta) => {
    if (!meta) return;
    const h = meta.elevation != null ? meta.elevation : meta.approxElevation;
    if (Number.isFinite(h)) parentHeights.push(h);
  };
  addHeight(parentMetaA);
  addHeight(parentMetaB);
  if (childMeta && childMeta.elevation == null && parentHeights.length) {
    const avgHeight = parentHeights.reduce((sum, h) => sum + h, 0) / parentHeights.length;
    childMeta.approxElevation = avgHeight;
    applyElevationToVertex(newIdx, avgHeight, false);
  }

  state.subdividedGeometry.edgeCache.set(key, newIdx);

  return newIdx;
}

function subdivideTriangle(v1Idx, v2Idx, v3Idx) {
  const v12 = getMidpointVertex(v1Idx, v2Idx);
  const v23 = getMidpointVertex(v2Idx, v3Idx);
  const v31 = getMidpointVertex(v3Idx, v1Idx);
  if (v12 == null || v23 == null || v31 == null) {
    return null;
  }

  return [
    [v1Idx, v12, v31],
    [v12, v2Idx, v23],
    [v31, v23, v3Idx],
    [v12, v23, v31]
  ];
}

function distanceToCharacter(vertex, surfacePosition) {
  const v1 = vertex.clone().normalize();
  const v2 = surfacePosition.clone().normalize();
  const angle = Math.acos(THREE.MathUtils.clamp(v1.dot(v2), -1, 1));
  return angle * EARTH_RADIUS_M;
}

function surfaceDistanceBetween(a, b) {
  const v1 = a.clone().normalize();
  const v2 = b.clone().normalize();
  const angle = Math.acos(THREE.MathUtils.clamp(v1.dot(v2), -1, 1));
  return angle * EARTH_RADIUS_M;
}

function distanceToFocusPoint(vertex, focusedPoint, surfacePosition) {
  if (!focusedPoint) return distanceToCharacter(vertex, surfacePosition);
  return surfaceDistanceBetween(vertex, focusedPoint);
}

function computeTriangleSSE(triangle, surfacePosition) {
  const v1 = state.subdividedGeometry.vertices[triangle[0]];
  const v2 = state.subdividedGeometry.vertices[triangle[1]];
  const v3 = state.subdividedGeometry.vertices[triangle[2]];
  if (!v1 || !v2 || !v3) return 0;
  const edge1 = v1.distanceTo(v2);
  const edge2 = v2.distanceTo(v3);
  const edge3 = v3.distanceTo(v1);
  const maxEdge = Math.max(edge1, edge2, edge3);
  const center = state.tmpCenter.copy(v1).add(v2).add(v3).multiplyScalar(1 / 3);
  const distanceToCamera = Math.max(center.distanceTo(surfacePosition), 1);
  const viewportHeight = getViewportHeight();
  const FOV_RAD = THREE.MathUtils.degToRad(CAMERA_FOV);
  return (maxEdge / distanceToCamera) * viewportHeight / (2 * Math.tan(FOV_RAD / 2));
}

function computeTriangleEdgeLength(triangle) {
  const v1 = state.subdividedGeometry.vertices[triangle[0]];
  const v2 = state.subdividedGeometry.vertices[triangle[1]];
  const v3 = state.subdividedGeometry.vertices[triangle[2]];
  if (!v1 || !v2 || !v3) return Infinity;
  const edge1 = v1.distanceTo(v2);
  const edge2 = v2.distanceTo(v3);
  const edge3 = v3.distanceTo(v1);
  return Math.max(edge1, edge2, edge3);
}

function triangleIntersectsFocus(triangle) {
  if (!state.focusRay || state.focusRay.direction.lengthSq() === 0) return false;
  const v1 = state.subdividedGeometry.vertices[triangle[0]];
  const v2 = state.subdividedGeometry.vertices[triangle[1]];
  const v3 = state.subdividedGeometry.vertices[triangle[2]];
  if (!v1 || !v2 || !v3) return false;
  const hit = state.focusRay.intersectTriangle(v1, v2, v3, false, state.tmpRayHit);
  if (!hit) return false;
  state.triangleHelper.set(v1, v2, v3);
  state.triangleHelper.getBarycoord(state.tmpRayHit, state.tmpBary);
  return Math.min(state.tmpBary.x, state.tmpBary.y, state.tmpBary.z) >= -FOCUS_BARY_EPS;
}

function heapPush(queue, node) {
  queue.push(node);
  let idx = queue.length - 1;
  while (idx > 0) {
    const parent = (idx - 1) >> 1;
    if (queue[parent].sse >= node.sse) break;
    queue[idx] = queue[parent];
    idx = parent;
  }
  queue[idx] = node;
}

function heapPop(queue) {
  if (!queue.length) return null;
  const top = queue[0];
  const last = queue.pop();
  if (!queue.length) return top;
  let idx = 0;
  while (true) {
    let left = idx * 2 + 1;
    let right = left + 1;
    if (left >= queue.length) break;
    let swapIdx = left;
    if (right < queue.length && queue[right].sse > queue[left].sse) {
      swapIdx = right;
    }
    if (queue[swapIdx].sse <= last.sse) break;
    queue[idx] = queue[swapIdx];
    idx = swapIdx;
  }
  queue[idx] = last;
  return top;
}

function buildVertexAdjacency() {
  const verts = state.subdividedGeometry.vertices;
  const adjacency = new Array(verts.length);
  for (let i = 0; i < state.subdividedGeometry.faces.length; i++) {
    const [a, b, c] = state.subdividedGeometry.faces[i];
    adjacency[a] = adjacency[a] || new Set();
    adjacency[b] = adjacency[b] || new Set();
    adjacency[c] = adjacency[c] || new Set();
    adjacency[a].add(b).add(c);
    adjacency[b].add(a).add(c);
    adjacency[c].add(a).add(b);
  }
  return adjacency;
}

function propagateApproxHeightsAroundVertices(sourceIndices, maxDepth = 2, minNeighbors = 2) {
  if (!Array.isArray(sourceIndices) || !sourceIndices.length) return;
  const adjacency = buildVertexAdjacency();
  const visited = new Set();
  const queue = [];
  for (const idx of sourceIndices) {
    if (idx == null) continue;
    visited.add(idx);
    queue.push({ idx, depth: 0 });
  }

  while (queue.length) {
    const { idx, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    const neighbors = adjacency[idx];
    if (!neighbors) continue;
    for (const nIdx of neighbors) {
      if (visited.has(nIdx)) continue;
      visited.add(nIdx);
      queue.push({ idx: nIdx, depth: depth + 1 });
    }
  }

  for (const idx of visited) {
    const meta = ensureVertexMetadata(idx);
    if (!meta || meta.elevation != null) continue;
    const neighbors = adjacency[idx];
    if (!neighbors || neighbors.size === 0) continue;
    let sum = 0;
    let count = 0;
    neighbors.forEach(nIdx => {
      const nMeta = ensureVertexMetadata(nIdx);
      if (!nMeta) return;
      const h = nMeta.elevation != null ? nMeta.elevation : nMeta.approxElevation;
      if (!Number.isFinite(h)) return;
      sum += h;
      count++;
    });
    if (count >= minNeighbors) {
      const avg = sum / count;
      meta.approxElevation = avg;
      applyElevationToVertex(idx, avg, false);
    }
  }
}

function findClosestBaseFaceIndex(surfacePosition) {
  let closestIndex = 0;
  let closestDist = Infinity;
  for (let i = 0; i < state.baseIcosahedron.faces.length; i++) {
    const tri = state.baseIcosahedron.faces[i];
    const v1 = state.baseIcosahedron.vertices[tri[0]];
    const v2 = state.baseIcosahedron.vertices[tri[1]];
    const v3 = state.baseIcosahedron.vertices[tri[2]];
    const center = new THREE.Vector3().add(v1).add(v2).add(v3).divideScalar(3);
    const dist = distanceToCharacter(center, surfacePosition);
    if (dist < closestDist) {
      closestDist = dist;
      closestIndex = i;
    }
  }
  return closestIndex;
}

function projectPointOntoTriangle(point, a, b, c, outBary, outProjected) {
  state.triangleHelper.set(a, b, c);
  state.tmpPlane.setFromCoplanarPoints(a, b, c);
  state.tmpPlane.projectPoint(point, outProjected);

  state.triangleHelper.getBarycoord(outProjected, outBary);

  const sum = outBary.x + outBary.y + outBary.z;
  if (!Number.isFinite(sum) || Math.abs(sum) <= 1e-9) {
    outBary.set(1/3, 1/3, 1/3);
    return false;
  }

  if (Math.abs(sum - 1) > 1e-4) {
    outBary.multiplyScalar(1 / sum);
  }

  const minComponent = Math.min(outBary.x, outBary.y, outBary.z);
  return minComponent >= -FOCUS_BARY_EPS;
}

function updateFocusedFaceBary(faceIndex, point) {
  if (faceIndex == null) {
    state.hasFocusedBary = false;
    state.focusedFaceBary.set(1/3, 1/3, 1/3);
    return;
  }
  const face = state.baseIcosahedron.faces[faceIndex];
  if (!face) {
    state.hasFocusedBary = false;
    return;
  }
  const a = state.baseIcosahedron.vertices[face[0]];
  const b = state.baseIcosahedron.vertices[face[1]];
  const c = state.baseIcosahedron.vertices[face[2]];
  if (!a || !b || !c) {
    state.hasFocusedBary = false;
    return;
  }

  let barySet = false;
  if (state.focusRay.direction.lengthSq() > 0) {
    const hit = state.focusRay.intersectTriangle(a, b, c, false, state.tmpRayHit);
    if (hit) {
      state.triangleHelper.set(a, b, c);
      state.triangleHelper.getBarycoord(state.tmpRayHit, state.focusedFaceBary);
      const minComponent = Math.min(state.focusedFaceBary.x, state.focusedFaceBary.y, state.focusedFaceBary.z);
      if (minComponent >= -FOCUS_BARY_EPS) {
        barySet = true;
        state.hasFocusedBary = true;
      }
    }
  }

  if (!barySet) {
    state.hasFocusedBary = projectPointOntoTriangle(point, a, b, c, state.focusedFaceBary, state.tmpProjected);
  }

  if (!state.hasFocusedBary) {
    const sum = state.focusedFaceBary.x + state.focusedFaceBary.y + state.focusedFaceBary.z;
    if (Math.abs(sum) > 1e-6) {
      state.focusedFaceBary.multiplyScalar(1 / sum);
    } else {
      state.focusedFaceBary.set(1/3, 1/3, 1/3);
    }
  }
}

// ──────────────────────── Main Subdivision Logic ────────────────────────
async function rebuildGlobeGeometry(surfacePosition, focusedPoint, options = {}) {
  const { preserveGeometry = false, incrementalSplitBudget = MOVEMENT_MAX_SPLITS } = options;
  const startTime = performance.now();
  let lastYieldTime = startTime;

  const maybeYield = async () => {
    if (performance.now() - lastYieldTime < WORKER_SUBDIVISION_SLICE_MS) return;
    await new Promise(resolve => setTimeout(resolve, 0));
    lastYieldTime = performance.now();
  };

  const seedFaces = [];
  const seedFaceBase = [];
  let initialVertexCount = 0;

  if (!preserveGeometry || state.subdividedGeometry.vertices.length === 0) {
    state.subdividedGeometry.vertices = state.baseIcosahedron.vertices.map(v => v.clone());
    state.subdividedGeometry.originalVertices = state.baseIcosahedron.originalVertices.map(v => v.clone());
    state.subdividedGeometry.faces = [];
    state.subdividedGeometry.edgeCache.clear();
    for (const key of state.subdividedGeometry.vertexData.keys()) {
      if (key >= state.subdividedGeometry.vertices.length) {
        state.subdividedGeometry.vertexData.delete(key);
      } else {
        const meta = state.subdividedGeometry.vertexData.get(key);
        if (meta) {
          meta.fetching = false;
        }
      }
    }
    state.subdividedGeometry.faceBaseIndex = [];

    state.subdividedGeometry.uvCoords = [];
    for (let v of state.subdividedGeometry.vertices) {
      const normalized = v.clone().normalize();
      let u = 0.5 - Math.atan2(normalized.z, normalized.x) / (2 * Math.PI);
      u = (u + 0.5) % 1.0;
      const v_coord = 0.5 + Math.asin(normalized.y) / Math.PI;
      state.subdividedGeometry.uvCoords.push([u, v_coord]);
    }

    for (let i = 0; i < state.subdividedGeometry.vertices.length; i++) {
      ensureVertexMetadata(i);
    }

    initialVertexCount = state.baseIcosahedron.vertices.length;
    state.baseIcosahedron.faces.forEach((face, idx) => {
      seedFaces.push([...face]);
      seedFaceBase.push(idx);
    });
  } else {
    initialVertexCount = state.subdividedGeometry.vertices.length;
    for (let i = 0; i < state.subdividedGeometry.vertices.length; i++) {
      ensureVertexMetadata(i);
    }
    const existingFaces = state.subdividedGeometry.faces && state.subdividedGeometry.faces.length
      ? state.subdividedGeometry.faces
      : state.baseIcosahedron.faces;
    const existingBaseIndex = state.subdividedGeometry.faceBaseIndex && state.subdividedGeometry.faceBaseIndex.length
      ? state.subdividedGeometry.faceBaseIndex
      : state.baseIcosahedron.faces.map((_, idx) => idx);
    existingFaces.forEach((face, idx) => {
      seedFaces.push([...face]);
      seedFaceBase.push(existingBaseIndex[idx] ?? idx);
    });
  }

  state.subdividedGeometry.faces = [];
  state.subdividedGeometry.faceBaseIndex = [];

  let subdivisionCount = 0;
  let maxDepthReached = 0;
  const vertexMaxDepth = (!preserveGeometry || !state.subdividedGeometry.vertexDepths)
    ? new Array(state.subdividedGeometry.vertices.length).fill(0)
    : state.subdividedGeometry.vertexDepths.slice();
  const leaves = [];
  const leafBaseIndex = [];
  const highQueue = [];
  const lowQueue = [];
  const MAX_QUEUE_DEPTH = 20;
  const activeMaxDepth = state.baseElevationsReady ? MAX_QUEUE_DEPTH : Math.min(MAX_QUEUE_DEPTH, BASE_PENDING_MAX_DEPTH);
  const minEdgeLength = Math.max(state.settings.minSpacingM, 1);
  const maxRadius = Math.max(state.settings.maxRadius, 1);
  const nearSSE = Math.max(state.settings.sseNearThreshold ?? 2, 0.5);
  const farSSE = Math.max(state.settings.sseFarThreshold ?? nearSSE, nearSSE);
  const configuredMaxVerts = state.settings.maxVertices ?? 50000;
  const vertexBudget = state.baseElevationsReady ? configuredMaxVerts : Math.min(configuredMaxVerts, BASE_PENDING_MAX_VERTICES);
  const splitBudget = preserveGeometry ? Math.max(0, incrementalSplitBudget|0) : Infinity;
  let splitsPerformed = 0;
  let splitBudgetReached = false;

  if (state.focusedBaseFaceIndex == null) {
    state.focusedBaseFaceIndex = findClosestBaseFaceIndex(surfacePosition);
    updateFocusedFaceBary(state.focusedBaseFaceIndex, focusedPoint);
  }

  const makeNode = (indices, depth, baseFaceIndex, inheritedFocus = false) => {
    const v1 = state.subdividedGeometry.vertices[indices[0]];
    const v2 = state.subdividedGeometry.vertices[indices[1]];
    const v3 = state.subdividedGeometry.vertices[indices[2]];
    const center = new THREE.Vector3().add(v1).add(v2).add(v3).multiplyScalar(1 / 3);
    const cameraDist = Math.max(center.distanceTo(surfacePosition), 1);
    const focusDist = focusedPoint ? distanceToFocusPoint(center, focusedPoint, surfacePosition) : Infinity;
    const intersectsFocus = triangleIntersectsFocus(indices);
    const hasFocusOverride =
      inheritedFocus ||
      intersectsFocus ||
      (Number.isFinite(focusDist) && focusDist <= Math.max(state.settings.fineDetailRadius ?? 0, 0));
    return {
      indices,
      depth,
      baseFaceIndex,
      hasFocus: hasFocusOverride,
      cameraDist,
      focusDist,
      maxEdge: computeTriangleEdgeLength(indices),
      sse: computeTriangleSSE(indices, surfacePosition)
    };
  };

  const pushNode = (node) => {
    const inHighQueue = node.hasFocus || node.sse >= nearSSE;
    if (inHighQueue) {
      heapPush(highQueue, node);
    } else {
      heapPush(lowQueue, node);
    }
  };

  const popNode = () => {
    if (highQueue.length) return heapPop(highQueue);
    if (lowQueue.length) return heapPop(lowQueue);
    return null;
  };

  seedFaces.forEach((tri, faceIndex) => {
    const baseIndex = seedFaceBase[faceIndex] ?? faceIndex;
    const depthEstimate = preserveGeometry
      ? Math.max(
          vertexMaxDepth[tri[0]] ?? 0,
          vertexMaxDepth[tri[1]] ?? 0,
          vertexMaxDepth[tri[2]] ?? 0
        )
      : 0;
    pushNode(
      makeNode([...tri], depthEstimate, baseIndex, state.hasFocusedBary && state.focusedBaseFaceIndex === baseIndex)
    );
  });

  const canAllocateMoreVertices = () => {
    const remaining = vertexBudget - state.subdividedGeometry.vertices.length;
    return remaining > 3;
  };

  while (true) {
    const node = popNode();
    if (!node) break;
    const { indices, depth, baseFaceIndex, hasFocus } = node;
    const { cameraDist, focusDist, maxEdge, sse } = node;

    const neighborPressure = indices.some(idx => {
      const maxNeighborDepth = vertexMaxDepth[idx] ?? depth;
      return maxNeighborDepth - depth > 1;
    });
    const canSplit =
      depth < activeMaxDepth &&
      canAllocateMoreVertices() &&
      maxEdge > minEdgeLength;

    let shouldSplit = false;
    if (canSplit) {
      if (splitBudgetReached) {
        shouldSplit = false;
      } else {
        const distNorm = Math.min(cameraDist / maxRadius, 1);
        const pixelThreshold = THREE.MathUtils.lerp(nearSSE, farSSE, distNorm);
        const ssePass = sse >= pixelThreshold;
        const focusOverride =
          hasFocus ||
          (Number.isFinite(focusDist) && focusDist <= Math.max(state.settings.fineDetailRadius ?? 0, 0));

        shouldSplit = neighborPressure || ssePass || (focusOverride && maxEdge > minEdgeLength);
      }
    }

    const markAsLeaf = () => {
      leaves.push(indices);
      leafBaseIndex.push(baseFaceIndex);
      indices.forEach(idx => {
        vertexMaxDepth[idx] = Math.max(vertexMaxDepth[idx], depth);
      });
      maxDepthReached = Math.max(maxDepthReached, depth);
    };

    if (!shouldSplit) {
      markAsLeaf();
      await maybeYield();
      continue;
    }

    const childTris = subdivideTriangle(indices[0], indices[1], indices[2]);
    if (!childTris) {
      markAsLeaf();
      await maybeYield();
      continue;
    }
    const nextDepth = depth + 1;
    while (vertexMaxDepth.length < state.subdividedGeometry.vertices.length) {
      vertexMaxDepth.push(nextDepth);
    }
    indices.forEach(idx => {
      vertexMaxDepth[idx] = Math.max(vertexMaxDepth[idx], depth);
    });
    childTris.forEach(child => {
      const childNode = makeNode(child, nextDepth, baseFaceIndex, hasFocus);
      pushNode(childNode);
    });
    subdivisionCount++;
    if (splitBudget !== Infinity) {
      splitsPerformed++;
      if (splitsPerformed >= splitBudget) {
        splitBudgetReached = true;
      }
    }
    await maybeYield();
  }

  state.subdividedGeometry.faces = leaves;
  state.subdividedGeometry.faceBaseIndex = leafBaseIndex;
  state.subdividedGeometry.vertexDepths = vertexMaxDepth;
  const newVertexCount = Math.max(0, state.subdividedGeometry.vertices.length - initialVertexCount);
  const newVertexIndices = newVertexCount > 0
    ? Array.from({ length: newVertexCount }, (_, i) => initialVertexCount + i)
    : [];

  if (newVertexIndices.length && preserveGeometry) {
    propagateApproxHeightsAroundVertices(
      newVertexIndices,
      MOVEMENT_PROPAGATION_DEPTH,
      1
    );
  }

  return {
    newVertexIndices: preserveGeometry ? newVertexIndices : null,
    subdivisionCount,
    maxDepthReached
  };
}

// ──────────────────────── Patch Generation ────────────────────────
function generateMeshPatch() {
  const verts = state.subdividedGeometry.vertices;
  const faces = state.subdividedGeometry.faces;

  // Generate complete mesh state
  const positions = new Float32Array(verts.length * 3);
  const uvs = new Float32Array(verts.length * 2);

  for (let i = 0; i < verts.length; i++) {
    positions[i * 3 + 0] = verts[i].x;
    positions[i * 3 + 1] = verts[i].y;
    positions[i * 3 + 2] = verts[i].z;

    if (state.subdividedGeometry.uvCoords[i]) {
      uvs[i * 2 + 0] = state.subdividedGeometry.uvCoords[i][0];
      uvs[i * 2 + 1] = state.subdividedGeometry.uvCoords[i][1];
    }
  }

  const indices = new Uint32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    indices[i * 3 + 0] = faces[i][0];
    indices[i * 3 + 1] = faces[i][1];
    indices[i * 3 + 2] = faces[i][2];
  }

  return {
    positions,
    uvs,
    indices,
    faceBaseIndex: state.subdividedGeometry.faceBaseIndex.slice(),
    vertexCount: verts.length,
    faceCount: faces.length
  };
}

// ──────────────────────── Message Handlers ────────────────────────
const messageHandlers = {
  async init(payload) {
    // Initialize base icosahedron
    const { vertices, faces, settings } = payload;

    state.baseIcosahedron.vertices = vertices.map(v => new THREE.Vector3(v.x, v.y, v.z));
    state.baseIcosahedron.originalVertices = vertices.map(v => new THREE.Vector3(v.x, v.y, v.z));
    state.baseIcosahedron.faces = faces;
    state.baseVertexCount = vertices.length;

    if (settings) {
      Object.assign(state.settings, settings);
    }

    postMessage({
      type: 'status',
      message: `Worker initialized with ${vertices.length} base vertices, ${faces.length} faces`
    });
  },

  async refine(payload) {
    const { reason, surfacePosition, focusedPoint } = payload;

    const surfacePos = new THREE.Vector3(surfacePosition.x, surfacePosition.y, surfacePosition.z);
    const focusPos = focusedPoint ? new THREE.Vector3(focusedPoint.x, focusedPoint.y, focusedPoint.z) : null;

    const preserveGeometry = reason === 'movement' && state.subdividedGeometry.faces.length > 0;

    const result = await rebuildGlobeGeometry(surfacePos, focusPos, { preserveGeometry });

    const patch = generateMeshPatch();

    postMessage({
      type: 'refineResult',
      patch,
      stats: {
        reason,
        subdivisionCount: result.subdivisionCount,
        maxDepthReached: result.maxDepthReached,
        vertexCount: state.subdividedGeometry.vertices.length,
        faceCount: state.subdividedGeometry.faces.length
      }
    });
  },

  async applyElevations(payload) {
    const { updates } = payload;
    const changedIndices = [];

    for (const update of updates) {
      const { idx, height } = update;
      if (!Number.isFinite(height)) continue;

      const meta = ensureVertexMetadata(idx);
      if (!meta) continue;

      meta.fetching = false;
      meta.elevation = height;
      meta.approxElevation = null;
      applyElevationToVertex(idx, height, true);
      state.elevationCache.set(meta.geohash, { height });
      changedIndices.push(idx);

      // Propagate to neighbors
      propagateApproxHeightsAroundVertices([idx], MOVEMENT_PROPAGATION_DEPTH, 1);
    }

    // Generate vertex updates
    const vertexUpdates = changedIndices.map(idx => ({
      idx,
      position: {
        x: state.subdividedGeometry.vertices[idx].x,
        y: state.subdividedGeometry.vertices[idx].y,
        z: state.subdividedGeometry.vertices[idx].z
      }
    }));

    postMessage({
      type: 'vertexUpdates',
      updates: vertexUpdates
    });
  },

  async reset(payload) {
    const { clearElevations } = payload;

    if (clearElevations) {
      for (let i = 0; i < state.baseIcosahedron.vertices.length; i++) {
        state.baseIcosahedron.vertices[i].copy(state.baseIcosahedron.originalVertices[i]);
      }
      state.subdividedGeometry.vertexData.clear();
      state.elevationCache.clear();
      state.baseElevationsReady = false;
    }

    state.subdividedGeometry.vertices = state.baseIcosahedron.vertices.map(v => v.clone());
    state.subdividedGeometry.originalVertices = state.baseIcosahedron.originalVertices.map(v => v.clone());
    state.subdividedGeometry.faces = state.baseIcosahedron.faces.map(face => [...face]);
    state.subdividedGeometry.edgeCache.clear();
    state.subdividedGeometry.faceBaseIndex = state.baseIcosahedron.faces.map((_, idx) => idx);

    postMessage({
      type: 'status',
      message: 'Worker state reset'
    });
  },

  async updateSettings(payload) {
    Object.assign(state.settings, payload.settings);

    postMessage({
      type: 'status',
      message: 'Settings updated'
    });
  }
};

// ──────────────────────── Worker Message Loop ────────────────────────
self.onmessage = async (e) => {
  const { type, payload } = e.data;

  if (messageHandlers[type]) {
    try {
      await messageHandlers[type](payload);
    } catch (err) {
      postMessage({
        type: 'error',
        error: err.message,
        stack: err.stack
      });
    }
  } else {
    postMessage({
      type: 'error',
      error: `Unknown message type: ${type}`
    });
  }
};

postMessage({ type: 'ready' });
