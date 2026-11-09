import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { themeHash } from '../src/theme-model.mjs';
import { addTheme, reviseTheme, readTheme, listThemes } from '../src/theme-store.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = 'a'.repeat(64);
const HASH = /^[0-9a-f]{64}$/;

async function workspace(t, label = 'theme-store') {
  await fs.mkdir(path.join(root, '.validation'), { recursive: true });
  const cwd = await fs.mkdtemp(path.join(root, '.validation', label + '-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function spec(overrides = {}) {
  return {
    title: 'Soft Workshop',
    summary: 'Warm ochre masses, plum shadows, low detail density.',
    tags: ['warm', 'workshop'],
    signature: ['edge.crisp'],
    language: { identity: 'Warm handmade props.', form: 'Large masses.' },
    tokens: {
      colors: { ink: { value: '#2c2333' }, shadow: { value: '#755146' }, base: { value: '#bc8758' }, light: { value: '#e7be83' } },
      ramps: { body: { stops: [{ at: 0, color: 'shadow' }, { at: 1, color: 'light' }] } },
      materials: { body: { ramp: 'body' } },
      defaultMaterial: 'body',
      outline: { enabled: true, color: 'ink', width: 1, direction: 'inside' },
      lights: [{ id: 'key', type: 'directional', direction: [0, -1, 0], frame: 'view' }],
      ambient: 0.2,
      exposure: 1,
      camera: { preset: 'top_down', pixelsPerUnit: 2 },
      appearanceShading: 'unlit',
    },
    rules: [
      { id: 'edge.crisp', strength: 'must', statement: 'One-pixel dark contour.', check: { kind: 'outline', enabled: true, width: 1, direction: 'inside', color: 'ink' } },
      { id: 'color.closed', strength: 'must', statement: 'Final opaque pixels use theme colors.', check: { kind: 'palette' } },
      { id: 'form.mass', strength: 'must', statement: 'Keep the main mass complete.' },
    ],
    adaptations: [
      { id: 'small', maxSize: 32, language: { detail: 'Remove secondary detail.' } },
      { id: 'prop', assetClass: 'prop', language: { form: 'Thicker frames.' } },
    ],
    references: [{ id: 'ref.one', path: 'assets/reference.png', sha256: sha, role: 'positive', note: 'Palette only.' }],
    source: { kind: 'hybrid', brief: 'Text plus one reference observation.' },
    ...overrides,
  };
}

async function expectReject(promise, code, label = '') {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, (label ? label + ': ' : '') + 'expected ' + code + ', got ' + error.code + ': ' + error.message);
    return true;
  });
}

test('add, read, revise, replay old revisions and list summaries', async t => {
  const ws = await workspace(t);
  const added = await addTheme(ws, 'soft-workshop', spec(), 'add-1');
  assert.equal(added.replayed, false);
  assert.equal(added.appliedRevision, 0);
  assert.equal(added.theme.revision, 0);
  assert.match(added.hash, HASH);
  assert.ok(Object.isFrozen(added.theme));
  const head0 = await readTheme(ws, 'soft-workshop');
  assert.equal(head0.theme.revision, 0);
  assert.equal(head0.hash, added.hash);
  assert.ok(Object.isFrozen(head0.theme));
  const rev1 = await reviseTheme(ws, 'soft-workshop', 0, spec({ title: 'Soft Workshop 2' }), 'rev-1');
  assert.equal(rev1.replayed, false);
  assert.equal(rev1.appliedRevision, 1);
  assert.notEqual(rev1.hash, added.hash);
  const old = await readTheme(ws, 'soft-workshop', 0);
  assert.equal(old.theme.title, 'Soft Workshop');
  assert.equal(old.hash, added.hash);
  const head1 = await readTheme(ws, 'soft-workshop');
  assert.equal(head1.theme.title, 'Soft Workshop 2');
  assert.equal(head1.hash, rev1.hash);
  const rev2 = await reviseTheme(ws, 'soft-workshop', 1, spec({ title: 'Soft Workshop 3' }), 'rev-2');
  assert.equal(rev2.appliedRevision, 2);
  const rev1Again = await readTheme(ws, 'soft-workshop', 1);
  assert.equal(rev1Again.theme.title, 'Soft Workshop 2');
  assert.equal(rev1Again.hash, rev1.hash);
  const oldAgain = await readTheme(ws, 'soft-workshop', 0);
  assert.equal(oldAgain.hash, added.hash);
  const list = await listThemes(ws);
  assert.equal(list.total, 1);
  assert.equal(list.themes[0].id, 'soft-workshop');
  assert.equal(list.themes[0].revision, 2);
  assert.equal(list.themes[0].hash, rev2.hash);
  assert.equal(list.themes[0].title, 'Soft Workshop 3');
  assert.deepEqual(list.themes[0].tags, ['warm', 'workshop']);
  assert.deepEqual(list.themes[0].assetClasses, ['prop']);
  assert.equal(list.nextOffset, null);
  assert.equal(list.truncated, false);
});

