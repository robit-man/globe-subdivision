import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  EARTH_RADIUS_M,
  CAMERA_FOV,
  CAMERA_NEAR,
  CAMERA_FAR,
  SURFACE_EYE_HEIGHT,
  ORBIT_START_DISTANCE,
  isSecure,
  isiOS,
  isMobile,
  WALK_SPEED_BASE,
  WALK_SPEED_SPRINT,
  FOCUS_DEBUG,
  WORLD_SCALE
} from './constants.js';
import {
  norm360,
  deltaDeg,
  normPi,
  cartesianToLatLon
} from './utils.js';
import { renderer, scene, raycaster, pointer } from './scene.js';
import {
  gps,
  followGPS,
  setFollowGPS,
  surfacePosition,
  focusedPoint,
  setSurfacePosition,
  setFocusedPoint,
  startGPS
} from './gps.js';
import { dom } from './ui.js';
import { saveOrbitState, saveCameraMode, getCameraSettings } from './persistent.js';
import {
  setFocusedBaseFaceIndex,
  setCancelRegeneration,
  incrementRegenerationRunId,
  focusedFaceBary,
  snapVectorToTerrain,
  getMeshWasUpdated,
  clearMeshWasUpdated
} from './terrain.js';

// ──────────────────────── Camera Initialization ────────────────────────

export const cameraOrbit = new THREE.PerspectiveCamera(CAMERA_FOV, innerWidth/innerHeight, CAMERA_NEAR, CAMERA_FAR);
cameraOrbit.position.set(ORBIT_START_DISTANCE, ORBIT_START_DISTANCE*0.4, ORBIT_START_DISTANCE);
cameraOrbit.lookAt(0,0,0);

export const cameraSurface = new THREE.PerspectiveCamera(CAMERA_FOV, innerWidth/innerHeight, CAMERA_NEAR, CAMERA_FAR);

export let activeCamera = cameraSurface;
export let mode = 'surface';

export let orbitControls = null;

// ──────────────────────── Camera Transition State ────────────────────────
let isTransitioning = false;
let transitionProgress = 0;
const TRANSITION_DURATION = 1.0; // seconds
let transitionStartPos = new THREE.Vector3();
let transitionStartQuat = new THREE.Quaternion();
let transitionEndPos = new THREE.Vector3();
let transitionEndQuat = new THREE.Quaternion();
let transitionTargetMode = null;
const ORBIT_CENTER = new THREE.Vector3(0, 0, 0);
let savedOrbitPosition = new THREE.Vector3();
let savedOrbitTarget = new THREE.Vector3();
let savedOrbitQuaternion = new THREE.Quaternion();

export function initCameras() {
  orbitControls = new OrbitControls(cameraOrbit, renderer.domElement);
  orbitControls.enableDamping = true;
  orbitControls.target.set(0,0,0);
  orbitControls.minDistance = EARTH_RADIUS_M*1.05;
  orbitControls.maxDistance = CAMERA_FAR;
  orbitControls.enabled = false;

  console.log('✅ Cameras initialized: orbit controls ready');
}

export function initInputHandlers() {
  // Keyboard handlers
  window.addEventListener('keydown', (e) => {
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
    if (['KeyW','KeyA','KeyS','KeyD'].includes(e.code)) e.preventDefault();
    keys.add(e.code);
    if (!isMobile && mode === 'surface') {
      hasManualControl = true;
    }
  });

  window.addEventListener('keyup', (e) => {
    keys.delete(e.code);
  });

  // Pointer handlers for surface mode dragging
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (mode === 'surface') {
      isDragging = true;
      renderer.domElement.style.cursor = 'grabbing';
      if (!isMobile) {
        hasManualControl = true;
      }
    }
  });

  renderer.domElement.addEventListener('pointerup', () => {
    isDragging = false;
    renderer.domElement.style.cursor = '';
  });

  renderer.domElement.addEventListener('pointercancel', () => {
    isDragging = false;
    renderer.domElement.style.cursor = '';
  });

  renderer.domElement.addEventListener('pointermove', (e) => {
    if (mode !== 'surface' || !isDragging) return;

    const movementX = e.movementX || 0;
    const movementY = e.movementY || 0;
    const yawSpeed = 0.005;
    const pitchSpeed = 0.004;

    const up = surfacePosition.clone().normalize();

    surfaceForward.applyAxisAngle(up, -movementX * yawSpeed);

    surfacePitch = THREE.MathUtils.clamp(
      surfacePitch - movementY * pitchSpeed,
      THREE.MathUtils.degToRad(-85),
      THREE.MathUtils.degToRad(85)
    );

    updateSurfaceCameraOrientation();
  });

  // Wheel handler for surface mode zoom (scroll to get overhead view)
  renderer.domElement.addEventListener('wheel', (e) => {
    if (mode !== 'surface') return;
    e.preventDefault();

    // Adaptive scroll speed: slower when close, faster when far
    // Speed ranges from 5m to 50m (scaled to world units)
    const normalizedDist = surfaceZoomDistance / MAX_SURFACE_ZOOM; // 0 to 1
    const scrollSpeed = (5 + normalizedDist * 45) * WORLD_SCALE; // 5 to 50 meters (scaled)

    // Update zoom distance
    const delta = e.deltaY > 0 ? scrollSpeed : -scrollSpeed;
    surfaceZoomDistance = THREE.MathUtils.clamp(
      surfaceZoomDistance + delta,
      MIN_SURFACE_ZOOM,
      MAX_SURFACE_ZOOM
    );
  }, { passive: false });

  console.log('✅ Input handlers initialized: keyboard, pointer, and wheel events ready');
}

