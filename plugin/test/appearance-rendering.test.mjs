import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene, applyOperations } from '../src/scene.mjs';
import { renderScene, traceScene } from '../src/renderer.mjs';
import { contributionReport } from '../src/contribution.mjs';
import { compileWorld } from '../src/world.mjs';
import { renderNormalmap } from '../src/normalmap.mjs';

/*
 * Focused 0.3.6 appearance/geometry separation checks. These tests use only
 * synthetic boxes/ellipsoids; they never read or write a user asset library.
 */

const PALETTE = { red: '#ff0000', green: '#00ff00', blue: '#0000ff', yellow: '#ffff00' };
const TOP_DOWN = { preset: 'top_down', pixelsPerUnit: 2 };

function scene(nodes, options = {}) {
  return createScene({
    id: options.id ?? 'appearance',
    width: options.width ?? 16,
    height: options.height ?? 16,
    camera: options.camera ?? TOP_DOWN,
    palette: PALETTE,
    lights: options.lights ?? [],
    ambient: options.ambient ?? 0.5,
    exposure: options.exposure ?? 1,
    ...(options.ramps ? { ramps: options.ramps } : {}),
    ...(options.materials ? { materials: options.materials } : {}),
    nodes,
  });
}

function box(id, min, max, extra = {}) {
  return { id, kind: 'part', geometry: { type: 'box', min, max }, outline: { enabled: false }, ...extra };
}

function bound(owner, options = {}) {
  const width = options.width ?? 4;
  const height = options.height ?? 4;
  return {
    id: options.id ?? 'paint',
    kind: 'layer',
    parent: owner,
    appearanceOf: owner,
    width,
    height,
    pixelSize: options.pixelSize ?? 1,
    basis: options.basis ?? { u: [1, 0, 0], v: [0, 0, 1] },
    transform: options.transform ?? { position: options.position ?? [-2, 0, -2] },
    castShadow: false,
    outline: { enabled: false },
    ...(options.shading ? { appearanceShading: options.shading } : {}),
    ...(options.visible === false ? { visible: false } : {}),
    pixels: options.pixels ?? Array(width * height).fill('red'),
    ...(options.extra ?? {}),
  };
}

test('a bound layer compiles without a physical instance or bounds', () => {
  const body = box('body', [-2, 0, -2], [2, 1, 2]);
  const appearance = scene([body, bound('body', { width: 4, height: 4, position: [-2, 0, -2] })]);
  const compiled = compileWorld(appearance);
  const entry = compiled.entries.get('paint');
  assert.equal(entry.instance, null);
  assert.equal(entry.bounds, null);
  assert.equal(entry.localBounds, null);
  assert.deepEqual(Object.keys(entry.anchors), []);
  // Omitted shading stays absent in the normalized document; renderer and
  // contribution resolve it to "lit".
  assert.equal(appearance.nodes.find(node => node.id === 'paint').appearanceShading, undefined);
});

test('curved surface keeps position, depth, normal, alpha and shadow observations when appearance supplies color', () => {
  const part = { id: 'ball', kind: 'part', geometry: { type: 'ellipsoid', center: [0, 1, 0], radii: [1.5, 1, 1.5] }, outline: { enabled: false } };
  const blocker = box('blocker', [-3, 3, -1], [-1, 4, 1]);
  const lights = [{ id: 'sun', type: 'directional', direction: [0.6, -1, 0.2], intensity: 1 }];
  const plain = scene([part, blocker], { lights, ambient: 0.2 });
  const appearance = scene([part, blocker, bound('ball', { width: 4, height: 4, position: [-2, 0, -2] })], { lights, ambient: 0.2 });
  const a = renderScene(plain);
  const b = renderScene(appearance);
  let checked = 0;
  let sampled = 0;
  for (let index = 0; index < a.hits.length; index++) {
    const before = a.hits[index];
    const after = b.hits[index];
    if (!before && !after) continue;
    assert.ok(before && after, `pixel ${index} must hit the same geometry`);
    assert.equal(after.nodeId, before.nodeId);
    assert.deepEqual(after.position, before.position);
    assert.deepEqual(after.normal, before.normal);
    assert.equal(after.depth, before.depth);
    assert.equal(b.rgba[index * 4 + 3], a.rgba[index * 4 + 3]);
    assert.deepEqual(after.shadowBy, before.shadowBy);
    if (after.appearanceNodeId) {
      assert.equal(after.appearanceNodeId, 'paint');
      assert.equal(after.appearanceShading, 'lit');
      assert.equal(after.appearancePixel.length, 2);
      sampled++;
    }
    checked++;
  }
  assert.ok(checked > 20);
  assert.ok(sampled > 0);
  assert.ok(b.stats.shadows > 0, 'the blocker must produce real shadow observations');
  assert.equal(b.stats.shadowRays, a.stats.shadowRays);
  assert.equal(b.stats.shadows, a.stats.shadows);
  assert.equal(b.stats.surfaceTests, a.stats.surfaceTests);
  assert.equal(b.stats.geometryCount, a.stats.geometryCount);
});

