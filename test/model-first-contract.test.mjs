import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {TOOL_SCHEMAS} from '../src/protocol.mjs';
import {GUIDES, WORKFLOW, guide} from '../src/guides.mjs';
import {createScene} from '../src/scene.mjs';
import {structureHash, contentHash, viewHash, flatScene, createObservationReceipt} from '../src/observation.mjs';

/*
 * Focused 0.5.3-dev model-first observation contract. This suite checks the public
 * surface that the service and renderer must satisfy: the additive schema
 * fields, the guide/workflow wording, the README/CONTRACT release contract and
 * the pure observation hash helpers. It does not render art or run the broad
 * scene/renderer suites.
 */

const tools = new Map(TOOL_SCHEMAS.map(tool => [tool.name, tool]));
const render = tools.get('zpixel_render').parameters;
const inspect = tools.get('zpixel_inspect').parameters;
const sceneTool = tools.get('zpixel_scene').parameters;
const exportTool = tools.get('zpixel_export').parameters;
const guideTool = tools.get('zpixel_guide').parameters;
const OBSERVATION_FIELDS = ['camera', 'fit', 'isolate', 'physicalOnly', 'expectedRevision', 'expectedHash'];
const observationCamera = {
  position: [8, 6, 8],
  target: [0, 1, 0],
  up: [0, 1, 0],
  mirrorX: false,
  pixelsPerUnit: 4,
  center: [8, 8]
};

test('render and inspect expose the same optional transient observation fields', () => {
  for (const [name, parameters] of [['zpixel_render', render], ['zpixel_inspect', inspect]]) {
    for (const field of OBSERVATION_FIELDS) {
      assert.ok(parameters.properties[field], `${name}.${field} must be declared`);
      assert.ok(!(parameters.required ?? []).includes(field), `${name}.${field} must stay optional`);
      assert.equal(typeof parameters.properties[field].description, 'string', `${name}.${field} needs a description`);
    }
    assert.equal(parameters.properties.camera, render.properties.camera, `${name}.camera must share the observation camera schema`);
  }

  const camera = render.properties.camera;
  assert.ok(Array.isArray(camera.oneOf) && camera.oneOf.length === 2, 'observation camera must reuse the scene camera oneOf');
  assert.deepEqual(camera.oneOf[0].properties.preset.enum, ['top_down', 'three_quarter']);
  assert.deepEqual(camera.oneOf[1].required, ['position', 'target', 'up']);
  assert.match(camera.description, /transient/i);
  assert.match(camera.description, /orthographic/i);
  assert.match(camera.description, /not perspective/i);
  assert.match(camera.description, /never replaces scene\.camera/i);

  assert.equal(render.properties.fit.type, 'boolean');
  assert.match(render.properties.fit.description, /default true when camera is supplied/i);
  assert.match(render.properties.fit.description, /re-centers the view target and eye/i);
  assert.equal(render.properties.isolate.type, 'string');
  assert.match(render.properties.isolate.description, /source visibility is preserved/i);
  assert.match(render.properties.isolate.description, /visible physical ancestor/i);
  assert.equal(render.properties.physicalOnly.type, 'boolean');
  assert.match(render.properties.physicalOnly.description, /not inherited visibility/i);
  assert.equal(render.properties.expectedRevision.type, 'integer');
  assert.equal(render.properties.expectedHash.type, 'string');
  assert.match(tools.get('zpixel_render').description, /non-delivery observation/i);
  assert.match(tools.get('zpixel_render').description, /delivery:false/i);
  assert.match(tools.get('zpixel_render').description, /even when the camera matches scene\.camera/i);
  assert.match(tools.get('zpixel_inspect').description, /observation view/i);
  assert.match(tools.get('zpixel_inspect').description, /expectedRevision\/expectedHash apply to every kind/i);
  assert.match(tools.get('zpixel_inspect').description, /valid only for view\/pixel\/region\/spatial/i);

  assert.deepEqual(inspect.properties.kind.enum, ['scene', 'tree', 'node', 'find', 'spatial', 'pixel', 'region', 'view', 'theme']);
  assert.match(inspect.properties.kind.description, /view follows the render preview path/i);
  assert.match(inspect.properties.kind.description, /non-delivery observation/i);
});

