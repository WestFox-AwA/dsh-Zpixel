/**
 * Pure model-first observation helpers.
 *
 * This module owns no storage, performs no I/O and never edits a scene. It
 * projects the normalized scene structure into stable hashes, validates the
 * temporary orthographic observation camera, and builds an in-memory receipt
 * for a non-delivery observation.
 *
 * The observation workflow is additive: delivery still uses scene.camera, and
 * these helpers do not change the scene, the renderer or any legacy path.
 */
import { createHash } from 'node:crypto';
import { cameraBasis } from './math.mjs';
import { RENDERER_VERSION } from './renderer.mjs';
import { ZPixelError, assert } from './scene.mjs';

const HASH_ALGORITHM = 'sha256';
const RENDERER_SEMVER = RENDERER_VERSION.startsWith('dsh-zpixel/renderer-')
  ? RENDERER_VERSION.slice('dsh-zpixel/renderer-'.length)
  : RENDERER_VERSION;
const CAMERA_KEYS = Object.freeze(['position', 'target', 'up', 'mirrorX', 'pixelsPerUnit', 'center']);
const OBSERVATION_MODES = Object.freeze(['beauty', 'silhouette', 'depth', 'normals', 'nodes']);
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CAMERA_COORDINATE_LIMIT = 1e8;
const CAMERA_TARGET_LIMIT = 1e6;

const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * Sorted-key canonical JSON used by every hash in this module. Array order is
 * preserved; object keys are sorted and undefined object values are omitted.
 * This matches the store's stableJSON, so contentHash(scene) equals the store's
 * fingerprint(scene) without importing storage code.
 */