// ──────────────────────── Resize Handler ────────────────────────

function onResize() {
  const aspect = innerWidth / innerHeight;
  cameraOrbit.aspect = cameraSurface.aspect = aspect;
  cameraOrbit.updateProjectionMatrix();
  cameraSurface.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', onResize);

// ──────────────────────── Orientation System ────────────────────────
const Y_UP = new THREE.Vector3(0,1,0);
const Z_AXIS = new THREE.Vector3(0,0,1);

const qDevice = new THREE.Quaternion();
const qYawOffset = new THREE.Quaternion();
const qLocalToWorld = new THREE.Quaternion();
const qFinal = new THREE.Quaternion();

const eulerYXZ = new THREE.Euler(0,0,0,'YXZ');
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

function setFromDeviceEuler(outQ, alpha, beta, gamma, screenOrientRad) {
  eulerYXZ.set(beta, alpha, -gamma, 'YXZ');
  outQ.setFromEuler(eulerYXZ);
  outQ.multiply(q1);
  const q0 = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, -screenOrientRad);
  outQ.multiply(q0);
  return outQ;
}

function getScreenAngleRad() {
  const angle = (screen.orientation && typeof screen.orientation.angle === 'number')
    ? screen.orientation.angle
    : (window.orientation || 0);
  return angle * Math.PI / 180;
}

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  return (typeof window.orientation === 'number') ? window.orientation : 0;
}

const fwd = new THREE.Vector3();
function yawFromQuaternion(q) {
  fwd.set(0,0,-1).applyQuaternion(q);
  return Math.atan2(-fwd.x, -fwd.z);
}

// ──────────────────────── Sensor State ────────────────────────
let usingSensor = '—';
let haveCompass = false;
let compassDeg = null;
let smoothedCompassDeg = null;
let manualYawOffsetRad = 0;
let initialAligned = false;
let awaitingInitialHeading = false;
let DO = { alpha: null, beta: null, gamma: null };

// ──────────────────────── AbsoluteOrientationSensor ────────────────────────
let absSensor = null;
async function tryStartAbsoluteSensor() {
  if (!('AbsoluteOrientationSensor' in window)) return false;
  try {
    absSensor = new AbsoluteOrientationSensor({ frequency: 60, referenceFrame: 'screen' });
  } catch { return false; }

  return new Promise((resolve) => {
    let started = false;
    absSensor.addEventListener('reading', () => {
      if (!started) {
        started = true;
        usingSensor = 'AbsoluteOrientationSensor';
        resolve(true);
      }
      qDevice.fromArray(absSensor.quaternion);
    });
    absSensor.addEventListener('error', () => resolve(false));
    try { absSensor.start(); } catch { resolve(false); }
  });
}

// ──────────────────────── DeviceOrientation Fallback ────────────────────────
function computeHeadingFromDO(ev) {
  if (typeof ev.webkitCompassHeading === 'number' && !Number.isNaN(ev.webkitCompassHeading)) {
    haveCompass = true;
    return norm360(ev.webkitCompassHeading);
  }
  if (typeof ev.alpha === 'number' && !Number.isNaN(ev.alpha)) {
    let hdg = 360 - ev.alpha;
    hdg += screenAngle();
    haveCompass = true;
    return norm360(hdg);
  }
  return null;
}

