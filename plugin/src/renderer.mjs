import { compositeOutlines } from './outlines.mjs';
import { sampleAppearanceLocal } from './geometry.mjs';
import { compileWorld } from './world.mjs';
import {add,cross,dot,normal,normalize,point,sub,vector,cameraBasis as canonicalCameraBasis} from './math.mjs';
import { validateScene } from './scene.mjs';

/**
 * ZPixel headless renderer v0.3.6.
 *
 * The renderer deliberately keeps geometry queries in one place. Camera rays,
 * public traceScene calls, and light shadow rays all go through traceNearest,
 * so a surface cannot be visible while being absent from its own shadows.
 * Bound appearance layers are sampled after a physical part hit; they never
 * participate in ray, shadow or outline geometry.
 */
export const RENDERER_VERSION = 'dsh-zpixel/renderer-0.3.6';

const EPSILON = 1e-7;
const SHADOW_EPSILON = 1e-5;
const TIE_EPSILON = 1e-8;
const FAR_CLIP = 1e7;
const SUPPORTED_MODES = new Set(['beauty', 'silhouette', 'depth', 'normals', 'nodes']);
const WHITE = '#ffffff';
const FALLBACK_INK = '#191827';
const FALLBACK_STONE = '#808080';

function fail(message, details) {
  const error = new Error(message);
  if (details !== undefined) error.details = details;
  throw error;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteArray(value, length, label) {
  if (!Array.isArray(value) || value.length !== length || !value.every(isFiniteNumber)) {
    fail(`${label} must be an array of ${length} finite numbers.`);
  }
  return value;
}

function finiteMatrix(value, label = 'matrix') {
  return finiteArray(value, 16, label);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function canonicalHex(value) {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) return null;
  return value.toLowerCase();
}

function rgbFromHex(value) {
  const hex = canonicalHex(value);
  if (!hex) fail(`Expected an opaque #RRGGBB color, got ${String(value)}.`);
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function resolveColorRef(ref, scene, fallback = null) {
  if (ref === null || ref === undefined) return fallback;
  if (typeof ref !== 'string') fail(`Color reference must be a palette ID or #RRGGBB, got ${typeof ref}.`);
  let value = ref;
  const seen = new Set();
  while (!canonicalHex(value)) {
    if (seen.has(value)) fail(`Palette color cycle at ${value}.`);
    seen.add(value);
    const next = scene.palette?.[value];
    if (next === undefined) fail(`Unknown palette color ${value}.`);
    value = next;
  }
  return canonicalHex(value);
}

function colorToBytes(value) {
  const [r, g, b] = rgbFromHex(value);
  return [r, g, b, 255];
}

/**
 * Modulate an opaque color by a scalar brightness. Appearance sampling uses
 * this for lit pixels: the sampled base color is multiplied channel-wise by
 * the target part's ramp-response brightness, then rounded to a byte.
 */
function modulateColor(value, factor) {
  const [r, g, b] = rgbFromHex(value);
  const scale = clamp01(factor);
  return `#${[r, g, b].map(channel => clampByte(channel * scale).toString(16).padStart(2, '0')).join('')}`;
}

function makeColorWriter(rgba, width) {
  return (x, y, bytes) => {
    if (x < 0 || y < 0 || x >= width) return;
    const offset = (y * width + x) * 4;
    rgba[offset] = bytes[0];
    rgba[offset + 1] = bytes[1];
    rgba[offset + 2] = bytes[2];
    rgba[offset + 3] = bytes[3];
  };
}

function readPixels(node) {
  if (!Array.isArray(node.pixels)) return [];
  return node.pixels;
}

function layerPixel(node, x, y) {
  const pixels = readPixels(node);
  if (Array.isArray(pixels[y])) return pixels[y][x] ?? null;
  return pixels[y * node.width + x] ?? null;
}

/**
 * Sample a bound appearance layer after a target part has been hit.
 *
 * The layer is a planar projector, not geometry: the world hit position is
 * transformed into the layer's local frame and only the basis.u/basis.v
 * coordinates are used. The perpendicular coordinate is deliberately ignored,
 * so an orthographic projection through the target may repeat the pattern on
 * opposite or grazing faces. Sampling is nearest-neighbor with the same edge
 * convention as a normal painted layer. A hidden projector, an out-of-extent
 * coordinate, or a null pixel returns null, in which case the caller keeps the
 * target material's ordinary ramp color.
 */
function sampleAppearance(context, hit, appearance) {
  const layer = appearance.entry;
  if (!layer.visible) return null;
  // The model owns the planar projection rule; the renderer only supplies the
  // world hit transformed into the bound layer's local frame. The helper
  // ignores the perpendicular coordinate and uses the existing nearest-pixel
  // edge convention, so this stays one shared sampling definition.
  const sample = sampleAppearanceLocal(layer.node, point(layer.inverse, hit.position));
  if (!sample) return null;
  return {
    layerId: layer.node.id,
    shading: appearance.shading,
    color: resolveColorRef(sample.colorRef, context.scene, FALLBACK_STONE),
    pixel: [sample.pixelX, sample.pixelY],
  };
}

function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area * 0.5;
}

function pointOnSegment2D(p, a, b, epsilon = 1e-8) {
  const ab = [b[0] - a[0], b[1] - a[1]];
  const ap = [p[0] - a[0], p[1] - a[1]];
  const length = Math.hypot(...ab);
  if (length <= epsilon) return Math.hypot(...ap) <= epsilon;
  if (Math.abs(ab[0] * ap[1] - ab[1] * ap[0]) > epsilon * Math.max(1, length)) return false;
  return dot(ap, ab) >= -epsilon && dot([p[0] - b[0], p[1] - b[1]], ab) <= epsilon;
}

/** Concave-safe even-odd test, including boundary pixels/vertices. */
function pointInPolygon2D(p, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if (pointOnSegment2D(p, a, b)) return true;
    const crosses = (a[1] > p[1]) !== (b[1] > p[1]);
    if (crosses) {
      const xAtY = (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0];
      if (p[0] < xAtY) inside = !inside;
    }
  }
  return inside;
}

