/** Pure theme compilation, working-read packs and final-beauty reports. No store or I/O access. */
import { validateTheme, validateThemeContext, validateThemeBinding, themeHash, THEME_LANGUAGE_SECTIONS } from './theme-model.mjs';
import { cameraBasis, normalize, sub, dot } from './math.mjs';

const LANGUAGE_SECTIONS = THEME_LANGUAGE_SECTIONS;
const VIEW_PRESETS = Object.freeze(['top_down', 'three_quarter']);
const CAMERA_ANGLE = 55 * Math.PI / 180;
const MAX_RESOURCE_ID = 128;
const MAX_LIGHTS = 8;
const MAX_DICTIONARY = 256;
const MAX_CANVAS = 256;
const HEX = /^#[0-9a-f]{6}$/i;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const MECHANICAL_KINDS = new Set(['palette', 'color_count', 'binary_alpha', 'padding', 'canvas', 'outline', 'camera', 'light_count', 'appearance_shading']);
const READ_SECTIONS = new Set([...LANGUAGE_SECTIONS, 'references', 'source', 'tokens', 'bindings', 'rules', 'checklist', 'capabilities', 'adaptations', 'definition']);

export class ThemeRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ThemeRuntimeError';
    this.code = code;
    this.details = details;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPlainObject = value => isObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const isVec3 = value => Array.isArray(value) && value.length === 3 && value.every(item => typeof item === 'number' && Number.isFinite(item));
function assert(condition, code, message, details = {}) {
  if (!condition) throw new ThemeRuntimeError(code, message, details);
}
function clone(value) {
  try { return structuredClone(value); }
  catch { throw new ThemeRuntimeError('INVALID_DATA', 'Theme data must be cloneable.', {}); }
}
function addSupported(capabilities, seen, path, feature) {
  const key = path + '\u0000' + feature;
  if (seen.supported.has(key)) return;
  seen.supported.add(key);
  capabilities.supported.push({ path, feature });
}
function addWarning(capabilities, seen, path, feature, reason) {
  const key = path + '\u0000' + feature;
  if (seen.warnings.has(key)) return;
  seen.warnings.add(key);
  capabilities.warnings.push({ path, feature, reason });
}
function addMissing(capabilities, seen, path, feature, reason) {
  const key = path + '\u0000' + feature;
  if (seen.missing.has(key)) return;
  seen.missing.add(key);
  capabilities.missing.push({ path, feature, reason });
}
function addUnsupported(capabilities, seen, path, feature, reason, required = true) {
  const key = path + '\u0000' + feature;
  if (seen.unsupported.has(key)) return;
  seen.unsupported.add(key);
  capabilities.unsupported.push({ path, feature, reason, required });
}
function resourceId(prefix, key, path, capabilities, seen, label) {
  if (typeof key !== 'string' || key.length === 0) {
    addUnsupported(capabilities, seen, path, label + ' id', label + ' id must be a nonempty string; the resource is omitted.');
    return null;
  }
  const id = prefix + key;
  if (id.length > MAX_RESOURCE_ID || !RESOURCE_ID.test(id)) {
    addUnsupported(capabilities, seen, path, label + ' id',
      'Namespaced ' + label + ' id "' + id + '" is not a valid scene resource id of at most ' + MAX_RESOURCE_ID + ' characters; the resource is omitted.');
    return null;
  }
  return id;
}
function canonicalCamera(view) {
  const preset = VIEW_PRESETS.includes(view) ? view : 'top_down';
  const target = [0, 0, 0];
  const offset = preset === 'top_down' ? [0, 100, 0] : [0, 100 * Math.sin(CAMERA_ANGLE), 100 * Math.cos(CAMERA_ANGLE)];
  return {
    position: target.map((value, index) => value + offset[index]),
    target,
    up: preset === 'top_down' ? [0, 0, -1] : [0, 1, 0],
    mirrorX: false,
    pixelsPerUnit: 1,
    center: [0, 0],
  };
}
function safeCameraBasis(camera) {
  if (!isPlainObject(camera) || !isVec3(camera.position) || !isVec3(camera.target) || !isVec3(camera.up)) return null;
  try { return cameraBasis({ camera }); }
  catch { return null; }
}
function viewToWorld(direction, basis) {
  const [x, y, z] = direction;
  return normalize([
    basis.right[0] * x - basis.down[0] * y - basis.direction[0] * z,
    basis.right[1] * x - basis.down[1] * y - basis.direction[1] * z,
    basis.right[2] * x - basis.down[2] * y - basis.direction[2] * z,
  ]);
}
function normalizeCompileOptions(options) {
  assert(isPlainObject(options), 'INVALID_OPTIONS', 'compileTheme options must be a plain object.');
  for (const key of Object.keys(options)) assert(key === 'camera', 'INVALID_OPTIONS', 'Unknown compileTheme option "' + key + '".', { key });
  return options;
}

/**
 * Resolve theme tokens into namespaced scene resources.
 * options.camera is an optional actual normalized scene camera. When supplied it is
 * authoritative for view-frame directional lights; otherwise the named context view,
 * the theme camera preset, or the disclosed top_down fallback is used.
 */
