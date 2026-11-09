import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCapability } from '../src/capability.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scene = { width: 8, height: 8, camera: { preset: 'top_down' }, nodes: [{ id: 'body', kind: 'part', geometry: { type: 'box', center: [0, 1, 0], size: [2, 2, 2] } }] };

async function fixture(t) {
  await fs.mkdir(path.join(root, '.validation'), { recursive: true });
  const workspace = await fs.mkdtemp(path.join(root, '.validation', 'capability-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const ports = {
    workspace: { async ensure(request) { return request.workspace; } },
    attachments: {
      imageLimits: { maxImageDimension: 4096 },
      async saveImages(images) { return images.map((image, index) => ({ id: `attachment-${index}`, name: image.name, mediaType: image.mediaType })); },
      async toContent(attachment) { return [{ type: 'image', attachment }]; },
    },
    async modelInput() { return 'capability_unknown'; },
  };
  const capability = createCapability(ports);
  t.after(() => capability.dispose());
  const request = (mode, modelInput = 'image_capable', suffix = mode) => ({
    actorId: `actor-${suffix}`,
    sessionId: `session-${suffix}`,
    workspace,
    signal: new AbortController().signal,
    callId: `call-${suffix}`,
    rootCallId: `root-${suffix}`,
    policy: { mode, workspaceRoot: workspace },
    modelInput,
  });
  return { capability, request };
}

test('capability descriptor exposes the seven suffix operations and preserves image content', async t => {
  const { capability, request } = await fixture(t);
  assert.deepEqual(capability.descriptor.operations.map(operation => operation.name), ['scene', 'render', 'normalmap', 'inspect', 'export', 'guide', 'theme']);
  const created = await capability.execute('scene', { action: 'create', document: 'descriptor', txid: 'descriptor-create', scene }, request('workspace-write', 'image_capable', 'descriptor'));
  const rendered = await capability.execute('render', { document: 'descriptor', scale: 1 }, request('workspace-write', 'image_capable', 'descriptor'));
  assert.equal(created.value.revision, 0);
  assert.ok(rendered.value.attachment);
  assert.deepEqual(rendered.content, [{ type: 'image', attachment: rendered.value.attachment }]);
});

test('read-only, workspace-write and danger-full-access are explicit policy modes', async t => {
  const { capability, request } = await fixture(t);
  await assert.rejects(
    capability.execute('scene', { action: 'create', document: 'readonly', txid: 'readonly-create', scene }, request('read-only', 'image_capable', 'readonly')),
    error => error.code === 'READ_ONLY',
  );
  await assert.doesNotReject(capability.execute('scene', { action: 'create', document: 'workspace', txid: 'workspace-create', scene }, request('workspace-write', 'image_capable', 'workspace')));
  await assert.doesNotReject(capability.execute('scene', { action: 'create', document: 'danger', txid: 'danger-create', scene }, request('danger-full-access', 'image_capable', 'danger')));
  await assert.rejects(
    capability.execute('scene', { action: 'create', document: 'unknown', txid: 'unknown-create', scene }, request('host-default', 'image_capable', 'unknown')),
    error => error.code === 'POLICY_REQUIRED',
  );
  const missingPolicy = request('workspace-write', 'image_capable', 'missing');
  delete missingPolicy.policy;
  await assert.rejects(capability.execute('guide', {}, missingPolicy), error => error.code === 'REQUEST_REQUIRED');
});

test('unknown model input is fail-closed for reviewed output while drafts remain available', async t => {
  const { capability, request } = await fixture(t);
  const unknown = request('workspace-write', { status: 'supported', canViewImages: true }, 'unknown-model');
  await capability.execute('scene', { action: 'create', document: 'model-input', txid: 'model-input-create', scene }, unknown);
  const draft = await capability.execute('export', { document: 'model-input', draft: true }, unknown);
  assert.equal(draft.value.status, 'draft');
  await capability.execute('render', { document: 'model-input', scale: 1 }, unknown);
  await assert.rejects(capability.execute('export', { document: 'model-input', draft: false, review: { identity: true, nativeReadable: true, lighting: true, note: 'Unknown image input remains unreviewed.' } }, unknown), error => error.code === 'VISUAL_INPUT_REQUIRED');
});
