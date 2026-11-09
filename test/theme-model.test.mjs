import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTheme, validateTheme, themeHash, validateThemeContext, validateThemeBinding,
  deepFreeze, THEME_LANGUAGE_SECTIONS, ThemeError,
} from '../src/theme-model.mjs';

const HASH = /^[0-9a-f]{64}$/;
const sha = 'a'.repeat(64);

function baseSpec(overrides = {}) {
  return {
    title: 'Soft Workshop',
    summary: 'Warm ochre masses, plum shadows, low detail density.',
    tags: ['warm', 'workshop'],
    signature: ['edge.crisp'],
    language: {
      identity: 'Warm handmade workshop props.',
      form: 'Large complete masses; short chamfers.',
      color: 'Ochre body, plum shadow, one teal accent.',
    },
    tokens: {
      colors: {
        ink: { value: '#2c2333', role: 'outline', usage: 'outer contour' },
        shadow: { value: '#755146', role: 'shadow' },
        base: { value: '#bc8758', role: 'base' },
        light: { value: '#e7be83', role: 'light' },
        accent: { value: '#668c83', role: 'accent' },
      },
      ramps: {
        body: { stops: [{ at: 0, color: 'shadow' }, { at: 0.5, color: 'base' }, { at: 1, color: 'light' }] },
      },
      materials: { body: { ramp: 'body' } },
      defaultMaterial: 'body',
      outline: { enabled: true, color: 'ink', width: 1, direction: 'inside' },
      lights: [{ id: 'key', type: 'directional', direction: [-0.4, -1, -0.6], frame: 'view' }],
      ambient: 0.2,
      exposure: 1,
      camera: { preset: 'top_down', pixelsPerUnit: 2 },
      appearanceShading: 'unlit',
    },
    rules: [
      { id: 'edge.crisp', strength: 'must', statement: 'One-pixel dark outer contour.', check: { kind: 'outline', enabled: true, width: 1, direction: 'inside', color: 'ink' } },
      { id: 'form.mass', strength: 'must', statement: 'Keep the main mass complete.' },
      { id: 'color.closed', strength: 'must', statement: 'Final opaque pixels use only theme colors.', check: { kind: 'palette' } },
      { id: 'color.count', strength: 'should', statement: 'Keep the final color count small.', check: { kind: 'color_count', max: 16 } },
      { id: 'alpha.binary', strength: 'must', statement: 'Alpha is binary.', check: { kind: 'binary_alpha' } },
      { id: 'pad.edge', strength: 'should', statement: 'Leave transparent padding.', check: { kind: 'padding', min: 1 } },
      { id: 'canvas.square', strength: 'must', statement: 'Use a square 64 canvas.', check: { kind: 'canvas', width: 64, height: 64 } },
      { id: 'camera.top', strength: 'must', statement: 'Top-down camera.', check: { kind: 'camera', preset: 'top_down' } },
      { id: 'light.one', strength: 'must', statement: 'One light.', check: { kind: 'light_count', max: 1 } },
      { id: 'shade.unlit', strength: 'should', statement: 'Prefer unlit appearance.', check: { kind: 'appearance_shading', value: 'unlit' } },
      { id: 'visual.silhouette', strength: 'must', statement: 'The silhouette reads as one object.', check: { kind: 'visual' } },
      { id: 'future.softshadow', strength: 'should', statement: 'Soft shadow support is not implemented.', check: { kind: 'unsupported', feature: 'soft shadow' } },
    ],
    adaptations: [
      { id: 'small', maxSize: 32, language: { detail: 'Remove secondary detail.' } },
      { id: 'prop', assetClass: 'prop', language: { form: 'Thicker frames.' } },
    ],
    references: [
      { id: 'ref.one', path: 'assets/reference.png', sha256: sha, role: 'positive', note: 'Palette and edge language only.', crop: [0, 0, 64, 64], observations: ['Warm body, plum shadow.'], inferences: ['Likely painted at 64px.'] },
    ],
    source: { kind: 'hybrid', brief: 'Text decisions plus one reference observation.', observations: ['Warm palette.'], inferences: ['Low detail density.'], decisions: ['Use unlit appearance.'], unknowns: ['Metal treatment is untested.'] },
    ...overrides,
  };
}

const minimal = (extra = {}) => ({ title: 'T', summary: 'S', ...extra });
function expectCode(fn, code, label = '') {
  assert.throws(fn, error => {
    assert.equal(error.code, code, (label ? label + ': ' : '') + 'expected ' + code + ', got ' + error.code + ': ' + error.message);
    return true;
  });
}
function expectOk(fn, label = '') {
  try { return fn(); }
  catch (error) { assert.fail((label ? label + ': ' : '') + 'expected success, got ' + error.code + ': ' + error.message); }
}

