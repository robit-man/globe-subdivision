import * as THREE from 'three';
import { SHOW_FOCUS_MARKER, FOCUS_RAY_LENGTH, CAMERA_FOV, PATCH_APPLY_BUDGET_MS } from './constants.js';
import { focusMarker, focusRayGeometry, focusRayLine } from './globe.js';
import { elevationEventBus } from './utils.js';

// ──────────────────────── Constants ────────────────────────
const EARTH_RADIUS_M = 6_371_000;
const FOCUS_BARY_EPS = 1e-4;
const FOV_RAD = THREE.MathUtils.degToRad(CAMERA_FOV);
function getViewportHeight() {
  if (typeof window !== 'undefined' && Number.isFinite(window.innerHeight)) {
    return Math.max(window.innerHeight, 1);
  }
  return 1080;
}

// ──────────────────────── Three.js Helpers ────────────────────────
const triangleHelper = new THREE.Triangle();
const tmpProjected = new THREE.Vector3();
const tmpBary = new THREE.Vector3();
const tmpPlane = new THREE.Plane();
const tmpCenter = new THREE.Vector3();
const tmpChildCenter = new THREE.Vector3();
const tmpFocusDir = new THREE.Vector3();
const tmpFocusEnd = new THREE.Vector3();
const tmpRayHit = new THREE.Vector3();
const tmpClosestPoint = new THREE.Vector3();
const tmpClosestOnSphere = new THREE.Vector3();
const tmpSnapDir = new THREE.Vector3();
const focusRay = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(1, 0, 0));
const focusedFaceBary = new THREE.Vector3(1/3, 1/3, 1/3);
let hasFocusedBary = false;

const MAX_MARKERS = 100000;
const BASE_PENDING_MAX_DEPTH = 4;
const BASE_PENDING_MAX_VERTICES = 12000;
const SUBDIVISION_SLICE_MS = 8;
const MOVEMENT_MAX_SPLITS = 300;
const MOVEMENT_PROPAGATION_DEPTH = 2;
const markerGeometry = new THREE.CircleGeometry(500, 8);
const markerMaterial = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 0.8,
  depthTest: false
});
const vertexMarkerIndices = new Map();
let markerCount = 0;
const WHITE_COLOR = new THREE.Color(0xffffff);
const GREEN_COLOR = new THREE.Color(0x00ff00);
const tmpMarkerPos = new THREE.Vector3();
const tmpMarkerLook = new THREE.Vector3();
const tmpMarkerUp = new THREE.Vector3();
const tmpMarkerMatrix = new THREE.Matrix4();

let markerInstanceMesh = null;
const pendingElevationApplications = [];
let meshRefreshPending = false;

// ──────────────────────── Terrain Worker Scheduler State ────────────────────────
let terrainWorker = null;
let terrainWorkerReady = false;
let workerInitQueued = false;
const workerPatchQueue = [];
const pendingWorkerMessages = [];
const pendingMeshPatches = [];
const pendingVertexUpdates = [];
const workerStatus = {
  isProcessing: false,
  pendingJobs: 0,
  message: null
};
let _schedulerDeps = null;

function initTerrainScheduler(deps = {}) {
  _schedulerDeps = deps;
  if (typeof Worker === 'undefined') {
    console.warn('[terrain] Web Workers unsupported in this environment.');
    return null;
  }
  if (terrainWorker) {
    maybeQueueWorkerInit();
    return terrainWorker;
  }
  try {
    terrainWorker = new Worker(new URL('./terrainWorker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    console.error('[terrain] Failed to create worker', err);
    terrainWorker = null;
    return null;
  }
  terrainWorker.onmessage = handleWorkerMessage;
  terrainWorker.onerror = (event) => console.error('[terrain] Worker error', event.message || event);
  maybeQueueWorkerInit();
  return terrainWorker;
}

function handleWorkerMessage(event) {
  const data = event.data;
  if (!data) return;
  switch (data.type) {
    case 'ready':
      terrainWorkerReady = true;
      flushPendingWorkerMessages();
      return;
    case 'init:ack':
      workerStatus.message = 'Worker initialized';
      return;
    case 'status':
      workerStatus.isProcessing = data.payload?.isProcessing ?? workerStatus.isProcessing;
      workerStatus.pendingJobs = data.payload?.pendingJobs ?? workerStatus.pendingJobs;
      workerStatus.message = data.payload?.message ?? workerStatus.message;
      workerPatchQueue.push(data);
      return;
    case 'error':
      console.error('[terrain] Worker reported error', data.error);
      return;
    default:
      workerPatchQueue.push(data);
  }
}

function maybeQueueWorkerInit() {
  if (workerInitQueued) return;
  const basePayload = serializeBaseIcosahedron();
  if (!basePayload) {
    console.warn('[terrain] Base icosahedron not captured; deferring worker init');
    return;
  }
  const settingsPayload = extractSchedulerSettings();
  const message = { type: 'init', payload: { baseIcosahedron: basePayload, settings: settingsPayload } };
  workerInitQueued = true;
  postMessageToWorker(message);
}

function serializeBaseIcosahedron() {
  if (!baseIcosahedron || !baseIcosahedron.vertices?.length) return null;
  return {
    vertices: baseIcosahedron.vertices.map(v => ({ x: v.x, y: v.y, z: v.z })),
    faces: baseIcosahedron.faces.map(face => [...face])
  };
}

function extractSchedulerSettings() {
  const source = _settings || _schedulerDeps?.settings;
  if (!source) return null;
  return {
    maxRadius: source.maxRadius,
    minSpacingM: source.minSpacingM,
    maxSpacingM: source.maxSpacingM,
    fineDetailRadius: source.fineDetailRadius,
    fineDetailFalloff: source.fineDetailFalloff,
    sseNearThreshold: source.sseNearThreshold,
    sseFarThreshold: source.sseFarThreshold,
    elevExag: source.elevExag,
    maxVertices: source.maxVertices,
    dataset: source.dataset
  };
}

function postMessageToWorker(message) {
  if (!terrainWorker) return;
  if (!terrainWorkerReady) {
    pendingWorkerMessages.push(message);
    return;
  }
  terrainWorker.postMessage(message);
}

function flushPendingWorkerMessages() {
  while (pendingWorkerMessages.length) {
    const msg = pendingWorkerMessages.shift();
    terrainWorker.postMessage(msg);
  }
}

function requestRefine(payload = {}) {
  if (!terrainWorker) {
    console.warn('[terrain] Worker not initialized; call initTerrainScheduler first.');
    return;
  }
  postMessageToWorker({ type: 'refine', payload });
}

function queueElevationBatch(updates = []) {
  if (!terrainWorker || !Array.isArray(updates) || !updates.length) return;
  postMessageToWorker({ type: 'applyElevations', payload: { updates } });
}

function applyPendingPatches(timeBudgetMs = PATCH_APPLY_BUDGET_MS) {
  if (!workerPatchQueue.length) return;
  const nowFn = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : () => Date.now();
  const start = nowFn();
  while (workerPatchQueue.length) {
    const packet = workerPatchQueue.shift();
    if (!packet) continue;
    switch (packet.type) {
      case 'status':
        if (_dom?.queueCount && typeof workerStatus.pendingJobs === 'number') {
          _dom.queueCount.textContent = workerStatus.pendingJobs.toString();
        }
        break;
      case 'refineResult':
        pendingMeshPatches.push(packet.patch);
        meshRefreshPending = true;
        break;
      case 'vertexUpdates':
        if (Array.isArray(packet.updates)) {
          pendingVertexUpdates.push(...packet.updates);
        }
        meshRefreshPending = true;
        break;
      default:
        console.warn('[terrain] Unhandled worker packet', packet.type);
    }
    if (nowFn() - start >= timeBudgetMs) {
      break;
    }
  }
}

// ──────────────────────── Geohash ────────────────────────
const GH32 = '0123456789bcdefghjkmnpqrstuvwxyz';
function geohashEncode(lat, lon, precision=9){
  let bit=0, even=true, latMin=-90,latMax=90,lonMin=-180,lonMax=180, ch=0, hash='';
  while (hash.length < precision){
    if (even){ const mid=(lonMin+lonMax)/2; if (lon > mid){ ch |= (1<<(4-bit)); lonMin=mid; } else { lonMax=mid; } }
    else { const mid=(latMin+latMax)/2; if (lat > mid){ ch |= (1<<(4-bit)); latMin=mid; } else { latMax=mid; } }
    even=!even;
    if (bit<4){ bit++; } else { hash += GH32[ch]; bit=0; ch=0; }
  }
  return hash;
}

// ──────────────────────── Utilities ────────────────────────
function cartesianToLatLon(vec) {
  const r = vec.length();
  const lat = Math.asin(THREE.MathUtils.clamp(vec.y / r, -1, 1));
  const lon = Math.atan2(vec.z, vec.x);
  return {
    latDeg: THREE.MathUtils.radToDeg(lat),
    lonDeg: THREE.MathUtils.radToDeg(lon)
  };
}

function uuidv4(){
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
    const r = Math.random()*16|0, v = c==='x'?r:(r&0x3|0x8); return v.toString(16);
  });
}

