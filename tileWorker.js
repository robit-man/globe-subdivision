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
function generateTileGeometry(west, south, east, north, level, elevationData = null) {
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
  const latLons = new Float32Array(vertexCount * 2); // Store lat/lon for each vertex

  // Generate grid of vertices
  let vIdx = 0;
  let llIdx = 0;
  for (let row = 0; row <= gridHeight; row++) {
    const v = row / gridHeight; // 0 to 1
    const lat = south + v * (north - south);

    for (let col = 0; col <= gridWidth; col++) {
      const u = col / gridWidth; // 0 to 1
      const lon = west + u * (east - west);

      // Get elevation for this lat/lon if available
      let elevation = 0;
      if (elevationData) {
        const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
        elevation = elevationData[key] ?? 0;
      }

      // Convert to Cartesian with elevation
      const radius = EARTH_RADIUS_M + elevation;
      const x = radius * Math.cos(lat) * Math.cos(lon);
      const y = radius * Math.cos(lat) * Math.sin(lon);
      const z = radius * Math.sin(lat);

      vertices[vIdx++] = x;
      vertices[vIdx++] = y;
      vertices[vIdx++] = z;

      latLons[llIdx++] = lat;
      latLons[llIdx++] = lon;
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

  return { vertices, indices, latLons };
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
  const { tileKey, west, south, east, north, level, elevationData } = payload;

  try {
    // Validate bounds
    if (!Number.isFinite(west) || !Number.isFinite(south) ||
        !Number.isFinite(east) || !Number.isFinite(north)) {
      throw new Error(`Invalid tile bounds: west=${west}, south=${south}, east=${east}, north=${north}`);
    }

    // Check cache (only if no elevation data - don't cache with elevation)
    if (!elevationData && tileCache.has(tileKey)) {
      const cached = tileCache.get(tileKey);
      self.postMessage({
        type: 'tile:geometry',
        payload: {
          tileKey,
          vertices: cached.vertices,
          indices: cached.indices,
          latLons: cached.latLons
        }
      });
      return;
    }

    // Generate geometry
    const { vertices, indices, latLons } = generateTileGeometry(west, south, east, north, level, elevationData);

    // Validate generated geometry
    for (let i = 0; i < vertices.length; i++) {
      if (!Number.isFinite(vertices[i])) {
        throw new Error(`NaN in generated vertices at index ${i} for tile ${tileKey}`);
      }
    }

    // Cache it (only if no elevation data)
    if (!elevationData) {
      tileCache.set(tileKey, { vertices, indices, latLons });
    }

    // Send back to main thread
    self.postMessage({
      type: 'tile:geometry',
      payload: {
        tileKey,
        vertices,
        indices,
        latLons,
        hasElevation: !!elevationData
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
