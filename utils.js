import * as THREE from 'three';
import { EARTH_RADIUS_M } from './constants.js';

// ──────────────────────── Event Bus ────────────────────────

export const elevationEventBus = (() => {
  const listeners = new Map();
  return {
    on(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    off(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    emit(type, payload) {
      listeners.get(type)?.forEach(fn => {
        try { fn(payload); } catch (err) { console.error('Elevation event handler error', err); }
      });
    }
  };
})();

// ──────────────────────── Math Helpers ────────────────────────

export const norm360 = d => (d % 360 + 360) % 360;

export function deltaDeg(a, b) {
  let d = norm360(a) - norm360(b);
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export function normPi(rad) {
  let r = (rad + Math.PI) % (2*Math.PI);
  if (r < 0) r += 2*Math.PI;
  return r - Math.PI;
}

export function latLonToCartesian(latDeg, lonDeg, altMeters = 0) {
  const latRad = THREE.MathUtils.degToRad(latDeg);
  const lonRad = THREE.MathUtils.degToRad(lonDeg);
  const r = EARTH_RADIUS_M + altMeters;
  const x = r * Math.cos(latRad) * Math.cos(lonRad);
  const y = r * Math.sin(latRad); // FIXED: Math.Sin -> Math.sin
  const z = r * Math.cos(latRad) * Math.sin(lonRad);
  return new THREE.Vector3(x, y, z);
}

export function cartesianToLatLon(vec) {
  const r = vec.length();
  const lat = Math.asin(THREE.MathUtils.clamp(vec.y / r, -1, 1));
  const lon = Math.atan2(vec.z, vec.x);
  return {
    latDeg: THREE.MathUtils.radToDeg(lat),
    lonDeg: THREE.MathUtils.radToDeg(lon)
  };
}

export function metersPerDegLat(phiRad){
  return (111132.954 - 559.822*Math.cos(2*phiRad) + 1.175*Math.cos(4*phiRad) - 0.0023*Math.cos(6*phiRad));
}

export function metersPerDegLon(phiRad){
  return (111412.84*Math.cos(phiRad) - 93.5*Math.cos(3*phiRad) + 0.118*Math.cos(5*phiRad));
}

// ──────────────────────── Geohash ────────────────────────

const GH32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function geohashEncode(lat, lon, precision=9){
  let bit=0, even=true, latMin=-90,latMax=90,lonMin=-180,lonMax=180, ch=0, hash='';
  while (hash.length < precision){
    if (even){ const mid=(lonMin+lonMax)/2; if (lon > mid){ ch |= (1<<(4-bit)); lonMin=mid; } else { lonMax=mid; } }
    else { const mid=(latMin+latMax)/2; if (lat > mid){ ch |= (1<<(4-bit)); latMin=mid; } else { latMax=mid; } }
    even=!even;
    if (bit<4){ bit++; } else { hash += GH32[ch]; bit=0; ch=0; }
  }
  return hash;
}

export function pickGeohashPrecision(spacingM){
  if (spacingM >= 1500) return 6;
  if (spacingM >= 300)  return 7;
  if (spacingM >= 60)   return 8;
  if (spacingM >= 10)   return 9;
  return 10;
}

// ──────────────────────── UUID Generator ────────────────────────

export function uuidv4(){
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
    const r = Math.random()*16|0, v = c==='x'?r:(r&0x3|0x8); return v.toString(16);
  });
}

// ──────────────────────── DM Byte Length ────────────────────────

const dmTextEncoder = new TextEncoder();
export const dmByteLength = (obj) => dmTextEncoder.encode(JSON.stringify(obj)).length;