function choosePositiveRoot(roots, epsilon = EPSILON) {
  let best = Infinity;
  for (const root of roots) if (root >= epsilon && root < best) best = root;
  return Number.isFinite(best) ? best : null;
}

function intersectBox(geometry, origin, direction) {
  const min = finiteArray(geometry.min, 3, 'box.min');
  const max = finiteArray(geometry.max, 3, 'box.max');
  if (min.some((v, i) => v > max[i])) fail('Box min must not exceed max.');

  let near = -Infinity;
  let far = Infinity;
  let nearNormal = [0, 0, 0];
  let farNormal = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const o = origin[axis];
    const d = direction[axis];
    if (Math.abs(d) <= EPSILON) {
      if (o < min[axis] - EPSILON || o > max[axis] + EPSILON) return null;
      continue;
    }
    const invD = 1 / d;
    let t1 = (min[axis] - o) * invD;
    let t2 = (max[axis] - o) * invD;
    let n1 = [0, 0, 0];
    let n2 = [0, 0, 0];
    n1[axis] = -1;
    n2[axis] = 1;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      [n1, n2] = [n2, n1];
    }
    if (t1 > near) {
      near = t1;
      nearNormal = n1;
    }
    if (t2 < far) {
      far = t2;
      farNormal = n2;
    }
    if (near > far + EPSILON) return null;
  }
  if (far < EPSILON) return null;
  if (near >= EPSILON) return { t: near, normal: nearNormal };
  return { t: far, normal: farNormal };
}

function intersectEllipsoid(geometry, origin, direction) {
  const center = finiteArray(geometry.center, 3, 'ellipsoid.center');
  const radii = finiteArray(geometry.radii, 3, 'ellipsoid.radii');
  if (radii.some(v => v <= 0)) fail('Ellipsoid radii must be positive.');
  const q = sub(origin, center);
  const scaledOrigin = q.map((v, i) => v / radii[i]);
  const scaledDirection = direction.map((v, i) => v / radii[i]);
  const a = dot(scaledDirection, scaledDirection);
  if (!(a > 0)) return null;
  // Closest-approach form avoids subtracting O(distance^2) quantities.
  const middle = -dot(scaledOrigin, scaledDirection) / a;
  const closest = add(scaledOrigin, scaledDirection.map(v => v * middle));
  const remainder = 1 - dot(closest, closest);
  if (remainder < 0) return null;
  const halfChord = Math.sqrt(remainder / a);
  const t = choosePositiveRoot([middle - halfChord, middle + halfChord]);
  if (t === null) return null;
  const hit = add(origin, direction.map(v => v * t));
  const normalLocal = [
    (hit[0] - center[0]) / (radii[0] * radii[0]),
    (hit[1] - center[1]) / (radii[1] * radii[1]),
    (hit[2] - center[2]) / (radii[2] * radii[2]),
  ];
  return { t, normal: normalize(normalLocal) };
}