export function compileTheme(theme, context = {}, options = {}) {
  const canonical = validateTheme(theme);
  const ctx = validateThemeContext(context ?? {});
  const opts = normalizeCompileOptions(options ?? {});
  const capabilities = { supported: [], warnings: [], unsupported: [], missing: [] };
  const seen = { supported: new Set(), warnings: new Set(), unsupported: new Set(), missing: new Set() };
  const tokens = canonical.tokens ?? {};
  const prefix = 'theme.' + canonical.id + '.';
  const namespace = {
    themeId: canonical.id,
    prefix,
    palette: {},
    ramps: {},
    materials: {},
    lights: {},
    lightFrame: { view: null, source: 'none', converted: 0, assumed: false },
  };
  const defaults = { palette: {}, ramps: {}, materials: {} };

  const colorEntries = Object.entries(tokens.colors ?? {});
  if (colorEntries.length > MAX_DICTIONARY) addUnsupported(capabilities, seen, 'tokens.colors', 'palette size',
    'A scene palette supports at most ' + MAX_DICTIONARY + ' colors; colors beyond that limit are omitted.');
  for (const [key, color] of colorEntries.slice(0, MAX_DICTIONARY)) {
    const path = 'tokens.colors.' + key;
    const id = resourceId(prefix, key, path, capabilities, seen, 'palette color');
    if (!id) continue;
    if (!isObject(color) || typeof color.value !== 'string' || !HEX.test(color.value)) {
      addUnsupported(capabilities, seen, path + '.value', 'palette color',
        'Color token "' + key + '" must be an opaque #RRGGBB value; the color is omitted.');
      continue;
    }
    defaults.palette[id] = color.value.toLowerCase();
    namespace.palette[key] = id;
  }
  if (Object.keys(namespace.palette).length) addSupported(capabilities, seen, 'tokens.colors', 'named palette colors');

  const rampEntries = Object.entries(tokens.ramps ?? {});
  if (rampEntries.length > MAX_DICTIONARY) addUnsupported(capabilities, seen, 'tokens.ramps', 'ramp count',
    'A scene supports at most ' + MAX_DICTIONARY + ' ramps; ramps beyond that limit are omitted.');
  for (const [key, ramp] of rampEntries.slice(0, MAX_DICTIONARY)) {
    const path = 'tokens.ramps.' + key;
    const id = resourceId(prefix, key, path, capabilities, seen, 'ramp');
    if (!id) continue;
    const response = ramp?.response ?? 1;
    if (typeof response !== 'number' || !Number.isFinite(response) || response < 1e-4 || response > 16) {
      addUnsupported(capabilities, seen, path + '.response', 'ramp response',
        'Ramp "' + key + '" response must be between 0.0001 and 16; the ramp is omitted.');
      continue;
    }
    const stops = Array.isArray(ramp?.stops) ? ramp.stops : null;
    if (!stops || stops.length < 1 || stops.length > MAX_DICTIONARY) {
      addUnsupported(capabilities, seen, path + '.stops', 'ramp stops',
        'Ramp "' + key + '" must contain 1-' + MAX_DICTIONARY + ' stops; the ramp is omitted.');
      continue;
    }
    const compiledStops = [];
    let invalid = false;
    for (let index = 0; index < stops.length; index++) {
      const stop = stops[index];
      const stopPath = path + '.stops[' + index + ']';
      if (!isObject(stop) || typeof stop.at !== 'number' || !Number.isFinite(stop.at) || stop.at < 0 || stop.at > 64) {
        addUnsupported(capabilities, seen, stopPath + '.at', 'ramp stop position',
          'Ramp "' + key + '" stop positions must be between 0 and 64; the ramp is omitted.');
        invalid = true;
        break;
      }
      if (index > 0 && stop.at <= stops[index - 1].at) {
        addUnsupported(capabilities, seen, stopPath + '.at', 'ramp stop ordering',
          'Ramp "' + key + '" stops must be strictly ordered; the ramp is omitted.');
        invalid = true;
        break;
      }
      const colorId = namespace.palette[stop.color];
      if (!colorId) {
        addUnsupported(capabilities, seen, stopPath + '.color', 'ramp color reference',
          'Ramp "' + key + '" references color token "' + String(stop.color) + '" that is missing or not engine-compatible; the ramp is omitted.');
        invalid = true;
        break;
      }
      compiledStops.push({ at: stop.at, color: colorId });
    }
    if (invalid) continue;
    defaults.ramps[id] = { response, stops: compiledStops };
    namespace.ramps[key] = id;
  }
  if (Object.keys(namespace.ramps).length) addSupported(capabilities, seen, 'tokens.ramps', 'material ramps');

  const materialEntries = Object.entries(tokens.materials ?? {});
  if (materialEntries.length > MAX_DICTIONARY) addUnsupported(capabilities, seen, 'tokens.materials', 'material count',
    'A scene supports at most ' + MAX_DICTIONARY + ' materials; materials beyond that limit are omitted.');
  for (const [key, material] of materialEntries.slice(0, MAX_DICTIONARY)) {
    const path = 'tokens.materials.' + key;
    const id = resourceId(prefix, key, path, capabilities, seen, 'material');
    if (!id) continue;
    const rampId = namespace.ramps[material?.ramp];
    if (!rampId) {
      addUnsupported(capabilities, seen, path + '.ramp', 'material ramp reference',
        'Material "' + key + '" references ramp token "' + String(material?.ramp) + '" that is missing or not engine-compatible; the material is omitted.');
      continue;
    }
    let diffuse = material.diffuse ?? 1;
    if (typeof diffuse !== 'number' || !Number.isFinite(diffuse) || diffuse < 0 || diffuse > 16) {
      addUnsupported(capabilities, seen, path + '.diffuse', 'material diffuse',
        'Material "' + key + '" diffuse must be between 0 and 16; the material uses 1.');
      diffuse = 1;
    }
    let emission = material.emission ?? 0;
    if (typeof emission !== 'number' || !Number.isFinite(emission) || emission < 0 || emission > 16) {
      addUnsupported(capabilities, seen, path + '.emission', 'material emission',
        'Material "' + key + '" emission must be between 0 and 16; the material uses 0.');
      emission = 0;
    }
    let specular = material.specular ?? 0;
    if (specular !== 0) {
      addUnsupported(capabilities, seen, path + '.specular', 'specular highlights',
        'Material "' + key + '" requests specular ' + String(specular) + '; only specular 0 is supported, so the compiled material uses 0.');
      specular = 0;
    }
    let roughness = material.roughness ?? 0.5;
    if (typeof roughness !== 'number' || !Number.isFinite(roughness) || roughness < 0 || roughness > 1) {
      addUnsupported(capabilities, seen, path + '.roughness', 'material roughness',
        'Material "' + key + '" roughness must be between 0 and 1; the material uses 0.5.');
      roughness = 0.5;
    }
    defaults.materials[id] = { ramp: rampId, diffuse, emission, specular, roughness };
    namespace.materials[key] = id;
  }
  if (Object.keys(namespace.materials).length) addSupported(capabilities, seen, 'tokens.materials', 'material appearance');

  const outline = tokens.outline;
  if (outline !== undefined) {
    if (!isObject(outline)) {
      addUnsupported(capabilities, seen, 'tokens.outline', 'outline configuration', 'Outline tokens must be an object; the outline defaults are omitted.');
    } else {
      const compiled = {};
      if (outline.enabled !== undefined) compiled.enabled = outline.enabled;
      if (outline.direction !== undefined) compiled.direction = outline.direction;
      if (outline.color !== undefined) {
        const colorId = namespace.palette[outline.color];
        if (!colorId) addUnsupported(capabilities, seen, 'tokens.outline.color', 'outline color reference',
          'Outline color token "' + String(outline.color) + '" is missing or not engine-compatible; the outline color is omitted.');
        else compiled.color = colorId;
      }
      if (outline.width !== undefined) {
        if (outline.width !== 1) addUnsupported(capabilities, seen, 'tokens.outline.width', 'outline width',
          'Only a 1px outline width is supported; requested width ' + String(outline.width) + ' is omitted.');
        else compiled.width = 1;
      }
      if (Object.keys(compiled).length) {
        defaults.outline = compiled;
        addSupported(capabilities, seen, 'tokens.outline', '1px inside/outside outline');
      }
    }
  }

  if (tokens.defaultMaterial !== undefined) {
    const materialId = namespace.materials[tokens.defaultMaterial];
    if (!materialId) addUnsupported(capabilities, seen, 'tokens.defaultMaterial', 'default material binding',
      'Default material token "' + String(tokens.defaultMaterial) + '" is missing or not engine-compatible; the binding is omitted.');
    else {
      defaults.defaultMaterial = materialId;
      addSupported(capabilities, seen, 'tokens.defaultMaterial', 'default material binding');
    }
  }

  const lightTokens = Array.isArray(tokens.lights) ? tokens.lights : [];
  const wantsViewLights = lightTokens.some(light => isObject(light) && light.type === 'directional' && light.frame === 'view');
  const actualBasis = wantsViewLights ? safeCameraBasis(opts.camera) : null;
  let lightView = null;
  let lightSource = 'none';
  let lightBasis = null;
  if (wantsViewLights) {
    if (actualBasis) {
      lightBasis = actualBasis;
      lightSource = 'camera';
      lightView = cameraPreset(opts.camera);
    } else {
      if (opts.camera !== undefined && opts.camera !== null) {
        addWarning(capabilities, seen, 'options.camera', 'actual scene camera',
          'The supplied options.camera is not a valid normalized scene camera; view-frame light conversion fell back to the named view.');
        addMissing(capabilities, seen, 'options.camera', 'actual scene camera',
          'The supplied options.camera could not be used; view-frame light conversion used a named or default camera instead.');
      }
      if (ctx.view) {
        lightView = ctx.view;
        lightSource = 'context';
      } else if (tokens.camera?.preset) {
        lightView = tokens.camera.preset;
        lightSource = 'theme';
      } else {
        lightView = 'top_down';
        lightSource = 'default';
        addWarning(capabilities, seen, 'tokens.lights', 'view-frame light conversion',
          'No actual camera, context.view, or theme camera preset was provided; view-frame light directions assume the top_down camera.');
        addMissing(capabilities, seen, 'options.camera', 'actual scene camera',
          'No actual scene camera was supplied; view-frame light conversion assumed the top_down camera.');
      }
      lightBasis = cameraBasis(canonicalCamera(lightView));
      if (lightSource !== 'default') addMissing(capabilities, seen, 'options.camera', 'actual scene camera',
        'The actual scene camera was not supplied; view-frame light conversion used the canonical ' + lightView + ' camera.');
    }
  }

  const compiledLights = [];
  let convertedViewLights = 0;
  if (lightTokens.length > MAX_LIGHTS) addUnsupported(capabilities, seen, 'tokens.lights', 'light count',
    'A scene supports at most ' + MAX_LIGHTS + ' lights; lights beyond that limit are omitted.');
  for (let index = 0; index < Math.min(lightTokens.length, MAX_LIGHTS); index++) {
    const light = lightTokens[index];
    const path = 'tokens.lights[' + index + ']';
    if (!isObject(light)) {
      addUnsupported(capabilities, seen, path, 'light definition', 'Light entries must be objects; the light is omitted.');
      continue;
    }
    const id = resourceId(prefix, light.id, path + '.id', capabilities, seen, 'light');
    if (!id) continue;
    if (light.type !== 'point' && light.type !== 'directional') {
      addUnsupported(capabilities, seen, path + '.type', 'light type', 'Light type must be point or directional; the light is omitted.');
      continue;
    }
    const frame = light.frame ?? 'world';
    if (frame !== 'world' && frame !== 'view') {
      addUnsupported(capabilities, seen, path + '.frame', 'light frame', 'Light frame must be world or view; the light is omitted.');
      continue;
    }
    if (light.type === 'point' && frame === 'view') {
      addUnsupported(capabilities, seen, path + '.frame', 'view-framed point light',
        'Point light positions are world-space only in v1; the light is omitted.');
      continue;
    }
    // Unspecified light fields stay absent so the scene's own light defaults apply.
    const compiled = { id, type: light.type };
    if (light.type === 'point') {
      if (light.position !== undefined) {
        if (isVec3(light.position)) compiled.position = [...light.position];
        else addUnsupported(capabilities, seen, path + '.position', 'point light position',
          'Point light position must be a finite world-space 3-vector; the scene default position applies.');
      }
      if (light.direction !== undefined) {
        if (isVec3(light.direction)) compiled.direction = [...light.direction];
        else addUnsupported(capabilities, seen, path + '.direction', 'point light direction',
          'Point light direction must be a finite 3-vector; the scene default direction applies.');
      }
    } else {
      if (light.direction !== undefined) {
        if (!isVec3(light.direction) || Math.hypot(...light.direction) <= 1e-8) {
          addUnsupported(capabilities, seen, path + '.direction', 'directional light direction',
            'Directional light direction must be a nonzero finite 3-vector; the scene default direction applies.');
        } else {
          compiled.direction = frame === 'view'
            ? viewToWorld(light.direction, lightBasis ?? cameraBasis(canonicalCamera('top_down')))
            : normalize(light.direction);
          if (frame === 'view') convertedViewLights++;
        }
      } else if (frame === 'view') {
        addWarning(capabilities, seen, path + '.direction', 'view-frame light direction',
          'A view-frame directional light without direction cannot be converted; the scene default direction applies.');
        addMissing(capabilities, seen, path + '.direction', 'view-frame light direction',
          'The view-frame direction is missing; the scene default direction applies.');
      }
      if (light.position !== undefined) {
        if (isVec3(light.position)) compiled.position = [...light.position];
        else addUnsupported(capabilities, seen, path + '.position', 'directional light position',
          'Directional light position must be a finite 3-vector; the scene default position applies.');
      }
    }
    if (light.intensity !== undefined) {
      if (typeof light.intensity === 'number' && Number.isFinite(light.intensity) && light.intensity >= 0 && light.intensity <= 64) {
        compiled.intensity = light.intensity;
      } else addUnsupported(capabilities, seen, path + '.intensity', 'light intensity',
        'Scene light intensity must be between 0 and 64; the scene default intensity applies.');
    }
    if (light.range !== undefined) {
      if (typeof light.range === 'number' && Number.isFinite(light.range) && light.range >= 0 && light.range <= 1e6) {
        compiled.range = light.range;
      } else addUnsupported(capabilities, seen, path + '.range', 'light range',
        'Scene light range must be between 0 and 1000000; the scene default range applies.');
    }
    if (light.color !== undefined) {
      if (typeof light.color !== 'string' || !HEX.test(light.color)) {
        addUnsupported(capabilities, seen, path + '.color', 'light color',
          'Light color must be an opaque #RRGGBB value; the scene default #ffffff applies.');
      } else if (light.color.toLowerCase() !== '#ffffff') {
        addUnsupported(capabilities, seen, path + '.color', 'colored light',
          'Only white light colors are supported; the compiled light uses the scene default #ffffff.');
      } else compiled.color = '#ffffff';
    }
    compiledLights.push(compiled);
    namespace.lights[light.id] = id;
  }
  if (Array.isArray(tokens.lights)) {
    if (tokens.lights.length === 0) {
      defaults.lights = [];
      addSupported(capabilities, seen, 'tokens.lights', 'explicit no lights');
    } else if (compiledLights.length) {
      defaults.lights = compiledLights;
      addSupported(capabilities, seen, 'tokens.lights', 'white point and directional lights');
    }
  }
  if (convertedViewLights > 0) addSupported(capabilities, seen, 'tokens.lights', 'view-frame directional lights converted to world');
  if (lightSource === 'camera') addSupported(capabilities, seen, 'options.camera', 'actual scene camera');
  namespace.lightFrame = {
    view: lightView ?? ctx.view ?? tokens.camera?.preset ?? null,
    source: lightSource,
    converted: convertedViewLights,
    assumed: lightSource === 'default',
  };

  if (tokens.ambient !== undefined) {
    if (typeof tokens.ambient === 'number' && Number.isFinite(tokens.ambient) && tokens.ambient >= 0 && tokens.ambient <= 1) {
      defaults.ambient = tokens.ambient;
      addSupported(capabilities, seen, 'tokens.ambient', 'ambient level');
    } else addUnsupported(capabilities, seen, 'tokens.ambient', 'ambient level',
      'Scene ambient must be between 0 and 1; the value is omitted.');
  }
  if (tokens.exposure !== undefined) {
    if (typeof tokens.exposure === 'number' && Number.isFinite(tokens.exposure) && tokens.exposure >= 0 && tokens.exposure <= 16) {
      defaults.exposure = tokens.exposure;
      addSupported(capabilities, seen, 'tokens.exposure', 'exposure');
    } else addUnsupported(capabilities, seen, 'tokens.exposure', 'exposure',
      'Scene exposure must be between 0 and 16; the value is omitted.');
  }
  if (tokens.camera !== undefined) {
    if (!isObject(tokens.camera)) {
      addUnsupported(capabilities, seen, 'tokens.camera', 'camera preset', 'Camera tokens must be an object; the camera default is omitted.');
    } else {
      const compiled = {};
      if (typeof tokens.camera.preset === 'string' && VIEW_PRESETS.includes(tokens.camera.preset)) compiled.preset = tokens.camera.preset;
      else addUnsupported(capabilities, seen, 'tokens.camera.preset', 'camera preset',
        'Camera preset must be top_down or three_quarter; the camera default is omitted.');
      if (tokens.camera.pixelsPerUnit !== undefined) {
        if (typeof tokens.camera.pixelsPerUnit === 'number' && Number.isFinite(tokens.camera.pixelsPerUnit) &&
          tokens.camera.pixelsPerUnit >= 1e-4 && tokens.camera.pixelsPerUnit <= 1e4) compiled.pixelsPerUnit = tokens.camera.pixelsPerUnit;
        else addUnsupported(capabilities, seen, 'tokens.camera.pixelsPerUnit', 'camera scale',
          'Scene camera pixelsPerUnit must be between 0.0001 and 10000; the value is omitted.');
      }
      if (Object.keys(compiled).length) {
        defaults.camera = compiled;
        addSupported(capabilities, seen, 'tokens.camera', 'camera preset');
      }
    }
  }
  if (tokens.appearanceShading !== undefined) {
    if (tokens.appearanceShading === 'lit' || tokens.appearanceShading === 'unlit') {
      defaults.appearanceShading = tokens.appearanceShading;
      addSupported(capabilities, seen, 'tokens.appearanceShading', 'appearance shading');
    } else addUnsupported(capabilities, seen, 'tokens.appearanceShading', 'appearance shading',
      'appearanceShading must be lit or unlit; the value is omitted.');
  }
  const hasPaletteRule = (canonical.rules ?? []).some(rule => rule?.check?.kind === 'palette');
  if (hasPaletteRule && (defaults.appearanceShading ?? 'lit') === 'lit') {
    addWarning(capabilities, seen, 'tokens.appearanceShading', 'lit appearance color drift',
      'Lit appearance multiplies continuous light and can produce colors outside the palette; the final RGBA check decides. Use ramps plus unlit appearance for a strict closed palette.');
  }

  return { defaults, capabilities, namespace };
}