// ──────────────────────── Base icosahedron capture ────────────────────────
const baseIcosahedron = {
  vertices: [],
  originalVertices: [],
  faces: []
};
let baseVertexCount = 0;
let baseElevationsReady = false;

function captureBaseIcosahedron(globeGeometry) {
  const pos = globeGeometry.getAttribute('position');
  const idx = globeGeometry.getIndex();

  for (let i = 0; i < pos.count; i++) {
    const vx = new THREE.Vector3(
      pos.getX(i),
      pos.getY(i),
      pos.getZ(i)
    );
    baseIcosahedron.vertices.push(vx.clone());
    baseIcosahedron.originalVertices.push(vx.clone());
  }

  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      baseIcosahedron.faces.push([
        idx.getX(i),
        idx.getX(i + 1),
        idx.getX(i + 2)
      ]);
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      baseIcosahedron.faces.push([i, i + 1, i + 2]);
    }
  }

  baseVertexCount = baseIcosahedron.vertices.length;
  console.log(`Base icosahedron: ${baseIcosahedron.vertices.length} vertices, ${baseIcosahedron.faces.length} faces`);
}

// ──────────────────────── Subdiv geometry structure ────────────────────────
const subdividedGeometry = {
  vertices: [],
  originalVertices: [],
  faces: [],
  vertexData: new Map(),
  edgeCache: new Map(),
  uvCoords: [],
  faceBaseIndex: [],
  vertexDepths: []
};

let focusedBaseFaceIndex = null;

// ──────────────────────── Vertex metadata and marker management ────────────────────────
function ensureVertexMetadata(idx, elevationCache, elevExag) {
  if (idx == null) return null;
  let data = subdividedGeometry.vertexData.get(idx);
  if (!data) {
    const origin = subdividedGeometry.originalVertices[idx] || subdividedGeometry.vertices[idx];
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
    subdividedGeometry.vertexData.set(idx, data);
  }

  const cached = elevationCache.get(data.geohash);
  if (cached && Number.isFinite(cached.height)) {
    if (data.elevation == null) data.elevation = cached.height;
  }

  if (data.elevation != null) {
    applyElevationToVertex(idx, data.elevation, elevExag, true);
  } else if (data.approxElevation != null) {
    applyElevationToVertex(idx, data.approxElevation, elevExag, false);
  }

  return data;
}

function applyElevationToVertex(idx, height, elevExag, isFinal) {
  if (height == null) return;
  const originalPos = subdividedGeometry.originalVertices[idx] || subdividedGeometry.vertices[idx];
  if (!originalPos) return;
  const baseRadius = originalPos.length();
  const radialDir = originalPos.clone().normalize();
  const targetRadius = baseRadius + height * elevExag;
  subdividedGeometry.vertices[idx].copy(radialDir.multiplyScalar(targetRadius));
  if (isFinal) {
    updateVertexMarkerColor(idx, true);
  }
}

function updateFocusIndicators(point) {
  if (!focusRayGeometry || !focusRayLine) {
    if (focusMarker) {
      focusMarker.visible = false;
    }
    return;
  }

  if (!point) {
    focusRayLine.visible = false;
    if (!SHOW_FOCUS_MARKER && focusMarker) {
      focusMarker.visible = false;
    }
    return;
  }

  tmpFocusDir.copy(point);
  if (tmpFocusDir.lengthSq() < 1e-8) {
    focusRayLine.visible = false;
    if (!SHOW_FOCUS_MARKER && focusMarker) {
      focusMarker.visible = false;
    }
    return;
  }

  tmpFocusDir.normalize();
  focusRay.origin.set(0, 0, 0);
  focusRay.direction.copy(tmpFocusDir);

  const positions = focusRayGeometry.attributes.position.array;
  positions[0] = 0;
  positions[1] = 0;
  positions[2] = 0;

  tmpFocusEnd.copy(tmpFocusDir).multiplyScalar(FOCUS_RAY_LENGTH);
  positions[3] = tmpFocusEnd.x;
  positions[4] = tmpFocusEnd.y;
  positions[5] = tmpFocusEnd.z;
  focusRayGeometry.attributes.position.needsUpdate = true;
  focusRayGeometry.computeBoundingSphere();

  focusRayLine.visible = true;

  if (SHOW_FOCUS_MARKER && focusMarker) {
    focusMarker.position.copy(point);
    focusMarker.visible = true;
  } else if (focusMarker) {
    focusMarker.visible = false;
  }
}

function initMarkerInstanceMesh(scene, ENABLE_VERTEX_MARKERS) {
  if (!ENABLE_VERTEX_MARKERS) return;
  if (!markerInstanceMesh) {
    markerInstanceMesh = new THREE.InstancedMesh(markerGeometry, markerMaterial, MAX_MARKERS);
    markerInstanceMesh.frustumCulled = false;
    scene.add(markerInstanceMesh);
  }
  markerCount = 0;
  vertexMarkerIndices.clear();
  markerInstanceMesh.count = 0;
  markerInstanceMesh.instanceMatrix.needsUpdate = true;
  if (markerInstanceMesh.instanceColor) {
    markerInstanceMesh.instanceColor.needsUpdate = true;
  }
}

function createVertexMarker(vertexIdx, ENABLE_VERTEX_MARKERS) {
  if (!ENABLE_VERTEX_MARKERS) return;
  const v = subdividedGeometry.vertices[vertexIdx];
  if (!v || markerCount >= MAX_MARKERS) return;

  const instanceIdx = markerCount++;
  vertexMarkerIndices.set(vertexIdx, instanceIdx);
  applyMarkerTransform(vertexIdx, instanceIdx);
  markerInstanceMesh.setColorAt(instanceIdx, WHITE_COLOR);
  if (markerInstanceMesh.instanceColor) {
    markerInstanceMesh.instanceColor.needsUpdate = true;
  }
  markerInstanceMesh.instanceMatrix.needsUpdate = true;
}

function applyMarkerTransform(vertexIdx, instanceIdx) {
  const v = subdividedGeometry.vertices[vertexIdx];
  if (!v || !markerInstanceMesh) return;

  const radius = v.length();
  tmpMarkerUp.copy(v).normalize();
  tmpMarkerPos.copy(tmpMarkerUp).multiplyScalar(radius + 10);
  tmpMarkerLook.copy(tmpMarkerUp).multiplyScalar(radius + 1000);
  tmpMarkerMatrix.lookAt(tmpMarkerPos, tmpMarkerLook, tmpMarkerUp);
  tmpMarkerMatrix.setPosition(tmpMarkerPos);
  markerInstanceMesh.setMatrixAt(instanceIdx, tmpMarkerMatrix);
}

function updateVertexMarkerColor(vertexIdx, hasElevation) {
  const instanceIdx = vertexMarkerIndices.get(vertexIdx);
  if (instanceIdx !== undefined && markerInstanceMesh) {
    markerInstanceMesh.setColorAt(instanceIdx, hasElevation ? GREEN_COLOR : WHITE_COLOR);
    if (markerInstanceMesh.instanceColor) {
      markerInstanceMesh.instanceColor.needsUpdate = true;
    }
    applyMarkerTransform(vertexIdx, instanceIdx);
    markerInstanceMesh.instanceMatrix.needsUpdate = true;
  }
}

function clearAllVertexMarkers(ENABLE_VERTEX_MARKERS) {
  if (!ENABLE_VERTEX_MARKERS) return;
  markerCount = 0;
  vertexMarkerIndices.clear();
  if (markerInstanceMesh) {
    markerInstanceMesh.count = 0;
    markerInstanceMesh.instanceMatrix.needsUpdate = true;
    if (markerInstanceMesh.instanceColor) {
      markerInstanceMesh.instanceColor.needsUpdate = true;
    }
  }
}

// ──────────────────────── Complete subdivision system ────────────────────────
let loggedBaseVertexDump = false;

