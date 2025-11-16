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
  DEBUG_LABEL_RADIUS_M,
  EARTH_RADIUS_M
} from './constants.js';
import { loadSettings, settings } from './settings.js';
import { saveGPSLocation, getLastGPSLocation } from './persistent.js';
import { dom, syncSettingsUI, initUIListeners } from './ui.js';
import { bootManager, applyFocusAndRegenerate } from './bootstrap.js';
import { initScene, renderer, scene } from './scene.js';
import {
  globe,
  globeGeometry,
  globeMaterial,
  wireframeGeometry,
  wireframeMaterial,
  wireframeMesh,
  setGlobeVisibility,
  getGlobeVisibility,
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
  incrementRegenerationRunId,
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
  ensureVertexMetadata,
  setCancelRegeneration
} from './terrain.js';
import { snapVectorToTerrain } from './terrain.js';
import { SimpleBuildingManager } from './buildings.js';
import { initMetricsHUD } from './metricsHud.js';
import { latLonToCartesian, cartesianToLatLon } from './utils.js';
import {
  splitVector3ToHighLow,
  renderOrigin,
  setRenderOrigin,
  shouldUpdateRenderOrigin,
  updateRenderOriginAndTransformScene,
  computeRenderOrigin,
  worldToLocal
} from './precision.js';
import {
  createDetailPatch,
  shouldRecreateDetailPatch,
  disposeDetailPatch,
  getDetailPatchMesh,
  transformDetailPatchForOriginChange,
  setDetailPatchVisibility,
  getDetailPatchVisibility
} from './detailPatch.js';

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

// ──────────────────────── Stage 1: Load Settings ────────────────────────

loadSettings();
console.log('✅ Settings loaded');
bootManager.markSettingsLoaded();

// Initialize tracking variables
let lastSubdivisionUpdate = 0;
let lastSubdivisionPosition = new THREE.Vector3();
const MOVEMENT_REBUILD_SETTLE_MS = 350;
let pendingMovementRebuild = false;
let movementRebuildDeadline = 0;
let baseElevationsKickoff = false;
let appliedSavedLocation = false;
let ipLocationRequested = false;
let ipLocationApplied = false;
let pendingAutoSubdivisionReason = null;

// Detail patch tracking
let detailPatchInitialized = false;

// ──────────────────────── Stage 2: Initialize Scene/Renderer/Globe/Camera ────────────────────────

initScene();
initCameras();
initInputHandlers();
initGlobe();
initFocusMarkers();
initMetricsHUD();

console.log('✅ Scene, renderer, globe, and camera initialized');
bootManager.markSceneReady();

// ──────────────────────── Stage 3: Initialize Terrain (No Subdivision Yet) ────────────────────────

captureBaseIcosahedron(globeGeometry);
initTerrainScheduler({ settings });

console.log('✅ Terrain scheduler initialized, base icosahedron captured');

// Inject dependencies into terrain module (must be done before location triggers subdivision)
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
console.log('✅ Terrain dependencies injected');

bootManager.markTerrainReady();

const buildingManager = new SimpleBuildingManager(scene);

// ──────────────────────── Stage 4: Acquire Location (Saved → GPS → IP Fallback) ────────────────────────

// Load saved GPS position if available
const savedGPS = getLastGPSLocation();
if (savedGPS && Number.isFinite(savedGPS.lat) && Number.isFinite(savedGPS.lon)) {
  gps.have = true;
  gps.lat = savedGPS.lat;
  gps.lon = savedGPS.lon;
  gps.alt = Number.isFinite(savedGPS.alt) ? savedGPS.alt : 0;
  const pos = latLonToCartesian(gps.lat, gps.lon, gps.alt);
  surfacePosition.copy(pos);
  focusedPoint.copy(pos);
  appliedSavedLocation = true;
  bootManager.markLocationAcquired();
  console.log(`📍 Loaded saved GPS: ${gps.lat.toFixed(6)}°, ${gps.lon.toFixed(6)}°`);

  // Switch to orbit mode to view the subdivision from above
  if (mode === 'surface') {
    switchMode('orbit');
  }

  // Trigger initial subdivision with saved location
  triggerAutoFocusSubdivision('saved-gps', updateFocusIndicators);
} else {
  console.log('⏸️ Initial subdivision deferred until location is acquired');
}

// Sync settings UI
syncSettingsUI();
console.log('✅ UI synchronized');

// Initialize UI event listeners
initUIListeners(resetTerrainGeometryToBase, scheduleTerrainRebuild);
console.log('✅ UI event listeners initialized');

// Initialize GPS listeners
initGPSListeners(updateFocusIndicators);
console.log('✅ GPS listeners initialized');
// Kick off IP-based fallback to drive initial subdivision when GPS is unavailable
fetchIPLocationFallback(updateFocusIndicators).catch(err => console.warn('[geoip] fallback fetch failed', err));

