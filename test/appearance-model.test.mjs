import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene, applyOperations, validateScene } from '../src/scene.mjs';
import { compileWorld } from '../src/world.mjs';
import { localBounds, intersectLocal, containsLocal, surfaceSamples, supportLocal, sampleAppearanceLocal } from '../src/geometry.mjs';
import { spatialReport, spatialSummary, spatialTree } from '../src/spatial.mjs';
import { point } from '../src/math.mjs';

const part = (id, extra = {}) => ({ id, kind: 'part', geometry: { type: 'box', min: [-1, 0, -1], max: [1, 2, 1] }, ...extra });
const layer = (id, parent, extra = {}) => ({ id, kind: 'layer', parent, width: 2, height: 2, pixels: ['ink', 'ink', 'ink', 'ink'], ...extra });
const sceneWith = (nodes, extra = {}) => createScene({ id: 'appearance-model', width: 16, height: 16, camera: { preset: 'top_down' }, nodes, ...extra });
const boundScene = (skin = {}) => sceneWith([part('body'), layer('skin', 'body', { appearanceOf: 'body', transform: { position: [0, 1, 0] }, ...skin })]);
const rejects = (fn, expected) => assert.throws(fn, error => {
  assert.equal(error.code, expected, `expected ${expected}, got ${error.code}: ${error.message}`);
  return true;
});
const deepFreeze = value => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
};

test('bound appearance is opt-in, leaf-only, and excluded from physical queries', () => {
  const scene = sceneWith([
    part('body'),
    layer('skin', 'body', { appearanceOf: 'body', transform: { position: [10, 1, 0] }, pixels: ['ink', null, 'ink', 'ink'] })
  ]);
  const skin = scene.nodes.find(node => node.id === 'skin');
  assert.equal(skin.appearanceOf, 'body');
  assert.equal(skin.appearanceShading, undefined);
  assert.equal(skin.castShadow, false);
  assert.equal(skin.outline.enabled, false);

  const compiled = compileWorld(scene), entry = compiled.entries.get('skin');
  assert.equal(entry.instance, null);
  assert.equal(entry.bounds, null);
  assert.equal(entry.localBounds, null);
  assert.equal(entry.visible, true);
  assert.deepEqual(compiled.entries.get('root').bounds, { min: [-1, 0, -1], max: [1, 2, 1] });

  assert.equal(localBounds(skin), null);
  assert.equal(intersectLocal(skin, [0, 0, 0], [0, 1, 0]), null);
  assert.equal(containsLocal(skin, [0.5, 0, -0.5]), false);
  assert.deepEqual(surfaceSamples(skin), []);
  assert.equal(supportLocal(skin, [0, 1, 0]), null);

  assert.deepEqual(sampleAppearanceLocal(skin, [0.5, 99, -0.5]), { colorRef: 'ink', pixelX: 0, pixelY: 0 });
  assert.equal(sampleAppearanceLocal(skin, [1.5, 0, -0.5]), null, 'a null pixel has no sampled color');
  assert.equal(sampleAppearanceLocal(skin, [2.5, 0, -0.5]), null, 'outside the layer extent falls back');
  assert.equal(sampleAppearanceLocal(scene.nodes.find(node => node.id === 'body'), [0.5, 0, -0.5]), null);

  const report = spatialReport(scene, { node: 'skin' }).nodes[0];
  assert.equal(report.bounds, null);
  assert.deepEqual(report.worldObservations, { total: 0, truncated: false, items: [] });
  assert.deepEqual(report.intent, []);
  assert.equal(spatialSummary(scene).edges.length, 0);
  assert.equal(spatialTree(scene, { root: 'body', depth: 1 }).tree.children[0].bounds, null);
});