function resetTerrainGeometryToBase(clearElevations, elevationCache, dom, ENABLE_VERTEX_MARKERS) {
  clearAllVertexMarkers(ENABLE_VERTEX_MARKERS);
  if (clearElevations) {
    for (let i = 0; i < baseIcosahedron.vertices.length; i++) {
      baseIcosahedron.vertices[i].copy(baseIcosahedron.originalVertices[i]);
    }
  }

  subdividedGeometry.vertices = baseIcosahedron.vertices.map(v => v.clone());
  subdividedGeometry.originalVertices = baseIcosahedron.originalVertices.map(v => v.clone());
  subdividedGeometry.faces = baseIcosahedron.faces.map(face => [...face]);
  subdividedGeometry.edgeCache.clear();
  if (clearElevations) {
    subdividedGeometry.vertexData.clear();
    elevationCache.clear();
    baseElevationsReady = false;
  } else {
    for (const [key, data] of subdividedGeometry.vertexData.entries()) {
      if (key >= baseVertexCount) {
        subdividedGeometry.vertexData.delete(key);
      } else if (data) {
        data.fetching = false;
      }
    }
  }
  subdividedGeometry.faceBaseIndex = baseIcosahedron.faces.map((_, idx) => idx);
  // Only reset the log flag when clearing elevations (full reset)
  if (clearElevations) {
    loggedBaseVertexDump = false;
  }

  subdividedGeometry.uvCoords = [];
  for (let v of subdividedGeometry.vertices) {
    const normalized = v.clone().normalize();
    let u = 0.5 - Math.atan2(normalized.z, normalized.x) / (2 * Math.PI);
    u = (u + 0.5) % 1.0;
    const vCoord = 0.5 + Math.asin(normalized.y) / Math.PI;
    subdividedGeometry.uvCoords.push([u, vCoord]);
  }

  subdividedGeometry.vertexDepths = new Array(subdividedGeometry.vertices.length).fill(0);

  dom.queueCount.textContent = '0';
}

function getMidpointVertex(v1Idx, v2Idx, elevationCache, elevExag) {
  const key = v1Idx < v2Idx ? `${v1Idx}_${v2Idx}` : `${v2Idx}_${v1Idx}`;

  if (subdividedGeometry.edgeCache.has(key)) {
    return subdividedGeometry.edgeCache.get(key);
  }

  const v1 = subdividedGeometry.vertices[v1Idx];
  const v2 = subdividedGeometry.vertices[v2Idx];
  if (!v1 || !v2) {
    console.warn('Missing vertices while computing midpoint', v1Idx, v2Idx);
    return null;
  }

  const mid = new THREE.Vector3().addVectors(v1, v2).multiplyScalar(0.5);
  mid.normalize().multiplyScalar(EARTH_RADIUS_M);

  const newIdx = subdividedGeometry.vertices.length;
  subdividedGeometry.vertices.push(mid.clone());
  subdividedGeometry.originalVertices.push(mid.clone());

  const normalized = mid.clone().normalize();
  let u = 0.5 - Math.atan2(normalized.z, normalized.x) / (2 * Math.PI);
  u = (u + 0.5) % 1.0;
  const v_coord = 0.5 + Math.asin(normalized.y) / Math.PI;
  subdividedGeometry.uvCoords.push([u, v_coord]);

  if (!subdividedGeometry.vertexDepths) {
    subdividedGeometry.vertexDepths = new Array(subdividedGeometry.vertices.length).fill(0);
  }
  const parentDepth = Math.max(
    subdividedGeometry.vertexDepths[v1Idx] ?? 0,
    subdividedGeometry.vertexDepths[v2Idx] ?? 0
  );
  subdividedGeometry.vertexDepths[newIdx] = parentDepth + 1;

  const parentMetaA = ensureVertexMetadata(v1Idx, elevationCache, elevExag);
  const parentMetaB = ensureVertexMetadata(v2Idx, elevationCache, elevExag);
  const childMeta = ensureVertexMetadata(newIdx, elevationCache, elevExag);
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
    applyElevationToVertex(newIdx, avgHeight, elevExag, false);
  }

  subdividedGeometry.edgeCache.set(key, newIdx);

  return newIdx;
}

