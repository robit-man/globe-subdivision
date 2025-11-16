import * as THREE from 'three';
import { EARTH_RADIUS_M, ICOS_DETAIL, LON_OFFSET_DEG, WORLD_SCALE } from './constants.js';
import { scene, renderer } from './scene.js';
import { splitVector3ToHighLow } from './precision.js';

// ──────────────────────── Globe Texture Helper ────────────────────────

function applyLonOffset(tex, deg) {
  if (!tex) return;
  tex.wrapS = THREE.RepeatWrapping;
  if (tex.wrapT !== THREE.ClampToEdgeWrapping) tex.wrapT = THREE.ClampToEdgeWrapping;
  const off = ((deg/360)%1+1)%1;
  tex.offset.x = off;
  tex.needsUpdate = true;
}

// ──────────────────────── Globe Mesh ────────────────────────

export let globeGeometry = null;
export let globeMaterial = null;
export let globe = null;
export const wireframeGeometry = new THREE.BufferGeometry();
export const wireframeMaterial = new THREE.LineBasicMaterial({
  color: 0x505560,
  transparent: true,
  opacity: 0.35,
  depthTest: false,
  depthWrite: false
});
export let wireframeMesh = null;

export function initGlobe() {
  // Create globe geometry
  globeGeometry = new THREE.IcosahedronGeometry(EARTH_RADIUS_M, ICOS_DETAIL);
  // Initialize high/low attributes for base geometry
  const posAttr = globeGeometry.getAttribute('position');
  if (posAttr?.isBufferAttribute) {
    const high = new Float32Array(posAttr.array.length);
    const low = new Float32Array(posAttr.array.length);
    for (let i = 0; i < posAttr.count; i++) {
      const v = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      const split = splitVector3ToHighLow(v);
      high[i * 3 + 0] = split.high.x;
      high[i * 3 + 1] = split.high.y;
      high[i * 3 + 2] = split.high.z;
      low[i * 3 + 0] = split.low.x;
      low[i * 3 + 1] = split.low.y;
      low[i * 3 + 2] = split.low.z;
    }
    globeGeometry.setAttribute('positionHigh', new THREE.BufferAttribute(high, 3));
    globeGeometry.setAttribute('positionLow', new THREE.BufferAttribute(low, 3));
  }

  // Load Earth texture
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  const earthTexture = loader.load('2k_earth_daymap.jpg', (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  });

  applyLonOffset(earthTexture, LON_OFFSET_DEG);

  // Create globe material and mesh - simple black material without custom shaders
  globeMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2
  });
  globe = new THREE.Mesh(globeGeometry, globeMaterial);
  scene.add(globe);
  globe.frustumCulled = false;

  // Create wireframe mesh
  wireframeMesh = new THREE.LineSegments(wireframeGeometry, wireframeMaterial);
  wireframeMesh.frustumCulled = false;
  scene.add(wireframeMesh);

  console.log('✅ Globe mesh and wireframe initialized with camera-relative shaders');
}

// ──────────────────────── Focus Markers ────────────────────────

export let focusMarkerGeometry = null;
export let focusMarkerMaterial = null;
export let focusMarker = null;
export let focusRayMaterial = null;
export let focusRayGeometry = null;
export let focusRayLine = null;

// ──────────────────────── Vertex Markers ────────────────────────

const MAX_MARKERS = 100000;
export let markerInstanceMesh = null;
export const markerGeometry = new THREE.CircleGeometry(500 * WORLD_SCALE, 8);

// Add high/low position attributes to marker geometry
const markerPosAttr = markerGeometry.getAttribute('position');
if (markerPosAttr?.isBufferAttribute) {
  const high = new Float32Array(markerPosAttr.array.length);
  const low = new Float32Array(markerPosAttr.array.length);
  for (let i = 0; i < markerPosAttr.count; i++) {
    const v = new THREE.Vector3(markerPosAttr.getX(i), markerPosAttr.getY(i), markerPosAttr.getZ(i));
    const split = splitVector3ToHighLow(v);
    high[i * 3 + 0] = split.high.x;
    high[i * 3 + 1] = split.high.y;
    high[i * 3 + 2] = split.high.z;
    low[i * 3 + 0] = split.low.x;
    low[i * 3 + 1] = split.low.y;
    low[i * 3 + 2] = split.low.z;
  }
  markerGeometry.setAttribute('positionHigh', new THREE.BufferAttribute(high, 3));
  markerGeometry.setAttribute('positionLow', new THREE.BufferAttribute(low, 3));
}

export const markerMaterial = new THREE.MeshBasicMaterial({
  side: THREE.DoubleSide,
  transparent: false,
  depthTest: false,
  depthWrite: false
});
export const vertexMarkerIndices = new Map();
export let markerCount = 0;
export const WHITE_COLOR = new THREE.Color(0xffffff);
export const GREEN_COLOR = new THREE.Color(0x00ff00);
export const tmpMarkerPos = new THREE.Vector3();
export const tmpMarkerLook = new THREE.Vector3();
export const tmpMarkerUp = new THREE.Vector3();
export const tmpMarkerMatrix = new THREE.Matrix4();