function intersectCylinder(geometry, origin, direction) {
  const center = finiteArray(geometry.center, 3, 'cylinder.center');
  const radius = geometry.radius;
  const height = geometry.height;
  if (!isFiniteNumber(radius) || radius <= 0) fail('Cylinder radius must be positive.');
  if (!isFiniteNumber(height) || height <= 0) fail('Cylinder height must be positive.');
  const zMin = center[2] - height * 0.5;
  const zMax = center[2] + height * 0.5;
  const candidates = [];
  const ox = origin[0] - center[0];
  const oy = origin[1] - center[1];
  const a = direction[0] * direction[0] + direction[1] * direction[1];
  if (a > 0) {
    const middle = -(ox * direction[0] + oy * direction[1]) / a;
    const qx = ox + direction[0] * middle;
    const qy = oy + direction[1] * middle;
    const remainder = radius * radius - qx * qx - qy * qy;
    if (remainder >= 0) {
      const halfChord = Math.sqrt(remainder / a);
      for (const t of [middle - halfChord, middle + halfChord]) {
        if (t < EPSILON) continue;
        const z = origin[2] + direction[2] * t;
        if (z >= zMin - EPSILON && z <= zMax + EPSILON) {
          const p = add(origin, direction.map(v => v * t));
          candidates.push({ t, normal: normalize([p[0] - center[0], p[1] - center[1], 0]) });
        }
      }
    }
  }
  if (Math.abs(direction[2]) > EPSILON) {
    for (const [z, nz] of [[zMin, -1], [zMax, 1]]) {
      const t = (z - origin[2]) / direction[2];
      if (t < EPSILON) continue;
      const x = origin[0] + direction[0] * t - center[0];
      const y = origin[1] + direction[1] * t - center[1];
      if (x * x + y * y <= radius * radius + EPSILON) candidates.push({ t, normal: [0, 0, nz] });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, bHit) => a.t - bHit.t);
  return candidates[0];
}

function intersectExtrude(geometry, origin, direction) {
  if (!Array.isArray(geometry.points) || geometry.points.length < 3) fail('Extrude needs at least three points.');
  const points = geometry.points.map((p, i) => finiteArray(p, 2, `extrude.points[${i}]`));
  const z = finiteArray(geometry.z, 2, 'extrude.z');
  if (z[0] > z[1]) fail('Extrude z[0] must not exceed z[1].');
  const candidates = [];
  if (Math.abs(direction[2]) > EPSILON) {
    for (const [planeZ, nz] of [[z[0], -1], [z[1], 1]]) {
      const t = (planeZ - origin[2]) / direction[2];
      if (t < EPSILON) continue;
      const p = add(origin, direction.map(v => v * t));
      if (pointInPolygon2D([p[0], p[1]], points)) candidates.push({ t, normal: [0, 0, nz] });
    }
  }
  const orientation = signedArea(points) >= 0 ? 1 : -1;
  const ray2 = [direction[0], direction[1]];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const edge = [b[0] - a[0], b[1] - a[1]];
    const denominator = ray2[0] * edge[1] - ray2[1] * edge[0];
    if (Math.abs(denominator) <= EPSILON) continue;
    const ao = [a[0] - origin[0], a[1] - origin[1]];
    const t = (ao[0] * edge[1] - ao[1] * edge[0]) / denominator;
    const u = (ao[0] * ray2[1] - ao[1] * ray2[0]) / denominator;
    if (t < EPSILON || u < -EPSILON || u > 1 + EPSILON) continue;
    const localZ = origin[2] + direction[2] * t;
    if (localZ < z[0] - EPSILON || localZ > z[1] + EPSILON) continue;
    const sideNormal = orientation > 0
      ? normalize([edge[1], -edge[0], 0])
      : normalize([-edge[1], edge[0], 0]);
    candidates.push({ t, normal: sideNormal });
  }
  if (!candidates.length) return null;
  candidates.sort((a, bHit) => a.t - bHit.t);
  return candidates[0];
}

function cameraBasis(scene) {
  return canonicalCameraBasis(scene);
}