function subdivideTriangle(v1Idx, v2Idx, v3Idx, elevationCache, elevExag) {
  const v12 = getMidpointVertex(v1Idx, v2Idx, elevationCache, elevExag);
  const v23 = getMidpointVertex(v2Idx, v3Idx, elevationCache, elevExag);
  const v31 = getMidpointVertex(v3Idx, v1Idx, elevationCache, elevExag);
  if (v12 == null || v23 == null || v31 == null) {
    console.warn('Skipping subdivision due to missing midpoint', { v1Idx, v2Idx, v3Idx, v12, v23, v31 });
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
  const v1 = subdividedGeometry.vertices[triangle[0]];
  const v2 = subdividedGeometry.vertices[triangle[1]];
  const v3 = subdividedGeometry.vertices[triangle[2]];
  if (!v1 || !v2 || !v3) return 0;
  const edge1 = v1.distanceTo(v2);
  const edge2 = v2.distanceTo(v3);
  const edge3 = v3.distanceTo(v1);
  const maxEdge = Math.max(edge1, edge2, edge3);
  const center = tmpCenter.copy(v1).add(v2).add(v3).multiplyScalar(1 / 3);
  const distanceToCamera = Math.max(center.distanceTo(surfacePosition), 1);
  const viewportHeight = getViewportHeight();
  return (maxEdge / distanceToCamera) * viewportHeight / (2 * Math.tan(FOV_RAD / 2));
}

function computeTriangleEdgeLength(triangle) {
  const v1 = subdividedGeometry.vertices[triangle[0]];
  const v2 = subdividedGeometry.vertices[triangle[1]];
  const v3 = subdividedGeometry.vertices[triangle[2]];
  if (!v1 || !v2 || !v3) return Infinity;
  const edge1 = v1.distanceTo(v2);
  const edge2 = v2.distanceTo(v3);
  const edge3 = v3.distanceTo(v1);
  return Math.max(edge1, edge2, edge3);
}

function triangleIntersectsFocus(triangle) {
  if (!focusRay || focusRay.direction.lengthSq() === 0) return false;
  const v1 = subdividedGeometry.vertices[triangle[0]];
  const v2 = subdividedGeometry.vertices[triangle[1]];
  const v3 = subdividedGeometry.vertices[triangle[2]];
  if (!v1 || !v2 || !v3) return false;
  const hit = focusRay.intersectTriangle(v1, v2, v3, false, tmpRayHit);
  if (!hit) return false;
  triangleHelper.set(v1, v2, v3);
  triangleHelper.getBarycoord(tmpRayHit, tmpBary);
  return Math.min(tmpBary.x, tmpBary.y, tmpBary.z) >= -FOCUS_BARY_EPS;
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

function findClosestBaseFaceIndex(surfacePosition) {
  let closestIndex = 0;
  let closestDist = Infinity;
  for (let i = 0; i < baseIcosahedron.faces.length; i++) {
    const tri = baseIcosahedron.faces[i];
    const v1 = baseIcosahedron.vertices[tri[0]];
    const v2 = baseIcosahedron.vertices[tri[1]];
    const v3 = baseIcosahedron.vertices[tri[2]];
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
  triangleHelper.set(a, b, c);
  tmpPlane.setFromCoplanarPoints(a, b, c);
  tmpPlane.projectPoint(point, outProjected);

  triangleHelper.getBarycoord(outProjected, outBary);

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
    hasFocusedBary = false;
    focusedFaceBary.set(1/3, 1/3, 1/3);
    return;
  }
  const face = baseIcosahedron.faces[faceIndex];
  if (!face) {
    hasFocusedBary = false;
    return;
  }
  const a = baseIcosahedron.vertices[face[0]];
  const b = baseIcosahedron.vertices[face[1]];
  const c = baseIcosahedron.vertices[face[2]];
  if (!a || !b || !c) {
    hasFocusedBary = false;
    return;
  }

  let barySet = false;
  if (focusRay.direction.lengthSq() > 0) {
    const hit = focusRay.intersectTriangle(a, b, c, false, tmpRayHit);
    if (hit) {
      triangleHelper.set(a, b, c);
      triangleHelper.getBarycoord(tmpRayHit, focusedFaceBary);
      const minComponent = Math.min(focusedFaceBary.x, focusedFaceBary.y, focusedFaceBary.z);
      if (minComponent >= -FOCUS_BARY_EPS) {
        barySet = true;
        hasFocusedBary = true;
      }
    }
  }

  if (!barySet) {
    hasFocusedBary = projectPointOntoTriangle(point, a, b, c, focusedFaceBary, tmpProjected);
  }

  if (!hasFocusedBary) {
    const sum = focusedFaceBary.x + focusedFaceBary.y + focusedFaceBary.z;
    if (Math.abs(sum) > 1e-6) {
      focusedFaceBary.multiplyScalar(1 / sum);
    } else {
      focusedFaceBary.set(1/3, 1/3, 1/3);
    }
  }
}

function shouldSubdivideTriangle(triangle, baseFaceIndex, focusPathActive, distanceToFocus, settings, focusedPoint, surfacePosition) {
  const v1 = subdividedGeometry.vertices[triangle[0]];
  const v2 = subdividedGeometry.vertices[triangle[1]];
  const v3 = subdividedGeometry.vertices[triangle[2]];

  const edge1 = v1.distanceTo(v2);
  const edge2 = v2.distanceTo(v3);
  const edge3 = v3.distanceTo(v1);
  const maxEdge = Math.max(edge1, edge2, edge3);

  const center = tmpCenter.copy(v1).add(v2).add(v3).multiplyScalar(1 / 3);
  const sampleDistances = [];
  const centerDist = Number.isFinite(distanceToFocus)
    ? distanceToFocus
    : distanceToFocusPoint(center, focusedPoint, surfacePosition);
  if (Number.isFinite(centerDist)) sampleDistances.push(centerDist);
  const d1 = distanceToFocusPoint(v1, focusedPoint, surfacePosition);
  const d2 = distanceToFocusPoint(v2, focusedPoint, surfacePosition);
  const d3 = distanceToFocusPoint(v3, focusedPoint, surfacePosition);
  if (Number.isFinite(d1)) sampleDistances.push(d1);
  if (Number.isFinite(d2)) sampleDistances.push(d2);
  if (Number.isFinite(d3)) sampleDistances.push(d3);

  if (focusedPoint && focusedPoint.lengthSq() > 0) {
    triangleHelper.set(v1, v2, v3);
    triangleHelper.closestPointToPoint(focusedPoint, tmpClosestPoint);
    if (tmpClosestPoint.lengthSq() > 0) {
      tmpClosestOnSphere.copy(tmpClosestPoint).normalize().multiplyScalar(EARTH_RADIUS_M);
      const focusClosestDist = surfaceDistanceBetween(tmpClosestOnSphere, focusedPoint);
      if (Number.isFinite(focusClosestDist)) {
        sampleDistances.push(focusClosestDist);
      }
    }
  }

  if (!sampleDistances.length) return false;
  const minSampleDist = Math.min(...sampleDistances);
  const maxSampleDist = Math.max(...sampleDistances);

  const viewportHeight = getViewportHeight();
  const distanceToCamera = Math.max(center.distanceTo(surfacePosition), 1);
  const sse = (maxEdge / distanceToCamera) * viewportHeight / (2 * Math.tan(FOV_RAD / 2));
  const nearThreshold = Math.max(0.25, settings.sseNearThreshold ?? 2.0);
  const farThreshold = Math.max(nearThreshold, settings.sseFarThreshold ?? nearThreshold);
  const distNormCamera = Math.min(distanceToCamera / Math.max(settings.maxRadius, 1), 1);
  const pixelThreshold = THREE.MathUtils.lerp(nearThreshold, farThreshold, distNormCamera);
  const ssePass = sse >= pixelThreshold;

  const approxRadius = maxEdge * 0.5;
  const effectiveDist = Math.max(0, minSampleDist - approxRadius * 0.5);

  const maxRadius = Math.max(settings.maxRadius, 1);
  if (effectiveDist > maxRadius) {
    return false;
  }

  const minEdge = Math.max(settings.minSpacingM, 1);
  const maxEdgeAllowed = Math.max(settings.maxSpacingM, minEdge);
  const fineRadius = Math.max(settings.fineDetailRadius, 0);

  const nearOverride = effectiveDist <= fineRadius;
  if (!focusPathActive && !nearOverride && !ssePass) {
    return false;
  }

  let targetEdge = maxEdgeAllowed;

  if (focusPathActive || nearOverride) {
    targetEdge = minEdge;
  } else {
    const falloff = Math.max(settings.fineDetailFalloff, 1);
    const t = Math.min((effectiveDist - fineRadius) / falloff, 1);
    const smooth = t * t * (3 - 2 * t);
    const farNorm = Math.min(distanceToCamera / maxRadius, 1);
    const farTarget = minEdge + (maxEdgeAllowed - minEdge) * farNorm;
    targetEdge = THREE.MathUtils.lerp(minEdge, farTarget, smooth);
  }

  return maxEdge > targetEdge;
}

function applyApproxHeightsForSmallFaces(maxEdgeMeters, elevExag, elevationCache, minKnownSamples = 1) {
  if (!Number.isFinite(maxEdgeMeters)) maxEdgeMeters = Infinity;
  if (maxEdgeMeters <= 0) return 0;
  let applied = 0;
  const faces = subdividedGeometry.faces;
  if (!faces || !faces.length) return 0;

  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    if (!face) continue;
    const [i0, i1, i2] = face;
    const v0 = subdividedGeometry.vertices[i0];
    const v1 = subdividedGeometry.vertices[i1];
    const v2 = subdividedGeometry.vertices[i2];
    if (!v0 || !v1 || !v2) continue;

    const edge01 = v0.distanceTo(v1);
    const edge12 = v1.distanceTo(v2);
    const edge20 = v2.distanceTo(v0);
    const maxEdge = Math.max(edge01, edge12, edge20);
    if (maxEdge > maxEdgeMeters) continue;

    const indices = [i0, i1, i2];
    const metas = indices.map(idx => ensureVertexMetadata(idx, elevationCache, elevExag));
    const heights = metas.map(meta => {
      if (!meta) return null;
      return meta.elevation != null ? meta.elevation : meta.approxElevation;
    });
    const knownHeights = heights.filter(h => h != null);
    if (knownHeights.length < minKnownSamples) continue;
    const avgHeight = knownHeights.reduce((sum, h) => sum + h, 0) / knownHeights.length;

    for (let j = 0; j < indices.length; j++) {
      const meta = metas[j];
      if (!meta || meta.elevation != null || meta.approxElevation != null) continue;
      meta.approxElevation = avgHeight;
      applyElevationToVertex(indices[j], avgHeight, elevExag, false);
      applied++;
    }
  }

  return applied;
}

function buildVertexAdjacency() {
  const verts = subdividedGeometry.vertices;
  const adjacency = new Array(verts.length);
  for (let i = 0; i < subdividedGeometry.faces.length; i++) {
    const [a, b, c] = subdividedGeometry.faces[i];
    adjacency[a] = adjacency[a] || new Set();
    adjacency[b] = adjacency[b] || new Set();
    adjacency[c] = adjacency[c] || new Set();
    adjacency[a].add(b).add(c);
    adjacency[b].add(a).add(c);
    adjacency[c].add(a).add(b);
  }
  return adjacency;
}

function blurApproxHeights(iterations = 1, elevExag, elevationCache, adjacency) {
  const verts = subdividedGeometry.vertices;
  adjacency = adjacency || buildVertexAdjacency();

  for (let iter = 0; iter < iterations; iter++) {
    const newApprox = new Map();
    for (let i = 0; i < verts.length; i++) {
      const meta = ensureVertexMetadata(i, elevationCache, elevExag);
      if (!meta || meta.elevation != null) continue;
      const neighbors = adjacency[i];
      if (!neighbors || neighbors.size === 0) continue;
      let sum = 0;
      let count = 0;
      for (const nIdx of neighbors) {
        const nMeta = ensureVertexMetadata(nIdx, elevationCache, elevExag);
        if (!nMeta) continue;
        const h = nMeta.elevation != null ? nMeta.elevation : nMeta.approxElevation;
        if (!Number.isFinite(h)) continue;
        sum += h;
        count++;
      }
      if (count >= 1) {
        newApprox.set(i, sum / count);
      }
    }
    for (const [idx, height] of newApprox.entries()) {
      const meta = subdividedGeometry.vertexData.get(idx);
      if (!meta || meta.elevation != null) continue;
      meta.approxElevation = height;
      applyElevationToVertex(idx, height, elevExag, false);
    }
    if (!newApprox.size) break;
  }
}

function propagateApproxHeightsFromKnown(elevExag, elevationCache, iterations = 2, minNeighbors = 2, adjacency) {
  const verts = subdividedGeometry.vertices;
  if (!verts.length) return;
  adjacency = adjacency || buildVertexAdjacency();
  for (let iter = 0; iter < iterations; iter++) {
    const updates = [];
    for (let i = 0; i < verts.length; i++) {
      const meta = ensureVertexMetadata(i, elevationCache, elevExag);
      if (!meta || meta.elevation != null) continue;
      const neighbors = adjacency[i];
      if (!neighbors || !neighbors.size) continue;
      let sum = 0;
      let count = 0;
      neighbors.forEach(nIdx => {
        const nMeta = ensureVertexMetadata(nIdx, elevationCache, elevExag);
        if (!nMeta) return;
        const h = nMeta.elevation != null ? nMeta.elevation : nMeta.approxElevation;
        if (!Number.isFinite(h)) return;
        sum += h;
        count++;
      });
      if (count >= minNeighbors) {
        updates.push([i, sum / count]);
      }
    }
    if (!updates.length) break;
    for (const [idx, height] of updates) {
      const meta = subdividedGeometry.vertexData.get(idx);
      if (!meta || meta.elevation != null) continue;
      meta.approxElevation = height;
      applyElevationToVertex(idx, height, elevExag, false);
    }
  }
}

function propagateApproxHeightsAroundVertices(sourceIndices, elevExag, elevationCache, maxDepth = 2, minNeighbors = 2) {
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
    const meta = ensureVertexMetadata(idx, elevationCache, elevExag);
    if (!meta || meta.elevation != null) continue;
    const neighbors = adjacency[idx];
    if (!neighbors || neighbors.size === 0) continue;
    let sum = 0;
    let count = 0;
    neighbors.forEach(nIdx => {
      const nMeta = ensureVertexMetadata(nIdx, elevationCache, elevExag);
      if (!nMeta) return;
      const h = nMeta.elevation != null ? nMeta.elevation : nMeta.approxElevation;
      if (!Number.isFinite(h)) return;
      sum += h;
      count++;
    });
    if (count >= minNeighbors) {
      const avg = sum / count;
      meta.approxElevation = avg;
      applyElevationToVertex(idx, avg, elevExag, false);
    }
  }
}

