import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createCapability } from '../src/capability.mjs';
import { TOOL_SCHEMAS } from '../src/protocol.mjs';
import { toolDefinitions } from '../src/protocol.mjs';
import { executionPolicy } from '../src/execution.mjs';
import { validateExampleDependencies } from '../src/interaction.mjs';
import { THEME_EXAMPLE } from '../src/guides.mjs';

// Behavioural checks for the additive interaction/execution metadata and for
// the real local-edit/preview/normal workflow it advertises. All writes stay in
// a per-test workspace under the package .validation directory.

const root = fileURLToPath(new URL('../', import.meta.url));
const scene = { width: 8, height: 8, camera: { preset: 'top_down' }, nodes: [{ id: 'body', kind: 'part', geometry: { type: 'box', center: [0, 1, 0], size: [2, 2, 2] } }] };

async function fixture(t) {
  await fs.mkdir(path.join(root, '.validation'), { recursive: true });
  const workspace = await fs.mkdtemp(path.join(root, '.validation', 'interaction-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const ports = {
    workspace: { async ensure(request) { return request.workspace; } },
    attachments: {
      imageLimits: { maxImageDimension: 4096 },
      async saveImages(images) { return images.map((image, index) => ({ id: 'attachment-' + index, name: image.name, mediaType: image.mediaType })); },
      async toContent(attachment) { return [{ type: 'image', attachment }]; },
    },
    async modelInput() { return 'capability_unknown'; },
  };
  const capability = createCapability(ports);
  t.after(() => capability.dispose());
  const request = (suffix = 'interaction', mode = 'workspace-write', modelInput = 'image_capable') => ({
    actorId: 'actor-' + suffix,
    sessionId: 'session-' + suffix,
    workspace,
    signal: new AbortController().signal,
    callId: 'call-' + suffix,
    rootCallId: 'root-' + suffix,
    policy: { mode, workspaceRoot: workspace },
    modelInput,
  });
  const execute = async (action, args, suffix = 'interaction') => capability.execute(action, args, request(suffix));
  return { capability, workspace, request, execute };
}

function setPointer(target, pointer, value) {
  const parts = pointer.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cursor = target;
  for (const part of parts.slice(0, -1)) cursor = cursor[part];
  cursor[parts.at(-1)] = value;
}

function bind(example, values) {
  const args = JSON.parse(JSON.stringify(example.args));
  for (const binding of example.bindings) {
    assert.ok(Object.hasOwn(values, binding.path), example.id + ' missing binding ' + binding.path);
    setPointer(args, binding.path, values[binding.path]);
  }
  return args;
}

const png = async file => {
  const bytes = await fs.readFile(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return bytes;
};

test('descriptor operations expose the standalone schema, description and execution metadata', async t => {
  const { capability } = await fixture(t);
  const standalone = toolDefinitions({ run: async () => ({}) });
  assert.equal(capability.descriptor.contractVersion, 1);
  assert.equal(capability.descriptor.version, '0.5.3-dev');
  assert.deepEqual(capability.descriptor.operations.map(operation => operation.name), ['scene', 'render', 'normalmap', 'inspect', 'export', 'guide', 'theme']);
  for (const operation of capability.descriptor.operations) {
    const schema = TOOL_SCHEMAS.find(item => item.name === 'zpixel_' + operation.name);
    const definition = standalone.find(item => item.name === 'zpixel_' + operation.name);
    assert.equal(operation.description, schema.description);
    assert.deepEqual(operation.parameters, schema.parameters);
    assert.deepEqual(operation.outputSchema, { type: 'object', additionalProperties: true });
    assert.deepEqual(operation.execution, executionPolicy(operation.name, {}));
    assert.equal(operation.execution.timeoutMs, definition.timeoutMs);
    assert.equal(operation.execution.concurrencySafe, definition.isConcurrencySafe({}));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(capability.descriptor)), capability.descriptor);
});

test('executionPolicy classifies reads, observations and writes conservatively', async t => {
  const { capability } = await fixture(t);
  assert.deepEqual(capability.executionPolicy('guide', {}), { timeoutMs: 120000, concurrencySafe: true });
  assert.deepEqual(capability.executionPolicy('inspect', {}), { timeoutMs: 120000, concurrencySafe: true });
  assert.deepEqual(capability.executionPolicy('render', {}), { timeoutMs: 120000, concurrencySafe: true });
  assert.equal(capability.executionPolicy('scene', { action: 'open' }).concurrencySafe, true);
  assert.equal(capability.executionPolicy('scene', { action: 'list' }).concurrencySafe, true);
  assert.equal(capability.executionPolicy('scene', { action: 'edit' }).concurrencySafe, false);
  assert.equal(capability.executionPolicy('normalmap', {}).concurrencySafe, true);
  assert.equal(capability.executionPolicy('normalmap', { export: true }).concurrencySafe, false);
  assert.equal(capability.executionPolicy('theme', { action: 'read' }).concurrencySafe, true);
  assert.equal(capability.executionPolicy('theme', { action: 'list' }).concurrencySafe, true);
  assert.equal(capability.executionPolicy('theme', { action: 'add' }).concurrencySafe, false);
  assert.equal(capability.executionPolicy('export', {}).concurrencySafe, false);
  assert.deepEqual(capability.executionPolicy('unknown', {}), { timeoutMs: 120000, concurrencySafe: false });
  assert.deepEqual(capability.executionPolicy('zpixel_render', {}), { timeoutMs: 120000, concurrencySafe: true });
});

test('interaction aliases, topics and examples are valid and every guide topic resolves', async t => {
  const { capability, execute } = await fixture(t);
  const interaction = capability.descriptor.interaction;
  assert.equal(interaction.version, 1);
  assert.match(interaction.workflow, /zpixel_scene, zpixel_render/);
  assert.deepEqual(interaction.aliases, { zpixel_scene: 'scene', zpixel_render: 'render', zpixel_normalmap: 'normalmap', zpixel_inspect: 'inspect', zpixel_export: 'export', zpixel_guide: 'guide', zpixel_theme: 'theme' });
  const actions = new Set(capability.descriptor.operations.map(operation => operation.name));
  assert.deepEqual(interaction.topics.map(topic => topic.id), ['overview', 'camera', 'observation', 'nodes', 'geometry', 'anchors', 'spatial', 'painting', 'lighting', 'migration', 'normalmap', 'theme', 'tools', 'limits']);
  for (const topic of interaction.topics) {
    assert(actions.has(topic.action), topic.id);
    const result = await execute(topic.action, topic.args);
    assert.equal(result.value.topic, topic.id);
    assert.equal(typeof result.value.text, 'string');
  }
  const ids = new Set();
  for (const example of interaction.examples) {
    assert(!ids.has(example.id), example.id);
    ids.add(example.id);
    assert(actions.has(example.action), example.id);
    assert.equal(typeof example.args, 'object');
    assert(!Array.isArray(example.args));
    assert.equal(typeof example.description, 'string');
    if (example.bindings) {
      assert(example.bindings.length > 0, example.id);
      for (const binding of example.bindings) {
        assert.match(binding.path, /^\//, example.id);
        assert(['string', 'integer', 'number', 'boolean', 'object', 'array'].includes(binding.type), example.id);
        assert.equal(typeof binding.description, 'string');
      }
    }
  }
  assert.equal(interaction.examples.filter(example => example.bindings).length, 3);
  assert.equal(interaction.dependencyValidation.ok, true, JSON.stringify(interaction.dependencyValidation.errors));
  assert.deepEqual([...interaction.dependencyValidation.order].sort(), [...ids].sort());
  const index = new Map(interaction.examples.map((example, position) => [example.id, position]));
  for (const example of interaction.examples) {
    if (example.dependsOn === undefined) continue;
    assert(Array.isArray(example.dependsOn), example.id);
    for (const dependency of example.dependsOn) {
      assert(ids.has(dependency), example.id + ' -> ' + dependency);
      assert(index.get(dependency) < index.get(example.id), example.id + ' must follow ' + dependency);
    }
  }
  assert(interaction.examples.find(example => example.id === 'edit-transform').dependsOn.includes('create-yard'));
  assert(interaction.examples.find(example => example.id === 'normalmap-export').dependsOn.includes('edit-node-set'));
  const unknown = validateExampleDependencies([{id: 'a', dependsOn: ['missing']}]);
  assert.equal(unknown.ok, false);
  assert(unknown.errors.some(error => error.code === 'DEPENDENCY_UNKNOWN'));
  const cyclic = validateExampleDependencies([{id: 'a', dependsOn: ['b']}, {id: 'b', dependsOn: ['a']}]);
  assert.equal(cyclic.ok, false);
  assert(cyclic.errors.some(error => error.code === 'DEPENDENCY_CYCLE'));
});

test('the self-contained workflow performs real local edits, previews, normal pairing and export', async t => {
  const { capability, workspace, execute } = await fixture(t);
  const examples = new Map(capability.descriptor.interaction.examples.map(example => [example.id, example]));
  const run = async id => {
    const example = examples.get(id);
    assert.ok(example, id);
    assert.equal(example.bindings, undefined, id + ' must be self-contained');
    return execute(example.action, JSON.parse(JSON.stringify(example.args)));
  };

  const created = await run('create-yard');
  assert.equal(created.value.id, 'interaction-yard');
  assert.equal(created.value.revision, 0);
  assert.ok(created.value.attachment);
  assert.equal(created.content[0].type, 'image');
  assert.equal(created.value.preview.workingView, true);

  const moved = await run('edit-transform');
  assert.equal(moved.value.revision, 1);
  const painted = await run('edit-paint');
  assert.equal(painted.value.revision, 2);
  const renamed = await run('edit-node-set');
  assert.equal(renamed.value.revision, 3);

  const stale = await execute('scene', { action: 'edit', document: 'interaction-yard', revision: 0, txid: 'interaction-stale', ops: [{ op: 'transform', id: 'gate', translate: [1, 0, 0] }] })
    .then(() => null, error => error);
  assert.equal(stale?.code, 'REVISION_CONFLICT');

  const spatial = await run('inspect-spatial');
  assert.equal(spatial.value.document, 'interaction-yard');
  assert.ok(Array.isArray(spatial.value.nodes));
  assert.ok(Array.isArray(spatial.value.nodes[0].intent));
  assert.ok(spatial.value.nodes[0].worldObservations !== undefined);

  const delivery = await run('render-delivery');
  assert.ok(delivery.value.attachment);
  assert.equal(delivery.value.delivery, true);
  assert.equal(delivery.content[0].type, 'image');

  const observed = await run('observe-three-quarter');
  assert.equal(observed.value.delivery, false);
  assert.ok(observed.value.observation?.id);
  assert.ok(observed.value.attachment);

  const normalPreview = await run('normalmap-preview');
  assert.ok(normalPreview.value.attachment);
  assert.equal(normalPreview.value.exported, false);
  assert.ok(normalPreview.value.normalMap);

  const normalExport = await run('normalmap-export');
  assert.equal(normalExport.value.exported, true);
  assert.equal(normalExport.value.version, '0.5.3-dev');
  const normalBytes = await png(normalExport.value.png);
  const beautyBytes = await png(normalExport.value.sprite);
  const normalManifest = JSON.parse(await fs.readFile(normalExport.value.manifest, 'utf8'));
  assert.equal(normalManifest.version, '0.5.3-dev');
  assert.equal(normalManifest.renderer.version, '0.3.6');
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(normalManifest.png.normal.sha256, sha256(normalBytes));
  assert.equal(normalManifest.png.beauty.sha256, sha256(beautyBytes));

  const draft = await run('export-draft');
  assert.equal(draft.value.status, 'draft');
  await png(path.resolve(workspace, draft.value.png));

  const listed = await run('list-documents');
  assert.ok(Array.isArray(listed.value.documents));
  assert.ok(listed.value.documents.some(document => document.id === 'interaction-yard'));
});

test('template examples are schema-valid and execute after typed binding', async t => {
  const { capability, execute } = await fixture(t);
  const examples = new Map(capability.descriptor.interaction.examples.map(example => [example.id, example]));

  // edit-existing-template: bind a real document, revision and node id.
  const bound = await execute('scene', { action: 'create', document: 'interaction-bound-doc', txid: 'interaction-bound-create', scene });
  assert.equal(bound.value.revision, 0);
  const editTemplate = examples.get('edit-existing-template');
  const editArgs = bind(editTemplate, { '/document': 'interaction-bound-doc', '/revision': 0, '/ops/0/id': 'body' });
  const edited = await execute('scene', editArgs);
  assert.equal(edited.value.revision, 1);

  // theme-read-template: bind a real theme id and pinned revision.
  const added = await execute('theme', { action: 'add', theme: 'interaction-bound-theme', txid: 'interaction-bound-theme-add', spec: THEME_EXAMPLE });
  assert.equal(added.value.theme.revision, 0);
  const themeTemplate = examples.get('theme-read-template');
  const themeArgs = bind(themeTemplate, { '/theme': 'interaction-bound-theme', '/revision': 0 });
  const themeRead = await execute('theme', themeArgs);
  assert.equal(themeRead.value.theme.id, 'interaction-bound-theme');

  // reviewed-export-template: bind a real document/revision and an honest note.
  const reviewed = await execute('scene', { action: 'create', document: 'interaction-reviewed', txid: 'interaction-reviewed-create', scene });
  assert.equal(reviewed.value.revision, 0);
  await execute('render', { document: 'interaction-reviewed' });
  await execute('render', { document: 'interaction-reviewed', camera: { preset: 'three_quarter' } });
  const exportTemplate = examples.get('reviewed-export-template');
  const exportArgs = bind(exportTemplate, { '/document': 'interaction-reviewed', '/revision': 0, '/review/note': 'Bound reviewed export: the box reads at native size with a visible outline.' });
  const exported = await execute('export', exportArgs);
  assert.equal(exported.value.status, 'reviewed');
  await png(path.resolve(exported.value.png));
});