test('scene preview stays a boolean and documents the automatic working view', () => {
  const sceneInput = sceneTool.properties.scene;
  assert.equal(sceneInput.properties.contract.type, 'string');
  assert.deepEqual(sceneInput.properties.contract.enum, ['model-first/1']);
  assert.ok(!(sceneInput.required ?? []).includes('contract'), 'contract must stay optional for legacy roundtrip');
  assert.match(sceneInput.properties.contract.description, /format-2 snapshot with revision and no contract/i);
  assert.equal(sceneTool.properties.preview.type, 'boolean');
  assert.match(sceneTool.properties.preview.description, /new model-first spatial document/i);
  assert.match(sceneTool.properties.preview.description, /non-delivery physicalOnly working view/i);
  assert.match(sceneTool.properties.preview.description, /not the final delivery preview/i);
  assert.match(sceneTool.properties.preview.description, /Flat-only and legacy documents keep the existing delivery preview/i);
  assert.match(sceneTool.properties.preview.description, /preview\.workingView:true/);
  assert.match(sceneTool.properties.preview.description, /does not fall back to delivery/i);
  assert.ok(!Object.hasOwn(sceneTool.properties, 'previewMode'), 'no new preview enum is added');
});

test('reviewed export exposes a narrow recorded structureReview waiver', () => {
  const waiver = exportTool.properties.structureReview;
  assert.equal(waiver.type, 'object');
  assert.equal(waiver.additionalProperties, false);
  assert.deepEqual(waiver.required, ['waived', 'reason']);
  assert.deepEqual(waiver.properties.waived.enum, [true]);
  assert.equal(waiver.properties.reason.type, 'string');
  assert.match(waiver.description, /never turns a missing observation into a pass/i);
  assert.match(waiver.properties.reason.description, /3-360/);
  assert.match(tools.get('zpixel_export').description, /delivered whole-scene nonparallel observation/i);
  assert.match(tools.get('zpixel_export').description, /status waived, never pass/i);
});

test('observation is a registered guide topic and WORKFLOW stays compact', () => {
  assert.ok(guideTool.properties.topic.enum.includes('observation'));
  assert.deepEqual(Object.keys(GUIDES).sort(), [...guideTool.properties.topic.enum].sort());
  assert.ok(WORKFLOW.length <= 780, `WORKFLOW is ${WORKFLOW.length} chars`);
  for (const phrase of [
    'blockout -> observation -> appearance -> delivery',
    'scene.camera is the one delivery camera',
    'orthographic',
    'not perspective',
    'paint is a surface property, not an object',
    'Flat/legacy skip observation'
  ]) assert.ok(WORKFLOW.includes(phrase), `WORKFLOW must say: ${phrase}`);
  for (const name of ['zpixel_scene', 'zpixel_render', 'zpixel_inspect', 'zpixel_normalmap', 'zpixel_export', 'zpixel_guide', 'zpixel_theme']) {
    assert.ok(WORKFLOW.includes(name), `WORKFLOW must name ${name}`);
  }
});

test('observation guide carries the exact camera, receipt, hash and gate contract', () => {
  const text = guide('observation').text;
  for (const phrase of [
    'blockout -> non-delivery observation -> appearance -> delivery',
    'scene.camera is the single persistent delivery camera',
    'camera:{preset:"top_down"|"three_quarter"}',
    'fit defaults true when camera is supplied and is invalid without camera',
    're-centers the view target and eye',
    'physicalOnly:true',
    'suppresses layer color/alpha, not inherited visibility',
    'isolate:"node-id"',
    'preserves source visibility',
    'hidden target or hidden ancestor rejects',
    'visible physical ancestor',
    'delivery:false',
    'observation:{id,document,revision,structureHash,contentHash,viewHash,camera,mode,physicalOnly,isolate,renderer,deliveredTo}',
    'observationId is an optional top-level alias',
    'A supplied camera is always an observation even when it matches the delivery view',
    'follows the render preview path',
    'view:{camera,mode,physicalOnly,isolate,fit,delivery,deliveryAngleDegrees,separationDegrees,wholeScene,partPixels}',
    'authoring:{contract,structureHash,contentHash,observation,deliveryPreview}',
    'authoring.observation is valid, stale or none',
    'In inspect, the pins apply to every kind',
    'structureHash covers canvas width/height, scene.camera',
    'contentHash is the full stored-scene fingerprint including revision',
    'viewHash covers the normalized camera, mode, isolate and physicalOnly',
    'at least 20 degrees from the delivery viewing axis',
    'parallel and antiparallel do not count',
    '20..160',
    'isolated or zoom-only observation is insufficient',
    'the reviewed export also needs a current delivery beauty preview',
    'the working view does not count as one',
    'contract model-first/1',
    'roundtrips a model-first snapshot',
    'observed, not-observed, flat-only-exempt, legacy-none or waived',
    'reason is 3-360 characters',
    'structureReview:{waived:true,reason:"..."}',
    'scene preview:true on a new spatial document is the automatic working view',
    'preview.workingView:true',
    'NO_VISIBLE_STRUCTURE or WORKING_VIEW_FAILED',
    'does not fall back to the delivery preview',
    'zpixel_scene({action:"create",document:"block"',
    'zpixel_render({document:"block"})',
    'zpixel_export({document:"block",revision:0,draft:true})',
    'not the final delivery preview',
    'not geometric approval',
    'paint is a property of a surface, not an object'
  ]) assert.ok(text.includes(phrase), `observation guide must say: ${phrase}`);
});

