import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTheme, themeHash, validateThemeBinding } from '../src/theme-model.mjs';
import { compileTheme, readThemePack, themeReport } from '../src/theme-runtime.mjs';
import { createScene } from '../src/scene.mjs';
import { renderScene } from '../src/renderer.mjs';
import { cameraBasis, normalize } from '../src/math.mjs';

function baseSpec() {
  return {
    title: 'Soft workshop',
    summary: 'Warm ochre masses with violet-brown shadows and a closed palette.',
    tags: ['workshop', 'warm'],
    signature: ['edge.crisp', 'color.closed'],
    language: {
      identity: 'Warm ochre masses with a quiet workshop mood.',
      view: 'Top-down read with a clear front.',
      scale: 'Readable at 32-64px.',
      form: 'Large masses with short chamfers; details serve the main mass.',
      pixel: 'Clusters of 2-3 pixels; no isolated noise.',
      color: 'Ochre body, violet-brown shadow, restrained teal accent.',
      outline: '1px dark outer edge.',
      light: 'View-left key light with hard geometric shadows.',
      materials: 'Wood and painted metal differ by ramp and edge treatment.',
      detail: 'One accent cluster per asset.',
    },
    tokens: {
      colors: {
        ink: { value: '#2C2333', role: 'outline', usage: 'outer edge and deepest seams' },
        body0: { value: '#755146', role: 'shadow', usage: 'warm material shadow' },
        body1: { value: '#BC8758', role: 'base', usage: 'main midtone' },
        body2: { value: '#E7BE83', role: 'light', usage: 'large lit planes' },
        accent: { value: '#668C83', role: 'accent', usage: 'small functional accent' },
      },
      ramps: { body: { response: 1, stops: [{ at: 0, color: 'body0' }, { at: 0.5, color: 'body1' }, { at: 1, color: 'body2' }] } },
      materials: { body: { ramp: 'body', diffuse: 1, emission: 0, specular: 0, roughness: 0.5 } },
      defaultMaterial: 'body',
      outline: { enabled: true, color: 'ink', width: 1, direction: 'inside' },
      lights: [{ id: 'key', type: 'directional', frame: 'view', direction: [-0.4, -0.2, 0.9], intensity: 1 }],
      ambient: 0.25,
      exposure: 1,
      camera: { preset: 'top_down', pixelsPerUnit: 1 },
      appearanceShading: 'unlit',
    },
    rules: [
      { id: 'edge.crisp', strength: 'must', statement: '1px dark outer edge.', check: { kind: 'outline', enabled: true, width: 1, direction: 'inside', color: 'ink' } },
      { id: 'color.closed', strength: 'must', statement: 'Final opaque pixels use only theme colors.', check: { kind: 'palette' } },
      { id: 'alpha.binary', strength: 'must', statement: 'Alpha is binary.', check: { kind: 'binary_alpha' } },
      { id: 'canvas.8', strength: 'must', statement: 'Native canvas is 8x8.', check: { kind: 'canvas', width: 8, height: 8 } },
      { id: 'camera.top', strength: 'must', statement: 'Top-down camera.', check: { kind: 'camera', preset: 'top_down' } },
      { id: 'lights.one', strength: 'must', statement: 'At most two lights.', check: { kind: 'light_count', max: 2 } },
      { id: 'appearance.unlit', strength: 'must', statement: 'Bound appearance uses unlit shading.', check: { kind: 'appearance_shading', value: 'unlit' } },
      { id: 'padding.safe', strength: 'should', statement: 'Keep at least 1px transparent padding.', check: { kind: 'padding', min: 1 } },
      { id: 'silhouette.read', strength: 'must', statement: 'The silhouette reads as one mass.', check: { kind: 'visual' } },
      { id: 'glow.unsupported', strength: 'should', statement: 'Add a soft glow.', check: { kind: 'unsupported', feature: 'soft glow' } },
    ],
    adaptations: [
      { id: 'prop-small', assetClass: 'prop', maxSize: 32, language: { form: 'Delete detail before shrinking functional gaps.', detail: 'One accent cluster.' } },
      { id: 'tree', assetClass: 'tree', language: { form: 'Canopy from overlapping masses.' } },
    ],
    references: [{ id: 'ref.shop', path: 'refs/shop.png', sha256: 'a'.repeat(64), role: 'positive', note: 'Warm workshop reference', observations: ['short chamfers'], inferences: ['ochre body'] }],
    source: { kind: 'hybrid', brief: 'Derived from a reference and authored decisions.', observations: ['short chamfers'], inferences: ['ochre body'], decisions: ['closed palette'], unknowns: ['metal treatment'] },
  };
}

