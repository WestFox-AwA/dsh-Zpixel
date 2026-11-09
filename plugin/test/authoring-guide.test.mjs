import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {guide, GUIDES, WORKFLOW} from '../src/guides.mjs';
import {TOOL_SCHEMAS} from '../src/protocol.mjs';
import {applyOperations, createScene} from '../src/scene.mjs';
import {compileWorld} from '../src/world.mjs';
import {renderScene} from '../src/renderer.mjs';
import {spatialReport} from '../src/spatial.mjs';

const registeredTopics = TOOL_SCHEMAS.find(schema => schema.name === 'zpixel_guide').parameters.properties.topic.enum;

function parseCall(text, name, occurrence = 0) {
  const lines = text.split('\n').filter(candidate => candidate.startsWith(`${name}(`));
  const line = lines[occurrence];
  assert.ok(line, `guide must contain ${name}(...) call ${occurrence + 1}`);
  assert.ok(line.endsWith(')'), `${name} example must be one complete call`);
  return Function(`return (${line.slice(name.length + 1, -1)})`)();
}

test('workflow is a first-use map for coordinates, representation choice, guide use and store safety', () => {
  for (const tool of ['zpixel_scene', 'zpixel_render', 'zpixel_inspect', 'zpixel_normalmap', 'zpixel_export', 'zpixel_guide', 'zpixel_theme']) {
    assert.ok(WORKFLOW.includes(tool), `WORKFLOW must name ${tool}`);
  }
  assert.match(WORKFLOW, /right-handed/i);
  assert.match(WORKFLOW, /\+Y up/i);
  assert.match(WORKFLOW, /XZ ground/i);
  assert.match(WORKFLOW, /\+X map-right/i);
  assert.match(WORKFLOW, /no implied front/i);
  assert.match(WORKFLOW, /PTC\/run_code/);
  assert.match(WORKFLOW, /await tools\.zpixel_/);
  assert.match(WORKFLOW, /Solid parts when/i);
  assert.match(WORKFLOW, /painted layers for fixed-view detail/i);
  assert.match(WORKFLOW, /not every sprite needs 3D/i);
  assert.match(WORKFLOW, /Parent each meaningful subsystem/i);
  assert.match(WORKFLOW, /after create\/attach/);
  assert.match(WORKFLOW, /Never hand-edit \.zpixel\/documents/);
  assert.match(WORKFLOW, /unique document\/txid/);

  const referencedTopics = [...WORKFLOW.matchAll(/topic:'([a-z]+)'/g)].map(match => match[1]);
  assert.ok(referencedTopics.length > 0, 'WORKFLOW must point at the guide starter');
  for (const topic of referencedTopics) {
    assert.ok(registeredTopics.includes(topic), `WORKFLOW references unregistered guide topic ${topic}`);
  }
  for (const topic of Object.keys(GUIDES)) {
    assert.ok(registeredTopics.includes(topic), `GUIDES.${topic} is not in the zpixel_guide topic enum`);
  }
});

