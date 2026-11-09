import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperations, createScene, ZPixelError } from '../src/scene.mjs';
import { renderScene } from '../src/renderer.mjs';
import { renderNormalmap, NORMALMAP_SOURCE_MODE, NORMALMAP_RELIEF } from '../src/normalmap.mjs';

const box = (id, min, max, extra = {}) => ({ id, kind: 'part', geometry: { type: 'box', min, max }, ...extra });
const bytesAt = (image, index) => Array.from(image.rgba.subarray(index * 4, index * 4 + 4));
const bytesAtPixel = (image, x, y) => bytesAt(image, y * image.width + x);
const findHit = (image, predicate) => image.beauty.hits.findIndex(hit => hit && predicate(hit));

// Independent view-basis and encoding math for expected values. This is
// intentionally not imported from the module under test.
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = value => {
  const length = Math.hypot(...value);
  return value.map(component => component / length);
};
const rotateZ = (value, degrees) => {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  return [cosine * value[0] - sine * value[1], sine * value[0] + cosine * value[1], value[2]];
};
function viewBasis(camera) {
  const direction = normalize(camera.target.map((value, index) => value - camera.position[index]));
  const baseRight = normalize(cross(direction, camera.up));
  const down = normalize(cross(direction, baseRight));
  return { right: camera.mirrorX ? baseRight.map(value => -value) : baseRight, down, direction };
}
function encodeExpected(normal, basis, convention = 'opengl') {
  const raw = [
    dot(normal, basis.right),
    convention === 'opengl' ? -dot(normal, basis.down) : dot(normal, basis.down),
    -dot(normal, basis.direction),
  ];
  const unit = normalize(raw);
  return unit.map(value => Math.max(0, Math.min(255, Math.round((Math.max(-1, Math.min(1, value)) * 0.5 + 0.5) * 255))));
}

test('top-down +Y face uses neutral sprite-view RGB while the world-normals diagnostic stays world-encoded', () => {
  const scene = createScene({
    id: 'neutral',
    width: 16,
    height: 16,
    camera: { preset: 'top_down', pixelsPerUnit: 2 },
    nodes: [box('body', [-2, 0, -2], [2, 1, 2], { outline: { enabled: false } })],
  });
  const result = renderNormalmap(scene);
  const index = findHit(result, hit => hit.nodeId === 'body' && hit.normal?.[1] > 0.999 && !hit.outlineReason);
  assert.ok(index >= 0);

  assert.deepEqual(bytesAt(result, index), [128, 128, 255, 255]);
  assert.deepEqual(result.hits[index].normal, [0, 0, 1]);
  assert.equal(result.hits[index].source, 'surface');
  assert.deepEqual(bytesAtPixel(result, 0, 0), [0, 0, 0, 0]);

  const world = renderScene(scene, { mode: 'normals' });
  assert.deepEqual(Array.from(world.rgba.subarray(index * 4, index * 4 + 4)), [128, 255, 128, 255]);

  assert.equal(result.width, 16);
  assert.equal(result.height, 16);
  assert.equal(result.hits.length, 16 * 16);
  assert.deepEqual(result.normalMap.neutral, [128, 128, 255]);
  assert.equal(result.normalMap.space, 'sprite-view');
  assert.equal(result.normalMap.alpha, 'beauty-matched');
  assert.equal(NORMALMAP_SOURCE_MODE, 'geometry');
  assert.equal(NORMALMAP_RELIEF, 'none');
  assert.equal(result.stats.mode, 'normalmap');
  assert.ok(result.colorsUsed.includes('#8080ff'));
  assert.ok(result.warnings.some(warning => /neutral/i.test(warning)));
  assert.ok(result.warnings.some(warning => /sRGB/i.test(warning)));
  for (let i = 0; i < result.hits.length; i++) {
    assert.equal(result.rgba[i * 4 + 3], result.beauty.rgba[i * 4 + 3]);
  }
});