function makeTheme(mutator = () => {}, id = 'soft-workshop', revision = 0) {
  const spec = baseSpec();
  mutator(spec);
  return normalizeTheme(spec, { id, revision });
}

function makeBinding(theme, context = {}, overrides = []) {
  return { id: theme.id, revision: theme.revision, hash: themeHash(theme), adapterVersion: '1', snapshot: theme, context, overrides };
}

function themedScene(theme, context = {}, nodes = [], options = {}) {
  const compiled = compileTheme(theme, context);
  const lights = compiled.defaults.lights ?? [{ id: 'key', type: 'directional', position: [0, 10, 0], direction: [0, -1, 0], intensity: 1, range: 0, color: '#ffffff' }];
  return createScene({
    id: options.id ?? 'themed-scene',
    width: options.width ?? 8,
    height: options.height ?? 8,
    camera: { preset: 'top_down' },
    palette: { ...compiled.defaults.palette },
    ramps: { ...compiled.defaults.ramps },
    materials: { ...compiled.defaults.materials },
    lights,
    ambient: compiled.defaults.ambient ?? 0.25,
    exposure: compiled.defaults.exposure ?? 1,
    nodes: [
      { id: 'root', kind: 'group', ...(compiled.defaults.outline ? { outline: { ...compiled.defaults.outline, group: 'root', occlusion: true } } : {}) },
      ...nodes,
    ],
    theme: makeBinding(theme, context, options.overrides ?? []),
  });
}

const bodyNode = { id: 'body', kind: 'part', geometry: { type: 'box', min: [-2, 0, -2], max: [2, 2, 2] }, material: 'theme.soft-workshop.body' };

function redImage(image) {
  const rgba = new Uint8Array(image.rgba);
  for (let index = 0; index < rgba.length; index += 4) {
    if (rgba[index + 3] !== 0) {
      rgba[index] = 255;
      rgba[index + 1] = 0;
      rgba[index + 2] = 0;
      return { ...image, rgba };
    }
  }
  throw new Error('No visible pixel to recolor.');
}

test('compileTheme namespaces resources and leaves unspecified directives absent', () => {
  const theme = makeTheme();
  const before = JSON.stringify(theme);
  const { defaults, capabilities, namespace } = compileTheme(theme, { view: 'top_down' });
  assert.equal(namespace.prefix, 'theme.soft-workshop.');
  assert.equal(namespace.palette.ink, 'theme.soft-workshop.ink');
  assert.equal(defaults.palette['theme.soft-workshop.ink'], '#2c2333');
  assert.deepEqual(defaults.ramps['theme.soft-workshop.body'].stops.map(stop => stop.color),
    ['theme.soft-workshop.body0', 'theme.soft-workshop.body1', 'theme.soft-workshop.body2']);
  assert.equal(defaults.materials['theme.soft-workshop.body'].ramp, 'theme.soft-workshop.body');
  assert.equal(defaults.materials['theme.soft-workshop.body'].specular, 0);
  assert.equal(defaults.defaultMaterial, 'theme.soft-workshop.body');
  assert.equal(defaults.outline.color, 'theme.soft-workshop.ink');
  assert.equal(defaults.outline.width, 1);
  assert.equal(defaults.ambient, 0.25);
  assert.equal(defaults.exposure, 1);
  assert.deepEqual(defaults.camera, { preset: 'top_down', pixelsPerUnit: 1 });
  assert.equal(defaults.appearanceShading, 'unlit');
  assert.equal(defaults.lights.length, 1);
  assert.equal(defaults.lights[0].id, 'theme.soft-workshop.key');
  assert.equal(defaults.lights[0].position, undefined);
  assert.equal(defaults.lights[0].range, undefined);
  assert.equal(defaults.lights[0].color, undefined);
  assert.equal(defaults.lights[0].intensity, 1);
  assert.equal(namespace.lightFrame.source, 'context');
  assert.equal(namespace.lightFrame.view, 'top_down');
  assert.equal(namespace.lightFrame.converted, 1);
  assert.equal(namespace.lightFrame.assumed, false);
  assert.ok(capabilities.missing.some(entry => entry.path === 'options.camera'));
  assert.equal(JSON.stringify(theme), before);
  assert.ok(Object.isFrozen(theme));
});