test('canonical theme fills defaults, normalizes text/colors and is deeply frozen', () => {
  const spec = baseSpec();
  spec.title = '  Soft Workshop  ';
  spec.summary = 'Line one.\r\nLine two.';
  spec.tags = [' warm ', 'workshop'];
  spec.language.form = 'Mass first.\rSecond.';
  spec.tokens.colors.ink.value = '#2C2333';
  delete spec.tokens.ramps.body.response;
  delete spec.tokens.materials.body.diffuse;
  delete spec.tokens.materials.body.emission;
  delete spec.tokens.materials.body.specular;
  delete spec.tokens.materials.body.roughness;
  const theme = normalizeTheme(deepFreeze(spec), { id: 'soft-workshop', revision: 0 });
  assert.equal(theme.format, 'dsh-zpixel-theme/1');
  assert.equal(theme.id, 'soft-workshop');
  assert.equal(theme.revision, 0);
  assert.equal(theme.title, 'Soft Workshop');
  assert.equal(theme.summary, 'Line one.\nLine two.');
  assert.deepEqual(theme.tags, ['warm', 'workshop']);
  assert.equal(theme.language.form, 'Mass first.\nSecond.');
  assert.equal(theme.tokens.colors.ink.value, '#2c2333');
  assert.equal(theme.tokens.ramps.body.response, 1);
  assert.deepEqual(theme.tokens.materials.body, { ramp: 'body', diffuse: 1, emission: 0, specular: 0, roughness: 0.5 });
  assert.equal(theme.tokens.lights[0].frame, 'view');
  assert.equal(theme.references[0].role, 'positive');
  assert.equal(theme.source.kind, 'hybrid');
  assert.equal(validateTheme(theme), theme);
  assert.match(themeHash(theme), HASH);
  assert.ok(Object.isFrozen(theme));
  assert.ok(Object.isFrozen(theme.tokens.colors.ink));
  assert.ok(Object.isFrozen(theme.rules[0].check));
  assert.throws(() => { theme.tokens.colors.ink.value = '#000000'; }, TypeError);
  assert.throws(() => { theme.tags.push('x'); }, TypeError);
});

test('minimal spec gets the documented empty defaults', () => {
  const theme = normalizeTheme({ title: 'T', summary: 'S' }, { id: 'x' });
  assert.deepEqual(theme.tags, []);
  assert.deepEqual(theme.signature, []);
  assert.deepEqual(theme.language, {});
  assert.deepEqual(theme.tokens, { colors: {}, ramps: {}, materials: {} });
  assert.deepEqual(theme.rules, []);
  assert.deepEqual(theme.adaptations, []);
  assert.deepEqual(theme.references, []);
  assert.deepEqual(theme.source, { kind: 'concept' });
  assert.equal(theme.revision, 0);
  assert.ok(Object.isFrozen(theme.tokens));
  assert.notEqual(themeHash(theme), themeHash(normalizeTheme({ title: 'T', summary: 'S' }, { id: 'y' })));
});

test('hash is canonical across key order, explicit defaults and line endings', () => {
  const a = baseSpec();
  a.summary = 'Line one.\nLine two.';
  const b = JSON.parse(JSON.stringify(baseSpec()));
  b.summary = 'Line one.\r\nLine two.';
  b.tokens.colors = Object.fromEntries(Object.entries(b.tokens.colors).reverse());
  b.tokens.ramps.body.response = 1;
  b.tokens.materials.body = { ramp: 'body', diffuse: 1, emission: 0, specular: 0, roughness: 0.5 };
  const ta = normalizeTheme(a, { id: 'x' });
  const tb = normalizeTheme(b, { id: 'x' });
  assert.equal(themeHash(ta), themeHash(tb));
  assert.notEqual(themeHash(ta), themeHash(normalizeTheme(a, { id: 'x', revision: 1 })));
  assert.notEqual(themeHash(ta), themeHash(normalizeTheme({ ...a, title: 'Other' }, { id: 'x' })));
  expectCode(() => normalizeTheme({ ...a, hash: sha }, { id: 'x' }), 'UNKNOWN_FIELD', 'author hash');
  expectCode(() => normalizeTheme({ ...a, format: 'dsh-zpixel-theme/1' }, { id: 'x' }), 'THEME_SPEC', 'format in spec');
  expectCode(() => normalizeTheme({ ...a, id: 'x' }, { id: 'x' }), 'THEME_SPEC', 'id in spec');
  expectCode(() => normalizeTheme({ ...a, revision: 0 }, { id: 'x' }), 'THEME_SPEC', 'revision in spec');
});

test('validateTheme accepts only canonical revisions and rejects mutation', () => {
  const theme = normalizeTheme(baseSpec(), { id: 'x' });
  const clone = () => JSON.parse(JSON.stringify(theme));
  const untrimmed = clone(); untrimmed.tags = [' x '];
  expectCode(() => validateTheme(untrimmed), 'NONCANONICAL_THEME', 'untrimmed tag');
  const minimalTheme = normalizeTheme({ title: 'T', summary: 'S' }, { id: 'x' });
  const missingColors = JSON.parse(JSON.stringify(minimalTheme)); delete missingColors.tokens.colors;
  expectCode(() => validateTheme(missingColors), 'NONCANONICAL_THEME', 'missing colors');
  const upper = clone(); upper.tokens.colors.ink.value = '#ABCDEF';
  expectCode(() => validateTheme(upper), 'NONCANONICAL_THEME', 'uppercase color');
  const extra = clone(); extra.extra = true;
  expectCode(() => validateTheme(extra), 'UNKNOWN_FIELD', 'extra field');
  const wrongFormat = clone(); wrongFormat.format = 'other';
  expectCode(() => validateTheme(wrongFormat), 'THEME_FORMAT', 'wrong format');
  const missingTitle = clone(); delete missingTitle.title;
  expectCode(() => validateTheme(missingTitle), 'INVALID_FIELD', 'missing title');
  const frozen = deepFreeze(clone());
  assert.equal(validateTheme(frozen), frozen);
});

