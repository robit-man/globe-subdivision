import * as THREE from 'three';

// ──────────────────────── Module Imports ────────────────────────
import {
  MIN_TERRAIN_REBUILD_INTERVAL_MS,
  SUBDIVISION_UPDATE_INTERVAL,
  SUBDIVISION_DISTANCE_THRESHOLD,
  isMobile,
  FOCUS_DEBUG,
  ENABLE_VERTEX_MARKERS,
  DEBUG_DISABLE_INITIAL_SUBDIVISION,
  DEBUG_DISABLE_MOVEMENT_REFINEMENT,
  DEBUG_SHOW_VERTEX_LABELS,
  DEBUG_MAX_VERTEX_LABELS,
  DEBUG_LABEL_RADIUS_M
} from './constants.js';
import { loadSettings, settings } from './settings.js';
import { getLastGPSLocation } from './persistent.js';
import { dom, syncSettingsUI, initUIListeners } from './ui.js';
import { initScene, renderer, scene } from './scene.js';
import {
  globe,
  globeGeometry,
  globeMaterial,
  wireframeGeometry,
  wireframeMaterial,
  wireframeMesh,
  focusMarkerMaterial,
  focusRayMaterial,
  markerMaterial,
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
  cameraOrbit,
  mode,
  orbitControls,
  initCameras,
  initInputHandlers,
  requestPermissions,
  initClickToPlace,
  switchMode,
  initModeButtons,
  initRecalibrate,
  updateCamera,
  isSurfaceInteractionActive
} from './camera.js';
import { initNKN, nknReady, elevationCache, fetchVertexElevation } from './router.js';
import {
  resetTerrainGeometryToBase,
  scheduleTerrainRebuild,
  wantTerrainRebuild,
  isRegenerating,
  lastTerrainRebuildTime,
  pendingRebuildReason,
  maybeInitTerrain,
  terrainInitialized,
  setFocusedBaseFaceIndex,
  setHasFocusedBary,
  updateFocusIndicators,
  findClosestBaseFaceIndex,
  updateFocusedFaceBary,
  injectRegenerateDependencies,
  captureBaseIcosahedron,
  initTerrainScheduler,
  shouldTriggerRefinement,
  requestRefine,
  applyPendingPatches,
  processElevationQueue,
  setWantTerrainRebuild,
  setIsRegenerating,
  setLastTerrainRebuildTime,
  baseVertexCount,
  baseElevationsReady,
  subdividedGeometry,
  currentRegenerationRunId,
  getMeshWasUpdated,
  clearMeshWasUpdated,
  setElevationUpdatesPaused,
  ensureVertexMetadata
} from './terrain.js';
import { SimpleBuildingManager } from './buildings.js';
import { initMetricsHUD } from './metricsHud.js';
import { splitVector3ToHighLow, applyCameraUniforms } from './precision.js';
import { latLonToCartesian } from './utils.js';

// ──────────────────────── Debug vertex label overlay ────────────────────────
const debugLabelContainer = document.createElement('div');
const debugLastRadius = new Map();
debugLabelContainer.style.position = 'fixed';
debugLabelContainer.style.top = '0';
debugLabelContainer.style.left = '0';
debugLabelContainer.style.width = '100%';
debugLabelContainer.style.height = '100%';
debugLabelContainer.style.pointerEvents = 'none';
debugLabelContainer.style.fontFamily = 'monospace';
debugLabelContainer.style.fontSize = '10px';
debugLabelContainer.style.color = '#0f0';
debugLabelContainer.style.textShadow = '0 0 2px #000';
debugLabelContainer.style.zIndex = '9999';
document.body.appendChild(debugLabelContainer);

// ──────────────────────── Initialization ────────────────────────

console.log('%c🏔️ TERRAIN GEN - MODULAR PRODUCTION SYSTEM', 'background:#0d1220;color:#8bd1ff;font-size:16px;padding:8px;border-radius:4px');
console.log('Adaptive terrain with Cesium-like LOD, NKN elevation fetching, and real-time progressive refinement.');
console.log('');
console.log('📦 Loading modular architecture...');

// Load settings from localStorage
loadSettings();
console.log('✅ Settings loaded');

// Initialize tracking variables
let lastSubdivisionUpdate = 0;
let lastSubdivisionPosition = new THREE.Vector3();
const MOVEMENT_REBUILD_SETTLE_MS = 350;
let pendingMovementRebuild = false;
let movementRebuildDeadline = 0;
let baseElevationsKickoff = false;
let appliedSavedLocation = false;

// Initialize scene, renderer, lighting
initScene();

// Initialize cameras and orbit controls
initCameras();

