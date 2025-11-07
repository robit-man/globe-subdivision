import * as THREE from 'three';
import { EARTH_RADIUS_M } from './constants.js';
import { dom } from './ui.js';

// ──────────────────────── Scene and Renderer ────────────────────────

export let renderer = null;
export let scene = null;

// Raycaster for clicking on globe
export const raycaster = new THREE.Raycaster();
export const pointer = new THREE.Vector2();
export const triangleHelper = new THREE.Triangle();
export const tmpProjected = new THREE.Vector3();
export const tmpBary = new THREE.Vector3();
export const tmpPlane = new THREE.Plane();
export const tmpCenter = new THREE.Vector3();
export const tmpChildCenter = new THREE.Vector3();
export const tmpFocusDir = new THREE.Vector3();
export const tmpFocusEnd = new THREE.Vector3();
export const tmpRayHit = new THREE.Vector3();
export const focusRay = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(1, 0, 0));

// ──────────────────────── Scene Initialization ────────────────────────

export function initScene() {
  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d12);

  // Lighting
  scene.add(new THREE.AmbientLight(0xffffff, 0.3));
  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x101318, 0.5);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 0.7);
  sun.position.set(5, 10, 7).multiplyScalar(EARTH_RADIUS_M * 2);
  scene.add(sun);

  console.log('✅ Scene initialized: renderer, scene, and lighting ready');
}