let doHandler = null;
function startDeviceOrientation() {
  usingSensor = 'DeviceOrientationEvent';
  doHandler = (ev) => {
    DO.alpha = (typeof ev.alpha === 'number') ? ev.alpha : null;
    DO.beta  = (typeof ev.beta  === 'number') ? ev.beta  : null;
    DO.gamma = (typeof ev.gamma === 'number') ? ev.gamma : null;

    const hdg = computeHeadingFromDO(ev);
    if (hdg != null) compassDeg = hdg;

    const alpha = (ev.alpha ?? 0) * Math.PI/180;
    const beta  = (ev.beta  ?? 0) * Math.PI/180;
    const gamma = (ev.gamma ?? 0) * Math.PI/180;
    setFromDeviceEuler(qDevice, alpha, beta, gamma, getScreenAngleRad());
  };
  const type = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  window.addEventListener(type, doHandler, false);
}

console.log('✅ Orientation system initialized: quaternion and sensor handlers ready');

// ──────────────────────── Permissions ────────────────────────
export async function requestPermissions(updateFocusIndicators) {
  if (!isSecure) return false;

  async function requestIOS() {
    let p1 = 'n/a', p2 = 'n/a';
    try { if (DeviceMotionEvent?.requestPermission) p1 = await DeviceMotionEvent.requestPermission(); } catch {}
    try { if (DeviceOrientationEvent?.requestPermission) p2 = await DeviceOrientationEvent.requestPermission(); } catch {}
    return (p1 === 'granted' || p2 === 'granted');
  }
  async function requestNonIOS() {
    return true;
  }

  const ok = isiOS ? await requestIOS() : await requestNonIOS();
  if (!ok) return false;

  let started = await tryStartAbsoluteSensor();
  if (!started) startDeviceOrientation();

  startGPS(updateFocusIndicators);

  awaitingInitialHeading = true;
  dom.status.textContent = 'Calibrating heading…';

  console.log('✅ Permissions granted, sensors started, GPS started');

  return true;
}

// ──────────────────────── Compass Smoothing ────────────────────────
function updateCompassSmoothing() {
  if (compassDeg == null) return;
  if (smoothedCompassDeg == null) {
    smoothedCompassDeg = compassDeg;
    return;
  }
  const alpha = 0.05;
  const d = deltaDeg(compassDeg, smoothedCompassDeg);
  smoothedCompassDeg = norm360(smoothedCompassDeg + d * alpha);
}

function synthesizeHeadingFromQuat() {
  const up = surfacePosition.clone().normalize();
  const qUp = new THREE.Quaternion().setFromUnitVectors(Y_UP, up);
  const qLocal = qUp.clone().invert().multiply(qDevice);
  const yaw = yawFromQuaternion(qLocal);
  compassDeg = norm360(THREE.MathUtils.radToDeg(yaw));
}

// ──────────────────────── Compass-First Alignment ────────────────────────
function tryInitialAlign() {
  if (initialAligned || smoothedCompassDeg == null) return;

  const up = surfacePosition.clone().normalize();
  const qUp = new THREE.Quaternion().setFromUnitVectors(Y_UP, up);
  const qLocal = qUp.clone().invert().multiply(qDevice);
  const gyYaw = yawFromQuaternion(qLocal);

  const desiredYaw = smoothedCompassDeg * Math.PI/180;
  const err = normPi(desiredYaw - gyYaw);
  manualYawOffsetRad = err;

  initialAligned = true;
}

function maybeHideOverlayAfterAlign() {
  if (awaitingInitialHeading && initialAligned) {
    dom.overlay.classList.remove('show');
    awaitingInitialHeading = false;
    dom.status.textContent = '';
  }
}

// ──────────────────────── Surface Movement State ────────────────────────
const keys = new Set();
let isDragging = false;
let hasManualControl = false;
let surfaceForward = new THREE.Vector3(0, 0, -1);
let surfacePitch = 0;
let walkSpeed = WALK_SPEED_BASE;  // Use scaled constant

// Surface zoom state (scroll to zoom out overhead)
let surfaceZoomDistance = 0; // 0 = on surface
const MIN_SURFACE_ZOOM = 0;
const MAX_SURFACE_ZOOM = 1000 * WORLD_SCALE;  // 1000m max zoom (scaled)