test('binding validation rejects contradictory local fields and invalid owners atomically', () => {
  const invalidScenes = [
    ['unknown owner', () => sceneWith([part('body'), layer('skin', 'body', { appearanceOf: 'missing' })]), 'INVALID_REFERENCE'],
    ['group owner', () => sceneWith([{ id: 'group', kind: 'group' }, layer('skin', 'group', { appearanceOf: 'group' })]), 'APPEARANCE_OWNER'],
    ['not a direct child', () => sceneWith([part('body'), layer('skin', 'root', { appearanceOf: 'body' })]), 'APPEARANCE_PARENT'],
    ['castShadow true', () => sceneWith([part('body'), layer('skin', 'body', { appearanceOf: 'body', castShadow: true })]), 'APPEARANCE_CAST_SHADOW'],
    ['outline enabled', () => sceneWith([part('body'), layer('skin', 'body', { appearanceOf: 'body', outline: { enabled: true } })]), 'APPEARANCE_OUTLINE'],
    ['physical anchors', () => sceneWith([part('body'), layer('skin', 'body', { appearanceOf: 'body', anchors: { socket: { point: [0, 0, 0] } } })]), 'APPEARANCE_ANCHORS'],
    ['shading on a free layer', () => sceneWith([part('body'), layer('skin', 'body', { appearanceShading: 'unlit' })]), 'APPEARANCE_SHADING'],
    ['invalid shading value', () => sceneWith([part('body'), layer('skin', 'body', { appearanceOf: 'body', appearanceShading: 'glow' })]), 'INVALID_FIELD'],
    ['two bound layers on one part', () => sceneWith([part('body'), layer('skin', 'body', { appearanceOf: 'body' }), layer('skin2', 'body', { appearanceOf: 'body', visible: false })]), 'APPEARANCE_DUPLICATE'],
    ['bound layer with a child', () => sceneWith([part('body'), layer('skin', 'body', { appearanceOf: 'body' }), { id: 'child', kind: 'group', parent: 'skin' }]), 'APPEARANCE_LEAF']
  ];
  for (const [name, make, expected] of invalidScenes) {
    assert.throws(make, error => {
      assert.equal(error.code, expected, `${name}: expected ${expected}, got ${error.code}: ${error.message}`);
      return true;
    });
  }

  const base = boundScene();
  const invalidSets = [
    [{ castShadow: true }, 'APPEARANCE_CAST_SHADOW'],
    [{ outline: { enabled: true } }, 'APPEARANCE_OUTLINE'],
    [{ anchors: { socket: { point: [0, 0, 0] } } }, 'APPEARANCE_ANCHORS'],
    [{ appearanceOf: 'missing' }, 'INVALID_REFERENCE'],
    [{ appearanceOf: 'body', appearanceShading: 'glow' }, 'INVALID_FIELD']
  ];
  for (const [values, expected] of invalidSets) rejects(() => applyOperations(base, [{ op: 'node_set', id: 'skin', values }]), expected);

  const free = sceneWith([part('body'), layer('free', 'body')]);
  rejects(() => applyOperations(free, [{ op: 'node_set', id: 'free', values: { appearanceShading: 'unlit' } }]), 'APPEARANCE_SHADING');
  rejects(() => applyOperations(free, [{ op: 'node_set', id: 'free', values: { appearanceOf: 'body', castShadow: true } }]), 'APPEARANCE_CAST_SHADOW');
  rejects(() => applyOperations(free, [{ op: 'node_set', id: 'free', values: { appearanceOf: 'body', outline: { enabled: true } } }]), 'APPEARANCE_OUTLINE');
  rejects(() => applyOperations(free, [{ op: 'node_set', id: 'free', values: { appearanceOf: 'body', anchors: { socket: { point: [0, 0, 0] } } } }]), 'APPEARANCE_ANCHORS');

  rejects(() => applyOperations(base, [{ op: 'node_add', node: layer('skin2', 'root', { appearanceOf: 'body' }) }]), 'APPEARANCE_PARENT');
  rejects(() => applyOperations(base, [{ op: 'node_add', node: layer('skin2', 'body', { appearanceOf: 'body', castShadow: true }) }]), 'APPEARANCE_CAST_SHADOW');
  rejects(() => applyOperations(base, [{ op: 'node_add', node: layer('skin2', 'body', { appearanceShading: 'unlit' }) }]), 'APPEARANCE_SHADING');
  rejects(() => applyOperations(base, [{ op: 'node_add', node: { ...part('part2'), appearanceOf: 'body' } }]), 'UNKNOWN_FIELD');

  const before = JSON.stringify(base);
  rejects(() => applyOperations(base, [
    { op: 'transform', id: 'skin', translate: [1, 0, 0] },
    { op: 'node_set', id: 'skin', values: { castShadow: true } }
  ]), 'APPEARANCE_CAST_SHADOW');
  assert.equal(JSON.stringify(base), before, 'a failing appearance batch must not mutate the source scene');

  rejects(() => sceneWith([part('body'), layer('skin', 'body', { appearanceOf: null })]), 'INVALID_ID');
  rejects(() => applyOperations(base, [{ op: 'node_add', node: layer('skin2', 'body', { appearanceOf: null }) }]), 'INVALID_ID');
});