function validateSceneShape(scene) {
  if (!scene || typeof scene !== 'object') fail('Scene must be an object.');
  if (scene.format !== undefined && scene.format !== 'dsh-zpixel/1') fail(`Unsupported scene format ${scene.format}.`);
  if (!Number.isInteger(scene.width) || !Number.isInteger(scene.height) || scene.width < 1 || scene.height < 1 || scene.width > 256 || scene.height > 256) {
    fail('Scene width and height must be integers from 1 to 256.');
  }
  if (!Array.isArray(scene.nodes) || scene.nodes.length > 256) fail('Scene nodes must be an array with at most 256 nodes.');
  const ids = new Set();
  for (const node of scene.nodes) {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string' || !node.id) fail('Every scene node needs a stable nonempty string id.');
    if (ids.has(node.id)) fail(`Duplicate scene node id ${node.id}.`);
    ids.add(node.id);
    if (node.parent !== null && node.parent !== undefined && typeof node.parent !== 'string') fail(`Node ${node.id} has an invalid parent.`);
    const transform = node.transform ?? {};
    if (transform.matrix !== undefined) finiteMatrix(transform.matrix, `${node.id}.transform.matrix`);
    else {
      finiteArray(transform.position ?? [0, 0, 0], 3, `${node.id}.transform.position`);
      finiteArray(transform.rotation ?? [0, 0, 0], 3, `${node.id}.transform.rotation`);
      finiteArray(transform.scale ?? [1, 1, 1], 3, `${node.id}.transform.scale`);
      finiteArray(transform.pivot ?? [0, 0, 0], 3, `${node.id}.transform.pivot`);
      if ((transform.scale ?? [1, 1, 1]).some(v => Math.abs(v) <= EPSILON)) fail(`Node ${node.id} has a singular transform scale.`);
    }
  }
  const nodeMap = new Map(scene.nodes.map(node => [node.id, node]));
  for (const node of scene.nodes) {
    if (node.parent !== null && node.parent !== undefined && !nodeMap.has(node.parent)) fail(`Node ${node.id} references unknown parent ${node.parent}.`);
  }
  const visiting = new Set();
  const checked = new Set();
  const visit = id => {
    if (checked.has(id)) return;
    if (visiting.has(id)) fail(`Scene graph cycle at ${id}.`);
    visiting.add(id);
    const node = nodeMap.get(id);
    if (node.parent !== null && node.parent !== undefined) visit(node.parent);
    visiting.delete(id);
    checked.add(id);
  };
  for (const node of scene.nodes) visit(node.id);
  if (scene.palette !== undefined && (typeof scene.palette !== 'object' || Array.isArray(scene.palette))) fail('scene.palette must be an object.');
  if (scene.lights !== undefined && (!Array.isArray(scene.lights) || scene.lights.length > 8)) fail('scene.lights must contain at most eight lights.');
}