test('malformed and conditional rule checks are rejected', () => {
  const check = value => () => normalizeTheme(minimal({ rules: [{ id: 'r', strength: 'must', statement: 'S', check: value }] }), { id: 'x' });
  expectCode(check({ kind: 'palette', max: 3 }), 'UNKNOWN_FIELD', 'palette extra');
  expectCode(check({ kind: 'binary_alpha', x: 1 }), 'UNKNOWN_FIELD', 'binary_alpha extra');
  expectCode(check({ kind: 'visual', x: 1 }), 'UNKNOWN_FIELD', 'visual extra');
  expectCode(check({ kind: 'color_count' }), 'INVALID_FIELD', 'color_count missing max');
  expectCode(check({ kind: 'color_count', max: 0 }), 'INVALID_NUMBER', 'color_count zero');
  expectCode(check({ kind: 'color_count', max: 257 }), 'INVALID_NUMBER', 'color_count too large');
  expectCode(check({ kind: 'color_count', max: 16, min: 1 }), 'UNKNOWN_FIELD', 'color_count extra min');
  expectCode(check({ kind: 'padding' }), 'INVALID_FIELD', 'padding missing min');
  expectCode(check({ kind: 'padding', min: -1 }), 'INVALID_NUMBER', 'padding negative');
  expectOk(check({ kind: 'padding', min: 0 }), 'padding zero');
  expectCode(check({ kind: 'canvas' }), 'INVALID_CHECK', 'canvas empty');
  expectCode(check({ kind: 'canvas', width: 64, maxWidth: 32 }), 'INVALID_CHECK', 'canvas contradiction');
  expectCode(check({ kind: 'canvas', width: 0 }), 'INVALID_NUMBER', 'canvas zero');
  expectCode(check({ kind: 'canvas', width: 300 }), 'INVALID_NUMBER', 'canvas too large');
  expectOk(check({ kind: 'canvas', maxWidth: 256 }), 'canvas max');
  expectCode(check({ kind: 'outline' }), 'INVALID_CHECK', 'outline empty');
  expectCode(check({ kind: 'outline', color: 'missing' }), 'INVALID_REFERENCE', 'outline color');
  expectCode(check({ kind: 'outline', width: 0 }), 'INVALID_NUMBER', 'outline width');
  expectOk(check({ kind: 'outline', enabled: false }), 'outline disabled');
  expectCode(check({ kind: 'camera' }), 'INVALID_FIELD', 'camera missing preset');
  expectCode(check({ kind: 'camera', preset: 'isometric' }), 'INVALID_FIELD', 'camera preset');
  expectOk(check({ kind: 'camera', preset: 'top_down' }), 'camera top');
  expectCode(check({ kind: 'light_count' }), 'INVALID_FIELD', 'light_count missing max');
  expectCode(check({ kind: 'light_count', max: 9 }), 'INVALID_NUMBER', 'light_count too large');
  expectOk(check({ kind: 'light_count', max: 0 }), 'light_count zero');
  expectCode(check({ kind: 'appearance_shading' }), 'INVALID_FIELD', 'shading missing value');
  expectCode(check({ kind: 'appearance_shading', value: 'flat' }), 'INVALID_FIELD', 'shading value');
  expectOk(check({ kind: 'appearance_shading', value: 'lit' }), 'shading lit');
  expectCode(check({ kind: 'unsupported' }), 'INVALID_FIELD', 'unsupported missing feature');
  expectCode(check({ kind: 'unsupported', feature: '' }), 'INVALID_TEXT', 'unsupported empty feature');
  expectOk(check({ kind: 'unsupported', feature: 'soft shadow' }), 'unsupported feature');
  expectCode(check({ kind: 'nope' }), 'INVALID_FIELD', 'unknown kind');
  expectCode(check({}), 'INVALID_CHECK', 'missing kind');
  expectCode(check('palette'), 'INVALID_FIELD', 'string check');
  expectCode(check(null), 'INVALID_FIELD', 'null check');
  expectOk(check({ kind: 'palette' }), 'palette');
  const withColor = () => normalizeTheme(minimal({ tokens: { colors: { ink: { value: '#112233' } } }, rules: [{ id: 'r', strength: 'must', statement: 'S', check: { kind: 'outline', color: 'ink' } }] }), { id: 'x' });
  assert.equal(withColor().rules[0].check.color, 'ink');
});

