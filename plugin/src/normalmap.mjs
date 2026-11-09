import { cameraBasis, dot } from './math.mjs';
import { renderScene } from './renderer.mjs';
import { validateScene, ZPixelError } from './scene.mjs';

/**
 * Same-source sprite-view normal-map export.
 *
 * The normal map is a sibling of a beauty render: it reuses the exact final
 * beauty hit buffer (including outline pixels and transparency) and never
 * re-traces, re-lights or re-shades the scene. Painted layers contribute their
 * plane normal only; their artwork is not unbaked into relief. Outside outline
 * pixels are neutral because they are image-space strokes, not geometry.
 */
const CONVENTIONS = Object.freeze(['opengl', 'directx']);
// Machine-readable statement of what the normal data is. The map is derived
// from visible geometry faces in the beauty hit buffer: there is no height
// field, no strength and no relief inference. These constants are surfaced in
// the service diagnostics so a caller can tell "flat by design" from "flat by
// a missing height input" without inspecting pixels.
export const NORMALMAP_SOURCE_MODE = 'geometry';
export const NORMALMAP_RELIEF = 'none';
const NEUTRAL_VIEW_NORMAL = Object.freeze([0, 0, 1]);
const NEUTRAL_RGBA = Object.freeze([128, 128, 255, 255]);
const TRANSPARENT_RGBA = Object.freeze([0, 0, 0, 0]);
const NORMALMAP_WARNINGS = Object.freeze([
  'Normal map: painted layer pixels use their planar plane normal oriented toward the current view; artwork color is not converted into 3D relief.',
  'Normal map: outside outline pixels are neutral view-facing [128,128,255]; they are not real surface geometry.',
  'Normal map: RGB channels are linear vector data, not color; import as data with sRGB conversion disabled.',
]);

function fail(code, message, details = {}) {
  throw new ZPixelError(code, message, details);
}

function isFiniteVector(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round((Math.max(-1, Math.min(1, value)) * 0.5 + 0.5) * 255)));
}

function colorHex(bytes) {
  return `#${bytes[0].toString(16).padStart(2, '0')}${bytes[1].toString(16).padStart(2, '0')}${bytes[2].toString(16).padStart(2, '0')}`;
}

/**
 * Project a world-space unit normal into the sprite-view basis used by the
 * existing camera. OpenGL-style green points up in the image; DirectX-style
 * green points down. The renderer already inverse-transposed solid normals,
 * so this function performs projection only.
 */
function viewSpaceNormal(worldNormal, camera, convention) {
  if (!isFiniteVector(worldNormal)) return null;
  const down = dot(worldNormal, camera.down);
  const view = [
    dot(worldNormal, camera.right),
    convention === 'opengl' ? -down : down,
    -dot(worldNormal, camera.direction),
  ];
  const length = Math.hypot(...view);
  if (!(length > 1e-12)) return null;
  // Collapse -0 so returned hit normals serialize predictably.
  return view.map(value => {
    const unit = value / length;
    return unit === 0 ? 0 : unit;
  });
}

function encodeViewNormal(viewNormal) {
  return [
    clampByte(viewNormal[0]),
    clampByte(viewNormal[1]),
    clampByte(viewNormal[2]),
  ];
}

function validateProvidedBeauty(scene, beauty) {
  if (beauty === null || typeof beauty !== 'object' || Array.isArray(beauty)) {
    fail('NORMAL_BEAUTY', 'beauty must be an image object returned by renderScene.', {});
  }
  const { width, height } = beauty;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    fail('NORMAL_BEAUTY', 'beauty.width and beauty.height must be positive integers.', { width, height });
  }
  if (width !== scene.width || height !== scene.height) {
    fail('NORMAL_BEAUTY', `beauty is ${width}x${height} but scene is ${scene.width}x${scene.height}; pass the matching beauty render.`, {
      width,
      height,
      sceneWidth: scene.width,
      sceneHeight: scene.height,
    });
  }
  const pixelCount = width * height;
  const rgba = beauty.rgba;
  if ((!Array.isArray(rgba) && !ArrayBuffer.isView(rgba)) || rgba.length !== pixelCount * 4) {
    fail('NORMAL_BEAUTY', 'beauty.rgba must be a byte array with exactly width*height*4 entries.', {
      expected: pixelCount * 4,
      actual: rgba?.length,
    });
  }
  if (!Array.isArray(beauty.hits) || beauty.hits.length !== pixelCount) {
    fail('NORMAL_BEAUTY', 'beauty.hits must be an array with exactly width*height entries.', {
      expected: pixelCount,
      actual: beauty.hits?.length,
    });
  }
  if (beauty.stats?.mode !== 'beauty') {
    fail('NORMAL_BEAUTY', 'beauty must be a renderScene beauty image; a diagnostic render has different hit and outline semantics.', {
      expectedMode: 'beauty',
      actualMode: beauty.stats?.mode,
    });
  }
  return beauty;
}

/**
 * Render the sprite-view normal map for a saved scene camera.
 *
 * @param {object} scene Validated dsh-zpixel/2 scene.
 * @param {{convention?: 'opengl'|'directx', beauty?: object}} [options]
 *   convention selects the green-channel direction. When beauty is omitted,
 *   renderScene(scene,{mode:'beauty'}) is called exactly once and shared.
 * @returns {object} normal-map image shape (width/height/rgba/hits/colorsUsed/
 *   stats/warnings) plus normalMap metadata and the effective beauty image.
 */
