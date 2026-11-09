/**
 * Workspace-scoped immutable theme revisions for ZPixel 0.4.0.
 *
 * Storage is one JSON envelope per theme under .zpixel/themes/<exact-id>.json:
 *   {format:'dsh-zpixel-themes/1', id, revisions:[{theme,hash}], receipts:[...]}
 *
 * Revisions are append-only and never pruned. Receipts are bounded by
 * MAX_RECEIPTS and the writer refuses a new mutation with RECEIPT_LIMIT rather
 * than silently evicting an old receipt (an evicted receipt would make an old
 * txid retry look like a new edit). The envelope size limit is a second bound.
 *
 * Identity is reserved case-insensitively on every platform while the exact
 * id spelling is preserved. No reference image is read or copied: references
 * stay metadata in the theme JSON.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeTheme, validateTheme, themeHash, stableJSON, deepFreeze, assertThemeId, ThemeError } from './theme-model.mjs';

const FORMAT = 'dsh-zpixel-themes/1';
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_RECEIPTS = 512;
const TXID = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;
const HASH = /^[0-9a-f]{64}$/;
const queues = new Map();

const fail = (code, message, details = {}) => { throw new ThemeError(code, message, details); };
const sameIdIgnoringCase = (left, right) => typeof left === 'string' && typeof right === 'string' &&
  left.length === right.length && left.toLowerCase() === right.toLowerCase();
const fingerprintOf = value => createHash('sha256').update(stableJSON(value)).digest('hex');

function checkTx(txid) {
  if (typeof txid !== 'string' || !TXID.test(txid)) {
    fail('TXID', 'Provide a unique txid starting with a letter (at most 96 characters). Reuse it only for an identical retry.', { txid });
  }
}

async function regular(target, directory = false) {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
      fail('UNSAFE_PATH', 'Expected a regular ' + (directory ? 'directory' : 'file') + ': ' + target, { path: target });
    }
    return stat;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function folder(parent, name, create) {
  const target = path.join(parent, name);
  if (!await regular(target, true)) {
    if (!create) return target;
    await fs.mkdir(target).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await regular(target, true);
  }
  return target;
}

async function storageRoot(workspace, create = false) {
  if (typeof workspace !== 'string' || !workspace) fail('WORKSPACE', 'workspace must be a directory path.', { workspace });
  let canonical;
  try { canonical = await fs.realpath(workspace); }
  catch (error) {
    if (error.code === 'ENOENT') fail('WORKSPACE', 'Workspace does not exist: ' + workspace, { workspace });
    throw error;
  }
  const stat = await fs.lstat(canonical);
  if (!stat.isDirectory()) fail('WORKSPACE', 'Workspace is not a directory: ' + workspace, { workspace });
  const root = await folder(canonical, '.zpixel', create);
  const themes = await folder(root, 'themes', create);
  return { workspace: canonical, root, themes };
}

const lockPath = (directory, id) => path.join(directory, '.theme-' + id.toLowerCase() + '.lock');

async function serialized(key, operation) {
  const previous = queues.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  queues.set(key, tail);
  await previous.catch(() => {});
  try { return await operation(); }
  finally { release(); if (queues.get(key) === tail) queues.delete(key); }
}

async function locked(lock, operation) {
  let handle;
  try { handle = await fs.open(lock, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') fail('BUSY', 'Another process owns this theme lock. Retry after that operation finishes.', { lock });
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(lock).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function atomicJSON(file, value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_BYTES) {
    fail('STORE_LIMIT', 'Theme store exceeds the ' + MAX_BYTES + ' byte limit. Existing revisions were preserved.', { path: file, limit: MAX_BYTES });
  }
  await regular(file);
  const temp = file + '.' + randomUUID() + '.tmp';
  let handle = null;
  let created = false;
  try {
    handle = await fs.open(temp, 'wx');
    created = true;
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, file);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (created) await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function findThemeFile(directory, id) {
  let names;
  try { names = await fs.readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const exactName = id + '.json';
  const wanted = exactName.toLowerCase();
  const matches = names.filter(name => name.toLowerCase() === wanted);
  if (!matches.length) return null;
  if (matches.length > 1) {
    fail('THEME_ID_COLLISION', 'Multiple theme files differ only by letter case for ID "' + id + '". Resolve the duplicate files before continuing.', { theme: id, names: matches.sort() });
  }
  const name = matches[0];
  return { name, file: path.join(directory, name), exact: name === exactName };
}

async function collisionForVariant(found, requestedId) {
  const stem = found.name.slice(0, -5);
  const envelope = await readEnvelope(found.file, stem, { allowDifferentId: true });
  if (envelope.id !== stem) {
    fail('STORE_FORMAT', 'Theme file ' + found.name + ' stores id "' + envelope.id + '"; the filename and stored id must match exactly.', { theme: stem, storedId: envelope.id, path: found.file });
  }
  fail('THEME_ID_COLLISION', 'Theme ID "' + requestedId + '" differs only by letter case from existing theme "' + envelope.id + '". Use the stored ID "' + envelope.id + '" or choose a different theme ID.', { theme: requestedId, storedId: envelope.id, path: found.file });
}

function validateEnvelope(envelope, expectedId, { allowDifferentId = false, path: file } = {}) {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    fail('STORE_FORMAT', 'Unrecognized or damaged theme store file.', { theme: expectedId, path: file });
  }
  for (const key of Object.keys(envelope)) {
    if (!['format', 'id', 'revisions', 'receipts'].includes(key)) {
      fail('STORE_FORMAT', 'Unknown theme store field "' + key + '".', { theme: expectedId, path: file, field: key });
    }
  }
  if (envelope.format !== FORMAT) {
    fail('STORE_FORMAT', 'Expected theme store format ' + FORMAT + '.', { theme: expectedId, path: file, format: envelope.format });
  }
  if (typeof envelope.id !== 'string') fail('STORE_FORMAT', 'Theme store id must be a string.', { theme: expectedId, path: file });
  try { assertThemeId(envelope.id, 'envelope.id'); }
  catch (error) { fail('STORE_FORMAT', 'Theme store id is invalid: ' + error.message, { theme: expectedId, path: file }); }
  if (envelope.id !== expectedId && !allowDifferentId) {
    if (sameIdIgnoringCase(envelope.id, expectedId)) {
      fail('THEME_ID_COLLISION', 'Theme ID "' + expectedId + '" differs only by letter case from existing theme "' + envelope.id + '". Use the stored ID "' + envelope.id + '" or choose a different theme ID.', { theme: expectedId, storedId: envelope.id, path: file });
    }
    fail('STORE_FORMAT', 'Theme store id "' + envelope.id + '" does not match expected id "' + expectedId + '".', { theme: expectedId, storedId: envelope.id, path: file });
  }
  if (!Array.isArray(envelope.revisions) || envelope.revisions.length < 1) {
    fail('STORE_FORMAT', 'Theme store must contain at least one revision.', { theme: envelope.id, path: file });
  }
  if (!Array.isArray(envelope.receipts)) fail('STORE_FORMAT', 'Theme store receipts must be an array.', { theme: envelope.id, path: file });
  if(envelope.receipts.length>MAX_RECEIPTS||envelope.revisions.length>MAX_RECEIPTS+1)fail('STORE_FORMAT','Theme store exceeds the bounded revision or receipt ledger.',{theme:envelope.id,path:file,limit:MAX_RECEIPTS});
  for (let index = 0; index < envelope.revisions.length; index++) {
    const entry = envelope.revisions[index];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('STORE_FORMAT', 'Theme store revision ' + index + ' must be an object.', { theme: envelope.id, revision: index, path: file });
    }
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes('theme') || !keys.includes('hash')) {
      fail('STORE_FORMAT', 'Theme store revision ' + index + ' must contain exactly theme and hash.', { theme: envelope.id, revision: index, path: file });
    }
    if (typeof entry.hash !== 'string' || !HASH.test(entry.hash)) {
      fail('STORE_FORMAT', 'Theme store revision ' + index + ' hash must be lowercase SHA-256 hex.', { theme: envelope.id, revision: index, path: file });
    }
    let theme;
    try { theme = validateTheme(entry.theme); }
    catch (error) {
      fail('STORE_FORMAT', 'Theme store revision ' + index + ' is not a valid canonical theme: ' + error.message, { theme: envelope.id, revision: index, path: file, cause: error.code });
    }
    if (theme.id !== envelope.id) {
      fail('STORE_FORMAT', 'Theme store revision ' + index + ' id does not match the envelope id.', { theme: envelope.id, revision: index, path: file });
    }
    if (theme.revision !== index) {
      fail('STORE_FORMAT', 'Theme store revision ' + index + ' must carry revision ' + index + '.', { theme: envelope.id, revision: index, path: file });
    }
    let actual;
    try { actual = themeHash(theme); }
    catch (error) {
      fail('STORE_FORMAT', 'Theme store revision ' + index + ' cannot be hashed: ' + error.message, { theme: envelope.id, revision: index, path: file, cause: error.code });
    }
    if (actual !== entry.hash) {
      fail('STORE_FORMAT', 'Theme store revision ' + index + ' hash does not match its canonical theme.', { theme: envelope.id, revision: index, path: file });
    }
  }
  const txids = new Set();
  for (let index = 0; index < envelope.receipts.length; index++) {
    const item = envelope.receipts[index];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      fail('STORE_FORMAT', 'Theme store receipt ' + index + ' must be an object.', { theme: envelope.id, receipt: index, path: file });
    }
    const keys = Object.keys(item);
    if (keys.length !== 3 || !keys.includes('txid') || !keys.includes('fingerprint') || !keys.includes('revision')) {
      fail('STORE_FORMAT', 'Theme store receipt ' + index + ' must contain exactly txid, fingerprint and revision.', { theme: envelope.id, receipt: index, path: file });
    }
    if (typeof item.txid !== 'string' || !TXID.test(item.txid)) {
      fail('STORE_FORMAT', 'Theme store receipt ' + index + ' txid is invalid.', { theme: envelope.id, receipt: index, path: file });
    }
    if (txids.has(item.txid)) {
      fail('STORE_FORMAT', 'Theme store receipt ' + index + ' repeats txid "' + item.txid + '".', { theme: envelope.id, receipt: index, path: file });
    }
    txids.add(item.txid);
    if (typeof item.fingerprint !== 'string' || !HASH.test(item.fingerprint)) {
      fail('STORE_FORMAT', 'Theme store receipt ' + index + ' fingerprint must be lowercase SHA-256 hex.', { theme: envelope.id, receipt: index, path: file });
    }
    if (!Number.isSafeInteger(item.revision) || item.revision < 0 || item.revision >= envelope.revisions.length) {
      fail('STORE_FORMAT', 'Theme store receipt ' + index + ' points to a missing revision.', { theme: envelope.id, receipt: index, path: file });
    }
  }
  return envelope;
}

async function readEnvelope(file, expectedId, { allowDifferentId = false } = {}) {
  const stat = await regular(file);
  if (!stat) fail('NOT_FOUND', 'Theme ' + expectedId + ' does not exist.', { theme: expectedId });
  if (stat.size > MAX_BYTES) fail('STORE_LIMIT', 'Theme store exceeds the ' + MAX_BYTES + ' byte limit.', { path: file, limit: MAX_BYTES });
  const text = await fs.readFile(file, 'utf8');
  let envelope;
  try { envelope = JSON.parse(text); }
  catch { fail('STORE_FORMAT', 'Unrecognized or damaged theme store file.', { theme: expectedId, path: file }); }
  validateEnvelope(envelope, expectedId, { allowDifferentId, path: file });
  return envelope;
}

function receipt(envelope, txid, fingerprint) {
  const found = envelope.receipts.find(item => item.txid === txid);
  if (!found) return null;
  if (found.fingerprint !== fingerprint) {
    fail('TXID_REUSED', 'This txid belongs to a different request. Use a new txid for a new edit.', { txid });
  }
  const entry = envelope.revisions[found.revision];
  if (!entry) fail('STORE_FORMAT', 'Theme store receipt points to a missing revision.', { txid, revision: found.revision });
  return { theme: deepFreeze(entry.theme), hash: entry.hash, replayed: true, appliedRevision: found.revision };
}

function remember(envelope, txid, fingerprint, revision) {
  envelope.receipts.push({ txid, fingerprint, revision });
}

function assetClassesOf(theme) {
  const classes = new Set();
  for (const rule of theme.rules) for (const assetClass of rule.scope?.assetClasses ?? []) classes.add(assetClass);
  for (const adaptation of theme.adaptations) if (adaptation.assetClass) classes.add(adaptation.assetClass);
  return [...classes].sort();
}

function matchesQuery(summary, needle) {
  const values = [summary.id, summary.title, summary.summary, ...summary.tags, ...(summary.assetClasses ?? [])];
  return values.some(value => value.toLowerCase().includes(needle));
}

/** Add revision 0 for a new theme id. Same txid + same payload replays it. */
export async function addTheme(workspace, id, spec, txid) {
  checkTx(txid);
  const theme = normalizeTheme(spec, { id, revision: 0 });
  const hash = themeHash(theme);
  const fingerprint = fingerprintOf({ action: 'add', id, theme });
  const { themes: directory } = await storageRoot(workspace, true);
  const lock = lockPath(directory, id);
  return serialized(lock, () => locked(lock, async () => {
    const found = await findThemeFile(directory, id);
    if (found) {
      if (!found.exact) await collisionForVariant(found, id);
      const envelope = await readEnvelope(found.file, id);
      const replay = receipt(envelope, txid, fingerprint);
      if (replay) return replay;
      fail('ALREADY_EXISTS', 'This theme exists. Read it or revise it; add never overwrites it.', {
        theme: id, revision: envelope.revisions[envelope.revisions.length - 1].theme.revision,
      });
    }
    const envelope = { format: FORMAT, id, revisions: [{ theme, hash }], receipts: [] };
    remember(envelope, txid, fingerprint, 0);
    await atomicJSON(path.join(directory, id + '.json'), envelope);
    return { theme, hash, replayed: false, appliedRevision: 0 };
  }));
}

