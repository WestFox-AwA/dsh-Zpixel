import { WORKFLOW } from './guides.mjs';

// Domain-owned interaction metadata. The workflow is the exact guidance the
// standalone adapter injects; topics point at the existing zpixel_guide
// topics instead of copying their bodies into a Host.
export const INTERACTION_VERSION = 1;

const ALIASES = Object.freeze({
  zpixel_scene: 'scene',
  zpixel_render: 'render',
  zpixel_normalmap: 'normalmap',
  zpixel_inspect: 'inspect',
  zpixel_export: 'export',
  zpixel_guide: 'guide',
  zpixel_theme: 'theme',
});

const TOPIC_DESCRIPTIONS = Object.freeze({
  overview: 'Coordinate system, representation choice and the blockout-observation-delivery order.',
  camera: 'The persistent delivery camera and its orthographic presets.',
  observation: 'Transient observation cameras, fit/isolate/physicalOnly and the reviewed-export gate.',
  nodes: 'Groups, solid parts, painted layers, part-bound appearance and outline inheritance.',
  geometry: 'Local primitives, extrusion mapping and world-compiled queries.',
  anchors: 'Named local mating ports and the three attach modes.',
  spatial: 'Authored relation intent versus separately measured world observations.',
  painting: 'Layer pixels, sparse/rect/whole-array paint edits and bound appearance sampling.',
  lighting: 'Palette, ramps, materials, lights and the supported lighting limits.',
  migration: 'Explicit legacy Z-up to Y-up migration into a new document.',
  normalmap: 'Technical sprite-local normal maps and the beauty/normal pairing.',
  theme: 'Versioned theme authoring, pinned binding and mechanical checks.',
  tools: 'Tool/action map, edit shapes and revision/txid protection.',
  limits: 'Implemented bounds and honest unsupported features.',
});

const TOPIC_IDS = Object.freeze(['overview', 'camera', 'observation', 'nodes', 'geometry', 'anchors', 'spatial', 'painting', 'lighting', 'migration', 'normalmap', 'theme', 'tools', 'limits']);

const TOPICS = Object.freeze(TOPIC_IDS.map(id => Object.freeze({
  id,
  action: 'guide',
  args: Object.freeze({ topic: id }),
  description: TOPIC_DESCRIPTIONS[id],
})));

// A real small assembly: a parent group, two solid parts with matching hinge
// anchors, one authored relation and one painted ground layer. It is authored
// by this example and never reads an existing user document.
const YARD_PIXELS = Object.freeze([
  'grass', null, null, null, null, null, null, null,
  null, 'grass', null, null, null, null, null, null,
  null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null,
]);

const YARD_SCENE = Object.freeze({
  width: 64,
  height: 64,
  camera: Object.freeze({ preset: 'top_down', target: Object.freeze([-2, 1, 0]), pixelsPerUnit: 4 }),
  palette: Object.freeze({ grass: '#4f7a3a' }),
  nodes: Object.freeze([
    Object.freeze({ id: 'yard', name: 'Yard', kind: 'group' }),
    Object.freeze({
      id: 'wall',
      name: 'Wall',
      kind: 'part',
      parent: 'yard',
      geometry: Object.freeze({ type: 'box', center: Object.freeze([0, 1, 0]), size: Object.freeze([8, 2, 1.5]) }),
      anchors: Object.freeze({ hinge: Object.freeze({ point: Object.freeze([-4, 1, 0]), axis: Object.freeze([0, 1, 0]) }) }),
    }),
    Object.freeze({
      id: 'gate',
      name: 'Gate',
      kind: 'part',
      parent: 'yard',
      geometry: Object.freeze({ type: 'box', center: Object.freeze([-6, 1, 0]), size: Object.freeze([4, 2, 1.2]) }),
      anchors: Object.freeze({ hinge: Object.freeze({ point: Object.freeze([-4, 1, 0]), axis: Object.freeze([0, 1, 0]) }) }),
    }),
    Object.freeze({
      id: 'ground',
      name: 'Ground paint',
      kind: 'layer',
      parent: 'yard',
      width: 8,
      height: 8,
      pixelSize: 1,
      basis: Object.freeze({ u: Object.freeze([1, 0, 0]), v: Object.freeze([0, 0, -1]) }),
      pixels: YARD_PIXELS,
    }),
  ]),
  spatialRelations: Object.freeze([
    Object.freeze({
      id: 'gate-hinge',
      from: Object.freeze({ node: 'gate', anchor: 'hinge' }),
      relation: 'coaxial',
      to: Object.freeze({ node: 'wall', anchor: 'hinge' }),
      angleTolerance: 2,
      distanceTolerance: 0.02,
    }),
  ]),
});