// Initialize input handlers (keyboard, pointer events)
initInputHandlers();

// Initialize globe mesh and wireframe
initGlobe();
captureBaseIcosahedron(globeGeometry);
initTerrainScheduler({ settings });

// Load saved GPS position BEFORE initial subdivision
const savedGPS = getLastGPSLocation();
if (savedGPS && Number.isFinite(savedGPS.lat) && Number.isFinite(savedGPS.lon)) {
  gps.have = true;
  gps.lat = savedGPS.lat;
  gps.lon = savedGPS.lon;
  gps.alt = Number.isFinite(savedGPS.alt) ? savedGPS.alt : 0;
  surfacePosition.copy(latLonToCartesian(gps.lat, gps.lon, gps.alt));
  focusedPoint.copy(surfacePosition);
  appliedSavedLocation = true;
  console.log(`📍 Loaded saved GPS: ${gps.lat.toFixed(6)}°, ${gps.lon.toFixed(6)}°`);
}

// Pass surfacePosition for BOTH params - subdivision is position-based, NOT look-direction-based
if (!DEBUG_DISABLE_INITIAL_SUBDIVISION) {
  requestRefine({
    reason: 'initial',
    surfacePosition: { x: surfacePosition.x, y: surfacePosition.y, z: surfacePosition.z },
    focusedPoint: { x: surfacePosition.x, y: surfacePosition.y, z: surfacePosition.z }
  });
  console.log(`🌍 Initial subdivision at position: ${surfacePosition.length().toFixed(0)}m from origin`);
} else {
  console.warn('[debug] Initial subdivision disabled via DEBUG_DISABLE_INITIAL_SUBDIVISION');
}

// Initialize focus markers and ray
initFocusMarkers();
initMetricsHUD();
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

function forceImmediateSubdivisionUpdate() {
  lastSubdivisionUpdate = 0;
  lastSubdivisionPosition.copy(surfacePosition);
}

function applySavedLocationIfAvailable(updateFocusIndicators) {
  if (appliedSavedLocation || gps.have) return;
  const last = getLastGPSLocation();
  if (!last || !Number.isFinite(last.lat) || !Number.isFinite(last.lon)) return;
  appliedSavedLocation = true;
  gps.have = true;
  gps.lat = last.lat;
  gps.lon = last.lon;
  gps.alt = Number.isFinite(last.alt) ? last.alt : 0;
  surfacePosition.copy(latLonToCartesian(gps.lat, gps.lon, gps.alt));
  focusedPoint.copy(surfacePosition);
  updateFocusIndicators(focusedPoint);
  dom.gpsStatus.textContent = `${gps.lat.toFixed(6)}°, ${gps.lon.toFixed(6)}° (saved)`;
  setFocusedBaseFaceIndex(null);
  setHasFocusedBary(false);
  scheduleTerrainRebuild('saved-gps');
}

// Floating origin: Translate scene to keep coordinates small near camera
const tmpOrigin = new THREE.Vector3();

function updateCameraSplitUniforms(camPos) {
  if (globeMaterial) applyCameraUniforms(globeMaterial, camPos);
  if (wireframeMaterial) applyCameraUniforms(wireframeMaterial, camPos);
  if (focusMarkerMaterial) applyCameraUniforms(focusMarkerMaterial, camPos);
  if (markerMaterial) applyCameraUniforms(markerMaterial, camPos);
  if (focusRayMaterial) applyCameraUniforms(focusRayMaterial, camPos);
}

