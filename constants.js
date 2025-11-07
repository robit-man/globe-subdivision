// ──────────────────────── Constants ────────────────────────

export const EARTH_RADIUS_M = 6_371_000;
export const CAMERA_FOV = 65;
export const CAMERA_NEAR = 0.01;
export const CAMERA_FAR = EARTH_RADIUS_M * 100;
export const SURFACE_EYE_HEIGHT = 1.7;
export const ORBIT_START_DISTANCE = EARTH_RADIUS_M * 2.5;
export const ICOS_DETAIL = 5;
export const LON_OFFSET_DEG = -60;
export const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
export const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
export const FOCUS_DEBUG = false;
export const SHOW_FOCUS_MARKER = false;
export const ENABLE_VERTEX_MARKERS = false;
export const MAX_MARKERS = 20000;
export const FOCUS_BARY_EPS = 1e-4;
export const FOCUS_RAY_LENGTH = EARTH_RADIUS_M * 1.15;

// Terrain rebuild scheduling
export const MIN_TERRAIN_REBUILD_INTERVAL_MS = 300;

// NKN message constants
export const DM_BUDGET_BYTES = 2800;
export const MAX_GEOHASH_PER_DM = 800;

// Walking speed constants
export const WALK_SPEED_BASE = 5;
export const WALK_SPEED_SPRINT = 20;

// Subdivision timing constants
export const SUBDIVISION_UPDATE_INTERVAL = 100;
export const SUBDIVISION_DISTANCE_THRESHOLD = 10;
