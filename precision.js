import * as THREE from 'three';

// ──────────────────────── Double Precision Coordinate Splitting ────────────────────────
// Handles large-scale coordinates (Earth radius ~6.3M meters) with GPU-compatible precision
// At 6.3e6 meters, float32 precision ≈ 0.75m, causing visible jitter
// Solution: Split coordinates into high/low parts to maintain sub-meter precision

/**
 * Split a double-precision Vector3 into high/low parts
 * High part = integer portion, Low part = fractional portion
 */
export function splitVector3ToHighLow(vec) {
  const high = new THREE.Vector3();
  const low = new THREE.Vector3();
  splitComponent(vec.x, high, low, 'x');
  splitComponent(vec.y, high, low, 'y');
  splitComponent(vec.z, high, low, 'z');
  return { high, low };
}

function splitComponent(value, highVec, lowVec, axis) {
  // Split into integer and fractional parts
  const sign = value >= 0 ? 1 : -1;
  const absValue = Math.abs(value);
  const high = sign * Math.floor(absValue);
  const low = value - high;
  highVec[axis] = high;
  lowVec[axis] = low;
}

export function splitCameraPosition(camera) {
  const pos = camera?.position || new THREE.Vector3();
  return splitVector3ToHighLow(pos);
}

export function applyCameraUniforms(material, camPos) {
  if (!material?.userData?.shader) return;
  const shader = material.userData.shader;
  if (!shader.uniforms?.cameraHigh || !shader.uniforms?.cameraLow) return;
  const split = splitVector3ToHighLow(camPos);
  shader.uniforms.cameraHigh.value.copy(split.high);
  shader.uniforms.cameraLow.value.copy(split.low);
}

export function injectCameraRelativeShader(materialOrShader) {
  // If it's a material, set up onBeforeCompile
  if (materialOrShader && materialOrShader.isMaterial) {
    const material = materialOrShader;
    material.onBeforeCompile = (shader) => {
      material.userData.shader = shader;
      injectShaderCode(shader);
    };
    return;
  }

  // Otherwise it's a shader object, inject directly
  injectShaderCode(materialOrShader);
}

function injectShaderCode(shader) {
  if (!shader || !shader.vertexShader) return;
  // Add high/low attributes but don't add camera uniforms
  shader.vertexShader = shader.vertexShader.replace(
    'void main() {',
    `
attribute vec3 positionHigh;
attribute vec3 positionLow;

void main() {
`
  ).replace(
    '#include <begin_vertex>',
    `
// Reconstruct high-precision position from high/low split
// Precision maintained by floating origin (scene.position offset in render loop)
vec3 transformed = positionHigh + positionLow;
`
  );
}

/**
 * Create high/low position attributes for BufferGeometry
 * Input: Float32Array of positions [x,y,z, x,y,z, ...]
 * Output: { positionHigh, positionLow } both Float32Arrays
 */
export function createHighLowPositionAttributes(positions) {
  const count = positions.length / 3;
  const positionHigh = new Float32Array(positions.length);
  const positionLow = new Float32Array(positions.length);

  for (let i = 0; i < count; i++) {
    const idx = i * 3;

    // X component
    const x = positions[idx];
    const xSign = x >= 0 ? 1 : -1;
    const xHigh = xSign * Math.floor(Math.abs(x));
    const xLow = x - xHigh;

    // Y component
    const y = positions[idx + 1];
    const ySign = y >= 0 ? 1 : -1;
    const yHigh = ySign * Math.floor(Math.abs(y));
    const yLow = y - yHigh;

    // Z component
    const z = positions[idx + 2];
    const zSign = z >= 0 ? 1 : -1;
    const zHigh = zSign * Math.floor(Math.abs(z));
    const zLow = z - zHigh;

    positionHigh[idx] = xHigh;
    positionHigh[idx + 1] = yHigh;
    positionHigh[idx + 2] = zHigh;

    positionLow[idx] = xLow;
    positionLow[idx + 1] = yLow;
    positionLow[idx + 2] = zLow;
  }

  return { positionHigh, positionLow };
}

/**
 * Update high/low attributes on existing geometry
 */
export function updateHighLowPositionAttributes(geometry, positions) {
  if (!geometry || !positions) return;

  const { positionHigh, positionLow } = createHighLowPositionAttributes(positions);

  // Update or create attributes
  if (geometry.attributes.positionHigh) {
    geometry.attributes.positionHigh.set(positionHigh);
    geometry.attributes.positionHigh.needsUpdate = true;
  } else {
    geometry.setAttribute('positionHigh', new THREE.BufferAttribute(positionHigh, 3));
  }

  if (geometry.attributes.positionLow) {
    geometry.attributes.positionLow.set(positionLow);
    geometry.attributes.positionLow.needsUpdate = true;
  } else {
    geometry.setAttribute('positionLow', new THREE.BufferAttribute(positionLow, 3));
  }
}

/**
 * Compute optimal render origin (camera-relative origin)
 * Snaps to nearest kilometer to reduce update frequency
 */
export function computeRenderOrigin(position, snapDistance = 1000.0) {
  return new THREE.Vector3(
    Math.round(position.x / snapDistance) * snapDistance,
    Math.round(position.y / snapDistance) * snapDistance,
    Math.round(position.z / snapDistance) * snapDistance
  );
}