function scopeApplicability(scope, context, size) {
  if (scope === undefined || scope === null) return { status: 'applicable' };
  const missing = [];
  if (Array.isArray(scope.assetClasses) && scope.assetClasses.length) {
    if (!context.assetClass) missing.push('assetClass');
    else if (!scope.assetClasses.includes(context.assetClass)) {
      return { status: 'not_applicable', reason: 'Asset class "' + context.assetClass + '" is outside the rule scope.' };
    }
  }
  if (scope.minSize !== undefined || scope.maxSize !== undefined) {
    if (size === null) missing.push('nativeSize');
    else {
      if (scope.minSize !== undefined && size < scope.minSize) {
        return { status: 'not_applicable', reason: 'Maximum native dimension ' + size + ' is below minSize ' + scope.minSize + '.' };
      }
      if (scope.maxSize !== undefined && size > scope.maxSize) {
        return { status: 'not_applicable', reason: 'Maximum native dimension ' + size + ' is above maxSize ' + scope.maxSize + '.' };
      }
    }
  }
  if (missing.length) {
    return { status: 'undecidable', missing, reason: 'Context is missing ' + missing.join(' and ') + '; the scope cannot be decided.' };
  }
  return { status: 'applicable' };
}
function adaptationApplicability(adaptation, context, size) {
  const scope = {};
  if (adaptation.assetClass !== undefined) scope.assetClasses = [adaptation.assetClass];
  if (adaptation.minSize !== undefined) scope.minSize = adaptation.minSize;
  if (adaptation.maxSize !== undefined) scope.maxSize = adaptation.maxSize;
  return scopeApplicability(scope, context, size);
}
function ruleMethod(rule) {
  const kind = rule.check?.kind;
  if (kind === undefined) return 'manual';
  if (kind === 'visual') return 'visual';
  if (kind === 'unsupported') return 'unsupported';
  if (MECHANICAL_KINDS.has(kind)) return 'mechanical';
  return 'manual';
}
function normalizeReadOptions(options) {
  assert(isPlainObject(options), 'INVALID_OPTIONS', 'readThemePack options must be a plain object.');
  for (const key of Object.keys(options)) assert(key === 'view' || key === 'sections', 'INVALID_OPTIONS', 'Unknown readThemePack option "' + key + '".', { key });
  const view = options.view ?? 'working';
  assert(view === 'working' || view === 'full', 'INVALID_VIEW', 'options.view must be working or full.', { view });
  let sections;
  if (options.sections !== undefined) {
    assert(Array.isArray(options.sections), 'INVALID_SECTIONS', 'options.sections must be an array of section names.');
    for (const section of options.sections) {
      assert(typeof section === 'string' && READ_SECTIONS.has(section), 'INVALID_SECTION',
        'Unknown read section "' + String(section) + '".', { section, allowed: [...READ_SECTIONS] });
    }
    sections = [...new Set(options.sections)];
  }
  return { view, sections };
}

