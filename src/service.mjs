import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createScene, applyOperations, summarizeScene, tree, ZPixelError, MODEL_FIRST_CONTRACT, resolveSceneCamera } from './scene.mjs';
import { renderScene, RENDERER_VERSION } from './renderer.mjs';
import { renderNormalmap, NORMALMAP_SOURCE_MODE, NORMALMAP_RELIEF } from './normalmap.mjs';
import { createDocument, editDocument, loadDocument, listDocuments, exportFiles, fingerprint } from './store.mjs';
import { encodePNG, previewBoard } from './png.mjs';
import {migrateLegacyScene} from './migration.mjs';
import {contributionReport} from './contribution.mjs';
import {spatialReport,spatialSummary,spatialTree,findNodes} from './spatial.mjs';
import { guide } from './guides.mjs';
import {addTheme,reviseTheme,readTheme,listThemes} from './theme-store.mjs';
import {compileTheme,readThemePack,themeReport} from './theme-runtime.mjs';
import {applyTheme,validateThemeRequest} from './theme-apply.mjs';
import {compileWorld} from './world.mjs';
import {cameraBasis} from './math.mjs';
import {
  createObservationReceipt,
  deliveryAngleSeparation,
  flatScene,
  normalizeIsolate,
  normalizeObservationMode,
  normalizeObservationView,
  structureHash,
  validateObservationCamera,
  viewHash,
} from './observation.mjs';