// ──────────────────────── Surface-Aligned Orientation Transform ────────────────────────
function updateSurfaceCameraOrientation() {
  if (!gps.have) return;

  const up = surfacePosition.clone().normalize();

  if (!isMobile && hasManualControl) {
    const tangentForward = surfaceForward.clone().sub(up.clone().multiplyScalar(surfaceForward.dot(up))).normalize();

    const pitchQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3().crossVectors(tangentForward, up).normalize(),
      surfacePitch
    );

    const lookDir = tangentForward.clone().applyQuaternion(pitchQuat);

    cameraSurface.lookAt(cameraSurface.position.clone().add(lookDir));
    cameraSurface.up.copy(up);
  } else {
    qYawOffset.setFromAxisAngle(Y_UP, manualYawOffsetRad);
    qFinal.copy(qDevice).premultiply(qYawOffset);

    qLocalToWorld.setFromUnitVectors(Y_UP, up);

    cameraSurface.quaternion.copy(qFinal).premultiply(qLocalToWorld);
    cameraSurface.up.copy(up);

    surfaceForward.set(0, 0, -1).applyQuaternion(cameraSurface.quaternion).normalize();
  }

  const baseRadius = surfacePosition.length();
  const eyeHeight = SURFACE_EYE_HEIGHT + (gps.alt > 0 ? gps.alt : 0);

  // Base position at eye height
  const basePosition = up.clone().multiplyScalar(baseRadius + eyeHeight);

  // Apply zoom offset: move camera back and up along view direction
  if (surfaceZoomDistance > 0) {
    // Get the camera's look direction (forward vector)
    const lookDir = new THREE.Vector3(0, 0, -1).applyQuaternion(cameraSurface.quaternion);

    // Move camera backward along look direction and upward along surface normal
    // Mix of backward movement (80%) and upward movement (20%) for nice overhead angle
    const backwardOffset = lookDir.clone().multiplyScalar(-surfaceZoomDistance * 0.8);
    const upwardOffset = up.clone().multiplyScalar(surfaceZoomDistance * 0.3);

    cameraSurface.position.copy(basePosition).add(backwardOffset).add(upwardOffset);
  } else {
    cameraSurface.position.copy(basePosition);
  }

  // Conditionally snap ONLY when mesh vertices have been updated with elevation data
  // This prevents undulation from elevation updates while avoiding every-frame snapping
  if (getMeshWasUpdated()) {
    snapVectorToTerrain(surfacePosition);
    clearMeshWasUpdated();
  }
}

// ──────────────────────── Surface Walking ────────────────────────
function updateSurfaceWalking(dt, updateFocusIndicators) {
  if (mode !== 'surface' || !gps.have) return;

  const up = surfacePosition.clone().normalize();

  // Project forward onto tangent plane
  const tangentForward = surfaceForward.clone().sub(up.clone().multiplyScalar(surfaceForward.dot(up))).normalize();
  const right = new THREE.Vector3().crossVectors(tangentForward, up).normalize();

  // Input direction
  const dir = new THREE.Vector3();
  if (keys.has('ArrowUp') || keys.has('KeyW')) dir.sub(tangentForward);
  if (keys.has('ArrowDown') || keys.has('KeyS')) dir.add(tangentForward);
  if (keys.has('ArrowLeft') || keys.has('KeyA')) dir.add(right);
  if (keys.has('ArrowRight') || keys.has('KeyD')) dir.sub(right);

  // Sprint with Shift
  const isSprinting = keys.has('ShiftLeft') || keys.has('ShiftRight');
  walkSpeed = isSprinting ? WALK_SPEED_SPRINT : WALK_SPEED_BASE;

  if (dir.lengthSq() > 0) {
    dir.normalize();
    const distance = walkSpeed * dt;
    const theta = distance / EARTH_RADIUS_M;
    const axis = new THREE.Vector3().crossVectors(dir, up);
    if (axis.lengthSq() > 1e-12) {
      axis.normalize();

      // Rotate position around sphere
      surfacePosition.applyAxisAngle(axis, theta);
      const snapped = snapVectorToTerrain(surfacePosition);
      if (!snapped) {
        surfacePosition.setLength(EARTH_RADIUS_M);
      }

      // Update GPS from new position
      const latLon = cartesianToLatLon(surfacePosition);
      gps.lat = latLon.latDeg;
      gps.lon = latLon.lonDeg;

      // Parallel transport forward direction
      surfaceForward.applyAxisAngle(axis, theta);
      surfaceForward.sub(up.clone().multiplyScalar(surfaceForward.dot(up))).normalize();

      dom.gpsStatus.textContent = `${gps.lat.toFixed(6)}°, ${gps.lon.toFixed(6)}° (walking)`;
      if (followGPS) {
        focusedPoint.copy(surfacePosition);
        updateFocusIndicators(focusedPoint);
      }
    }
  }
}