test('revise accepts a complete spec without service-owned envelope fields', async t => {
  const ws = await workspace(t);
  await addTheme(ws, 'full', spec(), 'add-1');
  const old = await readTheme(ws, 'full');
  await expectReject(reviseTheme(ws, 'full', 0, old.theme, 'rev-full'), 'THEME_SPEC', 'full theme envelope');
  const { format, id, revision, ...specOnly } = old.theme;
  const revised = await reviseTheme(ws, 'full', 0, specOnly, 'rev-1');
  assert.equal(revised.theme.revision, 1);
  assert.equal(revised.theme.title, 'Soft Workshop');
  assert.equal(revised.theme.tokens.colors.ink.value, '#2c2333');
  const oldAgain = await readTheme(ws, 'full', 0);
  assert.equal(oldAgain.theme.revision, 0);
});

test('add and revise reject service-owned format/id/revision metadata', async t => {
  const ws = await workspace(t);
  await expectReject(addTheme(ws, 'meta', { ...spec(), format: 'dsh-zpixel-theme/1' }, 'add-format'), 'THEME_SPEC', 'add format');
  await expectReject(addTheme(ws, 'meta', { ...spec(), id: 'meta' }, 'add-id'), 'THEME_SPEC', 'add id');
  await expectReject(addTheme(ws, 'meta', { ...spec(), revision: 0 }, 'add-revision'), 'THEME_SPEC', 'add revision');
  await expectReject(readTheme(ws, 'meta'), 'NOT_FOUND', 'rejected add wrote nothing');
  await addTheme(ws, 'meta', spec(), 'add-valid');
  await expectReject(reviseTheme(ws, 'meta', 0, { ...spec(), format: 'dsh-zpixel-theme/1' }, 'rev-format'), 'THEME_SPEC', 'revise format');
  await expectReject(reviseTheme(ws, 'meta', 0, { ...spec(), id: 'meta' }, 'rev-id'), 'THEME_SPEC', 'revise id');
  await expectReject(reviseTheme(ws, 'meta', 0, { ...spec(), revision: 1 }, 'rev-revision'), 'THEME_SPEC', 'revise revision');
  const head = await readTheme(ws, 'meta');
  assert.equal(head.theme.revision, 0);
  const list = await listThemes(ws);
  assert.equal(list.total, 1);
  assert.equal(list.themes[0].revision, 0);
});

test('txid replay is fixed and changed payload is rejected', async t => {
  const ws = await workspace(t);
  const added = await addTheme(ws, 'soft-workshop', spec(), 'add-1');
  const replayAdd = await addTheme(ws, 'soft-workshop', spec(), 'add-1');
  assert.equal(replayAdd.replayed, true);
  assert.equal(replayAdd.appliedRevision, 0);
  assert.equal(replayAdd.hash, added.hash);
  await expectReject(addTheme(ws, 'soft-workshop', spec({ title: 'Changed' }), 'add-1'), 'TXID_REUSED', 'changed add payload');
  const rev1 = await reviseTheme(ws, 'soft-workshop', 0, spec({ title: 'Soft Workshop 2' }), 'rev-1');
  const replayRev = await reviseTheme(ws, 'soft-workshop', 0, spec({ title: 'Soft Workshop 2' }), 'rev-1');
  assert.equal(replayRev.replayed, true);
  assert.equal(replayRev.appliedRevision, 1);
  assert.equal(replayRev.hash, rev1.hash);
  const rev2 = await reviseTheme(ws, 'soft-workshop', 1, spec({ title: 'Soft Workshop 3' }), 'rev-2');
  const replayOld = await reviseTheme(ws, 'soft-workshop', 0, spec({ title: 'Soft Workshop 2' }), 'rev-1');
  assert.equal(replayOld.replayed, true);
  assert.equal(replayOld.appliedRevision, 1);
  const head = await readTheme(ws, 'soft-workshop');
  assert.equal(head.theme.revision, 2);
  assert.equal(head.theme.title, 'Soft Workshop 3');
  assert.equal(head.hash, rev2.hash);
  await expectReject(reviseTheme(ws, 'soft-workshop', 1, spec({ title: 'Changed' }), 'rev-2'), 'TXID_REUSED', 'changed revise payload');
  await expectReject(reviseTheme(ws, 'soft-workshop', 2, spec({ title: 'Soft Workshop 2' }), 'rev-1'), 'TXID_REUSED', 'changed expected revision');
});