// ──────────────────────── Initialize Focus Markers and Ray ────────────────────────

export function initFocusMarkers() {
  focusMarkerGeometry = new THREE.SphereGeometry(2000 * WORLD_SCALE, 16, 16);

  // Add high/low position attributes to focus marker geometry
  const posAttr = focusMarkerGeometry.getAttribute('position');
  if (posAttr?.isBufferAttribute) {
    const high = new Float32Array(posAttr.array.length);
    const low = new Float32Array(posAttr.array.length);
    for (let i = 0; i < posAttr.count; i++) {
      const v = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      const split = splitVector3ToHighLow(v);
      high[i * 3 + 0] = split.high.x;
      high[i * 3 + 1] = split.high.y;
      high[i * 3 + 2] = split.high.z;
      low[i * 3 + 0] = split.low.x;
      low[i * 3 + 1] = split.low.y;
      low[i * 3 + 2] = split.low.z;
    }
    focusMarkerGeometry.setAttribute('positionHigh', new THREE.BufferAttribute(high, 3));
    focusMarkerGeometry.setAttribute('positionLow', new THREE.BufferAttribute(low, 3));
  }

  focusMarkerMaterial = new THREE.MeshBasicMaterial({
    color: 0xff0000,
    transparent: true,
    opacity: 0.8,
    depthTest: false,
    depthWrite: false
  });
  focusMarker = new THREE.Mesh(focusMarkerGeometry, focusMarkerMaterial);
  focusMarker.visible = false;
  scene.add(focusMarker);

  focusRayMaterial = new THREE.LineBasicMaterial({
    color: 0x39ff14,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false
  });
  focusRayGeometry = new THREE.BufferGeometry();
  focusRayGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
  focusRayGeometry.setAttribute('positionHigh', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
  focusRayGeometry.setAttribute('positionLow', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
  focusRayLine = new THREE.Line(focusRayGeometry, focusRayMaterial);
  focusRayLine.frustumCulled = false;
  focusRayLine.visible = false;
  focusRayLine.renderOrder = 5;
  scene.add(focusRayLine);

  console.log('✅ Globe initialized: mesh, wireframe, focus markers, and ray ready');
}

// ──────────────────────── Elevation Indicators ────────────────────────

const elevationIndicators = [];
const ELEVATION_INDICATOR_DURATION_MS = 200;
export const ELEVATION_FETCH_COLOR = 0xff8600;
export const ELEVATION_APPLY_COLOR = 0x40e0d0;

export function spawnElevationIndicator(target, color) {
  if (!target || target.lengthSq() === 0) return;
  const geom = new THREE.BufferGeometry();
  const posArray = new Float32Array([0, 0, 0, target.x, target.y, target.z]);
  const high = new Float32Array(posArray.length);
  const low = new Float32Array(posArray.length);
  for (let i = 0; i < posArray.length; i += 3) {
    const vx = posArray[i];
    const vy = posArray[i + 1];
    const vz = posArray[i + 2];
    const hx = vx >= 0 ? Math.floor(vx) : Math.ceil(vx);
    const hy = vy >= 0 ? Math.floor(vy) : Math.ceil(vy);
    const hz = vz >= 0 ? Math.floor(vz) : Math.ceil(vz);
    high[i] = hx; high[i + 1] = hy; high[i + 2] = hz;
    low[i] = vx - hx; low[i + 1] = vy - hy; low[i + 2] = vz - hz;
  }
  geom.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
  geom.setAttribute('positionHigh', new THREE.BufferAttribute(high, 3));
  geom.setAttribute('positionLow', new THREE.BufferAttribute(low, 3));
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 1,
    depthTest: false,
    depthWrite: false
  });
  const line = new THREE.Line(geom, mat);
  line.renderOrder = 9;
  scene.add(line);
  elevationIndicators.push({
    line,
    mat,
    geom,
    expiresAt: performance.now() + ELEVATION_INDICATOR_DURATION_MS
  });
}

export function showFetchRay() {}
export function completeFetchRay() {}

export function updateElevationIndicators(now) {
  for (let i = elevationIndicators.length - 1; i >= 0; i--) {
    const indicator = elevationIndicators[i];
    const timeLeft = indicator.expiresAt - now;
    if (timeLeft <= 0) {
      scene.remove(indicator.line);
      indicator.geom.dispose();
      indicator.mat.dispose();
      elevationIndicators.splice(i, 1);
    } else {
      const alpha = timeLeft / ELEVATION_INDICATOR_DURATION_MS;
      indicator.mat.opacity = alpha;
    }
  }

}

// ──────────────────────── Update Globe Geometry Reference ────────────────────────

export function setGlobeGeometry(newGeometry) {
  globeGeometry = newGeometry;
}
