// ──────────────────────── NKN Client & Elevation Router ────────────────────────

import { DM_BUDGET_BYTES, MAX_GEOHASH_PER_DM, DEBUG_DISABLE_ELEVATION_QUEUE, DEBUG_FAKE_ELEVATIONS, DEBUG_LOG_ELEVATIONS } from './constants.js';
import { elevationEventBus, geohashEncode, uuidv4, dmByteLength } from './utils.js';
import { settings } from './settings.js';
import { dom } from './ui.js';
import * as persistence from './persistent.js';
import {
  currentRegenerationRunId,
  cancelRegeneration,
  baseElevationsReady,
  baseVertexCount,
  subdividedGeometry,
  ensureVertexMetadata,
  updateVertexMarkerColor,
  scheduleTerrainRebuild,
  setBaseElevationsReady,
  queueElevationBatch,
  getVertexIndexForGeohash
} from './terrain.js';

// ──────────────────────── NKN Client State ────────────────────────

const CHUNK_LIMIT_BYTES = 1024; // keep under free-tier DM payload limits
const MAX_CHUNK_VERTEX_REQUESTS = 60;
const NKN_BASE_BACKOFF_MS = 1200;
const NKN_MAX_BACKOFF_MS = 20000;
const NKN_HEALTH_INTERVAL_MS = 20000;
const SEND_SPACING_MS = 250;
// Bootstrap seeds for TLS (required when the app is served over HTTPS)
const SEED_RPC_SERVERS = [
  'https://mainnet-seed-0001.nkn.org/mainnet/api/wallet',
  'https://mainnet-seed-0002.nkn.org/mainnet/api/wallet',
  'https://mainnet-seed-0003.nkn.org/mainnet/api/wallet'
];
const SEED_WS_SERVERS = [
  'wss://mainnet-seed-0001.nkn.org/mainnet/ws',
  'wss://mainnet-seed-0002.nkn.org/mainnet/ws',
  'wss://mainnet-seed-0003.nkn.org/mainnet/ws'
];

let nknClient = null;
let nknReady = false;
let connectPromise = null;
let reconnectTimer = null;
let healthInterval = null;
let backoffMs = NKN_BASE_BACKOFF_MS;
const getNKNSeed = persistence.getNKNSeed || (() => null);
const persistNKNSeed = persistence.setNKNSeed || (() => {});
const setNKNAddress = persistence.setNKNAddress || (() => {});
const getNKNConfig = persistence.getNKNConfig || (() => ({}));

const pending = new Map();
const chunkAssemblies = new Map();
export const elevationCache = new Map();