test('revision conflicts, missing revisions, duplicate add and missing theme', async t => {
  const ws = await workspace(t);
  await expectReject(readTheme(ws, 'missing'), 'NOT_FOUND', 'read missing');
  await expectReject(reviseTheme(ws, 'missing', 0, spec(), 'rev-missing'), 'NOT_FOUND', 'revise missing');
  const empty = await listThemes(ws);
  assert.deepEqual(empty, { themes: [], total: 0, offset: 0, limit: 50, nextOffset: null, truncated: false });
  await addTheme(ws, 'soft-workshop', spec(), 'add-1');
  await expectReject(addTheme(ws, 'soft-workshop', spec(), 'add-2'), 'ALREADY_EXISTS', 'duplicate add');
  await reviseTheme(ws, 'soft-workshop', 0, spec({ title: 'Soft Workshop 2' }), 'rev-1');
  await expectReject(reviseTheme(ws, 'soft-workshop', 0, spec({ title: 'Stale' }), 'rev-stale'), 'REVISION_CONFLICT', 'stale revision');
  await expectReject(readTheme(ws, 'soft-workshop', 5), 'REVISION_NOT_FOUND', 'missing revision');
  await expectReject(readTheme(ws, 'soft-workshop', -1), 'REVISION_REQUIRED', 'negative revision');
  await expectReject(readTheme(ws, 'soft-workshop', 1.5), 'REVISION_REQUIRED', 'fractional revision');
  await expectReject(reviseTheme(ws, 'soft-workshop', -1, spec(), 'rev-negative'), 'REVISION_REQUIRED', 'negative expected');
  await expectReject(reviseTheme(ws, 'soft-workshop', 1.5, spec(), 'rev-fractional'), 'REVISION_REQUIRED', 'fractional expected');
  await expectReject(reviseTheme(ws, 'soft-workshop', Number.MAX_SAFE_INTEGER, spec(), 'rev-max'), 'REVISION_REQUIRED', 'max expected');
});

test('case-insensitive identity is reserved while the exact id is preserved', async t => {
  const ws = await workspace(t);
  const added = await addTheme(ws, 'Soft-Workshop', spec(), 'add-1');
  assert.equal(added.theme.id, 'Soft-Workshop');
  await expectReject(addTheme(ws, 'soft-workshop', spec(), 'add-2'), 'THEME_ID_COLLISION', 'case add');
  await expectReject(readTheme(ws, 'SOFT-WORKSHOP'), 'THEME_ID_COLLISION', 'case read');
  await expectReject(reviseTheme(ws, 'soft-workshop', 0, spec({ title: 'X' }), 'rev-case'), 'THEME_ID_COLLISION', 'case revise');
  const list = await listThemes(ws);
  assert.equal(list.total, 1);
  assert.equal(list.themes[0].id, 'Soft-Workshop');
  const files = await fs.readdir(path.join(ws, '.zpixel', 'themes'));
  assert.deepEqual(files.filter(name => name.endsWith('.json')), ['Soft-Workshop.json']);
  await addTheme(ws, 'soft-workshop-2', spec(), 'add-3');
  const list2 = await listThemes(ws);
  assert.equal(list2.total, 2);
  assert.deepEqual(list2.themes.map(theme => theme.id), ['Soft-Workshop', 'soft-workshop-2']);
});