// ──────────────────────── Click to Place ────────────────────────
export function initClickToPlace(
  globe,
  globeGeometry,
  findClosestBaseFaceIndex,
  updateFocusIndicators,
  updateFocusedFaceBary,
  resetTerrainGeometryToBase,
  scheduleTerrainRebuild,
  forceSubdivisionUpdate,
  wireframeMesh = null
) {
  renderer.domElement.addEventListener('click', (e) => {
    if (mode !== 'orbit') return;

    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    // Apply the same origin offset used in rendering so raycast matches what we see
    const originalScenePos = scene.position.clone();
    const originalCamPos = activeCamera.position.clone();
    const originalTarget = (mode === 'orbit' && orbitControls) ? orbitControls.target.clone() : null;
    const offset = surfacePosition.clone();
    scene.position.set(-offset.x, -offset.y, -offset.z);
    activeCamera.position.copy(originalCamPos).sub(offset);
    if (mode === 'orbit' && orbitControls && originalTarget) {
      orbitControls.target.copy(originalTarget).sub(offset);
      orbitControls.update();
    }
    scene.updateMatrixWorld(true);
    activeCamera.updateMatrixWorld(true);

    raycaster.setFromCamera(pointer, activeCamera);
    // Only raycast against globe mesh, not wireframe (wireframe edges can give inconsistent hit points)
    const targets = [globe];
    const hits = raycaster.intersectObjects(targets, false);

    // Restore transforms
    scene.position.copy(originalScenePos);
    activeCamera.position.copy(originalCamPos);
    if (mode === 'orbit' && orbitControls && originalTarget) {
      orbitControls.target.copy(originalTarget);
      orbitControls.update();
    }
    scene.updateMatrixWorld(true);
    activeCamera.updateMatrixWorld(true);

    if (hits.length) {
      // Hit point is in offset space, convert back to world space
      const hitPointOffset = hits[0].point.clone();
      const p = hitPointOffset.clone().add(offset);

      console.log('🎯 Raycast debug:');
      console.log(`  Offset (surfacePosition): [${offset.x.toFixed(2)}, ${offset.y.toFixed(2)}, ${offset.z.toFixed(2)}]`);
      console.log(`  Hit point (offset space): [${hitPointOffset.x.toFixed(2)}, ${hitPointOffset.y.toFixed(2)}, ${hitPointOffset.z.toFixed(2)}]`);
      console.log(`  Hit point (world space): [${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}]`);

      const snapped = p.length() > 0 ? p.clone() : new THREE.Vector3(1, 0, 0).multiplyScalar(EARTH_RADIUS_M);
      snapVectorToTerrain(snapped);
      console.log(`  After snap: [${snapped.x.toFixed(2)}, ${snapped.y.toFixed(2)}, ${snapped.z.toFixed(2)}]`);

      const latLon = cartesianToLatLon(snapped);
      const latLonText = `${latLon.latDeg.toFixed(6)}°, ${latLon.lonDeg.toFixed(6)}°`;
      console.log(`  Lat/Lon: ${latLonText}`);

      setFollowGPS(false);

      gps.have = true;
      gps.lat = latLon.latDeg;
      gps.lon = latLon.lonDeg;
      gps.alt = snapped.length() - EARTH_RADIUS_M;

      setSurfacePosition(snapped);
      setFocusedPoint(snapped);
      updateFocusIndicators(focusedPoint);
      dom.gpsStatus.textContent = `${latLonText} (manual)`;

      let baseFaceIndex = null;
      const faceIndex = hits[0].faceIndex;
      const faceBaseMap = globeGeometry?.userData?.faceBaseIndex;
      if (faceBaseMap && faceIndex != null && faceIndex < faceBaseMap.length) {
        baseFaceIndex = faceBaseMap[faceIndex];
      }
      if (baseFaceIndex == null) {
        baseFaceIndex = findClosestBaseFaceIndex(surfacePosition);
      }
      setFocusedBaseFaceIndex(baseFaceIndex);
      updateFocusedFaceBary(baseFaceIndex, focusedPoint);

      if (FOCUS_DEBUG) {
        console.log(`🎯 Click registered at: (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)})`);
        console.log(`📍 Base face index: ${baseFaceIndex}, Bary coords: (${focusedFaceBary.x.toFixed(3)}, ${focusedFaceBary.y.toFixed(3)}, ${focusedFaceBary.z.toFixed(3)})`);
      }

      initialAligned = false;
      awaitingInitialHeading = false;
      manualYawOffsetRad = 0;

      setCancelRegeneration(true);
      incrementRegenerationRunId();
      resetTerrainGeometryToBase();

      if (typeof forceSubdivisionUpdate === 'function') {
        forceSubdivisionUpdate();
      }

      scheduleTerrainRebuild('manual-click');
    }
  });

  console.log('✅ Click to place handler initialized');
}