function mergeOutline(base, value) {
  const result = { ...base };
  if (value === false) {
    result.enabled = false;
    return result;
  }
  if (value && typeof value === 'object') {
    for (const key of ['enabled', 'color', 'direction', 'group', 'width', 'occlusion']) if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
}

function prepareNodes(scene, compiled, camera) {
  const nodeMap=compiled.nodes;
  const prepared = [];
  const cache = new Map();
  const prepare = id => {
    if (cache.has(id)) return cache.get(id);
    const node = nodeMap.get(id);
    const parent = node.parent === null || node.parent === undefined ? null : prepare(node.parent);
    const worldEntry=compiled.entries.get(id),visible=worldEntry.visible;
    // A bound appearance layer is never a physical surface: force it out of
    // ray/shadow/outline participation even if a world compiler still exposes
    // an instance for it. Its transform and inverse remain the projector frame.
    const appearanceBound = node.kind === 'layer' && node.appearanceOf !== undefined && node.appearanceOf !== null;
    const inheritedMaterial = node.material !== undefined ? node.material : (parent?.materialRef ?? undefined);
    let materialRef = inheritedMaterial;
    let material = materialRef && typeof materialRef === 'object' ? materialRef : (materialRef ? scene.materials?.[materialRef] : undefined);
    if (node.kind === 'part' && (materialRef === undefined || materialRef === null)) {
      if (scene.materials?.stone !== undefined) {
        materialRef = 'stone';
        material = scene.materials.stone;
      } else {
        const firstMaterial = Object.keys(scene.materials ?? {})[0];
        if (firstMaterial) {
          materialRef = firstMaterial;
          material = scene.materials[firstMaterial];
        }
      }
    }
    if (materialRef !== undefined && material === undefined && typeof materialRef !== 'object') fail(`Node ${id} references unknown material ${materialRef}.`);
    let outline = mergeOutline(parent?.outline ?? {
      enabled: true,
      color: 'ink',
      direction: 'inside',
      group: 'root',
      width: 1,
      occlusion: true,
    }, node.outline);
    if (node.kind === 'layer' && node.outline === undefined) outline.enabled = false;
    const inheritedCastShadow = parent?.castShadowExplicit;
    const castShadow = node.castShadow !== undefined
      ? Boolean(node.castShadow)
      : inheritedCastShadow !== undefined
        ? inheritedCastShadow
        : (node.kind === 'layer' ? false : node.kind === 'part');
    const entry = {
      node,
      id,
      parent,
      visible,
      materialRef: materialRef ?? null,
      material: material ?? null,
      outline,
      castShadow,
      world: worldEntry.transform,
      inverse: worldEntry.inverse,
      geometryInstance: appearanceBound ? null : worldEntry.instance,
      renderable: !appearanceBound && worldEntry.instance!==null,
      appearanceBound,
      camera,
      castShadowExplicit: node.castShadow !== undefined
        ? Boolean(node.castShadow)
        : parent?.castShadowExplicit,
    };
    if (appearanceBound) {
      // validateScene has already checked the owner kind, direct parent,
      // uniqueness and shading value. Resolve the default here so the renderer
      // and report both see "lit" when appearanceShading was omitted.
      parent.appearance = { entry, shading: node.appearanceShading ?? 'lit' };
    }
    cache.set(id, entry);
    return entry;
  };
  for (const node of scene.nodes) prepared.push(prepare(node.id));
  return prepared;
}

function makeContext(scene) {
  validateScene(scene);
  let compiled;
  try { compiled=compileWorld(scene); }
  catch(error){fail(`Unable to compile scene geometry: ${error.message}`);}
  const camera=cameraBasis(scene);
  const prepared=prepareNodes(scene,compiled,camera);
  const warnings = [];
  const lights = (scene.lights ?? []).map((light, index) => {
    if (!light || typeof light !== 'object') fail(`Light ${index} must be an object.`);
    const color = light.color === undefined ? WHITE : canonicalHex(light.color);
    if (color !== WHITE) fail(`Only white light colors are supported; light ${light.id ?? index} is ${String(light.color)}.`);
    const intensity = light.intensity ?? 1;
    if (!isFiniteNumber(intensity) || intensity < 0) fail(`Light ${light.id ?? index} intensity must be nonnegative.`);
    if (light.type !== 'point' && light.type !== 'directional') fail(`Unsupported light type ${light.type}.`);
    if (light.type === 'point') {
      finiteArray(light.position, 3, `light[${index}].position`);
      const range = light.range ?? 0;
      if (!isFiniteNumber(range) || range < 0) fail(`Light ${light.id ?? index} range must be nonnegative.`);
      return { ...light, color: WHITE, intensity, range, position: [...light.position] };
    }
    finiteArray(light.direction, 3, `light[${index}].direction`);
    if (Math.hypot(...light.direction) <= EPSILON) fail(`Directional light ${light.id ?? index} needs a nonzero direction.`);
    return { ...light, color: WHITE, intensity, direction: normalize(light.direction) };
  });
  const ambient = scene.ambient ?? 0.25;
  const exposure = scene.exposure ?? 1;
  if (!isFiniteNumber(ambient) || ambient < 0) fail('scene.ambient must be nonnegative.');
  if (!isFiniteNumber(exposure) || exposure < 0) fail('scene.exposure must be nonnegative.');
  return {
    scene,
    compiled,
    camera,
    prepared,
    lights,
    ambient,
    exposure,
    warnings,
    stats: {
      rays: 0,
      surfaceTests: 0,
      hits: 0,
      shadowRays: 0,
      shadows: 0,
      outlined: 0,
      geometryCount: prepared.filter(entry => entry.renderable).length,
      visibleGeometryCount: prepared.filter(entry => entry.renderable && entry.visible).length,
    },
  };
}

function intersectLayer(node, origin, direction, camera) {
  const width = node.width;
  const height = node.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 256 || height > 256) fail(`Layer ${node.id} dimensions must be integers from 1 to 256.`);
  const pixelSize = node.pixelSize ?? 1;
  if (!isFiniteNumber(pixelSize) || pixelSize <= 0) fail(`Layer ${node.id} pixelSize must be positive.`);
  const plane = node.plane ?? 'xy';
  if (!['xy', 'xz', 'yz', 'view'].includes(plane)) fail(`Unsupported layer plane ${plane}.`);
  let basisU;
  let basisV;
  let planeNormal;
  if (plane === 'xy') {
    basisU = [1, 0, 0];
    basisV = [0, 1, 0];
    planeNormal = [0, 0, 1];
  } else if (plane === 'xz') {
    basisU = [1, 0, 0];
    basisV = [0, 0, -1];
    planeNormal = [0, 1, 0];
  } else if (plane === 'yz') {
    basisU = [0, 1, 0];
    basisV = [0, 0, -1];
    planeNormal = [-1, 0, 0];
  } else {
    basisU = camera.right;
    basisV = camera.down;
    planeNormal = normalize(cross(basisU, basisV));
  }
  const denominator = dot(planeNormal, direction);
  if (Math.abs(denominator) <= EPSILON) return null;
  const t = -dot(planeNormal, origin) / denominator;
  if (t < EPSILON) return null;
  const q = add(origin, direction.map(v => v * t));
  const uu = dot(basisU, basisU);
  const vv = dot(basisV, basisV);
  const u = dot(q, basisU) / uu / pixelSize;
  const v = dot(q, basisV) / vv / pixelSize;
  if (u < -EPSILON || v < -EPSILON || u >= width - EPSILON || v >= height - EPSILON) return null;
  const pixelX = Math.min(width - 1, Math.max(0, Math.floor(u + EPSILON)));
  const pixelY = Math.min(height - 1, Math.max(0, Math.floor(v + EPSILON)));
  const colorRef = layerPixel(node, pixelX, pixelY);
  if (colorRef === null || colorRef === undefined) return null;
  return { t, normal: planeNormal, colorRef, pixelX, pixelY, surfaceKey: `${node.id}:${pixelX},${pixelY}` };
}