test('focused guides keep delivery, observation, paint and fast-path boundaries', () => {
  const camera = guide('camera').text;
  assert.match(camera, /scene\.camera is the one persistent delivery camera/);
  assert.match(camera, /three_quarter and any oblique eye are orthographic parallel-ray views, not perspective/);
  assert.match(camera, /transient camera/);

  const overview = guide('overview').text;
  assert.match(overview, /ZPixel 0\.5\.3-dev/);
  assert.match(overview, /blockout -> non-delivery observation -> appearance -> delivery/);
  assert.match(overview, /preview:true is the automatic working view/);
  assert.match(overview, /not the final delivery preview/);
  assert.match(overview, /Flat-only and legacy documents/);
  assert.match(overview, /paint is a property of a surface, not an object/);

  const painting = guide('painting').text;
  assert.match(painting, /paint is a property of a surface, not an object/);
  assert.match(painting, /bound correctly and still be semantically wrong/);

  assert.match(guide('tools').text, /structureReview/);
  assert.match(guide('tools').text, /never a pass/);
  assert.match(guide('limits').text, /no perspective/);
  assert.match(guide('limits').text, /not geometric correctness or approval/);
  assert.match(guide('migration').text, /legacy-none/);
  assert.match(guide('normalmap').text, /v0\.5\.3-dev-normalmap/);
  assert.match(guide('normalmap').text, /does not accept a transient observation camera/);
});

