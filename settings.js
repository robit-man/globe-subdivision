// ──────────────────────── Settings (persisted) ────────────────────────

import {
  initPersistence,
  getTerrainSettings,
  updateTerrainSettings,
  getNKNConfig,
  updateNKNRelay
} from './persistent.js';

// Initialize persistence on first import
const persistentState = initPersistence();

// Export settings object that references persistent storage
export let settings = {
  get nknRelay() { return getNKNConfig()?.relay || 'forwarder.4658c990865d63ad367a3f9e26203df9ad544f9d58ef27668db4f3ebc570eb5f'; },
  set nknRelay(value) { updateNKNRelay(value); },

  get dataset() { return getTerrainSettings()?.dataset || 'mapzen'; },
  set dataset(value) { updateTerrainSettings({ dataset: value }); },

  get maxRadius() { return getTerrainSettings()?.maxRadius || 50000; },
  set maxRadius(value) { updateTerrainSettings({ maxRadius: value }); },

  get fineDetailRadius() { return getTerrainSettings()?.fineDetailRadius || 4000; },
  set fineDetailRadius(value) { updateTerrainSettings({ fineDetailRadius: value }); },

  get fineDetailFalloff() { return getTerrainSettings()?.fineDetailFalloff || 6000; },
  set fineDetailFalloff(value) { updateTerrainSettings({ fineDetailFalloff: value }); },

  get elevExag() { return getTerrainSettings()?.elevExag || 1.0; },
  set elevExag(value) { updateTerrainSettings({ elevExag: value }); },

  get minSpacingM() { return getTerrainSettings()?.minSpacingM || 1; },
  set minSpacingM(value) { updateTerrainSettings({ minSpacingM: value }); },

  get maxSpacingM() { return getTerrainSettings()?.maxSpacingM || 5000; },
  set maxSpacingM(value) { updateTerrainSettings({ maxSpacingM: value }); },

  get maxVertices() { return getTerrainSettings()?.maxVertices || 50000; },
  set maxVertices(value) { updateTerrainSettings({ maxVertices: value }); },

  get sseNearThreshold() { return getTerrainSettings()?.sseNearThreshold ?? 2.0; },
  set sseNearThreshold(value) { updateTerrainSettings({ sseNearThreshold: value }); },

  get sseFarThreshold() { return getTerrainSettings()?.sseFarThreshold ?? 8.0; },
  set sseFarThreshold(value) { updateTerrainSettings({ sseFarThreshold: value }); }
};

export function loadSettings() {
  // Persistence is already initialized, settings object uses getters
  console.log('✅ Settings loaded from persistent storage');
}

export function saveSettings() {
  // Settings are saved automatically via setters
  console.log('✅ Settings saved to persistent storage');
}