export function renderNormalmap(scene, { convention = 'opengl', beauty: beautyInput } = {}) {
  if (!CONVENTIONS.includes(convention)) {
    fail('NORMAL_CONVENTION', `Unsupported normal-map convention ${String(convention)}. Use "opengl" or "directx".`, {
      convention,
      conventionLabel: String(convention),
      supported: [...CONVENTIONS],
    });
  }
  if (!scene || typeof scene !== 'object') fail('INVALID_DATA', 'Scene must be an object.', {});

  let beauty;
  if (beautyInput === undefined || beautyInput === null) {
    // The hit buffer and its alpha channel are the source of truth; one beauty
    // render is shared by the returned normal map and the caller's export.
    beauty = renderScene(scene, { mode: 'beauty' });
  } else {
    validateScene(scene);
    beauty = validateProvidedBeauty(scene, beautyInput);
  }

  const camera = cameraBasis(scene);
  const nodes = new Map(scene.nodes.map(node => [node.id, node]));
  const width = scene.width;
  const height = scene.height;
  const pixelCount = width * height;
  const rgba = new Uint8Array(pixelCount * 4);
  const hits = Array(pixelCount).fill(null);
  const colors = new Set();

  let surfacePixels = 0;
  let layerPixels = 0;
  let outsideOutlinePixels = 0;
  let insideOutlinePixels = 0;
  let neutralFallbackPixels = 0;
  let transparentPixels = 0;

  for (let index = 0; index < pixelCount; index++) {
    const source = beauty.hits[index];
    if (!source) {
      transparentPixels++;
      continue;
    }

    const offset = index * 4;
    const alpha = beauty.rgba[offset + 3];
    const node = nodes.get(source.nodeId);
    const outlineOutside = source.outlineReason === 'outside';
    let sourceKind;
    let viewNormal = null;

    if (outlineOutside) {
      sourceKind = 'outside-outline';
      outsideOutlinePixels++;
      viewNormal = [...NEUTRAL_VIEW_NORMAL];
    } else if (!isFiniteVector(source.normal)) {
      sourceKind = 'neutral-fallback';
      neutralFallbackPixels++;
      viewNormal = [...NEUTRAL_VIEW_NORMAL];
    } else {
      let worldNormal = source.normal;
      if (node?.kind === 'layer') {
        // A painted layer is a two-sided plane. Its hit normal is the world
        // plane normal (already inverse-transposed by the renderer). Orient it
        // toward the current view instead of inventing relief from pixels.
        sourceKind = 'layer';
        layerPixels++;
        if (dot(worldNormal, camera.direction) > 0) worldNormal = worldNormal.map(value => -value);
      } else {
        sourceKind = 'surface';
        surfacePixels++;
      }
      if (source.outlineReason === 'inside') insideOutlinePixels++;
      viewNormal = viewSpaceNormal(worldNormal, camera, convention);
      if (!viewNormal) {
        sourceKind = 'neutral-fallback';
        neutralFallbackPixels++;
        viewNormal = [...NEUTRAL_VIEW_NORMAL];
      }
    }

    const bytes = [...encodeViewNormal(viewNormal), alpha];
    rgba.set(bytes, offset);
    colors.add(colorHex(bytes));

    const normalHit = {
      nodeId: source.nodeId ?? null,
      normal: [...viewNormal],
      source: sourceKind,
    };
    if (source.outlineReason === 'inside' || source.outlineReason === 'outside') {
      normalHit.outlineReason = source.outlineReason;
    }
    hits[index] = normalHit;
  }

  const sourceStats = beauty.stats && typeof beauty.stats === 'object' ? beauty.stats : {};
  const visiblePixels = pixelCount - transparentPixels;
  const neutralPixels = outsideOutlinePixels + neutralFallbackPixels;
  const stats = {
    ...sourceStats,
    mode: 'normalmap',
    sourceMode: 'beauty',
    width,
    height,
    pixelCount,
    visiblePixels,
    transparentPixels,
    surfacePixels,
    layerPixels,
    outsideOutlinePixels,
    insideOutlinePixels,
    neutralPixels,
  };

  const normalMap = {
    convention,
    space: 'sprite-view',
    axes: {
      x: 'right',
      y: convention === 'opengl' ? 'up' : 'down',
      z: 'toward-viewer',
    },
    encoding: 'rgba8-linear; rgb=round(clamp(n*0.5+0.5)*255)',
    alpha: 'beauty-matched',
    layers: 'view-facing-plane',
    outlines: 'outside-neutral',
    neutral: [...NEUTRAL_RGBA.slice(0, 3)],
    transparent: [...TRANSPARENT_RGBA],
    source: 'beauty-hit-buffer',
    fallbackCounts: {
      paintedLayerPixels: layerPixels,
      outsideOutlinePixels,
      insideOutlinePixels,
      degenerateNormalPixels: neutralFallbackPixels,
      neutralPixels,
      transparentPixels,
    },
  };

  return {
    width,
    height,
    rgba,
    hits,
    colorsUsed: [...colors],
    stats,
    warnings: [...(Array.isArray(beauty.warnings) ? beauty.warnings : []), ...NORMALMAP_WARNINGS],
    normalMap,
    beauty,
  };
}

export default { renderNormalmap };
