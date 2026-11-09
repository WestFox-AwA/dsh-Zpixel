import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperations, createScene } from '../src/scene.mjs';
import { RENDERER_VERSION } from '../src/renderer.mjs';
import { fingerprint } from '../src/store.mjs';
import {
  contentHash,
  createObservationReceipt,
  deliveryAngleSeparation,
  flatScene,
  stableJSON,
  structureHash,
  validateObservationCamera,
  viewHash
} from '../src/observation.mjs';

const RENDERER_SEMVER = RENDERER_VERSION.startsWith('dsh-zpixel/renderer-')
  ? RENDERER_VERSION.slice('dsh-zpixel/renderer-'.length)
  : RENDERER_VERSION;

function baseScene() {
  return createScene({
    id: 'observation-fixture',
    width: 64,
    height: 64,
    camera: {
      position: [0, 100, 0],
      target: [0, 0, 0],
      up: [0, 0, -1],
      mirrorX: false,
      pixelsPerUnit: 4,
      center: [32, 32]
    },
    nodes: [
      { id: 'root', kind: 'group' },
      {
        id: 'hull',
        kind: 'part',
        parent: 'root',
        geometry: { type: 'box', center: [0, 1, 0], size: [8, 2, 6] },
        anchors: { center: { point: [0, 1, 0] } },
        semanticFrame: { forward: [0, 0, -1], up: [0, 1, 0] }
      },
      {
        id: 'turret',
        kind: 'part',
        parent: 'root',
        geometry: { type: 'cylinder', center: [0, 2.5, 0], radius: 1.5, length: 1, axis: 'y' }
      },
      {
        id: 'decal',
        kind: 'layer',
        parent: 'root',
        width: 8,
        height: 8,
        pixelSize: 0.25,
        plane: 'xz'
      },
      {
        id: 'hull-appearance',
        kind: 'layer',
        parent: 'hull',
        appearanceOf: 'hull',
        width: 4,
        height: 4,
        pixelSize: 0.25,
        plane: 'xz'
      }
    ]
  });
}

test('appearance-only edits keep structureHash and change contentHash', () => {
  const scene = baseScene();
  const structure = structureHash(scene);
  const content = contentHash(scene);

  const painted = applyOperations(scene, [
    { op: 'paint', id: 'hull-appearance', ops: [{ op: 'rect', x: 0, y: 0, w: 2, h: 2, color: 'ink' }] }
  ]);
  assert.equal(structureHash(painted), structure);
  assert.notEqual(contentHash(painted), content);

  const paletted = applyOperations(scene, [{ op: 'palette_set', id: 'ink', color: '#000000' }]);
  assert.equal(structureHash(paletted), structure);
  assert.notEqual(contentHash(paletted), content);

  const material = applyOperations(scene, [{ op: 'material_set', id: 'stone', value: { diffuse: 0.5 } }]);
  assert.equal(structureHash(material), structure);
  assert.notEqual(contentHash(material), content);

  const nodeMaterial = applyOperations(scene, [{ op: 'node_set', id: 'hull', values: { material: 'wood' } }]);
  assert.equal(structureHash(nodeMaterial), structure);
  assert.notEqual(contentHash(nodeMaterial), content);

  const lit = applyOperations(scene, [{ op: 'light_set', id: 'key', value: { intensity: 2 } }]);
  assert.equal(structureHash(lit), structure);
  assert.notEqual(contentHash(lit), content);

  const ambient = applyOperations(scene, [{ op: 'scene_set', values: { ambient: 0.5 } }]);
  assert.equal(structureHash(ambient), structure);
  assert.notEqual(contentHash(ambient), content);

  const exposure = applyOperations(scene, [{ op: 'scene_set', values: { exposure: 2 } }]);
  assert.equal(structureHash(exposure), structure);
  assert.notEqual(contentHash(exposure), content);
});