test('compileTheme uses the actual scene camera for view-frame lights when supplied', () => {
  const camera = { position: [10, 50, 10], target: [0, 0, 0], up: [0, 1, 0], mirrorX: false, pixelsPerUnit: 1, center: [4, 4] };
  const { defaults, capabilities, namespace } = compileTheme(makeTheme(), { view: 'top_down' }, { camera });
  const basis = cameraBasis({ camera });
  const [x, y, z] = [-0.4, -0.2, 0.9];
  const expected = normalize([
    basis.right[0] * x - basis.down[0] * y - basis.direction[0] * z,
    basis.right[1] * x - basis.down[1] * y - basis.direction[1] * z,
    basis.right[2] * x - basis.down[2] * y - basis.direction[2] * z,
  ]);
  assert.equal(namespace.lightFrame.source, 'camera');
  assert.equal(namespace.lightFrame.view, 'custom');
  assert.equal(namespace.lightFrame.assumed, false);
  assert.equal(capabilities.missing.length, 0);
  assert.ok(expected.every((value, index) => Math.abs(value - defaults.lights[0].direction[index]) < 1e-12));
});

test('compileTheme discloses a top_down fallback and missing actual camera', () => {
  const theme = makeTheme(spec => { delete spec.tokens.camera; });
  const { defaults, capabilities, namespace } = compileTheme(theme, {});
  assert.equal(namespace.lightFrame.source, 'default');
  assert.equal(namespace.lightFrame.view, 'top_down');
  assert.equal(namespace.lightFrame.assumed, true);
  assert.equal(defaults.camera, undefined);
  assert.ok(capabilities.warnings.some(entry => entry.feature === 'view-frame light conversion'));
  assert.ok(capabilities.missing.some(entry => entry.path === 'options.camera'));
  const basis = cameraBasis({ camera: { position: [0, 100, 0], target: [0, 0, 0], up: [0, 0, -1], mirrorX: false, pixelsPerUnit: 1, center: [0, 0] } });
  const expected = normalize([
    basis.right[0] * -0.4 - basis.down[0] * -0.2 - basis.direction[0] * 0.9,
    basis.right[1] * -0.4 - basis.down[1] * -0.2 - basis.direction[1] * 0.9,
    basis.right[2] * -0.4 - basis.down[2] * -0.2 - basis.direction[2] * 0.9,
  ]);
  assert.ok(expected.every((value, index) => Math.abs(value - defaults.lights[0].direction[index]) < 1e-12));
});

test('compileTheme reports unsupported desired features without silently dropping them', () => {
  const theme = makeTheme(spec => {
    spec.tokens.outline.width = 2;
    spec.tokens.materials.body.specular = 0.4;
    spec.tokens.lights[0].color = '#ffcc88';
    spec.tokens.lights.push({ id: 'fill', type: 'point', position: [1, 2, 3], frame: 'view' });
  });
  const { defaults, capabilities } = compileTheme(theme, { view: 'top_down' });
  const required = capabilities.unsupported.filter(entry => entry.required);
  assert.ok(required.some(entry => entry.path === 'tokens.outline.width'));
  assert.ok(required.some(entry => entry.path === 'tokens.materials.body.specular'));
  assert.ok(required.some(entry => entry.path === 'tokens.lights[0].color'));
  assert.ok(required.some(entry => entry.path === 'tokens.lights[1].frame'));
  assert.equal(defaults.outline.width, undefined);
  assert.equal(defaults.outline.enabled, true);
  assert.equal(defaults.materials['theme.soft-workshop.body'].specular, 0);
  assert.equal(defaults.lights[0].color, undefined);
  assert.equal(defaults.lights.length, 1);
});

test('compileTheme distinguishes absent lights from explicit no lights', () => {
  const absent = makeTheme(spec => { delete spec.tokens.lights; });
  const empty = makeTheme(spec => { spec.tokens.lights = []; });
  const absentCompiled = compileTheme(absent, { view: 'top_down' });
  const emptyCompiled = compileTheme(empty, { view: 'top_down' });
  assert.equal('lights' in absentCompiled.defaults, false);
  assert.deepEqual(emptyCompiled.defaults.lights, []);
  assert.equal(emptyCompiled.namespace.lightFrame.source, 'none');
  assert.equal(absentCompiled.namespace.lightFrame.source, 'none');
});