test('pagination and query return every matching theme without silent drops', async t => {
  const ws = await workspace(t);
  await addTheme(ws, 'alpha', spec({ title: 'Alpha', summary: 'Alpha warm body.', tags: ['warm'], adaptations: [{ id: 'prop', assetClass: 'prop', language: { form: 'F' } }] }), 'add-a');
  await addTheme(ws, 'beta', spec({ title: 'Beta', summary: 'Beta cool body.', tags: ['cool'], adaptations: [] }), 'add-b');
  await addTheme(ws, 'gamma', spec({ title: 'Gamma', summary: 'Gamma warm accent.', tags: ['warm'], adaptations: [] }), 'add-c');
  const page1 = await listThemes(ws, { limit: 2 });
  assert.equal(page1.total, 3);
  assert.deepEqual(page1.themes.map(theme => theme.id), ['alpha', 'beta']);
  assert.equal(page1.nextOffset, 2);
  assert.equal(page1.truncated, true);
  assert.match(page1.note, /catalog page/);
  const page2 = await listThemes(ws, { offset: 2, limit: 2 });
  assert.deepEqual(page2.themes.map(theme => theme.id), ['gamma']);
  assert.equal(page2.nextOffset, null);
  assert.equal(page2.truncated, false);
  const warm = await listThemes(ws, { query: 'WARM' });
  assert.deepEqual(warm.themes.map(theme => theme.id), ['alpha', 'gamma']);
  const prop = await listThemes(ws, { query: 'prop' });
  assert.deepEqual(prop.themes.map(theme => theme.id), ['alpha']);
  const beta = await listThemes(ws, { query: 'beta' });
  assert.deepEqual(beta.themes.map(theme => theme.id), ['beta']);
  const beyond = await listThemes(ws, { offset: 10 });
  assert.deepEqual(beyond.themes, []);
  assert.equal(beyond.nextOffset, null);
  assert.equal(beyond.truncated, false);
  await expectReject(listThemes(ws, { limit: 0 }), 'RANGE', 'limit 0');
  await expectReject(listThemes(ws, { limit: 51 }), 'RANGE', 'limit 51');
  await expectReject(listThemes(ws, { offset: -1 }), 'RANGE', 'offset -1');
  await expectReject(listThemes(ws, { extra: true }), 'INVALID_FIELD', 'unknown option');
  await expectReject(listThemes(ws, { query: 'x'.repeat(201) }), 'RANGE', 'long query');
});

test('references stay metadata and no image is copied', async t => {
  const ws = await workspace(t);
  await fs.mkdir(path.join(ws, 'assets'), { recursive: true });
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
  const image = path.join(ws, 'assets', 'reference.png');
  await fs.writeFile(image, bytes);
  const themeSpec = spec({ references: [{ id: 'ref.one', path: 'assets/reference.png', sha256: sha, role: 'positive', note: 'Palette only.', crop: [0, 0, 8, 8], observations: ['Observed.'], inferences: ['Inferred.'] }] });
  await addTheme(ws, 'soft-workshop', themeSpec, 'add-1');
  const read = await readTheme(ws, 'soft-workshop');
  assert.equal(read.theme.references[0].path, 'assets/reference.png');
  assert.equal(read.theme.references[0].sha256, sha);
  assert.deepEqual(await fs.readFile(image), bytes);
  const themesDir = path.join(ws, '.zpixel', 'themes');
  const files = await fs.readdir(themesDir);
  assert.deepEqual(files, ['soft-workshop.json']);
  const stored = await fs.readFile(path.join(themesDir, 'soft-workshop.json'), 'utf8');
  assert.ok(stored.includes('assets/reference.png'));
  const stat = await fs.stat(image);
  assert.equal(stat.size, bytes.length);
});