test('free layer occupancy and dimensions are structural; RGB alone is not', () => {
  const scene = baseScene();
  const free = applyOperations(scene, [
    { op: 'paint', id: 'decal', ops: [{ op: 'rect', x: 0, y: 0, w: 2, h: 2, color: 'ink' }] }
  ]);
  const freeStructure = structureHash(free);

  const recolored = applyOperations(free, [
    { op: 'paint', id: 'decal', ops: [{ op: 'rect', x: 0, y: 0, w: 2, h: 2, color: 'stone1' }] }
  ]);
  assert.equal(structureHash(recolored), freeStructure);
  assert.notEqual(contentHash(recolored), contentHash(free));

  const occupied = applyOperations(free, [
    { op: 'paint', id: 'decal', ops: [{ op: 'pixels', points: [[2, 2, 'ink']] }] }
  ]);
  assert.notEqual(structureHash(occupied), freeStructure);

  const cleared = applyOperations(free, [
    { op: 'paint', id: 'decal', ops: [{ op: 'clear', x: 0, y: 0, w: 1, h: 1 }] }
  ]);
  assert.notEqual(structureHash(cleared), freeStructure);

  const resized = applyOperations(scene, [
    { op: 'node_set', id: 'decal', values: { width: 16 } }
  ]);
  assert.notEqual(structureHash(resized), structureHash(scene));

  const scaled = applyOperations(scene, [
    { op: 'node_set', id: 'decal', values: { pixelSize: 0.5 } }
  ]);
  assert.notEqual(structureHash(scaled), structureHash(scene));

  const boundResized = applyOperations(scene, [
    { op: 'node_set', id: 'hull-appearance', values: { width: 8 } }
  ]);
  assert.equal(structureHash(boundResized), structureHash(scene));
});

test('contentHash equals the store fingerprint including revision', () => {
  const scene = baseScene();
  assert.equal(contentHash(scene), fingerprint(scene));

  const edited = applyOperations(scene, [
    { op: 'paint', id: 'hull-appearance', ops: [{ op: 'rect', x: 0, y: 0, w: 1, h: 1, color: 'ink' }] }
  ]);
  assert.equal(contentHash(edited), fingerprint(edited));

  const revised = { ...scene, revision: scene.revision + 1 };
  assert.equal(contentHash(revised), fingerprint(revised));
  assert.notEqual(contentHash(revised), contentHash(scene));
});

test('structural edits change structureHash', () => {
  const scene = baseScene();
  const structure = structureHash(scene);

  const resized = applyOperations(scene, [
    { op: 'node_set', id: 'hull', values: { geometry: { type: 'box', center: [0, 1, 0], size: [10, 2, 6] } } }
  ]);
  assert.notEqual(structureHash(resized), structure);

  const moved = applyOperations(scene, [{ op: 'transform', id: 'hull', translate: [1, 0, 0] }]);
  assert.notEqual(structureHash(moved), structure);

  const cameraMoved = applyOperations(scene, [
    { op: 'scene_set', values: { camera: { position: [10, 100, 0] } } }
  ]);
  assert.notEqual(structureHash(cameraMoved), structure);

  const hidden = applyOperations(scene, [{ op: 'node_set', id: 'hull', values: { visible: false } }]);
  assert.notEqual(structureHash(hidden), structure);

  const noShadow = applyOperations(scene, [{ op: 'node_set', id: 'hull', values: { castShadow: false } }]);
  assert.notEqual(structureHash(noShadow), structure);

  const framed = applyOperations(scene, [
    { op: 'node_set', id: 'hull', values: { semanticFrame: { forward: [0, 0, 1], up: [0, 1, 0] } } }
  ]);
  assert.notEqual(structureHash(framed), structure);

  const anchored = applyOperations(scene, [
    { op: 'node_set', id: 'hull', values: { anchors: { center: { point: [0, 2, 0] } } } }
  ]);
  assert.notEqual(structureHash(anchored), structure);

  const rebased = applyOperations(scene, [
    { op: 'node_set', id: 'decal', values: { basis: { u: [1, 0, 0], v: [0, 0, 1] } } }
  ]);
  assert.notEqual(structureHash(rebased), structure);
});

