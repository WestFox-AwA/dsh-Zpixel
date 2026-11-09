import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene, applyOperations } from '../src/scene.mjs';
import { renderScene } from '../src/renderer.mjs';
import { TOOL_SCHEMAS } from '../src/protocol.mjs';

/*
 * Focused 0.3.6 appearance contract smoke.
 *
 * This file deliberately checks only the public schema, the generic runnable
 * crate example, unbinding, and appearanceOf source validation. The model and
 * renderer suites own the exhaustive lit/unlit, fallback, outline, duplicate
 * and contribution behavior matrices; do not duplicate those here.
 */

const exampleValues = () => ({
  id: 'appearance-contract',
  width: 32,
  height: 32,
  camera: { preset: 'top_down', target: [0, 1, 0], pixelsPerUnit: 8 },
  nodes: [
    {
      id: 'crate',
      name: 'Crate',
      kind: 'part',
      material: 'wood',
      geometry: { type: 'box', center: [0, 1, 0], size: [4, 2, 4] }
    },
    {
      id: 'crate-label',
      name: 'Crate label',
      kind: 'layer',
      parent: 'crate',
      appearanceOf: 'crate',
      appearanceShading: 'lit',
      width: 4,
      height: 4,
      pixelSize: 1,
      basis: { u: [1, 0, 0], v: [0, 0, -1] },
      transform: { position: [-2, 2, 2] },
      castShadow: false,
      outline: { enabled: false },
      pixels: [
        null, 'white', 'white', null,
        'white', null, null, 'white',
        'white', null, null, 'white',
        null, 'white', 'white', null
      ]
    }
  ]
});

const sceneParameters = () => TOOL_SCHEMAS.find(tool => tool.name === 'zpixel_scene').parameters;

test('public node schema types appearanceOf and appearanceShading', () => {
  const scene = sceneParameters().properties.scene;
  const node = scene.properties.nodes.items;
  assert.equal(node.properties.appearanceOf.type, 'string');
  assert.match(node.properties.appearanceOf.description, /direct child/i);
  assert.match(node.properties.appearanceOf.description, /at most one bound layer/i);
  assert.equal(node.properties.appearanceShading.type, 'string');
  assert.deepEqual(node.properties.appearanceShading.enum, ['lit', 'unlit']);
  assert.match(node.properties.appearanceShading.description, /free layer/i);
  assert.match(node.description, /appearanceOf/i);

  const nodeSet = sceneParameters().properties.ops.items.oneOf
    .find(branch => branch.properties?.op?.enum?.includes('node_set'));
  assert.ok(nodeSet, 'node_set must keep its typed operation branch');
  assert.match(nodeSet.properties.values.description, /appearanceOf:null/);
  assert.match(nodeSet.properties.values.description, /unbind/i);
});

test('generic crate example creates and renders a bound appearance', () => {
  const scene = createScene(exampleValues());
  const mark = scene.nodes.find(node => node.id === 'crate-label');
  assert.equal(mark.parent, 'crate');
  assert.equal(mark.appearanceOf, 'crate');
  assert.equal(mark.appearanceShading, 'lit');

  const image = renderScene(scene);
  const hits = image.hits.filter(Boolean);
  assert.ok(hits.length > 0, 'the crate must render');
  const appearanceHits = hits.filter(hit => hit.appearanceNodeId === 'crate-label');
  assert.ok(appearanceHits.length > 0, 'the label must recolor at least one crate pixel');
  for (const hit of appearanceHits) {
    assert.equal(hit.nodeId, 'crate');
    assert.ok(Array.isArray(hit.appearancePixel) && hit.appearancePixel.length === 2);
    assert.ok(hit.appearancePixel.every(Number.isInteger));
    assert.equal(hit.appearanceShading, 'lit');
  }
  assert.equal(hits.some(hit => hit.nodeId === 'crate-label'), false,
    'a bound appearance layer has no geometry instance of its own');
});

test('node_set appearanceOf:null unbinds and restores the free layer', () => {
  const scene = createScene(exampleValues());
  const before = scene.nodes.find(node => node.id === 'crate-label');
  const unbound = applyOperations(scene, [
    { op: 'node_set', id: 'crate-label', values: { appearanceOf: null } }
  ]);
  const mark = unbound.nodes.find(node => node.id === 'crate-label');
  assert.equal(mark.appearanceOf, undefined);
  assert.equal(mark.appearanceShading, undefined);
  assert.equal(mark.parent, 'crate');
  assert.deepEqual(mark.transform, before.transform);
  assert.deepEqual(mark.basis, before.basis);
  assert.deepEqual(mark.pixels, before.pixels);

  const rebound = applyOperations(unbound, [
    { op: 'node_set', id: 'crate-label', values: { appearanceOf: 'crate', appearanceShading: 'unlit' } }
  ]);
  const again = rebound.nodes.find(node => node.id === 'crate-label');
  assert.equal(again.appearanceOf, 'crate');
  assert.equal(again.appearanceShading, 'unlit');
});

test('appearanceOf sources and free-layer shading are validated', () => {
  const unknown = exampleValues();
  unknown.nodes[1].appearanceOf = 'missing';
  assert.throws(() => createScene(unknown), error => {
    assert.match(error.message, /appearance|part|reference|unknown/i);
    return true;
  });

  const wrongParent = exampleValues();
  wrongParent.nodes[1].parent = 'root';
  assert.throws(() => createScene(wrongParent), error => {
    assert.match(error.message, /appearance|direct child|parent/i);
    return true;
  });

  const freeShading = exampleValues();
  delete freeShading.nodes[1].appearanceOf;
  freeShading.nodes[1].appearanceShading = 'unlit';
  assert.throws(() => createScene(freeShading), error => {
    assert.match(error.message, /appearance|free layer|bound/i);
    return true;
  });
});