test('rule fields, scopes and signature references are strict', () => {
  const rule = value => () => normalizeTheme(minimal({ rules: [value] }), { id: 'x' });
  expectCode(rule({ id: 'r', strength: 'maybe', statement: 'S' }), 'INVALID_FIELD', 'bad strength');
  expectCode(rule({ id: 'r', strength: 'must', statement: '' }), 'INVALID_TEXT', 'empty statement');
  expectCode(rule({ id: 'r', strength: 'must', statement: 'S', scope: { minSize: 64, maxSize: 32 } }), 'INVALID_RANGE', 'scope range');
  expectCode(rule({ id: 'r', strength: 'must', statement: 'S', scope: { assetClasses: [] } }), 'INVALID_FIELD', 'empty classes');
  expectCode(rule({ id: 'r', strength: 'must', statement: 'S', scope: { assetClasses: ['prop', 'prop'] } }), 'DUPLICATE_ID', 'duplicate classes');
  expectCode(rule({ id: 'r', strength: 'must', statement: 'S', scope: { minSize: 300 } }), 'INVALID_NUMBER', 'scope size');
  expectCode(rule({ id: 'constructor', strength: 'must', statement: 'S' }), 'INVALID_ID', 'forbidden id');
  expectCode(rule({ id: 'r', strength: 'must', statement: 'S', extra: true }), 'UNKNOWN_FIELD', 'rule extra');
  expectCode(rule({ id: 'r', strength: 'must', statement: 'S', check: 'palette' }), 'INVALID_FIELD', 'string check');
  expectCode(rule({ id: 'r', strength: 'must', statement: 'S', check: null }), 'INVALID_FIELD', 'null check');
  expectCode(() => normalizeTheme(minimal({ rules: [{ id: 'r', strength: 'must', statement: 'S' }, { id: 'r', strength: 'must', statement: 'S' }] }), { id: 'x' }), 'DUPLICATE_ID', 'duplicate rules');
  expectCode(() => normalizeTheme(minimal({ signature: ['missing'] }), { id: 'x' }), 'INVALID_REFERENCE', 'unknown signature');
  expectCode(() => normalizeTheme(minimal({ rules: [{ id: 'r', strength: 'must', statement: 'S' }], signature: ['r', 'r'] }), { id: 'x' }), 'DUPLICATE_ID', 'duplicate signature');
  const ok = normalizeTheme(minimal({ rules: [{ id: 'r', strength: 'must', statement: 'S', scope: { assetClasses: ['prop'], minSize: 32, maxSize: 64 } }], signature: ['r'] }), { id: 'x' });
  assert.deepEqual(ok.signature, ['r']);
  assert.deepEqual(ok.rules[0].scope, { assetClasses: ['prop'], minSize: 32, maxSize: 64 });
});