test('viewHash is stable for the same camera and changes with camera or view mode', () => {
  const scene = baseScene();
  const base = viewHash(scene);
  assert.equal(viewHash(scene), base);
  assert.equal(viewHash(scene, { camera: scene.camera }), base);
  assert.equal(viewHash(scene, { camera: { ...scene.camera } }), base);

  const side = { ...scene.camera, position: [100, 0, 0], up: [0, 1, 0] };
  assert.notEqual(viewHash(scene, { camera: side }), base);
  assert.notEqual(viewHash(scene, { mode: 'normals' }), base);
  assert.notEqual(viewHash(scene, { physicalOnly: true }), base);
  assert.notEqual(viewHash(scene, { isolate: 'hull' }), base);
  assert.notEqual(viewHash(scene, { camera: { ...scene.camera, center: [10, 10] } }), base);
  assert.notEqual(viewHash(scene, { camera: { ...scene.camera, pixelsPerUnit: 8 } }), base);

  assert.equal(stableJSON({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('validateObservationCamera accepts the existing orthographic shape and rejects invalid cameras', () => {
  const scene = baseScene();
  const normalized = validateObservationCamera(scene.camera);
  assert.deepEqual(normalized, scene.camera);

  const partial = validateObservationCamera(
    { position: [0, 100, 0], target: [0, 0, 0], up: [0, 0, -1] },
    { width: 64, height: 64 }
  );
  assert.deepEqual(partial, {
    position: [0, 100, 0],
    target: [0, 0, 0],
    up: [0, 0, -1],
    mirrorX: false,
    pixelsPerUnit: 1,
    center: [32, 32]
  });

  assert.throws(() => validateObservationCamera({ ...scene.camera, up: [0, 2, 0] }),
    error => error.code === 'CAMERA_UP');
  assert.throws(() => validateObservationCamera({ ...scene.camera, position: [0, 0, 0], target: [0, 0, 0] }),
    error => error.code === 'CAMERA_BASIS');
  assert.throws(() => validateObservationCamera({ ...scene.camera, projection: 'perspective' }),
    error => error.code === 'OBSERVATION_CAMERA');
  assert.throws(() => validateObservationCamera({ ...scene.camera, center: undefined }),
    error => error.code === 'OBSERVATION_CAMERA');
});

test('flatScene detects scenes without part nodes', () => {
  const empty = createScene({ id: 'flat-empty', width: 16, height: 16 });
  assert.equal(flatScene(empty), true);

  const layered = createScene({
    id: 'flat-layered',
    width: 16,
    height: 16,
    nodes: [
      { id: 'icon', kind: 'layer', width: 16, height: 16, plane: 'xz' },
      { id: 'badge', kind: 'group' }
    ]
  });
  assert.equal(flatScene(layered), true);

  const solid = createScene({
    id: 'solid',
    width: 16,
    height: 16,
    nodes: [{ id: 'box', kind: 'part', geometry: { type: 'box', center: [0, 1, 0], size: [2, 2, 2] } }]
  });
  assert.equal(flatScene(solid), false);

  const hidden = applyOperations(solid, [{ op: 'node_set', id: 'box', values: { visible: false } }]);
  assert.equal(flatScene(hidden), false);
});

test('createObservationReceipt records a deterministic non-delivery observation', () => {
  const scene = baseScene();
  const side = { ...scene.camera, position: [100, 0, 0], up: [0, 1, 0] };
  const options = { camera: side, mode: 'normals', physicalOnly: true, isolate: 'hull' };
  const receipt = createObservationReceipt(scene, options);

  assert.match(receipt.id, /^obs-[0-9a-f]{32}$/);
  assert.equal(receipt.document, scene.id);
  assert.equal(receipt.revision, scene.revision);
  assert.equal(receipt.structureHash, structureHash(scene));
  assert.equal(receipt.contentHash, contentHash(scene));
  assert.equal(receipt.viewHash, viewHash(scene, options));
  assert.deepEqual(receipt.camera, validateObservationCamera(side));
  assert.equal(receipt.mode, 'normals');
  assert.equal(receipt.physicalOnly, true);
  assert.equal(receipt.isolate, 'hull');
  assert.equal(receipt.renderer, RENDERER_SEMVER);
  assert.equal(receipt.delivery, false);
  assert.equal('deliveredTo' in receipt, false);

  const repeat = createObservationReceipt(scene, options);
  assert.equal(repeat.id, receipt.id);

  const differentView = createObservationReceipt(scene, { ...options, mode: 'beauty' });
  assert.notEqual(differentView.id, receipt.id);

  const delivered = createObservationReceipt(scene, {
    deliveredTo: new Set(['agent-b', 'agent-a', 'agent-a'])
  });
  assert.deepEqual(delivered.deliveredTo, ['agent-a', 'agent-b']);

  const explicit = createObservationReceipt(scene, { id: 'obs-explicit' });
  assert.equal(explicit.id, 'obs-explicit');
});

test('deliveryAngleSeparation measures the angle from the delivery view direction', () => {
  const top = { position: [0, 100, 0], target: [0, 0, 0], up: [0, 0, -1] };
  const side = { position: [100, 0, 0], target: [0, 0, 0], up: [0, 1, 0] };
  assert.ok(Math.abs(deliveryAngleSeparation(top, side) - 90) < 1e-9);
  assert.ok(Math.abs(deliveryAngleSeparation(top, { ...top, position: [0, 50, 0] })) < 1e-9);
  assert.ok(Math.abs(deliveryAngleSeparation(top, { ...top, position: [0, -100, 0] }) - 180) < 1e-9);
  assert.ok(Math.abs(deliveryAngleSeparation({ camera: top, nodes: [] }, side) - 90) < 1e-9);
});