test('README and CONTRACT state the 0.5.3-dev observation contract while the renderer stays 0.3.6', async () => {
  const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /^# ZPixel 0\.5\.3-dev$/m);
  assert.match(readme, /## Model-First Observation/);
  assert.match(readme, /renderer remains 0\.3\.6/);
  assert.match(readme, /package and service are 0\.5\.3-dev/);
  for (const phrase of [
    'blockout -> non-delivery observation -> appearance -> delivery',
    '`scene.camera` is the single persistent delivery camera',
    'not perspective',
    '`fit`',
    '`isolate`',
    '`physicalOnly`',
    '`expectedRevision`',
    '`expectedHash`',
    '`structureHash`',
    '`contentHash`',
    '`viewHash`',
    '`observationId`',
    'at least 20 degrees from the delivery viewing axis',
    'parallel and antiparallel do not count',
    '20..160',
    'isolated or zoom-only observation is insufficient',
    'delivery:false',
    'supplied camera is always an observation',
    're-centers the view target and eye',
    'Source visibility is preserved',
    'hidden target or hidden ancestor rejects',
    'visible physical ancestor',
    'not inherited visibility',
    'contract `model-first/1`',
    'roundtrips a model-first snapshot',
    'authoring',
    'separationDegrees',
    'flat-only-exempt',
    'legacy-none',
    'waived',
    'countsAsObservation:false',
    'NO_VISIBLE_STRUCTURE',
    'WORKING_VIEW_FAILED',
    '3-360',
    'structureReview:{waived:true,reason:"..."}',
    'preview:true` returns a fitted non-delivery `physicalOnly` working view',
    'not the final delivery preview',
    'paint is a property of a surface, not an object'
  ]) assert.ok(readme.includes(phrase), `README must say: ${phrase}`);

  const contract = await fs.readFile(new URL('../CONTRACT-0.3.md', import.meta.url), 'utf8');
  assert.match(contract, /\*\*Release:\*\* 0\.5\.3-dev/);
  assert.match(contract, /## Model-First Observation \(0\.5\.3-dev\)/);
  for (const phrase of [
    'blockout -> non-delivery observation -> appearance -> delivery',
    '`scene.camera` is the single persistent delivery camera',
    'not perspective',
    '`fit`',
    '`isolate`',
    '`physicalOnly`',
    '`expectedRevision`',
    '`expectedHash`',
    '`structureHash`',
    '`contentHash`',
    '`viewHash`',
    '`observationId`',
    'at least 20 degrees from the delivery viewing axis',
    'parallel and antiparallel do not count',
    '20..160',
    'isolated or zoom-only observation is insufficient',
    'delivery:false',
    'supplied camera is always an observation',
    're-centers the view target and eye',
    'Source visibility is preserved',
    'hidden target or hidden ancestor rejects',
    'visible physical ancestor',
    'not inherited visibility',
    'contract `model-first/1`',
    'roundtrips a model-first snapshot',
    'authoring',
    'separationDegrees',
    'flat-only-exempt',
    'legacy-none',
    'waived',
    'countsAsObservation:false',
    'NO_VISIBLE_STRUCTURE',
    'WORKING_VIEW_FAILED',
    '3-360',
    'structureReview:{waived:true,reason:"..."}',
    'preview:true` returns a fitted non-delivery `physicalOnly` working view',
    'not the final delivery preview',
    'paint is a property of a surface, not an object'
  ]) assert.ok(contract.includes(phrase), `CONTRACT must say: ${phrase}`);
});

test('observation helpers hash physical structure and view identity, not paint', () => {
  const base = createScene({
    id: 'obs-contract',
    width: 16,
    height: 16,
    camera: {preset: 'top_down'},
    nodes: [
      {id: 'root', kind: 'group'},
      {id: 'box', kind: 'part', parent: 'root', geometry: {type: 'box', center: [0, 1, 0], size: [2, 2, 2]}},
      {id: 'paint', kind: 'layer', parent: 'root', width: 2, height: 2, pixels: ['#ff0000', null, null, null]}
    ]
  });
  const painted = {...base, nodes: base.nodes.map(node => node.id === 'paint' ? {...node, pixels: ['#00ff00', null, null, null]} : node)};
  assert.equal(structureHash(base), structureHash(painted), 'RGB-only paint must not change structureHash');
  const occupied = {...base, nodes: base.nodes.map(node => node.id === 'paint' ? {...node, pixels: ['#ff0000', '#00ff00', null, null]} : node)};
  assert.notEqual(structureHash(base), structureHash(occupied), 'null/non-null occupancy must change structureHash');

  const moved = {...base, nodes: base.nodes.map(node => node.id === 'box' ? {...node, transform: {...node.transform, position: [1, 0, 0]}} : node)};
  assert.notEqual(structureHash(base), structureHash(moved), 'transform must change structureHash');
  assert.notEqual(structureHash(base), structureHash({...base, width: 32}), 'canvas must change structureHash');
  assert.notEqual(structureHash(base), structureHash({...base, camera: {...base.camera, position: [1, 100, 0]}}), 'scene.camera must change structureHash');
  assert.notEqual(contentHash(base), contentHash({...base, revision: base.revision + 1}), 'revision must change contentHash');

  const viewA = viewHash(base, {camera: observationCamera, mode: 'normals', physicalOnly: true});
  const viewB = viewHash(base, {camera: observationCamera, mode: 'normals', physicalOnly: true});
  assert.equal(viewA, viewB, 'identical views must hash identically');
  assert.notEqual(viewA, viewHash(base, {camera: observationCamera, mode: 'depth', physicalOnly: true}), 'mode must change viewHash');
  assert.notEqual(viewA, viewHash(base, {camera: observationCamera, mode: 'normals', physicalOnly: false}), 'physicalOnly must change viewHash');

  assert.equal(flatScene(base), false);
  assert.equal(flatScene(createScene({id: 'flat', nodes: [{id: 'root', kind: 'group'}, {id: 'paint', kind: 'layer', width: 2, height: 2}]})), true);

  const receipt = createObservationReceipt(base, {camera: observationCamera, mode: 'normals', physicalOnly: true});
  assert.equal(receipt.delivery, false);
  assert.match(receipt.id, /^obs-[0-9a-f]{32}$/);
  assert.match(receipt.structureHash, /^[0-9a-f]{64}$/);
  assert.match(receipt.contentHash, /^[0-9a-f]{64}$/);
  assert.match(receipt.viewHash, /^[0-9a-f]{64}$/);
  assert.equal(receipt.mode, 'normals');
  assert.equal(receipt.physicalOnly, true);
  assert.equal(receipt.isolate, null);
  assert.deepEqual(receipt.camera, observationCamera);
});
