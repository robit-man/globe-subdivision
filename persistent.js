// ──────────────────────── Persistent Storage System ────────────────────────
// Centralized persistence for all application state across page reloads

// NKN SDK is loaded globally via CDN
// Access via window.nkn

// ──────────────────────── Storage Keys ────────────────────────

const STORAGE_KEY = 'terrainGen_persistentState';
const STORAGE_VERSION = 1;

// ──────────────────────── Default State ────────────────────────

const DEFAULT_STATE = {
  version: STORAGE_VERSION,

  // NKN Configuration
  nkn: {
    seed: null,           // Hex string seed for NKN identity
    address: null,        // NKN address derived from seed
    relay: 'forwarder.5d7bdb47e1c757508d28f5726469afa1f7c93bd037a1940aa0dab97ab421c833',
    numSubClients: 4,
    originalClient: false
  },

  // Terrain Settings
  terrain: {
    maxRadius: 50000,           // Maximum subdivision radius (meters)
    fineDetailRadius: 4000,      // Fine detail radius (meters)
    fineDetailFalloff: 6000,     // Fine detail falloff distance (meters)
    minSpacingM: 1,              // Minimum edge length (meters)
    maxSpacingM: 5000,           // Maximum edge length (meters)
    elevExag: 1.0,               // Elevation exaggeration factor
    maxVertices: 30000,          // Maximum vertex count (hard-capped in settings)
    dataset: 'mapzen'            // Elevation dataset name
  },

  // Camera Settings
  camera: {
    lastMode: 'surface',         // 'surface' or 'orbit'
    orbitPosition: null,         // Saved orbit camera position {x, y, z}
    orbitTarget: null,           // Saved orbit camera target {x, y, z}
    savedLocations: []           // Array of {name, lat, lon, alt, timestamp}
  },

  // UI Preferences
  ui: {
    showWireframe: true,
    showFocusMarkers: true,
    showElevationIndicators: true,
    compressionQuality: 0.8
  },

  // Session Data
  session: {
    lastVisit: null,
    totalSessions: 0,
    lastGPSLocation: null        // {lat, lon, alt, timestamp}
  }
};

// ──────────────────────── State Management ────────────────────────

let state = null;