function intersectPrepared(entry, origin, direction) {
  if (!entry.visible || !entry.renderable) return null;
  const result=entry.geometryInstance.ray(origin,direction);
  if(result)result.surfaceKey=entry.id;
  return result;
}

function emptyHit(entry, origin, direction, candidate, color, shadeIndex = 0, shadowBy = []) {
  const worldPosition = add(origin, direction.map(v => v * candidate.t));
  const worldNormal = normalize(normal(entry.inverse, candidate.normal));
  return {
    nodeId: entry.id,
    materialId: entry.materialRef,
    position: worldPosition,
    normal: worldNormal,
    depth: candidate.t,
    shadeIndex,
    color,
    shadowBy: [...shadowBy],
    outlineReason: 'none',
    surfaceKey: candidate.surfaceKey ?? entry.id,
    _entry: entry,
    _candidate: candidate,
  };
}

function traceNearest(context, origin, direction, { shadowOnly = false, maxDistance = Infinity, pixelIndex } = {}) {
  let best = null;
  for (const entry of context.prepared) {
    if (!entry.visible || !entry.renderable || (shadowOnly && !entry.castShadow)) continue;
    context.stats.surfaceTests++;
    const candidate = intersectPrepared(entry, origin, direction);
    if (!candidate || candidate.t < EPSILON || candidate.t > maxDistance + EPSILON) continue;
    if (pixelIndex !== undefined && entry.projectedMask) entry.projectedMask[pixelIndex] = 1;
    if (!best || candidate.t < best._candidate.t - TIE_EPSILON) {
      let color = FALLBACK_STONE;
      if (entry.node.kind === 'layer') color = resolveColorRef(candidate.colorRef, context.scene, FALLBACK_STONE);
      else color = resolveColorRef(entry.material?.color ?? entry.node.color ?? context.scene.palette?.stone, context.scene, FALLBACK_STONE);
      best = emptyHit(entry, origin, direction, candidate, color);
    }
  }
  return best;
}

function rampFor(entry, scene) {
  const material = entry.material;
  if (!material || material.ramp === undefined || material.ramp === null) return null;
  const ramp = typeof material.ramp === 'object' ? material.ramp : scene.ramps?.[material.ramp];
  if (!ramp || !Array.isArray(ramp.stops) || ramp.stops.length === 0) fail(`Material ${String(entry.materialRef)} has no usable ramp.`);
  const stops = ramp.stops.map((stop, index) => {
    if (!stop || !isFiniteNumber(stop.at)) fail(`Ramp stop ${index} must have a finite at value.`);
    return { at: stop.at, color: resolveColorRef(stop.color, scene) };
  }).sort((a, b) => a.at - b.at);
  return { stops, response: ramp.response ?? 1 };
}