test('token references, defaults and unsupported desired values are strict but saved', () => {
  const tokens = value => () => normalizeTheme(minimal({ tokens: value }), { id: 'x' });
  expectCode(tokens({ colors: { ink: { value: 'red' } } }), 'INVALID_COLOR', 'bad color');
  expectCode(tokens({ colors: { ink: { value: '#11223' } } }), 'INVALID_COLOR', 'short color');
  expectCode(tokens({ colors: { ink: {} } }), 'INVALID_FIELD', 'missing color value');
  expectCode(tokens({ colors: { ink: { value: '#112233', role: '' } } }), 'INVALID_TEXT', 'empty role');
  expectCode(tokens({ colors: { ink: { value: '#112233', extra: 1 } } }), 'UNKNOWN_FIELD', 'color extra');
  expectCode(tokens({ colors: { ['a'.repeat(49)]: { value: '#112233' } } }), 'INVALID_ID', 'long token id');
  expectCode(tokens({ colors: { constructor: { value: '#112233' } } }), 'INVALID_ID', 'constructor key');
  expectCode(tokens({ colors: { prototype: { value: '#112233' } } }), 'INVALID_ID', 'prototype key');
  expectCode(tokens({ ramps: { body: {} } }), 'INVALID_FIELD', 'ramp missing stops');
  expectCode(tokens({ ramps: { body: { stops: [] } } }), 'INVALID_RAMP', 'ramp empty');
  expectCode(tokens({ colors: { ink: { value: '#112233' } }, ramps: { body: { stops: [{ at: 1, color: 'ink' }, { at: 1, color: 'ink' }] } } }), 'INVALID_RAMP', 'ramp order');
  expectCode(tokens({ ramps: { body: { stops: [{ at: 0, color: 'missing' }] } } }), 'INVALID_REFERENCE', 'ramp color');
  expectCode(tokens({ colors: { ink: { value: '#112233' } }, ramps: { body: { stops: [{ at: 0, color: 'ink' }] } }, materials: { body: { ramp: 'missing' } } }), 'INVALID_REFERENCE', 'material ramp');
  expectCode(tokens({ colors: { ink: { value: '#112233' } }, ramps: { body: { stops: [{ at: 0, color: 'ink' }] } }, materials: { body: { ramp: 'body' } }, defaultMaterial: 'missing' }), 'INVALID_REFERENCE', 'default material');
  expectCode(tokens({ colors: { ink: { value: '#112233' } }, outline: { color: 'missing' } }), 'INVALID_REFERENCE', 'outline color');
  expectCode(tokens({ outline: { width: 0 } }), 'INVALID_NUMBER', 'outline width');
  expectCode(tokens({ lights: [{ id: 'l', type: 'directional' }, { id: 'l', type: 'point' }] }), 'DUPLICATE_ID', 'duplicate light');
  expectCode(tokens({ lights: [{ id: 'l', type: 'spot' }] }), 'INVALID_FIELD', 'light type');
  expectCode(tokens({ lights: [{ id: 'l', type: 'point', position: [1, 2] }] }), 'INVALID_VECTOR', 'light position');
  expectCode(tokens({ lights: [{ id: 'l', type: 'directional', intensity: 65 }] }), 'INVALID_NUMBER', 'light intensity');
  expectCode(tokens({ lights: [{ id: 'l', type: 'directional', color: 'red' }] }), 'INVALID_COLOR', 'light color');
  expectCode(tokens({ camera: {} }), 'INVALID_FIELD', 'camera missing preset');
  expectCode(tokens({ camera: { preset: 'top_down', pixelsPerUnit: 0 } }), 'INVALID_NUMBER', 'camera scale');
  expectCode(tokens({ appearanceShading: 'flat' }), 'INVALID_FIELD', 'shading');
  expectCode(tokens({ extra: true }), 'UNKNOWN_FIELD', 'token extra');
  expectCode(tokens({ colors: Object.fromEntries(Array.from({ length: 65 }, (_, index) => ['c' + index, { value: '#112233' }])) }), 'THEME_LIMIT', 'too many colors');
  expectCode(tokens({ lights: Array.from({ length: 9 }, (_, index) => ({ id: 'l' + index, type: 'directional' })) }), 'THEME_LIMIT', 'too many lights');
  expectCode(tokens({ colors: { ink: { value: '#112233' } }, ramps: { body: { stops: Array.from({ length: 65 }, (_, index) => ({ at: index, color: 'ink' })) } } }), 'INVALID_RAMP', 'too many stops');
  const defaults = normalizeTheme(minimal({ tokens: { colors: { ink: { value: '#112233' } }, ramps: { body: { stops: [{ at: 0, color: 'ink' }] } }, materials: { body: { ramp: 'body' } } } }), { id: 'x' });
  assert.equal(defaults.tokens.ramps.body.response, 1);
  assert.deepEqual(defaults.tokens.materials.body, { ramp: 'body', diffuse: 1, emission: 0, specular: 0, roughness: 0.5 });
  const desired = normalizeTheme(minimal({ tokens: { colors: { ink: { value: '#112233' } }, outline: { enabled: true, color: 'ink', width: 2 }, materials: { body: { ramp: 'body', specular: 0.8 } }, ramps: { body: { stops: [{ at: 0, color: 'ink' }] } }, lights: [{ id: 'key', type: 'directional', color: '#ff0000' }, { id: 'fill', type: 'point', frame: 'view' }] } }), { id: 'x' });
  assert.equal(desired.tokens.outline.width, 2);
  assert.equal(desired.tokens.materials.body.specular, 0.8);
  assert.equal(desired.tokens.lights[0].color, '#ff0000');
  assert.equal(desired.tokens.lights[1].frame, 'view');
});