test('atomic reparent and rebind work in either order; null is only a node_set sentinel', () => {
  const make = () => sceneWith([part('body'), part('body2'), layer('skin', 'body', { appearanceOf: 'body' })]);
  for (const ops of [
    [{ op: 'node_set', id: 'skin', values: { appearanceOf: 'body2' } }, { op: 'node_reparent', id: 'skin', parent: 'body2' }],
    [{ op: 'node_reparent', id: 'skin', parent: 'body2' }, { op: 'node_set', id: 'skin', values: { appearanceOf: 'body2' } }]
  ]) {
    const scene = applyOperations(make(), ops);
    const skin = scene.nodes.find(node => node.id === 'skin');
    assert.equal(skin.parent, 'body2');
    assert.equal(skin.appearanceOf, 'body2');
    assert.equal(compileWorld(scene).entries.get('skin').instance, null);
  }

  rejects(() => applyOperations(make(), [{ op: 'node_set', id: 'skin', values: { appearanceOf: null, appearanceShading: 'glow' } }]), 'INVALID_FIELD');
  const unbound = applyOperations(make(), [
    { op: 'node_set', id: 'skin', values: { appearanceOf: null } },
    { op: 'node_reparent', id: 'skin', parent: 'root' }
  ]);
  const free = unbound.nodes.find(node => node.id === 'skin');
  assert.equal(free.appearanceOf, undefined);
  assert.equal(free.parent, 'root');
  assert.notEqual(compileWorld(unbound).entries.get('skin').instance, null);
});

test('null unbind restores a normal free layer and preserves its authored data', () => {
  const authored = layer('skin', 'body', {
    appearanceOf: 'body',
    appearanceShading: 'unlit',
    transform: { position: [3, 1, 2], rotation: [0, 30, 0] },
    basis: { u: [0, 1, 0], v: [0, 0, -1] },
    pixels: ['ink', 'white', 'white', 'ink']
  });
  const scene = sceneWith([part('body'), authored]);
  const before = scene.nodes.find(node => node.id === 'skin');

  const unbound = applyOperations(scene, [{ op: 'node_set', id: 'skin', values: { appearanceOf: null } }]);
  const after = unbound.nodes.find(node => node.id === 'skin');
  assert.equal(after.appearanceOf, undefined);
  assert.equal(after.appearanceShading, undefined);
  assert.deepEqual(after.transform, before.transform);
  assert.deepEqual(after.basis, before.basis);
  assert.deepEqual(after.pixels, before.pixels);

  const entry = compileWorld(unbound).entries.get('skin');
  assert.notEqual(entry.instance, null);
  assert.notEqual(entry.bounds, null);
  assert.notEqual(localBounds(after), null);
  assert.ok(surfaceSamples(after).length > 0);
  assert.equal(entry.instance.contains(entry.instance.samples()[0]), true);
  assert.equal(sampleAppearanceLocal(after, [0.5, 0, -0.5]), null, 'the helper only samples bound layers');

  const report = spatialReport(unbound, { node: 'skin' }).nodes[0];
  assert.notEqual(report.bounds, null);
  assert.equal(report.worldObservations.total > 0, true);
  assert.ok(spatialReport(unbound, { node: 'body' }).nodes[0].worldObservations.items.some(item => item.node === 'skin'));

  const explicit = applyOperations(scene, [{ op: 'node_set', id: 'skin', values: { appearanceOf: null, appearanceShading: 'unlit' } }]);
  assert.equal(explicit.nodes.find(node => node.id === 'skin').appearanceShading, undefined);
  const restored = applyOperations(scene, [{ op: 'node_set', id: 'skin', values: { appearanceOf: null, castShadow: true, outline: { enabled: true }, anchors: { socket: { point: [0, 0, 0] } } } }]);
  const restoredSkin = restored.nodes.find(node => node.id === 'skin');
  assert.equal(restoredSkin.castShadow, true);
  assert.equal(restoredSkin.outline.enabled, true);
  assert.deepEqual(restoredSkin.anchors.socket.point, [0, 0, 0]);

  const rebound = applyOperations(unbound, [{ op: 'node_set', id: 'skin', values: { appearanceOf: 'body' } }]);
  assert.equal(rebound.nodes.find(node => node.id === 'skin').appearanceOf, 'body');
  assert.equal(compileWorld(rebound).entries.get('skin').instance, null);
});