function shadeHit(context, hit, { calculateShadows = true, appearance = true } = {}) {
  const entry = hit._entry;
  delete hit.appearanceNodeId;
  delete hit.appearancePixel;
  delete hit.appearanceShading;
  if (entry.node.kind === 'layer') {
    hit.color = resolveColorRef(hit._candidate.colorRef, context.scene, FALLBACK_STONE);
    hit.shadeIndex = 0;
    hit.shadowBy = [];
    return hit;
  }
  const material = entry.material ?? {};
  const specular = material.specular ?? 0;
  const roughness = material.roughness ?? 0.5;
  if (!isFiniteNumber(specular) || !isFiniteNumber(roughness)) fail(`Material ${String(entry.materialRef)} has invalid specular/roughness.`);
  if (specular !== 0) fail(`Nonzero specular is not supported on material ${String(entry.materialRef)}; set specular to 0.`);
  const diffuse = material.diffuse ?? 1;
  const emission = material.emission ?? 0;
  if (!isFiniteNumber(diffuse) || diffuse < 0 || !isFiniteNumber(emission) || emission < 0) fail(`Material ${String(entry.materialRef)} has invalid diffuse/emission.`);
  let direct = 0;
  const shadowBy = [];
  for (const light of context.lights) {
    let lightDirection;
    let maxDistance = Infinity;
    let attenuation = 1;
    if (light.type === 'point') {
      const toLight = sub(light.position, hit.position);
      const distance = Math.hypot(...toLight);
      if (distance <= EPSILON) continue;
      if (light.range > 0 && distance >= light.range) continue;
      lightDirection = toLight.map(v => v / distance);
      maxDistance = distance;
      attenuation = light.range > 0 ? Math.max(0, 1 - distance / light.range) : 1;
    } else {
      // Contract convention: directional direction is light travel direction;
      // the vector from the surface toward the light is -direction.
      lightDirection = light.direction.map(v => -v);
    }
    const lambert = Math.max(0, dot(hit.normal, lightDirection));
    if (lambert <= 0) continue;
    let blocked = false;
    if (calculateShadows) {
      context.stats.shadowRays++;
      const shadowOrigin = add(hit.position, hit.normal.map(v => v * SHADOW_EPSILON));
      const blocker = traceNearest(context, shadowOrigin, lightDirection, { shadowOnly: true, maxDistance });
      if (blocker && blocker.nodeId !== hit.nodeId || blocker && blocker.depth < maxDistance - SHADOW_EPSILON) {
        blocked = true;
        if (!shadowBy.includes(blocker.nodeId)) shadowBy.push(blocker.nodeId);
      }
    }
    if (!blocked) direct += light.intensity * attenuation * lambert;
  }
  if (shadowBy.length) context.stats.shadows++;
  const response = rampFor(entry, context.scene);
  const responseValue = response ? (response.response ?? 1) : 1;
  if (!isFiniteNumber(responseValue) || responseValue <= 0) fail(`Material ${String(entry.materialRef)} has invalid ramp response.`);
  const brightness = Math.max(0, (context.ambient + direct * diffuse + emission) * context.exposure);
  const adjusted = Math.pow(brightness, responseValue);
  let color = resolveColorRef(material.color ?? entry.node.color ?? context.scene.palette?.stone, context.scene, FALLBACK_STONE);
  let shadeIndex = 0;
  if (response) {
    shadeIndex = 0;
    for (let i = 1; i < response.stops.length; i++) {
      if (adjusted >= response.stops[i].at) shadeIndex = i;
      else break;
    }
    color = response.stops[shadeIndex].color;
  }
  if (appearance && entry.appearance) {
    const sample = sampleAppearance(context, hit, entry.appearance);
    if (sample) {
      // "lit" uses the target part's ordinary lambert/shadow result only as a
      // scalar brightness; the sampled pixel is the base color. The resulting
      // shaded color may therefore be outside the authored palette. "unlit"
      // keeps the sampled color exactly while geometry still supplies depth,
      // normal, shadow observations and outline.
      const finalColor = sample.shading === 'unlit'
        ? sample.color
        : modulateColor(sample.color, clamp01(adjusted));
      hit.color = finalColor;
      hit.shadeIndex = 0;
      hit.shadowBy = shadowBy;
      hit.appearanceNodeId = sample.layerId;
      hit.appearancePixel = sample.pixel;
      hit.appearanceShading = sample.shading;
      return hit;
    }
  }
  hit.color = color;
  hit.shadeIndex = shadeIndex;
  hit.shadowBy = shadowBy;
  return hit;
}