test('adaptations, references and source stay bounded metadata', () => {
  expectCode(() => normalizeTheme(minimal({ adaptations: [{ id: 'a', language: {} }] }), { id: 'x' }), 'INVALID_FIELD', 'empty adaptation language');
  expectCode(() => normalizeTheme(minimal({ adaptations: [{ id: 'a', language: { nope: 'x' } }] }), { id: 'x' }), 'UNKNOWN_FIELD', 'unknown language section');
  expectCode(() => normalizeTheme(minimal({ adaptations: [{ id: 'a', language: { form: 'x' }, tokens: {} }] }), { id: 'x' }), 'UNKNOWN_FIELD', 'adaptation token override');
  expectCode(() => normalizeTheme(minimal({ adaptations: [{ id: 'a', minSize: 64, maxSize: 32, language: { form: 'x' } }] }), { id: 'x' }), 'INVALID_RANGE', 'adaptation range');
  expectCode(() => normalizeTheme(minimal({ adaptations: [{ id: 'a', language: { form: 'x' } }, { id: 'a', language: { form: 'y' } }] }), { id: 'x' }), 'DUPLICATE_ID', 'duplicate adaptation');
  const ref = value => () => normalizeTheme(minimal({ references: [value] }), { id: 'x' });
  expectCode(ref({ id: 'r', path: '../secret.png' }), 'INVALID_PATH', 'parent path');
  expectCode(ref({ id: 'r', path: '/abs.png' }), 'INVALID_PATH', 'absolute path');
  expectCode(ref({ id: 'r', path: 'C:/abs.png' }), 'INVALID_PATH', 'drive path');
  expectCode(ref({ id: 'r', path: 'a\\b.png' }), 'INVALID_PATH', 'backslash path');
  expectCode(ref({ id: 'r', path: 'a//b.png' }), 'INVALID_PATH', 'empty segment');
  expectCode(ref({ id: 'r', path: 'a/./b.png' }), 'INVALID_PATH', 'dot segment');
  expectCode(ref({ id: 'r', path: 'a/../b.png' }), 'INVALID_PATH', 'parent segment');
  expectCode(ref({ id: 'r', path: 'a/b/' }), 'INVALID_PATH', 'directory path');
  expectCode(ref({ id: 'r', path: 'a?b.png' }), 'INVALID_PATH', 'query path');
  expectCode(ref({ id: 'r', sha256: 'abc' }), 'INVALID_HASH', 'bad hash');
  expectCode(ref({ id: 'r', role: 'bad' }), 'INVALID_FIELD', 'bad role');
  expectCode(ref({ id: 'r', crop: [0, 0, 0, 1] }), 'INVALID_NUMBER', 'zero crop width');
  expectCode(ref({ id: 'r', crop: [0, 0, 1] }), 'INVALID_CROP', 'short crop');
  expectCode(ref({ id: 'r', observations: Array.from({ length: 33 }, () => 'x') }), 'THEME_LIMIT', 'too many observations');
  expectCode(() => normalizeTheme(minimal({ references: [{ id: 'r' }, { id: 'r' }] }), { id: 'x' }), 'DUPLICATE_ID', 'duplicate reference');
  const ok = normalizeTheme(minimal({ references: [{ id: 'r', path: 'assets/ref.png', sha256: sha.toUpperCase(), note: 'Note.', crop: [0, 0, 64, 64], observations: ['Observed.'], inferences: ['Inferred.'] }] }), { id: 'x' });
  assert.equal(ok.references[0].role, 'reference');
  assert.equal(ok.references[0].sha256, sha);
  assert.deepEqual(ok.references[0].crop, [0, 0, 64, 64]);
  expectCode(() => normalizeTheme(minimal({ source: { kind: 'bad' } }), { id: 'x' }), 'INVALID_FIELD', 'bad source kind');
  expectCode(() => normalizeTheme(minimal({ source: { kind: 'concept', brief: '' } }), { id: 'x' }), 'INVALID_TEXT', 'empty brief');
  expectCode(() => normalizeTheme(minimal({ source: { kind: 'concept', observations: Array.from({ length: 65 }, () => 'x') } }), { id: 'x' }), 'THEME_LIMIT', 'too many source observations');
  const source = normalizeTheme(minimal({ source: { kind: 'reference', brief: 'B', observations: ['O'], inferences: ['I'], decisions: ['D'], unknowns: ['U'] } }), { id: 'x' });
  assert.deepEqual(source.source, { kind: 'reference', brief: 'B', observations: ['O'], inferences: ['I'], decisions: ['D'], unknowns: ['U'] });
});

test('theme context is strict and pure', () => {
  const context = { assetClass: 'prop', nativeSize: [64, 64], view: 'top_down', channels: ['beauty', 'normalmap'] };
  assert.equal(validateThemeContext(context), context);
  assert.deepEqual(validateThemeContext(), {});
  expectCode(() => validateThemeContext({ extra: 1 }), 'UNKNOWN_FIELD', 'context extra');
  expectCode(() => validateThemeContext({ nativeSize: [64, 64, 32] }), 'INVALID_CONTEXT', 'native size length');
  expectCode(() => validateThemeContext({ nativeSize: [0, 64] }), 'INVALID_NUMBER', 'native size zero');
  expectCode(() => validateThemeContext({ nativeSize: [64, 257] }), 'INVALID_NUMBER', 'native size too large');
  expectCode(() => validateThemeContext({ view: 'isometric' }), 'INVALID_FIELD', 'bad view');
  expectCode(() => validateThemeContext({ channels: ['beauty', 'beauty'] }), 'DUPLICATE_ID', 'duplicate channel');
  expectCode(() => validateThemeContext({ channels: ['beauty', 'bad'] }), 'INVALID_FIELD', 'bad channel');
  expectCode(() => validateThemeContext({ channels: ['beauty', 'normalmap', 'depth', 'normals', 'silhouette', 'nodes', 'beauty'] }), 'INVALID_CONTEXT', 'too many channels');
  expectCode(() => validateThemeContext({ assetClass: 'bad class' }), 'INVALID_ID', 'bad asset class');
  expectCode(() => validateThemeContext(null), 'INVALID_FIELD', 'null context');
});

