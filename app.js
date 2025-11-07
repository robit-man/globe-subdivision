import * as THREE from 'three';

// ──────────────────────── Module Imports ────────────────────────
import {
  MIN_TERRAIN_REBUILD_INTERVAL_MS,
  SUBDIVISION_UPDATE_INTERVAL,
  SUBDIVISION_DISTANCE_THRESHOLD,
  isMobile,
  FOCUS_DEBUG,
  ENABLE_VERTEX_MARKERS
} from './constants.js';
import { loadSettings, settings } from './settings.js';
import { dom, syncSettingsUI, initUIListeners } from './ui.js';
import { initScene, renderer, scene } from './scene.js';
import {
  globe,
  globeGeometry,
  globeMaterial,
  wireframeGeometry,
  initGlobe,
  initFocusMarkers,
  updateElevationIndicators
} from './globe.js';
import {
  gps,
  followGPS,
  surfacePosition,
  focusedPoint,
  startGPS,
  initGPSListeners
} from './gps.js';
import {
  activeCamera,
  mode,
  orbitControls,
  initCameras,
  initInputHandlers,
  requestPermissions,
  initClickToPlace,
  switchMode,
  initModeButtons,
  initRecalibrate,
  updateCamera
} from './camera.js';
import { initNKN, nknReady, elevationCache, fetchVertexElevation } from './router.js';
import {
  resetTerrainGeometryToBase,
  scheduleTerrainRebuild,
  wantTerrainRebuild,
  isRegenerating,
  lastTerrainRebuildTime,
  pendingRebuildReason,
  regenerateTerrain,
  maybeInitTerrain,
  terrainInitialized,
  setFocusedBaseFaceIndex,
  setHasFocusedBary,
  updateFocusIndicators,
  findClosestBaseFaceIndex,
  updateFocusedFaceBary,
  injectRegenerateDependencies,
  captureBaseIcosahedron
} from './terrain.js';
import { SimpleBuildingManager } from './buildings.js';

// ──────────────────────── Initialization ────────────────────────

console.log('%c🏔️ TERRAIN GEN - MODULAR PRODUCTION SYSTEM', 'background:#0d1220;color:#8bd1ff;font-size:16px;padding:8px;border-radius:4px');
console.log('Adaptive terrain with Cesium-like LOD, NKN elevation fetching, and real-time progressive refinement.');
console.log('');
console.log('📦 Loading modular architecture...');

// Load settings from localStorage
loadSettings();
console.log('✅ Settings loaded');

// Initialize scene, renderer, lighting
initScene();

// Initialize cameras and orbit controls
initCameras();

// Initialize input handlers (keyboard, pointer events)
initInputHandlers();

// Initialize globe mesh and wireframe
initGlobe();
captureBaseIcosahedron(globeGeometry);

// Initialize focus markers and ray
initFocusMarkers();
const buildingManager = new SimpleBuildingManager(scene);

// Sync settings UI
syncSettingsUI();
console.log('✅ UI synchronized');

// Initialize UI event listeners
initUIListeners(resetTerrainGeometryToBase, scheduleTerrainRebuild);
console.log('✅ UI event listeners initialized');

// Initialize GPS listeners
initGPSListeners(updateFocusIndicators);
console.log('✅ GPS listeners initialized');

let lastSubdivisionUpdate = 0;
let lastSubdivisionPosition = new THREE.Vector3();

function forceImmediateSubdivisionUpdate() {
  lastSubdivisionUpdate = 0;
  lastSubdivisionPosition.copy(surfacePosition);
}

// Initialize click-to-place (for orbit mode)
initClickToPlace(
  globe,
  globeGeometry,
  findClosestBaseFaceIndex,
  updateFocusIndicators,
  updateFocusedFaceBary,
  resetTerrainGeometryToBase,
  scheduleTerrainRebuild,
  forceImmediateSubdivisionUpdate
);