/** Append a complete-spec replacement revision. Old revisions stay immutable. */
export async function reviseTheme(workspace, id, expectedRevision, spec, txid) {
  checkTx(txid);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision === Number.MAX_SAFE_INTEGER) {
    fail('REVISION_REQUIRED', 'expectedRevision must be a nonnegative safe integer returned by readTheme or the last revise.', { expectedRevision });
  }
  const theme = normalizeTheme(spec, { id, revision: expectedRevision + 1 });
  const hash = themeHash(theme);
  const fingerprint = fingerprintOf({ action: 'revise', id, expectedRevision, theme });
  const { themes: directory } = await storageRoot(workspace, false);
  if (!await regular(directory, true)) fail('NOT_FOUND', 'Theme ' + id + ' does not exist.', { theme: id });
  const lock = lockPath(directory, id);
  return serialized(lock, () => locked(lock, async () => {
    const found = await findThemeFile(directory, id);
    if (!found) fail('NOT_FOUND', 'Theme ' + id + ' does not exist.', { theme: id });
    if (!found.exact) await collisionForVariant(found, id);
    const envelope = await readEnvelope(found.file, id);
    const replay = receipt(envelope, txid, fingerprint);
    if (replay) return replay;
    const head = envelope.revisions[envelope.revisions.length - 1].theme.revision;
    if (head !== expectedRevision) {
      fail('REVISION_CONFLICT', 'Theme changed. Read its current revision before revising.', { expected: expectedRevision, actual: head });
    }
    if (envelope.receipts.length >= MAX_RECEIPTS) {
      fail('RECEIPT_LIMIT', 'This theme store has reached its ' + MAX_RECEIPTS + '-receipt transaction ledger. Existing revisions are preserved; no receipt was evicted.', { theme: id, limit: MAX_RECEIPTS });
    }
    envelope.revisions.push({ theme, hash });
    remember(envelope, txid, fingerprint, theme.revision);
    await atomicJSON(found.file, envelope);
    return { theme, hash, replayed: false, appliedRevision: theme.revision };
  }));
}