export function queueElevationApplication(idx, height) {
  if (!Number.isFinite(height)) return;
  if (!Number.isInteger(idx) || idx < 0) return;
  pendingElevationApplications.push({ idx, height });
}

export function processPendingElevationApplications(timeBudgetMs = 4) {
  if (!pendingElevationApplications.length) {
    if (meshRefreshPending) {
      runGlobeMeshUpdate();
      meshRefreshPending = false;
    }
    return;
  }
  if (!_settings || !_elevationCache) {
    pendingElevationApplications.length = 0;
    meshRefreshPending = false;
    return;
  }
  const start = performance.now();
  while (pendingElevationApplications.length) {
    if (timeBudgetMs != null && timeBudgetMs >= 0) {
      if (performance.now() - start >= timeBudgetMs) break;
    }
    const { idx, height } = pendingElevationApplications.shift();
    const meta = ensureVertexMetadata(idx, _elevationCache, _settings.elevExag);
    if (!meta) continue;
    meta.fetching = false;
    if (!Number.isFinite(height)) continue;
    meta.elevation = height;
    meta.approxElevation = null;
    applyElevationToVertex(idx, height, _settings.elevExag, true);
    _elevationCache.set(meta.geohash, { height });
    try {
      propagateApproxHeightsAroundVertices([idx], _settings.elevExag, _elevationCache, MOVEMENT_PROPAGATION_DEPTH, 1);
    } catch (err) {
      console.warn('Propagation error', err);
    }
    const appliedPosition = subdividedGeometry.vertices[idx]?.clone();
    if (appliedPosition) {
      elevationEventBus.emit('fetch:applied', { idx, position: appliedPosition });
    }
    meshRefreshPending = true;
  }
  if (!pendingElevationApplications.length && meshRefreshPending) {
    runGlobeMeshUpdate();
    meshRefreshPending = false;
  }
}

