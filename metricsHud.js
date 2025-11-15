import { elevationEventBus } from './utils.js';
import { dom } from './ui.js';
import { showFetchRay, completeFetchRay } from './globe.js';

const hudState = {
  totalQueued: 0,
  applied: 0,
  errors: 0,
  active: 0,
  lastBatch: null
};

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  return `${(bytes / 1024).toFixed(bytes >= 10240 ? 1 : 2)} KB`;
}

function updateHUD() {
  if (!dom.metricVertices || !dom.metricBatch || !dom.metricApply) return;
  const total = hudState.totalQueued;
  const success = hudState.applied;
  const failed = hudState.errors;
  const remaining = Math.max(hudState.active, 0);
  if (total > 0) {
    const pct = Math.min(100, Math.round((success / total) * 100));
    dom.metricVertices.textContent = `Vertices ${success} / ${total} (${pct}%) · ${remaining} pending`;
  } else {
    dom.metricVertices.textContent = 'Vertices —';
  }

  if (hudState.lastBatch) {
    const { vertices, bytes, chunkIndex, chunkCount } = hudState.lastBatch;
    dom.metricBatch.textContent = `Batch ${vertices} pts · ${formatBytes(bytes)} (${chunkIndex}/${chunkCount})`;
  } else {
    dom.metricBatch.textContent = 'Batch —';
  }

  const considered = success + failed;
  if (considered > 0) {
    const ratio = Math.round((success / considered) * 100);
    dom.metricApply.textContent = `Apply ${ratio}% success · ${failed} error${failed === 1 ? '' : 's'}`;
  } else {
    dom.metricApply.textContent = 'Apply —';
  }
}

export function initMetricsHUD() {
  if (initMetricsHUD._initialized) return;
  initMetricsHUD._initialized = true;

  elevationEventBus.on('fetch:queued', ({ count = 0 } = {}) => {
    const amount = Number(count) || 0;
    if (hudState.active === 0 && hudState.totalQueued > 0 && (hudState.applied + hudState.errors) >= hudState.totalQueued) {
      hudState.totalQueued = 0;
      hudState.applied = 0;
      hudState.errors = 0;
      hudState.lastBatch = null;
    }
    hudState.totalQueued += amount;
    hudState.active += amount;
    updateHUD();
  });

  elevationEventBus.on('fetch:batch', (payload = {}) => {
    hudState.lastBatch = {
      vertices: payload.vertices ?? 0,
      bytes: payload.bytes ?? 0,
      chunkIndex: payload.chunkIndex ?? 1,
      chunkCount: payload.chunkCount ?? 1
    };
    updateHUD();
  });

  elevationEventBus.on('fetch:start', ({ idx, position } = {}) => {
    if (Number.isInteger(idx) && position) {
      showFetchRay(idx, position);
    }
  });

  elevationEventBus.on('fetch:applied', ({ idx, position } = {}) => {
    hudState.applied += 1;
    hudState.active = Math.max(0, hudState.active - 1);
    if (Number.isInteger(idx)) {
      completeFetchRay(idx, position);
    }
    updateHUD();
  });

  elevationEventBus.on('fetch:error', () => {
    hudState.errors += 1;
    hudState.active = Math.max(0, hudState.active - 1);
    updateHUD();
  });
}

initMetricsHUD._initialized = false;
