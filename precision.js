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
  // DISABLED: With floating origin system, all coordinates are already local (0-1000m)
  // RTE shader is redundant since Three.js already handles small coordinates perfectly
  // The floating origin in precision.js handles coordinate system management
  console.log('📍 Shader injection skipped - using floating origin system instead');
  return;

  // If it's a material, set up onBeforeCompile
  if (materialOrShader && materialOrShader.isMaterial) {
    const material = materialOrShader;
    material.onBeforeCompile = (shader, renderer) => {
      material.userData.shader = shader;
      injectShaderCode(shader);
      material.needsUpdate = true;
    };
    return;
  }

  // Otherwise it's a shader object, inject directly
  injectShaderCode(materialOrShader);
}

function injectShaderCode(shader) {
  if (!shader || !shader.vertexShader) return;

  // Prevent double-injection
  if (shader.uniforms.cameraHigh) {
    console.warn('⚠️ RTE shader already injected, skipping');
    return;
  }

  // Add camera uniforms for RTE (Relative-To-Eye) rendering
  shader.uniforms.cameraHigh = { value: new THREE.Vector3() };
  shader.uniforms.cameraLow = { value: new THREE.Vector3() };

  // Store original shader for debugging
  const originalVertex = shader.vertexShader;

  // Add high/low attributes and RTE calculation at the top
  shader.vertexShader = shader.vertexShader.replace(
    'void main() {',
    `
uniform vec3 cameraHigh;
uniform vec3 cameraLow;
attribute vec3 positionHigh;
attribute vec3 positionLow;

void main() {
  // Cesium RTE: Calculate camera-relative position first
  vec3 rtePosition = (positionHigh - cameraHigh) + (positionLow - cameraLow);
`
  );

  // Replace all uses of 'position' attribute with our RTE position
  // This ensures the entire shader uses camera-relative coordinates
  shader.vertexShader = shader.vertexShader.replace(
    /#include <begin_vertex>/g,
    'vec3 transformed = rtePosition;'
  );

  // CRITICAL FIX: Replace project_vertex to only apply rotation, not translation
  // Since rtePosition is already camera-relative, viewMatrix translation would add back large coords
  shader.vertexShader = shader.vertexShader.replace(
    /#include <project_vertex>/g,
    `
  // Cesium RTE: Apply only rotation from viewMatrix, not translation
  // rtePosition is already relative to camera, so we only need rotation
  vec3 viewPosition = mat3(viewMatrix) * transformed;
  vec4 mvPosition = vec4(viewPosition, 1.0);
  gl_Position = projectionMatrix * mvPosition;
`
  );

  // Debug: Log shader modification and show first compiled shader
  const hasAttribs = shader.vertexShader.includes('positionHigh');
  const hasProjectFix = shader.vertexShader.includes('mat3(viewMatrix)');
  const hasRteCalc = shader.vertexShader.includes('rtePosition');

  console.log('🔧 RTE shader injected | attribs:', hasAttribs,
    '| projectFix:', hasProjectFix, '| rteCalc:', hasRteCalc);

  // Show first shader for debugging
  if (!window._rteShaderLogged) {
    window._rteShaderLogged = true;
    console.log('📋 First RTE Vertex Shader:\n' + shader.vertexShader);
  }
}

/**
 * Create high/low position attributes for BufferGeometry
 * Input: Float32Array of positions [x,y,z, x,y,z, ...]
 * Output: { positionHigh, positionLow } both Float32Arrays
 *
 * DISABLED: With floating origin system, coordinates are already local (0-1000m)
 * High/low splitting is unnecessary - float32 handles 1000m with 0.00012m precision
 */
