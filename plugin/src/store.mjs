import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateScene, summarizeScene, ZPixelError } from './scene.mjs';

const FORMAT = 'dsh-zpixel-store/1';
const MAX_BYTES = 32 * 1024 * 1024;
const HISTORY = 12;
const queues = new Map();
export const fingerprint = value => createHash('sha256').update(stableJSON(value)).digest('hex');
export function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableJSON(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function fail(code, message, details = {}) { throw new ZPixelError(code, message, details); }
function checkId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) fail('DOCUMENT_ID', 'Use a document ID starting with a letter, followed by letters, numbers, _ or - (at most 64 characters).');
}
function checkTx(txid) {
  if (typeof txid !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(txid)) fail('TXID', 'Provide a unique txid starting with a letter (at most 96 characters). Reuse it only for an identical retry.');
}
async function regular(target, directory = false) {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail('UNSAFE_PATH', `Expected a regular ${directory ? 'directory' : 'file'}: ${target}`);
    return stat;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
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
export async function storageRoot(workspace, create = false) {
  const canonical = await fs.realpath(workspace);
  const root = await folder(canonical, '.zpixel', create);
  return { workspace: canonical, root };
}
async function location(workspace, id, create = false) {
  checkId(id);
  const { root } = await storageRoot(workspace, create);
  const directory = await folder(root, 'documents', create);
  return { directory, file: path.join(directory, `${id}.json`) };
}
const sameIdIgnoringCase = (left, right) => typeof left === 'string' && typeof right === 'string' &&
  left.length === right.length && left.toLowerCase() === right.toLowerCase();

async function readEnvelope(file, id, allowLegacy = false, { acceptStoredId = false } = {}) {
  const stat = await regular(file);
  if (!stat) fail('NOT_FOUND', `ZPixel document ${id} does not exist.`, { document: id });
  if (stat.size > MAX_BYTES) fail('STORE_LIMIT', 'Document history exceeds the 32 MiB storage limit.');
  const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
  if (envelope.format !== FORMAT || !Array.isArray(envelope.history) || !Array.isArray(envelope.future) || !Array.isArray(envelope.receipts)) {
    fail('STORE_FORMAT', 'Unrecognized or damaged ZPixel store document.', { document: id, path: file });
  }
  const storedId = envelope.scene?.id;
  if (storedId !== id && !(acceptStoredId && typeof storedId === 'string' && storedId.length > 0)) {
    if (sameIdIgnoringCase(storedId, id)) fail('DOCUMENT_ID_COLLISION',
      `Document ID "${id}" differs only by letter case from existing document "${storedId}". Use the stored ID "${storedId}" or choose a different document ID.`,
      { document: id, storedId, path: file });
    fail('STORE_FORMAT', 'Unrecognized or damaged ZPixel store document.', { document: id, storedId, path: file });
  }
  if (!(allowLegacy && envelope.scene.format === 'dsh-zpixel/1')) validateScene(envelope.scene);
  return envelope;
}
async function atomicJSON(file, value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_BYTES) fail('STORE_LIMIT', 'Document history exceeds 32 MiB. Reduce layer sizes or history.');
  await regular(file);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, text, { flag: 'wx' });
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
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
async function locked(file, operation) {
  let handle;
  try {
    handle = await fs.open(`${file}.lock`, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') fail('BUSY', 'Another process owns this document lock. Retry after that operation finishes.', { lock: `${file}.lock` });
    throw error;
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid })); return await operation(); }
  finally { await handle.close(); await fs.unlink(`${file}.lock`); }
}
function receipt(envelope, txid, hash) {
  const found = envelope.receipts.find(item => item.txid === txid);
  if (!found) return null;
  if (found.fingerprint !== hash) fail('TXID_REUSED', 'This txid belongs to a different request. Use a new txid for a new edit.');
  return { scene: envelope.scene, replayed: true, appliedRevision: found.revision };
}
function remember(envelope, txid, hash) {
  envelope.receipts.push({ txid, fingerprint: hash, revision: envelope.scene.revision });
  envelope.receipts = envelope.receipts.slice(-128);
}