test('three-quarter camera encodes a +Y face from the analytic camera basis, not a self-check', () => {
  const scene = createScene({
    id: 'tilted',
    width: 24,
    height: 24,
    camera: { preset: 'three_quarter', pixelsPerUnit: 4 },
    nodes: [box('body', [-2, 0, -2], [2, 1, 2], { outline: { enabled: false } })],
  });
  const result = renderNormalmap(scene);
  const index = findHit(result, hit => hit.nodeId === 'body' && hit.normal?.[1] > 0.999 && !hit.outlineReason);
  assert.ok(index >= 0);

  // dir=[0,-sin55,-cos55], right=[1,0,0], down=[0,-cos55,sin55]:
  // ny=+cos55 -> 201, nz=+sin55 -> 232.
  assert.deepEqual(bytesAt(result, index), [128, 201, 232, 255]);
  const basis = viewBasis(scene.camera);
  assert.deepEqual(basis.right.map(value => (Math.abs(value) < 1e-12 ? 0 : value)), [1, 0, 0]);
  assert.ok(Math.abs(basis.down[0]) < 1e-12);
  assert.ok(Math.abs(basis.down[1] + Math.cos(55 * Math.PI / 180)) < 1e-12);
  assert.ok(Math.abs(basis.down[2] - Math.sin(55 * Math.PI / 180)) < 1e-12);
  assert.deepEqual(encodeExpected([0, 1, 0], basis), [128, 201, 232]);
  assert.deepEqual(encodeExpected(result.beauty.hits[index].normal, basis), [128, 201, 232]);
});

test('DirectX flips green and mirrorX flips red at the corresponding mirrored pixel', () => {
  const scene = createScene({
    id: 'conventions',
    width: 24,
    height: 24,
    camera: { preset: 'three_quarter', pixelsPerUnit: 4 },
    nodes: [box('body', [-2, 0, -2], [2, 1, 2], { outline: { enabled: false } })],
  });
  const open = renderNormalmap(scene);
  const direct = renderNormalmap(scene, { convention: 'directx' });
  let greenDifference = 0;
  for (let index = 0; index < open.hits.length; index++) {
    if (!open.hits[index]) continue;
    const a = bytesAt(open, index), b = bytesAt(direct, index);
    assert.equal(a[3], b[3]);
    assert.equal(a[0], b[0]);
    assert.equal(a[2], b[2]);
    assert.ok(Math.abs(a[1] + b[1] - 255) <= 1);
    greenDifference = Math.max(greenDifference, Math.abs(a[1] - b[1]));
  }
  assert.ok(greenDifference > 50);
  assert.equal(open.normalMap.convention, 'opengl');
  assert.equal(direct.normalMap.convention, 'directx');
  assert.equal(direct.normalMap.axes.y, 'down');

  const rotated = {
    ...box('sloped', [-2, 0, -2], [2, 1, 2], { outline: { enabled: false } }),
    transform: { rotation: [0, 0, 45] },
  };
  const camera = { preset: 'top_down', pixelsPerUnit: 4 };
  const plain = renderNormalmap(createScene({ id: 'mirror-a', width: 24, height: 24, camera, nodes: [rotated] }));
  const mirrored = renderNormalmap(createScene({ id: 'mirror-b', width: 24, height: 24, camera: { ...camera, mirrorX: true }, nodes: [rotated] }));
  const index = findHit(plain, hit => hit.normal && Math.abs(hit.normal[0]) > 0.5 && !hit.outlineReason);
  assert.ok(index >= 0);
  const x = index % 24, y = Math.floor(index / 24);
  const mirroredX = 2 * 12 - 1 - x;
  const mirroredIndex = y * 24 + mirroredX;

  assert.ok(mirrored.beauty.hits[mirroredIndex]);
  const a = bytesAt(plain, index), b = bytesAt(mirrored, mirroredIndex);
  assert.ok(Math.abs(a[0] - b[0]) > 50);
  assert.ok(Math.abs(a[0] + b[0] - 255) <= 1);
  assert.deepEqual(a.slice(1, 3), b.slice(1, 3));
});

