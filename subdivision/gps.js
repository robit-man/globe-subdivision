import * as THREE from 'three';
import { EARTH_RADIUS_M, isSecure } from './constants.js';
import { latLonToCartesian, norm360 } from './utils.js';
import { dom } from './ui.js';
import { saveGPSLocation } from './persistent.js';

// ──────────────────────── GPS State ────────────────────────

export let followGPS = true;

export const gps = {
  have: false,
  lat: null,
  lon: null,
  alt: 0,
  acc: null,
  heading: null,
  speed: null
};

export let surfacePosition = new THREE.Vector3(1, 0, 0).multiplyScalar(EARTH_RADIUS_M);
export let focusedPoint = surfacePosition.clone();

// ──────────────────────── GPS Initialization ────────────────────────

let geoWatchId = null;

export function startGPS(updateFocusIndicators) {
  if (!('geolocation' in navigator)) return;
  if (!isSecure) return;
  try {
    geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        gps.have = true;
        gps.lat = c.latitude;
        gps.lon = c.longitude;
        gps.alt = Number.isFinite(c.altitude) ? c.altitude : 0;
        gps.acc = c.accuracy;
        gps.heading = (c.heading != null && !Number.isNaN(c.heading)) ? norm360(c.heading) : gps.heading;
        gps.speed = c.speed;

        // Save GPS location to persistence (throttled updates)
        saveGPSLocation(gps.lat, gps.lon, gps.alt);

        if (followGPS) {
          surfacePosition.copy(latLonToCartesian(gps.lat, gps.lon, gps.alt));
          focusedPoint.copy(surfacePosition);
          updateFocusIndicators(focusedPoint);
        }

        dom.gpsStatus.textContent = `${gps.lat.toFixed(6)}°, ${gps.lon.toFixed(6)}°`;
      },
      (err) => {},
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );
  } catch (err) {}
}

// ──────────────────────── GPS Follow Toggle ────────────────────────

export function initGPSListeners(updateFocusIndicators) {
  dom.followGPS.addEventListener('change', () => {
    followGPS = dom.followGPS.checked;
    if (followGPS) {
      // focusedBaseFaceIndex will be set to null in terrain.js
      focusedPoint.copy(surfacePosition);
      updateFocusIndicators(focusedPoint);
    }
  });
}

// ──────────────────────── GPS State Updates ────────────────────────

export function setFollowGPS(value) {
  followGPS = value;
  dom.followGPS.checked = value;
}

export function setSurfacePosition(pos) {
  surfacePosition.copy(pos);
}

export function setFocusedPoint(pos) {
  focusedPoint.copy(pos);
}
