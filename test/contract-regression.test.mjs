import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScene, applyOperations } from '../src/scene.mjs';
import { renderScene } from '../src/renderer.mjs';
import { compileWorld } from '../src/world.mjs';
import {createZPixelServiceForTest as createZPixelService} from './helpers.mjs';
import { TOOL_SCHEMAS } from '../src/protocol.mjs';

/*
 * 0.3.5 contract regression. These tests deliberately hit only the seams this
 * release changed or promised: catalog paging, reachable paint payloads and
 * their error paths, the documented extrude axes, outline inheritance, and
 * the typed common-operation schema. Rendering output/art is covered by the
 * existing rendering and authoring suites; no new image fixtures live here.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
async function workspace(t) {
  await fs.mkdir(path.join(root, '.validation'), { recursive: true });
  const cwd = await fs.mkdtemp(path.join(root, '.validation', 'v034-contract-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}
function serviceFor(cwd) {
  const ctx = {
    workingDirectory: { async ensure() { return cwd; } },
    sandboxPolicy: { resolve() { return { mode: 'workspace-write', workspaceRoot: cwd }; } },
    llm: { async resolveModelInfo() { return { inputModalities: ['text'] }; } },
    attachments: { imageLimits: { maxImageDimension: 4096 }, async saveImages(images) { return images.map(image => ({ path: 'stub.png', mediaType: image.mediaType, name: image.name })); } }
  };
  const exec = { agent: { id: 'contract-regression', session: { requestHeader() { return { config: { provider: 'test', model: 'test' } }; } } }, signal: new AbortController().signal };
  return { service: createZPixelService(ctx), exec };
}

test('catalog list pages in id order, rejects invalid pages and parses only the requested page', async t => {
  const cwd = await workspace(t), { service, exec } = serviceFor(cwd);
  try {
    for (const id of ['alpha', 'bravo', 'charlie']) await service.run('zpixel_scene', { action: 'create', document: id, txid: `catalog-${id}`, scene: { width: 8, height: 8 } }, exec);
    const parameters = TOOL_SCHEMAS.find(tool => tool.name === 'zpixel_scene').parameters;
    assert.equal(parameters.properties.offset.type, 'integer', 'list offset must be reachable through the tool schema');
    assert.equal(parameters.properties.limit.type, 'integer', 'list limit must be reachable through the tool schema');

    const all = await service.run('zpixel_scene', { action: 'list' }, exec);
    assert.deepEqual(all.documents.map(document => document.id), ['alpha', 'bravo', 'charlie']);
    assert.equal(all.total, 3);
    assert.equal(all.nextOffset, null);

    const first = await service.run('zpixel_scene', { action: 'list', offset: 0, limit: 1 }, exec);
    assert.deepEqual(first.documents.map(document => document.id), ['alpha']);
    assert.deepEqual([first.offset, first.limit, first.total, first.nextOffset], [0, 1, 3, 1]);

    const second = await service.run('zpixel_scene', { action: 'list', offset: 1, limit: 1 }, exec);
    assert.deepEqual(second.documents.map(document => document.id), ['bravo']);
    assert.equal(second.nextOffset, 2);

    const last = await service.run('zpixel_scene', { action: 'list', offset: 2, limit: 2 }, exec);
    assert.deepEqual(last.documents.map(document => document.id), ['charlie']);
    assert.equal(last.nextOffset, null);

    const empty = await service.run('zpixel_scene', { action: 'list', offset: 3, limit: 2 }, exec);
    assert.deepEqual(empty.documents, []);
    assert.equal(empty.total, 3);
    assert.equal(empty.nextOffset, null);

    for (const invalid of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: 51 }, { limit: '2' }]) {
      const field = Object.hasOwn(invalid, 'offset') ? 'offset' : 'limit';
      await assert.rejects(service.run('zpixel_scene', { action: 'list', ...invalid }, exec), error => {
        assert.match(error.message, new RegExp(field));
        assert.equal(error.details?.field, field);
        return true;
      });
    }

    // The page reader must not parse unrelated documents: a corrupt entry that
    // sorts outside the requested page may increase total but must not fail it.
    await fs.writeFile(path.join(cwd, '.zpixel', 'documents', 'zulu.json'), '{not json');
    const isolated = await service.run('zpixel_scene', { action: 'list', offset: 0, limit: 1 }, exec);
    assert.deepEqual(isolated.documents.map(document => document.id), ['alpha']);
    assert.equal(isolated.total, 4);
    assert.equal(isolated.nextOffset, 1);
  } finally { service.dispose(); }
});

test('paint sparse points, dense pixels and node_set replacement write the same layer, and invalid batches roll back', () => {
  const makeLayer = () => createScene({ id: 'paint-contract', width: 8, height: 8, camera: { preset: 'top_down' }, nodes: [{ id: 'canvas', kind: 'layer', width: 4, height: 4 }] });
  const pixels = Array(16).fill(null);
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) pixels[y * 4 + x] = 'ink';

  const sparse = applyOperations(makeLayer(), [{ op: 'paint', id: 'canvas', ops: [{ op: 'pixels', points: [[1, 1, 'ink'], [2, 1, 'ink'], [1, 2, 'ink'], [2, 2, 'ink']] }] }]);
  const dense = applyOperations(makeLayer(), [{ op: 'paint', id: 'canvas', ops: [{ op: 'pixels', x: 1, y: 1, w: 2, h: 2, pixels: ['ink', 'ink', 'ink', 'ink'] }] }]);
  const replaced = applyOperations(makeLayer(), [{ op: 'node_set', id: 'canvas', values: { pixels } }]);
  for (const scene of [sparse, dense, replaced]) assert.deepEqual(scene.nodes.find(node => node.id === 'canvas').pixels, pixels);

  const layer = makeLayer();
  assert.throws(() => applyOperations(layer, [{ op: 'paint', id: 'canvas', ops: [{ op: 'pixels', points: [[4, 0, 'ink']] }] }]), error => {
    assert.equal(error.code, 'INVALID_NUMBER');
    assert.match(error.message, /ops\[0\]\.ops\[0\]\.points\[0\]\.x/);
    return true;
  });
  assert.throws(() => applyOperations(layer, [{ op: 'paint', id: 'canvas', ops: [{ op: 'pixels', x: 0, y: 0, w: 2, h: 2, pixels: ['ink', 'ink', 'ink'] }] }]), error => {
    assert.equal(error.code, 'INVALID_PIXELS');
    assert.match(error.message, /ops\[0\]\.ops\[0\]\.pixels/);
    assert.deepEqual([error.details?.expected, error.details?.actual], [4, 3]);
    return true;
  });
  assert.throws(() => applyOperations(layer, [{ op: 'paint', id: 'canvas', ops: [{ op: 'line', x: 0, y: 0, x2: 3, color: 'ink' }] }]), error => {
    assert.equal(error.code, 'INVALID_OPERATION');
    assert.match(error.message, /x2/);
    assert.match(error.message, /y2/);
    assert.deepEqual(error.details?.missing, ['y2']);
    return true;
  });
  assert.throws(() => applyOperations(layer, [{ op: 'paint', id: 'canvas', ops: [{ op: 'line', x: 0, y: 0, x2: 9, y2: 0, color: 'ink' }] }]), error => {
    assert.match(error.message, /ops\[0\]\.ops\[0\]\.x2/, 'end-point errors must name the real x2 field');
    return true;
  });
  assert.throws(() => applyOperations(layer, [{ op: 'paint', id: 'canvas', pixels: ['ink'] }]), error => {
    assert.equal(error.code, 'UNKNOWN_FIELD');
    assert.match(error.message, /ops/);
    assert.equal(typeof error.details?.hint, 'string');
    return true;
  });

  const before = JSON.stringify(layer);
  assert.throws(() => applyOperations(layer, [
    { op: 'paint', id: 'canvas', ops: [{ op: 'rect', x: 0, y: 0, w: 1, h: 1, color: 'ink' }] },
    { op: 'paint', id: 'canvas', ops: [{ op: 'line', x: 0, y: 0, x2: 9, y2: 0, color: 'ink' }] }
  ]));
  assert.equal(JSON.stringify(layer), before, 'a failing batch must not mutate the source scene');
});

test('extrude axis y places the asymmetric profile on X/-Z and the sweep on Y', () => {
  const scene = createScene({
    id: 'extrude-contract', width: 8, height: 8,
    nodes: [{ id: 'wedge', kind: 'part', geometry: { type: 'extrude', points: [[0, 0], [4, 0], [0, 2]], range: [0, 2], axis: 'y' } }]
  });
  const entry = compileWorld(scene).entries.get('wedge');
  assert.deepEqual(entry.bounds, { min: [0, 0, -2], max: [4, 2, 0] });
});

test('the four common editing ops keep one closed typed branch outside the generic fallback', () => {
  const parameters = TOOL_SCHEMAS.find(tool => tool.name === 'zpixel_scene').parameters;
  const branches = parameters.properties.ops.items.oneOf;
  const opValues = branch => branch.properties?.op?.enum ?? (branch.properties?.op?.const === undefined ? [] : [branch.properties.op.const]);
  const samples = [
    { op: 'paint', id: 'canvas', ops: [] },
    { op: 'node_set', id: 'canvas', values: {} },
    { op: 'transform', id: 'canvas', translate: [1, 0, 0] },
    { op: 'palette_set', id: 'ink', color: '#000000' }
  ];
  for (const sample of samples) {
    const matches = branches.filter(branch => opValues(branch).includes(sample.op) &&
      (branch.required ?? []).every(key => Object.hasOwn(sample, key)) &&
      Object.keys(sample).every(key => Object.hasOwn(branch.properties ?? {}, key)));
    assert.equal(matches.length, 1, `${sample.op} must match exactly one operation branch`);
    assert.equal(matches[0].additionalProperties, false, `${sample.op} must keep a closed typed branch`);
  }
  const generic = branches.filter(branch => branch.additionalProperties === true);
  assert.equal(generic.length, 1, 'one annotated generic branch remains for the other operations');
  for (const op of ['paint', 'node_set', 'transform', 'palette_set']) assert.ok(!opValues(generic[0]).includes(op), `${op} must not overlap the generic oneOf branch`);

  const outline = parameters.properties.scene.properties.nodes.items.properties.outline;
  assert.equal(outline.type, 'object');
  assert.equal(outline.additionalProperties, false);
  assert.equal(outline.properties.enabled.type, 'boolean');
  assert.deepEqual(outline.properties.direction.enum, ['inside', 'outside']);
  assert.deepEqual(outline.properties.width.enum, [1]);
});

test('outline inheritance keeps plain parts stroked, honours a disabled group and a layer default', () => {
  const part = parent => ({ id: 'box', kind: 'part', parent, geometry: { type: 'box', center: [0, 1, 0], size: [2, 2, 2] } });
  const plain = createScene({ id: 'outline-plain', width: 16, height: 16, camera: { preset: 'top_down' }, nodes: [part('root')] });
  const disabled = createScene({ id: 'outline-disabled', width: 16, height: 16, camera: { preset: 'top_down' }, nodes: [{ id: 'frame', kind: 'group', outline: { enabled: false } }, part('frame')] });
  const layer = createScene({ id: 'outline-layer', width: 16, height: 16, camera: { preset: 'top_down' }, nodes: [{ id: 'canvas', kind: 'layer', width: 4, height: 4 }, part('canvas')] });

  assert.equal(plain.nodes.find(node => node.id === 'root').outline.enabled, true);
  assert.equal(plain.nodes.find(node => node.id === 'box').outline, undefined);
  assert.equal(layer.nodes.find(node => node.id === 'canvas').outline.enabled, false);
  assert.ok(renderScene(plain).stats.outlined > 0, 'a plain part inherits the root outline');
  assert.equal(renderScene(disabled).stats.outlined, 0, 'a disabled group outline reaches its part');
  assert.equal(renderScene(layer).stats.outlined, 0, 'a layer default disabled outline reaches its part');
});