// ──────────────────────── Camera Transition Update ────────────────────────
function updateCameraTransition(dt) {
  if (!isTransitioning) return;

  transitionProgress += dt / TRANSITION_DURATION;

  if (transitionProgress >= 1.0) {
    // Transition complete
    transitionProgress = 1.0;
    isTransitioning = false;

    // Finalize mode switch
    mode = transitionTargetMode;
    dom.mode.textContent = mode;

    if (mode === 'orbit') {
      activeCamera = cameraOrbit;
      orbitControls.enabled = true;
      dom.btnOrbit.classList.add('active');
      dom.btnSurface.classList.remove('active');

      // Restore saved orbit state
      cameraOrbit.position.copy(savedOrbitPosition);
      cameraOrbit.quaternion.copy(savedOrbitQuaternion);
      orbitControls.target.copy(savedOrbitTarget);
      orbitControls.update();

      // Save to persistence
      saveOrbitState(savedOrbitPosition, savedOrbitTarget);
      saveCameraMode('orbit');

      console.log('✅ Camera transition to orbit mode complete');
    } else {
      activeCamera = cameraSurface;
      orbitControls.enabled = false;
      dom.btnOrbit.classList.remove('active');
      dom.btnSurface.classList.add('active');

      // Save to persistence
      saveCameraMode('surface');

      console.log('✅ Camera transition to surface mode complete');
    }
  } else {
    // Smooth interpolation using easeInOutCubic
    const t = transitionProgress < 0.5
      ? 4 * transitionProgress * transitionProgress * transitionProgress
      : 1 - Math.pow(-2 * transitionProgress + 2, 3) / 2;

    // Interpolate position and rotation
    activeCamera.position.lerpVectors(transitionStartPos, transitionEndPos, t);
    activeCamera.quaternion.slerpQuaternions(transitionStartQuat, transitionEndQuat, t);
  }
}