test('rotated non-uniform ellipsoid uses inverse-transposed world normals exactly once', () => {
  const scene = createScene({
    id: 'ellipsoid',
    width: 24,
    height: 24,
    camera: { preset: 'top_down', pixelsPerUnit: 4 },
    nodes: [{
      id: 'ellipsoid',
      kind: 'part',
      outline: { enabled: false },
      transform: { position: [0, 1, 0], rotation: [0, 0, 30], scale: [2, 1, 1] },
      geometry: { type: 'ellipsoid', center: [0, 0, 0], radii: [1, 1, 1] },
    }],
  });
  const result = renderNormalmap(scene);
  const basis = viewBasis(scene.camera);
  let checked = 0, sloped = 0;
  for (let index = 0; index < result.hits.length; index++) {
    const hit = result.beauty.hits[index];
    if (!hit || hit.nodeId !== 'ellipsoid' || hit.outlineReason || !hit.normal) continue;
    // R*S maps the local unit sphere to the world ellipsoid. The world normal
    // of (R*S)^-T is R*S^-1, so unrotate the offset, divide by radii squared,
    // rotate back, then normalize. This distinguishes inverse-transpose from
    // a plain inverse on a rotated non-uniform scale.
    const localOffset = rotateZ([hit.position[0], hit.position[1] - 1, hit.position[2]], -30);
    const expectedWorld = normalize(rotateZ([localOffset[0] / 4, localOffset[1], localOffset[2]], 30));
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(hit.normal[axis] - expectedWorld[axis]) < 1e-7);
    }
    assert.deepEqual(bytesAt(result, index).slice(0, 3), encodeExpected(expectedWorld, basis));
    if (Math.abs(expectedWorld[0]) > 0.2) sloped++;
    checked++;
  }
  assert.ok(checked > 50);
  assert.ok(sloped > 5);
});

test('final-hit alpha matches beauty through inside/outside outlines and foreground overlap', () => {
  const scene = createScene({
    id: 'alpha',
    width: 20,
    height: 20,
    camera: { preset: 'three_quarter', pixelsPerUnit: 3 },
    nodes: [
      box('body', [-2, 0, -2], [2, 1, 2], { outline: { enabled: true, direction: 'outside' } }),
      box('cover', [-3, 3, -3], [3, 4, 3], { outline: { enabled: false } }),
    ],
  });
  const outside = renderNormalmap(scene);
  const outsideIndices = [];
  let coverPixels = 0, bodyPixels = 0;
  for (let index = 0; index < outside.hits.length; index++) {
    const hit = outside.beauty.hits[index];
    if (hit?.outlineReason === 'outside') outsideIndices.push(index);
    if (hit?.nodeId === 'cover') coverPixels++;
    if (hit?.nodeId === 'body') bodyPixels++;
    assert.equal(outside.rgba[index * 4 + 3], outside.beauty.rgba[index * 4 + 3]);
  }
  assert.ok(outsideIndices.length > 0);
  assert.ok(coverPixels > 0 && bodyPixels > 0);
  assert.equal(outside.normalMap.fallbackCounts.outsideOutlinePixels, outsideIndices.length);
  for (const index of outsideIndices) {
    assert.deepEqual(bytesAt(outside, index), [128, 128, 255, 255]);
    assert.equal(outside.hits[index].source, 'outside-outline');
    assert.deepEqual(outside.hits[index].normal, [0, 0, 1]);
  }
  assert.deepEqual(bytesAtPixel(outside, 0, 0), [0, 0, 0, 0]);

  const insideScene = applyOperations(scene, [{ op: 'node_set', id: 'body', values: { outline: { enabled: true, direction: 'inside' } } }]);
  const inside = renderNormalmap(insideScene);
  const insideIndex = findHit(inside, hit => hit.nodeId === 'body' && hit.outlineReason === 'inside' && hit.normal);
  assert.ok(insideIndex >= 0);
  const expected = [...encodeExpected(inside.beauty.hits[insideIndex].normal, viewBasis(insideScene.camera)), 255];
  assert.deepEqual(bytesAt(inside, insideIndex), expected);
  assert.notDeepEqual(expected.slice(0, 3), [128, 128, 255]);
  assert.equal(inside.normalMap.fallbackCounts.insideOutlinePixels, inside.beauty.hits.filter(hit => hit?.outlineReason === 'inside').length);
  for (let index = 0; index < inside.hits.length; index++) {
    assert.equal(inside.rgba[index * 4 + 3], inside.beauty.rgba[index * 4 + 3]);
  }
});