test('readThemePack returns an actionable working pack without claiming a pass', () => {
  const theme = makeTheme();
  const pack = readThemePack(theme, { assetClass: 'prop', nativeSize: [64, 64], view: 'top_down', channels: ['beauty', 'normalmap'] });
  assert.equal(pack.view, 'working');
  assert.equal(pack.theme.id, 'soft-workshop');
  assert.equal(pack.identity.hash, themeHash(theme));
  assert.equal(pack.brief, theme.summary);
  assert.deepEqual(pack.signature.map(item => item.id), ['edge.crisp', 'color.closed']);
  assert.equal(pack.rules.length, 10);
  assert.ok(pack.hardRuleIds.includes('edge.crisp'));
  assert.ok(pack.reviewChecklist.mechanical.every(item => item.status === 'pending'));
  assert.ok(pack.reviewChecklist.visual.every(item => item.status === 'needs_review'));
  assert.ok(pack.reviewChecklist.unsupported.every(item => item.status === 'unsupported'));
  assert.equal(pack.reviewChecklist.evaluation, 'pending');
  assert.equal(pack.evaluation, 'pending');
  assert.equal(pack.tokens.colors.find(color => color.key === 'ink').resourceId, 'theme.soft-workshop.ink');
  assert.equal(pack.tokens.ramps.find(ramp => ramp.key === 'body').stops[1].resourceId, 'theme.soft-workshop.body1');
  assert.equal(pack.bindings.defaults.defaultMaterial, 'theme.soft-workshop.body');
  assert.equal(pack.bindings.blocked, false);
  assert.equal(pack.definition, undefined);
  assert.ok(pack.omittedSections.includes('definition'));
  assert.equal(pack.language.form, 'Large masses with short chamfers; details serve the main mass.');
  assert.ok(pack.adaptations.find(item => item.id === 'prop-small').status === 'not_applicable');
  assert.ok(pack.unknowns.some(item => item.kind === 'source_unknown' && item.detail === 'metal treatment'));
  assert.ok(pack.unknowns.some(item => item.kind === 'capability_missing'));
  assert.equal(pack.references.length, 1);
  assert.equal(pack.source.kind, 'hybrid');
  assert.equal(pack.evidence.referenceIds[0], 'ref.shop');
  const statuses = [...pack.reviewChecklist.mechanical, ...pack.reviewChecklist.visual, ...pack.reviewChecklist.unsupported].map(item => item.status);
  assert.ok(!statuses.includes('pass'));
});

test('readThemePack resolves size and asset-class adaptations from context', () => {
  const theme = makeTheme();
  const small = readThemePack(theme, { assetClass: 'prop', nativeSize: [32, 32] });
  assert.equal(small.language.form, 'Delete detail before shrinking functional gaps.');
  assert.equal(small.languageSources.form, 'prop-small');
  assert.equal(small.adaptations.find(item => item.id === 'prop-small').status, 'applied');
  assert.equal(small.adaptations.find(item => item.id === 'tree').status, 'not_applicable');

  const unknownClass = readThemePack(theme, { nativeSize: [32, 32] });
  assert.equal(unknownClass.adaptations.find(item => item.id === 'prop-small').status, 'undecidable');
  assert.ok(unknownClass.unknowns.some(item => item.kind === 'context_missing' && item.field === 'assetClass'));
  assert.equal(unknownClass.language.form, 'Large masses with short chamfers; details serve the main mass.');

  const unknownSize = readThemePack(theme, { assetClass: 'prop' });
  assert.equal(unknownSize.adaptations.find(item => item.id === 'prop-small').status, 'undecidable');
  assert.ok(unknownSize.unknowns.some(item => item.kind === 'context_missing' && item.field === 'nativeSize'));
});