async function rebuildGlobeGeometry(settings, surfacePosition, focusedPoint, elevationCache, FOCUS_DEBUG, ENABLE_VERTEX_MARKERS, options = {}) {
  const { preserveGeometry = false, incrementalSplitBudget = MOVEMENT_MAX_SPLITS } = options;
  const startTime = performance.now();
  let lastYieldTime = startTime;

  const maybeYield = async () => {
    if (performance.now() - lastYieldTime < SUBDIVISION_SLICE_MS) return;
    if (typeof requestAnimationFrame === 'function') {
      await new Promise(resolve => requestAnimationFrame(resolve));
    } else {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    lastYieldTime = performance.now();
  };

  const shouldLog = FOCUS_DEBUG;
  if (shouldLog) {
    console.log(`User surface position: (${surfacePosition.x.toFixed(0)}, ${surfacePosition.y.toFixed(0)}, ${surfacePosition.z.toFixed(0)}), length=${surfacePosition.length().toFixed(0)}m`);
    const userLatLon = cartesianToLatLon(surfacePosition);
    console.log(`User GPS: ${userLatLon.latDeg.toFixed(4)}°, ${userLatLon.lonDeg.toFixed(4)}°`);
  }

  const seedFaces = [];
  const seedFaceBase = [];
  let initialVertexCount = 0;

  if (!preserveGeometry || subdividedGeometry.vertices.length === 0) {
    clearAllVertexMarkers(ENABLE_VERTEX_MARKERS);

    subdividedGeometry.vertices = baseIcosahedron.vertices.map(v => v.clone());
    subdividedGeometry.originalVertices = baseIcosahedron.originalVertices.map(v => v.clone());
    subdividedGeometry.faces = [];
    subdividedGeometry.edgeCache.clear();
    for (const key of subdividedGeometry.vertexData.keys()) {
      if (key >= subdividedGeometry.vertices.length) {
        subdividedGeometry.vertexData.delete(key);
      } else {
        const meta = subdividedGeometry.vertexData.get(key);
        if (meta) {
          meta.fetching = false;
        }
      }
    }
    subdividedGeometry.faceBaseIndex = [];

    subdividedGeometry.uvCoords = [];
    for (let v of subdividedGeometry.vertices) {
      const normalized = v.clone().normalize();
      let u = 0.5 - Math.atan2(normalized.z, normalized.x) / (2 * Math.PI);
      u = (u + 0.5) % 1.0;
      const v_coord = 0.5 + Math.asin(normalized.y) / Math.PI;
      subdividedGeometry.uvCoords.push([u, v_coord]);
    }

    for (let i = 0; i < subdividedGeometry.vertices.length; i++) {
      ensureVertexMetadata(i, elevationCache, settings.elevExag);
    }

    initialVertexCount = baseIcosahedron.vertices.length;
    baseIcosahedron.faces.forEach((face, idx) => {
      seedFaces.push([...face]);
      seedFaceBase.push(idx);
    });
  } else {
    initialVertexCount = subdividedGeometry.vertices.length;
    for (let i = 0; i < subdividedGeometry.vertices.length; i++) {
      ensureVertexMetadata(i, elevationCache, settings.elevExag);
    }
    const existingFaces = subdividedGeometry.faces && subdividedGeometry.faces.length
      ? subdividedGeometry.faces
      : baseIcosahedron.faces;
    const existingBaseIndex = subdividedGeometry.faceBaseIndex && subdividedGeometry.faceBaseIndex.length
      ? subdividedGeometry.faceBaseIndex
      : baseIcosahedron.faces.map((_, idx) => idx);
    existingFaces.forEach((face, idx) => {
      seedFaces.push([...face]);
      seedFaceBase.push(existingBaseIndex[idx] ?? idx);
    });
  }

  subdividedGeometry.faces = [];
  subdividedGeometry.faceBaseIndex = [];

  let subdivisionCount = 0;
  let maxDepthReached = 0;
  let smallestEdgeFound = Infinity;
  let smallestEdgeDist = Infinity;
  const vertexMaxDepth = (!preserveGeometry || !subdividedGeometry.vertexDepths)
    ? new Array(subdividedGeometry.vertices.length).fill(0)
    : subdividedGeometry.vertexDepths.slice();
  const leaves = [];
  const leafBaseIndex = [];
  const highQueue = [];
  const lowQueue = [];
  const MAX_QUEUE_DEPTH = 20;
  const activeMaxDepth = baseElevationsReady ? MAX_QUEUE_DEPTH : Math.min(MAX_QUEUE_DEPTH, BASE_PENDING_MAX_DEPTH);
  const minEdgeLength = Math.max(settings.minSpacingM, 1);
  const maxRadius = Math.max(settings.maxRadius, 1);
  const nearSSE = Math.max(settings.sseNearThreshold ?? 2, 0.5);
  const farSSE = Math.max(settings.sseFarThreshold ?? nearSSE, nearSSE);
  const configuredMaxVerts = settings.maxVertices ?? 50000;
  const vertexBudget = baseElevationsReady ? configuredMaxVerts : Math.min(configuredMaxVerts, BASE_PENDING_MAX_VERTICES);
  const splitBudget = preserveGeometry ? Math.max(0, incrementalSplitBudget|0) : Infinity;
  let splitsPerformed = 0;
  let splitBudgetReached = false;

  if (focusedBaseFaceIndex == null) {
    focusedBaseFaceIndex = findClosestBaseFaceIndex(surfacePosition);
    updateFocusedFaceBary(focusedBaseFaceIndex, focusedPoint);
  }

  const makeNode = (indices, depth, baseFaceIndex, inheritedFocus = false) => {
    const v1 = subdividedGeometry.vertices[indices[0]];
    const v2 = subdividedGeometry.vertices[indices[1]];
    const v3 = subdividedGeometry.vertices[indices[2]];
    const center = new THREE.Vector3().add(v1).add(v2).add(v3).multiplyScalar(1 / 3);
    const cameraDist = Math.max(center.distanceTo(surfacePosition), 1);
    const focusDist = focusedPoint ? distanceToFocusPoint(center, focusedPoint, surfacePosition) : Infinity;
    const intersectsFocus = triangleIntersectsFocus(indices);
    const hasFocusOverride =
      inheritedFocus ||
      intersectsFocus ||
      (Number.isFinite(focusDist) && focusDist <= Math.max(settings.fineDetailRadius ?? 0, 0));
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
      makeNode([...tri], depthEstimate, baseIndex, hasFocusedBary && focusedBaseFaceIndex === baseIndex)
    );
  });

  const canAllocateMoreVertices = () => {
    const remaining = vertexBudget - subdividedGeometry.vertices.length;
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
          (Number.isFinite(focusDist) && focusDist <= Math.max(settings.fineDetailRadius ?? 0, 0));

        shouldSplit = neighborPressure || ssePass || (focusOverride && maxEdge > minEdgeLength);
      }
    }

    const markAsLeaf = () => {
      leaves.push(indices);
      leafBaseIndex.push(baseFaceIndex);
      indices.forEach(idx => {
        vertexMaxDepth[idx] = Math.max(vertexMaxDepth[idx], depth);
      });
      if (maxEdge < smallestEdgeFound) {
        const va = subdividedGeometry.vertices[indices[0]];
        const vb = subdividedGeometry.vertices[indices[1]];
        const vc = subdividedGeometry.vertices[indices[2]];
        if (va && vb && vc) {
          smallestEdgeFound = maxEdge;
          const center = tmpCenter
            .copy(va)
            .add(vb)
            .add(vc)
            .multiplyScalar(1 / 3);
          smallestEdgeDist = distanceToCharacter(center, surfacePosition);
        }
      }
      maxDepthReached = Math.max(maxDepthReached, depth);
    };

    if (!shouldSplit) {
      markAsLeaf();
      await maybeYield();
      continue;
    }

    const childTris = subdivideTriangle(indices[0], indices[1], indices[2], elevationCache, settings.elevExag);
    if (!childTris) {
      markAsLeaf();
      await maybeYield();
      continue;
    }
    const nextDepth = depth + 1;
    while (vertexMaxDepth.length < subdividedGeometry.vertices.length) {
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

  subdividedGeometry.faces = leaves;
  subdividedGeometry.faceBaseIndex = leafBaseIndex;
  subdividedGeometry.vertexDepths = vertexMaxDepth;
  const newVertexCount = Math.max(0, subdividedGeometry.vertices.length - initialVertexCount);
  const newVertexIndices = newVertexCount > 0
    ? Array.from({ length: newVertexCount }, (_, i) => initialVertexCount + i)
    : [];
  if (!preserveGeometry) {
    applyApproxHeightsForSmallFaces(Infinity, settings.elevExag, elevationCache, 1);
    const adjacency = buildVertexAdjacency();
    blurApproxHeights(2, settings.elevExag, elevationCache, adjacency);
    propagateApproxHeightsFromKnown(settings.elevExag, elevationCache, 3, 2, adjacency);
  } else if (newVertexIndices.length) {
    propagateApproxHeightsAroundVertices(
      newVertexIndices,
      settings.elevExag,
      elevationCache,
      MOVEMENT_PROPAGATION_DEPTH,
      1
    );
  }
  if (shouldLog) {
    console.log(`Subdivision: max depth=${maxDepthReached}, operations=${subdivisionCount}`);
    if (Number.isFinite(smallestEdgeFound) && Number.isFinite(smallestEdgeDist)) {
      console.log(`Smallest triangle created: edge=${smallestEdgeFound.toFixed(2)}m at dist=${smallestEdgeDist.toFixed(0)}m from user`);
    }
  }

  for (let i = initialVertexCount; i < subdividedGeometry.vertices.length; i++) {
    createVertexMarker(i, ENABLE_VERTEX_MARKERS);
    if (i % 250 === 0) {
      await maybeYield();
    }
  }

  if (markerInstanceMesh) {
    markerInstanceMesh.count = markerCount;
    markerInstanceMesh.instanceMatrix.needsUpdate = true;
    if (markerInstanceMesh.instanceColor) {
      markerInstanceMesh.instanceColor.needsUpdate = true;
    }
  }

  if (shouldLog) {
    const elapsed = performance.now() - startTime;
    console.log(`TOTAL rebuild: ${elapsed.toFixed(2)}ms - ${subdividedGeometry.vertices.length} vertices, ${subdividedGeometry.faces.length} faces`);
  }

  return { newVertexIndices: preserveGeometry ? newVertexIndices : null };
}

// ──────────────────────── Mesh update functions ────────────────────────
function updateGlobeMesh(globeGeometry, wireframeGeometry, globe, globeMaterial, dom, elevationCache) {
  const verts = subdividedGeometry.vertices;
  const faces = subdividedGeometry.faces;

  if (!loggedBaseVertexDump) {
    console.groupCollapsed('Icosahedron vertex lat/lon');
    for (let i = 0; i < verts.length; i++) {
      const meta = ensureVertexMetadata(i, elevationCache, 1.0);
      if (!meta) continue;
      console.log(`#${i}`, meta.lat, meta.lon);
    }
    console.groupEnd();
    loggedBaseVertexDump = true;
  }

  const positions = new Float32Array(verts.length * 3);
  const uvs = new Float32Array(verts.length * 2);

  for (let i = 0; i < verts.length; i++) {
    positions[i * 3 + 0] = verts[i].x;
    positions[i * 3 + 1] = verts[i].y;
    positions[i * 3 + 2] = verts[i].z;

    if (subdividedGeometry.uvCoords[i]) {
      uvs[i * 2 + 0] = subdividedGeometry.uvCoords[i][0];
      uvs[i * 2 + 1] = subdividedGeometry.uvCoords[i][1];
    }
  }

  const indices = new Uint32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    indices[i * 3 + 0] = faces[i][0];
    indices[i * 3 + 1] = faces[i][1];
    indices[i * 3 + 2] = faces[i][2];
  }

  globeGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  globeGeometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  globeGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
  globeGeometry.computeVertexNormals();
  globeGeometry.computeBoundingSphere();
  globeGeometry.computeBoundingBox();
  globeGeometry.attributes.position.needsUpdate = true;
  globeGeometry.attributes.uv.needsUpdate = true;
  if (globeGeometry.attributes.normal) {
    globeGeometry.attributes.normal.needsUpdate = true;
  }
  globeGeometry.index.needsUpdate = true;
  globeGeometry.userData.faceBaseIndex = subdividedGeometry.faceBaseIndex.slice();
  if (globe.material) globe.material.needsUpdate = true;
  if (globeMaterial) {
    globeMaterial.needsUpdate = true;
    if (globeMaterial.map) {
      globeMaterial.map.needsUpdate = true;
    }
  }

  const wireframePositions = new Float32Array(faces.length * 6 * 3);
  let wireIdx = 0;

  for (let i = 0; i < faces.length; i++) {
    const [v0, v1, v2] = faces[i];

    wireframePositions[wireIdx++] = verts[v0].x;
    wireframePositions[wireIdx++] = verts[v0].y;
    wireframePositions[wireIdx++] = verts[v0].z;
    wireframePositions[wireIdx++] = verts[v1].x;
    wireframePositions[wireIdx++] = verts[v1].y;
    wireframePositions[wireIdx++] = verts[v1].z;

    wireframePositions[wireIdx++] = verts[v1].x;
    wireframePositions[wireIdx++] = verts[v1].y;
    wireframePositions[wireIdx++] = verts[v1].z;
    wireframePositions[wireIdx++] = verts[v2].x;
    wireframePositions[wireIdx++] = verts[v2].y;
    wireframePositions[wireIdx++] = verts[v2].z;

    wireframePositions[wireIdx++] = verts[v2].x;
    wireframePositions[wireIdx++] = verts[v2].y;
    wireframePositions[wireIdx++] = verts[v2].z;
    wireframePositions[wireIdx++] = verts[v0].x;
    wireframePositions[wireIdx++] = verts[v0].y;
    wireframePositions[wireIdx++] = verts[v0].z;
  }

  wireframeGeometry.setAttribute('position', new THREE.BufferAttribute(wireframePositions, 3));
  wireframeGeometry.attributes.position.needsUpdate = true;
  wireframeGeometry.computeBoundingSphere();
  wireframeGeometry.computeBoundingBox();

  dom.vertCount.textContent = verts.length;
  dom.tileCount.textContent = faces.length;
}