/**
 * Build a working read pack. No scene image is checked here, so no rule can pass.
 */
export function readThemePack(theme, context = {}, options = {}) {
  const canonical = validateTheme(theme);
  const ctx = validateThemeContext(context ?? {});
  const opts = normalizeReadOptions(options ?? {});
  const compile = compileTheme(canonical, ctx);
  const hash = themeHash(canonical);
  const nativeSize = Array.isArray(ctx.nativeSize) ? [...ctx.nativeSize] : null;
  const size = nativeSize ? Math.max(nativeSize[0], nativeSize[1]) : null;
  const resolvedContext = {
    ...ctx,
    nativeSize,
    size,
    assetClass: ctx.assetClass ?? null,
    view: ctx.view ?? null,
    channels: Array.isArray(ctx.channels) ? [...ctx.channels] : [],
  };

  const allRules = (canonical.rules ?? []).map(rule => {
    const applicability = scopeApplicability(rule.scope, ctx, size);
    return {
      id: rule.id,
      strength: rule.strength,
      statement: rule.statement,
      scope: rule.scope ?? null,
      check: rule.check ?? null,
      method: ruleMethod(rule),
      applicability: applicability.status,
      ...(applicability.reason ? { reason: applicability.reason } : {}),
      ...(applicability.missing ? { missing: [...applicability.missing] } : {}),
    };
  });
  const ruleById = new Map(allRules.map(rule => [rule.id, rule]));
  const signature = (canonical.signature ?? []).map(id => {
    const rule = ruleById.get(id);
    if (!rule) throw new ThemeRuntimeError('INVALID_THEME', 'Theme signature refers to unknown rule "' + id + '".');
    return { id: rule.id, strength: rule.strength, statement: rule.statement, applicability: rule.applicability };
  });

  const language = {};
  const languageSources = {};
  for (const section of LANGUAGE_SECTIONS) {
    const value = canonical.language?.[section];
    if (typeof value === 'string') {
      language[section] = value;
      languageSources[section] = 'theme';
    }
  }
  const adaptationReports = [];
  for (const adaptation of canonical.adaptations ?? []) {
    const applicability = adaptationApplicability(adaptation, ctx, size);
    const sections = Object.keys(adaptation.language ?? {});
    if (applicability.status === 'applicable') {
      for (const section of LANGUAGE_SECTIONS) {
        const value = adaptation.language?.[section];
        if (typeof value === 'string') {
          language[section] = value;
          languageSources[section] = adaptation.id;
        }
      }
      adaptationReports.push({ id: adaptation.id, status: 'applied', sections });
    } else {
      adaptationReports.push({
        id: adaptation.id,
        status: applicability.status,
        sections,
        ...(applicability.reason ? { reason: applicability.reason } : {}),
        ...(applicability.missing ? { missing: [...applicability.missing] } : {}),
      });
    }
  }

  const requested = opts.sections;
  const includeLanguage = section => !requested || requested.includes(section);
  const includedLanguageSections = LANGUAGE_SECTIONS.filter(section => includeLanguage(section) && language[section] !== undefined);
  const filteredLanguage = {};
  const filteredLanguageSources = {};
  for (const section of includedLanguageSections) {
    filteredLanguage[section] = language[section];
    filteredLanguageSources[section] = languageSources[section];
  }
  const omittedLanguageSections = LANGUAGE_SECTIONS.filter(section => !includeLanguage(section) && language[section] !== undefined);
  const unspecifiedSections = LANGUAGE_SECTIONS.filter(section => language[section] === undefined);
  const includeReferences = !requested || requested.includes('references');
  const includeSource = !requested || requested.includes('source');
  const omittedSections = [...omittedLanguageSections];
  if (opts.view === 'working') omittedSections.push('definition');
  if (!includeReferences) omittedSections.push('references');
  if (!includeSource) omittedSections.push('source');

  const references = includeReferences ? clone(canonical.references ?? []) : null;
  const source = includeSource ? clone(canonical.source ?? {}) : null;
  const evidence = {
    observations: includeSource ? [...(canonical.source?.observations ?? [])] : [],
    inferences: includeSource ? [...(canonical.source?.inferences ?? [])] : [],
    decisions: includeSource ? [...(canonical.source?.decisions ?? [])] : [],
    referenceIds: includeReferences ? (canonical.references ?? []).map(reference => reference.id) : [],
  };

  const tokens = {
    colors: Object.entries(canonical.tokens?.colors ?? {}).map(([key, color]) => ({
      key,
      resourceId: compile.namespace.palette[key] ?? null,
      value: color.value,
      role: color.role ?? null,
      usage: color.usage ?? null,
    })),
    ramps: Object.entries(canonical.tokens?.ramps ?? {}).map(([key, ramp]) => ({
      key,
      resourceId: compile.namespace.ramps[key] ?? null,
      response: ramp.response ?? 1,
      stops: (ramp.stops ?? []).map(stop => ({
        at: stop.at,
        colorToken: stop.color,
        resourceId: compile.namespace.palette[stop.color] ?? null,
        value: canonical.tokens?.colors?.[stop.color]?.value ?? null,
      })),
    })),
    materials: Object.entries(canonical.tokens?.materials ?? {}).map(([key, material]) => ({
      key,
      resourceId: compile.namespace.materials[key] ?? null,
      rampToken: material.ramp,
      rampResourceId: compile.namespace.ramps[material.ramp] ?? null,
      diffuse: material.diffuse ?? 1,
      emission: material.emission ?? 0,
      specular: material.specular ?? 0,
      roughness: material.roughness ?? 0.5,
    })),
    outline: compile.defaults.outline ?? null,
    defaultMaterial: compile.defaults.defaultMaterial ?? null,
    lights: (canonical.tokens?.lights ?? []).map(light => ({
      key: light.id,
      resourceId: compile.namespace.lights[light.id] ?? null,
      type: light.type,
      frame: light.frame ?? 'world',
      compiled: (compile.defaults.lights ?? []).find(item => item.id === compile.namespace.lights[light.id]) ?? null,
    })),
    ambient: compile.defaults.ambient ?? null,
    exposure: compile.defaults.exposure ?? null,
    camera: compile.defaults.camera ?? null,
    appearanceShading: compile.defaults.appearanceShading ?? null,
  };
  const bindings = {
    namespace: compile.namespace,
    defaults: compile.defaults,
    node: {
      defaultMaterial: compile.defaults.defaultMaterial ?? null,
      outline: compile.defaults.outline ?? null,
      appearanceShading: compile.defaults.appearanceShading ?? null,
      materials: compile.namespace.materials,
      lights: compile.namespace.lights,
    },
    blocked: compile.capabilities.unsupported.some(entry => entry.required),
    note: 'Apply compiled defaults at the scene root and bind materials by token key. Compilation never mutates geometry or painted pixels.',
  };

  const mechanical = [];
  const visual = [];
  const unsupportedChecks = [];
  const notApplicable = [];
  for (const rule of allRules) {
    const base = { id: rule.id, strength: rule.strength, statement: rule.statement, method: rule.method, applicability: rule.applicability };
    if (rule.applicability === 'not_applicable') {
      notApplicable.push({ ...base, status: 'not_applicable', reason: rule.reason });
      continue;
    }
    if (rule.method === 'unsupported') {
      unsupportedChecks.push({ ...base, status: 'unsupported', reason: 'The engine does not implement this check; it is not converted to a pass.' });
      continue;
    }
    if (rule.method === 'visual' || rule.method === 'manual') {
      visual.push({
        ...base,
        status: 'needs_review',
        reason: rule.method === 'manual' ? 'No mechanical check was declared; visual review is required.' : 'Visual judgment is required.',
      });
      continue;
    }
    mechanical.push({
      ...base,
      status: 'pending',
      reason: rule.applicability === 'undecidable'
        ? 'Scope is undecidable (' + (rule.missing ?? []).join(', ') + ' missing); the check is pending.'
        : 'No scene image was provided; the mechanical check is pending.',
    });
  }
  const reviewChecklist = {
    mechanical,
    visual,
    unsupported: unsupportedChecks,
    notApplicable,
    evaluation: 'pending',
    note: 'No scene image was checked. A read never certifies compliance; run themeReport against a final beauty render.',
  };

  const unknowns = [];
  for (const rule of allRules) {
    if (rule.applicability === 'undecidable') unknowns.push({ kind: 'rule_scope', id: rule.id, missing: [...(rule.missing ?? [])], reason: rule.reason });
  }
  for (const adaptation of adaptationReports) {
    if (adaptation.status === 'undecidable') unknowns.push({ kind: 'adaptation_scope', id: adaptation.id, missing: [...(adaptation.missing ?? [])], reason: adaptation.reason });
  }
  for (const section of unspecifiedSections) unknowns.push({ kind: 'unspecified_language', section });
  if (includeSource) for (const detail of canonical.source?.unknowns ?? []) unknowns.push({ kind: 'source_unknown', detail });
  for (const entry of compile.capabilities.unsupported) unknowns.push({ kind: 'unsupported_feature', path: entry.path, feature: entry.feature, reason: entry.reason, required: entry.required });
  for (const entry of compile.capabilities.warnings) unknowns.push({ kind: 'capability_warning', path: entry.path, feature: entry.feature, reason: entry.reason });
  for (const entry of compile.capabilities.missing) unknowns.push({ kind: 'capability_missing', path: entry.path, feature: entry.feature, reason: entry.reason });
  const needsAssetClass = allRules.some(rule => rule.applicability === 'undecidable' && (rule.missing ?? []).includes('assetClass')) ||
    adaptationReports.some(adaptation => adaptation.status === 'undecidable' && (adaptation.missing ?? []).includes('assetClass'));
  if (needsAssetClass) unknowns.push({ kind: 'context_missing', field: 'assetClass' });
  const needsNativeSize = allRules.some(rule => rule.applicability === 'undecidable' && (rule.missing ?? []).includes('nativeSize')) ||
    adaptationReports.some(adaptation => adaptation.status === 'undecidable' && (adaptation.missing ?? []).includes('nativeSize'));
  if (needsNativeSize) unknowns.push({ kind: 'context_missing', field: 'nativeSize' });

  const identity = {
    id: canonical.id,
    revision: canonical.revision,
    hash,
    title: canonical.title,
    summary: canonical.summary,
    tags: [...(canonical.tags ?? [])],
    signature: signature.map(item => item.id),
  };
  const pack = {
    view: opts.view,
    theme: { id: canonical.id, revision: canonical.revision, hash },
    identity,
    brief: canonical.summary,
    context: resolvedContext,
    signature,
    language: filteredLanguage,
    languageSources: filteredLanguageSources,
    adaptations: adaptationReports,
    rules: allRules,
    hardRuleIds: allRules.filter(rule => rule.strength !== 'should').map(rule => rule.id),
    advisoryRuleIds: allRules.filter(rule => rule.strength === 'should').map(rule => rule.id),
    reviewChecklist,
    tokens,
    bindings,
    capabilities: compile.capabilities,
    references,
    source,
    evidence,
    unknowns,
    unspecifiedSections,
    omittedSections: [...new Set(omittedSections)],
    evaluation: 'pending',
    note: 'Read only: no scene image was checked. Mechanical checks are pending and visual rules require review; a read is not a compliance pass.',
  };
  if (bindings.blocked) pack.note += ' Required unsupported features block binding.';
  if (opts.view === 'full') pack.definition = canonical;
  return pack;
}

