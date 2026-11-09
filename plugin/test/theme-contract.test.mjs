import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { TOOL_SCHEMAS, toolDefinitions } from '../src/protocol.mjs';
import { WORKFLOW, GUIDES, guide, THEME_EXAMPLE, THEME_EXAMPLE_REVISED } from '../src/guides.mjs';
import { normalizeTheme, validateTheme, themeHash, validateThemeContext, validateThemeBinding } from '../src/theme-model.mjs';
import { compileTheme, readThemePack } from '../src/theme-runtime.mjs';

/*
 * Focused 0.4.0 theme contract. This test deliberately consumes the executable
 * definition and call sequence published in zpixel_guide topic:'theme' instead
 * of keeping a second private copy. It checks the public schema, the documented
 * revision sequence, canonical/hash/binding behavior, unsupported-token
 * reporting and the docs that must stay aligned with the guide.
 */

const tool = name => TOOL_SCHEMAS.find(candidate => candidate.name === name);
const themeTool = () => tool('zpixel_theme');
const sceneTool = () => tool('zpixel_scene');
const guideTopics = () => tool('zpixel_guide').parameters.properties.topic.enum;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function parseCall(line, name) {
  assert.ok(line.startsWith(`${name}(`), `expected a ${name} call`);
  assert.ok(line.endsWith(')'), `${name} call must be one complete expression`);
  return Function(`return (${line.slice(name.length + 1, -1)})`)();
}

function calls(text, name) {
  return text.split('\n').filter(line => line.startsWith(`${name}(`)).map(line => parseCall(line, name));
}

