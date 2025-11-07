// ──────────────────────── NKN Client & Elevation Router ────────────────────────

import { DM_BUDGET_BYTES, MAX_GEOHASH_PER_DM } from './constants.js';
import { elevationEventBus, geohashEncode, uuidv4, dmByteLength } from './utils.js';
import { settings } from './settings.js';
import { dom } from './ui.js';
import { getNKNSeed, setNKNAddress, getNKNConfig } from './persistent.js';
import {
  currentRegenerationRunId,
  cancelRegeneration,
  baseElevationsReady,
  baseVertexCount,
  subdividedGeometry,
  ensureVertexMetadata,
  updateVertexMarkerColor,
  scheduleTerrainRebuild,
  runGlobeMeshUpdate,
  setBaseElevationsReady,
  applyElevationToVertex
} from './terrain.js';

// ──────────────────────── NKN Client State ────────────────────────

let nknClient = null;
let nknReady = false;
const pending = new Map();
export const elevationCache = new Map();

// ──────────────────────── NKN Messaging Functions ────────────────────────

function sendWithReply(dest, obj, timeoutMs=25000) {
  if (!nknReady) {
    return Promise.reject(new Error('NKN client not ready'));
  }
  const id = obj.id || uuidv4(); obj.id = id;
  const p = new Promise((resolve, reject)=>{
    const t = setTimeout(()=>{
      pending.delete(id);
      reject(new Error('DM reply timeout'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timeout: t });
  });
  nknClient.send(dest, JSON.stringify(obj)).then(()=>{
    console.log('📤 sent DM', id);
  }).catch(err=>{
    const st = pending.get(id);
    if (st){
      clearTimeout(st.timeout);
      pending.delete(id);
      if (typeof st.reject === 'function') {
        st.reject(err);
      }
    }
    console.error('❌ send error:', err);
  });
  return p;
}

function handleIncoming(src, payload){
  const text = (typeof payload==='string') ? payload : new TextDecoder().decode(payload);
  let msg; try { msg = JSON.parse(text); } catch { return; }
  if (msg && msg.type === 'http.response' && msg.id && pending.has(msg.id)) {
    const st = pending.get(msg.id);
    clearTimeout(st.timeout);
    pending.delete(msg.id);
    if (typeof st.resolve === 'function') {
      st.resolve(msg);
    }
    return;
  }
}

async function initNKN() {
  if (!window.nkn || !nkn.MultiClient) {
    dom.nknStatus.textContent = 'SDK not loaded';
    return;
  }

  console.log('🔌 Initializing NKN client...');
  dom.nknStatus.textContent = 'connecting...';

  try {
    // Get persistent NKN configuration
    const seed = getNKNSeed();
    const config = getNKNConfig();

    // Create client with or without persistent identity
    const clientConfig = {
      numSubClients: config?.numSubClients || 4,
      originalClient: config?.originalClient || false
    };

    // Only add seed if available
    if (seed) {
      clientConfig.seed = seed;
      console.log('🔑 Using persistent NKN seed');
    } else {
      console.log('🔑 Generating new NKN identity (seed will be saved on connect)');
    }

    nknClient = new nkn.MultiClient(clientConfig);

    nknClient.onConnect(() => {
      nknReady = true;
      const address = nknClient.addr;
      setNKNAddress(address);
      dom.nknStatus.textContent = 'connected';
      console.log('✅ NKN connected');
      console.log('📍 NKN address:', address);

      // Save the seed if we didn't have one
      if (!seed && nknClient.seed) {
        // Note: nknClient.seed might not be exposed, this is a fallback
        console.log('💾 NKN seed generated, address saved');
      }
    });

    nknClient.onMessage(({ src, payload }) => handleIncoming(src, payload));
  } catch (err) {
    dom.nknStatus.textContent = 'error';
    console.error('NKN init error:', err);
  }
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
  if (!nknClient || !settings.nknRelay || vertexIndices.length === 0) return;
  if (runId !== currentRegenerationRunId) return;

  const requests = [];
  const ghToEntries = new Map();
  const latLonToEntries = new Map();

  const ghPrec = 9;

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
    const currentPosition = subdividedGeometry.vertices[idx]?.clone();
    if (currentPosition) {
      elevationEventBus.emit('fetch:start', { idx, position: currentPosition });
    }

    if (!ghToEntries.has(geohash)) ghToEntries.set(geohash, []);
    ghToEntries.get(geohash).push({ idx, meta });

    const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    if (!latLonToEntries.has(key)) latLonToEntries.set(key, []);
    latLonToEntries.get(key).push({ idx, meta });
  }

  if (requests.length === 0) return;

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
    const exceedsCount = currentChunk.length > MAX_GEOHASH_PER_DM;
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
      if (dmByteLength(buildPayload(currentChunkGeohashes)) > DM_BUDGET_BYTES) {
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

  const markComplete = (entry, height) => {
    const { idx, meta } = entry;
    if (!meta) return;
    meta.fetching = false;
    if (!Number.isFinite(height)) return;
    meta.elevation = height;
    meta.approxElevation = null;

    applyElevationToVertex(idx, height, settings.elevExag, true);
    elevationCache.set(meta.geohash, { height });
    const appliedPosition = subdividedGeometry.vertices[idx]?.clone();
    if (appliedPosition) {
      elevationEventBus.emit('fetch:applied', { idx, position: appliedPosition });
    }
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

      console.groupCollapsed(`📨 Elevation request chunk ${chunkLabel}`);
      console.log('Relay', settings.nknRelay);
      console.log('Payload bytes', payloadBytes);
      console.log('Vertices', chunk.entries.map(r => ({ idx: r.idx, lat: r.lat, lon: r.lon, geohash: r.geohash })));
      console.groupEnd();

      const resp = await sendWithReply(settings.nknRelay, req, 30000);
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

      let updated = false;

      const applyHeightToEntries = (entries, height) => {
        if (!entries || !entries.length) return;
        for (const entry of entries) {
          if (runId !== currentRegenerationRunId || cancelRegeneration) return;
          markComplete(entry, height);
          updated = true;
        }
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
        console.groupCollapsed('📥 Elevation response results');
        console.log(json.results);
        console.groupEnd();
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
          if (hashKey && ghToEntries.has(hashKey)) {
            applyHeightToEntries(ghToEntries.get(hashKey), height);
            matched = true;
          }

          const loc = res?.location || res?.loc;
          if (!matched && loc) {
            const lat = Number(loc.lat ?? loc.latitude ?? loc[0]);
            const lon = Number(loc.lon ?? loc.lng ?? loc.longitude ?? loc[1]);
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
              const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
              if (latLonToEntries.has(key)) {
                applyHeightToEntries(latLonToEntries.get(key), height);
                matched = true;
              }
            }
          }

          if (!matched && res?.geohashes && Array.isArray(res.geohashes) && Array.isArray(res.elevations)) {
            for (let i = 0; i < res.geohashes.length; i++) {
              const gh = res.geohashes[i];
              const h = Number(res.elevations[i]);
              if (!Number.isFinite(h)) continue;
              applyHeightToEntries(ghToEntries.get(gh), h);
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
                applyHeightToEntries(ghToEntries.get(gh), h);
              }
            }
          }
        }
      }

      if (!updated && json) {
        const ghList = json.geohashes || json.hashes || json.keys;
        const values = json.elevations || json.heights || json.values;
        if (Array.isArray(ghList) && Array.isArray(values) && ghList.length === values.length) {
          for (let i = 0; i < ghList.length; i++) {
            const gh = ghList[i];
            const h = Number(values[i]);
            if (!Number.isFinite(h)) continue;
            applyHeightToEntries(ghToEntries.get(gh), h);
          }
        }

        const samples = json.samples;
        if (Array.isArray(samples)) {
          for (const sample of samples) {
            const height = extractHeight(sample);
            if (!Number.isFinite(height)) continue;
            let handled = false;
            if (sample.geohash && ghToEntries.has(sample.geohash)) {
              applyHeightToEntries(ghToEntries.get(sample.geohash), height);
              handled = true;
            }
            if (!handled && sample.location) {
              const lat = Number(sample.location.lat ?? sample.location.latitude);
              const lon = Number(sample.location.lon ?? sample.location.lng ?? sample.location.longitude);
              if (Number.isFinite(lat) && Number.isFinite(lon)) {
                const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
                applyHeightToEntries(latLonToEntries.get(key), height);
              }
            }
          }
        }
      }

      if (Array.isArray(json?.results)) {
        console.groupCollapsed('📥 Elevation results array');
        console.log(json.results);
        console.groupEnd();
        const minLen = Math.min(chunk.entries.length, json.results.length);
        for (let i = 0; i < minLen; i++) {
          const entry = chunk.entries[i];
          if (!entry || !entry.meta) continue;
          if (entry.meta.elevation != null) continue;
          const res = json.results[i];
          const height = extractHeight(res);
          if (!Number.isFinite(height)) continue;
          markComplete(entry, height);
          updated = true;
        }
      }

      if (updated) {
        runGlobeMeshUpdate();
      }
    }
  } catch (err) {
    console.error(`Elevation fetch error (chunk ${chunkLabel || 'n/a'})`, err);
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