test('foreground occlusion is decided before color and appearance is clipped to the part hit', () => {
  const body = box('body', [-4, 0, -4], [4, 1, 4]);
  const cover = box('cover', [-1, 2, -1], [1, 3, 1]);
  const full = scene([body, cover, bound('body', { width: 8, height: 8, position: [-4, 0, -4], pixels: Array(64).fill('red') })], { width: 16, height: 16, camera: TOP_DOWN });
  const image = renderScene(full);
  const coverHits = image.hits.filter(hit => hit?.nodeId === 'cover');
  const bodyHits = image.hits.filter(hit => hit?.nodeId === 'body');
  assert.ok(coverHits.length > 0 && bodyHits.length > 0);
  assert.ok(coverHits.every(hit => hit.appearanceNodeId === undefined));
  assert.ok(bodyHits.every(hit => hit.appearanceNodeId === 'paint'));
  assert.ok(coverHits.every(hit => hit.color !== '#ff0000'));

  const clipped = scene([body, bound('body', { width: 2, height: 2, position: [-4, 0, -4], pixels: ['red', 'red', 'red', 'red'] })], { width: 16, height: 16, camera: TOP_DOWN });
  const baseline = scene([body], { width: 16, height: 16, camera: TOP_DOWN });
  const c = renderScene(clipped);
  const b = renderScene(baseline);
  let inside = 0;
  let outside = 0;
  for (let index = 0; index < c.hits.length; index++) {
    const hit = c.hits[index];
    const base = b.hits[index];
    if (!hit) {
      assert.equal(base, null);
      continue;
    }
    assert.ok(base);
    if (hit.appearanceNodeId) {
      inside++;
      assert.notEqual(hit.color, base.color);
    } else {
      outside++;
      assert.equal(hit.color, base.color);
      assert.equal(hit.shadeIndex, base.shadeIndex);
      assert.deepEqual(hit.shadowBy, base.shadowBy);
    }
  }
  assert.ok(inside > 0 && outside > 0);
});

test('null and out-of-extent appearance pixels fall back to the old ramp exactly', () => {
  const body = box('body', [-2, 0, -2], [2, 1, 2]);
  const pixels = ['red', null, null, 'blue'];
  const appearance = scene([body, bound('body', { width: 2, height: 2, position: [-2, 0, -2], pixels })]);
  const baseline = scene([body]);
  const a = renderScene(appearance);
  const b = renderScene(baseline);
  let sampled = 0;
  let fallback = 0;
  for (let index = 0; index < a.hits.length; index++) {
    const hit = a.hits[index];
    const base = b.hits[index];
    if (!hit) {
      assert.equal(base, null);
      continue;
    }
    assert.ok(base);
    if (hit.appearanceNodeId) {
      sampled++;
      assert.equal(hit.appearanceShading, 'lit');
    } else {
      fallback++;
      assert.equal(hit.color, base.color);
      assert.equal(hit.shadeIndex, base.shadeIndex);
      assert.deepEqual(hit.shadowBy, base.shadowBy);
      assert.deepEqual(
        Array.from(a.rgba.subarray(index * 4, index * 4 + 4)),
        Array.from(b.rgba.subarray(index * 4, index * 4 + 4)),
      );
    }
  }
  assert.ok(sampled > 0 && fallback > 0);
});