test('parent semantics move, hide, lock and delete a bound appearance', () => {
  const scene = boundScene();
  const moved = applyOperations(scene, [{ op: 'transform', id: 'body', translate: [5, 0, 0] }]);
  assert.equal(compileWorld(moved).entries.get('skin').transform[12], 5);
  assert.equal(moved.nodes.find(node => node.id === 'skin').parent, 'body');

  const grouped = applyOperations(scene, [{ op: 'node_group', id: 'assembly', children: ['body'] }]);
  assert.equal(grouped.nodes.find(node => node.id === 'skin').parent, 'body');
  assert.equal(grouped.nodes.find(node => node.id === 'skin').appearanceOf, 'body');
  const ungrouped = applyOperations(grouped, [{ op: 'node_reparent', id: 'body', parent: 'root', keepWorld: true }]);
  assert.equal(ungrouped.nodes.find(node => node.id === 'skin').appearanceOf, 'body');

  const hiddenOwner = applyOperations(scene, [{ op: 'node_set', id: 'body', values: { visible: false } }]);
  assert.equal(compileWorld(hiddenOwner).entries.get('skin').visible, false);
  const hiddenLayer = applyOperations(scene, [{ op: 'node_set', id: 'skin', values: { visible: false } }]);
  assert.equal(compileWorld(hiddenLayer).entries.get('skin').visible, false);

  const locked = applyOperations(scene, [{ op: 'node_set', id: 'body', values: { locked: true } }]);
  rejects(() => applyOperations(locked, [{ op: 'node_set', id: 'skin', values: { pixels: ['white', 'white', 'white', 'white'] } }]), 'LOCKED_NODE');
  rejects(() => applyOperations(locked, [{ op: 'node_reparent', id: 'skin', parent: 'root' }]), 'LOCKED_NODE');
  const unlocked = applyOperations(locked, [{ op: 'node_set', id: 'body', values: { locked: false } }]);
  assert.equal(applyOperations(unlocked, [{ op: 'node_set', id: 'skin', values: { pixels: ['white', 'white', 'white', 'white'] } }]).nodes.find(node => node.id === 'skin').pixels[0], 'white');

  const layerLocked = applyOperations(scene, [{ op: 'node_set', id: 'skin', values: { locked: true } }]);
  rejects(() => applyOperations(layerLocked, [{ op: 'node_set', id: 'skin', values: { pixels: ['white', 'white', 'white', 'white'] } }]), 'LOCKED_NODE');
  assert.equal(applyOperations(layerLocked, [{ op: 'node_set', id: 'body', values: { name: 'Body' } }]).nodes.find(node => node.id === 'body').name, 'Body');

  rejects(() => applyOperations(scene, [{ op: 'node_reparent', id: 'skin', parent: 'root' }]), 'APPEARANCE_PARENT');
  const twoParts = sceneWith([part('body'), part('other'), layer('skin', 'body', { appearanceOf: 'body' })]);
  rejects(() => applyOperations(twoParts, [{ op: 'node_reparent', id: 'skin', parent: 'other' }]), 'APPEARANCE_PARENT');

  const deletedOwner = applyOperations(scene, [{ op: 'node_delete', id: 'body' }]);
  assert.equal(deletedOwner.nodes.some(node => node.id === 'skin'), false);
  const hiddenOwnerDeleted = applyOperations(boundScene({ visible: false }), [{ op: 'node_delete', id: 'body' }]);
  assert.equal(hiddenOwnerDeleted.nodes.some(node => node.id === 'skin'), false);
  const deletedLayer = applyOperations(scene, [{ op: 'node_delete', id: 'skin' }]);
  assert.deepEqual(deletedLayer.nodes.map(node => node.id), ['root', 'body']);
});