function rgbHex(rgba, index) {
  return '#' + rgba[index].toString(16).padStart(2, '0') + rgba[index + 1].toString(16).padStart(2, '0') + rgba[index + 2].toString(16).padStart(2, '0');
}
function paletteCheck(state) {
  const allowed = new Set(Object.values(state.snapshot.tokens?.colors ?? {}).map(color => color.value.toLowerCase()));
  let visible = 0;
  let violating = 0;
  const samples = new Set();
  for (let index = 0; index < state.rgba.length; index += 4) {
    if (state.rgba[index + 3] === 0) continue;
    visible++;
    const color = rgbHex(state.rgba, index);
    if (!allowed.has(color)) {
      violating++;
      if (samples.size < 8) samples.add(color);
    }
  }
  return {
    pass: violating === 0,
    evidence: {
      allowedColors: [...allowed].sort(),
      visiblePixels: visible,
      violatingPixels: violating,
      sampleViolatingColors: [...samples],
    },
  };
}
function colorCountCheck(check, state) {
  const colors = new Set();
  let visible = 0;
  for (let index = 0; index < state.rgba.length; index += 4) {
    if (state.rgba[index + 3] === 0) continue;
    visible++;
    colors.add(rgbHex(state.rgba, index));
  }
  return {
    pass: colors.size <= check.max,
    evidence: {
      count: colors.size,
      max: check.max,
      visiblePixels: visible,
      colors: [...colors].sort().slice(0, 16),
      truncated: colors.size > 16,
    },
  };
}
function binaryAlphaCheck(state) {
  let nonBinary = 0;
  const samples = new Set();
  for (let index = 3; index < state.rgba.length; index += 4) {
    const alpha = state.rgba[index];
    if (alpha !== 0 && alpha !== 255) {
      nonBinary++;
      if (samples.size < 8) samples.add(alpha);
    }
  }
  return { pass: nonBinary === 0, evidence: { nonBinaryPixels: nonBinary, sampleAlphas: [...samples].sort((a, b) => a - b) } };
}
function paddingSides(rgba, width, height) {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return { left: width, right: width, top: height, bottom: height, min: Math.min(width, height) };
  const sides = { left, right: width - 1 - right, top, bottom: height - 1 - bottom };
  return { ...sides, min: Math.min(sides.left, sides.right, sides.top, sides.bottom) };
}
function paddingCheck(check, state) {
  const sides = paddingSides(state.rgba, state.width, state.height);
  return { pass: sides.min >= check.min, evidence: { ...sides, required: check.min } };
}
function canvasCheck(check, state) {
  if ((check.width !== undefined && check.width > MAX_CANVAS) || (check.height !== undefined && check.height > MAX_CANVAS)) {
    return {
      unsupported: true,
      evidence: { feature: 'canvas size', reason: 'The renderer supports native canvases up to ' + MAX_CANVAS + 'x' + MAX_CANVAS + '; this exact canvas rule cannot be satisfied.' },
    };
  }
  const pass = (check.width === undefined || state.width === check.width) &&
    (check.height === undefined || state.height === check.height) &&
    (check.maxWidth === undefined || state.width <= check.maxWidth) &&
    (check.maxHeight === undefined || state.height <= check.maxHeight);
  return {
    pass,
    evidence: {
      width: state.width,
      height: state.height,
      expected: {
        width: check.width ?? null,
        height: check.height ?? null,
        maxWidth: check.maxWidth ?? null,
        maxHeight: check.maxHeight ?? null,
      },
    },
  };
}
function effectiveOutline(scene, node) {
  const nodes = new Map((scene.nodes ?? []).map(item => [item.id, item]));
  const chain = [];
  const seen = new Set();
  let current = node;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parent ? nodes.get(current.parent) : null;
  }
  chain.reverse();
  const outline = { enabled: true, color: 'ink', direction: 'inside', group: 'root', width: 1, occlusion: true };
  for (const item of chain) {
    const value = item.outline;
    if (value === false) {
      outline.enabled = false;
      continue;
    }
    if (value && typeof value === 'object') {
      for (const key of ['enabled', 'color', 'direction', 'group', 'width', 'occlusion']) if (value[key] !== undefined) outline[key] = value[key];
    }
  }
  return outline;
}
function resolveSceneColor(value, palette) {
  if (typeof value !== 'string') return null;
  if (HEX.test(value)) return value.toLowerCase();
  const entry = palette?.[value];
  return typeof entry === 'string' && HEX.test(entry) ? entry.toLowerCase() : null;
}
function outlineCheck(check, state) {
  if (check.width !== undefined && check.width !== 1) {
    return {
      unsupported: true,
      evidence: { feature: 'outline width', reason: 'Only 1px outline width is supported; this rule cannot be satisfied by the current renderer.' },
    };
  }
  const parts = (state.scene.nodes ?? []).filter(node => node?.kind === 'part');
  if (!parts.length) return { notApplicable: true, evidence: { reason: 'The scene contains no physical parts.' } };
  let expectedColor = null;
  if (check.color !== undefined) {
    const token = state.snapshot.tokens?.colors?.[check.color];
    if (!token || typeof token.value !== 'string') {
      return { needsReview: true, evidence: { reason: 'Theme color token "' + String(check.color) + '" is not available.' } };
    }
    expectedColor = token.value.toLowerCase();
  }
  const mismatches = [];
  const partEvidence = [];
  for (const part of parts) {
    const effective = effectiveOutline(state.scene, part);
    const fields = [];
    if (check.enabled !== undefined && effective.enabled !== check.enabled) fields.push('enabled');
    if (check.width !== undefined && effective.width !== check.width) fields.push('width');
    if (check.direction !== undefined && effective.direction !== check.direction) fields.push('direction');
    const resolvedColor = resolveSceneColor(effective.color, state.scene.palette);
    if (expectedColor !== null && resolvedColor !== expectedColor) fields.push('color');
    partEvidence.push({
      id: part.id,
      visible: part.visible !== false,
      effective: { enabled: effective.enabled, width: effective.width, direction: effective.direction, color: effective.color },
      resolvedColor,
    });
    if (fields.length) mismatches.push({ id: part.id, fields });
  }
  return {
    pass: mismatches.length === 0,
    evidence: {
      expected: { enabled: check.enabled ?? null, width: check.width ?? null, direction: check.direction ?? null, color: expectedColor },
      parts: partEvidence,
      mismatches,
    },
  };
}
function cameraPreset(camera) {
  const direction = normalize(sub(camera.target, camera.position));
  if (Math.hypot(...direction) < 1e-9) return null;
  const up = normalize(camera.up);
  const candidates = {
    top_down: { direction: [0, -1, 0], up: [0, 0, -1] },
    three_quarter: { direction: [0, -Math.sin(CAMERA_ANGLE), -Math.cos(CAMERA_ANGLE)], up: [0, 1, 0] },
  };
  for (const [name, preset] of Object.entries(candidates)) {
    if (dot(direction, preset.direction) > 1 - 1e-6 && dot(up, preset.up) > 1 - 1e-6 && camera.mirrorX !== true) return name;
  }
  return 'custom';
}
function cameraCheck(check, state) {
  const camera = state.scene.camera;
  if (!isObject(camera) || !isVec3(camera.position) || !isVec3(camera.target) || !isVec3(camera.up)) {
    return { needsReview: true, evidence: { reason: 'The scene camera is missing or incomplete.' } };
  }
  const actual = cameraPreset(camera);
  if (actual === null) return { needsReview: true, evidence: { reason: 'The scene camera direction is degenerate.' } };
  return {
    pass: actual === check.preset,
    evidence: {
      actualPreset: actual,
      expected: check.preset,
      contextView: state.context.view ?? null,
      camera: { position: [...camera.position], target: [...camera.target], up: [...camera.up], mirrorX: Boolean(camera.mirrorX) },
    },
  };
}
function lightCountCheck(check, state) {
  const lights = Array.isArray(state.scene.lights) ? state.scene.lights : [];
  return { pass: lights.length <= check.max, evidence: { count: lights.length, max: check.max, ids: lights.map(light => light?.id ?? null) } };
}
function appearanceShadingCheck(check, state) {
  const layers = (state.scene.nodes ?? []).filter(node => node?.kind === 'layer' && node.appearanceOf !== undefined);
  if (!layers.length) return { notApplicable: true, evidence: { reason: 'The scene has no part-bound appearance layers.' } };
  const values = layers.map(node => ({ id: node.id, declared: node.appearanceShading ?? null, effective: node.appearanceShading ?? 'lit' }));
  return { pass: values.every(value => value.effective === check.value), evidence: { expected: check.value, layers: values } };
}
function evaluateMechanical(check, state) {
  switch (check.kind) {
    case 'palette': return paletteCheck(state);
    case 'color_count': return colorCountCheck(check, state);
    case 'binary_alpha': return binaryAlphaCheck(state);
    case 'padding': return paddingCheck(check, state);
    case 'canvas': return canvasCheck(check, state);
    case 'outline': return outlineCheck(check, state);
    case 'camera': return cameraCheck(check, state);
    case 'light_count': return lightCountCheck(check, state);
    case 'appearance_shading': return appearanceShadingCheck(check, state);
    default: return { needsReview: true, evidence: { reason: 'Unknown mechanical check kind "' + String(check.kind) + '".' } };
  }
}
function beautyRgba(image, width, height) {
  assert(isObject(image), 'INVALID_IMAGE', 'themeReport requires the rendered beauty image.');
  for (const mode of [image.stats?.mode, image.mode]) {
    assert(mode === undefined || mode === 'beauty', 'INVALID_IMAGE',
      'themeReport requires the final beauty buffer, not the ' + String(mode) + ' diagnostic raster.', { mode });
  }
  assert(image.width === width && image.height === height, 'INVALID_IMAGE',
    'The beauty image is ' + String(image.width) + 'x' + String(image.height) + ', but the scene is ' + width + 'x' + height + '.',
    { image: { width: image.width, height: image.height }, scene: { width, height } });
  const data = image.rgba ?? image.data;
  assert(data instanceof Uint8Array, 'INVALID_IMAGE', 'The beauty image must expose a Uint8Array rgba buffer.');
  assert(data.length === width * height * 4, 'INVALID_IMAGE',
    'The beauty image rgba buffer must contain ' + (width * height * 4) + ' bytes.');
  return data;
}