test('lit modulates the sampled base by target brightness and unlit keeps it exact', () => {
  const body = box('body', [-2, 0, -2], [2, 1, 2]);
  const material = { ramp: 'stone', diffuse: 1, emission: 0, specular: 0, roughness: 0.5 };
  const ramps = { stone: { response: 2, stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }] } };
  const lit = scene([body, bound('body', { width: 4, height: 4, position: [-2, 0, -2], pixels: Array(16).fill('red') })], { ambient: 0.5, exposure: 1, ramps, materials: { stone: material } });
  const unlit = scene([body, bound('body', { width: 4, height: 4, position: [-2, 0, -2], pixels: Array(16).fill('red'), shading: 'unlit' })], { ambient: 0.5, exposure: 1, ramps, materials: { stone: material } });
  const litHits = renderScene(lit).hits.filter(hit => hit?.appearanceNodeId);
  const unlitHits = renderScene(unlit).hits.filter(hit => hit?.appearanceNodeId);
  assert.ok(litHits.length > 0 && unlitHits.length > 0);
  assert.ok(litHits.every(hit => hit.appearanceShading === 'lit' && hit.color === '#400000'));
  assert.ok(unlitHits.every(hit => hit.appearanceShading === 'unlit' && hit.color === '#ff0000'));

  const darkUnlit = scene([body, bound('body', { width: 4, height: 4, position: [-2, 0, -2], pixels: Array(16).fill('red'), shading: 'unlit' })], { ambient: 0, exposure: 0.5, ramps, materials: { stone: material } });
  assert.ok(renderScene(darkUnlit).hits.filter(hit => hit?.appearanceNodeId).every(hit => hit.color === '#ff0000'));

  const dimLit = scene([body, bound('body', { width: 4, height: 4, position: [-2, 0, -2], pixels: Array(16).fill('red') })], { ambient: 0.25, exposure: 1, ramps, materials: { stone: material } });
  assert.ok(renderScene(dimLit).hits.filter(hit => hit?.appearanceNodeId).every(hit => hit.color === '#100000'));
});

test('unlit appearance keeps geometry shadow observations', () => {
  const body = box('body', [-2, 0, -2], [2, 1, 2]);
  const blocker = box('blocker', [-3, 3, -1], [-1, 4, 1]);
  const lights = [{ id: 'sun', type: 'directional', direction: [0.6, -1, 0.2], intensity: 1 }];
  const plain = scene([body, blocker], { lights, ambient: 0.2 });
  const unlit = scene([body, blocker, bound('body', { width: 4, height: 4, position: [-2, 0, -2], shading: 'unlit' })], { lights, ambient: 0.2 });
  const a = renderScene(plain);
  const b = renderScene(unlit);
  let sampled = 0;
  let shadowed = 0;
  for (let index = 0; index < a.hits.length; index++) {
    const before = a.hits[index];
    const after = b.hits[index];
    if (!before && !after) continue;
    assert.ok(before && after);
    assert.equal(after.nodeId, before.nodeId);
    assert.deepEqual(after.shadowBy, before.shadowBy);
    if (before.shadowBy.length) shadowed++;
    if (after.appearanceNodeId) {
      sampled++;
      assert.equal(after.appearanceShading, 'unlit');
    }
  }
  assert.ok(sampled > 0);
  assert.ok(shadowed > 0);
  assert.equal(b.stats.shadowRays, a.stats.shadowRays);
  assert.equal(b.stats.shadows, a.stats.shadows);
});

test('projection follows the bound layer object transform and a hidden projector falls back', () => {
  const body = box('body', [-2, 0, -2], [2, 1, 2], { transform: { position: [3, 0, 0] } });
  const pixels = ['red', 'green', 'blue', 'yellow'];
  // The projector plane sits above the part: if it were physical it would win
  // the camera ray. Only the part may be hit, with sampled color.
  const visible = scene([body, bound('body', { width: 2, height: 2, transform: { position: [-1, 2, -1] }, pixels })], { width: 16, height: 16, camera: TOP_DOWN });
  const hit = traceScene(visible, [3.25, 10, 0.25], [0, -1, 0]);
  assert.ok(hit);
  assert.equal(hit.nodeId, 'body');
  assert.equal(hit.appearanceNodeId, 'paint');
  assert.deepEqual(hit.appearancePixel, [1, 1]);
  assert.equal(hit.appearanceShading, 'lit');
  assert.equal(hit.color, '#808000');

  const hidden = scene([body, bound('body', { width: 2, height: 2, transform: { position: [-1, 2, -1] }, pixels, visible: false })], { width: 16, height: 16, camera: TOP_DOWN });
  const hiddenHit = traceScene(hidden, [3.25, 10, 0.25], [0, -1, 0]);
  assert.ok(hiddenHit);
  assert.equal(hiddenHit.nodeId, 'body');
  assert.equal(hiddenHit.appearanceNodeId, undefined);
  assert.equal(hiddenHit.color, '#606779');
  assert.equal(renderScene(hidden).hits.filter(h => h?.appearanceNodeId).length, 0);
});

