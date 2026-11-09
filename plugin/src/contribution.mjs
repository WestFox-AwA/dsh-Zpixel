/**
 * Derived delivery facts for one rendered revision.
 *
 * This module never re-traces, re-shades, re-orders or re-validates anything:
 * it reads the renderer's final hit buffer and the scene nodes, and reports
 * pixel counts. Counts are facts about this revision and camera, not a score.
 * Bound appearance layers are reported separately; pixelsByKind and
 * representation stay physical-hit-owner facts.
 */

const CONTENT_KINDS = new Set(['part', 'layer']);

function fail(message) {
  const error = new Error(message);
  error.code = 'CONTRIBUTION_INPUT';
  throw error;
}

function paintedPixels(node) {
  if (!Array.isArray(node.pixels)) return 0;
  let painted = 0;
  for (const value of node.pixels) if (value !== null) painted++;
  return painted;
}

/**
 * Summarize what the current render actually delivered.
 *
 * @param {object} scene validated dsh-zpixel/2 scene for the rendered revision
 * @param {object} image renderScene result (width, height, hits, stats)
 * @returns {object} bounded, additive contribution facts
 */
export function contributionReport(scene, image) {
  if (!scene || !Array.isArray(scene.nodes)) fail('contributionReport needs a scene with nodes.');
  if (!image || !Array.isArray(image.hits)) fail('contributionReport needs a render result with hits.');

  const width = image.width ?? scene.width;
  const height = image.height ?? scene.height;
  const mode = image.stats?.mode ?? 'beauty';

  const visibleByNode = new Map();
  const visibleByAppearance = new Map();
  let visiblePixels = 0;
  let outlinePixels = 0;
  let appearancePixels = 0;
  for (const hit of image.hits) {
    if (!hit) continue;
    visiblePixels++;
    if (hit.outlineReason) outlinePixels++;
    const id = hit.nodeId;
    if (typeof id === 'string') visibleByNode.set(id, (visibleByNode.get(id) ?? 0) + 1);
    // Outline pixels clear appearance provenance in the renderer; keep this
    // guard here so a malformed hit cannot inflate the appearance totals.
    if (!hit.outlineReason && typeof hit.appearanceNodeId === 'string') {
      appearancePixels++;
      visibleByAppearance.set(hit.appearanceNodeId, (visibleByAppearance.get(hit.appearanceNodeId) ?? 0) + 1);
    }
  }

  const nodes = [];
  const appearances = [];
  const zeroVisible = { parts: [], layers: [] };
  const pixelsByKind = { part: 0, layer: 0 };
  const layerPixels = { total: 0, painted: 0, visible: 0 };

  for (const node of scene.nodes) {
    if (!CONTENT_KINDS.has(node.kind)) continue;
    // A bound appearance layer is not a physical layer. Its pixels belong to
    // the owner part's hit and are reported in appearances instead of being
    // mislabeled as a zero-visible physical layer.
    if (node.kind === 'layer' && node.appearanceOf !== undefined && node.appearanceOf !== null) {
      const total = Number.isInteger(node.width) && Number.isInteger(node.height)
        ? node.width * node.height
        : 0;
      appearances.push({
        id: node.id,
        appearanceOf: node.appearanceOf,
        appearanceShading: node.appearanceShading ?? 'lit',
        paintedPixels: paintedPixels(node),
        totalPixels: total,
        visiblePixels: visibleByAppearance.get(node.id) ?? 0,
      });
      continue;
    }
    const visible = visibleByNode.get(node.id) ?? 0;
    if (node.kind === 'part') {
      pixelsByKind.part += visible;
      if (visible === 0) zeroVisible.parts.push(node.id);
      else nodes.push({ id: node.id, name: node.name, kind: 'part', visiblePixels: visible });
      continue;
    }
    const total = Number.isInteger(node.width) && Number.isInteger(node.height)
      ? node.width * node.height
      : 0;
    const painted = paintedPixels(node);
    layerPixels.total += total;
    layerPixels.painted += painted;
    layerPixels.visible += visible;
    pixelsByKind.layer += visible;
    if (visible === 0) zeroVisible.layers.push(node.id);
    else nodes.push({ id: node.id, name: node.name, kind: 'layer', visiblePixels: visible, totalPixels: total, paintedPixels: painted });
  }

  nodes.sort((a, b) => b.visiblePixels - a.visiblePixels || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  appearances.sort((a, b) => b.visiblePixels - a.visiblePixels || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const representation = visiblePixels === 0
    ? 'empty'
    : pixelsByKind.layer === 0
      ? 'geometry'
      : pixelsByKind.part === 0
        ? 'appearance'
        : 'mixed';

  return {
    revision: scene.revision,
    mode,
    width,
    height,
    visiblePixels,
    transparentPixels: width * height - visiblePixels,
    outlinePixels,
    appearancePixels,
    representation,
    pixelsByKind,
    layerPixels,
    nodes,
    appearances,
    zeroVisible,
    note: 'Derived from this revision\'s render hit buffer and scene nodes; pixel counts are facts, not a quality score. representation and pixelsByKind describe physical hit owners; bound appearance layers are listed separately in appearances. Lit appearance pixels may use shaded colors outside the authored palette.',
  };
}