test('theme binding validates snapshot, hash and overrides without rewriting', () => {
  const theme = normalizeTheme(baseSpec(), { id: 'x' });
  const hash = themeHash(theme);
  const context = { assetClass: 'prop', nativeSize: [64, 64] };
  const binding = { id: 'x', revision: 0, hash, adapterVersion: '1', snapshot: theme, context, overrides: [{ rule: 'edge.crisp', reason: 'Client request.' }] };
  assert.equal(validateThemeBinding(binding), binding);
  assert.equal(binding.snapshot.title, 'Soft Workshop');
  assert.deepEqual(binding.overrides, [{ rule: 'edge.crisp', reason: 'Client request.' }]);
  const clone = () => JSON.parse(JSON.stringify(binding));
  const badHash = clone(); badHash.hash = 'b'.repeat(64);
  expectCode(() => validateThemeBinding(badHash), 'BINDING_HASH', 'hash mismatch');
  const upperHash = clone(); upperHash.hash = hash.toUpperCase();
  expectCode(() => validateThemeBinding(upperHash), 'BINDING_HASH', 'uppercase hash');
  const badId = clone(); badId.id = 'y';
  expectCode(() => validateThemeBinding(badId), 'BINDING_ID', 'id mismatch');
  const badRevision = clone(); badRevision.revision = 1;
  expectCode(() => validateThemeBinding(badRevision), 'BINDING_REVISION', 'revision mismatch');
  const badAdapter = clone(); badAdapter.adapterVersion = '2';
  expectCode(() => validateThemeBinding(badAdapter), 'BINDING_ADAPTER', 'adapter');
  const unknownOverride = clone(); unknownOverride.overrides = [{ rule: 'missing', reason: 'R' }];
  expectCode(() => validateThemeBinding(unknownOverride), 'BINDING_OVERRIDE', 'unknown override');
  const duplicateOverride = clone(); duplicateOverride.overrides = [{ rule: 'edge.crisp', reason: 'R' }, { rule: 'edge.crisp', reason: 'R2' }];
  expectCode(() => validateThemeBinding(duplicateOverride), 'DUPLICATE_OVERRIDE', 'duplicate override');
  const extraOverride = clone(); extraOverride.overrides = [{ rule: 'edge.crisp', reason: 'R', extra: true }];
  expectCode(() => validateThemeBinding(extraOverride), 'UNKNOWN_FIELD', 'override extra');
  const missingReason = clone(); missingReason.overrides = [{ rule: 'edge.crisp' }];
  expectCode(() => validateThemeBinding(missingReason), 'INVALID_FIELD', 'override reason');
  const emptyReason = clone(); emptyReason.overrides = [{ rule: 'edge.crisp', reason: ' ' }];
  expectCode(() => validateThemeBinding(emptyReason), 'INVALID_TEXT', 'empty reason');
  const notArray = clone(); notArray.overrides = {};
  expectCode(() => validateThemeBinding(notArray), 'INVALID_FIELD', 'overrides object');
  const extra = clone(); extra.extra = true;
  expectCode(() => validateThemeBinding(extra), 'UNKNOWN_FIELD', 'binding extra');
  const missingContext = clone(); delete missingContext.context;
  expectCode(() => validateThemeBinding(missingContext), 'INVALID_FIELD', 'missing context');
  const badContext = clone(); badContext.context = { extra: true };
  expectCode(() => validateThemeBinding(badContext), 'UNKNOWN_FIELD', 'bad context');
  const noncanonical = clone(); noncanonical.snapshot.tags = [' x '];
  expectCode(() => validateThemeBinding(noncanonical), 'NONCANONICAL_THEME', 'noncanonical snapshot');
  const wrongSnapshotId = clone(); wrongSnapshotId.snapshot.id = 'y';
  expectCode(() => validateThemeBinding(wrongSnapshotId), 'BINDING_ID', 'snapshot id');
  const wrongSnapshotRevision = clone(); wrongSnapshotRevision.snapshot.revision = 1;
  expectCode(() => validateThemeBinding(wrongSnapshotRevision), 'BINDING_REVISION', 'snapshot revision');
});

test('safe JSON property validation rejects prototype-sensitive keys', () => {
  const protoColor = JSON.parse('{"title":"T","summary":"S","tokens":{"colors":{"__proto__":{"value":"#112233"}}}}');
  expectCode(() => normalizeTheme(protoColor, { id: 'x' }), 'INVALID_ID', '__proto__ color');
  expectCode(() => normalizeTheme(minimal({ tokens: { colors: { constructor: { value: '#112233' } } } }), { id: 'x' }), 'INVALID_ID', 'constructor color');
  expectCode(() => normalizeTheme(minimal({ tokens: { colors: { prototype: { value: '#112233' } } } }), { id: 'x' }), 'INVALID_ID', 'prototype color');
  const protoTop = JSON.parse('{"title":"T","summary":"S","__proto__":{"polluted":true}}');
  expectCode(() => normalizeTheme(protoTop, { id: 'x' }), 'UNKNOWN_FIELD', '__proto__ top');
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  const safe = normalizeTheme(minimal({ tokens: { colors: { toString: { value: '#112233' } } } }), { id: 'x' });
  assert.ok(Object.prototype.hasOwnProperty.call(safe.tokens.colors, 'toString'));
  assert.equal(safe.tokens.colors.toString.value, '#112233');
  assert.equal(Object.prototype.toString.call({}), '[object Object]');
  const getter = minimal();
  Object.defineProperty(getter, 'title', { enumerable: true, get() { return 'T'; } });
  expectCode(() => normalizeTheme(getter, { id: 'x' }), 'INVALID_FIELD', 'getter');
  const hidden = minimal();
  Object.defineProperty(hidden, 'hidden', { value: 1, enumerable: false });
  expectCode(() => normalizeTheme(hidden, { id: 'x' }), 'INVALID_FIELD', 'non-enumerable');
  const symbol = minimal();
  symbol[Symbol('x')] = 1;
  expectCode(() => normalizeTheme(symbol, { id: 'x' }), 'UNKNOWN_FIELD', 'symbol');
});