// ──────────────────────── Terrain regeneration orchestration ────────────────────────

// NOTE: This function needs imports from other modules - they will be injected at initialization
let _gps, _surfacePosition, _focusedPoint, _settings, _elevationCache, _fetchVertexElevation, _dom, _globeGeometry, _wireframeGeometry, _globe, _globeMaterial;
let _FOCUS_DEBUG, _ENABLE_VERTEX_MARKERS, _MIN_TERRAIN_REBUILD_INTERVAL_MS, _getNknReady = () => false, _updateFocusIndicatorsFunc;
let _updateGlobeMeshBound = null;

function snapVectorToTerrain(vec) {
  if (!vec || subdividedGeometry.vertices.length === 0) return false;
  tmpSnapDir.copy(vec);
  const len = tmpSnapDir.length();
  if (!Number.isFinite(len) || len < 1e-6) return false;
  tmpSnapDir.multiplyScalar(1 / len);
  let bestDot = -Infinity;
  let bestRadius = len;
  const verts = subdividedGeometry.vertices;
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    const vLen = v.length();
    if (!Number.isFinite(vLen) || vLen < 1e-6) continue;
    const dot = tmpSnapDir.dot(v) / vLen;
    if (dot > bestDot) {
      bestDot = dot;
      bestRadius = vLen;
    }
  }
  if (bestDot <= 0) return false;
  vec.copy(tmpSnapDir.multiplyScalar(bestRadius));
  return true;
}

export function injectRegenerateDependencies(deps) {
  _gps = deps.gps;
  _surfacePosition = deps.surfacePosition;
  _focusedPoint = deps.focusedPoint;
  _settings = deps.settings;
  _elevationCache = deps.elevationCache;
  _fetchVertexElevation = deps.fetchVertexElevation;
  _dom = deps.dom;
  _globeGeometry = deps.globeGeometry;
  _wireframeGeometry = deps.wireframeGeometry;
  _globe = deps.globe;
  _globeMaterial = deps.globeMaterial;
  _FOCUS_DEBUG = deps.FOCUS_DEBUG;
  _ENABLE_VERTEX_MARKERS = deps.ENABLE_VERTEX_MARKERS;
  _MIN_TERRAIN_REBUILD_INTERVAL_MS = deps.MIN_TERRAIN_REBUILD_INTERVAL_MS;
  if (typeof deps.nknReady === 'function') {
    _getNknReady = deps.nknReady;
  } else {
    const readyValue = !!deps.nknReady;
    _getNknReady = () => readyValue;
  }
  _updateFocusIndicatorsFunc = deps.updateFocusIndicators;
  _updateGlobeMeshBound = () => {
    updateGlobeMesh(_globeGeometry, _wireframeGeometry, _globe, _globeMaterial, _dom, _elevationCache);
    if (snapVectorToTerrain(_surfacePosition)) {
      _focusedPoint.copy(_surfacePosition);
    }
  };
  console.log('✅ Terrain dependencies injected');
}

// Wrapper function that uses injected dependencies
function resetTerrainGeometryToBaseWrapper(clearElevations = false) {
  resetTerrainGeometryToBase(clearElevations, _elevationCache, _dom, _ENABLE_VERTEX_MARKERS);
}

export function runGlobeMeshUpdate() {
  if (_updateGlobeMeshBound) {
    _updateGlobeMeshBound();
  }
}