export async function loadDocument(workspace, id, { allowLegacy = false } = {}) {
  const { file } = await location(workspace, id);
  return (await readEnvelope(file, id, allowLegacy)).scene;
}
export async function listDocuments(workspace, { offset = 0, limit = 50 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0) fail('RANGE', 'offset must be a nonnegative safe integer.', { field: 'offset', hint: 'Use offset 0 for the first catalog page.' });
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail('RANGE', 'limit must be a safe integer from 1 to 50.', { field: 'limit', hint: 'Choose a page size from 1 to 50; the default is 50.' });
  const { root } = await storageRoot(workspace);
  const directory = await folder(root, 'documents', false);
  let names;
  try { names = await fs.readdir(directory); } catch (error) {
    if (error.code === 'ENOENT') return { documents: [], total: 0, offset, limit, nextOffset: null, truncated: false };
    throw error;
  }
  const ids = names.filter(name => /^[A-Za-z][A-Za-z0-9_-]{0,63}\.json$/.test(name)).sort();
  const documents = [];
  for (const name of ids.slice(offset, offset + limit)) {
    const scene = (await readEnvelope(path.join(directory, name), name.slice(0, -5), true, { acceptStoredId: true })).scene;
    documents.push(scene.format==='dsh-zpixel/1'?{id:scene.id,title:scene.title,revision:scene.revision,format:scene.format,legacy:true,migrationRequired:true}:summarizeScene(scene));
  }
  const total = ids.length, nextOffset = offset + documents.length < total ? offset + documents.length : null;
  const truncated = total > documents.length;
  const page = { documents, total, offset, limit, nextOffset, truncated };
  if (truncated) page.note = 'An alphabetical catalog page, not recommended examples or a representative sample. Use nextOffset for later pages.';
  return page;
}
export async function createDocument(workspace, scene, txid, request) {
  checkTx(txid); validateScene(scene);
  const { file } = await location(workspace, scene.id, true);
  const hash = fingerprint(request);
  return serialized(file, () => locked(file, async () => {
    if (await regular(file)) {
      // A valid legacy envelope is an existing document, not an unsupported
      // scene. Detect it before scene validation so the conflict is reported.
      const existing = await readEnvelope(file, scene.id, true);
      if (existing.scene.format === 'dsh-zpixel/1') fail('ALREADY_EXISTS',
        'This document ID already exists as a legacy dsh-zpixel/1 document. Choose a new ID, open it, or migrate it explicitly; create never overwrites it.',
        { document: scene.id, format: existing.scene.format, migrationRequired: true });
      const replay = receipt(existing, txid, hash);
      if (replay) return replay;
      fail('ALREADY_EXISTS', 'This document exists. Open it or choose a new ID.', { document: scene.id });
    }
    const envelope = { format: FORMAT, scene, history: [], future: [], receipts: [] };
    remember(envelope, txid, hash);
    await atomicJSON(file, envelope);
    return { scene, replayed: false, appliedRevision: scene.revision };
  }));
}
export async function editDocument(workspace, id, revision, txid, request, update, action = 'edit') {
  checkTx(txid);
  if (!Number.isSafeInteger(revision) || revision < 0) fail('REVISION_REQUIRED', 'Use the revision returned by open, create or the last edit.');
  const { file } = await location(workspace, id);
  const hash = fingerprint(request);
  return serialized(file, () => locked(file, async () => {
    const envelope = await readEnvelope(file, id);
    const replay = receipt(envelope, txid, hash);
    if (replay) return replay;
    if (envelope.scene.revision !== revision) fail('REVISION_CONFLICT', 'Document changed. Open its current revision before editing.', { expected: revision, actual: envelope.scene.revision });
    const current = envelope.scene;
    let next;
    if (action === 'undo') {
      if (!envelope.history.length) fail('NO_UNDO', 'No retained edit to undo.');
      next = envelope.history.pop(); envelope.future.push(current);
    } else if (action === 'redo') {
      if (!envelope.future.length) fail('NO_REDO', 'No retained edit to redo.');
      next = envelope.future.pop(); envelope.history.push(current);
    } else {
      next = update(current); envelope.history.push(current); envelope.future = [];
    }
    next.revision = current.revision + 1;
    validateScene(next);
    envelope.scene = next; envelope.history = envelope.history.slice(-HISTORY); envelope.future = envelope.future.slice(-HISTORY);
    remember(envelope, txid, hash);
    await atomicJSON(file, envelope);
    return { scene: next, replayed: false, appliedRevision: next.revision };
  }));
}

/** Immutable revision exports; differing existing bytes are never overwritten. */
export async function exportFiles(workspace, id, revision, files, generation = '') {
  checkId(id);
  if (generation && !/^[A-Za-z0-9._-]{1,48}$/.test(generation)) fail('EXPORT_GENERATION', 'Invalid internal renderer generation.');
  const { root } = await storageRoot(workspace, true);
  const exports = await folder(root, 'exports', true);
  const directory = await folder(exports, `${id}-r${revision}${generation ? `-${generation}` : ''}`, true);
  const result = {};
  for (const [name, content] of Object.entries(files)) {
    if (!/^[a-z][a-z0-9_.-]+$/.test(name)) fail('EXPORT_NAME', 'Invalid internal export filename.');
    const target = path.join(directory, name), bytes = Buffer.from(content);
    if (await regular(target)) {
      const existing = await fs.readFile(target);
      if (!existing.equals(bytes)) fail('EXPORT_EXISTS', 'Export contains different existing bytes. Existing files were preserved.', { path: target });
    } else {
      try { await fs.writeFile(target, bytes, { flag: 'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await regular(target);
        if (!(await fs.readFile(target)).equals(bytes)) fail('EXPORT_EXISTS', 'A concurrent export wrote different bytes.', { path: target });
      }
    }
    result[name] = target;
  }
  return result;
}