test('readThemePack supports section filtering and full definition', () => {
  const theme = makeTheme();
  const filtered = readThemePack(theme, { assetClass: 'prop', nativeSize: [64, 64] }, { sections: ['form'] });
  assert.deepEqual(Object.keys(filtered.language), ['form']);
  assert.ok(filtered.omittedSections.includes('color'));
  assert.ok(filtered.omittedSections.includes('references'));
  assert.equal(filtered.references, null);
  assert.equal(filtered.source, null);
  assert.ok(filtered.tokens.colors.length > 0);
  assert.equal(filtered.rules.length, 10);
  assert.ok(filtered.capabilities);
  assert.ok(filtered.reviewChecklist);
  const full = readThemePack(theme, { assetClass: 'prop', nativeSize: [64, 64] }, { view: 'full' });
  assert.equal(full.definition.id, 'soft-workshop');
  assert.ok(!full.omittedSections.includes('definition'));
  assert.throws(() => readThemePack(theme, {}, { sections: ['nope'] }), /Unknown read section/);
});

test('readThemePack never truncates hard rules and exposes unsupported capabilities', () => {
  const many = makeTheme(spec => {
    spec.rules = Array.from({ length: 64 }, (_, index) => ({ id: 'rule.' + index, strength: 'must', statement: 'Rule ' + index, check: { kind: 'palette' } }));
    spec.signature = [];
  });
  const pack = readThemePack(many, { assetClass: 'prop', nativeSize: [64, 64] });
  assert.equal(pack.rules.length, 64);
  assert.equal(pack.hardRuleIds.length, 64);
  assert.equal(pack.reviewChecklist.mechanical.length, 64);

  const unsupported = makeTheme(spec => { spec.tokens.materials.body.specular = 0.4; });
  const unsupportedPack = readThemePack(unsupported, { assetClass: 'prop', nativeSize: [64, 64] });
  assert.equal(unsupportedPack.bindings.blocked, true);
  assert.ok(unsupportedPack.capabilities.unsupported.some(entry => entry.feature === 'specular highlights' && entry.required));
  assert.ok(unsupportedPack.unknowns.some(item => item.kind === 'unsupported_feature' && item.required));
});

test('themeReport returns null without a theme and rejects diagnostic rasters', () => {
  const plain = createScene({ id: 'plain', width: 8, height: 8 });
  const plainImage = renderScene(plain);
  assert.equal(themeReport(plain, plainImage), null);

  const themed = themedScene(makeTheme(), { assetClass: 'prop', nativeSize: [8, 8] }, [bodyNode]);
  const image = renderScene(themed);
  assert.throws(() => themeReport(themed, { ...image, stats: { ...image.stats, mode: 'normalmap' } }), /beauty buffer/);
  assert.throws(() => themeReport(themed, { ...image, mode: 'depth' }), /beauty buffer/);
  assert.throws(() => themeReport(themed, { ...image, width: 9 }), /beauty image/);
  assert.throws(() => themeReport(themed, { ...image, rgba: new Uint8Array(4) }), /rgba buffer/);
  const badBinding = { ...themed, theme: { ...themed.theme, hash: '0'.repeat(64) } };
  assert.throws(() => themeReport(badBinding, image), /hash/i);
});

test('themeReport checks the final beauty RGBA and blocks a hard palette failure', () => {
  const theme = makeTheme();
  const scene = themedScene(theme, { assetClass: 'prop', nativeSize: [8, 8] }, [bodyNode]);
  const image = renderScene(scene);
  const report = themeReport(scene, image);
  assert.equal(report.theme.id, 'soft-workshop');
  assert.equal(report.theme.revision, 0);
  assert.equal(report.theme.hash, themeHash(theme));
  assert.equal(report.sceneRevision, 0);
  assert.equal(report.checks.find(check => check.id === 'color.closed').status, 'pass');
  assert.equal(report.checks.find(check => check.id === 'edge.crisp').status, 'pass');
  assert.equal(report.checks.find(check => check.id === 'alpha.binary').status, 'pass');
  assert.equal(report.checks.find(check => check.id === 'canvas.8').status, 'pass');
  assert.equal(report.checks.find(check => check.id === 'camera.top').status, 'pass');
  assert.equal(report.checks.find(check => check.id === 'lights.one').status, 'pass');
  assert.equal(report.checks.find(check => check.id === 'appearance.unlit').status, 'not_applicable');
  assert.equal(report.checks.find(check => check.id === 'padding.safe').status, 'pass');
  assert.equal(report.checks.find(check => check.id === 'silhouette.read').status, 'needs_review');
  assert.equal(report.checks.find(check => check.id === 'glow.unsupported').status, 'unsupported');
  assert.equal(report.mechanical.status, 'pass');
  assert.equal(report.visual.status, 'needs_review');
  assert.equal(report.blocked, false);
  assert.equal(report.capabilities.missing.length, 0);

  const failed = themeReport(scene, redImage(image));
  const palette = failed.checks.find(check => check.id === 'color.closed');
  assert.equal(palette.status, 'fail');
  assert.ok(palette.evidence.violatingPixels >= 1);
  assert.equal(failed.mechanical.status, 'fail');
  assert.equal(failed.blocked, true);
});

