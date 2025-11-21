import * as THREE from 'three';
import { settings, saveSettings } from './settings.js';
import { VERTEX_HARD_CAP } from './constants.js';

// ──────────────────────── DOM References ────────────────────────

export const dom = {
  canvas: document.getElementById('c'),
  overlay: document.getElementById('overlay'),
  enable: document.getElementById('enable'),
  continue: document.getElementById('continue'),
  status: document.getElementById('status'),
  btnOrbit: document.getElementById('btnOrbit'),
  btnSurface: document.getElementById('btnSurface'),
  recalibrate: document.getElementById('recalibrate'),
  followGPS: document.getElementById('followGPS'),
  mode: document.getElementById('mode'),
  tileCount: document.getElementById('tileCount'),
  vertCount: document.getElementById('vertCount'),
  queueCount: document.getElementById('queueCount'),
  fps: document.getElementById('fps'),
  gpsStatus: document.getElementById('gpsStatus'),
  cameraPos: document.getElementById('cameraPos'),
  nknStatus: document.getElementById('nknStatus'),
  metricsOverlay: document.getElementById('metricsOverlay'),
  metricVertices: document.getElementById('metricVertices'),
  metricBatch: document.getElementById('metricBatch'),
  metricApply: document.getElementById('metricApply'),
  metricQuadtree: document.getElementById('metricQuadtree'),
  gearBtn: document.getElementById('gearBtn'),
  settingsModal: document.getElementById('settingsModal'),
  togglePlanet: document.getElementById('togglePlanet'),
  toggleYarmulke: document.getElementById('toggleYarmulke'),
  nknRelay: document.getElementById('nknRelay'),
  dataset: document.getElementById('dataset'),
  maxRadius: document.getElementById('maxRadius'),
  maxRadiusVal: document.getElementById('maxRadiusVal'),
  fineRadius: document.getElementById('fineRadius'),
  fineRadiusVal: document.getElementById('fineRadiusVal'),
  fineFalloff: document.getElementById('fineFalloff'),
  fineFalloffVal: document.getElementById('fineFalloffVal'),
  minEdge: document.getElementById('minEdge'),
  minEdgeVal: document.getElementById('minEdgeVal'),
  maxEdge: document.getElementById('maxEdge'),
  maxEdgeVal: document.getElementById('maxEdgeVal'),
  sseNear: document.getElementById('sseNear'),
  sseNearVal: document.getElementById('sseNearVal'),
  sseFar: document.getElementById('sseFar'),
  sseFarVal: document.getElementById('sseFarVal'),
  elevExag: document.getElementById('elevExag'),
  elevExagVal: document.getElementById('elevExagVal'),
  maxVerts: document.getElementById('maxVerts'),
  applySettings: document.getElementById('applySettings'),
  closeSettings: document.getElementById('closeSettings')
};

// ──────────────────────── UI Sync ────────────────────────

export function syncSettingsUI() {
  dom.nknRelay.value = settings.nknRelay;
  dom.dataset.value = settings.dataset;
  dom.maxRadius.value = settings.maxRadius;
  dom.maxRadiusVal.textContent = Math.round(settings.maxRadius);
  dom.fineRadius.value = settings.fineDetailRadius;
  dom.fineRadiusVal.textContent = Math.round(settings.fineDetailRadius);
  dom.fineFalloff.value = settings.fineDetailFalloff;
  dom.fineFalloffVal.textContent = Math.round(settings.fineDetailFalloff);
  dom.minEdge.value = settings.minSpacingM;
  dom.minEdgeVal.textContent = Number(settings.minSpacingM.toFixed(2));
  dom.maxEdge.value = settings.maxSpacingM;
  dom.maxEdgeVal.textContent = Math.round(settings.maxSpacingM);
  dom.sseNear.value = settings.sseNearThreshold;
  dom.sseNearVal.textContent = settings.sseNearThreshold.toFixed(1);
  dom.sseFar.value = settings.sseFarThreshold;
  dom.sseFarVal.textContent = settings.sseFarThreshold.toFixed(1);
  dom.elevExag.value = settings.elevExag;
  dom.elevExagVal.textContent = settings.elevExag.toFixed(1);
  dom.maxVerts.value = settings.maxVertices;
}