function updateDebugVertexLabels(renderCam = activeCamera) {
  if (!DEBUG_SHOW_VERTEX_LABELS) {
    debugLabelContainer.innerHTML = '';
    debugLastRadius.clear();
    return;
  }
  const posAttr = globeGeometry?.getAttribute ? globeGeometry.getAttribute('position') : null;
  const nowTs = performance.now();
  const radiusLimit = DEBUG_LABEL_RADIUS_M ?? 100;
  const maxLabels = DEBUG_MAX_VERTEX_LABELS ?? 120;
  const labels = [];
  const verts = subdividedGeometry.vertices;
  const width = renderer.domElement.clientWidth || window.innerWidth;
  const height = renderer.domElement.clientHeight || window.innerHeight;
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    if (!v) continue;
    const dist = v.distanceTo(surfacePosition);
    if (!Number.isFinite(dist) || dist > radiusLimit) continue;
    labels.push({ idx: i, dist, v });
  }
  labels.sort((a, b) => a.dist - b.dist);
  const slice = labels.slice(0, maxLabels);
  debugLabelContainer.innerHTML = '';
  const consoleRows = [];
  for (const entry of slice) {
    const meta = ensureVertexMetadata(entry.idx, elevationCache, settings.elevExag);
    let radius = entry.v.length();
    if (posAttr && posAttr.isBufferAttribute) {
      const offset = entry.idx * 3;
      if (offset + 2 < posAttr.array.length) {
        const gx = posAttr.array[offset];
        const gy = posAttr.array[offset + 1];
        const gz = posAttr.array[offset + 2];
        const gr = Math.sqrt(gx * gx + gy * gy + gz * gz);
        if (Number.isFinite(gr)) {
          radius = gr;
        }
      }
    }
    const elev = meta?.elevation ?? null;
    const displayRadius = Number.isFinite(elev) ? radius + elev : radius;
    const prevR = debugLastRadius.get(entry.idx);
    const delta = (prevR != null && Number.isFinite(prevR)) ? displayRadius - prevR : 0;
    debugLastRadius.set(entry.idx, displayRadius);
    const deltaText = (prevR != null && Math.abs(delta) > 0.0001) ? ` Δr=${delta.toFixed(4)}` : '';
    const text = `${meta?.geohash || entry.idx} | r=${displayRadius.toFixed(4)}${Number.isFinite(elev) ? ` | h=${elev.toFixed(4)}` : ''}${deltaText}`;
    // Offset vertex position to match floating origin rendering
    const worldPos = entry.v.clone().sub(surfacePosition);
    worldPos.project(renderCam || activeCamera);
    if (worldPos.z > 1) continue;
    const x = (worldPos.x + 1) / 2 * width;
    const y = (-worldPos.y + 1) / 2 * height;
    const label = document.createElement('div');
    label.textContent = text;
    label.style.position = 'absolute';
    label.style.transform = `translate(${x}px, ${y}px)`;
    if (Number.isFinite(elev)) {
      label.style.color = 'yellow';
    }
    debugLabelContainer.appendChild(label);
    consoleRows.push({
      idx: entry.idx,
      geohash: meta?.geohash,
      radius: Number.isFinite(displayRadius) ? Number(displayRadius.toFixed(6)) : null,
      elevation: Number.isFinite(elev) ? Number(elev.toFixed(6)) : null,
      deltaRadius: Number.isFinite(delta) ? Number(delta.toFixed(6)) : null,
      dist: Number.isFinite(entry.dist) ? Number(entry.dist.toFixed(6)) : null
    });
  }
  if (consoleRows.length && nowTs - (updateDebugVertexLabels._lastLogTs || 0) > 500) {
    console.table(consoleRows);
    updateDebugVertexLabels._lastLogTs = nowTs;
  }
}