/** Read one immutable revision; omitted revision means the current head. */
export async function readTheme(workspace, id, revision) {
  assertThemeId(id);
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) {
    fail('REVISION_REQUIRED', 'revision must be a nonnegative safe integer when supplied.', { revision });
  }
  const { themes: directory } = await storageRoot(workspace, false);
  const found = await findThemeFile(directory, id);
  if (!found) fail('NOT_FOUND', 'Theme ' + id + ' does not exist.', { theme: id });
  if (!found.exact) await collisionForVariant(found, id);
  const envelope = await readEnvelope(found.file, id);
  const index = revision === undefined ? envelope.revisions.length - 1 : revision;
  const entry = envelope.revisions[index];
  if (!entry) {
    fail('REVISION_NOT_FOUND', 'Theme ' + id + ' has no revision ' + revision + '.', { theme: id, revision, head: envelope.revisions.length - 1 });
  }
  return { theme: deepFreeze(entry.theme), hash: entry.hash };
}

/** Paginated summaries; query matches id, title, summary, tags and asset classes. */
export async function listThemes(workspace, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('RANGE', 'options must be an object.', {});
  }
  for (const key of Object.keys(options)) {
    if (!['offset', 'limit', 'query'].includes(key)) fail('INVALID_FIELD', 'Unknown listThemes option "' + key + '".', { field: key });
  }
  const offset = options.offset === undefined ? 0 : options.offset;
  const limit = options.limit === undefined ? 50 : options.limit;
  if (!Number.isSafeInteger(offset) || offset < 0) fail('RANGE', 'offset must be a nonnegative safe integer.', { field: 'offset' });
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail('RANGE', 'limit must be a safe integer from 1 to 50.', { field: 'limit' });
  let needle = null;
  if (options.query !== undefined) {
    if (typeof options.query !== 'string' || options.query.length > 200) {
      fail('RANGE', 'query must be a string of at most 200 characters.', { field: 'query' });
    }
    const trimmed = options.query.trim().toLowerCase();
    if (trimmed) needle = trimmed;
  }
  const { themes: directory } = await storageRoot(workspace, false);
  let names;
  try { names = await fs.readdir(directory); }
  catch (error) {
    if (error.code === 'ENOENT') return { themes: [], total: 0, offset, limit, nextOffset: null, truncated: false };
    throw error;
  }
  const files = names.filter(name => name.toLowerCase().endsWith('.json')).sort();
  const all = [];
  const reserved = new Set();
  for (const name of files) {
    const stem = name.slice(0, -5);
    const file = path.join(directory, name);
    const envelope = await readEnvelope(file, stem, { allowDifferentId: true });
    if (envelope.id !== stem) {
      fail('STORE_FORMAT', 'Theme file ' + name + ' stores id "' + envelope.id + '"; the filename and stored id must match exactly.', { theme: stem, storedId: envelope.id, path: file });
    }
    const reservation = envelope.id.toLowerCase();
    if (reserved.has(reservation)) {
      fail('THEME_ID_COLLISION', 'Multiple theme files reserve the same case-insensitive id "' + envelope.id + '".', { theme: envelope.id, path: file });
    }
    reserved.add(reservation);
    const head = envelope.revisions[envelope.revisions.length - 1];
    const summary = {
      id: envelope.id,
      revision: head.theme.revision,
      hash: head.hash,
      title: head.theme.title,
      summary: head.theme.summary,
      tags: [...head.theme.tags],
    };
    const assetClasses = assetClassesOf(head.theme);
    if (assetClasses.length) summary.assetClasses = assetClasses;
    all.push(summary);
  }
  const filtered = needle ? all.filter(item => matchesQuery(item, needle)) : all;
  const page = filtered.slice(offset, offset + limit);
  const total = filtered.length;
  const nextOffset = offset + page.length < total ? offset + page.length : null;
  const truncated = nextOffset !== null;
  const result = { themes: page, total, offset, limit, nextOffset, truncated };
  if (truncated) result.note = 'An alphabetical catalog page, not a recommended sample. Use nextOffset for later pages.';
  return result;
}