export function stableJSON(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(item => stableJSON(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stableJSON(value[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

function digest(value) {
  return createHash(HASH_ALGORITHM).update(value).digest('hex');
}

function assertScene(scene) {
  assert(plain(scene), 'OBSERVATION_SCENE', 'scene must be a plain object.');
  assert(typeof scene.id === 'string' && scene.id.length > 0, 'OBSERVATION_SCENE',
    'scene.id must be a nonempty string.');
  assert(Number.isSafeInteger(scene.revision) && scene.revision >= 0, 'OBSERVATION_SCENE',
    'scene.revision must be a nonnegative safe integer.');
  assert(Number.isFinite(scene.width) && Number.isFinite(scene.height), 'OBSERVATION_SCENE',
    'scene.width and scene.height must be finite numbers.');
  assert(plain(scene.camera), 'OBSERVATION_SCENE', 'scene.camera must be an object.');
  assert(Array.isArray(scene.nodes), 'OBSERVATION_SCENE', 'scene.nodes must be an array.');
}

function finiteNumber(value, path, min, max) {
  assert(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max,
    'OBSERVATION_CAMERA', `${path} must be a finite number between ${min} and ${max}.`,
    { path, value, min, max });
  return value;
}

function vector3(value, path, min = -CAMERA_TARGET_LIMIT, max = CAMERA_TARGET_LIMIT) {
  assert(Array.isArray(value) && value.length === 3, 'OBSERVATION_CAMERA',
    `${path} must be an array of 3 numbers.`, { path });
  for (let index = 0; index < 3; index++) finiteNumber(value[index], `${path}[${index}]`, min, max);
  return value;
}

function projectCamera(camera) {
  assert(plain(camera), 'OBSERVATION_SCENE', 'scene.camera must be an object.');
  const projected = {};
  for (const key of CAMERA_KEYS) if (camera[key] !== undefined) projected[key] = camera[key];
  return projected;
}

/**
 * Validate and normalize a temporary orthographic observation camera.
 *
 * The accepted shape is the existing scene camera shape:
 * {position, target, up, mirrorX, pixelsPerUnit, center}. A preset, projection,
 * perspective or fov field is rejected: observation cameras are explicit and
 * orthographic. Supplying options.base lets a partial camera inherit fields
 * (typically from scene.camera); options.width/height supply the default
 * canvas center when center is omitted.
 *
 * Returns a fresh object with cloned arrays. It never writes to the scene.
 */
export function validateObservationCamera(camera, options = {}) {
  assert(plain(camera), 'OBSERVATION_CAMERA', 'camera must be a plain object.');
  assert(options === undefined || plain(options), 'OBSERVATION_CAMERA', 'options must be a plain object.');
  assert(!owns(camera, 'preset'), 'OBSERVATION_CAMERA',
    'Observation cameras use explicit position/target/up, not preset; resolve the preset before observing.',
    { field: 'preset' });
  for (const key of ['projection', 'perspective', 'fov']) {
    assert(!owns(camera, key), 'OBSERVATION_CAMERA',
      `camera.${key} is not supported; observation cameras are orthographic and use position, target, up, mirrorX, pixelsPerUnit and center.`,
      { field: key });
  }
  for (const key of Object.keys(camera)) {
    assert(CAMERA_KEYS.includes(key), 'OBSERVATION_CAMERA',
      `camera.${key} is not part of the orthographic camera shape. Allowed fields: ${CAMERA_KEYS.join(', ')}.`,
      { field: key, allowed: CAMERA_KEYS });
  }
  const base = options.base;
  if (base !== undefined) assert(plain(base), 'OBSERVATION_CAMERA', 'base camera must be a plain object.');
  const merged = { ...(base ?? {}), ...camera };
  for (const key of ['position', 'target', 'up']) {
    assert(merged[key] !== undefined, 'OBSERVATION_CAMERA', `camera.${key} is required.`, { field: key });
  }
  const position = [...vector3(merged.position, 'camera.position', -CAMERA_COORDINATE_LIMIT, CAMERA_COORDINATE_LIMIT)];
  const target = [...vector3(merged.target, 'camera.target')];
  const up = [...vector3(merged.up, 'camera.up')];
  assert(Math.abs(Math.hypot(...up) - 1) < 1e-6, 'CAMERA_UP',
    'camera.up must be a unit vector; normalize it before validation.', { path: 'camera.up', value: up });
  const mirrorX = merged.mirrorX ?? false;
  assert(typeof mirrorX === 'boolean', 'OBSERVATION_CAMERA', 'camera.mirrorX must be a boolean.',
    { path: 'camera.mirrorX' });
  const pixelsPerUnit = merged.pixelsPerUnit ?? 1;
  finiteNumber(pixelsPerUnit, 'camera.pixelsPerUnit', 1e-4, 1e4);
  let center = merged.center;
  if (center === undefined) {
    assert(Number.isFinite(options.width) && Number.isFinite(options.height), 'OBSERVATION_CAMERA',
      'camera.center is required when width/height are not provided.', { path: 'camera.center' });
    center = [options.width / 2, options.height / 2];
  }
  assert(Array.isArray(center) && center.length === 2, 'OBSERVATION_CAMERA',
    'camera.center must be an array of 2 numbers.', { path: 'camera.center' });
  for (let index = 0; index < 2; index++) {
    finiteNumber(center[index], `camera.center[${index}]`, -CAMERA_TARGET_LIMIT, CAMERA_TARGET_LIMIT);
  }
  const normalized = { position, target, up, mirrorX, pixelsPerUnit, center: [...center] };
  try {
    cameraBasis(normalized);
  } catch (error) {
    throw new ZPixelError('CAMERA_BASIS',
      'camera position, target and up must define a nondegenerate orthographic view.',
      { path: 'camera', cause: error.message });
  }
  return normalized;
}

/** Normalize a render mode accepted by observation receipts. */
export function normalizeObservationMode(mode = 'beauty') {
  assert(typeof mode === 'string' && OBSERVATION_MODES.includes(mode), 'OBSERVATION_MODE',
    `mode must be one of: ${OBSERVATION_MODES.join(', ')}.`, { mode, allowed: OBSERVATION_MODES });
  return mode;
}

/** Normalize isolate to a node ID or null. */
export function normalizeIsolate(isolate = null) {
  if (isolate === undefined || isolate === null) return null;
  assert(typeof isolate === 'string' && NODE_ID.test(isolate), 'OBSERVATION_VIEW',
    'isolate must be a node ID or null.', { isolate });
  return isolate;
}

/** Normalize the complete view identity used by viewHash and receipts. */
export function normalizeObservationView(camera, options = {}) {
  assert(plain(options), 'OBSERVATION_VIEW', 'options must be a plain object.');
  const normalizedCamera = validateObservationCamera(camera, options);
  const mode = normalizeObservationMode(options.mode ?? 'beauty');
  const physicalOnly = options.physicalOnly ?? false;
  assert(typeof physicalOnly === 'boolean', 'OBSERVATION_VIEW', 'physicalOnly must be a boolean.',
    { physicalOnly });
  const isolate = normalizeIsolate(options.isolate);
  return { camera: normalizedCamera, mode, physicalOnly, isolate };
}

/**
 * Stable hash of the normalized scene structure.
 *
 * Included: canvas width/height, the normalized camera, and for every node in
 * normalized scene order: id, kind, parent, visible, castShadow, transform,
 * geometry, basis, appearanceOf, semanticFrame and anchors. Unbound (free)
 * layers are physical surfaces, so their width, height, pixelSize and binary
 * alpha occupancy (pixels.map(pixel => pixel !== null)) are also included.
 * RGB-only paint changes keep the hash stable; a null/non-null change
 * invalidates the observation because occlusion/bounds can change.
 *
 * Excluded by design: palette, ramps, materials, lights, ambient and exposure
 * (appearance/content), plus node name/role/tags/locked/material/outline,
 * bound-appearance layer pixels/width/height/pixelSize/appearanceShading,
 * spatialRelations, theme, title, document id and revision. Node array order is
 * preserved because it is part of the normalized scene and can affect render
 * tie-breaking.
 */
export function structureHash(scene) {
  assertScene(scene);
  const nodes = scene.nodes.map(node => {
    assert(plain(node), 'OBSERVATION_SCENE', 'scene.nodes must contain node objects.');
    assert(typeof node.id === 'string' && node.id.length > 0, 'OBSERVATION_SCENE',
      'Every node must have a nonempty string id.');
    const projected = {
      id: node.id,
      kind: node.kind,
      parent: node.parent,
      visible: node.visible,
      castShadow: node.castShadow,
      transform: node.transform,
      geometry: node.geometry,
      basis: node.basis,
      appearanceOf: node.appearanceOf,
      semanticFrame: node.semanticFrame,
      anchors: node.anchors
    };
    if (node.kind === 'layer' && node.appearanceOf === undefined) {
      assert(Array.isArray(node.pixels), 'OBSERVATION_SCENE',
        `Free layer "${node.id}" must have a pixels array.`, { id: node.id });
      projected.width = node.width;
      projected.height = node.height;
      projected.pixelSize = node.pixelSize;
      projected.occupancy = node.pixels.map(pixel => pixel !== null);
    }
    return projected;
  });
  return digest(stableJSON({
    canvas: { width: scene.width, height: scene.height },
    camera: projectCamera(scene.camera),
    nodes
  }));
}

/**
 * Stable hash of the complete normalized scene, including revision. This is
 * the store's fingerprint(scene) shape, so contentHash can be compared directly
 * with expectedHash. It changes for pixels, palette, ramps, materials, lights,
 * ambient, exposure, camera, nodes, relations, theme and revision.
 */
export function contentHash(scene) {
  assertScene(scene);
  return digest(stableJSON(scene));
}

/**
 * True when the scene has no part nodes. Groups and painted layers are flat;
 * any part, including a hidden part, means the scene makes a spatial promise.
 */
export function flatScene(scene) {
  assert(plain(scene), 'OBSERVATION_SCENE', 'flatScene requires a scene object.');
  assert(Array.isArray(scene.nodes), 'OBSERVATION_SCENE', 'flatScene requires scene.nodes to be an array.');
  return !scene.nodes.some(node => node && node.kind === 'part');
}

/** Normalized view direction (position -> target). */
export function viewDirection(camera) {
  assert(plain(camera), 'OBSERVATION_CAMERA', 'camera must be a plain object.');
  const position = vector3(camera.position, 'camera.position', -CAMERA_COORDINATE_LIMIT, CAMERA_COORDINATE_LIMIT);
  const target = vector3(camera.target, 'camera.target');
  const direction = target.map((value, index) => value - position[index]);
  const length = Math.hypot(...direction);
  assert(length > 1e-12, 'CAMERA_BASIS', 'camera.position and camera.target must be distinct.',
    { path: 'camera' });
  return direction.map(value => value / length);
}

/** Angle between two nonzero direction vectors, in degrees (0..180). */
export function angleBetweenDirections(a, b) {
  const unit = (value, path) => {
    assert(Array.isArray(value) && value.length === 3, 'OBSERVATION_VIEW',
      `${path} must be an array of 3 numbers.`, { path });
    for (let index = 0; index < 3; index++) {
      assert(typeof value[index] === 'number' && Number.isFinite(value[index]), 'OBSERVATION_VIEW',
        `${path}[${index}] must be a finite number.`, { path: `${path}[${index}]` });
    }
    const length = Math.hypot(...value);
    assert(length > 1e-12, 'OBSERVATION_VIEW', `${path} must be nonzero.`, { path });
    return value.map(component => component / length);
  };
  const left = unit(a, 'a');
  const right = unit(b, 'b');
  const cosine = Math.max(-1, Math.min(1,
    left.reduce((sum, value, index) => sum + value * right[index], 0)));
  return Math.acos(cosine) * 180 / Math.PI;
}

/**
 * Angle in degrees between the delivery view direction and an observation
 * camera. The delivery argument may be a scene (scene.camera is used) or a
 * camera. Callers choose the non-delivery threshold; this helper only measures.
 */
export function deliveryAngleSeparation(delivery, observation) {
  const deliveryCamera = plain(delivery) && plain(delivery.camera) && Array.isArray(delivery.nodes)
    ? delivery.camera
    : delivery;
  return angleBetweenDirections(viewDirection(deliveryCamera), viewDirection(observation));
}

/**
 * Stable hash of the observation view identity: normalized camera, mode,
 * physicalOnly and isolate. The same camera in a different object key order
 * hashes identically; changing any view field changes the hash.
 */
export function viewHash(input, options = {}) {
  assert(plain(options), 'OBSERVATION_VIEW', 'options must be a plain object.');
  const scene = plain(input) && Array.isArray(input.nodes) && plain(input.camera) ? input : null;
  const camera = options.camera ?? (scene ? scene.camera : input);
  const view = normalizeObservationView(camera, {
    ...options,
    base: options.base ?? (scene ? scene.camera : undefined),
    width: options.width ?? scene?.width,
    height: options.height ?? scene?.height
  });
  return digest(stableJSON(view));
}

function normalizeDeliveredTo(value) {
  const items = value instanceof Set ? [...value] : value;
  assert(Array.isArray(items), 'OBSERVATION_RECEIPT',
    'deliveredTo must be an array or Set of agent IDs.', { deliveredTo: value });
  const unique = new Set();
  for (const item of items) {
    assert(typeof item === 'string' && item.length > 0, 'OBSERVATION_RECEIPT',
      'deliveredTo entries must be nonempty strings.', { deliveredTo: item });
    unique.add(item);
  }
  return [...unique].sort();
}

/**
 * Build an in-memory receipt for a non-delivery observation.
 *
 * The receipt is deterministic for the same document/revision/structure/
 * content/view/renderer. deliveredTo is optional, normalized to a sorted unique
 * array, and never affects the receipt id. The helper does not store, mutate or
 * deliver anything; callers own cache and delivery tracking.
 */
export function createObservationReceipt(scene, options = {}) {
  assertScene(scene);
  assert(plain(options), 'OBSERVATION_RECEIPT', 'options must be a plain object.');
  assert(options.delivery === undefined || options.delivery === false, 'OBSERVATION_RECEIPT',
    'createObservationReceipt always creates a non-delivery observation.',
    { delivery: options.delivery });
  const camera = validateObservationCamera(options.camera ?? scene.camera, {
    base: scene.camera,
    width: scene.width,
    height: scene.height
  });
  const mode = normalizeObservationMode(options.mode ?? 'beauty');
  const physicalOnly = options.physicalOnly ?? false;
  assert(typeof physicalOnly === 'boolean', 'OBSERVATION_VIEW', 'physicalOnly must be a boolean.',
    { physicalOnly });
  const isolate = normalizeIsolate(options.isolate);
  const renderer = options.renderer ?? RENDERER_SEMVER;
  assert(typeof renderer === 'string' && renderer.length > 0, 'OBSERVATION_RECEIPT',
    'renderer must be a nonempty string.', { renderer });
  const structure = structureHash(scene);
  const content = contentHash(scene);
  const view = viewHash(scene, { camera, mode, physicalOnly, isolate });
  const id = options.id ?? `obs-${digest(stableJSON({
    document: scene.id,
    revision: scene.revision,
    structureHash: structure,
    contentHash: content,
    viewHash: view,
    renderer
  })).slice(0, 32)}`;
  assert(typeof id === 'string' && id.length > 0, 'OBSERVATION_RECEIPT',
    'id must be a nonempty string.', { id });
  const receipt = {
    id,
    document: scene.id,
    revision: scene.revision,
    structureHash: structure,
    contentHash: content,
    viewHash: view,
    camera,
    mode,
    physicalOnly,
    isolate,
    renderer,
    delivery: false
  };
  if (options.deliveredTo !== undefined) receipt.deliveredTo = normalizeDeliveredTo(options.deliveredTo);
  return receipt;
}
