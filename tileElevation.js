/**
 * Tile Elevation Integration
 *
 * Fetches elevation data for quadtree tiles over NKN
 * Integrates with existing elevation fetching infrastructure
 */

import { geohashEncode } from './utils.js';
import { sendWithReply } from './router.js';
import { settings } from './settings.js';

// NKN free tier limits - EXTREMELY conservative
// After base64 + JSON overhead, 1KB raw → ~2KB final message (safe for free tier)
const CHUNK_LIMIT_BYTES = 1_024; // 1KB chunks (final message ~2KB after encoding)
const ELEVATION_TIMEOUT_MS = 15_000; // 15 seconds (matching reference NKN repo)
const ELEVATION_MAX_ATTEMPTS = 2; // Fewer retries to avoid overwhelming free tier
const ELEVATION_EXAGGERATION = 1.0; // Match settings.elevExag

/**
 * Fetch elevation data for a tile's vertices
 * Returns a map of lat/lon keys to elevation heights
 */
export async function fetchTileElevation(tile) {
  if (!tile.latLons || tile.latLons.length === 0) {
    console.warn('[tileElevation] No lat/lon data for tile', tile.getKey());
    return null;
  }

  if (!settings.nknRelay) {
    console.warn('[tileElevation] NKN relay not configured');
    return null;
  }

  const vertexCount = tile.latLons.length / 2;
  const requests = [];
  const ghToLatLons = new Map();

  const ghPrec = 9;

  // Limit how many geohashes per request for free tier NKN
  // Fewer geohashes = smaller requests = more reliable on free tier
  const MAX_GEOHASHES_PER_REQUEST = 20; // VERY conservative limit for free tier

  // Group vertices by geohash
  for (let i = 0; i < vertexCount; i++) {
    const lat = tile.latLons[i * 2];
    const lon = tile.latLons[i * 2 + 1];

    const geohash = geohashEncode(lat, lon, ghPrec);

    if (!ghToLatLons.has(geohash)) {
      ghToLatLons.set(geohash, []);
    }
    ghToLatLons.get(geohash).push({ lat, lon });
  }

  const geohashes = Array.from(ghToLatLons.keys());

  // Chunk requests to stay under byte limit
  const chunkedRequests = [];
  let currentChunk = [];

  for (const gh of geohashes) {
    currentChunk.push(gh);

    // Conservative limits: respect both byte size AND count limit
    const estimatedSize = JSON.stringify({
      type: 'elev.query',
      dataset: settings.dataset,
      geohashes: currentChunk,
      enc: 'geohash',
      prec: ghPrec
    }).length;

    // Chunk if we exceed size OR count limit (whichever comes first)
    if (estimatedSize > CHUNK_LIMIT_BYTES * 0.8 || currentChunk.length >= MAX_GEOHASHES_PER_REQUEST) {
      chunkedRequests.push([...currentChunk]);
      currentChunk = [];
    }
  }

  if (currentChunk.length > 0) {
    chunkedRequests.push(currentChunk);
  }

  // Fetch elevation data for all chunks
  const elevationMap = {}; // lat,lon -> height

  console.log(`[tileElevation] Fetching elevation for tile ${tile.getKey()}: ${chunkedRequests.length} chunk(s), ${vertexCount} vertices total`);

  for (let chunkIndex = 0; chunkIndex < chunkedRequests.length; chunkIndex++) {
    const chunk = chunkedRequests[chunkIndex];
    console.log(`[tileElevation] Chunk ${chunkIndex + 1}/${chunkedRequests.length}: ${chunk.length} geohashes`);

    const payload = {
      type: 'elev.query',
      dataset: settings.dataset,
      geohashes: chunk,
      enc: 'geohash',
      prec: ghPrec
    };

    try {
      const response = await sendWithReply(settings.nknRelay, payload, {
        timeoutMs: ELEVATION_TIMEOUT_MS,
        maxAttempts: ELEVATION_MAX_ATTEMPTS,
        maxChunkBytes: CHUNK_LIMIT_BYTES, // Conservative 4KB chunks for free tier NKN
        backoffMs: 1000 // 1 second backoff between retries
      });

      // Decode response body (same as router.js does)
      let json = null;
      if (response && response.body_b64) {
        try {
          json = JSON.parse(atob(response.body_b64));
        } catch (err) {
          console.warn('[tileElevation] Failed to decode response body:', err);
          continue;
        }
      } else if (response && response.body) {
        json = (typeof response.body === 'string') ? JSON.parse(response.body) : response.body;
      }

      if (json && json.results) {
        // Process OpenTopoData-style response with geohash results
        // Response format: { results: [{ geohash: "...", elevation: 123 }, ...] }
        for (const result of json.results) {
          const geohash = result.geohash;
          const elevation = result.elevation;

          if (!geohash || !Number.isFinite(elevation)) continue;

          const latLons = ghToLatLons.get(geohash) || [];
          for (const { lat, lon } of latLons) {
            const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
            elevationMap[key] = elevation * ELEVATION_EXAGGERATION;
          }
        }
      } else if (json && typeof json === 'object') {
        // Fallback: try to process as raw geohash->elevation map
        for (const [geohash, elevData] of Object.entries(json)) {
          const latLons = ghToLatLons.get(geohash) || [];

          for (const { lat, lon } of latLons) {
            const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;

            // Find matching elevation in response
            // Response may have slightly different precision
            let foundHeight = null;

            if (typeof elevData === 'object') {
              for (const [latLonKey, height] of Object.entries(elevData)) {
                const [respLat, respLon] = latLonKey.split(',').map(Number);

                // Match within tolerance
                if (Math.abs(respLat - lat) < 0.000001 && Math.abs(respLon - lon) < 0.000001) {
                  foundHeight = Number(height) * ELEVATION_EXAGGERATION;
                  break;
                }
              }
            } else if (typeof elevData === 'number') {
              foundHeight = Number(elevData) * ELEVATION_EXAGGERATION;
            }

            if (foundHeight !== null && Number.isFinite(foundHeight)) {
              elevationMap[key] = foundHeight;
            } else {
              elevationMap[key] = 0; // Default to sea level
            }
          }
        }
      }

      if (!json) {
        console.warn('[tileElevation] No valid JSON response received');
      } else {
        const elevCount = Object.keys(elevationMap).length;
        console.log(`[tileElevation] ✓ Chunk ${chunkIndex + 1}/${chunkedRequests.length} complete: ${elevCount} elevations so far`);
      }
    } catch (err) {
      console.warn(`[tileElevation] ✗ Failed to fetch elevation for chunk ${chunkIndex + 1}/${chunkedRequests.length}:`, err.message);
      // Continue with other chunks
    }
  }

  const totalElevations = Object.keys(elevationMap).length;
  console.log(`[tileElevation] ✅ Tile ${tile.getKey()} complete: ${totalElevations}/${vertexCount} elevations fetched`);

  return elevationMap;
}

/**
 * Request tile geometry with elevation data
 * Fetches elevation first, then requests worker to regenerate geometry
 */
export async function requestTileWithElevation(tile, quadtreeManager) {
  if (!tile || !quadtreeManager || !quadtreeManager.worker) {
    console.warn('[tileElevation] Invalid tile or quadtree manager');
    return;
  }

  try {
    // Fetch elevation data
    const elevationData = await fetchTileElevation(tile);

    if (!elevationData) {
      console.warn('[tileElevation] No elevation data returned for tile', tile.getKey());
      return;
    }

    // Request worker to regenerate geometry with elevation
    quadtreeManager.worker.postMessage({
      type: 'tile:request',
      payload: {
        tileKey: tile.getKey(),
        west: tile.west,
        south: tile.south,
        east: tile.east,
        north: tile.north,
        level: tile.level,
        elevationData: elevationData
      }
    });

    // Store the request so we can handle the response
    if (!quadtreeManager.pendingRequests.has(tile.getKey())) {
      quadtreeManager.pendingRequests.set(tile.getKey(), {
        tile,
        callback: null
      });
    }

  } catch (err) {
    console.error('[tileElevation] Failed to fetch elevation for tile', tile.getKey(), err);
  }
}