test('painted layer with a back-facing plane normal becomes neutral view-facing, not guessed relief', () => {
  const scene = createScene({
    id: 'layer',
    width: 8,
    height: 8,
    camera: { preset: 'top_down', pixelsPerUnit: 1 },
    nodes: [{
      id: 'paint',
      kind: 'layer',
      width: 2,
      height: 2,
      basis: { u: [1, 0, 0], v: [0, 0, 1] },
      pixels: ['#ff0000', '#ff0000', '#ff0000', '#ff0000'],
    }],
  });
  const result = renderNormalmap(scene);
  const index = findHit(result, hit => hit.nodeId === 'paint');
  assert.ok(index >= 0);
  assert.ok(result.beauty.hits[index].normal[1] < 0);
  assert.deepEqual(bytesAt(result, index), [128, 128, 255, 255]);
  assert.equal(result.hits[index].source, 'layer');
  assert.equal(result.normalMap.layers, 'view-facing-plane');
  assert.equal(result.normalMap.fallbackCounts.paintedLayerPixels, 4);
  assert.ok(result.warnings.some(warning => /planar/i.test(warning)));
  const direct = renderNormalmap(scene, { convention: 'directx' });
  assert.deepEqual(bytesAt(direct, index), [128, 128, 255, 255]);
});

test('normal-map bytes ignore lights/ramp, and provided beauty is reused without mutation', () => {
  const nodes = [box('body', [-2, 0, -2], [2, 1, 2], { outline: { enabled: false } })];
  const scene = createScene({ id: 'invariant', width: 16, height: 16, camera: { preset: 'three_quarter' }, nodes });
  const variant = createScene({
    id: 'invariant',
    width: 16,
    height: 16,
    camera: scene.camera,
    nodes,
    lights: [{ id: 'key', type: 'directional', direction: [-1, -1, -1], intensity: 0.1 }],
    ambient: 0,
    exposure: 0.5,
    ramps: { stone: { response: 1, stops: [{ at: 0, color: '#ff0000' }, { at: 1, color: '#00ff00' }] } },
  });
  const a = renderNormalmap(scene);
  const b = renderNormalmap(variant);
  assert.deepEqual(Array.from(a.rgba), Array.from(b.rgba));
  assert.notDeepEqual(Array.from(a.beauty.rgba), Array.from(b.beauty.rgba));

  const provided = renderScene(scene);
  const providedBytes = provided.rgba.slice();
  const providedHits = structuredClone(provided.hits);
  const sceneSnapshot = structuredClone(scene);
  const reused = renderNormalmap(scene, { beauty: provided });
  assert.equal(reused.beauty, provided);
  assert.deepEqual(Array.from(reused.rgba), Array.from(a.rgba));
  assert.deepEqual(scene, sceneSnapshot);
  assert.deepEqual(provided.rgba, providedBytes);
  assert.deepEqual(provided.hits, providedHits);
  assert.throws(() => renderNormalmap(scene, { beauty: { ...provided, width: 15 } }), error => {
    assert.ok(error instanceof ZPixelError);
    assert.equal(error.code, 'NORMAL_BEAUTY');
    return true;
  });
  const diagnostic = renderScene(scene, { mode: 'normals' });
  assert.throws(() => renderNormalmap(scene, { beauty: diagnostic }), error => {
    assert.ok(error instanceof ZPixelError);
    assert.equal(error.code, 'NORMAL_BEAUTY');
    assert.match(error.message, /beauty/i);
    assert.equal(error.details.actualMode, 'normals');
    return true;
  });
});

test('unknown normal-map conventions rejected with NORMAL_CONVENTION', () => {
  const scene = createScene({ id: 'bad-convention', width: 8, height: 8, nodes: [box('body', [-1, 0, -1], [1, 1, 1])] });
  for (const convention of ['metal', 'OpenGL', '']) {
    assert.throws(() => renderNormalmap(scene, { convention }), error => {
      assert.ok(error instanceof ZPixelError);
      assert.equal(error.code, 'NORMAL_CONVENTION');
      assert.match(error.message, /convention/i);
      assert.deepEqual(error.details.supported, ['opengl', 'directx']);
      return true;
    });
  }
});