test('workflow stays a compact first-use map, not a copy of the guide', () => {
  assert.ok(WORKFLOW.length <= 780, `WORKFLOW is ${WORKFLOW.length} chars; keep detail in overview/lighting`);
  assert.ok(!/zpixel_scene\(\{/.test(WORKFLOW), 'runnable snippets belong in overview/lighting, not WORKFLOW');
});

test('README shows 0.5.3-dev status, normal-map limits, keeps old verification as history and points at the guide', async () => {
  const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /^# ZPixel 0\.5\.3-dev$/m);
  assert.match(readme, /\[VERIFICATION-0\.3\.3\.md\]\(VERIFICATION-0\.3\.3\.md\)/);
  assert.match(readme, /\[VERIFICATION-0\.3\.2\.md\]\(VERIFICATION-0\.3\.2\.md\)/);
  assert.match(readme, /\[VERIFICATION-0\.3\.md\]\(VERIFICATION-0\.3\.md\)/);
  assert.match(readme, /historical/i);
  assert.match(readme, /zpixel_guide/);
  assert.match(readme, /zpixel_normalmap/);
  assert.match(readme, /128,128,255/);
  assert.match(readme, /nearest filtering/i);
  assert.match(readme, /one flat normal/);
  assert.match(readme, /double-light/);
  assert.match(readme, /No Godot import was tested/);
  assert.match(readme, /\{id:"yard",name:"Yard",kind:"group"\}/);
  assert.match(readme, /target:\[-2,1,0\],pixelsPerUnit:4/);
  assert.match(readme, /material:"wood"/);
  assert.equal((readme.match(/parent:"yard"/g) ?? []).length, 2, 'README wall and gate must both parent to yard');
});

test('overview starter builds a parent group with parts, local anchors, one relation and spatial inspection', () => {
  const text = guide('overview').text;
  assert.match(text, /ZPixel 0\.5\.3-dev/);
  assert.match(text, /optional scene\.format.*does not change create defaults/i);
  assert.match(text, /snapshot revision is validated and reset to 0/i);
  assert.match(text, /await tools\.zpixel_\*/);

  const create = parseCall(text, 'zpixel_scene');
  assert.equal(create.action, 'create');
  assert.equal(create.document, 'yard');
  assert.equal(create.preview, true);
  assert.ok(!('format' in create.scene), 'starter must stay on the partial create path (no scene.format)');

  const input = create.scene;
  const nodes = new Map(input.nodes.map(node => [node.id, node]));
  const yard = nodes.get('yard');
  assert.ok(yard, 'starter must define the parent group');
  assert.equal(yard.kind, 'group');
  assert.ok(yard.parent === undefined || yard.parent === 'root', 'the parent group is top-level in the starter');

  for (const id of ['wall', 'gate']) {
    const part = nodes.get(id);
    assert.ok(part, `starter must define ${id}`);
    assert.equal(part.kind, 'part');
    assert.equal(part.parent, 'yard');
    assert.ok(part.geometry, `${id} must be solid geometry`);
  }
  assert.deepEqual(nodes.get('wall').anchors.hinge.point, [-4, 1, 0]);
  assert.deepEqual(nodes.get('gate').anchors.hinge.point, [-4, 1, 0]);
  assert.deepEqual(nodes.get('gate').anchors.hinge.axis, [0, 1, 0]);

  assert.equal(input.spatialRelations.length, 1);
  const edge = input.spatialRelations[0];
  assert.equal(edge.id, 'gate-hinge');
  assert.equal(edge.relation, 'coaxial');
  assert.deepEqual(edge.from, {node: 'gate', anchor: 'hinge'});
  assert.deepEqual(edge.to, {node: 'wall', anchor: 'hinge'});

  const inspect = parseCall(text, 'zpixel_inspect');
  assert.equal(inspect.document, 'yard');
  assert.equal(inspect.kind, 'spatial');
  assert.equal(inspect.node, 'gate');
  assert.equal(inspect.other, 'wall');

  const scene = createScene({...input, id: create.document});
  assert.equal(scene.nodes.find(node => node.id === 'gate').parent, 'yard');
  assert.equal(scene.nodes.find(node => node.id === 'gate').material, 'wood');

  const image = renderScene(scene);
  const nodePixels = id => image.hits.filter(hit => hit?.nodeId === id).length;
  assert.ok(nodePixels('wall') > 0, 'starter preview must show the wall');
  assert.ok(nodePixels('gate') > 0, 'starter preview must show the gate');
  assert.ok(image.colorsUsed.length >= 2, 'starter render must show fill colors, not only outline ink');
  assert.ok(image.stats.outlined < image.stats.visiblePixels, 'outline must not cover every visible pixel');
  const visibleX = image.hits.flatMap((hit, index) => hit && ['wall', 'gate'].includes(hit.nodeId) ? [index % image.width] : []);
  const visibleY = image.hits.flatMap((hit, index) => hit && ['wall', 'gate'].includes(hit.nodeId) ? [Math.floor(index / image.width)] : []);
  assert.ok(Math.min(...visibleX) >= 4, 'starter must fit horizontally with margin');
  assert.ok(Math.max(...visibleX) <= image.width - 5, 'starter must fit horizontally with margin');
  assert.ok(Math.min(...visibleY) >= 4, 'starter must fit vertically with margin');
  assert.ok(Math.max(...visibleY) <= image.height - 5, 'starter must fit vertically with margin');

  const gate = spatialReport(scene, {node: 'gate', other: 'wall'}).nodes[0];
  assert.equal(gate.intent.length, 1);
  assert.equal(gate.intent[0].intent.id, 'gate-hinge');
  assert.equal(gate.intent[0].verdict, 'met');
  assert.equal(gate.intent[0].observation.method, 'named-anchor-axes');
  assert.ok(
    gate.worldObservations.items.some(item => item.node === 'wall'),
    'spatial inspection must report measured evidence separately from the declared relation'
  );

  const edit = parseCall(text, 'zpixel_scene', 1);
  assert.equal(edit.action, 'edit');
  assert.equal(edit.document, 'yard');
  assert.equal(edit.revision, scene.revision, 'the example must use the current revision');
  assert.deepEqual(edit.ops, [{op: 'transform', id: 'yard', translate: [1, 0, 0]}]);
  assert.match(text, /Both parts and paint layers move with the parent; inspect again/i);

  const centerX = entry => (entry.bounds.min[0] + entry.bounds.max[0]) / 2;
  const before = compileWorld(scene).entries;
  assert.equal(centerX(before.get('wall')), 0);
  assert.equal(centerX(before.get('gate')), -6);

  const moved = applyOperations(scene, edit.ops);
  const after = compileWorld(moved).entries;
  assert.equal(centerX(after.get('wall')), 1, 'the wall must inherit the parent translate');
  assert.equal(centerX(after.get('gate')), -5, 'the gate must inherit the same parent translate');
  assert.equal(after.get('wall').node.parent, 'yard');
  assert.equal(after.get('gate').node.parent, 'yard');
  const movedGate = spatialReport(moved, {node: 'gate', other: 'wall'}).nodes[0];
  assert.equal(movedGate.intent[0].verdict, 'met', 'parent motion preserves the relative relation');
});

test('lighting topic gives exact ramp/material fields and white-only light', () => {
  const text = guide('lighting').text;
  assert.match(text, /white light/i);
  assert.match(text, /#ffffff/);
  assert.match(text, /0\.0001/);
  assert.match(text, /\b16\b/);
  assert.match(text, /stops ascend/i);
  assert.ok(
    text.includes("{response:1,stops:[{at:0,color:'dark'},{at:1,color:'light'}]}"),
    'lighting guide must carry the exact minimal ramp literal'
  );
  assert.ok(
    text.includes("{ramp:'stone',diffuse:1,emission:0,specular:0,roughness:0.5}"),
    'lighting guide must carry the exact minimal material literal'
  );
  for (const field of ['ramp', 'diffuse', 'emission', 'specular', 'roughness']) {
    assert.ok(text.includes(field), `lighting guide must name material.${field}`);
  }

  const scene = createScene({
    id: 'lighting-guide',
    palette: {dark: '#20242c', light: '#c8d2dc'},
    ramps: {stone: {response: 1, stops: [{at: 0, color: 'dark'}, {at: 1, color: 'light'}]}},
    materials: {stone: {ramp: 'stone', diffuse: 1, emission: 0, specular: 0, roughness: 0.5}},
    nodes: [{id: 'root', kind: 'group'}]
  });
  assert.equal(scene.ramps.stone.response, 1);
  assert.deepEqual(scene.ramps.stone.stops.map(stop => stop.at), [0, 1]);
  assert.equal(scene.materials.stone.ramp, 'stone');
  assert.equal(scene.materials.stone.roughness, 0.5);
  assert.equal(scene.lights[0].color, '#ffffff');

  assert.throws(
    () => createScene({
      id: 'ramp-response',
      ramps: {stone: {response: 0, stops: [{at: 0, color: '#ffffff'}]}},
      nodes: [{id: 'root', kind: 'group'}]
    }),
    error => {
      assert.match(error.message, /between 0\.0001 and 16/);
      return true;
    }
  );
});

test('normalmap guide carries sprite-local conventions, policies and preview/export calls', () => {
  const text = guide('normalmap').text;
  assert.match(text, /sprite-local/i);
  assert.match(text, /alpha identical/i);
  assert.match(text, /opengl/);
  assert.match(text, /directx/);
  assert.match(text, /128,128,255/);
  assert.match(text, /linear, non-color/i);
  assert.match(text, /nearest filtering/i);
  assert.match(text, /one flat normal/i);
  assert.match(text, /not recovered 3D/i);
  assert.match(text, /neutral view normal/i);
  assert.match(text, /normal\.png/);
  assert.match(text, /sprite\.png/);
  assert.match(text, /normalmap\.json/);
  assert.match(text, /v0\.5\.3-dev-normalmap/);
  assert.match(text, /not aesthetic certification/i);

  const calls = text.split('\n').filter(line => line.startsWith('zpixel_normalmap('));
  assert.equal(calls.length, 2, 'guide must carry one preview and one export call');
  const parse = line => {
    assert.ok(line.endsWith(')'), 'normalmap example must be one complete call');
    return Function(`return (${line.slice('zpixel_normalmap('.length, -1)})`)();
  };
  assert.deepEqual(parse(calls[0]), {document: 'yard', convention: 'opengl'});
  const exported = parse(calls[1]);
  assert.equal(exported.document, 'yard');
  assert.equal(exported.revision, 1);
  assert.equal(exported.convention, 'directx');
  assert.equal(exported.scale, 4);
  assert.equal(exported.export, true);
});

test('painted layers stay explicitly unlit, volume-free and optional', () => {
  const overview = guide('overview').text;
  assert.match(overview, /layer = authored unlit pixels/i);
  assert.match(overview, /no volume/i);
  assert.match(overview, /may mix solid parts with painted detail/i);
  assert.match(overview, /not every sprite needs 3D/i);
  assert.ok(
    !/(all|every) (assets?|sprites?) (must|need to) (be )?(3D|solid)/i.test(overview),
    'overview must not claim every sprite needs solid 3D geometry'
  );

  const painting = guide('painting').text;
  assert.match(painting, /unlit/i);
  assert.match(painting, /no solid geometry/i);
});