test('themeReport scans outline pixels in the final beauty buffer', () => {
  const theme = makeTheme(spec => {
    spec.rules = [{ id: 'color.closed', strength: 'must', statement: 'Final opaque pixels use only theme colors.', check: { kind: 'palette' } }];
    spec.signature = [];
  });
  const base = themedScene(theme, { assetClass: 'prop', nativeSize: [8, 8] }, [bodyNode]);
  const changed = {
    ...base,
    nodes: base.nodes.map(node => node.id === 'root'
      ? { ...node, outline: { ...node.outline, color: '#ff00ff' } }
      : node),
  };
  const image = renderScene(changed);
  const report = themeReport(changed, image);
  assert.equal(report.checks[0].status, 'fail');
  assert.ok(report.checks[0].evidence.sampleViolatingColors.includes('#ff00ff'));
});

test('themeReport inverts must_not predicates and never blocks on should', () => {
  const mustNot = makeTheme(spec => {
    spec.rules = [
      { id: 'no.extra.lights', strength: 'must_not', statement: 'Never more than two lights.', check: { kind: 'light_count', max: 2 } },
      { id: 'prefer.palette', strength: 'should', statement: 'Prefer the theme palette.', check: { kind: 'palette' } },
    ];
    spec.signature = [];
  });
  const scene = themedScene(mustNot, { assetClass: 'prop', nativeSize: [8, 8] }, [bodyNode]);
  const image = renderScene(scene);
  const report = themeReport(scene, image);
  const lightCheck = report.checks.find(check => check.id === 'no.extra.lights');
  assert.equal(lightCheck.status, 'fail');
  assert.equal(lightCheck.evidence.inverted, true);
  assert.equal(lightCheck.evidence.predicate, true);
  assert.equal(report.blocked, true);

  const shouldOnly = makeTheme(spec => {
    spec.rules = [{ id: 'prefer.palette', strength: 'should', statement: 'Prefer the theme palette.', check: { kind: 'palette' } }];
    spec.signature = [];
  });
  const shouldScene = themedScene(shouldOnly, { assetClass: 'prop', nativeSize: [8, 8] }, [bodyNode]);
  const shouldReport = themeReport(shouldScene, redImage(renderScene(shouldScene)));
  assert.equal(shouldReport.checks[0].status, 'fail');
  assert.equal(shouldReport.blocked, false);
  assert.equal(shouldReport.mechanical.status, 'fail');
  assert.deepEqual(shouldReport.mechanical.advisoryFailures, ['prefer.palette']);

  const mustNotPass = makeTheme(spec => {
    spec.rules = [{ id: 'no.lights', strength: 'must_not', statement: 'Never any lights.', check: { kind: 'light_count', max: 0 } }];
    spec.signature = [];
  });
  const passScene = themedScene(mustNotPass, { assetClass: 'prop', nativeSize: [8, 8] }, [bodyNode]);
  const passReport = themeReport(passScene, renderScene(passScene));
  assert.equal(passReport.checks[0].status, 'pass');
  assert.equal(passReport.blocked, false);
});

test('themeReport waives overrides and preserves deviations', () => {
  const theme = makeTheme();
  const scene = themedScene(theme, { assetClass: 'prop', nativeSize: [8, 8] }, [bodyNode], {
    overrides: [{ rule: 'color.closed', reason: 'User requested a red accent for this asset.' }],
  });
  const report = themeReport(scene, redImage(renderScene(scene)));
  const check = report.checks.find(item => item.id === 'color.closed');
  assert.equal(check.status, 'waived');
  assert.equal(check.method, 'override');
  assert.equal(check.evidence.reason, 'User requested a red accent for this asset.');
  assert.equal(report.deviations.length, 1);
  assert.equal(report.deviations[0].rule, 'color.closed');
  assert.equal(report.blocked, false);
  assert.match(report.note, /override/i);
  assert.throws(() => validateThemeBinding(makeBinding(theme, {}, [{ rule: 'unknown.rule', reason: 'x' }])), /unknown rule/i);
});

