import * as THREE from 'three';

// ──────────────────────── Bootstrap State Machine ────────────────────────

/**
 * Boot stages ensure dependencies are satisfied before proceeding.
 * Each stage gates certain operations until its dependencies are ready.
 */
export const BootStage = {
  INIT: 'init',                     // Nothing loaded yet
  SETTINGS_LOADED: 'settings',      // Settings/persistence loaded
  SCENE_READY: 'scene',             // Scene/renderer/globe/camera ready
  TERRAIN_READY: 'terrain',         // Base icosahedron captured, scheduler initialized
  LOCATION_ACQUIRED: 'location',    // Position obtained (saved/GPS/IP)
  NKN_READY: 'nkn',                 // NKN client connected
  FULLY_READY: 'ready'              // All systems operational
};

export class BootManager {
  constructor() {
    this.stage = BootStage.INIT;
    this.flags = {
      settingsLoaded: false,
      sceneInitialized: false,
      terrainInitialized: false,
      locationAcquired: false,
      nknReady: false
    };
    this.callbacks = {
      onLocationAcquired: []
    };
  }

  setStage(stage) {
    this.stage = stage;
    console.log(`📍 Boot stage: ${stage}`);
  }

  markSettingsLoaded() {
    this.flags.settingsLoaded = true;
    this.setStage(BootStage.SETTINGS_LOADED);
  }

  markSceneReady() {
    this.flags.sceneInitialized = true;
    this.setStage(BootStage.SCENE_READY);
  }

  markTerrainReady() {
    this.flags.terrainInitialized = true;
    this.setStage(BootStage.TERRAIN_READY);
  }

  markLocationAcquired() {
    this.flags.locationAcquired = true;
    this.setStage(BootStage.LOCATION_ACQUIRED);
    // Fire callbacks
    this.callbacks.onLocationAcquired.forEach(cb => cb());
    this.callbacks.onLocationAcquired = [];
  }

  markNKNReady() {
    this.flags.nknReady = true;
    this.setStage(BootStage.NKN_READY);
    this.checkFullyReady();
  }

  checkFullyReady() {
    if (this.flags.settingsLoaded &&
        this.flags.sceneInitialized &&
        this.flags.terrainInitialized &&
        this.flags.locationAcquired) {
      this.setStage(BootStage.FULLY_READY);
    }
  }

  onLocationAcquired(callback) {
    if (this.flags.locationAcquired) {
      callback();
    } else {
      this.callbacks.onLocationAcquired.push(callback);
    }
  }

  canRender() {
    return this.flags.sceneInitialized && this.flags.terrainInitialized;
  }

  canSubdivide() {
    return this.flags.terrainInitialized && this.flags.locationAcquired;
  }
}

export const bootManager = new BootManager();

// ──────────────────────── Shared Focus + Regen Logic ────────────────────────

/**
 * Applies a focus point and triggers terrain regeneration.
 * This is the shared logic used by both:
 * - Click-to-place (orbit mode)
 * - Auto-location (saved GPS, IP geolocation, GPS lock)
 *
 * @param {THREE.Vector3} position - World-space position to focus on
 * @param {Object} options - Configuration options
 * @param {string} options.reason - Rebuild reason ('click', 'gps-lock', 'ip-location', 'saved-gps')
 * @param {string} [options.source] - Source description for GPS display (e.g., 'manual', 'ip', 'saved')
 * @param {Function} options.updateFocusIndicators - Focus indicator update callback
 * @param {Object} options.deps - Required dependencies
 */
export function applyFocusAndRegenerate(position, options) {
  const {
    reason,
    source = 'manual',
    updateFocusIndicators,
    deps
  } = options;

  const {
    snapVectorToTerrain,
    surfacePosition,
    focusedPoint,
    gps,
    setFollowGPS,
    setSurfacePosition,
    setFocusedPoint,
    findClosestBaseFaceIndex,
    setFocusedBaseFaceIndex,
    updateFocusedFaceBary,
    setHasFocusedBary,
    setCancelRegeneration,
    incrementRegenerationRunId,
    resetTerrainGeometryToBase,
    scheduleTerrainRebuild,
    setLastTerrainRebuildTime,
    forceSubdivisionUpdate,
    cartesianToLatLon,
    saveGPSLocation,
    dom,
    MIN_TERRAIN_REBUILD_INTERVAL_MS
  } = deps;

  // Snap to terrain
  const snapped = position.clone();
  snapVectorToTerrain(snapped);

  // Calculate lat/lon
  const latLon = cartesianToLatLon(snapped);
  const latLonText = `${latLon.latDeg.toFixed(6)}°, ${latLon.lonDeg.toFixed(6)}°`;

  // Update GPS state
  if (source === 'manual') {
    setFollowGPS(false);
  }
  gps.have = true;
  gps.lat = latLon.latDeg;
  gps.lon = latLon.lonDeg;
  gps.alt = snapped.length() - deps.EARTH_RADIUS_M;

  // Update surface position and focus
  setSurfacePosition(snapped);
  setFocusedPoint(snapped);
  focusedPoint.copy(snapped);
  surfacePosition.copy(snapped);
  updateFocusIndicators(focusedPoint);

  // Update UI
  dom.gpsStatus.textContent = `${latLonText} (${source})`;

  // Find and set base face
  const baseFaceIndex = findClosestBaseFaceIndex(surfacePosition);
  setFocusedBaseFaceIndex(baseFaceIndex);
  updateFocusedFaceBary(baseFaceIndex, focusedPoint);
  setHasFocusedBary(true);

  // Save location
  saveGPSLocation(gps.lat, gps.lon, gps.alt);

  // Trigger regeneration
  setCancelRegeneration(true);
  incrementRegenerationRunId();
  resetTerrainGeometryToBase();

  // Force immediate subdivision update
  setLastTerrainRebuildTime(performance.now() - MIN_TERRAIN_REBUILD_INTERVAL_MS);
  if (forceSubdivisionUpdate) {
    forceSubdivisionUpdate();
  }

  scheduleTerrainRebuild(reason);

  console.log(`🎯 Focus applied: ${latLonText} (${source})`);
}