export const VERSION = '0.5.3-dev';
const RENDERER_SEMVER = RENDERER_VERSION.startsWith('dsh-zpixel/renderer-') ? RENDERER_VERSION.slice('dsh-zpixel/renderer-'.length) : RENDERER_VERSION;
const CONVENTIONS = new Set(['opengl', 'directx']);
// zpixel_normalmap accepts exactly these fields. Unknown fields are rejected
// instead of ignored so a caller cannot believe it tuned a parameter that does
// not exist (strength, height, normalSource, ...).
const NORMALMAP_FIELDS = Object.freeze(['document', 'revision', 'convention', 'scale', 'export']);
const NEUTRAL_ENCODED_RGB = Object.freeze([128, 128, 255]);
// A whole-scene observation must look at the model from a genuinely different
// projection axis than the persisted delivery camera. The qualifier is axis
// separation min(angle,180-angle) >= 20, so a parallel or exactly opposite view
// (same axis) does not count. deliveryAngleDegrees stays 0..180 as evidence;
// qualifying values are 20..160.
const OBSERVATION_MIN_ANGLE = 20;
const MAX_OBSERVATION_RECORDS = 256;
const fail = (code, message, details = {}) => { throw new ZPixelError(code, message, details); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function documentId(args) {
  if (typeof args.document !== 'string' || !args.document) fail('DOCUMENT_REQUIRED', 'Provide document, the stable scene ID.');
  return args.document;
}
function int(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail('RANGE', `${label} must be an integer from ${min} to ${max}.`, { field: label });
  return value;
}
function atRevision(scene, revision) {
  if (revision !== undefined && revision !== scene.revision) fail('REVISION_CONFLICT', 'The requested revision is no longer current. Open the document before exporting.', { expected: revision, actual: scene.revision });
}
function compactNode(node) {
  const { pixels, ...fields } = node;
  return pixels ? { ...fields, pixels: { length: pixels.length, painted: pixels.filter(v => v !== null).length, sample: pixels.slice(0, 32) }, note: 'Pixel sample is bounded; use inspect region or scene export for complete data.' } : fields;
}

/** Application operations shared by the five native tools and local core checks. */
export function createZPixelService(ports, config = {}) {
  if (!ports || typeof ports !== 'object') fail('PORTS_REQUIRED', 'ZPixel requires explicit capability ports.');
  const workspacePort = ports.workspace;
  const attachments = ports.attachments;
  if (!workspacePort || typeof workspacePort.ensure !== 'function') fail('PORTS_REQUIRED', 'ZPixel requires ports.workspace.ensure(request, options).');
  if (!attachments || typeof attachments.saveImages !== 'function') fail('PORTS_REQUIRED', 'ZPixel requires ports.attachments.saveImages(images).');
  const maxImageDimension = attachments.imageLimits?.maxImageDimension;
  if (!Number.isSafeInteger(maxImageDimension) || maxImageDimension < 1) fail('PORTS_REQUIRED', 'ZPixel requires a finite attachments.imageLimits.maxImageDimension.');
  const detectModelInput = typeof ports.modelInput === 'function' ? ports.modelInput : null;
  const cacheLimit = Number.isSafeInteger(config.maxCacheBytes) && config.maxCacheBytes > 0 ? config.maxCacheBytes : 24 * 1024 * 1024;
  const cache = new Map();
  // Delivery images and observation images are deliberately separate cache
  // families. A delivery entry owns the beauty preview that can unlock a
  // reviewed export; an observation entry never does, even when the pixels are
  // identical. Keys include the workspace and the full content fingerprint.
  const maxCacheBytes = cacheLimit;
  // Delivered non-delivery observations, keyed by workspace + receipt id.
  // Records are service-session state: a new session must observe again.
  const observations = new Map();
  // Delivered beauty previews, keyed by workspace + document + content
  // fingerprint. This is derived session evidence for authoring status, never
  // a persisted scene phase.
  const deliveryPreviews = new Map();
  const requestOf = request => {
    if (!request || typeof request !== 'object') fail('REQUEST_REQUIRED', 'ZPixel requires a trusted request DTO from the Host.');
    for (const field of ['actorId', 'sessionId', 'workspace', 'callId', 'rootCallId']) {
      if (typeof request[field] !== 'string' || request[field].length === 0) fail('REQUEST_REQUIRED', `request.${field} must be a non-empty Host-owned string.`, { field });
    }
    if (!request.signal || typeof request.signal.throwIfAborted !== 'function') fail('REQUEST_REQUIRED', 'request.signal must be the Host-owned cancellation signal.');
    if (!request.policy || typeof request.policy !== 'object') fail('REQUEST_REQUIRED', 'request.policy must be the Host-owned sandbox policy.');
    return request;
  };
  function checkWorkspacePolicy(request, workspace, write) {
    const resolved = path.resolve(workspace);
    if (!write) return resolved;
    const mode = request.policy.mode;
    if (mode === 'read-only') fail('READ_ONLY', 'This session is read-only. Open or render existing scenes, or enable workspace writes before changing documents.');
    if (!['workspace-write', 'danger-full-access'].includes(mode)) fail('POLICY_REQUIRED', 'ZPixel requires an explicit read-only, workspace-write, or danger-full-access policy.');
    const root = request.policy.workspaceRoot;
    if (typeof root !== 'string' || !root) fail('POLICY_REQUIRED', 'writable requests require policy.workspaceRoot so ZPixel output stays inside the explicit workspace.');
    const relative = path.relative(path.resolve(root), resolved);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) fail('WORKSPACE_BOUNDARY', 'The current workspace lies outside the session write boundary.');
    return resolved;
  }
  async function context(request, write = false) {
    requestOf(request);
    request.signal.throwIfAborted();
    const workspace = await workspacePort.ensure(request, { write, signal: request.signal });
    if (typeof workspace !== 'string' || !workspace) fail('WORKSPACE_REQUIRED', 'ports.workspace.ensure must return the authorized workspace path.');
    return checkWorkspacePolicy(request, workspace, write);
  }
  async function modelInput(request) {
    requestOf(request);
    const known = new Set(['image_capable', 'data_only', 'capability_unknown']);
    if (known.has(request.modelInput)) return request.modelInput;
    if (detectModelInput) {
      try {
        const detected = await detectModelInput(request);
        return known.has(detected) ? detected : 'capability_unknown';
      } catch (error) {
        request.signal.throwIfAborted();
        return 'capability_unknown';
      }
    }
    return 'capability_unknown';
  }
  function markDelivered(entry, request) {
    const key = `${request.actorId}:${request.sessionId}`;
    if (!entry.deliveries) entry.deliveries = new Map();
    entry.deliveries.set(key, { actorId: request.actorId, sessionId: request.sessionId });
    entry.deliveredTo.add(request.actorId);
  }
  function releaseEntrySession(entry, sessionId) {
    if (!entry.deliveries) return;
    for (const [key, delivery] of entry.deliveries) if (delivery.sessionId === sessionId) entry.deliveries.delete(key);
    entry.deliveredTo.clear();
    for (const delivery of entry.deliveries.values()) entry.deliveredTo.add(delivery.actorId);
  }
  function hasActorDelivery(entry, actorId) {
    return entry.deliveries ? [...entry.deliveries.values()].some(delivery => delivery.actorId === actorId) : entry.deliveredTo.has(actorId);
  }
  function imageFor(workspace, scene, mode, projection = false) {
    const key = `${workspace}:${fingerprint(scene)}:${mode}:${projection}`;
    if (cache.has(key)) {
      const value = cache.get(key); cache.delete(key); cache.set(key, value); return value;
    }
    const image = renderScene(scene, { mode, projection });
    const value = { key, kind: 'delivery', image, deliveredTo: new Set(), deliveries: new Map(), bytes: image.rgba.byteLength + image.hits.length * 192 };
    cache.set(key, value);
    let total = [...cache.values()].reduce((sum, item) => sum + item.bytes, 0);
    while (cache.size > 1 && total > maxCacheBytes) { const oldest = cache.keys().next().value; total -= cache.get(oldest).bytes; cache.delete(oldest); }
    return value;
  }
  function countPartPixels(scene, image) {
    const kinds = new Map(scene.nodes.map(node => [node.id, node.kind]));
    let count = 0;
    // Outline strokes are image-space replacements, not visible solid surface.
    // A frame made only of generated outline pixels is not a part observation.
    for (const hit of image.hits) if (hit && !hit.outlineReason && kinds.get(hit.nodeId) === 'part') count++;
    return count;
  }
  function observationImageFor(workspace, scene, view) {
    const structure = structureHash(scene), content = fingerprint(scene);
    const key = `obs:${workspace}:${scene.id}:${structure}:${content}:${view.viewHash}`;
    if (cache.has(key)) {
      const value = cache.get(key); cache.delete(key); cache.set(key, value); return value;
    }
    const image = renderScene(view.scene, { mode: view.mode });
    const value = { key, kind: 'observation', image, deliveredTo: new Set(), deliveries: new Map(), bytes: image.rgba.byteLength + image.hits.length * 192, contribution: undefined, structureHash: structure, contentHash: content, viewHash: view.viewHash, partPixels: countPartPixels(scene, image), view };
    cache.set(key, value);
    let total = [...cache.values()].reduce((sum, item) => sum + item.bytes, 0);
    while (cache.size > 1 && total > maxCacheBytes) { const oldest = cache.keys().next().value; total -= cache.get(oldest).bytes; cache.delete(oldest); }
    return value;
  }
  function contributionFor(entry, scene) {
    // The image cache key includes the scene fingerprint, so one entry always
    // describes one revision and one camera; the report is computed at most once.
    if (!entry.contribution) entry.contribution = contributionReport(scene, entry.image);
    return entry.contribution;
  }
  function reportFor(workspace,scene){
    if(!scene.theme)return null;
    const entry=imageFor(workspace,scene,'beauty');
    if(!entry.themeReport)entry.themeReport=themeReport(scene,entry.image);
    return entry.themeReport;
  }
  function themeMetadata(scene){
    if(!scene.theme)return null;
    const {id,revision,hash,adapterVersion,context,overrides}=scene.theme;
    return{id,revision,hash,adapterVersion,context,overrides,snapshot:'theme.json'};
  }
  function themeFiles(scene){return scene.theme?{'theme.json':JSON.stringify(scene.theme.snapshot,null,2)+'\n'}:{};}
  // ---------------------------------------------------------------------------
  // Model-first observation helpers. All of these operate on private clones;
  // none of them writes a document or changes a revision.
  // ---------------------------------------------------------------------------
  function checkExpected(scene, args) {
    if (args.expectedRevision !== undefined) {
      const expected = int(args.expectedRevision, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER);
      if (expected !== scene.revision) fail('REVISION_CONFLICT', 'The requested expectedRevision is no longer current. Open the document before observing.', { expected, actual: scene.revision });
    }
    if (args.expectedHash !== undefined) {
      if (typeof args.expectedHash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(args.expectedHash)) fail('ARGUMENTS', 'expectedHash must be a 64-character sha256 hex digest.', { field: 'expectedHash' });
      const actual = fingerprint(scene), expected = args.expectedHash.toLowerCase();
      if (expected !== actual) fail('HASH_CONFLICT', 'The scene content no longer matches expectedHash. Open the current revision before observing.', { expected, actual, field: 'expectedHash', hint: 'expectedHash is the full store fingerprint returned as contentHash; it includes revision.' });
    }
  }
  function observationScene(scene, { camera, physicalOnly, isolate }) {
    const clone = structuredClone(scene);
    clone.camera = camera;
    if (physicalOnly) for (const node of clone.nodes) {
      if (node.kind !== 'layer') continue;
      // A bound appearance layer is a leaf and adds no geometry; hiding it is
      // safe. A free layer may legally be an ancestor of parts, so its own
      // surface is suppressed by clearing pixels while its visibility,
      // transform, material and outline remain intact for descendants.
      if (node.appearanceOf !== undefined) node.visible = false;
      else node.pixels = Array(node.width * node.height).fill(null);
    }
    if (isolate !== null) {
      const node = clone.nodes.find(value => value.id === isolate);
      if (!node) fail('NODE_NOT_FOUND', 'isolate refers to an unknown node.', { node: isolate });
      if (node.kind === 'layer' && node.appearanceOf !== undefined) fail('OBSERVATION_ISOLATE', 'A bound appearance layer has no physical geometry; isolate its owner part instead.', { node: isolate, appearanceOf: node.appearanceOf });
      const target = compileWorld(scene).entries.get(isolate);
      if (!target || target.visible === false) fail('OBSERVATION_ISOLATE', 'The isolate target or one of its ancestors is hidden; no visible structure would be isolated. Unhide the target or choose a visible node.', { node: isolate, visible: false });
      const ancestors = new Set();
      for (let parent = node.parent; parent !== null;) {
        const value = clone.nodes.find(item => item.id === parent);
        if (!value) break;
        if (value.kind !== 'group') fail('OBSERVATION_ISOLATE', 'The isolate target has a physical ancestor that would remain visible as an occluder. Isolate a top-level part or group, or reparent the target under a group first.', { node: isolate, ancestor: value.id, ancestorKind: value.kind });
        ancestors.add(parent);
        parent = value.parent;
      }
      const subtree = new Set([isolate]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const item of clone.nodes) if (!subtree.has(item.id) && subtree.has(item.parent)) { subtree.add(item.id); grew = true; }
      }
      const keep = new Set([...ancestors, ...subtree, 'root']);
      for (const item of clone.nodes) if (!keep.has(item.id)) item.visible = false;
    }
    return clone;
  }
  /**
   * Fit translates the requested target and eye together to the observed
   * bounds center (preserving the requested direction), then frames the
   * projected bounds with pixelsPerUnit/center. The returned receipt always
   * carries this actual normalized camera, never the pre-fit request.
   */
  function fitCamera(scene, transient, camera) {
    const compiled = compileWorld(transient);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let found = false;
    for (const entry of compiled.entries.values()) {
      if (!entry.visible || !entry.instance || !entry.bounds) continue;
      found = true;
      for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], entry.bounds.min[axis]); max[axis] = Math.max(max[axis], entry.bounds.max[axis]); }
    }
    if (!found) return camera;
    // Fit moves the view target to the observed bounds center and shifts the
    // eye with it, preserving the requested direction. It never rotates the
    // camera behind the caller's back.
    const target = min.map((value, index) => (value + max[index]) / 2);
    const dx = camera.target[0] - camera.position[0], dy = camera.target[1] - camera.position[1], dz = camera.target[2] - camera.position[2];
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 1e-12) return camera;
    const unit = [dx / distance, dy / distance, dz / distance];
    const position = target.map((value, index) => value - unit[index] * distance);
    const fitted = { ...camera, position, target };
    const basis = cameraBasis(fitted);
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (const entry of compiled.entries.values()) {
      if (!entry.visible || !entry.instance || !entry.bounds) continue;
      const bounds = entry.bounds;
      for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) {
        const px = x - target[0], py = y - target[1], pz = z - target[2];
        const u = px * basis.right[0] + py * basis.right[1] + pz * basis.right[2];
        const v = px * basis.down[0] + py * basis.down[1] + pz * basis.down[2];
        if (u < umin) umin = u; if (u > umax) umax = u;
        if (v < vmin) vmin = v; if (v > vmax) vmax = v;
      }
    }
    const uExtent = umax - umin, vExtent = vmax - vmin;
    if (uExtent < 1e-6 && vExtent < 1e-6) return { ...fitted, center: [scene.width / 2, scene.height / 2] };
    const margin = 1;
    const availableWidth = Math.max(1, scene.width - margin * 2), availableHeight = Math.max(1, scene.height - margin * 2);
    const candidates = [];
    if (uExtent >= 1e-6) candidates.push(availableWidth / uExtent);
    if (vExtent >= 1e-6) candidates.push(availableHeight / vExtent);
    const pixelsPerUnit = Math.min(1e4, Math.max(1e-4, Math.min(...candidates)));
    const center = [scene.width / 2 - pixelsPerUnit * (umin + umax) / 2, scene.height / 2 - pixelsPerUnit * (vmin + vmax) / 2];
    return { ...fitted, pixelsPerUnit, center };
  }
  function resolveObservationView(scene, args, { mode } = {}) {
    // Validate fit before the no-request early return: fit without a transient
    // camera is an argument error, never silently ignored.
    if (args.fit !== undefined && typeof args.fit !== 'boolean') fail('OBSERVATION_FIT', 'fit must be a boolean.');
    if (args.fit !== undefined && args.camera === undefined) fail('OBSERVATION_FIT', 'fit is valid only with a transient camera; the delivery camera is persisted in scene.camera.');
    const requested = args.camera !== undefined || args.isolate !== undefined || args.physicalOnly !== undefined;
    const normalizedMode = normalizeObservationMode(args.mode ?? mode ?? 'beauty');
    if (!requested) {
      const delivery = normalizedMode === 'beauty';
      const camera = scene.camera;
      return { requested: false, delivery, camera, mode: normalizedMode, physicalOnly: false, isolate: null, fit: false, scene: delivery ? scene : structuredClone(scene), viewHash: viewHash(scene, { camera, mode: normalizedMode }), deliveryAngleDegrees: delivery ? 0 : deliveryAngleSeparation(scene, camera) };
    }
    const fit = args.fit ?? true;
    let camera = args.camera !== undefined ? resolveSceneCamera(args.camera, scene) : scene.camera;
    const physicalOnly = args.physicalOnly ?? false;
    if (typeof physicalOnly !== 'boolean') fail('OBSERVATION_VIEW', 'physicalOnly must be a boolean.');
    const isolate = normalizeIsolate(args.isolate ?? null);
    let transient = observationScene(scene, { camera, physicalOnly, isolate });
    if (fit && args.camera !== undefined) {
      camera = fitCamera(scene, transient, camera);
      transient = observationScene(scene, { camera, physicalOnly, isolate });
    }
    const normalizedCamera = validateObservationCamera(camera, { base: scene.camera, width: scene.width, height: scene.height });
    const view = normalizeObservationView(normalizedCamera, { mode: normalizedMode, physicalOnly, isolate, base: scene.camera, width: scene.width, height: scene.height });
    const hash = viewHash(scene, { camera: view.camera, mode: normalizedMode, physicalOnly, isolate });
    // A supplied camera/isolate/physicalOnly is an observation request even if
    // it resolves to the same pixels as the delivery view. Only a render with
    // no observation overrides can be a delivery preview.
    return { requested: true, delivery: false, camera: view.camera, mode: normalizedMode, physicalOnly, isolate, fit, scene: transient, viewHash: hash, deliveryAngleDegrees: deliveryAngleSeparation(scene, view.camera) };
  }
  function viewInfo(view) {
    return { camera: view.camera, mode: view.mode, physicalOnly: view.physicalOnly, isolate: view.isolate, fit: view.fit, delivery: view.delivery, deliveryAngleDegrees: view.deliveryAngleDegrees, separationDegrees: Math.min(view.deliveryAngleDegrees, 180 - view.deliveryAngleDegrees), wholeScene: view.isolate === null };
  }
  function buildObservationReceipt(scene, view, deliveredTo) {
    return createObservationReceipt(scene, { camera: view.camera, mode: view.mode, physicalOnly: view.physicalOnly, isolate: view.isolate, deliveredTo: [...deliveredTo] });
  }
  function buildDeliveryReceipt(scene, deliveredTo) {
    const receipt = createObservationReceipt(scene, { camera: scene.camera, mode: 'beauty', deliveredTo: [...deliveredTo] });
    return { ...receipt, id: `view-${receipt.id.slice(4)}`, delivery: true };
  }
  function rememberObservation(workspace, receipt, view, partPixels, request) {
    const key = `${workspace}:${receipt.id}`;
    let record = observations.get(key);
    if (!record) {
      record = { key, workspace, id: receipt.id, receipt, document: receipt.document, revision: receipt.revision, structureHash: receipt.structureHash, contentHash: receipt.contentHash, viewHash: receipt.viewHash, mode: receipt.mode, physicalOnly: receipt.physicalOnly, isolate: receipt.isolate, camera: receipt.camera, deliveryAngleDegrees: view.deliveryAngleDegrees, partPixels, deliveredTo: new Set(), deliveries: new Map() };
      observations.set(key, record);
      if (observations.size > MAX_OBSERVATION_RECORDS) observations.delete(observations.keys().next().value);
    }
    const deliveryKey = `${request.actorId}:${request.sessionId}`;
    record.deliveries.set(deliveryKey, { actorId: request.actorId, sessionId: request.sessionId });
    record.deliveredTo.add(request.actorId);
    return record;
  }
  function rememberDeliveryPreview(workspace, scene, request) {
    const key = `${workspace}:${scene.id}:${fingerprint(scene)}`;
    let delivered = deliveryPreviews.get(key);
    if (!delivered) {
      delivered = new Map();
      deliveryPreviews.set(key, delivered);
      if (deliveryPreviews.size > MAX_OBSERVATION_RECORDS) deliveryPreviews.delete(deliveryPreviews.keys().next().value);
    }
    let sessions = delivered.get(request.actorId);
    if (!sessions) { sessions = new Set(); delivered.set(request.actorId, sessions); }
    sessions.add(request.sessionId);
    return delivered;
  }
  function deliveryPreviewStatus(workspace, scene, actorId) {
    return deliveryPreviews.get(`${workspace}:${scene.id}:${fingerprint(scene)}`)?.has(actorId) ? 'current' : 'none';
  }
  function observationStatus(workspace, scene, agentId) {
    if (scene.contract !== MODEL_FIRST_CONTRACT) return 'none';
    const structure = structureHash(scene);
    const records = [...observations.values()].filter(record => record.workspace === workspace && record.document === scene.id && record.deliveredTo.has(agentId));
    if (records.some(record => record.structureHash === structure && record.isolate === null && record.partPixels > 0 && Math.min(record.deliveryAngleDegrees, 180 - record.deliveryAngleDegrees) >= OBSERVATION_MIN_ANGLE)) return 'valid';
    // Evidence for an older structure is stale; same-structure but
    // non-qualifying probes are simply not a valid observation yet.
    return records.some(record => record.structureHash !== structure) ? 'stale' : 'none';
  }
  function authoringStatus(workspace, scene, agentId) {
    return { contract: scene.contract ?? null, structureHash: structureHash(scene), contentHash: fingerprint(scene), observation: observationStatus(workspace, scene, agentId), deliveryPreview: deliveryPreviewStatus(workspace, scene, agentId) };
  }
  function observationGate(workspace, scene, agentId) {
    const structure = structureHash(scene), contract = scene.contract === MODEL_FIRST_CONTRACT, flat = flatScene(scene), required = contract && !flat;
    const candidates = [...observations.values()].filter(record => record.workspace === workspace && record.document === scene.id && record.structureHash === structure);
    const valid = candidates.filter(record => record.isolate === null && record.deliveredTo.has(agentId) && record.partPixels > 0 && Math.min(record.deliveryAngleDegrees, 180 - record.deliveryAngleDegrees) >= OBSERVATION_MIN_ANGLE);
    const status = !contract ? 'legacy-none' : flat ? 'flat-only-exempt' : valid.length ? 'observed' : 'not-observed';
    const chosen = valid[0] ?? null;
    const nearMisses = required && !chosen ? candidates.filter(record => record.deliveredTo.has(agentId)).slice(-4).map(record => {
      const separation = Math.min(record.deliveryAngleDegrees, 180 - record.deliveryAngleDegrees);
      return { id: record.id, revision: record.revision, reasons: [...(record.isolate !== null ? ['isolate'] : []), ...(separation < OBSERVATION_MIN_ANGLE ? [`axis-separation ${separation.toFixed(1)}<${OBSERVATION_MIN_ANGLE}`] : []), ...(record.partPixels <= 0 ? ['no-visible-part-pixels'] : [])] };
    }) : [];
    const chosenSeparation = chosen ? Math.min(chosen.deliveryAngleDegrees, 180 - chosen.deliveryAngleDegrees) : null;
    return { required, status, structureHash: structure, contract: contract ? MODEL_FIRST_CONTRACT : null, flat, matched: valid.length, receipt: chosen ? { ...chosen.receipt, deliveredTo: [...chosen.deliveredTo].sort() } : null, partPixels: chosen?.partPixels ?? null, deliveryAngleDegrees: chosen?.deliveryAngleDegrees ?? null, separationDegrees: chosenSeparation, nearMisses };
  }
  function observationReport(gate, waiver, draft) {
    const note = !gate.contract
      ? 'Legacy document without the model-first contract; the reviewed gate remains the existing visual review.'
      : gate.flat
        ? 'No part nodes; a flat scene has no hidden spatial structure to observe.'
        : gate.status === 'observed'
          ? 'A delivered whole-scene non-delivery observation of the current structure satisfies the reviewed gate.'
          : waiver
            ? 'Observation gate waived by a recorded structureReview reason; the waiver is recorded, not hidden.'
            : draft
              ? 'Draft export is unblocked; a reviewed export requires a delivered whole-scene observation of this structure at least 20 degrees of axis separation from the delivery view (opposite views do not count).'
              : 'A reviewed export requires a delivered whole-scene observation of this structure at least 20 degrees of axis separation from the delivery view (opposite views do not count).';
    const status = waiver && gate.required && gate.status !== 'observed' ? 'waived' : gate.status;
    return { required: gate.required, status, structureHash: gate.structureHash, contract: gate.contract, flat: gate.flat, receipt: gate.receipt, partPixels: gate.partPixels, deliveryAngleDegrees: gate.deliveryAngleDegrees, separationDegrees: gate.separationDegrees, minimumSeparationDegrees: OBSERVATION_MIN_ANGLE, qualifyingDeliveryAngleRange: [OBSERVATION_MIN_ANGLE, 180 - OBSERVATION_MIN_ANGLE], waiver: waiver ?? null, draft, nearMisses: gate.nearMisses, note };
  }
  function structureReviewWaiver(args) {
    if (args.structureReview === undefined) return null;
    const value = args.structureReview;
    if (!plain(value)) fail('STRUCTURE_REVIEW', 'structureReview must be an object {waived:true,reason}.');
    for (const key of Object.keys(value)) if (!['waived', 'reason'].includes(key)) fail('STRUCTURE_REVIEW', 'Unknown structureReview field ' + key + '.', { field: key, allowed: ['waived', 'reason'] });
    if (value.waived !== true) fail('STRUCTURE_REVIEW', 'structureReview.waived must be true to waive the observation gate.');
    if (typeof value.reason !== 'string' || value.reason.trim().length < 3 || value.reason.length > 360) fail('STRUCTURE_REVIEW', 'structureReview.reason must be a 3–360 character production reason.');
    return { waived: true, reason: value.reason };
  }
  function workingObservation(scene) {
    const compiled = compileWorld(scene);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let found = false;
    for (const entry of compiled.entries.values()) {
      if (!entry.visible || !entry.instance || !entry.bounds || entry.node.kind === 'layer') continue;
      found = true;
      for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], entry.bounds.min[axis]); max[axis] = Math.max(max[axis], entry.bounds.max[axis]); }
    }
    if (!found) return null;
    const center = min.map((value, index) => (value + max[index]) / 2);
    const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const distance = Math.max(diagonal, 1);
    const directions = [[1, 1, 1], [-1, 1, 1], [1, 1, -1], [-1, 1, -1], [1, 0.6, 1], [-1, 0.6, 1], [1, 0.6, -1], [-1, 0.6, -1]];
    let best = null;
    for (const direction of directions) {
      const length = Math.hypot(...direction), unit = direction.map(value => value / length);
      const camera = { position: center.map((value, index) => value + unit[index] * distance), target: [...center], up: [0, 1, 0], mirrorX: scene.camera.mirrorX, pixelsPerUnit: 1, center: [scene.width / 2, scene.height / 2] };
      const angle = deliveryAngleSeparation(scene, camera);
      const separation = Math.min(angle, 180 - angle);
      if (!best || separation > best.separation) best = { camera, angle, separation };
      if (separation >= OBSERVATION_MIN_ANGLE) return { camera, angle, separation };
    }
    return best;
  }

  async function preview(workspace, scene, args, request) {
    checkExpected(scene, args);
    const mode = normalizeObservationMode(args.mode ?? 'beauty');
    const scale = int(args.scale ?? 6, 'scale', 1, 8);
    const view = resolveObservationView(scene, args, { mode });
    const structure = structureHash(scene), content = fingerprint(scene);
    const entry = view.delivery ? imageFor(workspace, scene, mode) : observationImageFor(workspace, scene, view);
    const board = previewBoard(entry.image, scale);
    if (board.width > attachments.imageLimits.maxImageDimension || board.height > attachments.imageLimits.maxImageDimension) fail('PREVIEW_SIZE', 'Preview exceeds the host image dimensions. Choose a smaller scale.');
    request.signal.throwIfAborted();
    const name = view.delivery ? `${scene.id}-r${scene.revision}-${mode}.png` : `${scene.id}-r${scene.revision}-${mode}-${view.viewHash.slice(0, 8)}.png`;
    const [attachment] = await attachments.saveImages([{ data: encodePNG(board.width, board.height, board.rgba), mediaType: 'image/png', name }]);
    markDelivered(entry, request);
    if (view.delivery) rememberDeliveryPreview(workspace, scene, request);
    const capability = await modelInput(request);
    let observation;
    if (view.delivery) observation = buildDeliveryReceipt(scene, entry.deliveredTo);
    else {
      const receipt = buildObservationReceipt(scene, view, entry.deliveredTo);
      rememberObservation(workspace, receipt, view, entry.partPixels, request);
      observation = { ...receipt, deliveredTo: [...entry.deliveredTo].sort() };
    }
    const contribution = contributionFor(entry, view.delivery ? scene : view.scene);
    return {
      document: scene.id, revision: scene.revision, coordinates: scene.coordinates, mode,
      nativeSize: { width: scene.width, height: scene.height }, panels: board.panels, colorsUsed: entry.image.colorsUsed,
      stats: entry.image.stats, contribution, warnings: entry.image.warnings, modelInput: capability, visualReview: 'not-recorded',
      structureHash: structure, contentHash: content, viewHash: view.viewHash, observationId: observation.id,
      delivery: view.delivery,
      view: { ...viewInfo(view), partPixels: view.delivery ? null : entry.partPixels },
      observation,
      authoring: authoringStatus(workspace, scene, request.actorId),
      ...(scene.theme && view.delivery ? { theme_report: reportFor(workspace, scene) } : {}),
      attachment,
    };
  }
  async function withPreview(result, workspace, args, request) {
    const value = { ...summarizeScene(result.scene), ...(result.themeChanges?{theme_changes:result.themeChanges}:{}), tree: spatialTree(result.scene,{limit:24}).tree, spatial:spatialSummary(result.scene), replayed: result.replayed, appliedRevision: result.appliedRevision, authoring: authoringStatus(workspace, result.scene, request.actorId) };
    if (args.preview) {
      const spatial = result.scene.contract === MODEL_FIRST_CONTRACT && !flatScene(result.scene);
      if (spatial) {
        // The default working view is the model-first workflow. A failure here
        // must never fall back to the delivery beauty: that would silently
        // reopen the old delivery-only loop and unlock a reviewed export.
        let working = null;
        try { working = workingObservation(result.scene); }
        catch (error) { value.previewError = { code: error.code || 'WORKING_VIEW_FAILED', message: error.message }; }
        if (!value.previewError && !working) value.previewError = { code: 'NO_VISIBLE_STRUCTURE', message: 'This model-first scene has no visible physical structure to observe. Unhide or reparent a part, or call zpixel_render with no overrides for the persisted delivery beauty when you deliberately want it.' };
        if (!value.previewError) {
          try {
            value.preview = await preview(workspace, result.scene, { camera: working.camera, physicalOnly: true, fit: true }, request);
            value.preview.workingView = true;
            value.preview.note = 'Default model-first working view: fitted physical-only non-delivery observation. Call zpixel_render with no overrides for the persisted delivery beauty before a reviewed export.';
            value.attachment = value.preview.attachment; delete value.preview.attachment;
          } catch (error) { value.previewError = { code: error.code || 'WORKING_VIEW_FAILED', message: error.message }; }
        }
        if (value.previewError) value.note = 'The scene is committed. No delivery preview was delivered; call zpixel_render with no overrides for the persisted delivery beauty when you deliberately want it.';
      } else {
        try {
          value.preview = await preview(workspace, result.scene, {}, request);
          value.attachment = value.preview.attachment; delete value.preview.attachment;
        } catch (error) { value.previewError = { code: error.code || 'PREVIEW_FAILED', message: error.message }; value.note = 'The scene is committed. Render its returned revision to retry the preview.'; }
      }
      value.authoring = authoringStatus(workspace, result.scene, request.actorId);
    }
    return value;
  }
  function actionFields(args,allowed){
    for(const key of Object.keys(args))if(!allowed.includes(key))fail('THEME_ARGUMENT','Field '+key+' is not valid for theme action '+args.action,{field:key,action:args.action,allowed});
  }
  async function referenceInfo(workspace,reference){
    if(!reference.path)return{...reference,available:false,note:'No local reference path is stored.'};
    const root=await fs.realpath(workspace),candidate=path.resolve(root,reference.path);
    const relative=path.relative(root,candidate);
    if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))fail('THEME_REFERENCE_PATH','Reference path escapes the workspace.');
    try{
      const real=await fs.realpath(candidate),rel=path.relative(root,real);
      if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))return{...reference,available:false,note:'Reference resolves outside the workspace.'};
      const stat=await fs.stat(real);
      return{...reference,available:stat.isFile(),bytes:stat.size};
    }catch(error){if(error.code==='ENOENT')return{...reference,available:false,note:'Reference file is missing; stored observations remain available.'};throw error;}
  }
  async function attachReference(workspace,theme,id,request){
    const reference=theme.references.find(value=>value.id===id);
    if(!reference)fail('THEME_REFERENCE','This theme has no reference '+String(id));
    const info=await referenceInfo(workspace,reference);
    if(!info.available)fail('THEME_REFERENCE','The selected reference image is unavailable.',{reference:info});
    if(info.bytes>8*1024*1024)fail('THEME_REFERENCE_LIMIT','Reference image exceeds the 8 MiB delivery limit.');
    const mediaTypes={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
    const mediaType=mediaTypes[path.extname(reference.path).toLowerCase()];
    if(!mediaType)fail('THEME_REFERENCE_TYPE','References must be PNG, JPEG, WebP or GIF images.');
    const data=await fs.readFile(path.resolve(workspace,reference.path));
    const hash=createHash('sha256').update(data).digest('hex');
    if(reference.sha256&&reference.sha256!==hash)fail('THEME_REFERENCE_CHANGED','Reference bytes no longer match the stored hash.',{reference:id,expected:reference.sha256,actual:hash});
    request.signal.throwIfAborted();
    const [attachment]=await attachments.saveImages([{data,mediaType,name:theme.id+'-'+reference.id+path.extname(reference.path)}]);
    return{attachment,reference:{...info,sha256:hash,note:'Original reference delivered; crop coordinates are metadata. Visual analysis is performed by the calling model.'}};
  }
  async function themeAction(args,request){
    const action=args.action,write=action==='add'||action==='revise';
    const workspace=await context(request,write);
    if(action==='list'){
      actionFields(args,['action','offset','limit','query']);
      return listThemes(workspace,{offset:args.offset,limit:args.limit,query:args.query});
    }
    if(action==='add'||action==='revise'){
      actionFields(args,action==='add'?['action','theme','spec','txid']:['action','theme','expected_revision','spec','txid']);
      request.signal.throwIfAborted();
      const result=action==='add'?await addTheme(workspace,args.theme,args.spec,args.txid):await reviseTheme(workspace,args.theme,args.expected_revision,args.spec,args.txid);
      const capabilities=compileTheme(result.theme).capabilities;
      return{theme:{id:result.theme.id,revision:result.theme.revision,title:result.theme.title},hash:result.hash,capabilities,replayed:result.replayed,appliedRevision:result.appliedRevision,modelInput:await modelInput(request),note:'Theme authored and stored. Capabilities describe executable support, not reference fidelity or finished-asset conformity.'};
    }
    if(action==='read'){
      actionFields(args,['action','theme','revision','context','view','sections','reference']);
      const record=await readTheme(workspace,args.theme,args.revision);
      const pack=readThemePack(record.theme,args.context??{},{view:args.view,sections:args.sections});
      // Reference availability is factual; no image analysis is implied by reading metadata.
      if(Array.isArray(pack.references))pack.references=await Promise.all(pack.references.map(ref=>referenceInfo(workspace,ref)));
      pack.modelInput=await modelInput(request);
      if(args.reference!==undefined)Object.assign(pack,await attachReference(workspace,record.theme,args.reference,request));
      return pack;
    }
    fail('THEME_ACTION','Choose add, read, list or revise.');
  }
  async function sceneAction(args, request) {
    const write = ['create', 'edit', 'undo', 'redo', 'migrate'].includes(args.action);
    const workspace = await context(request, write);
    if(Object.hasOwn(args,'theme')&&!['create','edit'].includes(args.action))fail('THEME_ARGUMENT','Theme binding is valid only on create or edit.');
    if (args.action === 'list') return listDocuments(workspace, { offset: args.offset, limit: args.limit });
    const id = documentId(args);
    if (args.action === 'open') {
      const scene = await loadDocument(workspace, id,{allowLegacy:true});
      if(scene.format==='dsh-zpixel/1')return {id,revision:scene.revision,format:scene.format,migrationRequired:true,next:'Use action:migrate with source_document and a new document ID. Original is preserved.'};
      return withPreview({ scene, replayed: false, appliedRevision: scene.revision }, workspace, args, request);
    }
    if(args.action==='migrate'){
      if(args.scene!==undefined&&args.source_document!==undefined)fail('MIGRATION_SOURCE','Provide scene OR source_document, not both.');
      if(args.source_document===id)fail('MIGRATION_COPY','Migration must create a new document ID.');
      const input=args.scene??(args.source_document?await loadDocument(workspace,args.source_document,{allowLegacy:true}):null);
      const converted=migrateLegacyScene(input,{id});
      const result=await createDocument(workspace,converted.scene,args.txid,args);
      return {...await withPreview(result,workspace,args,request),migration:converted.migration};
    }
    if (args.action === 'create') {
      // create takes initial scene values; format/coordinates are optional
      // markers. A dsh-zpixel/2 snapshot may repeat its revision, which is
      // validated and reset; without that marker revision is not an input field.
      if (args.scene !== undefined && !plain(args.scene)) fail('SCENE_VALUES', 'scene must be an object containing initial scene values.');
      const input = args.scene ?? {};
      const snapshot = input.format === 'dsh-zpixel/2';
      if (input.format !== undefined && !snapshot) {
        if (input.format === 'dsh-zpixel/1') fail('MIGRATION_REQUIRED', 'Legacy dsh-zpixel/1 scenes are Z-up. Use action:migrate with source_document and a new document ID; create accepts only dsh-zpixel/2.', { format: input.format });
        fail('INVALID_FORMAT', `scene.format must be "dsh-zpixel/2" or omitted; got ${JSON.stringify(input.format)}. Legacy dsh-zpixel/1 scenes must use action:migrate.`, { format: input.format });
      }
      if (input.coordinates !== undefined && input.coordinates !== 'right-handed-y-up') fail('COORDINATES', 'New scenes use only right-handed-y-up coordinates. Use action:migrate for legacy Z-up scenes.', { coordinates: input.coordinates });
      const { format, coordinates, ...initial } = input;
      if (initial.id !== undefined && initial.id !== id) fail('DOCUMENT_ID', 'scene.id must equal document when supplied.');
      if (snapshot && Object.hasOwn(initial, 'revision')) {
        if (!Number.isSafeInteger(initial.revision) || initial.revision < 0) fail('RANGE', 'scene.revision in a dsh-zpixel/2 snapshot must be a nonnegative safe integer. Create always starts the new document at revision 0.', { field: 'scene.revision', value: initial.revision });
        delete initial.revision;
      }
      // A fresh create is model-first by default. A complete format-2 snapshot
      // is imported content: preserve its contract, including the absence that
      // marks a legacy asset. Direct createScene callers are unaffected.
      const contract = input.contract !== undefined ? input.contract : snapshot && Object.hasOwn(input, 'revision') ? undefined : MODEL_FIRST_CONTRACT;
      let record,prepared=initial,themeChanges;
      if(Object.hasOwn(args,'theme')){
        if(args.theme===null)fail('THEME_ARGUMENT','Use theme:null only on edit to detach a theme.');
        if(Object.hasOwn(initial,'theme'))fail('THEME_ARGUMENT','Choose an outer theme reference or an embedded scene snapshot, not both.');
        validateThemeRequest(args.theme);
        record=await readTheme(workspace,args.theme.id,args.theme.revision);
        const camera=initial.camera??(args.theme.applyDefaults!==false?record.theme.tokens.camera:undefined);
        const frame=createScene({id,width:initial.width??64,height:initial.height??64,...(camera?{camera}:{})});
        const compiled=compileTheme(record.theme,{...args.theme.context,nativeSize:[frame.width,frame.height]},{camera:frame.camera});
        const blockers=compiled.capabilities.unsupported.filter(item=>item.required!==false);
        if(blockers.length)fail('THEME_UNSUPPORTED','Theme resources require unsupported renderer capabilities.',{unsupported:blockers});
        // Nodes and authored pixels may reference theme resources in their first create.
        prepared={...initial,...(camera?{camera}:{}),palette:{...compiled.defaults.palette,...initial.palette},ramps:{...compiled.defaults.ramps,...initial.ramps},materials:{...compiled.defaults.materials,...initial.materials}};
      }
      let scene=createScene({...prepared,id,...(contract===undefined?{}:{contract})});
      if(record){
        const applied=applyTheme(scene,record,args.theme,{initial:true,explicitFields:Object.keys(initial),explicitRoot:(initial.nodes??[]).find(node=>node.id==='root')??{},explicitResources:initial});
        scene=applied.scene;themeChanges=applied.changes;
      }
      if (args.ops !== undefined) scene = applyOperations(scene, args.ops);
      request.signal.throwIfAborted();
      const stored=await createDocument(workspace, scene, args.txid, args);
      return withPreview({...stored,themeChanges}, workspace, args, request);
    }
    if (['edit', 'undo', 'redo'].includes(args.action)) {
      let record,themeChanges;
      if(Object.hasOwn(args,'theme')&&args.theme!==null){validateThemeRequest(args.theme);record=await readTheme(workspace,args.theme.id,args.theme.revision);}
      const result = await editDocument(workspace, id, args.revision, args.txid, args, current => {
        request.signal.throwIfAborted();
        // Resource preload lets node_add/paint in this same transaction name theme tokens.
        // Both stages remain on private clones; only the final validated scene is committed.
        const preload=record?applyTheme(current,record,{...args.theme,bindings:[],applyDefaults:args.theme.applyDefaults===true}):null;
        let next=preload?.scene??current;
        next=applyOperations(next,args.ops??(Object.hasOwn(args,'theme')?[]:undefined));
        if(Object.hasOwn(args,'theme')){
          if(args.theme===null){next=applyOperations(next,[{op:'scene_set',values:{theme:null}}]);themeChanges={metadataOnly:true,detached:true};}
          else{
            const applied=applyTheme(next,record,{...args.theme,applyDefaults:false});
            next=applied.scene;
            themeChanges={...applied.changes,defaultsApplied:preload.changes.defaultsApplied,globalFields:preload.changes.globalFields,removedLights:preload.changes.removedLights,retainedResources:preload.changes.retainedResources};
          }
        }
        return next;
      }, args.action);
      return withPreview({...result,themeChanges}, workspace, args, request);
    }
    fail('ACTION', 'Choose create, open, list, edit, undo, redo or migrate.');
  }
  async function inspect(args, request) {
    const workspace = await context(request), scene = await loadDocument(workspace, documentId(args));
    checkExpected(scene, args);
    const kind = args.kind ?? 'tree';
    const observationFields = ['camera', 'fit', 'isolate', 'physicalOnly'].filter(key => args[key] !== undefined);
    if (observationFields.length && !['view', 'pixel', 'region', 'spatial'].includes(kind)) fail('OBSERVATION_ARGUMENT', 'camera, fit, isolate and physicalOnly are valid only for inspect kinds view, pixel, region or spatial.', { kind, fields: observationFields });
    // kind:view is the image route; it shares the exact render/observation path.
    // With no observation overrides it follows delivery-preview semantics: the
    // persisted delivery beauty image is actually sent and counts as a delivery
    // preview. With camera/fit/isolate/physicalOnly it is a non-delivery
    // observation and never counts as the delivery preview.
    if (kind === 'view') return preview(workspace, scene, args, request);
    if(kind==='theme')return{document:scene.id,revision:scene.revision,theme_report:reportFor(workspace,scene)};
    if(kind==='tree')return {document:scene.id,...spatialTree(scene,{root:args.node??'root',depth:args.depth??3,limit:args.limit??32}),spatial:spatialSummary(scene)};
    if(kind==='find') {const nodes=findNodes(scene,{query:args.query,role:args.role,tag:args.tag,root:args.node}),limit=int(args.limit??32,'limit',1,256);return {document:scene.id,revision:scene.revision,nodes:nodes.slice(0,limit),total:nodes.length,truncated:nodes.length>limit};}
    if(kind==='spatial'){
      const view=resolveObservationView(scene,args,{mode:'beauty'});
      const report=spatialReport(view.scene,{node:args.node,other:args.other,query:args.query,role:args.role,tag:args.tag,limit:args.limit??12});
      if(args.include_projection){
        let physicalImage;
        for(const n of report.nodes){
          const node=view.scene.nodes.find(value=>value.id===n.id);
          if(node?.appearanceOf!==undefined){
            const entry=view.delivery?imageFor(workspace,scene,'beauty'):observationImageFor(workspace,scene,view);
            const contribution=contributionFor(entry,view.scene);
            const appearance=contribution.appearances.find(value=>value.id===n.id);
            n.projectionInfo={visiblePixels:appearance?.visiblePixels??0,source:'appearance',appearanceOf:node.appearanceOf,note:'Visible color samples on the owner part in the current beauty image; this layer has no physical surface. Outline replacements are excluded.'};
          }else{
            if(!physicalImage){
              if(view.delivery)physicalImage=imageFor(workspace,scene,'nodes').image;
              else {
                const nodesView={...view,mode:'nodes',viewHash:viewHash(scene,{camera:view.camera,mode:'nodes',physicalOnly:view.physicalOnly,isolate:view.isolate})};
                physicalImage=observationImageFor(workspace,scene,nodesView).image;
              }
            }
            const visiblePixels=physicalImage.hits.filter(hit=>hit?.nodeId===n.id).length;
            n.projectionInfo={visiblePixels,note:'Visible pixels in the current camera; fully occluded footprint is not counted.'};
          }
        }
      }
      return {document:scene.id,...report,structureHash:structureHash(scene),contentHash:fingerprint(scene),viewHash:view.viewHash,delivery:view.delivery,view:viewInfo(view)};
    }
    if (kind === 'scene') {
      const source = JSON.stringify(scene);
      return source.length <= 64000 ? { scene } : { ...summarizeScene(scene), sourcePath: path.join(workspace, '.zpixel', 'documents', `${scene.id}.json`), truncated: true, note: 'Scene exceeds 64,000 characters. Inspect individual nodes or export the editable scene.' };
    }
    if (kind === 'node') {
      const node = scene.nodes.find(n => n.id === args.node);
      if (!node) fail('NODE_NOT_FOUND', 'Provide an existing node ID.', { node: args.node });
      return { document: scene.id, revision: scene.revision, node: compactNode(node), spatial:spatialReport(scene,{node:node.id,limit:6}).nodes[0] };
    }
    if (kind === 'pixel' || kind === 'region') {
      const view=resolveObservationView(scene,args,{mode:'beauty'});
      const x = int(args.x, 'x', 0, scene.width - 1), y = int(args.y, 'y', 0, scene.height - 1);
      const w = kind === 'pixel' ? 1 : int(args.w, 'w', 1, 16), h = kind === 'pixel' ? 1 : int(args.h, 'h', 1, 16);
      if (x + w > scene.width || y + h > scene.height) fail('REGION_BOUNDS', 'The requested region extends outside the native image.');
      const { image } = view.delivery ? imageFor(workspace, scene, 'beauty') : observationImageFor(workspace, scene, view), pixels = [];
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) pixels.push({ x: x + dx, y: y + dy, hit: image.hits[(y + dy) * scene.width + x + dx] });
      return { document: scene.id, revision: scene.revision, pixels, structureHash:structureHash(scene), contentHash:fingerprint(scene), viewHash:view.viewHash, delivery:view.delivery, view:viewInfo(view) };
    }
    fail('INSPECT_KIND', 'Choose scene, tree, find, spatial, node, pixel, region, view or theme.');
  }
  async function exportScene(args, request) {
    const workspace = await context(request, true), scene = await loadDocument(workspace, documentId(args));
    atRevision(scene, args.revision);
    const entry = imageFor(workspace, scene, 'beauty'), contribution = contributionFor(entry, scene);
    const theme_report=reportFor(workspace,scene);
    const capability = await modelInput(request), draft = args.draft ?? true;
    const waiver = structureReviewWaiver(args);
    const gate = observationGate(workspace, scene, request.actorId);
    if (!draft) {
      if (capability !== 'image_capable') fail('VISUAL_INPUT_REQUIRED', 'This model route has no verified image input. Export with draft:true.');
      if (deliveryPreviewStatus(workspace, scene, request.actorId) !== 'current') fail('PREVIEW_REQUIRED', 'Render the current beauty image in this session before recording a visual review.');
      if (!plain(args.review) || !['identity', 'nativeReadable', 'lighting'].every(k => args.review[k] === true) || typeof args.review.note !== 'string' || args.review.note.trim().length < 3 || args.review.note.length > 360) fail('REVIEW_REQUIRED', 'Provide review:{identity:true,nativeReadable:true,lighting:true,note:"honest visual judgment"}; note must be 3–360 characters, with length at least 3 after trimming surrounding whitespace, or use draft:true.');
      if(theme_report?.blocked)fail('THEME_RULES','Theme hard rules failed or require unsupported capabilities. Save a draft, fix the rules, or record an explicit rule override.',{theme_report});
      if(gate.required&&gate.status!=='observed'&&!waiver)fail('OBSERVATION_REQUIRED','Reviewed export requires a delivered whole-scene non-delivery observation of the current structure, at least 20 degrees of axis separation from the delivery view (exactly opposite views do not count) and showing at least one visible part pixel. Render with zpixel_render camera/physicalOnly (no isolate) or record structureReview:{waived:true,reason}.',{structureHash:gate.structureHash,status:gate.status,minimumSeparationDegrees:OBSERVATION_MIN_ANGLE,qualifyingDeliveryAngleRange:[OBSERVATION_MIN_ANGLE,180-OBSERVATION_MIN_ANGLE],nearMisses:gate.nearMisses});
    }
    const structure = gate.structureHash, spatial = spatialSummary(scene), observation = observationReport(gate, waiver, draft);
    const png = encodePNG(scene.width, scene.height, entry.image.rgba);
    const project = `${JSON.stringify(scene, null, 2)}\n`;
    const manifest = { format: 'dsh-zpixel-export/1', version: VERSION, document: scene.id, revision: scene.revision, width: scene.width, height: scene.height, status: draft ? 'draft' : 'reviewed', sceneHash: fingerprint(scene), structureHash: structure, spatial, observation, camera: scene.camera, pngHash: createHash('sha256').update(png).digest('hex'), colorsUsed: entry.image.colorsUsed, contribution, ...(scene.theme?{theme:themeMetadata(scene),theme_report}:{}), renderer: { version: RENDERER_SEMVER, mode: 'beauty', sampling: 'pixel-centers', coordinates:scene.coordinates,camera:scene.camera }, modelInput: capability, review: draft ? null : args.review, note: 'A recorded human/model judgment is not an automatic aesthetic certification.' };
    request.signal.throwIfAborted();
    const manifestName = draft ? 'draft.json' : 'reviewed.json';
    const files = await exportFiles(workspace, scene.id, scene.revision, { 'sprite.png': png, 'project.zpixel.json': project, [manifestName]: `${JSON.stringify(manifest, null, 2)}\n`,...themeFiles(scene) }, `v${VERSION}`);
    return { document: scene.id, revision: scene.revision, status: manifest.status, width: scene.width, height: scene.height, png: files['sprite.png'], project: files['project.zpixel.json'], manifest: files[manifestName], colors: entry.image.colorsUsed.length, contribution, structureHash: structure, spatial, observation, camera: scene.camera, ...(waiver?{structureReview:waiver}:{}), ...(scene.theme?{theme:themeMetadata(scene),theme_report}:{}), modelInput: capability, review: manifest.review };
  }
  function normalmapFields(args) {
    for (const key of Object.keys(args)) {
      if (NORMALMAP_FIELDS.includes(key)) continue;
      fail('UNSUPPORTED_FIELD', `Field ${key} is not supported by zpixel_normalmap.`, {
        field: key,
        allowed: [...NORMALMAP_FIELDS],
        hint: 'There is no strength, height, heightScale, normalSource, normalConvention, blur, edge, alpha, flat or background parameter. Normals come from visible geometry faces in the beauty hit buffer; use convention opengl|directx, scale 1..8 and export true|false.',
      });
    }
  }
  const shareOf = value => Math.round(value * 10000) / 10000;
  const hexByte = value => value.toString(16).padStart(2, '0');
  /**
   * Describe the encoded normal image without touching it. All counts are area
   * weighted over visible (non-null hit) pixels, so dominantShare and
   * neutralEncodedShare use the same denominator. neutralEncodedShare counts
   * pixels whose encoded RGB is exactly [128,128,255]; it is deliberately not
   * fallbackCounts.neutralPixels, which counts only outside-outline and
   * degenerate fallbacks and can be 0 on a fully neutral image.
   */
  function normalmapDiagnostics(scene, image) {
    const counts = new Map();
    let visible = 0, neutralEncodedPixels = 0;
    for (let index = 0; index < image.hits.length; index++) {
      if (!image.hits[index]) continue;
      const offset = index * 4;
      const r = image.rgba[offset], g = image.rgba[offset + 1], b = image.rgba[offset + 2];
      visible++;
      const key = (r << 16) | (g << 8) | b;
      counts.set(key, (counts.get(key) || 0) + 1);
      if (r === NEUTRAL_ENCODED_RGB[0] && g === NEUTRAL_ENCODED_RGB[1] && b === NEUTRAL_ENCODED_RGB[2]) neutralEncodedPixels++;
    }
    let dominantKey = null, dominantPixels = 0;
    for (const [key, count] of counts) if (count > dominantPixels) { dominantKey = key; dominantPixels = count; }
    const dominantColor = dominantKey === null ? null : '#' + hexByte((dominantKey >> 16) & 255) + hexByte((dominantKey >> 8) & 255) + hexByte(dominantKey & 255);
    const uniqueColorCount = counts.size;
    const dominantShare = visible ? shareOf(dominantPixels / visible) : 0;
    const neutralEncodedShare = visible ? shareOf(neutralEncodedPixels / visible) : 0;
    const surfacePixels = image.stats.surfacePixels ?? 0;
    const layerPixels = image.stats.layerPixels ?? 0;
    const representation = visible === 0 ? 'empty'
      : surfacePixels > 0 && layerPixels > 0 ? 'mixed'
        : layerPixels > 0 ? 'painted-layers'
          : surfacePixels > 0 ? 'solid-parts'
            : 'outline-only';
    const camera = cameraBasis(scene);
    const topDown = Math.abs(camera.direction[0]) < 1e-6 && Math.abs(camera.direction[2]) < 1e-6 && camera.direction[1] < -1 + 1e-6;
    const flatness = visible === 0 ? 'empty' : uniqueColorCount === 1 ? 'flat' : dominantShare >= 0.9 ? 'near-flat' : 'varied';
    const percent = value => `${Math.round(value * 1000) / 10}%`;
    const warnings = [];
    if (visible === 0) warnings.push('Normal map: no visible pixels; the image is fully transparent.');
    if (topDown && surfacePixels > 0 && dominantShare >= 0.9) warnings.push(`Normal map: the delivery camera is top_down and ${percent(dominantShare)} of visible pixels share one encoded normal (${dominantColor}). A visible face pointing at the camera encodes as neutral [128,128,255]; tilt the delivery camera (three_quarter) or add solid parts whose visible faces are not +Y if you need varied normals.`);
    if (layerPixels > 0) warnings.push(`Normal map: ${layerPixels} of ${visible} visible pixels come from painted layers (${percent(visible ? layerPixels / visible : 0)}). A free layer contributes only its plane normal; pixel color is never converted into height relief, so a view-facing layer is neutral by design.`);
    if (uniqueColorCount > 1 && dominantShare >= 0.9) warnings.push(`Normal map: ${percent(dominantShare)} of visible pixels share ${dominantColor}; the map is near-flat even though it has ${uniqueColorCount} distinct encoded colors.`);
    return {
      sourceMode: NORMALMAP_SOURCE_MODE,
      relief: NORMALMAP_RELIEF,
      representation,
      camera: { view: topDown ? 'top_down' : 'oblique', preset: scene.camera.preset ?? null, direction: [...camera.direction], up: [...(scene.camera.up ?? [0, 1, 0])], mirrorX: scene.camera.mirrorX === true },
      visiblePixels: visible,
      surfacePixels,
      layerPixels,
      uniqueColorCount,
      dominantColor,
      dominantShare,
      neutralEncodedShare,
      flatness,
      warnings,
    };
  }
  async function normalmap(args, request) {
    normalmapFields(args);
    const convention = args.convention ?? 'opengl';
    if (!CONVENTIONS.has(convention)) fail('CONVENTION', "convention must be 'opengl' or 'directx'.", { convention });
    if (args.export !== undefined && typeof args.export !== 'boolean') fail('ARGUMENTS', 'export must be a boolean.');
    const write = args.export === true;
    const workspace = await context(request, write), scene = await loadDocument(workspace, documentId(args));
    atRevision(scene, args.revision);
    const scale = int(args.scale ?? 6, 'scale', 1, 8);
    const beauty = imageFor(workspace, scene, 'beauty');
    const contribution = contributionFor(beauty, scene);
    const theme_report=reportFor(workspace,scene);
    const structure = structureHash(scene), spatial = spatialSummary(scene), gate = observationGate(workspace, scene, request.actorId);
    const observation = { ...observationReport(gate, null, !write), countsAsObservation: false, note: 'Technical normal-map data; this export does not deliver a non-delivery observation and cannot satisfy the reviewed observation gate.' };
    request.signal.throwIfAborted();
    const image = renderNormalmap(scene, { convention, beauty: beauty.image });
    if (!plain(image?.normalMap)) fail('NORMALMAP_METADATA', 'The normal map renderer did not return normalMap metadata.');
    const diagnostics = normalmapDiagnostics(scene, image);
    const warnings = [...image.warnings, ...diagnostics.warnings];
    const space = image.normalMap.space ?? 'view', encoding = image.normalMap.encoding ?? 'linear-rgb';
    const board = previewBoard(image, scale);
    if (board.width > attachments.imageLimits.maxImageDimension || board.height > attachments.imageLimits.maxImageDimension) fail('PREVIEW_SIZE', 'Preview exceeds the host image dimensions. Choose a smaller scale.');
    request.signal.throwIfAborted();
    const [attachment] = await attachments.saveImages([{ data: encodePNG(board.width, board.height, board.rgba), mediaType: 'image/png', name: `${scene.id}-r${scene.revision}-normalmap-${convention}.png` }]);
    const capability = await modelInput(request);
    // A normal map is technical data: this preview is never recorded as a
    // beauty delivery, so it cannot unlock a reviewed zpixel_export.
    const result = { document: scene.id, revision: scene.revision, coordinates: scene.coordinates, mode: 'normalmap', convention, space, encoding, sceneHash: fingerprint(scene), structureHash: structure, spatial, observation, camera: scene.camera, nativeSize: { width: scene.width, height: scene.height }, normalMap: image.normalMap, diagnostics, contribution, ...(scene.theme?{theme:themeMetadata(scene),theme_report}:{}), version: VERSION, exported: write, status: write ? 'technical-data' : 'preview', preview: { scale, board: { width: board.width, height: board.height }, panels: board.panels, colorCount: image.colorsUsed.length, colorsUsed: image.colorsUsed.slice(0, 32), colorsTruncated: image.colorsUsed.length > 32, stats: image.stats, warnings, modelInput: capability, visualReview: 'not-recorded' }, attachment };
    if (!write) return result;
    const normalPng = encodePNG(image.width, image.height, image.rgba), beautyPng = encodePNG(scene.width, scene.height, beauty.image.rgba);
    const normalHash = createHash('sha256').update(normalPng).digest('hex'), beautyHash = createHash('sha256').update(beautyPng).digest('hex');
    const manifest = { format: 'dsh-zpixel-normalmap-export/1', version: VERSION, renderer: { version: RENDERER_SEMVER, mode: 'normalmap', sampling: 'pixel-centers', coordinates: scene.coordinates, camera: scene.camera }, camera: scene.camera, document: scene.id, revision: scene.revision, width: scene.width, height: scene.height, convention, space, encoding, sceneHash: fingerprint(scene), structureHash: structure, spatial, observation, normalMap: image.normalMap, contribution, ...(scene.theme?{theme:themeMetadata(scene),theme_report}:{}), png: { normal: { file: 'normal.png', width: image.width, height: image.height, sha256: normalHash }, beauty: { file: 'sprite.png', width: scene.width, height: scene.height, sha256: beautyHash } }, status: 'technical-data', import: 'normal.png is linear, non-color data: disable sRGB sampling on import. sprite.png is the lit/ramped beauty render from the same scene revision, camera, occlusion and masks.', review: null, note: 'Technical normal map data only; no human or model aesthetic review is recorded.' };
    const generation = `v${VERSION}-normalmap-${convention}`;
    request.signal.throwIfAborted();
    const files = await exportFiles(workspace, scene.id, scene.revision, { 'normal.png': normalPng, 'sprite.png': beautyPng, 'project.zpixel.json': `${JSON.stringify(scene, null, 2)}\n`, 'normalmap.json': `${JSON.stringify(manifest, null, 2)}\n`,...themeFiles(scene) }, generation);
    return { ...result, exported: true, status: 'technical-data', generation, png: files['normal.png'], beauty: files['sprite.png'], sprite: files['sprite.png'], project: files['project.zpixel.json'], manifest: files['normalmap.json'] };
  }
  function releaseSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return;
    for (const entry of cache.values()) releaseEntrySession(entry, sessionId);
    for (const record of observations.values()) {
      if (record.deliveries) for (const [key, delivery] of record.deliveries) if (delivery.sessionId === sessionId) record.deliveries.delete(key);
      record.deliveredTo.clear();
      for (const delivery of record.deliveries?.values() ?? []) record.deliveredTo.add(delivery.actorId);
    }
    for (const [key, delivered] of deliveryPreviews) {
      for (const [actorId, sessions] of delivered) {
        sessions.delete(sessionId);
        if (!sessions.size) delivered.delete(actorId);
      }
      if (!delivered.size) deliveryPreviews.delete(key);
    }
  }
  return {
    async run(name, args, request) {
      requestOf(request);
      if (!plain(args)) fail('ARGUMENTS', 'Tool arguments must be an object.');
      request.signal.throwIfAborted();
      if (name === 'zpixel_guide') return guide(args.topic);
      if (name === 'zpixel_theme') return themeAction(args,request);
      if (name === 'zpixel_scene') return sceneAction(args, request);
      if (name === 'zpixel_render') { const workspace = await context(request); return preview(workspace, await loadDocument(workspace, documentId(args)), args, request); }
      if (name === 'zpixel_normalmap') return normalmap(args, request);
      if (name === 'zpixel_inspect') return inspect(args, request);
      if (name === 'zpixel_export') return exportScene(args, request);
      fail('TOOL', 'Unknown ZPixel tool.');
    },
    releaseSession,
    dispose() { cache.clear(); observations.clear(); deliveryPreviews.clear(); },
  };
}