test('projection follows the bound layer local transform and ignores perpendicular offset', () => {
  const scene = boundScene({ pixels: ['ink', 'white', 'stone0', 'stone1'] });
  const skin = scene.nodes.find(node => node.id === 'skin');
  assert.deepEqual(sampleAppearanceLocal(skin, [0.5, 0, -0.5]), { colorRef: 'ink', pixelX: 0, pixelY: 0 });
  assert.deepEqual(sampleAppearanceLocal(skin, [1.5, 0, -0.5]), { colorRef: 'white', pixelX: 1, pixelY: 0 });
  assert.deepEqual(sampleAppearanceLocal(skin, [0.5, 0, -1.5]), { colorRef: 'stone0', pixelX: 0, pixelY: 1 });
  assert.deepEqual(sampleAppearanceLocal(skin, [1.5, 0, -1.5]), { colorRef: 'stone1', pixelX: 1, pixelY: 1 });
  assert.deepEqual(sampleAppearanceLocal(skin, [0.5, 99, -0.5]), sampleAppearanceLocal(skin, [0.5, 0, -0.5]), 'the perpendicular coordinate is ignored');
  assert.equal(sampleAppearanceLocal(skin, [2.5, 0, -0.5]), null);

  const moved = applyOperations(scene, [{ op: 'transform', id: 'skin', translate: [10, 0, 0] }]);
  const movedSkin = moved.nodes.find(node => node.id === 'skin');
  const movedEntry = compileWorld(moved).entries.get('skin');
  const localFromWorld = point(movedEntry.inverse, [10.5, 1, -0.5]);
  assert.deepEqual(sampleAppearanceLocal(movedSkin, localFromWorld), { colorRef: 'ink', pixelX: 0, pixelY: 0 });

  const parentMoved = applyOperations(scene, [{ op: 'transform', id: 'body', translate: [0, 0, 4] }]);
  const parentEntry = compileWorld(parentMoved).entries.get('skin');
  const parentLocal = point(parentEntry.inverse, point(parentEntry.transform, [0.5, 0, -0.5]));
  assert.deepEqual(sampleAppearanceLocal(parentMoved.nodes.find(node => node.id === 'skin'), parentLocal), { colorRef: 'ink', pixelX: 0, pixelY: 0 });

  const cameraChanged = applyOperations(scene, [{ op: 'scene_set', values: { camera: { preset: 'top_down', target: [5, 0, 5], pixelsPerUnit: 4 } } }]);
  assert.deepEqual(sampleAppearanceLocal(cameraChanged.nodes.find(node => node.id === 'skin'), [0.5, 0, -0.5]), { colorRef: 'ink', pixelX: 0, pixelY: 0 });
});

test('subtree duplication remaps appearanceOf while independent duplicates stay invalid', () => {
  const scene = boundScene();
  const duplicated = applyOperations(scene, [{ op: 'node_duplicate', id: 'body', newId: 'body2' }]);
  const skin2 = duplicated.nodes.find(node => node.id === 'body2.skin');
  assert.equal(skin2.parent, 'body2');
  assert.equal(skin2.appearanceOf, 'body2');
  assert.equal(duplicated.nodes.find(node => node.id === 'skin').appearanceOf, 'body');
  assert.equal(compileWorld(duplicated).entries.get('body2.skin').instance, null);
  assert.notEqual(compileWorld(duplicated).entries.get('body2').instance, null);

  const hidden = boundScene({ visible: false });
  const hiddenCopy = applyOperations(hidden, [{ op: 'node_duplicate', id: 'body', newId: 'body2' }]);
  const hiddenSkin2 = hiddenCopy.nodes.find(node => node.id === 'body2.skin');
  assert.equal(hiddenSkin2.visible, false);
  assert.equal(hiddenSkin2.appearanceOf, 'body2');

  const grouped = applyOperations(scene, [{ op: 'node_group', id: 'assembly', children: ['body'] }]);
  const groupCopy = applyOperations(grouped, [{ op: 'node_duplicate', id: 'assembly', newId: 'assembly2' }]);
  const groupSkin2 = groupCopy.nodes.find(node => node.id === 'assembly2.skin');
  assert.equal(groupSkin2.parent, 'assembly2.body');
  assert.equal(groupSkin2.appearanceOf, 'assembly2.body');

  const before = JSON.stringify(scene);
  rejects(() => applyOperations(scene, [{ op: 'node_duplicate', id: 'skin', newId: 'skin2' }]), 'APPEARANCE_DUPLICATE');
  assert.equal(JSON.stringify(scene), before);
  const other = sceneWith([part('body'), part('other'), layer('skin', 'body', { appearanceOf: 'body' })]);
  rejects(() => applyOperations(other, [{ op: 'node_duplicate', id: 'skin', newId: 'skin2', parent: 'other' }]), 'APPEARANCE_PARENT');
});