// Start GPS; when first fix arrives, trigger subdivision as if user clicked that point
startGPS(updateFocusIndicators, () => {
  if (!bootManager.flags.locationAcquired) {
    bootManager.markLocationAcquired();
    console.log('📍 GPS lock acquired');
  }

  // Switch to orbit mode to view the subdivision from above
  if (mode === 'surface') {
    switchMode('orbit');
  }

  triggerAutoFocusSubdivision('gps-lock', updateFocusIndicators);
});

function updateToggleButtonState(btn, isActive) {
  if (!btn) return;
  btn.classList.toggle('active', isActive);
  btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
}

function initVisibilityToggles() {
  updateToggleButtonState(dom.togglePlanet, getGlobeVisibility());
  updateToggleButtonState(dom.toggleYarmulke, getDetailPatchVisibility());

  dom.togglePlanet?.addEventListener('click', () => {
    const next = !getGlobeVisibility();
    setGlobeVisibility(next);
    updateToggleButtonState(dom.togglePlanet, next);
  });

  dom.toggleYarmulke?.addEventListener('click', () => {
    const next = !getDetailPatchVisibility();
    setDetailPatchVisibility(next);
    updateToggleButtonState(dom.toggleYarmulke, next);
  });
}

initVisibilityToggles();

function forceImmediateSubdivisionUpdate() {
  lastSubdivisionUpdate = 0;
  lastSubdivisionPosition.copy(surfacePosition);
}

function triggerAutoFocusSubdivision(reason, updateFocusIndicators) {
  console.log(`🎯 triggerAutoFocusSubdivision called: reason=${reason}, isRegenerating=${isRegenerating}`);

  // If a regeneration is mid-flight, wait until it completes.
  if (isRegenerating) {
    console.log(`⏸️ Deferring auto-subdivision (${reason}) - regeneration in progress`);
    pendingAutoSubdivisionReason = pendingAutoSubdivisionReason || reason;
    setCancelRegeneration(true);
    return;
  }

  // Use shared apply focus + regen logic
  const sourceMap = {
    'saved-gps': 'saved',
    'ip-location': 'ip',
    'gps-lock': 'gps',
    'click': 'manual'
  };

  applyFocusAndRegenerate(surfacePosition, {
    reason,
    source: sourceMap[reason] || 'auto',
    updateFocusIndicators,
    deps: {
      snapVectorToTerrain,
      surfacePosition,
      focusedPoint,
      gps,
      setFollowGPS: () => {}, // No-op for auto triggers
      setSurfacePosition: (pos) => surfacePosition.copy(pos),
      setFocusedPoint: (pos) => focusedPoint.copy(pos),
      findClosestBaseFaceIndex,
      setFocusedBaseFaceIndex,
      updateFocusedFaceBary,
      setHasFocusedBary,
      setCancelRegeneration,
      incrementRegenerationRunId,
      resetTerrainGeometryToBase,
      scheduleTerrainRebuild,
      setLastTerrainRebuildTime,
      forceSubdivisionUpdate: forceImmediateSubdivisionUpdate,
      cartesianToLatLon,
      saveGPSLocation,
      dom,
      MIN_TERRAIN_REBUILD_INTERVAL_MS,
      EARTH_RADIUS_M
    }
  });
}

function applyApproximateLocationFromIP(lat, lon, updateFocusIndicators) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  if (gps.have) return; // Do not override an active GPS/watch/manual selection
  ipLocationApplied = true;
  gps.have = true;
  gps.lat = lat;
  gps.lon = lon;
  gps.alt = 0;
  const pos = latLonToCartesian(lat, lon, gps.alt);
  surfacePosition.copy(pos);
  focusedPoint.copy(pos);
  bootManager.markLocationAcquired();
  console.log(`📍 IP location acquired: ${gps.lat.toFixed(6)}°, ${gps.lon.toFixed(6)}°`);

  // Switch to orbit mode to view the subdivision from above
  if (mode === 'surface') {
    switchMode('orbit');
  }

  triggerAutoFocusSubdivision('ip-location', updateFocusIndicators);
}

async function fetchIPLocationFallback(updateFocusIndicators) {
  if (ipLocationRequested || ipLocationApplied || gps.have) return;
  ipLocationRequested = true;
  const providers = [
    'https://ipapi.co/json/',
    'https://ipinfo.io/json'
  ];
  for (const url of providers) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const data = await res.json();
      let lat = Number(data?.lat ?? data?.latitude ?? data?.location?.lat ?? data?.location?.latitude);
      let lon = Number(data?.lon ?? data?.lng ?? data?.longitude ?? data?.location?.lon ?? data?.location?.lng ?? data?.location?.longitude);
      const locString = data?.loc || data?.location || data?.data?.loc;
      if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && typeof locString === 'string' && locString.includes(',')) {
        const [la, lo] = locString.split(',').map(v => Number.parseFloat(v));
        lat = Number.isFinite(lat) ? lat : la;
        lon = Number.isFinite(lon) ? lon : lo;
      }
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        applyApproximateLocationFromIP(lat, lon, updateFocusIndicators);
        return;
      }
    } catch (err) {
      console.warn('[geoip] lookup failed', url, err);
    }
  }
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
  triggerAutoFocusSubdivision('saved-gps', updateFocusIndicators);
}