test('themeReport keeps unknown scopes as needs_review and mechanical pending', () => {
  const theme = makeTheme(spec => {
    spec.rules = [{ id: 'tree.only', strength: 'must', statement: 'Tree-only palette.', scope: { assetClasses: ['tree'] }, check: { kind: 'palette' } }];
    spec.signature = [];
  });
  const unknown = themedScene(theme, { nativeSize: [8, 8] }, [bodyNode]);
  const unknownReport = themeReport(unknown, renderScene(unknown));
  assert.equal(unknownReport.checks[0].status, 'needs_review');
  assert.ok(unknownReport.checks[0].evidence.missing.includes('assetClass'));
  assert.equal(unknownReport.mechanical.status, 'pending');
  assert.equal(unknownReport.blocked, false);

  const outOfScope = themedScene(theme, { assetClass: 'prop', nativeSize: [8, 8] }, [bodyNode]);
  const outReport = themeReport(outOfScope, renderScene(outOfScope));
  assert.equal(outReport.checks[0].status, 'not_applicable');
  assert.equal(outReport.mechanical.status, 'pass');
  assert.equal(outReport.blocked, false);

  const inScope = themedScene(theme, { assetClass: 'tree', nativeSize: [8, 8] }, [bodyNode]);
  const inReport = themeReport(inScope, renderScene(inScope));
  assert.equal(inReport.checks[0].status, 'pass');
});

test('themeReport keeps rules without a check as manual needs_review', () => {
  const theme = makeTheme(spec => {
    spec.rules = [{ id: 'mass.read', strength: 'must', statement: 'The primary mass reads clearly.' }];
    spec.signature = [];
  });
  const scene = themedScene(theme, { assetClass: 'prop', nativeSize: [8, 8] }, [bodyNode]);
  const report = themeReport(scene, renderScene(scene));
  assert.equal(report.checks[0].status, 'needs_review');
  assert.equal(report.checks[0].method, 'manual');
  assert.equal(report.visual.status, 'needs_review');
  assert.deepEqual(report.visual.ruleIds, ['mass.read']);
  assert.equal(report.blocked, false);
});

test('themeReport checks outline configuration, not painted line morphology', () => {
  const theme = makeTheme(spec => {
    spec.rules = [{ id: 'edge.outside', strength: 'must', statement: 'Outside outline.', check: { kind: 'outline', enabled: true, direction: 'outside', width: 1, color: 'ink' } }];
    spec.signature = [];
  });
  const scene = themedScene(theme, { assetClass: 'prop', nativeSize: [8, 8] }, [bodyNode]);
  const report = themeReport(scene, renderScene(scene));
  const check = report.checks[0];
  assert.equal(check.status, 'fail');
  assert.ok(check.evidence.mismatches[0].fields.includes('direction'));
  assert.equal(report.blocked, true);

  const empty = themedScene(theme, { assetClass: 'prop', nativeSize: [8, 8] }, []);
  const emptyReport = themeReport(empty, renderScene(empty));
  assert.equal(emptyReport.checks[0].status, 'not_applicable');
  assert.equal(emptyReport.blocked, false);
});