// ──────────────────────── Mode Switching ────────────────────────
export function switchMode(newMode, updateFocusIndicators) {
  if (newMode === mode || isTransitioning) return;

  // Save current orbit camera state before switching away
  if (mode === 'orbit') {
    savedOrbitPosition.copy(cameraOrbit.position);
    savedOrbitQuaternion.copy(cameraOrbit.quaternion);
    savedOrbitTarget.copy(orbitControls.target);
  }

  // Start transition
  isTransitioning = true;
  transitionProgress = 0;
  transitionTargetMode = newMode;

  if (newMode === 'orbit') {
    // Transitioning from surface to orbit
    console.log('🎬 Starting camera transition: surface → orbit');

    // Start from current surface camera position
    transitionStartPos.copy(cameraSurface.position);
    transitionStartQuat.copy(cameraSurface.quaternion);

    // Calculate orbit end position - zoom out to see the surface point
    const distanceFromCenter = EARTH_RADIUS_M * 3; // 3x Earth radius for good overview
    const directionFromCenter = surfacePosition.clone().normalize();
    transitionEndPos.copy(directionFromCenter.multiplyScalar(distanceFromCenter));

    // End quaternion looks at the surface position
    const tempCamera = new THREE.PerspectiveCamera();
    tempCamera.position.copy(transitionEndPos);
    tempCamera.lookAt(ORBIT_CENTER);
    transitionEndQuat.copy(tempCamera.quaternion);

    // Update saved orbit state for when transition completes
    savedOrbitPosition.copy(transitionEndPos);
    savedOrbitTarget.copy(ORBIT_CENTER);
    savedOrbitQuaternion.copy(transitionEndQuat);

    // Use surface camera for transition
    activeCamera = cameraSurface;
    orbitControls.enabled = false;

  } else {
    // Transitioning from orbit to surface
    console.log('🎬 Starting camera transition: orbit → surface');

    // Start from current orbit camera position
    transitionStartPos.copy(cameraOrbit.position);
    transitionStartQuat.copy(cameraOrbit.quaternion);

    // Calculate surface camera end position
    if (!gps.have) {
      // If no GPS, use a default position
      const defaultLat = 0;
      const defaultLon = 0;
      const up = new THREE.Vector3(
        Math.cos(defaultLat * Math.PI / 180) * Math.cos(defaultLon * Math.PI / 180),
        Math.sin(defaultLat * Math.PI / 180),
        Math.cos(defaultLat * Math.PI / 180) * Math.sin(defaultLon * Math.PI / 180)
      );
      const eyeHeight = SURFACE_EYE_HEIGHT;
      transitionEndPos.copy(up.multiplyScalar(EARTH_RADIUS_M + eyeHeight));
    } else {
      const up = surfacePosition.clone().normalize();
      const baseRadius = surfacePosition.length();
      const eyeHeight = SURFACE_EYE_HEIGHT + (gps.alt > 0 ? gps.alt : 0);
      transitionEndPos.copy(up.multiplyScalar(baseRadius + eyeHeight));
    }

    // Calculate end quaternion for surface view
    const up = transitionEndPos.clone().normalize();
    const tempCamera = new THREE.PerspectiveCamera();
    tempCamera.position.copy(transitionEndPos);
    tempCamera.up.copy(up);

    // Look in the direction of surface forward
    const forward = surfaceForward.clone();
    const tangentForward = forward.sub(up.clone().multiplyScalar(forward.dot(up))).normalize();
    const lookTarget = transitionEndPos.clone().add(tangentForward.multiplyScalar(1000));
    tempCamera.lookAt(lookTarget);
    transitionEndQuat.copy(tempCamera.quaternion);

    // Use orbit camera for transition
    activeCamera = cameraOrbit;
    orbitControls.enabled = false;

    // Update focus
    focusedPoint.copy(surfacePosition);
    updateFocusIndicators(focusedPoint);
  }

  // Update UI immediately
  dom.mode.textContent = `${mode} → ${newMode}`;
}

export function initModeButtons(updateFocusIndicators) {
  dom.btnOrbit.addEventListener('click', () => switchMode('orbit', updateFocusIndicators));
  dom.btnSurface.addEventListener('click', () => switchMode('surface', updateFocusIndicators));
  console.log('✅ Mode switching buttons initialized');
}

// ──────────────────────── Recalibrate ────────────────────────
export function initRecalibrate() {
  dom.recalibrate.addEventListener('click', () => {
    if (smoothedCompassDeg == null && compassDeg == null) return;
    const heading = (smoothedCompassDeg != null) ? smoothedCompassDeg : compassDeg;

    const up = surfacePosition.clone().normalize();
    const qUp = new THREE.Quaternion().setFromUnitVectors(Y_UP, up);
    const qLocal = qUp.clone().invert().multiply(qDevice);
    const gyYaw = yawFromQuaternion(qLocal);
    const desiredYaw = heading * Math.PI/180;

    manualYawOffsetRad = normPi(desiredYaw - gyYaw);
  });

  console.log('✅ Recalibrate button initialized');
}

// ──────────────────────── Camera Update Loop ────────────────────────
export function updateCamera(dt, updateFocusIndicators) {
  // Update camera transition if active
  updateCameraTransition(dt);

  // Skip normal camera updates during transition
  if (isTransitioning) {
    return;
  }

  updateCompassSmoothing();
  tryInitialAlign();
  maybeHideOverlayAfterAlign();
  updateSurfaceWalking(dt, updateFocusIndicators);
  updateSurfaceCameraOrientation();

  if (mode === 'orbit') {
    orbitControls.update();
  }
}

export function isSurfaceInteractionActive() {
  if (mode !== 'surface') return false;
  return isDragging || keys.size > 0;
}

// ──────────────────────── Exports ────────────────────────
export function getActiveCamera() {
  return activeCamera;
}

export function getMode() {
  return mode;
}