function generateLocalSeed() {
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

function updateNknStatus(text, ok = true) {
  if (!dom.nknStatus) return;
  dom.nknStatus.textContent = text;
  dom.nknStatus.classList.toggle('error', !ok);
}

function decodePayload(payload) {
  if (typeof payload === 'string') return payload;
  if (payload instanceof Uint8Array) {
    return new TextDecoder().decode(payload);
  }
  if (payload && payload.payload) {
    return decodePayload(payload.payload);
  }
  return '';
}

function base64ToUint8(b64) {
  if (!b64) return null;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch (err) {
    console.warn('Failed to decode chunk', err);
    return null;
  }
}

function uint8ToBase64(bytes) {
  if (!bytes) return '';
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    let segment = '';
    for (let j = 0; j < slice.length; j++) {
      segment += String.fromCharCode(slice[j]);
    }
    binary += segment;
  }
  return btoa(binary);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let sendLock = Promise.resolve();
function runSendWithSpacing(fn) {
  const task = sendLock.then(fn, fn);
  sendLock = task.catch(() => {}).then(() => sleep(SEND_SPACING_MS));
  return task;
}

function bindClientEvent(client, event, handler) {
  if (!client || typeof handler !== 'function') return;
  const methodMap = {
    connect: client.onConnect,
    message: client.onMessage,
    close: client.onClose,
    error: client.onError
  };
  const direct = methodMap[event];
  if (typeof direct === 'function') {
    direct.call(client, handler);
    return;
  }
  if (typeof client.on === 'function') {
    try {
      client.on(event, handler);
    } catch (err) {
      console.warn('[nkn] failed to bind event', event, err);
    }
  }
}

function recordChunkAssembly(msg) {
  const id = msg?.id;
  if (!id || !msg.body_b64) return false;
  const data = base64ToUint8(msg.body_b64);
  if (!data) return false;
  let entry = chunkAssemblies.get(id);
  if (!entry) {
    entry = {
      chunks: [],
      chunkCount: Number.isFinite(msg.chunk_count) ? msg.chunk_count : null,
      totalBytes: Number.isFinite(msg.bytes_total) ? msg.bytes_total : 0,
      receivedCount: 0,
      receivedBytes: 0
    };
    chunkAssemblies.set(id, entry);
  }
  const idx = Number.isFinite(msg.chunk_index) ? msg.chunk_index : entry.receivedCount;
  if (!entry.chunks[idx]) {
    entry.chunks[idx] = data;
    entry.receivedCount += 1;
    entry.receivedBytes += data.length;
  }
  if (!Number.isFinite(entry.chunkCount) && Number.isFinite(msg.chunk_count)) {
    entry.chunkCount = msg.chunk_count;
  }
  if (!entry.totalBytes || entry.totalBytes < msg.bytes_total) {
    entry.totalBytes = Number(msg.bytes_total) || entry.receivedBytes;
  }
  return true;
}

function attachChunksToResponse(msg) {
  if (!msg || !msg.id) return false;
  const entry = chunkAssemblies.get(msg.id);
  if (!entry) return false;
  const expected = entry.chunkCount ?? entry.chunks.length;
  const actual = entry.chunks.filter(Boolean).length;
  if (expected && actual < expected) {
    console.warn(`Chunk assembly incomplete for ${msg.id}: ${actual}/${expected}`);
  }
  const total = entry.totalBytes || entry.chunks.reduce((sum, chunk) => sum + (chunk?.length || 0), 0);
  const buffer = new Uint8Array(total);
  let offset = 0;
  entry.chunks.forEach(chunk => {
    if (!chunk) return;
    buffer.set(chunk, offset);
    offset += chunk.length;
  });
  msg.body_b64 = uint8ToBase64(buffer);
  chunkAssemblies.delete(msg.id);
  return true;
}

function clearPendingEntry(id, shouldReject=false, err=null) {
  if (!id || !pending.has(id)) return;
  const st = pending.get(id);
  clearTimeout(st.timer);
  pending.delete(id);
  if (shouldReject && typeof st.reject === 'function') {
    st.reject(err || new Error('DM cancelled'));
  }
}

function stopNknHealthMonitor() {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
}

function scheduleNknReconnect(reason) {
  if (reconnectTimer) return;
  stopNknHealthMonitor();
  const delay = backoffMs;
  console.warn(`[nkn] reconnect scheduled (${reason}) in ${(delay/1000).toFixed(1)}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureNknClient().catch(err => console.warn('[nkn] reconnect failed', err));
  }, delay);
  backoffMs = Math.min(backoffMs * 1.5, NKN_MAX_BACKOFF_MS);
}

function resetNknClient(reason='reset') {
  if (nknClient && typeof nknClient.close === 'function') {
    try { nknClient.close(); }
    catch (_) { /* ignore */ }
  }
  nknClient = null;
  nknReady = false;
  updateNknStatus('reconnecting…', false);
  scheduleNknReconnect(reason);
}

function startNknHealthMonitor() {
  stopNknHealthMonitor();
  healthInterval = setInterval(async () => {
    if (!nknReady || !settings.nknRelay) return;
    try {
      await sendWithReply(settings.nknRelay, { type: 'ping' }, { timeoutMs: 5000, maxAttempts: 1 });
    } catch (err) {
      console.warn('[nkn] health ping failed', err);
    }
  }, NKN_HEALTH_INTERVAL_MS);
}

async function ensureNknClient() {
  if (nknClient && nknReady) return nknClient;
  if (connectPromise) return connectPromise;
  if (!window.nkn || !window.nkn.MultiClient) {
    throw new Error('nkn-sdk not loaded');
  }

  let seed = getNKNSeed();
  if (!seed) {
    const generator = window.nkn?.util?.generateSeed;
    seed = generator ? generator() : generateLocalSeed();
    if (seed) {
      persistNKNSeed(seed);
    }
  }
  const config = getNKNConfig();
  const forceTls = (typeof window !== 'undefined' && window.location && window.location.protocol === 'https:');
  const clientConfig = {
    identifier: 'inference-web',
    numSubClients: Math.min(config?.numSubClients || 8, 8),
    originalClient: config?.originalClient || false,
    reconnectIntervalMin: 1000,
    reconnectIntervalMax: 6000,
    responseTimeout: config?.responseTimeoutMs || 15000,
    msgHoldingSeconds: 60,
    msgCacheSize: 2048,
    msgCacheExpiration: 300000,
    wsConnHeartbeatTimeout: 120000,
    seedRpcServerAddr: SEED_RPC_SERVERS,
    seedWsAddr: SEED_WS_SERVERS,
    tls: config?.tls ?? forceTls ?? false
  };
  if (seed) {
    clientConfig.seed = seed;
  }

  updateNknStatus('connecting…', true);

  connectPromise = new Promise((resolve, reject) => {
    try {
      const client = new window.nkn.MultiClient(clientConfig);
      nknClient = client;
      let settled = false;

      bindClientEvent(client, 'connect', () => {
        nknReady = true;
        reconnectTimer = null;
        backoffMs = NKN_BASE_BACKOFF_MS;
        const address = client.addr ? String(client.addr) : '';
        if (address) {
          setNKNAddress(address);
          console.log('✅ NKN connected', address);
          updateNknStatus(`connected · ${address.slice(0, 12)}…`, true);
        } else {
          updateNknStatus('connected', true);
        }
        if (client.seed) {
          persistNKNSeed(client.seed);
        }
        startNknHealthMonitor();
        if (!settled) {
          settled = true;
          resolve(client);
        }
      });

      bindClientEvent(client, 'message', (evt) => {
        const src = evt?.src ?? evt?.from ?? evt?.address ?? '';
        const payload = evt?.payload ?? evt?.data ?? evt;
        handleIncoming(src, payload);
      });

      bindClientEvent(client, 'close', () => {
        nknReady = false;
        nknClient = null;
        updateNknStatus('disconnected', false);
        stopNknHealthMonitor();
        scheduleNknReconnect('close');
      });

      bindClientEvent(client, 'error', (err) => {
        console.error('[nkn] error', err);
        nknReady = false;
        nknClient = null;
        updateNknStatus('error', false);
        stopNknHealthMonitor();
        if (!settled) {
          settled = true;
          reject(err);
        }
        scheduleNknReconnect('error');
      });
    } catch (err) {
      reject(err);
    }
  }).finally(() => {
    connectPromise = null;
  });

  return connectPromise;
}

function handleIncoming(src, payload){
  const text = decodePayload(payload);
  let msg;
  try { msg = JSON.parse(text); }
  catch { return false; }

  const type = msg?.type || msg?.event;
  const id = msg?.id;

  if (type === 'http.chunk') {
    recordChunkAssembly(msg);
    return false;
  }

  if (type === 'http.response' && msg?.chunked) {
    attachChunksToResponse(msg);
  }

  if (id && pending.has(id)) {
    const st = pending.get(id);
    clearTimeout(st.timer);
    pending.delete(id);
    if (typeof st.resolve === 'function') {
      st.resolve(msg);
    }
    return false;
  }

  return false;
}

async function initNKN() {
  if (!window.nkn || !window.nkn.MultiClient) {
    updateNknStatus('SDK not loaded', false);
    return;
  }
  try {
    await ensureNknClient();
  } catch (err) {
    updateNknStatus('error', false);
    console.error('NKN init error:', err);
  }
}

function normalizeSendOptions(optionsOrTimeout) {
  if (typeof optionsOrTimeout === 'number') {
    return { timeoutMs: optionsOrTimeout };
  }
  return optionsOrTimeout || {};
}

async function sendWithReply(dest, obj, optionsOrTimeout={}) {
  const options = normalizeSendOptions(optionsOrTimeout);
  const maxAttempts = options.maxAttempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 15000;
  const backoffDelay = options.backoffMs ?? NKN_BASE_BACKOFF_MS;
  const chunkBytes = Math.min(options.maxChunkBytes ?? CHUNK_LIMIT_BYTES, CHUNK_LIMIT_BYTES);

  if (!dest) throw new Error('Dest required');
  if (chunkBytes && !obj.max_chunk_bytes) {
    obj.max_chunk_bytes = chunkBytes;
  }

  const baseId = obj.id || uuidv4();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const reqId = attempt === 1 ? baseId : `${baseId}-r${attempt}`;
    obj.id = reqId;

    try {
      const client = await ensureNknClient();
      console.log(`[NKN][SYN] ${obj.type || obj.event || 'request'} #${reqId} attempt ${attempt}/${maxAttempts}`);
      const response = await runSendWithSpacing(() => new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          chunkAssemblies.delete(reqId);
          pending.delete(reqId);
          reject(new Error('DM reply timeout'));
        }, timeoutMs);
        pending.set(reqId, {
          resolve: (data) => {
            clearTimeout(timer);
            resolve(data);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
          timer
        });
        client.send(dest, JSON.stringify(obj)).catch((err) => {
          clearTimeout(timer);
          pending.delete(reqId);
          reject(err);
        });
      }));
      console.log(`[NKN][ACK] ${obj.type || obj.event || 'response'} #${reqId}`);
      return response;
    } catch (err) {
      console.warn(`[nkn] send error (${err.message || err}) attempt ${attempt}/${maxAttempts}`);
      chunkAssemblies.delete(reqId);
      clearPendingEntry(reqId);
      if (attempt >= maxAttempts) {
        throw err;
      }
      await sleep(backoffDelay * attempt);
      scheduleNknReconnect('send-error');
    }
  }

  throw new Error('All DM attempts exhausted');
}

