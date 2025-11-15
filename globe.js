import * as THREE from 'three';
import { EARTH_RADIUS_M, ICOS_DETAIL, LON_OFFSET_DEG } from './constants.js';
import { scene, renderer } from './scene.js';

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
  color: 0xffffff,
  transparent: true,
  opacity: 0.8,
  depthTest: true
});
export let wireframeMesh = null;

export function initGlobe() {
  // Create globe geometry
  globeGeometry = new THREE.IcosahedronGeometry(EARTH_RADIUS_M, ICOS_DETAIL);

  // Load Earth texture
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  const earthTexture = loader.load('2k_earth_daymap.jpg', (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  });

  applyLonOffset(earthTexture, LON_OFFSET_DEG);

  // Create globe material and mesh
  globeMaterial = new THREE.MeshStandardMaterial({
    map: earthTexture,
    roughness: 1.0,
    metalness: 0.0,
    wireframe: false,
    side: THREE.DoubleSide
  });
  globe = new THREE.Mesh(globeGeometry, globeMaterial);
  scene.add(globe);
  globe.frustumCulled = false;

  // Create wireframe mesh
  wireframeMesh = new THREE.LineSegments(wireframeGeometry, wireframeMaterial);
  wireframeMesh.frustumCulled = false;
  scene.add(wireframeMesh);

  console.log('✅ Globe mesh and wireframe initialized');
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
export const markerGeometry = new THREE.CircleGeometry(500, 8);
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
  focusMarkerGeometry = new THREE.SphereGeometry(2000, 16, 16);
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
  geom.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, target.x, target.y, target.z], 3));
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