/**
 * Check a bound theme against the final beauty RGBA. Uses only the pinned snapshot.
 * Returns null when the scene has no theme binding.
 */
export function themeReport(scene, image) {
  assert(isPlainObject(scene), 'INVALID_SCENE', 'themeReport requires a scene object.');
  if (scene.theme === undefined || scene.theme === null) return null;
  const binding = validateThemeBinding(scene.theme);
  const snapshot = validateTheme(binding.snapshot);
  const baseContext = validateThemeContext(binding.context ?? {});
  const width = scene.width;
  const height = scene.height;
  assert(Number.isSafeInteger(width) && width >= 1 && width <= MAX_CANVAS, 'INVALID_SCENE', 'scene.width must be an integer between 1 and ' + MAX_CANVAS + '.');
  assert(Number.isSafeInteger(height) && height >= 1 && height <= MAX_CANVAS, 'INVALID_SCENE', 'scene.height must be an integer between 1 and ' + MAX_CANVAS + '.');
  const context = validateThemeContext({ ...baseContext, nativeSize: [width, height] });
  const compile = compileTheme(snapshot, context, { camera: scene.camera });
  const rgba = beautyRgba(image, width, height);
  const size = Math.max(width, height);
  const checks = [];
  const deviations = [];
  const overrideMap = new Map((binding.overrides ?? []).map(override => [override.rule, override]));

  for (const rule of snapshot.rules ?? []) {
    const applicability = scopeApplicability(rule.scope, context, size);
    const method = ruleMethod(rule);
    const base = { id: rule.id, strength: rule.strength, statement: rule.statement };
    const override = overrideMap.get(rule.id);
    if (override) {
      checks.push({
        ...base,
        status: 'waived',
        method: 'override',
        evidence: {
          reason: override.reason,
          originalMethod: method,
          applicability: applicability.status,
          ...(applicability.reason ? { scopeReason: applicability.reason } : {}),
        },
      });
      deviations.push({ rule: rule.id, strength: rule.strength, statement: rule.statement, reason: override.reason, applicability: applicability.status });
      continue;
    }
    if (applicability.status === 'not_applicable') {
      checks.push({ ...base, status: 'not_applicable', method, evidence: { scope: applicability.reason } });
      continue;
    }
    if (applicability.status === 'undecidable') {
      checks.push({ ...base, status: 'needs_review', method, evidence: { scope: applicability.reason, missing: [...(applicability.missing ?? [])] } });
      continue;
    }
    if (method === 'manual') {
      checks.push({ ...base, status: 'needs_review', method: 'manual', evidence: { reason: 'No mechanical check was declared; visual review is required.' } });
      continue;
    }
    if (method === 'visual') {
      checks.push({ ...base, status: 'needs_review', method: 'visual', evidence: { reason: 'Visual judgment is required; the runtime does not convert it to a pass.' } });
      continue;
    }
    if (method === 'unsupported') {
      checks.push({ ...base, status: 'unsupported', method: 'unsupported', evidence: { feature: rule.check.feature, required: rule.strength !== 'should' } });
      continue;
    }
    let result;
    try { result = evaluateMechanical(rule.check, { scene, rgba, width, height, snapshot, context, compile }); }
    catch (error) {
      checks.push({ ...base, status: 'needs_review', method: rule.check.kind, evidence: { error: error.message } });
      continue;
    }
    if (result.notApplicable) {
      checks.push({ ...base, status: 'not_applicable', method: rule.check.kind, evidence: result.evidence });
      continue;
    }
    if (result.needsReview) {
      checks.push({ ...base, status: 'needs_review', method: rule.check.kind, evidence: result.evidence });
      continue;
    }
    if (result.unsupported) {
      checks.push({ ...base, status: 'unsupported', method: rule.check.kind, evidence: result.evidence });
      continue;
    }
    const inverted = rule.strength === 'must_not';
    const passed = inverted ? !result.pass : result.pass;
    checks.push({ ...base, status: passed ? 'pass' : 'fail', method: rule.check.kind, evidence: { ...result.evidence, predicate: result.pass, inverted } });
  }

  const mechanicalChecks = checks.filter(check => check.method !== 'visual' && check.method !== 'manual' && check.method !== 'unsupported' && check.method !== 'override');
  let mechanicalStatus = 'pass';
  if (mechanicalChecks.some(check => check.status === 'fail')) mechanicalStatus = 'fail';
  else if (mechanicalChecks.some(check => check.status === 'needs_review' || check.status === 'unsupported')) mechanicalStatus = 'pending';
  const visualIds = checks.filter(check => check.status === 'needs_review' && (check.method === 'visual' || check.method === 'manual')).map(check => check.id);
  const visualStatus = visualIds.length ? 'needs_review' : 'not_required';
  const isHard = check => check.strength === 'must' || check.strength === 'must_not';
  const hardFail = checks.some(check => isHard(check) && check.status === 'fail');
  const hardUnsupported = checks.some(check => isHard(check) && check.status === 'unsupported');
  const requiredCapability = compile.capabilities.unsupported.some(entry => entry.required);
  const blocked = hardFail || hardUnsupported || requiredCapability;
  const advisoryFailures = checks.filter(check => check.strength === 'should' && check.status === 'fail').map(check => check.id);
  const unsupportedIds = checks.filter(check => check.status === 'unsupported').map(check => check.id);
  const noteParts = ['Checks run on the final beauty RGBA including outline pixels.'];
  if (unsupportedIds.length) noteParts.push(unsupportedIds.length + ' rule(s) are unsupported by the engine; see checks.');
  if (visualStatus === 'needs_review') noteParts.push(visualIds.length + ' visual rule(s) remain needs_review.');
  if (deviations.length) noteParts.push(deviations.length + ' override(s) are recorded as deviations, not full compliance.');
  if (compile.capabilities.missing.length) noteParts.push(compile.capabilities.missing.length + ' capability input(s) are missing; see capabilities.missing.');
  if (blocked) noteParts.push('A non-waived hard rule failed or a required feature is unsupported.');
  else if (mechanicalStatus === 'pending') noteParts.push('Some mechanical rules are pending; this report is not a pass.');
  else noteParts.push('No blocking hard-rule failure was found; visual review is still required where listed.');
  if (advisoryFailures.length) noteParts.push(advisoryFailures.length + ' advisory should-rule(s) did not pass and do not block.');

  return {
    theme: { id: snapshot.id, revision: snapshot.revision, hash: binding.hash },
    sceneRevision: scene.revision,
    checks,
    mechanical: {
      status: mechanicalStatus,
      ruleIds: mechanicalChecks.map(check => check.id),
      advisoryFailures,
      note: 'Only non-waived must/must_not failures and required unsupported features block; visual rules never become machine passes.',
    },
    visual: { status: visualStatus, ruleIds: visualIds },
    blocked,
    deviations,
    capabilities: compile.capabilities,
    note: noteParts.join(' '),
  };
}