export function createHighLowPositionAttributes(positions) {
  // Return dummy empty arrays - not used with floating origin system
  return {
    positionHigh: new Float32Array(0),
    positionLow: new Float32Array(0)
  };
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

// ──────────────────────── Render Origin System ────────────────────────
// Cesium approach: All geometry stored in LOCAL coordinates relative to render origin
// Three.js works with small numbers, avoiding float32 precision loss in CPU calculations

export let renderOrigin = new THREE.Vector3(0, 0, 0);
export let renderOriginUpdateThreshold = 500.0; // Update when camera moves 500m from origin

/**
 * Set the global render origin
 */
export function setRenderOrigin(newOrigin) {
  renderOrigin.copy(newOrigin);
  console.log('🎯 Render origin set to:',
    (renderOrigin.length() / 1000).toFixed(1) + 'km',
    renderOrigin.toArray().map(v => (v / 1000).toFixed(2) + 'km'));
}

/**
 * Check if camera has moved far enough to warrant updating render origin
 */
export function shouldUpdateRenderOrigin(cameraWorldPosition) {
  return cameraWorldPosition.distanceTo(renderOrigin) > renderOriginUpdateThreshold;
}

/**
 * Convert world position to local position (relative to render origin)
 */
export function worldToLocal(worldPosition) {
  return new THREE.Vector3().subVectors(worldPosition, renderOrigin);
}

/**
 * Convert local position to world position
 */
export function localToWorld(localPosition) {
  return new THREE.Vector3().addVectors(localPosition, renderOrigin);
}

/**
 * Transform geometry positions from world to local coordinates
 */
export function transformGeometryToLocal(geometry, worldPositions) {
  const localPositions = new Float32Array(worldPositions.length);

  for (let i = 0; i < worldPositions.length; i += 3) {
    localPositions[i] = worldPositions[i] - renderOrigin.x;
    localPositions[i + 1] = worldPositions[i + 1] - renderOrigin.y;
    localPositions[i + 2] = worldPositions[i + 2] - renderOrigin.z;
  }

  return localPositions;
}

/**
 * Update render origin and transform all scene geometry
 * This is called when camera moves too far from current origin
 */
export function updateRenderOriginAndTransformScene(newOrigin, scene, globeGeometry, wireframeGeometry) {
  const delta = new THREE.Vector3().subVectors(newOrigin, renderOrigin);

  console.log('🔄 Updating render origin, delta:',
    (delta.length()).toFixed(1) + 'm');

  // Update origin
  const oldOrigin = renderOrigin.clone();
  setRenderOrigin(newOrigin);

  // Note: Detail patch transformation now handled by caller (app.js)

  // Transform globe geometry
  if (globeGeometry?.attributes?.position) {
    const positions = globeGeometry.attributes.position.array;
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] -= delta.x;
      positions[i + 1] -= delta.y;
      positions[i + 2] -= delta.z;
    }
    globeGeometry.attributes.position.needsUpdate = true;

    // Update high/low attributes
    const { positionHigh, positionLow } = createHighLowPositionAttributes(positions);
    if (globeGeometry.attributes.positionHigh) {
      globeGeometry.attributes.positionHigh.set(positionHigh);
      globeGeometry.attributes.positionHigh.needsUpdate = true;
    }
    if (globeGeometry.attributes.positionLow) {
      globeGeometry.attributes.positionLow.set(positionLow);
      globeGeometry.attributes.positionLow.needsUpdate = true;
    }

    globeGeometry.computeBoundingSphere();
    globeGeometry.computeBoundingBox();
  }

  // Transform wireframe geometry
  if (wireframeGeometry?.attributes?.position) {
    const positions = wireframeGeometry.attributes.position.array;
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] -= delta.x;
      positions[i + 1] -= delta.y;
      positions[i + 2] -= delta.z;
    }
    wireframeGeometry.attributes.position.needsUpdate = true;

    // Update high/low attributes
    const { positionHigh, positionLow } = createHighLowPositionAttributes(positions);
    if (wireframeGeometry.attributes.positionHigh) {
      wireframeGeometry.attributes.positionHigh.set(positionHigh);
      wireframeGeometry.attributes.positionHigh.needsUpdate = true;
    }
    if (wireframeGeometry.attributes.positionLow) {
      wireframeGeometry.attributes.positionLow.set(positionLow);
      wireframeGeometry.attributes.positionLow.needsUpdate = true;
    }

    wireframeGeometry.computeBoundingSphere();
    wireframeGeometry.computeBoundingBox();
  }

  // Transform all other scene objects (buildings, markers, etc.)
  scene.traverse((object) => {
    if (object.geometry && object !== scene) {
      const geom = object.geometry;
      if (geom.attributes?.position) {
        const positions = geom.attributes.position.array;
        for (let i = 0; i < positions.length; i += 3) {
          positions[i] -= delta.x;
          positions[i + 1] -= delta.y;
          positions[i + 2] -= delta.z;
        }
        geom.attributes.position.needsUpdate = true;

        // Update high/low if they exist
        if (geom.attributes.positionHigh && geom.attributes.positionLow) {
          const { positionHigh, positionLow } = createHighLowPositionAttributes(positions);
          geom.attributes.positionHigh.set(positionHigh);
          geom.attributes.positionLow.set(positionLow);
          geom.attributes.positionHigh.needsUpdate = true;
          geom.attributes.positionLow.needsUpdate = true;
        }

        geom.computeBoundingSphere();
        geom.computeBoundingBox();
      }
    }
  });

  return delta;
}