function generateRandomSeed() {
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    const arr = new Uint8Array(32);
    window.crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  let out = '';
  for (let i = 0; i < 64; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

// ──────────────────────── Initialization ────────────────────────

export function initPersistence() {
  console.log('💾 Initializing persistent storage...');

  // Try to load existing state
  const stored = localStorage.getItem(STORAGE_KEY);

  if (stored) {
    try {
      const parsed = JSON.parse(stored);

      // Check version compatibility
      if (parsed.version === STORAGE_VERSION) {
        state = deepMerge(DEFAULT_STATE, parsed);
        console.log('✅ Loaded persistent state from localStorage');
      } else {
        console.warn(`⚠️ Storage version mismatch (${parsed.version} vs ${STORAGE_VERSION}), migrating...`);
        state = migrateState(parsed);
      }
    } catch (err) {
      console.error('❌ Failed to parse stored state, using defaults:', err);
      state = deepClone(DEFAULT_STATE);
    }
  } else {
    console.log('📝 No existing state found, creating new state');
    state = deepClone(DEFAULT_STATE);
  }

  // Initialize NKN seed if not present
  if (!state.nkn.seed) {
    console.log('🔑 Generating new NKN seed...');
    const generator = (typeof window !== 'undefined' && window.nkn && window.nkn.util && window.nkn.util.generateSeed)
      ? window.nkn.util.generateSeed
      : null;
    state.nkn.seed = generator ? generator() : generateRandomSeed();
    console.log('✅ NKN seed generated and saved');
  }

  // Update session data
  state.session.totalSessions++;
  state.session.lastVisit = new Date().toISOString();

  // Save initial state
  save();

  console.log('✅ Persistent storage initialized');
  console.log('📊 State:', {
    sessions: state.session.totalSessions,
    nknAddress: state.nkn.address || 'pending',
    savedLocations: state.camera.savedLocations.length
  });

  return state;
}

// ──────────────────────── NKN Functions ────────────────────────

export function getNKNSeed() {
  return state?.nkn?.seed || null;
}

export function setNKNSeed(seed) {
  if (!state || !seed) return;
  state.nkn.seed = seed;
  save();
}

export function saveNKNSeed(seed) {
  setNKNSeed(seed);
}

export function setNKNAddress(address) {
  if (!state) return;
  state.nkn.address = address;
  save();
}

export function getNKNConfig() {
  return state?.nkn || null;
}

export function updateNKNRelay(relay) {
  if (!state) return;
  state.nkn.relay = relay;
  save();
}

// ──────────────────────── Terrain Settings ────────────────────────

export function getTerrainSettings() {
  return state?.terrain || null;
}

export function updateTerrainSettings(updates) {
  if (!state) return;
  Object.assign(state.terrain, updates);
  save();
}

export function resetTerrainSettings() {
  if (!state) return;
  state.terrain = deepClone(DEFAULT_STATE.terrain);
  save();
}

// ──────────────────────── Camera Functions ────────────────────────

export function getCameraSettings() {
  return state?.camera || null;
}

export function saveOrbitState(position, target) {
  if (!state) return;
  state.camera.orbitPosition = { x: position.x, y: position.y, z: position.z };
  state.camera.orbitTarget = { x: target.x, y: target.y, z: target.z };
  save();
}

export function saveCameraMode(mode) {
  if (!state) return;
  state.camera.lastMode = mode;
  save();
}

export function saveLocation(name, lat, lon, alt = 0) {
  if (!state) return;

  const location = {
    name,
    lat,
    lon,
    alt,
    timestamp: new Date().toISOString()
  };

  // Add to beginning of array
  state.camera.savedLocations.unshift(location);

  // Keep only last 50 locations
  if (state.camera.savedLocations.length > 50) {
    state.camera.savedLocations = state.camera.savedLocations.slice(0, 50);
  }

  save();
  console.log(`📍 Location saved: ${name} (${lat.toFixed(6)}, ${lon.toFixed(6)})`);
}

export function getSavedLocations() {
  return state?.camera?.savedLocations || [];
}

export function deleteLocation(index) {
  if (!state || !state.camera.savedLocations[index]) return;
  state.camera.savedLocations.splice(index, 1);
  save();
}

// ──────────────────────── UI Preferences ────────────────────────

export function getUIPreferences() {
  return state?.ui || null;
}

export function updateUIPreference(key, value) {
  if (!state || !state.ui.hasOwnProperty(key)) return;
  state.ui[key] = value;
  save();
}

// ──────────────────────── GPS/Session Functions ────────────────────────

export function saveGPSLocation(lat, lon, alt = 0) {
  if (!state) return;
  state.session.lastGPSLocation = {
    lat,
    lon,
    alt,
    timestamp: new Date().toISOString()
  };
  save();
}

export function getLastGPSLocation() {
  return state?.session?.lastGPSLocation || null;
}

// ──────────────────────── Save/Load Functions ────────────────────────

export function save() {
  if (!state) return;

  try {
    const serialized = JSON.stringify(state, null, 2);
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch (err) {
    console.error('❌ Failed to save persistent state:', err);

    // If quota exceeded, try to free space
    if (err.name === 'QuotaExceededError') {
      console.warn('⚠️ Storage quota exceeded, trimming saved locations...');
      if (state.camera.savedLocations.length > 10) {
        state.camera.savedLocations = state.camera.savedLocations.slice(0, 10);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state, null, 2));
          console.log('✅ Successfully saved after trimming');
        } catch (e) {
          console.error('❌ Still failed after trimming:', e);
        }
      }
    }
  }
}

export function getState() {
  return state;
}

export function exportState() {
  if (!state) return null;
  return JSON.stringify(state, null, 2);
}

export function importState(jsonString) {
  try {
    const imported = JSON.parse(jsonString);
    state = deepMerge(DEFAULT_STATE, imported);
    save();
    console.log('✅ State imported successfully');
    return true;
  } catch (err) {
    console.error('❌ Failed to import state:', err);
    return false;
  }
}

export function resetAll() {
  console.warn('⚠️ Resetting all persistent data...');
  state = deepClone(DEFAULT_STATE);

  // Generate new NKN seed
  if (typeof window !== 'undefined' && window.nkn && window.nkn.util && window.nkn.util.generateSeed) {
    state.nkn.seed = window.nkn.util.generateSeed();
  }

  save();
  console.log('✅ All data reset to defaults');
}

// ──────────────────────── Migration & Utilities ────────────────────────

function migrateState(oldState) {
  // Future version migrations will go here
  // For now, just merge with defaults
  return deepMerge(DEFAULT_STATE, oldState);
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function deepMerge(target, source) {
  const result = { ...target };

  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

// ──────────────────────── Debug Functions ────────────────────────

export function debugPrintState() {
  console.log('📊 Current Persistent State:', state);
}

export function getStorageSize() {
  if (!state) return 0;
  const serialized = JSON.stringify(state);
  return new Blob([serialized]).size;
}

// ──────────────────────── Auto-export on window (for debugging) ────────────────────────

if (typeof window !== 'undefined') {
  window.terrainGenPersistence = {
    getState,
    exportState,
    importState,
    resetAll,
    debugPrintState,
    getStorageSize
  };
}