async function regenerateTerrain(reason = 'update') {
  if (!_gps.have) return;
  if (isRegenerating) {
    scheduleTerrainRebuild(reason);
    return;
  }

  isRegenerating = true;
  cancelRegeneration = false;
  const runId = ++currentRegenerationRunId;
  const terrainStart = performance.now();

  try {
    const userLatLon = cartesianToLatLon(_surfacePosition);
    if (_FOCUS_DEBUG) console.log(`[${reason}] Subdividing icosahedron at ${userLatLon.latDeg.toFixed(4)}°, ${userLatLon.lonDeg.toFixed(4)}°`);
    if (_FOCUS_DEBUG) console.log(`Focused base face index: ${focusedBaseFaceIndex}`);
    const focusReference =
      _focusedPoint && _focusedPoint.lengthSq() > 0
        ? _focusedPoint
        : _surfacePosition;
    const getFocusDistance = (idx) => {
      const vert = subdividedGeometry.vertices[idx];
      if (!vert) return Infinity;
      if (!focusReference) return vert.distanceTo(_surfacePosition);
      return distanceToFocusPoint(vert, focusReference, _surfacePosition);
    };

    const rebuildStart = performance.now();
    const preserveGeometry =
      reason === 'movement' && subdividedGeometry.faces && subdividedGeometry.faces.length > 0;
    const { newVertexIndices } = await rebuildGlobeGeometry(
      _settings,
      _surfacePosition,
      _focusedPoint,
      _elevationCache,
      _FOCUS_DEBUG,
      _ENABLE_VERTEX_MARKERS,
      { preserveGeometry }
    );
    if (_FOCUS_DEBUG) console.log(`Total rebuild time: ${(performance.now() - rebuildStart).toFixed(2)}ms`);

    const refreshMesh = () => {
      updateGlobeMesh(_globeGeometry, _wireframeGeometry, _globe, _globeMaterial, _dom, _elevationCache);
      if (snapVectorToTerrain(_surfacePosition)) {
        _focusedPoint.copy(_surfacePosition);
      }
    };

    // Update the globe mesh immediately after rebuild
    refreshMesh();

    if (cancelRegeneration) {
      _dom.queueCount.textContent = '0';
      if (_FOCUS_DEBUG) console.log('Terrain regeneration cancelled before collecting vertices.');
      return;
    }

    const collectStart = performance.now();
    const newVertices = [];
    if (preserveGeometry && Array.isArray(newVertexIndices) && newVertexIndices.length) {
      for (const idx of newVertexIndices) {
        if (cancelRegeneration) break;
        const meta = ensureVertexMetadata(idx, _elevationCache, _settings.elevExag);
        if (!meta || meta.fetching) continue;
        if (meta.elevation == null) {
          newVertices.push(idx);
        }
      }
    } else {
      for (let i = 0; i < subdividedGeometry.vertices.length; i++) {
        if (cancelRegeneration) break;
        const meta = ensureVertexMetadata(i, _elevationCache, _settings.elevExag);
        if (!meta || meta.fetching) continue;
        if (meta.elevation == null) {
          newVertices.push(i);
        }
      }
    }
    if (_FOCUS_DEBUG) console.log(`Collect vertices: ${(performance.now() - collectStart).toFixed(2)}ms`);

    if (cancelRegeneration) {
      _dom.queueCount.textContent = '0';
      if (_FOCUS_DEBUG) console.log('Terrain regeneration cancelled during vertex collection.');
      return;
    }

    const sortStart = performance.now();
    const vertexDepths = subdividedGeometry.vertexDepths || [];
    newVertices.sort((a, b) => {
      const depthA = vertexDepths[a] ?? 0;
      const depthB = vertexDepths[b] ?? 0;
      if (depthA !== depthB) return depthA - depthB;
      const distA = getFocusDistance(a);
      const distB = getFocusDistance(b);
      return distA - distB;
    });

    if (baseVertexCount > 0 && newVertices.length > 1) {
      const baseIndices = [];
      const extraIndices = [];
      for (let i = 0; i < newVertices.length; i++) {
        const idx = newVertices[i];
        if (idx < baseVertexCount) {
          baseIndices.push(idx);
        } else {
          extraIndices.push(idx);
        }
      }
      if (baseIndices.length) {
        newVertices.length = 0;
        newVertices.push(...baseIndices, ...extraIndices);
      }
    }
    if (_FOCUS_DEBUG) console.log(`Sort vertices by distance: ${(performance.now() - sortStart).toFixed(2)}ms`);

    if (_FOCUS_DEBUG) console.log(`Fetching elevation for ${newVertices.length} vertices (SSE-prioritized tiers)`);

    const fetchStart = performance.now();
    const PRIORITY_RADIUS = Math.max(
      1000,
      Math.min(_settings.maxRadius ?? 50000, (_settings.fineDetailRadius ?? 4000) * 1.5)
    );
    const localRadius = Math.max(250, (_settings.fineDetailRadius ?? 4000) * 0.35);
    const tiers = [
      { name: 'local', batch: 150, predicate: (depth, dist) => dist <= localRadius },
      { name: 'coarse', batch: 220, predicate: (depth) => depth <= 1 },
      { name: 'near', batch: 320, predicate: (depth, dist) => depth <= 3 || dist <= PRIORITY_RADIUS }
    ];
    const STANDARD_BATCH = 500;
    const totalQueue = newVertices.length;
    let processed = 0;
    let lastMeshUpdate = performance.now();
    let batchesApplied = false;
    if (totalQueue > 0) {
      _dom.queueCount.textContent = totalQueue.toString();
    } else {
      _dom.queueCount.textContent = '0';
    }

    const processedSet = new Set();
    const fetchYieldIntervalMs = SUBDIVISION_SLICE_MS;
    let lastFetchYieldTime = performance.now();
    const maybeYieldFetch = async () => {
      if (performance.now() - lastFetchYieldTime < fetchYieldIntervalMs) return;
      if (typeof requestAnimationFrame === 'function') {
        await new Promise(resolve => requestAnimationFrame(resolve));
      } else {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      lastFetchYieldTime = performance.now();
    };

    const compareVertexPriority = (a, b) => {
      const depthA = vertexDepths[a] ?? 0;
      const depthB = vertexDepths[b] ?? 0;
      if (depthA !== depthB) return depthA - depthB;
      const distA = getFocusDistance(a);
      const distB = getFocusDistance(b);
      return distA - distB;
    };

    const processQueue = async (vertices, batchSize) => {
      if (!vertices.length) return;
      vertices.sort(compareVertexPriority);
      for (let i = 0; i < vertices.length; i += batchSize) {
        if (cancelRegeneration) break;
        const batch = vertices.slice(i, i + batchSize);
        let succeeded = false;
        try {
          await _fetchVertexElevation(batch, runId);
          succeeded = true;
        } catch (err) {
          console.error('Elevation batch fetch failed', err);
          if (runId !== currentRegenerationRunId || cancelRegeneration) break;
          for (const idx of batch) {
            processedSet.delete(idx);
          }
          continue;
        }
        if (!succeeded) continue;
        if (cancelRegeneration || runId !== currentRegenerationRunId) break;

        processed += batch.length;
        const remaining = Math.max(0, totalQueue - processed);
        const nowTime = performance.now();
        if (
          processed <= batch.length ||
          remaining === 0 ||
          nowTime - lastMeshUpdate >= 120
        ) {
          refreshMesh();
          lastMeshUpdate = nowTime;
          batchesApplied = true;
        }
        _dom.queueCount.textContent = remaining.toString();
        await maybeYieldFetch();
      }
    };

    for (const tier of tiers) {
      if (cancelRegeneration || runId !== currentRegenerationRunId) break;
      const tierVertices = [];
      for (const idx of newVertices) {
        if (processedSet.has(idx)) continue;
        const depth = vertexDepths[idx] ?? 0;
        const dist = getFocusDistance(idx);
        if (tier.predicate(depth, dist)) {
          tierVertices.push(idx);
          processedSet.add(idx);
        }
      }
      await processQueue(tierVertices, tier.batch);
      if (tier.name === 'coarse' && !cancelRegeneration && runId === currentRegenerationRunId) {
        const approxApplied = applyApproxHeightsForSmallFaces(Infinity, _settings.elevExag, _elevationCache);
        blurApproxHeights(1, _settings.elevExag, _elevationCache);
        if (approxApplied > 0) {
          refreshMesh();
          batchesApplied = true;
        }
      }
    }

    if (!cancelRegeneration && runId === currentRegenerationRunId) {
      const remainingVertices = newVertices.filter(idx => !processedSet.has(idx));
      await processQueue(remainingVertices, STANDARD_BATCH);
    }

    if (_FOCUS_DEBUG) console.log(`Fetch elevation: ${(performance.now() - fetchStart).toFixed(2)}ms`);

    if (!batchesApplied) {
      refreshMesh();
    }

    _dom.queueCount.textContent = '0';

    if (cancelRegeneration || runId !== currentRegenerationRunId) {
      if (_FOCUS_DEBUG) console.log('Terrain regeneration stopped mid-run due to a newer request.');
      return;
    }

    if (_FOCUS_DEBUG) console.log(`TOTAL regenerateTerrain: ${(performance.now() - terrainStart).toFixed(2)}ms`);
  } finally {
    isRegenerating = false;
    const finishedAt = performance.now();
    lastTerrainRebuildTime = finishedAt;
    if (wantTerrainRebuild) {
      lastTerrainRebuildTime = finishedAt - _MIN_TERRAIN_REBUILD_INTERVAL_MS;
    }
    if (cancelRegeneration) {
      cancelRegeneration = false;
    }
  }
}

function maybeInitTerrain() {
  // nknReady needs to be injected too
  const nknReady = _getNknReady ? _getNknReady() : false;
  if (!terrainInitialized && _gps && _gps.have && nknReady) {
    terrainInitialized = true;
    console.log('✅ Initial terrain generation at GPS location');
    _focusedPoint.copy(_surfacePosition);
    _updateFocusIndicatorsFunc(_focusedPoint);
    scheduleTerrainRebuild('initial');
  }
}

// ──────────────────────── State Management Variables ────────────────────────

// Terrain rebuild scheduling state
export let wantTerrainRebuild = false;
export let isRegenerating = false;
export let lastTerrainRebuildTime = 0;
export let pendingRebuildReason = null;
export let cancelRegeneration = false;
export let currentRegenerationRunId = 0;
export let terrainInitialized = false;
const URGENT_REBUILD_REASONS = new Set(['manual-click', 'settings', 'reset-all', 'base-ready']);

export function scheduleTerrainRebuild(reason = 'update') {
  pendingRebuildReason = reason;
  wantTerrainRebuild = true;
  if (!isRegenerating) return;
  if (URGENT_REBUILD_REASONS.has(reason)) {
    cancelRegeneration = true;
    const MIN_TERRAIN_REBUILD_INTERVAL_MS = 300;
    lastTerrainRebuildTime = Math.min(
      lastTerrainRebuildTime,
      performance.now() - MIN_TERRAIN_REBUILD_INTERVAL_MS
    );
  }
}

// Setters for state that needs to be modified externally
export function setFocusedBaseFaceIndex(value) {
  focusedBaseFaceIndex = value;
}

export function setHasFocusedBary(value) {
  hasFocusedBary = value;
}

export function setWantTerrainRebuild(value) {
  wantTerrainRebuild = value;
}

export function setPendingRebuildReason(value) {
  pendingRebuildReason = value;
}

export function setIsRegenerating(value) {
  isRegenerating = value;
}

export function setLastTerrainRebuildTime(value) {
  lastTerrainRebuildTime = value;
}

export function setCancelRegeneration(value) {
  cancelRegeneration = value;
}

export function incrementRegenerationRunId() {
  return ++currentRegenerationRunId;
}

export function setTerrainInitialized(value) {
  terrainInitialized = value;
}

export function setBaseElevationsReady(value) {
  baseElevationsReady = value;
}

// ──────────────────────── Exports ────────────────────────
// Note: State management functions and injectRegenerateDependencies are already exported above
export {
  captureBaseIcosahedron,
  baseIcosahedron,
  baseVertexCount,
  baseElevationsReady,
  subdividedGeometry,
  focusedFaceBary,
  focusedBaseFaceIndex,
  ensureVertexMetadata,
  updateVertexMarkerColor,
  updateFocusIndicators,
  initMarkerInstanceMesh,
  createVertexMarker,
  clearAllVertexMarkers,
  resetTerrainGeometryToBaseWrapper as resetTerrainGeometryToBase,
  getMidpointVertex,
  subdivideTriangle,
  distanceToCharacter,
  surfaceDistanceBetween,
  distanceToFocusPoint,
  findClosestBaseFaceIndex,
  shouldSubdivideTriangle,
  rebuildGlobeGeometry,
  updateGlobeMesh,
  regenerateTerrain,
  maybeInitTerrain,
  cartesianToLatLon,
  geohashEncode,
  focusRay,
  updateFocusedFaceBary,
  applyElevationToVertex,
  propagateApproxHeightsAroundVertices,
  snapVectorToTerrain,
  initTerrainScheduler,
  requestRefine,
  queueElevationBatch,
  applyPendingPatches
};