test('malformed or tampered store data is rejected honestly', async t => {
  const ws = await workspace(t);
  await addTheme(ws, 'soft-workshop', spec(), 'add-1');
  const file = path.join(ws, '.zpixel', 'themes', 'soft-workshop.json');
  const original = await fs.readFile(file, 'utf8');
  const restore = async () => { await fs.writeFile(file, original); };
  const write = async value => { await fs.writeFile(file, JSON.stringify(value)); };
  await fs.writeFile(file, '{not json');
  await expectReject(readTheme(ws, 'soft-workshop'), 'STORE_FORMAT', 'invalid json read');
  await expectReject(listThemes(ws), 'STORE_FORMAT', 'invalid json list');
  await restore();
  const badHash = JSON.parse(original); badHash.revisions[0].hash = 'b'.repeat(64); await write(badHash);
  await expectReject(readTheme(ws, 'soft-workshop'), 'STORE_FORMAT', 'hash mismatch');
  await restore();
  const changed = JSON.parse(original); changed.revisions[0].theme.title = 'Tampered'; await write(changed);
  await expectReject(readTheme(ws, 'soft-workshop'), 'STORE_FORMAT', 'theme hash mismatch');
  await restore();
  const badRevision = JSON.parse(original); badRevision.revisions[0].theme.revision = 1; await write(badRevision);
  await expectReject(readTheme(ws, 'soft-workshop'), 'STORE_FORMAT', 'revision mismatch');
  await restore();
  const extra = JSON.parse(original); extra.extra = true; await write(extra);
  await expectReject(readTheme(ws, 'soft-workshop'), 'STORE_FORMAT', 'envelope extra');
  await restore();
  const badReceipt = JSON.parse(original); badReceipt.receipts[0].revision = 5; await write(badReceipt);
  await expectReject(readTheme(ws, 'soft-workshop'), 'STORE_FORMAT', 'receipt revision');
  await restore();
  const duplicate = JSON.parse(original); duplicate.receipts.push({ ...duplicate.receipts[0] }); await write(duplicate);
  await expectReject(readTheme(ws, 'soft-workshop'), 'STORE_FORMAT', 'duplicate receipt');
  await restore();
  const other = path.join(ws, '.zpixel', 'themes', 'other.json');
  await fs.writeFile(other, JSON.stringify({ ...JSON.parse(original), id: 'other' }));
  await expectReject(readTheme(ws, 'other'), 'STORE_FORMAT', 'envelope revision id mismatch');
  await fs.rm(other);
  await reviseTheme(ws, 'soft-workshop', 0, spec({ title: 'Soft Workshop 2' }), 'rev-1');
  const twoOriginal = await fs.readFile(file, 'utf8');
  const two = JSON.parse(twoOriginal);
  two.revisions[0].hash = 'c'.repeat(64);
  await write(two);
  await expectReject(readTheme(ws, 'soft-workshop'), 'STORE_FORMAT', 'old revision tamper');
  await fs.writeFile(file, twoOriginal);
  const before = await fs.readFile(file);
  await expectReject(reviseTheme(ws, 'soft-workshop', 1, { title: 'T' }, 'rev-bad'), 'INVALID_FIELD', 'invalid spec');
  assert.deepEqual(await fs.readFile(file), before);
});

test('locks are honored, cleaned and serialize concurrent revisions', async t => {
  const ws = await workspace(t);
  await addTheme(ws, 'soft-workshop', spec(), 'add-1');
  const themesDir = path.join(ws, '.zpixel', 'themes');
  const lock = path.join(themesDir, '.theme-soft-workshop.lock');
  await fs.writeFile(lock, JSON.stringify({ pid: 1 }));
  await expectReject(reviseTheme(ws, 'soft-workshop', 0, spec({ title: 'Locked' }), 'rev-lock'), 'BUSY', 'manual lock');
  await fs.rm(lock);
  const firstPromise = reviseTheme(ws, 'soft-workshop', 0, spec({ title: 'First' }), 'rev-first');
  await new Promise(resolve => setTimeout(resolve, 10));
  const secondPromise = reviseTheme(ws, 'soft-workshop', 0, spec({ title: 'Second' }), 'rev-second');
  const [first, second] = await Promise.allSettled([firstPromise, secondPromise]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason.code, 'REVISION_CONFLICT');
  const head = await readTheme(ws, 'soft-workshop');
  assert.equal(head.theme.revision, 1);
  assert.equal(head.theme.title, 'First');
  const files = await fs.readdir(themesDir);
  assert.deepEqual(files.filter(name => name.endsWith('.lock') || name.endsWith('.tmp')), []);
});