const EXAMPLES = Object.freeze([
  Object.freeze({
    id: 'guide-overview',
    description: 'Read the domain-owned overview first; it is the same workflow the standalone adapter injects.',
    action: 'guide',
    args: Object.freeze({ topic: 'overview' }),
  }),
  Object.freeze({
    id: 'create-yard',
    description: 'Self-contained: create a parent group, two solid parts with matching hinge anchors, one authored coaxial relation and one painted ground layer, then request the non-delivery working view.',
    action: 'scene',
    args: Object.freeze({
      action: 'create',
      document: 'interaction-yard',
      txid: 'interaction-yard-create',
      scene: YARD_SCENE,
      preview: true,
    }),
  }),
  Object.freeze({
    id: 'edit-transform',
    description: 'Self-contained after create-yard at revision 0: move the gate subtree locally; both parts and the layer stay untouched otherwise.',
    action: 'scene',
    dependsOn: Object.freeze(['create-yard']),
    args: Object.freeze({
      action: 'edit',
      document: 'interaction-yard',
      revision: 0,
      txid: 'interaction-yard-move',
      ops: Object.freeze([Object.freeze({ op: 'transform', id: 'gate', translate: Object.freeze([1, 0, 0]) })]),
    }),
  }),
  Object.freeze({
    id: 'edit-paint',
    description: 'Self-contained after create-yard and edit-transform: paint two sparse cells on the existing ground layer at revision 1.',
    action: 'scene',
    dependsOn: Object.freeze(['edit-transform']),
    args: Object.freeze({
      action: 'edit',
      document: 'interaction-yard',
      revision: 1,
      txid: 'interaction-yard-paint',
      ops: Object.freeze([Object.freeze({ op: 'paint', id: 'ground', ops: Object.freeze([Object.freeze({ op: 'pixels', pixels: Object.freeze([Object.freeze([0, 0, 'grass']), Object.freeze([1, 1, 'grass'])]) })]) })]),
    }),
  }),
  Object.freeze({
    id: 'edit-node-set',
    description: 'Self-contained after the two edits: rename the gate part with node_set at revision 2; each supplied field replaces that stored field wholesale.',
    action: 'scene',
    dependsOn: Object.freeze(['edit-paint']),
    args: Object.freeze({
      action: 'edit',
      document: 'interaction-yard',
      revision: 2,
      txid: 'interaction-yard-rename',
      ops: Object.freeze([Object.freeze({ op: 'node_set', id: 'gate', values: Object.freeze({ name: 'Gate leaf' }) })]),
    }),
  }),
  Object.freeze({
    id: 'inspect-spatial',
    description: 'Self-contained after the edits: read authored relation intent plus separately measured world observations for the gate/wall pair.',
    action: 'inspect',
    dependsOn: Object.freeze(['edit-node-set']),
    args: Object.freeze({ document: 'interaction-yard', kind: 'spatial', node: 'gate', other: 'wall' }),
  }),
  Object.freeze({
    id: 'render-delivery',
    description: 'Self-contained after the edits: render the delivery beauty preview from the persistent scene.camera; no observation overrides.',
    action: 'render',
    dependsOn: Object.freeze(['edit-node-set']),
    args: Object.freeze({ document: 'interaction-yard' }),
  }),
  Object.freeze({
    id: 'observe-three-quarter',
    description: 'Self-contained after the edits: render a transient non-delivery observation from a three-quarter orthographic camera; the stored camera and revision do not change.',
    action: 'render',
    dependsOn: Object.freeze(['edit-node-set']),
    args: Object.freeze({ document: 'interaction-yard', camera: Object.freeze({ preset: 'three_quarter' }) }),
  }),
  Object.freeze({
    id: 'normalmap-preview',
    description: 'Self-contained after the edits: preview the technical sprite-local normal map computed lightless from the current beauty render.',
    action: 'normalmap',
    dependsOn: Object.freeze(['edit-node-set']),
    args: Object.freeze({ document: 'interaction-yard', convention: 'opengl' }),
  }),
  Object.freeze({
    id: 'normalmap-export',
    description: 'Self-contained after the three edits at revision 3: export normal.png plus the same-source sprite.png and manifests into a convention-tagged generation.',
    action: 'normalmap',
    dependsOn: Object.freeze(['edit-node-set']),
    args: Object.freeze({ document: 'interaction-yard', revision: 3, convention: 'opengl', export: true }),
  }),
  Object.freeze({
    id: 'export-draft',
    description: 'Self-contained after the three edits at revision 3: export a draft transparent PNG and the editable Y-up scene; drafts preserve pending review state.',
    action: 'export',
    dependsOn: Object.freeze(['edit-node-set']),
    args: Object.freeze({ document: 'interaction-yard', revision: 3, draft: true }),
  }),
  Object.freeze({
    id: 'list-documents',
    description: 'Page the alphabetical catalog of existing user documents; it is not a set of examples and grants no permission to reuse them.',
    action: 'scene',
    args: Object.freeze({ action: 'list', limit: 5 }),
  }),
  Object.freeze({
    id: 'edit-existing-template',
    description: 'Template: bind an existing document, its observed revision and the target node id before executing; example values are schema-valid but are not a real asset.',
    action: 'scene',
    args: Object.freeze({
      action: 'edit',
      document: 'interaction-template-document',
      revision: 0,
      txid: 'interaction-template-edit',
      ops: Object.freeze([Object.freeze({ op: 'transform', id: 'interaction-template-node', translate: Object.freeze([1, 0, 0]) })]),
    }),
    bindings: Object.freeze([
      Object.freeze({ path: '/document', type: 'string', description: 'Existing document id.' }),
      Object.freeze({ path: '/revision', type: 'integer', description: 'Observed current revision.' }),
      Object.freeze({ path: '/ops/0/id', type: 'string', description: 'Existing node id to move.' }),
    ]),
  }),
  Object.freeze({
    id: 'theme-read-template',
    description: 'Template: bind an existing theme id and pinned revision before executing; read returns the working production pack, never a compliance pass.',
    action: 'theme',
    args: Object.freeze({ action: 'read', theme: 'interaction-template-theme', revision: 0, view: 'working' }),
    bindings: Object.freeze([
      Object.freeze({ path: '/theme', type: 'string', description: 'Existing theme id.' }),
      Object.freeze({ path: '/revision', type: 'integer', description: 'Pinned theme revision.' }),
    ]),
  }),
  Object.freeze({
    id: 'reviewed-export-template',
    description: 'Template: bind an existing document, its observed revision and an honest visual-review note; reviewed export also needs image-capable model input and the observation gate.',
    action: 'export',
    args: Object.freeze({
      document: 'interaction-template-document',
      revision: 0,
      draft: false,
      review: Object.freeze({ identity: true, nativeReadable: true, lighting: true, note: 'interaction-template honest visual judgment' }),
    }),
    bindings: Object.freeze([
      Object.freeze({ path: '/document', type: 'string', description: 'Existing document id.' }),
      Object.freeze({ path: '/revision', type: 'integer', description: 'Observed current revision.' }),
      Object.freeze({ path: '/review/note', type: 'string', description: 'Honest 3-360 character visual judgment.' }),
    ]),
  }),
]);

