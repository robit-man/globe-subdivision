import * as THREE from 'three';
import {
  cartesianToLatLon,
  latLonToCartesian,
  metersPerDegLat,
  metersPerDegLon
} from './utils.js';
import { snapVectorToTerrain } from './terrain.js';
import { WORLD_SCALE, EARTH_RADIUS_M } from './constants.js';

const OVERPASS_URL = 'https://overpass.kumi.systems/api/interpreter';
const FETCH_RADIUS_M = 900 * WORLD_SCALE;
const REFRESH_DISTANCE_M = 250 * WORLD_SCALE;
const MAX_FEATURES = 180;

function haversine(lat1, lon1, lat2, lon2) {
  const R = EARTH_RADIUS_M;
  const dLat = THREE.MathUtils.degToRad(lat2 - lat1);
  const dLon = THREE.MathUtils.degToRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(THREE.MathUtils.degToRad(lat1)) *
      Math.cos(THREE.MathUtils.degToRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function parseHeight(tags = {}) {
  const raw =
    tags.height ||
    tags['building:height'] ||
    tags['roof:height'] ||
    null;
  if (raw) {
    const clean = parseFloat(String(raw).replace(/[^\d.]/g, ''));
    if (Number.isFinite(clean)) return THREE.MathUtils.clamp(clean * WORLD_SCALE, 4 * WORLD_SCALE, 120 * WORLD_SCALE);
  }
  const levels = parseFloat(tags.levels || tags['building:levels']);
  if (Number.isFinite(levels)) return THREE.MathUtils.clamp(levels * 3.4 * WORLD_SCALE, 4 * WORLD_SCALE, 120 * WORLD_SCALE);
  return (8 + Math.random() * 25) * WORLD_SCALE;
}

export class SimpleBuildingManager {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'osm-buildings-lite';
    this.scene.add(this.group);
    this.material = new THREE.MeshBasicMaterial({
      color: 0x000000,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1
    });
    this._lastCenter = null;
    this._inflight = false;
  }

  update(positionVec) {
    if (this._inflight || !positionVec || positionVec.lengthSq() === 0) return;
    const { latDeg, lonDeg } = cartesianToLatLon(positionVec);
    if (this._lastCenter) {
      const dist = haversine(latDeg, lonDeg, this._lastCenter.lat, this._lastCenter.lon);
      if (dist < REFRESH_DISTANCE_M) return;
    }
    this._lastCenter = { lat: latDeg, lon: lonDeg };
    this._fetch(latDeg, lonDeg);
  }

  async _fetch(lat, lon) {
    this._inflight = true;
    try {
      const latRad = THREE.MathUtils.degToRad(lat);
      const dLat = FETCH_RADIUS_M / metersPerDegLat(latRad);
      const dLon = FETCH_RADIUS_M / metersPerDegLon(latRad);
      const minLat = (lat - dLat).toFixed(6);
      const maxLat = (lat + dLat).toFixed(6);
      const minLon = (lon - dLon).toFixed(6);
      const maxLon = (lon + dLon).toFixed(6);
      const query = `
        [out:json][timeout:25];
        (
          way["building"](${minLat},${minLon},${maxLat},${maxLon});
          relation["building"](${minLat},${minLon},${maxLat},${maxLon});
        );
        (._;>;);
        out body;
      `.trim();
      const resp = await fetch(OVERPASS_URL, {
        method: 'POST',
        body: query
      });
      if (!resp.ok) throw new Error(`Overpass ${resp.status}`);
      const json = await resp.json();
      this._applyBuildings(json, lat, lon);
    } catch (err) {
      console.warn('Building fetch failed', err);
    } finally {
      this._inflight = false;
    }
  }

  _applyBuildings(data, lat, lon) {
    const nodes = new Map();
    for (const el of data.elements || []) {
      if (el.type === 'node') nodes.set(el.id, el);
    }
    const meshes = [];
    let processed = 0;
    for (const el of data.elements || []) {
      if (processed >= MAX_FEATURES) break;
      if (el.type !== 'way' || !el.nodes || !el.tags || !el.tags.building) continue;
      const footprint = [];
      for (const nodeId of el.nodes) {
        const node = nodes.get(nodeId);
        if (!node) continue;
        footprint.push([node.lat, node.lon]);
      }
      if (footprint.length < 3) continue;
      const mesh = this._meshingFromFootprint(footprint, el.tags);
      if (mesh) {
        meshes.push(mesh);
        processed++;
      }
    }
    this._replaceMeshes(meshes);
  }

  _meshingFromFootprint(latLonPairs, tags) {
    const center = this._averageLatLon(latLonPairs);
    if (!center) return null;
    const latRad = THREE.MathUtils.degToRad(center.lat);
    const lonRad = THREE.MathUtils.degToRad(center.lon);
    const east = new THREE.Vector3(-Math.sin(lonRad), 0, Math.cos(lonRad)).normalize();
    const upVec = latLonToCartesian(center.lat, center.lon, 0).normalize();
    const north = new THREE.Vector3().crossVectors(upVec, east).normalize();
    const metersLat = metersPerDegLat(latRad);
    const metersLon = metersPerDegLon(latRad);

    const shapePts = [];
    for (const [lat, lon] of latLonPairs) {
      const dx = (lon - center.lon) * metersLon;
      const dy = (lat - center.lat) * metersLat;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
      shapePts.push(new THREE.Vector2(dx, dy));
    }
    if (shapePts.length < 3) return null;
    const shape = new THREE.Shape(shapePts);
    const height = parseHeight(tags);
    const embed = Math.min(2, Math.max(0.5, height * 0.1));
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: height + embed,
      bevelEnabled: false
    });
    geometry.translate(0, 0, -embed);
    const basis = new THREE.Matrix4().makeBasis(east, north, upVec);
    const position = latLonToCartesian(center.lat, center.lon, 0);
    snapVectorToTerrain(position);
    // Push buildings slightly off the terrain to avoid z-fighting/shimmer
    position.add(upVec.clone().multiplyScalar(0.5));
    basis.setPosition(position);
    geometry.applyMatrix4(basis);
    // Add high/low split for building geometry
    const posAttr = geometry.getAttribute('position');
    if (posAttr?.isBufferAttribute) {
      const high = new Float32Array(posAttr.array.length);
      const low = new Float32Array(posAttr.array.length);
      for (let i = 0; i < posAttr.count; i++) {
        const x = posAttr.getX(i);
        const y = posAttr.getY(i);
        const z = posAttr.getZ(i);
        const hx = x >= 0 ? Math.floor(x) : Math.ceil(x);
        const hy = y >= 0 ? Math.floor(y) : Math.ceil(y);
        const hz = z >= 0 ? Math.floor(z) : Math.ceil(z);
        high[i * 3] = hx; high[i * 3 + 1] = hy; high[i * 3 + 2] = hz;
        low[i * 3] = x - hx; low[i * 3 + 1] = y - hy; low[i * 3 + 2] = z - hz;
      }
      geometry.setAttribute('positionHigh', new THREE.BufferAttribute(high, 3));
      geometry.setAttribute('positionLow', new THREE.BufferAttribute(low, 3));
    }
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.name = tags.name || 'building';

    const edges = new THREE.EdgesGeometry(geometry, 15);
    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0x505560,
      transparent: true,
      opacity: 0.45
    });
    const outline = new THREE.LineSegments(edges, lineMaterial);
    outline.name = 'building-outline';
    const group = new THREE.Group();
    group.add(mesh);
    group.add(outline);
    return group;
  }

  _averageLatLon(points) {
    if (!points.length) return null;
    let lat = 0;
    let lon = 0;
    let n = 0;
    for (const pair of points) {
      if (!pair) continue;
      lat += pair[0];
      lon += pair[1];
      n++;
    }
    if (!n) return null;
    return { lat: lat / n, lon: lon / n };
  }

  _replaceMeshes(meshes) {
    while (this.group.children.length) {
      const child = this.group.children.pop();
      this.group.remove(child);
      child.traverse?.((node) => {
        if (node.geometry) node.geometry.dispose();
        if (node.material) {
          if (Array.isArray(node.material)) {
            node.material.forEach(mat => mat.dispose?.());
          } else {
            node.material.dispose?.();
          }
        }
      });
    }
    meshes.forEach(mesh => this.group.add(mesh));
  }
}