// ──────────────────────── UI Event Listeners ────────────────────────

export function initUIListeners(resetTerrainGeometryToBase, scheduleTerrainRebuild) {
  dom.maxRadius.addEventListener('input', () => dom.maxRadiusVal.textContent = Math.round(parseFloat(dom.maxRadius.value)));
  dom.fineRadius.addEventListener('input', () => dom.fineRadiusVal.textContent = Math.round(parseFloat(dom.fineRadius.value)));
  dom.fineFalloff.addEventListener('input', () => dom.fineFalloffVal.textContent = Math.round(parseFloat(dom.fineFalloff.value)));
  dom.minEdge.addEventListener('input', () => dom.minEdgeVal.textContent = Number(parseFloat(dom.minEdge.value).toFixed(2)));
  dom.maxEdge.addEventListener('input', () => dom.maxEdgeVal.textContent = Math.round(parseFloat(dom.maxEdge.value)));
  dom.sseNear.addEventListener('input', () => dom.sseNearVal.textContent = parseFloat(dom.sseNear.value).toFixed(1));
  dom.sseFar.addEventListener('input', () => dom.sseFarVal.textContent = parseFloat(dom.sseFar.value).toFixed(1));
  dom.elevExag.addEventListener('input', () => dom.elevExagVal.textContent = parseFloat(dom.elevExag.value).toFixed(1));

  dom.gearBtn.addEventListener('click', () => dom.settingsModal.classList.add('show'));
  dom.closeSettings.addEventListener('click', () => dom.settingsModal.classList.remove('show'));

  dom.applySettings.addEventListener('click', () => {
    settings.nknRelay = dom.nknRelay.value.trim();
    settings.dataset = dom.dataset.value.trim();
    const maxRadiusValue = parseFloat(dom.maxRadius.value);
    settings.maxRadius = Number.isFinite(maxRadiusValue) ? Math.max(1000, maxRadiusValue) : 50000;
    const fineRadiusValue = parseFloat(dom.fineRadius.value);
    settings.fineDetailRadius = Number.isFinite(fineRadiusValue) ? Math.max(0, fineRadiusValue) : 4000;
    const fineFalloffValue = parseFloat(dom.fineFalloff.value);
    settings.fineDetailFalloff = Number.isFinite(fineFalloffValue) ? Math.max(0, fineFalloffValue) : 6000;
    const minEdgeValue = parseFloat(dom.minEdge.value);
    settings.minSpacingM = Number.isFinite(minEdgeValue) ? Math.max(1, minEdgeValue) : 1;
    const maxEdgeValue = parseFloat(dom.maxEdge.value);
    settings.maxSpacingM = Number.isFinite(maxEdgeValue) ? Math.max(settings.minSpacingM, maxEdgeValue) : settings.maxSpacingM;
    const elevValue = parseFloat(dom.elevExag.value);
    settings.elevExag = Number.isFinite(elevValue) ? Math.max(0.1, elevValue) : 1.0;
    const sseNearVal = parseFloat(dom.sseNear.value);
    const sseFarVal = parseFloat(dom.sseFar.value);
    const nearPx = Number.isFinite(sseNearVal) ? THREE.MathUtils.clamp(sseNearVal, 0.5, 20) : 2.0;
    const farPx = Number.isFinite(sseFarVal) ? THREE.MathUtils.clamp(sseFarVal, nearPx, 30) : 8.0;
    settings.sseNearThreshold = nearPx;
    settings.sseFarThreshold = farPx;
    const maxVertsValue = parseInt(dom.maxVerts.value, 10);
    if (Number.isFinite(maxVertsValue)) {
      settings.maxVertices = THREE.MathUtils.clamp(maxVertsValue, 2000, VERTEX_HARD_CAP);
    }
    saveSettings();
    syncSettingsUI();
    dom.settingsModal.classList.remove('show');
    resetTerrainGeometryToBase(true);
    scheduleTerrainRebuild('settings');
    console.log('✅ Settings applied and terrain regeneration scheduled');
  });
}