// Initialize mode buttons
initModeButtons(updateFocusIndicators);

// Initialize recalibration button
initRecalibrate();

// Initialize NKN client
initNKN();

// Inject dependencies into terrain module
injectRegenerateDependencies({
  gps,
  surfacePosition,
  focusedPoint,
  settings,
  elevationCache,
  fetchVertexElevation,
  dom,
  globeGeometry,
  wireframeGeometry,
  globe,
  globeMaterial,
  FOCUS_DEBUG,
  ENABLE_VERTEX_MARKERS,
  MIN_TERRAIN_REBUILD_INTERVAL_MS,
  nknReady: () => nknReady,
  updateFocusIndicators
});

// ──────────────────────── Permission Overlay ────────────────────────

dom.enable.addEventListener('click', async () => {
  dom.status.textContent = 'Requesting permissions...';
  const ok = await requestPermissions(updateFocusIndicators);
  if (ok) {
    startGPS(updateFocusIndicators);
    dom.overlay.classList.remove('show');
  } else {
    dom.status.textContent = 'Permission denied or sensors unavailable.';
  }
});

dom.continue.addEventListener('click', () => {
  dom.overlay.classList.remove('show');
});

console.log('✅ Permission handlers initialized');
console.log('');
console.log('🚀 Starting render loop...');

// ──────────────────────── Render Loop ────────────────────────

let then = performance.now();
let frames = 0;
let fps = 0;
let fpsAccum = 0;

function tick(now) {
  const dt = Math.min(0.05, (now - then) / 1000);
  then = now;

  // Update camera (handles orientation, walking, compass, alignment)
  updateCamera(dt, updateFocusIndicators);

  // Update orbit controls if enabled
  if (orbitControls.enabled) {
    orbitControls.update();
  }

  // Initialize terrain on first GPS lock
  maybeInitTerrain();
  buildingManager?.update(surfacePosition);

  // Check if we need to update subdivision based on movement/time
  if (terrainInitialized && gps.have) {
    const timeSinceLastUpdate = now - lastSubdivisionUpdate;
    const distanceMoved = surfacePosition.distanceTo(lastSubdivisionPosition);
    const needsUpdate =
      timeSinceLastUpdate > SUBDIVISION_UPDATE_INTERVAL ||
      distanceMoved > SUBDIVISION_DISTANCE_THRESHOLD;

    if (needsUpdate) {
      lastSubdivisionUpdate = now;
      lastSubdivisionPosition.copy(surfacePosition);
      if (mode !== 'orbit' || followGPS) {
        setFocusedBaseFaceIndex(null);
        focusedPoint.copy(surfacePosition);
        setHasFocusedBary(false);
        updateFocusIndicators(focusedPoint);
      }
      scheduleTerrainRebuild('movement');
    }
  }

  // Execute pending terrain rebuild if ready
  if (!isRegenerating && wantTerrainRebuild) {
    const elapsed = performance.now() - lastTerrainRebuildTime;
    if (elapsed >= MIN_TERRAIN_REBUILD_INTERVAL_MS) {
      const reason = pendingRebuildReason;
      regenerateTerrain(reason ?? 'update');
    }
  }

  // Update elevation indicators (visual feedback for fetches)
  updateElevationIndicators(now);

  // Render the scene
  renderer.render(scene, activeCamera);

  // FPS counter
  frames++;
  fpsAccum += dt;
  if (fpsAccum >= 0.5) {
    fps = Math.round(frames / fpsAccum);
    frames = 0;
    fpsAccum = 0;
    dom.fps.textContent = fps.toString();
  }

  requestAnimationFrame(tick);
}

// Start the render loop
requestAnimationFrame(tick);

console.log('✅ Render loop started');
console.log('');
console.log('%c🌍 SYSTEM READY', 'background:#0d1220;color:#40e0d0;font-size:14px;padding:6px;border-radius:4px');
