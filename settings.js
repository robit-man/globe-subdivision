// ──────────────────────── Settings (persisted) ────────────────────────

import {
  initPersistence,
  getTerrainSettings,
  updateTerrainSettings,
  getNKNConfig,
  updateNKNRelay
} from './persistent.js';
import { VERTEX_HARD_CAP } from './constants.js';

// Initialize persistence on first import
const persistentState = initPersistence();

// Export settings object that references persistent storage
export let settings = {
  get nknRelay() { return getNKNConfig()?.relay || 'forwarder.5d7bdb47e1c757508d28f5726469afa1f7c93bd037a1940aa0dab97ab421c833'; },
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

  get maxVertices() {
    const raw = getTerrainSettings()?.maxVertices ?? 50000;
    return Math.min(VERTEX_HARD_CAP, raw);
  },
  set maxVertices(value) {
    const clamped = Math.max(2000, Math.min(VERTEX_HARD_CAP, Number(value) || VERTEX_HARD_CAP));
    updateTerrainSettings({ maxVertices: clamped });
  },

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