test('bounded limits are explicit', () => {
  expectCode(() => normalizeTheme(minimal({ tags: Array.from({ length: 33 }, (_, index) => 't' + index) }), { id: 'x' }), 'THEME_LIMIT', 'too many tags');
  expectCode(() => normalizeTheme(minimal({ rules: Array.from({ length: 65 }, (_, index) => ({ id: 'r' + index, strength: 'must', statement: 'S' })) }), { id: 'x' }), 'THEME_LIMIT', 'too many rules');
  expectCode(() => normalizeTheme(minimal({ adaptations: Array.from({ length: 33 }, (_, index) => ({ id: 'a' + index, language: { form: 'F' } })) }), { id: 'x' }), 'THEME_LIMIT', 'too many adaptations');
  expectCode(() => normalizeTheme(minimal({ references: Array.from({ length: 33 }, (_, index) => ({ id: 'r' + index })) }), { id: 'x' }), 'THEME_LIMIT', 'too many references');
  expectCode(() => normalizeTheme(minimal({ title: 'x'.repeat(201) }), { id: 'x' }), 'INVALID_TEXT', 'long title');
  expectCode(() => normalizeTheme(minimal({ summary: 'x'.repeat(2001) }), { id: 'x' }), 'INVALID_TEXT', 'long summary');
  expectCode(() => normalizeTheme(minimal({ language: { form: 'x'.repeat(4001) } }), { id: 'x' }), 'INVALID_TEXT', 'long language');
  expectCode(() => normalizeTheme(minimal({ rules: [{ id: 'r', strength: 'must', statement: 'x'.repeat(2001) }] }), { id: 'x' }), 'INVALID_TEXT', 'long statement');
  expectCode(() => normalizeTheme(minimal({ references: [{ id: 'r', crop: [0, 0, 4097, 1] }] }), { id: 'x' }), 'INVALID_NUMBER', 'large crop');
  expectCode(() => normalizeTheme(minimal({ rules: [{ id: 'a'.repeat(65), strength: 'must', statement: 'S' }] }), { id: 'x' }), 'INVALID_ID', 'long rule id');
  const huge = minimal({
    language: Object.fromEntries(THEME_LANGUAGE_SECTIONS.map(section => [section, 'x'.repeat(4000)])),
    rules: Array.from({ length: 64 }, (_, index) => ({ id: 'r' + index, strength: 'must', statement: 'x'.repeat(2000) })),
    source: { kind: 'concept', observations: Array.from({ length: 64 }, () => 'x'.repeat(2000)) },
  });
  expectCode(() => normalizeTheme(huge, { id: 'x' }), 'THEME_LIMIT', 'theme too large');
});

test('desired unsupported values are saved without coercion', () => {
  const spec = baseSpec();
  spec.tokens.outline = { enabled: true, color: 'ink', width: 2, direction: 'inside' };
  spec.tokens.materials.body = { ramp: 'body', diffuse: 1, emission: 0, specular: 0.8, roughness: 0.5 };
  spec.tokens.lights = [
    { id: 'key', type: 'directional', direction: [0, -1, 0], frame: 'view', color: '#ff0000' },
    { id: 'fill', type: 'point', position: [10, 20, 30], frame: 'view' },
  ];
  spec.rules.push({ id: 'future.soft', strength: 'must', statement: 'Soft shadows are not implemented.', check: { kind: 'unsupported', feature: 'soft shadow' } });
  const theme = normalizeTheme(spec, { id: 'x' });
  assert.equal(theme.tokens.outline.width, 2);
  assert.equal(theme.tokens.materials.body.specular, 0.8);
  assert.equal(theme.tokens.lights[0].color, '#ff0000');
  assert.equal(theme.tokens.lights[1].frame, 'view');
  assert.equal(theme.rules.find(rule => rule.id === 'future.soft').check.feature, 'soft shadow');
  assert.equal(validateTheme(theme), theme);
  assert.match(themeHash(theme), HASH);
});

test('ThemeError carries code/details and a service-compatible name', () => {
  try {
    normalizeTheme({}, { id: 'x' });
    assert.fail('expected error');
  } catch (error) {
    assert.ok(error instanceof ThemeError);
    assert.equal(error.name, 'ZPixelError');
    assert.equal(error.code, 'INVALID_FIELD');
    assert.equal(error.details.path, 'spec.title');
  }
});