function maybeKickoffBaseElevations() {
  if (baseElevationsKickoff) return;
  if (!nknReady) return;
  if (!terrainInitialized) return;
  if (!baseVertexCount || baseElevationsReady) {
    baseElevationsKickoff = true;
    return;
  }
  const availableVertices = subdividedGeometry?.originalVertices?.length || 0;
  if (availableVertices < baseVertexCount) return;
  baseElevationsKickoff = true;
  const indices = Array.from({ length: baseVertexCount }, (_, i) => i);
  fetchVertexElevation(indices, currentRegenerationRunId).catch(err => {
    console.warn('Base elevation fetch failed', err);
    baseElevationsKickoff = false;
  });
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
  forceImmediateSubdivisionUpdate,
  wireframeMesh
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

async function autoEnableSensors() {
  if (!dom.overlay) return;
  dom.status.textContent = 'Enabling sensors...';
  try {
    const ok = await requestPermissions(updateFocusIndicators);
    if (ok) {
      dom.overlay.classList.remove('show');
      dom.status.textContent = '';
      return;
    }
  } catch (err) {
    console.warn('Auto sensor enable failed', err);
  }
  dom.status.textContent = 'Tap Enable to grant sensor access.';
  dom.overlay.classList.add('show');
}

autoEnableSensors();

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

  const interactionActive = isSurfaceInteractionActive();
  setElevationUpdatesPaused(interactionActive);

  // Update orbit controls if enabled
  if (orbitControls.enabled) {
    orbitControls.update();
  }

  // Initialize terrain on first GPS lock
  applySavedLocationIfAvailable(updateFocusIndicators);
  maybeInitTerrain();
  maybeKickoffBaseElevations();
  buildingManager?.update(surfacePosition);

  // Check if we need to update subdivision based on movement/time
  if (terrainInitialized && gps.have) {
    const timeSinceLastUpdate = now - lastSubdivisionUpdate;
    const distanceMoved = surfacePosition.distanceTo(lastSubdivisionPosition);
    const needsUpdate =
      timeSinceLastUpdate > SUBDIVISION_UPDATE_INTERVAL ||
      distanceMoved > SUBDIVISION_DISTANCE_THRESHOLD;
    const allowMovementRefinement = !DEBUG_DISABLE_MOVEMENT_REFINEMENT;

    if (needsUpdate && allowMovementRefinement) {
      lastSubdivisionUpdate = now;
      lastSubdivisionPosition.copy(surfacePosition);
      if (mode !== 'orbit' || followGPS) {
        setFocusedBaseFaceIndex(null);
        focusedPoint.copy(surfacePosition);
        setHasFocusedBary(false);
        updateFocusIndicators(focusedPoint);
      }
      pendingMovementRebuild = true;
      movementRebuildDeadline = now + MOVEMENT_REBUILD_SETTLE_MS;
    } else if (needsUpdate && !allowMovementRefinement) {
      lastSubdivisionUpdate = now;
      lastSubdivisionPosition.copy(surfacePosition);
      pendingMovementRebuild = false;
    }
  }

  if (!DEBUG_DISABLE_MOVEMENT_REFINEMENT && pendingMovementRebuild && now >= movementRebuildDeadline) {
    if (!isRegenerating && !wantTerrainRebuild) {
      pendingMovementRebuild = false;
      // Only trigger refinement if we've moved significantly (prevents rotation-based rebuilds)
      if (shouldTriggerRefinement(surfacePosition)) {
        scheduleTerrainRebuild('movement');
        // Pass surfacePosition for BOTH params - ensures subdivision follows movement, not camera rotation
        requestRefine({
          reason: 'movement',
          surfacePosition: { x: surfacePosition.x, y: surfacePosition.y, z: surfacePosition.z },
          focusedPoint: { x: surfacePosition.x, y: surfacePosition.y, z: surfacePosition.z },
          useIncremental: true
        });
      }
    } else {
      movementRebuildDeadline = now + MOVEMENT_REBUILD_SETTLE_MS;
    }
  }

  // Execute pending terrain refine if ready
  if (!isRegenerating && wantTerrainRebuild) {
    const elapsed = performance.now() - lastTerrainRebuildTime;
    if (elapsed >= MIN_TERRAIN_REBUILD_INTERVAL_MS) {
      const reason = pendingRebuildReason ?? 'update';
      // Check if we should trigger refinement (prevents rotation-based rebuilds)
      if (shouldTriggerRefinement(surfacePosition)) {
        setIsRegenerating(true);
        // Pass surfacePosition for BOTH params - subdivision based on position, not gaze
        requestRefine({
          reason,
          surfacePosition: { x: surfacePosition.x, y: surfacePosition.y, z: surfacePosition.z },
          focusedPoint: { x: surfacePosition.x, y: surfacePosition.y, z: surfacePosition.z },
          useIncremental: true
        });
        setWantTerrainRebuild(false);
        setLastTerrainRebuildTime(performance.now());
      } else {
        // Clear the rebuild request since we're not far enough from last refinement
        setWantTerrainRebuild(false);
      }
    }
  }

  if (!interactionActive) {
    clearMeshWasUpdated(); // Clear flag before applying new updates when idle
  }
  applyPendingPatches();
  // Process elevation queue to fetch pending elevations (fire-and-forget async)
  if (!interactionActive) {
    processElevationQueue(16).catch(err => console.error('[tick] processElevationQueue error', err));
  }

  // Floating origin: Translate scene by -surfacePosition to keep coordinates small
  const offset = tmpOrigin.copy(surfacePosition);
  const origScenePos = scene.position.clone();
  scene.position.set(-offset.x, -offset.y, -offset.z);

  if (mode === 'orbit' && typeof orbitControls !== 'undefined' && orbitControls) {
    const origCamPos = cameraOrbit.position.clone();
    const origTarget = orbitControls.target.clone();
    const renderTarget = origTarget.clone().sub(offset);
    cameraOrbit.position.copy(origCamPos).sub(offset);
    cameraOrbit.lookAt(renderTarget);
    updateDebugVertexLabels(cameraOrbit);
    updateElevationIndicators(now);
    renderer.render(scene, cameraOrbit);
    cameraOrbit.position.copy(origCamPos);
    cameraOrbit.lookAt(origTarget);
  } else {
    const origCamPos = activeCamera.position.clone();
    activeCamera.position.copy(origCamPos).sub(offset);
    updateDebugVertexLabels(activeCamera);
    updateElevationIndicators(now);
    renderer.render(scene, activeCamera);
    activeCamera.position.copy(origCamPos);
  }

  scene.position.copy(origScenePos);

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
