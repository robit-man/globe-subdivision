// ──────────────────────── Constants ────────────────────────

// Precision fix: Cesium RTE (Relative-To-Eye) approach
// Camera moves in world space, vertex shaders compute positions relative to camera
// Uses emulated double precision (high/low float splits) in GPU
// Achieves sub-meter precision at Earth scale without custom coordinate systems
export const EARTH_RADIUS_M = 6371000; // Earth radius in meters
export const CAMERA_FOV = 65;
// Tighten frustum for better depth precision near the surface
export const CAMERA_NEAR = 0.01; // 0.01m (1cm)
export const CAMERA_FAR = EARTH_RADIUS_M * 4;
export const SURFACE_EYE_HEIGHT = 1.7; // 1.7m eye height
export const ORBIT_START_DISTANCE = EARTH_RADIUS_M * 2.5;
// Base globe detail - reduced for separate patch architecture
// Detail patch will handle high-res terrain in local coordinates
export const ICOS_DETAIL = 3; // Low detail for base globe (was 5)
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

// Walking speed constants (meters/second)
export const WALK_SPEED_BASE = 5;  // 5 m/s
export const WALK_SPEED_SPRINT = 20;  // 20 m/s

// Subdivision timing constants
export const SUBDIVISION_UPDATE_INTERVAL = 100;
export const SUBDIVISION_DISTANCE_THRESHOLD = 50; // 50m threshold
export const VERTEX_HARD_CAP = 30000; // Safety limit regardless of user settings; keeps DM load reasonable

// Worker frame budget constants
export const PATCH_APPLY_BUDGET_MS = 3;
export const MAX_PENDING_WORKER_JOBS = 5;
export const WORKER_SUBDIVISION_SLICE_MS = 8;
export const BASE_PENDING_MAX_DEPTH = 4;
export const BASE_PENDING_MAX_VERTICES = 12000;
export const MOVEMENT_MAX_SPLITS = 300;
export const MOVEMENT_PROPAGATION_DEPTH = 2;

// Debug toggles to isolate undulation sources
export const DEBUG_DISABLE_INITIAL_SUBDIVISION = false;
export const DEBUG_DISABLE_MOVEMENT_REFINEMENT = false;
export const DEBUG_DISABLE_ELEVATION_QUEUE = false;
export const DEBUG_DISABLE_VERTEX_UPDATES = false;
export const DEBUG_SHOW_VERTEX_LABELS = true;
export const DEBUG_MAX_VERTEX_LABELS = 120;
export const DEBUG_LABEL_RADIUS_M = 100; // 100m around player
export const DEBUG_LOG_ELEVATIONS = false; // Log decoded elevation results from relay
export const DEBUG_FAKE_ELEVATIONS = false; // When network is unavailable, apply zero elevations to clear pending state
