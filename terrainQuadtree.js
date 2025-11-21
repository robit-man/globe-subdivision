/**
 * Terrain Quadtree Integration
 *
 * Replaces the old single-mesh globe with Cesium-style quadtree tiles
 * All tiles use local coordinates for perfect precision
 */

import { QuadtreeManager } from './quadtree.js';

// Quadtree manager instance
let quadtreeManager = null;
let quadtreeInitialized = false;

/**
 * Initialize the quadtree terrain system
 */
export function initQuadtreeTerrain(scene, options = {}) {
  if (quadtreeManager) {
    console.warn('[terrainQuadtree] Already initialized');
    return quadtreeManager;
  }

  // Create quadtree manager
  quadtreeManager = new QuadtreeManager(scene, {
    sseThreshold: options.sseThreshold ?? 32,
    maxLevel: options.maxLevel ?? 18,
    maxVisibleTiles: options.maxVisibleTiles ?? 300,
    maxTileLoadsPerFrame: options.maxTileLoadsPerFrame ?? 2,
    maxElevationFetchesPerFrame: options.maxElevationFetchesPerFrame ?? 1,
    enableElevation: options.enableElevation ?? true,
    tileUnloadDistance: options.tileUnloadDistance ?? 3
  });

  // Initialize worker
  const workerUrl = new URL('./tileWorker.js', import.meta.url);
  quadtreeManager.initWorker(workerUrl);

  quadtreeInitialized = true;

  console.log('✅ Quadtree terrain system initialized');

  return quadtreeManager;
}

/**
 * Update quadtree - call this every frame
 */
export function updateQuadtree(camera) {
  if (!quadtreeManager) {
    console.warn('[terrainQuadtree] Not initialized');
    return;
  }

  quadtreeManager.update(camera);
}

/**
 * Get quadtree statistics
 */
export function getQuadtreeStats() {
  if (!quadtreeManager) {
    return {
      visibleTiles: 0,
      loadedTiles: 0,
      totalTiles: 0,
      maxLevel: 0
    };
  }

  return quadtreeManager.getStats();
}

/**
 * Find tile at world position
 */
export function findTileAtPosition(position) {
  if (!quadtreeManager) return null;
  return quadtreeManager.findTileAtPosition(position);
}

/**
 * Dispose quadtree
 */
export function disposeQuadtree() {
  if (quadtreeManager) {
    quadtreeManager.dispose();
    quadtreeManager = null;
    quadtreeInitialized = false;
  }
}

/**
 * Check if quadtree is initialized
 */
export function isQuadtreeInitialized() {
  return quadtreeInitialized;
}

/**
 * Get quadtree manager (for advanced usage)
 */
export function getQuadtreeManager() {
  return quadtreeManager;
}