function hashNodeId(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function diagnosticColor(mode, hit, depthRange) {
  if (mode === 'silhouette') return [255, 255, 255, 255];
  if (mode === 'normals') return [
    clampByte((hit.normal[0] * 0.5 + 0.5) * 255),
    clampByte((hit.normal[1] * 0.5 + 0.5) * 255),
    clampByte((hit.normal[2] * 0.5 + 0.5) * 255),
    255,
  ];
  if (mode === 'nodes') {
    const hash = hashNodeId(hit.nodeId);
    return [(hash >>> 16) & 255, (hash >>> 8) & 255, hash & 255, 255];
  }
  if (mode === 'depth') {
    const span = Math.max(EPSILON, depthRange.max - depthRange.min);
    const value = clampByte((hit.depth - depthRange.min) / span * 255);
    return [value, value, value, 255];
  }
  return colorToBytes(hit.color);
}

function applyOutlines(hits, rgba, width, height, context) {
  compositeOutlines(hits, rgba, width, height, context, resolveColorRef);
}

function cleanHit(hit) {
  if (!hit) return null;
  const {
    nodeId,
    materialId,
    position,
    normal: hitNormal,
    depth,
    shadeIndex,
    color,
    shadowBy,
    outlineReason,
  } = hit;
  // Appearance provenance is only valid while the sampled color is the final
  // color. Inside/outside outline hits replace that color, so they must never
  // expose these fields.
  const appearance = hit.appearanceNodeId !== undefined &&
    hit.outlineReason !== 'inside' && hit.outlineReason !== 'outside' &&
    Array.isArray(hit.appearancePixel)
    ? {
        appearanceNodeId: hit.appearanceNodeId,
        appearancePixel: [...hit.appearancePixel],
        appearanceShading: hit.appearanceShading,
      }
    : {};
  return {
    nodeId,
    materialId,
    position: position ? [...position] : null,
    normal: hitNormal ? [...hitNormal] : null,
    depth,
    shadeIndex,
    color,
    shadowBy: [...shadowBy],
    outlineReason: outlineReason === 'none' ? undefined : outlineReason,
    ...appearance,
    ...(hit.outlineDirection ? { outlineDirection: hit.outlineDirection, outlineSourcePixel: hit.outlineSourcePixel } : {}),
    ...(hit.outlineReason === 'outside' ? { geometryNodeId: hit.geometryNodeId, generated: true } : {}),
  };
}

function makeRay(context, x, y) {
  const camera = context.camera;
  const dx = (x + 0.5 - camera.center[0]) / camera.pixelsPerUnit;
  const dy = (y + 0.5 - camera.center[1]) / camera.pixelsPerUnit;
  const screenPoint = add(camera.target, add(camera.right.map(v => v * dx), camera.down.map(v => v * dy)));
  const origin = sub(screenPoint, camera.direction.map(v => v * FAR_CLIP));
  return { origin, direction: camera.direction };
}

function emptyStats(context, width, height) {
  return {
    ...context.stats,
    width,
    height,
    pixelCount: width * height,
    transparentPixels: width * height - context.stats.hits,
    mode: 'beauty',
    renderer: RENDERER_VERSION,
  };
}

/** Render a full native scene. Region rendering is intentionally unsupported. */
export function renderScene(scene, { mode = 'beauty', region } = {}) {
  if (region !== undefined) fail('renderScene region is unsupported; render the complete scene.');
  if (!SUPPORTED_MODES.has(mode)) fail(`Unsupported render mode ${mode}.`);
  const context = makeContext(scene);
  const width = scene.width;
  const height = scene.height;
  const workEstimate = width * height * context.stats.visibleGeometryCount * (context.lights.length + 1);
  const maxWork = 32_000_000;
  if (workEstimate > maxWork) {
    fail(`Render workload ${workEstimate} exceeds the synchronous render limit ${maxWork}. Reduce the canvas, visible geometry, or lights.`, {
      workEstimate,
      maxWork,
      width,
      height,
      visibleGeometryCount: context.stats.visibleGeometryCount,
      lights: context.lights.length,
    });
  }
  if (mode === 'beauty') for (const entry of context.prepared) {
    if (entry.renderable && entry.visible && entry.outline.enabled) entry.projectedMask = new Uint8Array(width * height);
  }
  const rgba = new Uint8Array(width * height * 4);
  const hits = Array(width * height).fill(null);
  const write = makeColorWriter(rgba, width);
  const depthValues = [];
  context.stats.rays = width * height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ray = makeRay(context, x, y);
      const hit = traceNearest(context, ray.origin, ray.direction, { pixelIndex: y * width + x });
      if (!hit) continue;
      context.stats.hits++;
      // Diagnostic modes use debug colors, so only beauty pixels may claim
      // appearance provenance.
      shadeHit(context, hit, { appearance: mode === 'beauty' });
      hits[y * width + x] = hit;
      depthValues.push(hit.depth);
    }
  }
  const depthRange = depthValues.length
    ? { min: Math.min(...depthValues), max: Math.max(...depthValues) }
    : { min: 0, max: 1 };
  for (let i = 0; i < hits.length; i++) {
    if (hits[i]) write(i % width, Math.floor(i / width), diagnosticColor(mode, hits[i], depthRange));
  }
  if (mode === 'beauty') applyOutlines(hits, rgba, width, height, context);
  const colors = new Set();
  if (mode === 'beauty') {
    for (const hit of hits) if (hit) colors.add(hit.color);
  }
  const cleanHits = hits.map(cleanHit);
  const stats = emptyStats(context, width, height);
  stats.mode = mode;
  stats.geometryPixels = context.stats.hits;
  stats.visiblePixels = hits.filter(Boolean).length;
  stats.transparentPixels = width * height - stats.visiblePixels;
  if (mode !== 'beauty') context.warnings.push(`Diagnostic mode ${mode} uses debug colors and omits palette colors.`);
  return {
    width,
    height,
    rgba,
    hits: cleanHits,
    colorsUsed: [...colors],
    stats,
    warnings: [...context.warnings],
  };
}

/** Trace the nearest visible surface using the exact geometry used by renderScene. */
export function traceScene(scene, origin, direction, { shadowOnly = false } = {}) {
  const context = makeContext(scene);
  finiteArray(origin, 3, 'origin');
  finiteArray(direction, 3, 'direction');
  const length = Math.hypot(...direction);
  if (length <= EPSILON) fail('direction must be nonzero.');
  const unitDirection = direction.map(v => v / length);
  const hit = traceNearest(context, origin, unitDirection, { shadowOnly: Boolean(shadowOnly) });
  if (!hit) return null;
  if (!shadowOnly) shadeHit(context, hit);
  return cleanHit(hit);
}

export default { renderScene, traceScene, RENDERER_VERSION };