test('spatial relations and mating reject bound appearance with clear errors', () => {
  const scene = boundScene();
  const relation = { id: 'skin-contact', from: { node: 'skin' }, relation: 'contact', to: { node: 'body' } };
  rejects(() => applyOperations(scene, [{ op: 'spatial_relation_add', edge: relation }]), 'APPEARANCE_NOT_PHYSICAL');
  rejects(() => applyOperations(scene, [{ op: 'node_attach', id: 'skin', target: 'body', mode: 'translate', sourceAnchor: 'a', targetAnchor: 'b' }]), 'APPEARANCE_NOT_PHYSICAL');
  rejects(() => applyOperations(scene, [{ op: 'node_align', id: 'skin', target: 'body' }]), 'APPEARANCE_NOT_PHYSICAL');
  rejects(() => applyOperations(scene, [{ op: 'node_attach', id: 'body', target: 'skin', mode: 'translate', sourceAnchor: 'a', targetAnchor: 'b' }]), 'APPEARANCE_NOT_PHYSICAL');
  rejects(() => applyOperations(scene, [{ op: 'node_align', id: 'body', target: 'skin' }]), 'APPEARANCE_NOT_PHYSICAL');

  const filtered = spatialReport(scene, { node: 'body', other: 'skin' }).nodes[0];
  assert.equal(filtered.worldObservations.total, 0);
  assert.deepEqual(filtered.worldObservations.items, []);

  const unbound = applyOperations(scene, [{ op: 'node_set', id: 'skin', values: { appearanceOf: null } }]);
  const related = applyOperations(unbound, [{ op: 'spatial_relation_add', edge: relation }]);
  assert.ok(related.spatialRelations.some(edge => edge.id === 'skin-contact'));
  const aligned = applyOperations(unbound, [{ op: 'node_align', id: 'skin', target: 'body', axis: 'y', targetAxis: 'y' }]);
  assert.equal(aligned.nodes.find(node => node.id === 'skin').appearanceOf, undefined);
});

test('ordinary free layers and format 2 stay unchanged while format 1 still requires migration', () => {
  const free = sceneWith([part('body'), layer('flat', 'root', { transform: { position: [0, 1, 0] } })]);
  validateScene(free);
  const flat = free.nodes.find(node => node.id === 'flat');
  assert.equal(flat.appearanceOf, undefined);
  assert.equal(flat.appearanceShading, undefined);
  assert.notEqual(localBounds(flat), null);
  const hit = intersectLocal(flat, [0.5, 10, -0.5], [0, -1, 0]);
  assert.equal(hit.colorRef, 'ink');
  assert.deepEqual([hit.pixelX, hit.pixelY], [0, 0]);
  assert.equal(sampleAppearanceLocal(flat, [0.5, 0, -0.5]), null);

  assert.throws(() => validateScene({ format: 'dsh-zpixel/1' }), error => {
    assert.equal(error.code, 'MIGRATION_REQUIRED');
    return true;
  });

  const frozen = deepFreeze(boundScene());
  assert.equal(validateScene(frozen), frozen);
  const edited = applyOperations(frozen, [{ op: 'node_set', id: 'skin', values: { appearanceOf: null } }]);
  assert.equal(edited.nodes.find(node => node.id === 'skin').appearanceOf, undefined);
  assert.equal(frozen.nodes.find(node => node.id === 'skin').appearanceOf, 'body');
});