// ──────────────────────── Elevation Fetching System ────────────────────────
// NOTE: This function requires external dependencies that must be provided by the importing module:
// - currentRegenerationRunId
// - cancelRegeneration
// - baseElevationsReady
// - baseVertexCount
// - subdividedGeometry
// - ensureVertexMetadata
// - updateVertexMarkerColor
// - updateGlobeMesh
// - scheduleTerrainRebuild

async function fetchVertexElevation(vertexIndices, runId) {
  if (DEBUG_DISABLE_ELEVATION_QUEUE) return;
  if (!settings.nknRelay || vertexIndices.length === 0) return;
  if (runId !== currentRegenerationRunId) return;

  try {
    await ensureNknClient();
  } catch (err) {
    console.warn('[nkn] Elevation fetch skipped (client offline)', err);
    if (DEBUG_FAKE_ELEVATIONS) {
      // Apply zero elevations so vertices aren’t stuck pending
      const dedup = Array.from(new Set(vertexIndices));
      queueElevationBatch(dedup.map(idx => ({ idx, height: 0 })));
      if (!baseElevationsReady && dedup.length >= baseVertexCount) {
        setBaseElevationsReady(true);
        scheduleTerrainRebuild('base-ready');
      }
    } else {
      elevationEventBus.emit('fetch:error', { reason: err?.message || 'nkn offline' });
    }
    return;
  }

  const requests = [];
  const ghToEntries = new Map();
  const latLonToEntries = new Map();

  const ghPrec = 9;
  const requestOptions = {
    timeoutMs: 18000,
    maxAttempts: 3,
    backoffMs: NKN_BASE_BACKOFF_MS,
    maxChunkBytes: CHUNK_LIMIT_BYTES
  };

  const resetPending = () => {
    for (const entry of requests) {
      if (entry?.meta) {
        entry.meta.fetching = false;
      }
    }
  };

  const wantingBaseOnly = !baseElevationsReady;
  for (const idx of vertexIndices) {
    if (runId !== currentRegenerationRunId || cancelRegeneration) {
      resetPending();
      return;
    }
    if (wantingBaseOnly && idx >= baseVertexCount) continue;
    const meta = ensureVertexMetadata(idx, elevationCache, settings.elevExag);
    if (!meta) continue;
    if (meta.fetching) continue;
    if (meta.elevation != null) continue;

    meta.fetching = true;

    const lat = meta.lat;
    const lon = meta.lon;
    const geohash = meta.geohash || geohashEncode(lat, lon, ghPrec);
    meta.geohash = geohash;

    requests.push({ idx, meta, lat, lon, geohash });
    if (!ghToEntries.has(geohash)) ghToEntries.set(geohash, []);
    ghToEntries.get(geohash).push({ idx, meta });

    const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    if (!latLonToEntries.has(key)) latLonToEntries.set(key, []);
    latLonToEntries.get(key).push({ idx, meta });
  }

  if (requests.length === 0) return;
  if (DEBUG_FAKE_ELEVATIONS) {
    const dedup = Array.from(new Set(requests.map(r => r.idx)));
    queueElevationBatch(dedup.map(idx => ({ idx, height: 0 })));
    if (!baseElevationsReady && dedup.length >= baseVertexCount) {
      setBaseElevationsReady(true);
      scheduleTerrainRebuild('base-ready');
    }
    return;
  }
  elevationEventBus.emit('fetch:queued', { count: requests.length });

  const buildPayload = (geohashList) => ({
    type: 'elev.query',
    dataset: settings.dataset,
    geohashes: geohashList,
    enc: 'geohash',
    prec: ghPrec
  });

  const chunkedRequests = [];
  let currentChunk = [];
  let currentChunkGeohashes = [];

  const flushChunk = () => {
    if (!currentChunk.length) return;
    chunkedRequests.push({
      entries: currentChunk,
      geohashes: currentChunkGeohashes
    });
    currentChunk = [];
    currentChunkGeohashes = [];
  };

  for (const entry of requests) {
    currentChunk.push(entry);
    currentChunkGeohashes.push(entry.geohash);
    const exceedsCount = currentChunk.length > Math.min(MAX_GEOHASH_PER_DM, MAX_CHUNK_VERTEX_REQUESTS);
    const exceedsBytes = dmByteLength(buildPayload(currentChunkGeohashes)) > DM_BUDGET_BYTES;
    if (exceedsCount || exceedsBytes) {
      if (currentChunk.length === 1) {
        flushChunk();
        continue;
      }
      const overflowEntry = currentChunk.pop();
      const overflowHash = currentChunkGeohashes.pop();
      flushChunk();
      currentChunk.push(overflowEntry);
      currentChunkGeohashes.push(overflowHash);
      const payloadBytes = dmByteLength(buildPayload(currentChunkGeohashes));
      if (payloadBytes > DM_BUDGET_BYTES || currentChunk.length > MAX_CHUNK_VERTEX_REQUESTS) {
        flushChunk();
      }
    }
  }
  flushChunk();

  if (!chunkedRequests.length) return;

  console.groupCollapsed(`📨 Elevation request batch (${chunkedRequests.length} chunk${chunkedRequests.length === 1 ? '' : 's'})`);
  console.log('Relay', settings.nknRelay);
  console.log('Total vertices', requests.length);
  console.log('Chunk sizes', chunkedRequests.map(chunk => chunk.geohashes.length));
  console.groupEnd();

  const queueResult = (entry, height) => {
    if (!Number.isFinite(height)) return;
    const geohash = entry?.geohash || entry?.meta?.geohash;
    let targetIdx = entry.idx;
    if (geohash) {
      const mappedIdx = getVertexIndexForGeohash(geohash);
      if (Number.isInteger(mappedIdx) && mappedIdx >= 0) {
        targetIdx = mappedIdx;
      }
    }
    const targetMeta = ensureVertexMetadata(targetIdx, elevationCache, settings.elevExag);
    if (!targetMeta) return;
    if (Number.isFinite(targetMeta.elevation) && Math.abs(targetMeta.elevation - height) < 1e-3) {
      return;
    }
    queueElevationBatch([{ idx: targetIdx, height, geohash }]);
  };

  let chunkLabel = '';
  try {
    for (let chunkIndex = 0; chunkIndex < chunkedRequests.length; chunkIndex++) {
      if (runId !== currentRegenerationRunId || cancelRegeneration) {
        resetPending();
        return;
      }

      const chunk = chunkedRequests[chunkIndex];
      chunkLabel = `${chunkIndex + 1}/${chunkedRequests.length}`;
      const req = buildPayload(chunk.geohashes);
      const payloadBytes = dmByteLength(req);
      elevationEventBus.emit('fetch:batch', {
        chunkIndex: chunkIndex + 1,
        chunkCount: chunkedRequests.length,
        vertices: chunk.entries.length,
        bytes: payloadBytes
      });

      for (const entry of chunk.entries) {
        const currentPosition = subdividedGeometry.vertices[entry.idx]?.clone();
        if (currentPosition) {
          elevationEventBus.emit('fetch:start', { idx: entry.idx, position: currentPosition });
        }
      }

      console.groupCollapsed(`📨 Elevation request chunk ${chunkLabel}`);
      console.log('Relay', settings.nknRelay);
      console.log('Payload bytes', payloadBytes);
      console.log('Vertices', chunk.entries.map(r => ({ idx: r.idx, lat: r.lat, lon: r.lon, geohash: r.geohash })));
      console.groupEnd();

      const resp = await sendWithReply(settings.nknRelay, req, requestOptions);
      console.log(`📥 Raw elevation response (chunk ${chunkLabel})`, resp);
      if (runId !== currentRegenerationRunId || cancelRegeneration) {
        resetPending();
        return;
      }

      let json = null;
      if (resp.body_b64) {
        json = JSON.parse(atob(resp.body_b64));
      } else if (resp.body) {
        json = (typeof resp.body === 'string') ? JSON.parse(resp.body) : resp.body;
      }
      if (DEBUG_LOG_ELEVATIONS && json?.results) {
        try {
          const table = json.results.map((r) => ({
            geohash: r.geohash || r.hash || r.key || null,
            lat: r.lat ?? r.latitude ?? r?.location?.lat ?? r?.location?.latitude ?? null,
            lon: r.lon ?? r.lng ?? r.longitude ?? r?.location?.lon ?? r?.location?.lng ?? r?.location?.longitude ?? null,
            elevation: r.elevation ?? r.elev ?? r.height ?? r.value ?? r.z ?? r.h ?? r.d ?? r.v ?? null
          }));
          console.table(table);
        } catch (err) {
          console.warn('Failed to log elevations', err);
        }
      }

      let updated = false;
      let responseCount = 0;

      // Build per-chunk lookup maps so each response is matched to the exact requested vertex
      const ghResponseMap = new Map();
      const latLonResponseMap = new Map();
      for (const entry of chunk.entries) {
        if (!entry) continue;
        if (entry.geohash) {
          if (!ghResponseMap.has(entry.geohash)) ghResponseMap.set(entry.geohash, []);
          ghResponseMap.get(entry.geohash).push(entry);
        }
        const key = `${entry.lat.toFixed(6)},${entry.lon.toFixed(6)}`;
        if (!latLonResponseMap.has(key)) latLonResponseMap.set(key, []);
        latLonResponseMap.get(key).push(entry);
      }

      const applyEntryHeight = (entry, height) => {
        if (!entry) return;
        if (runId !== currentRegenerationRunId || cancelRegeneration) return;
        queueResult(entry, height);
        updated = true;
      };

      const applyByGeohash = (gh, height) => {
        if (!gh) return false;
        const list = ghResponseMap.get(gh);
        if (list && list.length) {
          applyEntryHeight(list.shift(), height);
          return true;
        }
        const fallback = ghToEntries.get(gh);
        if (fallback && fallback.length) {
          for (const entry of fallback) applyEntryHeight(entry, height);
          return true;
        }
        return false;
      };

      const applyByLatLon = (lat, lon, height) => {
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
        const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
        const list = latLonResponseMap.get(key);
        if (list && list.length) {
          applyEntryHeight(list.shift(), height);
          return true;
        }
        const fallback = latLonToEntries.get(key);
        if (fallback && fallback.length) {
          for (const entry of fallback) applyEntryHeight(entry, height);
          return true;
        }
        return false;
      };

      const extractHeight = (result) => {
        if (!result) return null;
        const value =
          result.elev ??
          result.elevation ??
          result.height ??
          result.value ??
          result.z ??
          result.h ??
          result.d ??
          result.v;
        if (Number.isFinite(value)) return Number(value);
        return null;
      };

      if (json && Array.isArray(json.results)) {
        responseCount = json.results.length;
        if (runId !== currentRegenerationRunId || cancelRegeneration) {
          resetPending();
          return;
        }

        for (const res of json.results) {
          if (runId !== currentRegenerationRunId || cancelRegeneration) {
            resetPending();
            return;
          }
          const height = extractHeight(res);
          if (!Number.isFinite(height)) continue;

          let matched = false;

          const hashKey = res?.geohash || res?.hash || res?.key;
          if (hashKey) {
            matched = applyByGeohash(hashKey, height);
          }

          const loc = res?.location || res?.loc;
          if (!matched && loc) {
            const lat = Number(loc.lat ?? loc.latitude ?? loc[0]);
            const lon = Number(loc.lon ?? loc.lng ?? loc.longitude ?? loc[1]);
            matched = applyByLatLon(lat, lon, height);
          }

          if (!matched && res?.geohashes && Array.isArray(res.geohashes) && Array.isArray(res.elevations)) {
            for (let i = 0; i < res.geohashes.length; i++) {
              const gh = res.geohashes[i];
              const h = Number(res.elevations[i]);
              if (!Number.isFinite(h)) continue;
              if (applyByGeohash(gh, h)) {
                matched = true;
              }
            }
            matched = true;
          }

          if (!matched && res?.values && Array.isArray(res.values)) {
            const ghList = res.geohashes || res.hashes || res.keys;
            if (Array.isArray(ghList) && ghList.length === res.values.length) {
              for (let i = 0; i < ghList.length; i++) {
                const gh = ghList[i];
                const h = Number(res.values[i]);
                if (!Number.isFinite(h)) continue;
                if (applyByGeohash(gh, h)) {
                  matched = true;
                }
              }
            }
          }

          if (!matched) {
            // Fallback: compute geohash from lat/lon if present
            const lat = Number(res.lat ?? res.latitude);
            const lon = Number(res.lon ?? res.lng ?? res.longitude);
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
              const gh = geohashEncode(lat, lon, ghPrec);
              matched = applyByGeohash(gh, height) || applyByLatLon(lat, lon, height);
            }
          }
        }
      }

      if (!updated && json) {
        const ghList = json.geohashes || json.hashes || json.keys;
        const values = json.elevations || json.heights || json.values;
        if (Array.isArray(ghList) && Array.isArray(values) && ghList.length === values.length) {
          responseCount = ghList.length;
          for (let i = 0; i < ghList.length; i++) {
            const gh = ghList[i];
            const h = Number(values[i]);
            if (!Number.isFinite(h)) continue;
            applyByGeohash(gh, h);
          }
        }

        const samples = json.samples;
        if (Array.isArray(samples)) {
          for (const sample of samples) {
            const height = extractHeight(sample);
            if (!Number.isFinite(height)) continue;
            let handled = false;
            if (sample.geohash) {
              handled = applyByGeohash(sample.geohash, height);
            }
            if (!handled && sample.location) {
              const lat = Number(sample.location.lat ?? sample.location.latitude);
              const lon = Number(sample.location.lon ?? sample.location.lng ?? sample.location.longitude);
              handled = applyByLatLon(lat, lon, height);
            }
          }
        }
      }

      if (Array.isArray(json?.results)) {
        const minLen = Math.min(chunk.entries.length, json.results.length);
        for (let i = 0; i < minLen; i++) {
          const entry = chunk.entries[i];
          if (!entry || !entry.meta) continue;
          if (entry.meta.elevation != null) continue;
          const res = json.results[i];
          const height = extractHeight(res);
          if (!Number.isFinite(height)) continue;
          const lat = Number(res.lat ?? res.latitude);
          const lon = Number(res.lon ?? res.lng ?? res.longitude);
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            const gh = geohashEncode(lat, lon, ghPrec);
            entry.geohash = entry.geohash || gh;
          }
          queueResult(entry, height);
          updated = true;
        }
      }

      if (updated) {
        // mesh update will be triggered by queued elevation processing
      }
      elevationEventBus.emit('dm:success', { chunkLabel, count: responseCount });
      await sleep(SEND_SPACING_MS);
    }
  } catch (err) {
    console.error(`Elevation fetch error (chunk ${chunkLabel || 'n/a'})`, err);
    elevationEventBus.emit('fetch:error', { reason: err?.message || 'unknown' });
    resetPending();
    return;
  }

  for (const { meta } of requests) {
    if (meta && meta.fetching) {
      meta.fetching = false;
    }
  }

  if (!baseElevationsReady) {
    let allReady = true;
    for (let i = 0; i < baseVertexCount; i++) {
      const meta = ensureVertexMetadata(i, elevationCache, settings.elevExag);
      if (!meta || meta.elevation == null) { allReady = false; break; }
    }
    if (allReady) {
      setBaseElevationsReady(true);
      console.log('✅ Base icosahedron elevations loaded');
      scheduleTerrainRebuild('base-ready');
    }
  }
}

// ──────────────────────── Exports ────────────────────────

export { nknClient, nknReady, initNKN, sendWithReply, fetchVertexElevation };
