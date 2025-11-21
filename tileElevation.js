/**
 * Tile Elevation Integration
 *
 * Fetches elevation data for quadtree tiles over NKN
 * Integrates with existing elevation fetching infrastructure
 */

import { geohashEncode } from './utils.js';
import { sendWithReply } from './router.js';
import { settings } from './settings.js';

const CHUNK_LIMIT_BYTES = 16_000; // Same as router.js
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

    // Estimate size (rough approximation)
    const estimatedSize = JSON.stringify({
      type: 'elev.query',
      dataset: settings.dataset,
      geohashes: currentChunk,
      enc: 'geohash',
      prec: ghPrec
    }).length;

    if (estimatedSize > CHUNK_LIMIT_BYTES * 0.9) {
      chunkedRequests.push([...currentChunk]);
      currentChunk = [];
    }
  }

  if (currentChunk.length > 0) {
    chunkedRequests.push(currentChunk);
  }

  // Fetch elevation data for all chunks
  const elevationMap = {}; // lat,lon -> height

  for (let chunkIndex = 0; chunkIndex < chunkedRequests.length; chunkIndex++) {
    const chunk = chunkedRequests[chunkIndex];

    const payload = {
      type: 'elev.query',
      dataset: settings.dataset,
      geohashes: chunk,
      enc: 'geohash',
      prec: ghPrec
    };

    try {
      const response = await sendWithReply(settings.nknRelay, payload, {
        timeoutMs: 30000,
        maxAttempts: 3
      });

      if (response && response.data) {
        const { data } = response;

        // Process elevation data
        // data format: { geohash: { lat,lon -> height } }
        for (const [geohash, elevData] of Object.entries(data)) {
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
    } catch (err) {
      console.warn(`[tileElevation] Failed to fetch elevation for chunk ${chunkIndex + 1}/${chunkedRequests.length}:`, err.message);
      // Continue with other chunks
    }
  }

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