test('workspace scoping and path safety', async t => {
  const ws1 = await workspace(t, 'theme-store-a');
  const ws2 = await workspace(t, 'theme-store-b');
  await addTheme(ws1, 'shared', spec({ title: 'A' }), 'add-a');
  await addTheme(ws2, 'shared', spec({ title: 'B' }), 'add-b');
  assert.equal((await readTheme(ws1, 'shared')).theme.title, 'A');
  assert.equal((await readTheme(ws2, 'shared')).theme.title, 'B');
  for (const id of ['a/b', '../x', 'a.json', '', '1abc', 'a b', 'constructor', 'prototype', '__proto__']) {
    await expectReject(addTheme(ws1, id, spec(), 'add-bad-' + id.length), 'THEME_ID', 'bad id ' + id);
  }
  await expectReject(addTheme(path.join(ws1, 'missing'), 'x', spec(), 'add-missing'), 'WORKSPACE', 'missing workspace');
  const file = path.join(ws1, 'not-a-directory');
  await fs.writeFile(file, 'x');
  await expectReject(addTheme(file, 'x', spec(), 'add-file'), 'WORKSPACE', 'file workspace');
  const blocked = await workspace(t, 'theme-store-blocked');
  await fs.writeFile(path.join(blocked, '.zpixel'), 'x');
  await expectReject(addTheme(blocked, 'x', spec(), 'add-blocked'), 'UNSAFE_PATH', 'zpixel file');
  const blocked2 = await workspace(t, 'theme-store-blocked2');
  await fs.mkdir(path.join(blocked2, '.zpixel'));
  await fs.writeFile(path.join(blocked2, '.zpixel', 'themes'), 'x');
  await expectReject(addTheme(blocked2, 'x', spec(), 'add-blocked2'), 'UNSAFE_PATH', 'themes file');
  const linkWs = await workspace(t, 'theme-store-link');
  const outside = await workspace(t, 'theme-store-outside');
  try {
    await fs.symlink(outside, path.join(linkWs, '.zpixel'));
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'EEXIST'].includes(error.code)) throw error;
    return;
  }
  await expectReject(addTheme(linkWs, 'x', spec(), 'add-link'), 'UNSAFE_PATH', 'zpixel symlink');
});

test('theme file symlinks are rejected when the platform allows creating them', async t => {
  const ws = await workspace(t, 'theme-store-filelink');
  await addTheme(ws, 'real', spec(), 'add-real');
  const themesDir = path.join(ws, '.zpixel', 'themes');
  try {
    await fs.symlink(path.join(themesDir, 'real.json'), path.join(themesDir, 'link.json'));
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'EEXIST'].includes(error.code)) throw error;
    return;
  }
  await expectReject(readTheme(ws, 'link'), 'UNSAFE_PATH', 'theme symlink');
});

test('receipt ledger is bounded explicitly and never silently evicted', async t => {
  const ws = await workspace(t);
  await addTheme(ws, 'soft-workshop', spec(), 'add-1');
  const file = path.join(ws, '.zpixel', 'themes', 'soft-workshop.json');
  const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
  for (let index = 1; index < 512; index++) {
    envelope.receipts.push({ txid: 'filler-' + index, fingerprint: 'a'.repeat(64), revision: 0 });
  }
  assert.equal(envelope.receipts.length, 512);
  await fs.writeFile(file, JSON.stringify(envelope));
  const before = await fs.readFile(file);
  await expectReject(reviseTheme(ws, 'soft-workshop', 0, spec({ title: 'Blocked' }), 'rev-blocked'), 'RECEIPT_LIMIT', 'receipt limit');
  assert.deepEqual(await fs.readFile(file), before);
  const replay = await addTheme(ws, 'soft-workshop', spec(), 'add-1');
  assert.equal(replay.replayed, true);
  assert.equal(replay.appliedRevision, 0);
  const read = await readTheme(ws, 'soft-workshop');
  assert.equal(read.theme.revision, 0);
});