test('themeReport checks bound appearance shading without pretending it owns beauty', () => {
  const theme = makeTheme(spec => {
    spec.rules = [{ id: 'appearance.unlit', strength: 'must', statement: 'Bound appearance uses unlit shading.', check: { kind: 'appearance_shading', value: 'unlit' } }];
    spec.signature = [];
  });
  const layer = {
    id: 'paint', kind: 'layer', parent: 'body', width: 2, height: 2, plane: 'xz',
    pixels: ['theme.soft-workshop.body1', 'theme.soft-workshop.body2', 'theme.soft-workshop.body2', 'theme.soft-workshop.body1'],
    appearanceOf: 'body', appearanceShading: 'lit', transform: { position: [0, 2.01, 0] },
  };
  const litScene = themedScene(theme, { assetClass: 'prop', nativeSize: [8, 8] }, [bodyNode, layer]);
  const litReport = themeReport(litScene, renderScene(litScene));
  assert.equal(litReport.checks[0].status, 'fail');
  assert.equal(litReport.blocked, true);
  assert.equal(litReport.checks[0].evidence.layers[0].effective, 'lit');

  const unlitScene = themedScene(theme, { assetClass: 'prop', nativeSize: [8, 8] }, [bodyNode, { ...layer, appearanceShading: 'unlit' }]);
  const unlitReport = themeReport(unlitScene, renderScene(unlitScene));
  assert.equal(unlitReport.checks[0].status, 'pass');
  assert.equal(unlitReport.blocked, false);

  const noAppearance = themedScene(theme, { assetClass: 'prop', nativeSize: [8, 8] }, [bodyNode]);
  const noReport = themeReport(noAppearance, renderScene(noAppearance));
  assert.equal(noReport.checks[0].status, 'not_applicable');
});

test('themeReport uses only the pinned snapshot, not a mutable library revision', () => {
  const snapshot = makeTheme();
  const scene = themedScene(snapshot, { assetClass: 'prop', nativeSize: [8, 8] }, [bodyNode]);
  const updated = makeTheme(spec => {
    spec.tokens.colors.ink.value = '#000000';
    spec.rules = [{ id: 'color.closed', strength: 'must', statement: 'Final opaque pixels use only theme colors.', check: { kind: 'palette' } }];
    spec.signature = ['color.closed'];
  }, 'soft-workshop', 1);
  assert.notEqual(themeHash(snapshot), themeHash(updated));
  const report = themeReport(scene, renderScene(scene));
  assert.equal(report.theme.revision, 0);
  assert.equal(report.theme.hash, themeHash(snapshot));
  assert.equal(report.checks.find(check => check.id === 'color.closed').status, 'pass');
  assert.equal(report.checks.find(check => check.id === 'edge.crisp').status, 'pass');
});

test('themeReport blocks a hard unsupported rule but not a should unsupported rule', () => {
  const hard = makeTheme(spec => {
    spec.rules = [{ id: 'glow.required', strength: 'must', statement: 'Add a soft glow.', check: { kind: 'unsupported', feature: 'soft glow' } }];
    spec.signature = [];
  });
  const scene = themedScene(hard, { assetClass: 'prop', nativeSize: [8, 8] }, [bodyNode]);
  const report = themeReport(scene, renderScene(scene));
  assert.equal(report.checks[0].status, 'unsupported');
  assert.equal(report.blocked, true);
  assert.equal(report.mechanical.status, 'pass');

  const advisory = makeTheme(spec => {
    spec.rules = [{ id: 'glow.preferred', strength: 'should', statement: 'Add a soft glow.', check: { kind: 'unsupported', feature: 'soft glow' } }];
    spec.signature = [];
  });
  const advisoryScene = themedScene(advisory, { assetClass: 'prop', nativeSize: [8, 8] }, [bodyNode]);
  const advisoryReport = themeReport(advisoryScene, renderScene(advisoryScene));
  assert.equal(advisoryReport.checks[0].status, 'unsupported');
  assert.equal(advisoryReport.blocked, false);
});

test('required unsupported tokens block even when every mechanical rule passes', () => {
  const theme = makeTheme(spec => { spec.tokens.materials.body.specular = 0.4; });
  const scene = themedScene(theme, { assetClass: 'prop', nativeSize: [8, 8] }, [bodyNode]);
  const report = themeReport(scene, renderScene(scene));
  assert.ok(report.capabilities.unsupported.some(entry => entry.feature === 'specular highlights' && entry.required));
  assert.equal(report.blocked, true);
  assert.equal(report.mechanical.status, 'pass');
});

test('themeReport rejects noncanonical themes instead of treating malformed data as style conformity', () => {
  const theme = makeTheme();
  const malformed = { ...theme, tokens: { ...theme.tokens, mystery: 1 } };
  assert.throws(() => compileTheme(malformed, {}), /Unknown field/);
  const scene = themedScene(theme, { assetClass: 'prop', nativeSize: [8, 8] }, [bodyNode]);
  const broken = { ...scene, theme: { ...scene.theme, snapshot: malformed } };
  assert.throws(() => themeReport(broken, renderScene(scene)), /Unknown field|canonical/i);
});