test('traceScene returns appearance provenance only when the sampled color is final', () => {
  const body = box('body', [-2, 0, -2], [2, 1, 2]);
  const appearance = scene([body, bound('body', { width: 4, height: 4, position: [-2, 0, -2], pixels: Array(16).fill('red') })]);
  const hit = traceScene(appearance, [0.25, 10, 0.25], [0, -1, 0]);
  assert.ok(hit);
  assert.equal(hit.nodeId, 'body');
  assert.equal(hit.appearanceNodeId, 'paint');
  assert.deepEqual(hit.appearancePixel, [2, 2]);
  assert.equal(hit.appearanceShading, 'lit');
  assert.equal(hit.color, '#800000');

  const shadow = traceScene(appearance, [0.25, 10, 0.25], [0, -1, 0], { shadowOnly: true });
  assert.ok(shadow);
  assert.equal(shadow.appearanceNodeId, undefined);
  assert.equal(shadow.appearancePixel, undefined);
  assert.equal(shadow.appearanceShading, undefined);

  const plain = scene([body]);
  const plainHit = traceScene(plain, [0.25, 10, 0.25], [0, -1, 0]);
  assert.equal(plainHit.appearanceNodeId, undefined);
  assert.equal(plainHit.color, '#606779');
});

test('normalmap stays on geometry hits and ignores appearance color', () => {
  const body = box('body', [-2, 0, -2], [2, 1, 2]);
  const appearance = scene([body, bound('body', { width: 4, height: 4, position: [-2, 0, -2], pixels: Array(16).fill('red') })], { width: 8, height: 8, camera: { preset: 'top_down', pixelsPerUnit: 1 } });
  const normalmap = renderNormalmap(appearance);
  const beautyHit = normalmap.beauty.hits.find(hit => hit);
  assert.equal(beautyHit.appearanceNodeId, 'paint');
  assert.equal(normalmap.stats.surfacePixels, 16);
  assert.equal(normalmap.stats.layerPixels, 0);
  const normalHit = normalmap.hits.find(hit => hit);
  assert.equal(normalHit.source, 'surface');
  assert.deepEqual(normalHit.normal, [0, 0, 1]);
  assert.equal(normalmap.rgba[3], normalmap.beauty.rgba[3]);
});

test('outline strokes clear appearance provenance and contribution reports appearances separately', () => {
  const body = box('body', [-2, 0, -2], [2, 1, 2], { outline: { enabled: true, direction: 'outside' } });
  const appearance = scene([body, bound('body', { width: 4, height: 4, position: [-2, 0, -2], pixels: Array(16).fill('red') })], { width: 12, height: 12, camera: TOP_DOWN });
  const outside = renderScene(appearance);
  const outlineHits = outside.hits.filter(hit => hit?.outlineReason);
  assert.ok(outlineHits.length > 0);
  assert.ok(outlineHits.every(hit => hit.appearanceNodeId === undefined && hit.appearancePixel === undefined && hit.appearanceShading === undefined));
  const sampled = outside.hits.filter(hit => hit?.appearanceNodeId);
  assert.ok(sampled.length > 0);

  const report = contributionReport(appearance, outside);
  assert.equal(report.appearancePixels, sampled.length);
  assert.equal(report.pixelsByKind.layer, 0);
  assert.ok(report.pixelsByKind.part > 0);
  assert.deepEqual(report.layerPixels, { total: 0, painted: 0, visible: 0 });
  assert.deepEqual(report.zeroVisible, { parts: [], layers: [] });
  assert.deepEqual(report.nodes.map(node => node.id), ['body']);
  assert.equal(report.representation, 'geometry');
  assert.equal(report.appearances.length, 1);
  assert.deepEqual(report.appearances[0], {
    id: 'paint',
    appearanceOf: 'body',
    appearanceShading: 'lit',
    paintedPixels: 16,
    totalPixels: 16,
    visiblePixels: sampled.length,
  });
  assert.match(report.note, /appearances/);
  assert.match(report.note, /physical/i);
  assert.match(report.note, /palette/i);

  const insideScene = applyOperations(appearance, [{ op: 'node_set', id: 'body', values: { outline: { enabled: true, direction: 'inside' } } }]);
  const inside = renderScene(insideScene);
  assert.ok(inside.hits.filter(hit => hit?.outlineReason).every(hit => hit.appearanceNodeId === undefined));

  const hidden = scene([body, bound('body', { width: 4, height: 4, position: [-2, 0, -2], pixels: Array(16).fill('red'), visible: false })], { width: 12, height: 12, camera: TOP_DOWN });
  const hiddenReport = contributionReport(hidden, renderScene(hidden));
  assert.equal(hiddenReport.appearancePixels, 0);
  assert.deepEqual(hiddenReport.zeroVisible.layers, []);
  assert.equal(hiddenReport.appearances[0].visiblePixels, 0);
  assert.equal(hiddenReport.appearances[0].appearanceShading, 'lit');
});
