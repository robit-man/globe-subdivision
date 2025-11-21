/**
 * Tile Worker - Generates geometry for individual terrain tiles
 *
 * Similar to terrainWorker.js but focused on per-tile generation
 * Each tile is subdivided independently in its geographic bounds
 */

const EARTH_RADIUS_M = 6_371_000;

// Worker state
let initialized = false;
const tileCache = new Map(); // Cache generated tiles

/**
 * Generate vertices for a tile using lat/lon grid
 */
function generateTileGeometry(west, south, east, north, level) {
  // Determine grid resolution based on level
  // Level 0: 8x8 grid
  // Level 1: 16x16 grid
  // Level 2+: 32x32 grid
  const baseResolution = level === 0 ? 8 : level === 1 ? 16 : 32;
  const gridWidth = baseResolution;
  const gridHeight = baseResolution;

  const vertexCount = (gridWidth + 1) * (gridHeight + 1);
  const triangleCount = gridWidth * gridHeight * 2;

  const vertices = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(triangleCount * 3);

  // Generate grid of vertices
  let vIdx = 0;
  for (let row = 0; row <= gridHeight; row++) {
    const v = row / gridHeight; // 0 to 1
    const lat = south + v * (north - south);

    for (let col = 0; col <= gridWidth; col++) {
      const u = col / gridWidth; // 0 to 1
      const lon = west + u * (east - west);

      // Convert to Cartesian (no elevation yet)
      const radius = EARTH_RADIUS_M;
      const x = radius * Math.cos(lat) * Math.cos(lon);
      const y = radius * Math.cos(lat) * Math.sin(lon);
      const z = radius * Math.sin(lat);

      vertices[vIdx++] = x;
      vertices[vIdx++] = y;
      vertices[vIdx++] = z;
    }
  }

  // Generate indices (triangles)
  let iIdx = 0;
  for (let row = 0; row < gridHeight; row++) {
    for (let col = 0; col < gridWidth; col++) {
      const topLeft = row * (gridWidth + 1) + col;
      const topRight = topLeft + 1;
      const bottomLeft = (row + 1) * (gridWidth + 1) + col;
      const bottomRight = bottomLeft + 1;

      // Two triangles per quad
      indices[iIdx++] = topLeft;
      indices[iIdx++] = bottomLeft;
      indices[iIdx++] = topRight;

      indices[iIdx++] = topRight;
      indices[iIdx++] = bottomLeft;
      indices[iIdx++] = bottomRight;
    }
  }

  return { vertices, indices };
}

/**
 * Handle incoming messages
 */
self.onmessage = function(event) {
  const { type, payload } = event.data;

  switch (type) {
    case 'init':
      initialized = true;
      self.postMessage({ type: 'ready' });
      break;

    case 'tile:request':
      handleTileRequest(payload);
      break;

    default:
      console.warn('[tileWorker] Unknown message type:', type);
  }
};

/**
 * Handle tile geometry request
 */
function handleTileRequest(payload) {
  const { tileKey, west, south, east, north, level } = payload;

  try {
    // Validate bounds
    if (!Number.isFinite(west) || !Number.isFinite(south) ||
        !Number.isFinite(east) || !Number.isFinite(north)) {
      throw new Error(`Invalid tile bounds: west=${west}, south=${south}, east=${east}, north=${north}`);
    }

    // Check cache
    if (tileCache.has(tileKey)) {
      const cached = tileCache.get(tileKey);
      self.postMessage({
        type: 'tile:geometry',
        payload: {
          tileKey,
          vertices: cached.vertices,
          indices: cached.indices
        }
      });
      return;
    }

    // Generate geometry
    const { vertices, indices } = generateTileGeometry(west, south, east, north, level);

    // Validate generated geometry
    for (let i = 0; i < vertices.length; i++) {
      if (!Number.isFinite(vertices[i])) {
        throw new Error(`NaN in generated vertices at index ${i} for tile ${tileKey}`);
      }
    }

    // Cache it
    tileCache.set(tileKey, { vertices, indices });

    // Send back to main thread
    self.postMessage({
      type: 'tile:geometry',
      payload: {
        tileKey,
        vertices,
        indices
      }
    });

  } catch (error) {
    self.postMessage({
      type: 'error',
      payload: {
        tileKey,
        error: error.message
      }
    });
  }
}

// Notify main thread that worker is ready
self.postMessage({ type: 'ready' });