function assertValue(value, schema, path) {
  if (schema == null || Object.keys(schema).length === 0) return;
  if (schema.oneOf) {
    const candidates = schema.oneOf.filter(branch => {
      if (value === null) return branch.type === 'null';
      if (typeof value !== 'object' || Array.isArray(value)) return false;
      if (branch.type !== 'object') return false;
      if ((branch.required ?? []).some(key => !Object.hasOwn(value, key))) return false;
      if (branch.properties?.type?.enum) return branch.properties.type.enum.includes(value.type);
      if (branch.properties?.preset?.enum) return branch.properties.preset.enum.includes(value.preset);
      if (branch.properties?.id) return Object.hasOwn(value, 'id');
      return false;
    });
    assert.equal(candidates.length, 1, `${path} must match exactly one oneOf branch; got ${candidates.length}`);
    assertValue(value, candidates[0], path);
    return;
  }
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path} must be one of ${schema.enum.join(', ')}`);
  switch (schema.type) {
    case 'object': {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${path} must be an object`);
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${path}.${key} is required`);
      for (const [key, child] of Object.entries(value)) {
        if (Object.hasOwn(properties, key)) assertValue(child, properties[key], `${path}.${key}`);
        else assert.notEqual(schema.additionalProperties, false, `${path}.${key} is not declared by the tool schema`);
      }
      break;
    }
    case 'array': {
      assert.ok(Array.isArray(value), `${path} must be an array`);
      if (schema.items) value.forEach((entry, index) => assertValue(entry, schema.items, `${path}[${index}]`));
      break;
    }
    case 'string': assert.equal(typeof value, 'string', `${path} must be a string`); break;
    case 'integer': assert.ok(Number.isInteger(value), `${path} must be an integer`); break;
    case 'number': assert.equal(typeof value, 'number', `${path} must be a number`); break;
    case 'boolean': assert.equal(typeof value, 'boolean', `${path} must be a boolean`); break;
    case 'null': assert.equal(value, null, `${path} must be null`); break;
    default: break;
  }
}

test('theme tool exposes exactly four actions and the shared typed fields', () => {
  assert.equal(TOOL_SCHEMAS.length, 7, '0.4.0 exposes seven native tools');
  assert.deepEqual(TOOL_SCHEMAS.map(candidate => candidate.name).sort(), [
    'zpixel_export', 'zpixel_guide', 'zpixel_inspect', 'zpixel_normalmap', 'zpixel_render', 'zpixel_scene', 'zpixel_theme'
  ]);
  const parameters = themeTool().parameters;
  assert.deepEqual(parameters.properties.action.enum, ['add', 'read', 'list', 'revise']);
  for (const field of ['theme', 'revision', 'expected_revision', 'spec', 'txid', 'context', 'view', 'sections', 'reference', 'offset', 'limit', 'query']) {
    assert.ok(Object.hasOwn(parameters.properties, field), `zpixel_theme must expose ${field}`);
  }
  assert.equal(parameters.properties.theme.type, 'string');
  assert.equal(parameters.properties.revision.type, 'integer');
  assert.equal(parameters.properties.expected_revision.type, 'integer');
  assert.equal(parameters.properties.txid.type, 'string');
  assert.equal(parameters.properties.reference.type, 'string');
  assert.deepEqual(parameters.properties.view.enum, ['working', 'full']);
  assert.equal(parameters.properties.sections.type, 'array');
  assert.equal(parameters.properties.sections.items.type, 'string');
  assert.equal(parameters.properties.offset.type, 'integer');
  assert.equal(parameters.properties.limit.type, 'integer');
  assert.equal(parameters.properties.query.type, 'string');
  assert.ok(!Object.hasOwn(parameters.properties, 'document'), 'v1 read does not resolve a scene document');

  const spec = parameters.properties.spec;
  assert.equal(spec.type, 'object');
  assert.equal(spec.additionalProperties, false);
  assert.deepEqual(spec.required, ['title', 'summary']);
  for (const field of ['title', 'summary', 'tags', 'signature', 'language', 'tokens', 'rules', 'adaptations', 'references', 'source']) {
    assert.ok(Object.hasOwn(spec.properties, field), `theme spec must expose ${field}`);
  }
  for (const forbidden of ['format', 'id', 'revision', 'hash']) {
    assert.ok(!Object.hasOwn(spec.properties, forbidden), `theme spec must not accept author ${forbidden}`);
  }
  assert.equal(spec.properties.language.additionalProperties, false);
  assert.equal(spec.properties.tokens.additionalProperties, false);
  assert.deepEqual(spec.properties.rules.items.properties.strength.enum, ['must', 'should', 'must_not']);
  assert.ok(spec.properties.rules.items.properties.check.properties.kind.enum.includes('visual'));
  assert.ok(spec.properties.rules.items.properties.check.properties.kind.enum.includes('unsupported'));

  const context = parameters.properties.context;
  assert.equal(context.type, 'object');
  assert.equal(context.additionalProperties, false);
  assert.equal(context.properties.nativeSize.items.type, 'integer');
  assert.deepEqual(context.properties.view.enum, ['top_down', 'three_quarter']);
  assert.ok(context.properties.channels.items.enum.includes('normalmap'));

  const sceneParameters = sceneTool().parameters;
  const theme = sceneParameters.properties.theme;
  assert.equal(theme.oneOf.length, 2);
  const binding = theme.oneOf.find(branch => branch.type === 'object');
  const detach = theme.oneOf.find(branch => branch.type === 'null');
  assert.ok(binding && detach, 'scene theme must be an object or null');
  assert.deepEqual(binding.required, ['id', 'revision']);
  for (const field of ['id', 'revision', 'hash', 'context', 'applyDefaults', 'bindings', 'overwrite', 'replace', 'overrides']) {
    assert.ok(Object.hasOwn(binding.properties, field), `scene theme binding must expose ${field}`);
  }
  assert.equal(binding.properties.applyDefaults.type, 'boolean');
  assert.deepEqual(binding.properties.bindings.items.required, ['node']);
  assert.deepEqual(binding.properties.bindings.items.properties.outline.type, 'boolean');
  assert.deepEqual(binding.properties.bindings.items.properties.appearanceShading.type, 'boolean');
  assert.deepEqual(binding.properties.overrides.items.required, ['rule', 'reason']);
  const snapshot = sceneParameters.properties.scene.properties.theme;
  assert.equal(snapshot.type, 'object');
  assert.equal(snapshot.additionalProperties, true, 'scene.theme is a descriptive canonical snapshot');
  assert.ok(tool('zpixel_inspect').parameters.properties.kind.enum.includes('theme'));
  assert.ok(guideTopics().includes('theme'));

  const definitions = toolDefinitions({});
  const themeDefinition = definitions.find(definition => definition.name === 'zpixel_theme');
  assert.equal(themeDefinition.isConcurrencySafe({ action: 'read' }), true);
  assert.equal(themeDefinition.isConcurrencySafe({ action: 'list' }), true);
  assert.equal(themeDefinition.isConcurrencySafe({ action: 'add' }), false);
  assert.equal(themeDefinition.isConcurrencySafe({ action: 'revise' }), false);
});

test('the guide definition is executable, canonical and hash-stable', () => {
  const text = guide('theme').text;
  assert.ok(Object.hasOwn(GUIDES, 'theme'));
  assert.ok(guideTopics().includes('theme'));
  const add = calls(text, 'zpixel_theme').find(call => call.action === 'add');
  assert.ok(add, 'theme guide must contain an add call');
  assert.equal(add.theme, 'soft-workshop');
  assert.equal(add.txid, 'soft-workshop-add');
  assert.deepEqual(add.spec, THEME_EXAMPLE, 'the guide add spec must be the published example');

  const theme0 = normalizeTheme(add.spec, { id: add.theme, revision: 0 });
  assert.equal(theme0.format, 'dsh-zpixel-theme/1');
  assert.equal(theme0.id, 'soft-workshop');
  assert.equal(theme0.revision, 0);
  assert.equal(theme0.title, 'Soft workshop');
  assert.ok(theme0.tags.length > 0);
  assert.ok(theme0.signature.every(id => theme0.rules.some(rule => rule.id === id)), 'signature must reference existing rules');
  assert.equal(validateTheme(theme0), theme0, 'validateTheme must be pure and return the same canonical object');

  const hash0 = themeHash(theme0);
  assert.match(hash0, /^[0-9a-f]{64}$/, 'theme hashes are bare hex64');
  const reordered = Object.fromEntries(Object.entries(add.spec).reverse());
  assert.equal(themeHash(normalizeTheme(reordered, { id: 'soft-workshop', revision: 0 })), hash0, 'hash must not depend on key order');
  assert.equal(themeHash(normalizeTheme(deepFreeze(structuredClone(add.spec)), { id: 'soft-workshop', revision: 0 })), hash0, 'normalization must not mutate or reject deep-frozen input');

  const context = validateThemeContext({ assetClass: 'prop', nativeSize: [32, 32], view: 'top_down', channels: ['beauty', 'normalmap'] });
  assert.deepEqual(context, { assetClass: 'prop', nativeSize: [32, 32], view: 'top_down', channels: ['beauty', 'normalmap'] });

  const compiled = compileTheme(theme0, context);
  assert.deepEqual(Object.keys(compiled).sort(), ['capabilities', 'defaults', 'namespace']);
  assert.equal(compiled.namespace.prefix, 'theme.soft-workshop.');
  assert.equal(compiled.defaults.defaultMaterial, 'theme.soft-workshop.wood');
  assert.equal(compiled.defaults.outline.color, 'theme.soft-workshop.ink');
  assert.equal(compiled.defaults.outline.width, 1);
  assert.equal(compiled.defaults.camera.preset, 'top_down');
  assert.equal(compiled.defaults.camera.pixelsPerUnit, 4);
  assert.equal(compiled.defaults.appearanceShading, 'unlit');
  assert.equal(compiled.defaults.lights.length, 1);
  assert.equal(compiled.defaults.lights[0].color, '#ffffff');
  assert.equal(compiled.defaults.lights[0].direction.length, 3);
  for (const key of Object.keys(compiled.defaults.palette)) assert.ok(key.startsWith('theme.soft-workshop.'), `${key} must be namespaced`);
  assert.equal(compiled.defaults.palette['theme.soft-workshop.ink'].toLowerCase(), add.spec.tokens.colors.ink.value.toLowerCase());
  assert.deepEqual(compiled.capabilities.unsupported, [], 'the published example must be fully supported');
  assert.ok(compiled.capabilities.supported.length > 0);
  assert.ok(!('nodes' in compiled.defaults) && !('pixels' in compiled.defaults), 'compilation must not add geometry or pixels');

  const pack = readThemePack(theme0, context);
  assert.equal(pack.identity.id, 'soft-workshop');
  assert.equal(pack.identity.revision, 0);
  assert.equal(pack.identity.hash, hash0);
  assert.equal(pack.brief, add.spec.summary);
  assert.deepEqual([...pack.hardRuleIds].sort(), ['alpha.binary', 'canvas.margin', 'canvas.size', 'edge.ink', 'light.one', 'mass.primary', 'shade.unlit']);
  assert.ok(!pack.hardRuleIds.includes('palette.prefer'), 'should rules are advisory, not hard rules');
  assert.ok(pack.reviewChecklist.mechanical.every(entry => entry.status !== 'pass'), 'read must not claim a mechanical pass without a scene');
  assert.equal(pack.evaluation, 'pending');
  assert.match(pack.note, /no scene|not a compliance pass|pending/i);
  assert.ok(pack.capabilities && Array.isArray(pack.capabilities.supported));

  const binding = { id: theme0.id, revision: 0, hash: hash0, adapterVersion: '1', snapshot: theme0, context, overrides: [] };
  assert.equal(validateThemeBinding(binding), binding);
  assert.throws(() => validateThemeBinding({ ...binding, hash: '0'.repeat(64) }), /hash/i);
  assert.throws(() => validateThemeBinding({ ...binding, overrides: [{ rule: 'missing.rule', reason: 'x' }] }), /unknown rule/i);

  const revisedCall = calls(text, 'zpixel_theme').find(call => call.action === 'revise');
  assert.ok(revisedCall, 'theme guide must contain a revise call');
  assert.equal(revisedCall.expected_revision, 0);
  assert.deepEqual(revisedCall.spec, THEME_EXAMPLE_REVISED);
  const theme1 = normalizeTheme(revisedCall.spec, { id: 'soft-workshop', revision: 1 });
  assert.equal(theme1.revision, 1);
  assert.notEqual(themeHash(theme1), hash0, 'a revision must change the hash');
  assert.equal(themeHash(theme0), hash0, 'the old revision must stay immutable');
});

test('guide calls stay inside the published schemas and use an accurate revision sequence', () => {
  const text = guide('theme').text;
  for (const name of ['zpixel_theme', 'zpixel_scene', 'zpixel_inspect', 'zpixel_render', 'zpixel_export']) {
    const published = calls(text, name);
    assert.ok(published.length > 0, `theme guide must contain ${name} calls`);
    for (const call of published) assertValue(call, tool(name).parameters, name);
  }

  const add = calls(text, 'zpixel_theme').find(call => call.action === 'add');
  assert.equal(add.spec.format, undefined);
  assert.equal(add.spec.id, undefined);
  assert.equal(add.spec.revision, undefined);

  const sceneCalls = calls(text, 'zpixel_scene');
  assert.equal(sceneCalls.length, 4, 'create, bind, rebind and detach are the documented scene sequence');
  const [create, bind, rebind, detach] = sceneCalls;
  assert.equal(create.action, 'create');
  assert.equal(create.document, 'crate');
  assert.equal(create.theme.id, 'soft-workshop');
  assert.equal(create.theme.revision, 0);
  assert.deepEqual(create.theme.context.nativeSize, [32, 32]);
  assert.equal(create.scene.width, 32);
  assert.equal(create.scene.height, 32);
  const nodes = new Map(create.scene.nodes.map(node => [node.id, node]));
  assert.equal(nodes.get('crate').kind, 'part');
  const label = nodes.get('crate-label');
  assert.equal(label.kind, 'layer');
  assert.equal(label.parent, 'crate');
  assert.equal(label.appearanceOf, 'crate');
  assert.equal(label.pixels.length, 16);
  assert.ok(label.pixels.every(pixel => pixel === null || pixel === 'theme.soft-workshop.accent'), 'painted pixels must use the namespaced palette id');

  assert.equal(bind.action, 'edit');
  assert.equal(bind.revision, 0);
  assert.equal(bind.theme.revision, 0);
  assert.deepEqual(bind.theme.bindings.map(entry => entry.node), ['crate', 'crate-label']);
  assert.equal(bind.theme.bindings[0].material, 'wood');
  assert.equal(bind.theme.bindings[0].outline, true);
  assert.equal(bind.theme.bindings[1].appearanceShading, true);

  assert.equal(rebind.action, 'edit');
  assert.equal(rebind.revision, 1);
  assert.equal(rebind.theme.revision, 1);
  assert.equal(rebind.theme.applyDefaults, true);
  assert.equal(rebind.theme.replace, true);
  assert.equal(rebind.theme.overwrite, true);

  assert.equal(detach.action, 'edit');
  assert.equal(detach.revision, 2);
  assert.equal(detach.theme, null);

  const inspect = calls(text, 'zpixel_inspect')[0];
  assert.equal(inspect.document, 'crate');
  assert.equal(inspect.kind, 'theme');
  assert.equal(calls(text, 'zpixel_render')[0].document, 'crate');
  const exports = calls(text, 'zpixel_export');
  assert.equal(exports.length, 2);
  assert.deepEqual([exports[0].revision, exports[0].draft], [1, true]);
  assert.equal(exports[1].revision, 1);
  assert.equal(exports[1].draft, false);
  assert.equal(exports[1].review.identity, true);
  assert.equal(exports[1].review.nativeReadable, true);
  assert.equal(exports[1].review.lighting, true);
  assert.ok(exports[1].review.note.length >= 3 && exports[1].review.note.length <= 360);
});

test('theme guide documents evidence, strict checks, exact palette/lit, unsupported tokens and snapshots', () => {
  const text = guide('theme').text;
  for (const pattern of [
    /reference-based/i, /concept-based/i, /observations/i, /inferences/i, /decisions/i, /unknowns/i,
    /image_capable/, /data_only/, /capability_unknown/, /never calls another model/i, /never analyzes an image/i,
    /final opaque beauty RGBA/i, /lit parts multiply/i, /unlit keeps sampled RGB exact/i, /color_count/i,
    /needs_review/, /not_applicable/, /waived/, /blocked/, /must_not inverts/i, /should is advisory/i,
    /theme_report/, /theme\.json/, /missing external store/i, /revision 0/, /immutable/i, /expected_revision/, /txid/,
    /applyDefaults/, /overwrite:true/, /replace:true/, /theme:null/, /renderer remains 0\.3\.6/i, /package and service are 0\.4\.0/i,
    /one scene binds at most one theme/i, /no subtree or multi-theme engine/i, /256 KiB per revision/i, /64 rules/i,
    /no aesthetic score/i, /part-count gate/i, /never generates geometry/i, /paints pixels/i,
    /outline\.width other than 1/i, /specular above 0/i, /colored lights/i, /view-frame point lights/i,
    /soft or dashed outlines/i, /mirror reflection/i, /CSG/i, /arbitrary scripts/i
  ]) assert.match(text, pattern, `theme guide must document ${pattern}`);
  assert.ok(!/(minimum|at least)\s+\d+\s+parts/i.test(text), 'theme guide must not gate by part count');
  assert.ok(!/(supports?|adds?)\s+(soft shadows|dashed outlines|colored lights)/i.test(text), 'theme guide must not claim unsupported primitives');

  assert.ok(WORKFLOW.length <= 780, `WORKFLOW is ${WORKFLOW.length} chars; keep it a compact first-use map`);
  assert.ok(WORKFLOW.includes('zpixel_theme'));
  assert.match(WORKFLOW, /topic:'theme'/);
  assert.match(WORKFLOW, /topic:'overview'/);
  assert.ok(!/zpixel_scene\(\{/.test(WORKFLOW), 'runnable snippets belong in focused topics, not WORKFLOW');
  for (const topic of Object.keys(GUIDES)) assert.ok(guideTopics().includes(topic), `GUIDES.${topic} is not registered`);
});

test('README, THEMES and CONTRACT state 0.5.3-dev while the renderer stays 0.3.6', async () => {
  const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /^# ZPixel 0\.5\.3-dev$/m);
  assert.doesNotMatch(readme, /^# ZPixel 0\.3\.6$/m);
  for (const pattern of [/zpixel_theme/, /theme_report/, /applyDefaults/, /theme:null/, /snapshot/i, /needs_review/, /unsupported/, /no aesthetic score/i, /part-count gate/i, /0\.3\.6/, /0\.4\.0/, /THEMES\.md/]) {
    assert.match(readme, pattern, `README must document ${pattern}`);
  }

  const themes = await fs.readFile(new URL('../THEMES.md', import.meta.url), 'utf8');
  assert.match(themes, /^# ZPixel Themes 0\.4\.0$/m);
  for (const pattern of [/dsh-zpixel-theme\/1/, /theme_report/, /applyDefaults/, /theme:null/, /needs_review/, /unsupported/, /256 KiB/, /renderer remains 0\.3\.6/i, /one scene binds at most one theme/i, /zpixel_guide topic:"theme"/]) {
    assert.match(themes, pattern, `THEMES.md must document ${pattern}`);
  }
  const block = themes.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(block, 'THEMES.md must contain the complete JSON definition');
  const documented = normalizeTheme(JSON.parse(block[1]), { id: 'soft-workshop', revision: 0 });
  const guided = normalizeTheme(THEME_EXAMPLE, { id: 'soft-workshop', revision: 0 });
  assert.equal(themeHash(documented), themeHash(guided), 'THEMES.md and the guide must publish the same definition');

  const contract = await fs.readFile(new URL('../CONTRACT-0.3.md', import.meta.url), 'utf8');
  assert.match(contract, /\*\*Release:\*\* 0\.5\.3-dev/);
  assert.match(contract, /renderer remains 0\.3\.6/i);
  assert.match(contract, /seven native tools/i);
  assert.match(contract, /## Theme System \(0\.4\.0\)/);
  for (const pattern of [/theme_report/, /applyDefaults/, /theme:null/, /part-count gate/i, /THEMES\.md/]) {
    assert.match(contract, pattern, `CONTRACT-0.3.md must document ${pattern}`);
  }
});

test('malformed theme data rejects and unsupported tokens are reported, never passed as conformity', () => {
  const clone = () => structuredClone(THEME_EXAMPLE);
  const normalize = spec => normalizeTheme(spec, { id: 'soft-workshop', revision: 0 });
  const invalid = [
    ['unknown token field', spec => { spec.tokens.mystery = 1; }],
    ['invalid color', spec => { spec.tokens.colors.ink.value = 'nothex'; }],
    ['unknown check kind', spec => { spec.rules[0].check = { kind: 'nope' }; }],
    ['missing title', spec => { delete spec.title; }],
    ['duplicate rule id', spec => { spec.rules.push({ ...spec.rules[0] }); }],
    ['unknown signature rule', spec => { spec.signature = ['missing.rule']; }],
    ['unknown adaptation language section', spec => { spec.adaptations[0].language.nope = 'x'; }],
    ['escaping reference path', spec => { spec.references = [{ id: 'r', path: '../secret.png' }]; }],
    ['missing ramp reference', spec => { spec.tokens.materials.wood.ramp = 'nope'; }],
    ['unordered ramp stops', spec => { spec.tokens.ramps.body.stops = [{ at: 1, color: 'shadow' }, { at: 0, color: 'light' }]; }],
    ['author format', spec => { spec.format = 'dsh-zpixel-theme/1'; }],
    ['author id', spec => { spec.id = 'soft-workshop'; }],
    ['author revision', spec => { spec.revision = 9; }],
    ['author hash', spec => { spec.hash = '0'.repeat(64); }]
  ];
  for (const [label, mutate] of invalid) {
    const spec = clone();
    mutate(spec);
    assert.throws(() => normalize(spec), error => {
      assert.ok(error.code, `${label} must throw a coded error`);
      return true;
    }, label);
  }

  const unsupportedSpec = clone();
  unsupportedSpec.tokens.outline.width = 2;
  unsupportedSpec.tokens.materials.wood.specular = 0.5;
  unsupportedSpec.tokens.lights[0].color = '#ff0000';
  unsupportedSpec.tokens.lights.push({ id: 'rim', type: 'point', position: [0, 1, 0], frame: 'view', intensity: 1, color: '#ffffff' });
  const unsupported = normalize(unsupportedSpec);
  assert.equal(unsupported.tokens.outline.width, 2, 'unsupported width is saved, not coerced');
  assert.equal(unsupported.tokens.materials.wood.specular, 0.5);
  assert.match(unsupported.tokens.lights[0].color, /^#ff0000$/i);
  const compiled = compileTheme(unsupported, {});
  const paths = compiled.capabilities.unsupported.map(entry => entry.path);
  for (const path of ['tokens.outline.width', 'tokens.materials.wood.specular', 'tokens.lights[0].color', 'tokens.lights[1].frame']) {
    assert.ok(paths.includes(path), `capabilities must report ${path}`);
  }
  assert.ok(compiled.capabilities.unsupported.every(entry => entry.required === true), 'saved unsupported tokens are required blockers');
  const pack = readThemePack(unsupported, {});
  assert.ok(!JSON.stringify(pack).includes('"status":"pass"'), 'unsupported tokens must not produce a pass');
});