test('unsupported desired features roundtrip through immutable revisions', async t => {
  const ws = await workspace(t);
  const desired = spec();
  desired.tokens.outline = { enabled: true, color: 'ink', width: 2, direction: 'inside' };
  desired.tokens.materials.body = { ramp: 'body', diffuse: 1, emission: 0, specular: 0.8, roughness: 0.5 };
  desired.tokens.lights = [
    { id: 'key', type: 'directional', direction: [0, -1, 0], frame: 'view', color: '#ff0000' },
    { id: 'fill', type: 'point', position: [10, 20, 30], frame: 'view' },
  ];
  desired.rules.push({ id: 'future.soft', strength: 'must', statement: 'Soft shadows are not implemented.', check: { kind: 'unsupported', feature: 'soft shadow' } });
  await addTheme(ws, 'desired', desired, 'add-1');
  const old = await readTheme(ws, 'desired');
  assert.equal(old.theme.tokens.outline.width, 2);
  assert.equal(old.theme.tokens.materials.body.specular, 0.8);
  assert.equal(old.theme.tokens.lights[0].color, '#ff0000');
  assert.equal(old.theme.tokens.lights[1].frame, 'view');
  assert.equal(old.theme.rules.find(rule => rule.id === 'future.soft').check.feature, 'soft shadow');
  const revised = spec({ title: 'Desired Revised' });
  revised.tokens.outline = { enabled: true, color: 'ink', width: 2, direction: 'inside' };
  revised.tokens.materials.body = { ramp: 'body', diffuse: 1, emission: 0, specular: 0.8, roughness: 0.5 };
  revised.tokens.lights = desired.tokens.lights;
  revised.rules.push({ id: 'future.soft', strength: 'must', statement: 'Soft shadows are not implemented.', check: { kind: 'unsupported', feature: 'soft shadow' } });
  await reviseTheme(ws, 'desired', 0, revised, 'rev-1');
  const oldAgain = await readTheme(ws, 'desired', 0);
  assert.equal(oldAgain.theme.tokens.outline.width, 2);
  assert.equal(oldAgain.theme.tokens.materials.body.specular, 0.8);
  const head = await readTheme(ws, 'desired');
  assert.equal(head.theme.title, 'Desired Revised');
  assert.equal(head.theme.tokens.outline.width, 2);
  assert.equal(head.theme.tokens.materials.body.specular, 0.8);
  assert.equal(head.theme.tokens.lights[0].color, '#ff0000');
});

test('safe token keys survive a store roundtrip', async t => {
  const ws = await workspace(t);
  const themeSpec = spec({ tokens: { colors: { ink: { value: '#2c2333' }, toString: { value: '#112233' } } }, rules: [], signature: [] });
  await addTheme(ws, 'safe', themeSpec, 'add-1');
  const read = await readTheme(ws, 'safe');
  assert.equal(read.theme.tokens.colors.toString.value, '#112233');
  assert.ok(Object.prototype.hasOwnProperty.call(read.theme.tokens.colors, 'toString'));
  assert.equal(Object.prototype.toString.call({}), '[object Object]');
});

test('list surfaces malformed theme filenames instead of skipping them', async t => {
  const ws = await workspace(t);
  await addTheme(ws, 'valid', spec(), 'add-1');
  const dir = path.join(ws, '.zpixel', 'themes');
  await fs.writeFile(path.join(dir, 'bad name.json'), JSON.stringify({ format: 'dsh-zpixel-themes/1', id: 'bad name', revisions: [], receipts: [] }));
  await expectReject(listThemes(ws), 'STORE_FORMAT', 'malformed filename');
});

test('revise replaces the complete spec instead of merging fields', async t => {
  const ws = await workspace(t);
  await addTheme(ws, 'replace', spec(), 'add-1');
  const revised = await reviseTheme(ws, 'replace', 0, { title: 'Replacement', summary: 'Only these fields.' }, 'rev-1');
  assert.deepEqual(revised.theme.tags, []);
  assert.deepEqual(revised.theme.language, {});
  assert.deepEqual(revised.theme.tokens, { colors: {}, ramps: {}, materials: {} });
  assert.deepEqual(revised.theme.rules, []);
  assert.deepEqual(revised.theme.adaptations, []);
  assert.deepEqual(revised.theme.references, []);
  assert.deepEqual(revised.theme.source, { kind: 'concept' });
  const old = await readTheme(ws, 'replace', 0);
  assert.deepEqual(old.theme.tags, ['warm', 'workshop']);
  assert.equal(themeHash(old.theme), old.hash);
});

test('reader rejects an oversized receipt ledger and lists uppercase JSON extensions',async t=>{
  const ws=await workspace(t,'theme-store-bounds');
  await addTheme(ws,'CaseTheme',spec(),'bounded-add');
  const file=path.join(ws,'.zpixel','themes','CaseTheme.json');
  const bytes=await fs.readFile(file,'utf8'),envelope=JSON.parse(bytes);
  envelope.receipts=Array.from({length:513},(_,i)=>({txid:'fill-'+i,fingerprint:sha,revision:0}));
  await fs.writeFile(file,JSON.stringify(envelope));
  await expectReject(readTheme(ws,'CaseTheme'),'STORE_FORMAT');
  await fs.writeFile(file,bytes);
  const temp=path.join(ws,'.zpixel','themes','CaseTheme.case-change');
  await fs.rename(file,temp);await fs.rename(temp,path.join(ws,'.zpixel','themes','CaseTheme.JSON'));
  assert.equal((await listThemes(ws)).themes[0].id,'CaseTheme');
});