export function validateExampleDependencies(examples = EXAMPLES) {
  const ids = new Set(examples.map(example => example.id));
  const errors = [];
  const state = new Map();
  const order = [];
  const visit = (id, trail = []) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      errors.push({ code: 'DEPENDENCY_CYCLE', example: id, trail: [...trail, id] });
      return;
    }
    state.set(id, 'visiting');
    const example = examples.find(item => item.id === id);
    if (example?.dependsOn !== undefined && !Array.isArray(example.dependsOn)) {
      errors.push({ code: 'DEPENDENCY_TYPE', example: id });
    } else {
      for (const dependency of example?.dependsOn || []) {
        if (typeof dependency !== 'string' || !ids.has(dependency)) {
          errors.push({ code: 'DEPENDENCY_UNKNOWN', example: id, dependency });
          continue;
        }
        if (dependency === id) {
          errors.push({ code: 'DEPENDENCY_SELF', example: id });
          continue;
        }
        visit(dependency, [...trail, id]);
      }
    }
    state.set(id, 'done');
    order.push(id);
  };
  for (const example of examples) visit(example.id);
  return { ok: errors.length === 0, errors, order };
}

export function createInteraction() {
  return {
    version: INTERACTION_VERSION,
    workflow: WORKFLOW,
    aliases: { ...ALIASES },
    topics: TOPICS.map(topic => ({ ...topic, args: { ...topic.args } })),
    examples: EXAMPLES.map(example => ({
      ...example,
      args: JSON.parse(JSON.stringify(example.args)),
      ...(example.bindings ? { bindings: example.bindings.map(binding => ({ ...binding })) } : {}),
      ...(example.dependsOn ? { dependsOn: [...example.dependsOn] } : {}),
    })),
    dependencyValidation: validateExampleDependencies(EXAMPLES),
  };
}

export { ALIASES, TOPICS, EXAMPLES };