// Cesium RTE: Camera world position tracking
export const cameraWorldPosition = new THREE.Vector3(); // Camera's world position

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

// ──────────────────────── Stage 5: Start NKN Client & Elevation Pipeline ────────────────────────

initNKN();

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

// ──────────────────────── Cesium RTE Camera Uniforms ────────────────────────

let rteDebugOnce = false;
function updateCameraUniforms(cameraPosition) {
  // Split camera position into high/low for RTE rendering
  const { high, low } = splitVector3ToHighLow(cameraPosition);

  let updatedCount = 0;
  // Update all materials with RTE shaders in the scene
  scene.traverse((object) => {
    if (object.material) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];

      for (const material of materials) {
        if (material?.userData?.shader) {
          const shader = material.userData.shader;
          if (shader.uniforms?.cameraHigh) {
            shader.uniforms.cameraHigh.value.copy(high);
            updatedCount++;
          }
          if (shader.uniforms?.cameraLow) {
            shader.uniforms.cameraLow.value.copy(low);
          }
        }
      }
    }
  });

  // Debug once
  if (!rteDebugOnce && updatedCount > 0) {
    console.log(`✅ RTE uniforms updating ${updatedCount} materials | cam:`,
      (cameraPosition.length() / 1000).toFixed(1) + 'km',
      '| high:', high.length().toFixed(0), '| low:', low.length().toFixed(3));
    rteDebugOnce = true;
  }
}

// ──────────────────────── Render Loop ────────────────────────

let then = performance.now();
let frames = 0;
let fps = 0;
let fpsAccum = 0;

function tick(now) {
  const dt = Math.min(0.05, (now - then) / 1000);
  then = now;

  // Early exit if boot dependencies not met
  if (!bootManager.canRender()) {
    requestAnimationFrame(tick);
    return;
  }

  // Update camera (handles orientation, walking, compass, alignment)
  updateCamera(dt, updateFocusIndicators);

  // If an auto subdivision was deferred due to in-flight regeneration, fire it now.
  if (pendingAutoSubdivisionReason && !isRegenerating) {
    const reason = pendingAutoSubdivisionReason;
    pendingAutoSubdivisionReason = null;
    console.log(`🔄 Triggering deferred auto-subdivision: ${reason}`);
    triggerAutoFocusSubdivision(reason, updateFocusIndicators);
  }

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

  // Create or recreate detail patch when needed
  if (gps.have && surfacePosition.lengthSq() > 0) {
    if (!detailPatchInitialized) {
      // Create initial detail patch at player position
      createDetailPatch(scene, surfacePosition);
      detailPatchInitialized = true;
      console.log('✅ Detail patch created at player position');
    } else if (shouldRecreateDetailPatch(surfacePosition)) {
      // Player moved far from patch center - recreate patch
      console.log('🔄 Player moved far from patch center, recreating detail patch...');
      disposeDetailPatch(scene);
      createDetailPatch(scene, surfacePosition);
      // Trigger subdivision rebuild to populate new patch
      scheduleTerrainRebuild('patch-recreation');
    }
  }

  // Ensure current visibility flags are applied each frame
  setGlobeVisibility(getGlobeVisibility());
  setDetailPatchVisibility(getDetailPatchVisibility());

  // Check if we need to update subdivision based on movement/time (only after location acquired)
  if (terrainInitialized && gps.have && bootManager.canSubdivide()) {
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

  // Simple world-centered system:
  // - Globe stays at (0,0,0)
  // - Detail patch is a local dome/cap on the surface
  // - No floating origin needed

  scene.position.set(0, 0, 0);

  if (mode === 'orbit' && typeof orbitControls !== 'undefined' && orbitControls) {
    // Orbit mode: camera looks at world center (0,0,0)
    orbitControls.target.set(0, 0, 0);
    updateDebugVertexLabels(cameraOrbit);
    updateElevationIndicators(now);
    renderer.render(scene, cameraOrbit);
  } else {
    // Surface mode: raycast-based as before
    updateDebugVertexLabels(activeCamera);
    updateElevationIndicators(now);
    renderer.render(scene, activeCamera);
  }

  // Update camera position display in UI
  if (dom.cameraPos) {
    const cam = mode === 'orbit' ? cameraOrbit : activeCamera;
    const x = (cam.position.x / 1000).toFixed(2);
    const y = (cam.position.y / 1000).toFixed(2);
    const z = (cam.position.z / 1000).toFixed(2);
    dom.cameraPos.textContent = `${x}, ${y}, ${z}`;
  }

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
