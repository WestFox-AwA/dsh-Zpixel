/**
 * Pure canonical theme data for ZPixel 0.4.0.
 *
 * A theme is authoring intent, not a renderer. This module never touches
 * scenes, pixels, geometry, images or the filesystem. It normalizes an
 * authoring spec into one canonical revision, validates canonical revisions
 * without mutation (deep-frozen objects are accepted), hashes the canonical
 * revision, and validates read contexts and scene bindings.
 *
 * No imports from scene.mjs or store.mjs: scene validation imports this
 * module, so importing scene back would create a cycle.
 *
 * Canonical defaults (normalizeTheme fills these; validateTheme requires the
 * canonical form):
 *   tags [], signature [], language {}, rules [], adaptations [], references []
 *   tokens.colors/ramps/materials always present, possibly empty
 *   ramp response 1; material diffuse 1, emission 0, specular 0, roughness 0.5
 *   light frame world; reference role reference; source {kind:'concept'}
 *   optional directives (defaultMaterial/outline/lights/ambient/exposure/
 *   camera/appearanceShading) are absent when unspecified, so a theme never
 *   silently forces a scene value. tokens.lights:[] is an explicit "no lights".
 *
 * Text is trimmed and CRLF/CR is normalized to LF. Colors are lowercased
 * #RRGGBB. Hash is lowercase SHA-256 hex of stable sorted-key JSON of the
 * canonical revision (format/id/revision included), never an author field.
 */
import { createHash } from 'node:crypto';

export const THEME_FORMAT = 'dsh-zpixel-theme/1';
export const THEME_LANGUAGE_SECTIONS = Object.freeze([
  'identity', 'view', 'scale', 'form', 'pixel', 'color', 'outline', 'light', 'materials', 'detail',
]);
export const THEME_LIMITS = Object.freeze({
  id: 64,
  title: 200,
  summary: 2000,
  tags: 32,
  tag: 64,
  languageSections: 10,
  languageText: 4000,
  colors: 64,
  tokenId: 48,
  tokenRole: 200,
  tokenUsage: 500,
  ramps: 64,
  rampStops: 64,
  materials: 64,
  lights: 8,
  rules: 64,
  ruleId: 64,
  ruleStatement: 2000,
  scopeClasses: 32,
  size: 256,
  image: 4096,
  adaptations: 32,
  references: 32,
  referenceLists: 32,
  referenceText: 2000,
  sourceLists: 64,
  sourceText: 2000,
  sourceBrief: 4000,
  overrides: 64,
  overrideReason: 1000,
  themeBytes: 256 * 1024,
});

/**
 * Theme errors carry the same .code/.details contract as ZPixelError. The
 * service dispatches on .code, and the name is kept compatible with the
 * plugin's existing error envelope.
 */
export class ThemeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ZPixelError';
    this.code = code;
    this.details = details;
  }
}
const fail = (code, message, details = {}) => { throw new ThemeError(code, message, details); };
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const sameIdIgnoringCase = (left, right) => typeof left === 'string' && typeof right === 'string' &&
  left.length === right.length && left.toLowerCase() === right.toLowerCase();

function plainObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_FIELD', path + ' must be a plain object.', { path });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('INVALID_FIELD', path + ' must be a plain object, not a class instance.', { path });
  }
  if (Object.getOwnPropertySymbols(value).length) {
    fail('UNKNOWN_FIELD', path + ' cannot have symbol fields.', { path });
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      fail('INVALID_FIELD', path + '.' + key + ' must be an enumerable data property.', { path: path + '.' + key });
    }
  }
  return value;
}

function fields(value, allowed, path) {
  plainObject(value, path);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail('UNKNOWN_FIELD', 'Unknown field ' + path + '.' + key + '. Allowed fields: ' + allowed.join(', ') + '.', {
        path: path + '.' + key, field: key, allowed: [...allowed],
      });
    }
  }
  return value;
}

function requireFields(value, keys, path) {
  for (const key of keys) {
    if (!owns(value, key)) fail('INVALID_FIELD', path + '.' + key + ' is required.', { path: path + '.' + key });
  }
}

function oneOf(value, values, path) {
  if (!values.includes(value)) {
    fail('INVALID_FIELD', path + ' must be one of: ' + values.join(', ') + '.', { path, value, allowed: [...values] });
  }
  return value;
}

function number(value, path, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail('INVALID_NUMBER', path + ' must be a finite number from ' + min + ' to ' + max + '.', { path, value, min, max });
  }
  return value === 0 ? 0 : value;
}

function integer(value, path, min, max) {
  number(value, path, min, max);
  if (!Number.isSafeInteger(value)) fail('INVALID_INTEGER', path + ' must be a safe integer.', { path, value });
  return value;
}

function boolean(value, path) {
  if (typeof value !== 'boolean') fail('INVALID_FIELD', path + ' must be a boolean.', { path, value });
  return value;
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      index++;
    } else if (code >= 0xDC00 && code <= 0xDFFF) return true;
  }
  return false;
}

function cleanText(value, path, max, min = 1, { line = false } = {}) {
  if (typeof value !== 'string') fail('INVALID_TEXT', path + ' must be a string.', { path, value });
  if (hasLoneSurrogate(value)) fail('INVALID_TEXT', path + ' contains an unpaired surrogate.', { path });
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (text.length < min || text.length > max) {
    fail('INVALID_TEXT', path + ' must contain ' + min + '-' + max + ' characters after trimming.', { path, length: text.length, min, max });
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    fail('INVALID_TEXT', path + ' contains a disallowed control character.', { path });
  }
  if (line && text.includes('\n')) fail('INVALID_TEXT', path + ' must be a single line.', { path });
  return text;
}

const cleanLine = (value, path, max, min = 1) => cleanText(value, path, max, min, { line: true });

function hexColor(value, path) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
    fail('INVALID_COLOR', path + ' must be an opaque #RRGGBB color.', { path, value });
  }
  return value.toLowerCase();
}

function sha256Hex(value, path) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    fail('INVALID_HASH', path + ' must be a SHA-256 hex digest.', { path, value });
  }
  return value.toLowerCase();
}

const THEME_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
function themeId(value, path) {
  if (typeof value !== 'string' || !THEME_ID.test(value) || FORBIDDEN_KEYS.has(value)) {
    fail('THEME_ID', path + ' must start with a letter, then use letters, digits, _ or - (at most ' + THEME_LIMITS.id + ' characters).', { path, value });
  }
  return value;
}
export function assertThemeId(value, path = 'id') { return themeId(value, path); }

const NAME_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
function nameId(value, path) {
  if (typeof value !== 'string' || !NAME_ID.test(value) || FORBIDDEN_KEYS.has(value)) {
    fail('INVALID_ID', path + ' must start with a letter and use at most ' + THEME_LIMITS.ruleId + ' letters, digits, dots, colons, underscores or hyphens.', { path, value });
  }
  return value;
}

const TOKEN_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/;
function tokenId(value, path) {
  if (typeof value !== 'string' || !TOKEN_ID.test(value) || FORBIDDEN_KEYS.has(value)) {
    fail('INVALID_ID', path + ' must start with a letter and use at most ' + THEME_LIMITS.tokenId + ' letters, digits, dots, underscores or hyphens.', { path, value });
  }
  return value;
}

function vec3(value, path) {
  if (!Array.isArray(value) || value.length !== 3) {
    fail('INVALID_VECTOR', path + ' must be an array of three finite numbers.', { path });
  }
  const result = [];
  for (let index = 0; index < 3; index++) result.push(number(value[index], path + '[' + index + ']', -1e6, 1e6));
  return result;
}

function dictionary(value, path, max) {
  plainObject(value, path);
  const entries = Object.entries(value);
  if (entries.length > max) {
    fail('THEME_LIMIT', path + ' supports at most ' + max + ' entries.', { path, limit: max, count: entries.length });
  }
  for (const [key] of entries) tokenId(key, path + ' key');
  return entries;
}

const sortedEntries = entries => entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

function stringList(value, path, maxItems, maxLength, { unique = false, line = false } = {}) {
  if (!Array.isArray(value)) fail('INVALID_FIELD', path + ' must be an array.', { path });
  if (value.length > maxItems) {
    fail('THEME_LIMIT', path + ' supports at most ' + maxItems + ' entries.', { path, limit: maxItems, count: value.length });
  }
  const result = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index++) {
    const text = line ? cleanLine(value[index], path + '[' + index + ']', maxLength) : cleanText(value[index], path + '[' + index + ']', maxLength);
    if (unique) {
      if (seen.has(text)) fail('DUPLICATE_ID', path + ' contains duplicate entry "' + text + '".', { path, value: text });
      seen.add(text);
    }
    result.push(text);
  }
  return result;
}

function normalizeTags(value, path) {
  return stringList(value, path, THEME_LIMITS.tags, THEME_LIMITS.tag, { unique: true, line: true });
}

function normalizeLanguage(value, path) {
  fields(value, THEME_LANGUAGE_SECTIONS, path);
  const result = {};
  for (const section of THEME_LANGUAGE_SECTIONS) {
    if (owns(value, section)) result[section] = cleanText(value[section], path + '.' + section, THEME_LIMITS.languageText);
  }
  return result;
}

function normalizeColors(value, path) {
  const entries = dictionary(value, path, THEME_LIMITS.colors);
  const result = {};
  for (const [key, raw] of sortedEntries(entries)) {
    const itemPath = path + '.' + key;
    fields(raw, ['value', 'role', 'usage'], itemPath);
    requireFields(raw, ['value'], itemPath);
    const color = { value: hexColor(raw.value, itemPath + '.value') };
    if (owns(raw, 'role')) color.role = cleanText(raw.role, itemPath + '.role', THEME_LIMITS.tokenRole);
    if (owns(raw, 'usage')) color.usage = cleanText(raw.usage, itemPath + '.usage', THEME_LIMITS.tokenUsage);
    result[key] = color;
  }
  return result;
}

function normalizeStops(value, path, colors) {
  if (!Array.isArray(value) || value.length < 1 || value.length > THEME_LIMITS.rampStops) {
    fail('INVALID_RAMP', path + ' must be an array of 1-' + THEME_LIMITS.rampStops + ' stops.', { path });
  }
  const stops = [];
  for (let index = 0; index < value.length; index++) {
    const stopPath = path + '[' + index + ']';
    fields(value[index], ['at', 'color'], stopPath);
    requireFields(value[index], ['at', 'color'], stopPath);
    const at = number(value[index].at, stopPath + '.at', 0, 64);
    if (index > 0 && at <= stops[index - 1].at) {
      fail('INVALID_RAMP', stopPath + '.at must be greater than the previous stop.', { path: stopPath + '.at' });
    }
    const color = tokenId(value[index].color, stopPath + '.color');
    if (!owns(colors, color)) {
      fail('INVALID_REFERENCE', stopPath + '.color refers to unknown theme color "' + color + '".', { path: stopPath + '.color', available: Object.keys(colors) });
    }
    stops.push({ at, color });
  }
  return stops;
}

function normalizeRamps(value, path, colors) {
  const entries = dictionary(value, path, THEME_LIMITS.ramps);
  const result = {};
  for (const [key, raw] of sortedEntries(entries)) {
    const itemPath = path + '.' + key;
    fields(raw, ['response', 'stops'], itemPath);
    requireFields(raw, ['stops'], itemPath);
    const response = owns(raw, 'response') ? number(raw.response, itemPath + '.response', 1e-4, 16) : 1;
    result[key] = { response, stops: normalizeStops(raw.stops, itemPath + '.stops', colors) };
  }
  return result;
}

function normalizeMaterials(value, path, ramps) {
  const entries = dictionary(value, path, THEME_LIMITS.materials);
  const result = {};
  for (const [key, raw] of sortedEntries(entries)) {
    const itemPath = path + '.' + key;
    fields(raw, ['ramp', 'diffuse', 'emission', 'specular', 'roughness'], itemPath);
    requireFields(raw, ['ramp'], itemPath);
    const ramp = tokenId(raw.ramp, itemPath + '.ramp');
    if (!owns(ramps, ramp)) {
      fail('INVALID_REFERENCE', itemPath + '.ramp refers to unknown theme ramp "' + ramp + '".', { path: itemPath + '.ramp', available: Object.keys(ramps) });
    }
    result[key] = {
      ramp,
      diffuse: owns(raw, 'diffuse') ? number(raw.diffuse, itemPath + '.diffuse', 0, 16) : 1,
      emission: owns(raw, 'emission') ? number(raw.emission, itemPath + '.emission', 0, 16) : 0,
      specular: owns(raw, 'specular') ? number(raw.specular, itemPath + '.specular', 0, 16) : 0,
      roughness: owns(raw, 'roughness') ? number(raw.roughness, itemPath + '.roughness', 0, 1) : 0.5,
    };
  }
  return result;
}

function normalizeOutline(value, path, colors) {
  fields(value, ['enabled', 'color', 'width', 'direction'], path);
  const result = {};
  if (owns(value, 'enabled')) result.enabled = boolean(value.enabled, path + '.enabled');
  if (owns(value, 'color')) {
    const color = tokenId(value.color, path + '.color');
    if (!owns(colors, color)) {
      fail('INVALID_REFERENCE', path + '.color refers to unknown theme color "' + color + '".', { path: path + '.color', available: Object.keys(colors) });
    }
    result.color = color;
  }
  if (owns(value, 'width')) result.width = integer(value.width, path + '.width', 1, 64);
  if (owns(value, 'direction')) result.direction = oneOf(value.direction, ['inside', 'outside'], path + '.direction');
  return Object.keys(result).length ? result : null;
}

function normalizeLights(value, path) {
  if (!Array.isArray(value)) fail('INVALID_FIELD', path + ' must be an array.', { path });
  if (value.length > THEME_LIMITS.lights) {
    fail('THEME_LIMIT', path + ' supports at most ' + THEME_LIMITS.lights + ' lights.', { path, limit: THEME_LIMITS.lights, count: value.length });
  }
  const result = [];
  const ids = new Set();
  for (let index = 0; index < value.length; index++) {
    const itemPath = path + '[' + index + ']';
    fields(value[index], ['id', 'type', 'position', 'direction', 'frame', 'intensity', 'range', 'color'], itemPath);
    requireFields(value[index], ['id', 'type'], itemPath);
    const id = nameId(value[index].id, itemPath + '.id');
    if (ids.has(id)) fail('DUPLICATE_ID', path + ' contains duplicate light id "' + id + '".', { path, id });
    ids.add(id);
    const light = { id, type: oneOf(value[index].type, ['point', 'directional'], itemPath + '.type') };
    if (owns(value[index], 'position')) light.position = vec3(value[index].position, itemPath + '.position');
    if (owns(value[index], 'direction')) light.direction = vec3(value[index].direction, itemPath + '.direction');
    light.frame = owns(value[index], 'frame') ? oneOf(value[index].frame, ['world', 'view'], itemPath + '.frame') : 'world';
    if (owns(value[index], 'intensity')) light.intensity = number(value[index].intensity, itemPath + '.intensity', 0, 64);
    if (owns(value[index], 'range')) light.range = number(value[index].range, itemPath + '.range', 0, 1e6);
    if (owns(value[index], 'color')) light.color = hexColor(value[index].color, itemPath + '.color');
    result.push(light);
  }
  return result;
}

function normalizeCamera(value, path) {
  fields(value, ['preset', 'pixelsPerUnit'], path);
  requireFields(value, ['preset'], path);
  const camera = { preset: oneOf(value.preset, ['top_down', 'three_quarter'], path + '.preset') };
  if (owns(value, 'pixelsPerUnit')) camera.pixelsPerUnit = number(value.pixelsPerUnit, path + '.pixelsPerUnit', 1e-4, 1e4);
  return camera;
}

function normalizeTokens(value, path) {
  fields(value, ['colors', 'ramps', 'materials', 'defaultMaterial', 'outline', 'lights', 'ambient', 'exposure', 'camera', 'appearanceShading'], path);
  const colors = normalizeColors(owns(value, 'colors') ? value.colors : {}, path + '.colors');
  const ramps = normalizeRamps(owns(value, 'ramps') ? value.ramps : {}, path + '.ramps', colors);
  const materials = normalizeMaterials(owns(value, 'materials') ? value.materials : {}, path + '.materials', ramps);
  const tokens = { colors, ramps, materials };
  if (owns(value, 'defaultMaterial')) {
    const material = tokenId(value.defaultMaterial, path + '.defaultMaterial');
    if (!owns(materials, material)) {
      fail('INVALID_REFERENCE', path + '.defaultMaterial refers to unknown theme material "' + material + '".', { path: path + '.defaultMaterial', available: Object.keys(materials) });
    }
    tokens.defaultMaterial = material;
  }
  if (owns(value, 'outline')) {
    const outline = normalizeOutline(value.outline, path + '.outline', colors);
    if (outline) tokens.outline = outline;
  }
  if (owns(value, 'lights')) tokens.lights = normalizeLights(value.lights, path + '.lights');
  if (owns(value, 'ambient')) tokens.ambient = number(value.ambient, path + '.ambient', 0, 1);
  if (owns(value, 'exposure')) tokens.exposure = number(value.exposure, path + '.exposure', 0, 16);
  if (owns(value, 'camera')) tokens.camera = normalizeCamera(value.camera, path + '.camera');
  if (owns(value, 'appearanceShading')) tokens.appearanceShading = oneOf(value.appearanceShading, ['lit', 'unlit'], path + '.appearanceShading');
  return tokens;
}

function normalizeScope(value, path) {
  fields(value, ['assetClasses', 'minSize', 'maxSize'], path);
  const scope = {};
  if (owns(value, 'assetClasses')) {
    if (!Array.isArray(value.assetClasses) || value.assetClasses.length < 1 || value.assetClasses.length > THEME_LIMITS.scopeClasses) {
      fail('INVALID_FIELD', path + '.assetClasses must be an array of 1-' + THEME_LIMITS.scopeClasses + ' asset classes.', { path: path + '.assetClasses' });
    }
    const classes = [];
    const seen = new Set();
    for (let index = 0; index < value.assetClasses.length; index++) {
      const assetClass = nameId(value.assetClasses[index], path + '.assetClasses[' + index + ']');
      if (seen.has(assetClass)) fail('DUPLICATE_ID', path + '.assetClasses contains duplicate "' + assetClass + '".', { path: path + '.assetClasses', value: assetClass });
      seen.add(assetClass);
      classes.push(assetClass);
    }
    scope.assetClasses = classes;
  }
  if (owns(value, 'minSize')) scope.minSize = integer(value.minSize, path + '.minSize', 0, THEME_LIMITS.size);
  if (owns(value, 'maxSize')) scope.maxSize = integer(value.maxSize, path + '.maxSize', 0, THEME_LIMITS.size);
  if (scope.minSize !== undefined && scope.maxSize !== undefined && scope.minSize > scope.maxSize) {
    fail('INVALID_RANGE', path + '.minSize must not exceed maxSize.', { path, minSize: scope.minSize, maxSize: scope.maxSize });
  }
  return Object.keys(scope).length ? scope : null;
}

const CHECK_KINDS = Object.freeze(['palette', 'color_count', 'binary_alpha', 'padding', 'canvas', 'outline', 'camera', 'light_count', 'appearance_shading', 'visual', 'unsupported']);

function normalizeCheck(value, path, tokens) {
  plainObject(value, path);
  if (!owns(value, 'kind')) fail('INVALID_CHECK', path + '.kind is required.', { path: path + '.kind', allowed: [...CHECK_KINDS] });
  const kind = oneOf(value.kind, CHECK_KINDS, path + '.kind');
  switch (kind) {
    case 'palette':
    case 'binary_alpha':
    case 'visual':
      fields(value, ['kind'], path);
      return { kind };
    case 'color_count':
      fields(value, ['kind', 'max'], path);
      requireFields(value, ['max'], path);
      return { kind, max: integer(value.max, path + '.max', 1, THEME_LIMITS.size) };
    case 'padding':
      fields(value, ['kind', 'min'], path);
      requireFields(value, ['min'], path);
      return { kind, min: integer(value.min, path + '.min', 0, THEME_LIMITS.size) };
    case 'canvas': {
      fields(value, ['kind', 'width', 'height', 'maxWidth', 'maxHeight'], path);
      const result = { kind };
      for (const key of ['width', 'height', 'maxWidth', 'maxHeight']) {
        if (owns(value, key)) result[key] = integer(value[key], path + '.' + key, 1, THEME_LIMITS.size);
      }
      if (!['width', 'height', 'maxWidth', 'maxHeight'].some(key => owns(result, key))) {
        fail('INVALID_CHECK', path + ' must declare at least one of width, height, maxWidth or maxHeight.', { path });
      }
      if (result.width !== undefined && result.maxWidth !== undefined && result.width > result.maxWidth) {
        fail('INVALID_CHECK', path + '.width must not exceed maxWidth.', { path });
      }
      if (result.height !== undefined && result.maxHeight !== undefined && result.height > result.maxHeight) {
        fail('INVALID_CHECK', path + '.height must not exceed maxHeight.', { path });
      }
      return result;
    }
    case 'outline': {
      fields(value, ['kind', 'enabled', 'width', 'direction', 'color'], path);
      const result = { kind };
      if (owns(value, 'enabled')) result.enabled = boolean(value.enabled, path + '.enabled');
      if (owns(value, 'width')) result.width = integer(value.width, path + '.width', 1, 64);
      if (owns(value, 'direction')) result.direction = oneOf(value.direction, ['inside', 'outside'], path + '.direction');
      if (owns(value, 'color')) {
        const color = tokenId(value.color, path + '.color');
        if (!owns(tokens.colors, color)) {
          fail('INVALID_REFERENCE', path + '.color refers to unknown theme color "' + color + '".', { path: path + '.color', available: Object.keys(tokens.colors) });
        }
        result.color = color;
      }
      if (Object.keys(result).length === 1) fail('INVALID_CHECK', path + ' must declare at least one outline property.', { path });
      return result;
    }
    case 'camera':
      fields(value, ['kind', 'preset'], path);
      requireFields(value, ['preset'], path);
      return { kind, preset: oneOf(value.preset, ['top_down', 'three_quarter'], path + '.preset') };
    case 'light_count':
      fields(value, ['kind', 'max'], path);
      requireFields(value, ['max'], path);
      return { kind, max: integer(value.max, path + '.max', 0, THEME_LIMITS.lights) };
    case 'appearance_shading':
      fields(value, ['kind', 'value'], path);
      requireFields(value, ['value'], path);
      return { kind, value: oneOf(value.value, ['lit', 'unlit'], path + '.value') };
    case 'unsupported':
      fields(value, ['kind', 'feature'], path);
      requireFields(value, ['feature'], path);
      return { kind, feature: cleanLine(value.feature, path + '.feature', 200) };
    default:
      fail('INVALID_CHECK', 'Unsupported check kind.', { path });
  }
}

function normalizeRules(value, path, tokens) {
  if (!Array.isArray(value)) fail('INVALID_FIELD', path + ' must be an array.', { path });
  if (value.length > THEME_LIMITS.rules) {
    fail('THEME_LIMIT', path + ' supports at most ' + THEME_LIMITS.rules + ' rules.', { path, limit: THEME_LIMITS.rules, count: value.length });
  }
  const result = [];
  const ids = new Set();
  for (let index = 0; index < value.length; index++) {
    const itemPath = path + '[' + index + ']';
    fields(value[index], ['id', 'strength', 'statement', 'scope', 'check'], itemPath);
    requireFields(value[index], ['id', 'strength', 'statement'], itemPath);
    const id = nameId(value[index].id, itemPath + '.id');
    if (ids.has(id)) fail('DUPLICATE_ID', path + ' contains duplicate rule id "' + id + '".', { path, id });
    ids.add(id);
    const rule = {
      id,
      strength: oneOf(value[index].strength, ['must', 'should', 'must_not'], itemPath + '.strength'),
      statement: cleanText(value[index].statement, itemPath + '.statement', THEME_LIMITS.ruleStatement),
    };
    if (owns(value[index], 'scope')) {
      const scope = normalizeScope(value[index].scope, itemPath + '.scope');
      if (scope) rule.scope = scope;
    }
    if (owns(value[index], 'check')) rule.check = normalizeCheck(value[index].check, itemPath + '.check', tokens);
    result.push(rule);
  }
  return result;
}

function normalizeSignature(value, path, rules) {
  if (!Array.isArray(value)) fail('INVALID_FIELD', path + ' must be an array.', { path });
  if (value.length > THEME_LIMITS.rules) {
    fail('THEME_LIMIT', path + ' supports at most ' + THEME_LIMITS.rules + ' rule ids.', { path, limit: THEME_LIMITS.rules, count: value.length });
  }
  const known = new Set(rules.map(rule => rule.id));
  const result = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index++) {
    const id = nameId(value[index], path + '[' + index + ']');
    if (seen.has(id)) fail('DUPLICATE_ID', path + ' contains duplicate rule id "' + id + '".', { path, id });
    if (!known.has(id)) {
      fail('INVALID_REFERENCE', path + '[' + index + '] refers to unknown rule "' + id + '".', { path: path + '[' + index + ']', available: [...known] });
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

function normalizeAdaptations(value, path) {
  if (!Array.isArray(value)) fail('INVALID_FIELD', path + ' must be an array.', { path });
  if (value.length > THEME_LIMITS.adaptations) {
    fail('THEME_LIMIT', path + ' supports at most ' + THEME_LIMITS.adaptations + ' adaptations.', { path, limit: THEME_LIMITS.adaptations, count: value.length });
  }
  const result = [];
  const ids = new Set();
  for (let index = 0; index < value.length; index++) {
    const itemPath = path + '[' + index + ']';
    fields(value[index], ['id', 'assetClass', 'minSize', 'maxSize', 'language'], itemPath);
    requireFields(value[index], ['id', 'language'], itemPath);
    const id = nameId(value[index].id, itemPath + '.id');
    if (ids.has(id)) fail('DUPLICATE_ID', path + ' contains duplicate adaptation id "' + id + '".', { path, id });
    ids.add(id);
    const adaptation = { id };
    if (owns(value[index], 'assetClass')) adaptation.assetClass = nameId(value[index].assetClass, itemPath + '.assetClass');
    if (owns(value[index], 'minSize')) adaptation.minSize = integer(value[index].minSize, itemPath + '.minSize', 0, THEME_LIMITS.size);
    if (owns(value[index], 'maxSize')) adaptation.maxSize = integer(value[index].maxSize, itemPath + '.maxSize', 0, THEME_LIMITS.size);
    if (adaptation.minSize !== undefined && adaptation.maxSize !== undefined && adaptation.minSize > adaptation.maxSize) {
      fail('INVALID_RANGE', itemPath + '.minSize must not exceed maxSize.', { path: itemPath, minSize: adaptation.minSize, maxSize: adaptation.maxSize });
    }
    const language = normalizeLanguage(value[index].language, itemPath + '.language');
    if (!Object.keys(language).length) {
      fail('INVALID_FIELD', itemPath + '.language must declare at least one language section.', { path: itemPath + '.language' });
    }
    adaptation.language = language;
    result.push(adaptation);
  }
  return result;
}

function referencePath(value, path) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    fail('INVALID_PATH', path + ' must be a workspace-relative path of 1-256 characters.', { path, value });
  }
  if (/[\u0000-\u001F\u007F]/.test(value)) fail('INVALID_PATH', path + ' contains a control character.', { path });
  if (value.includes('\\')) fail('INVALID_PATH', path + ' must use forward slashes.', { path, value });
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) fail('INVALID_PATH', path + ' must be workspace-relative, not absolute.', { path, value });
  if (value.endsWith('/')) fail('INVALID_PATH', path + ' must name an image file, not a directory.', { path, value });
  if (/[?#]/.test(value)) fail('INVALID_PATH', path + ' cannot contain query or fragment characters.', { path, value });
  for (const segment of value.split('/')) {
    if (!segment || segment === '.' || segment === '..') {
      fail('INVALID_PATH', path + ' cannot contain empty, "." or ".." path segments.', { path, value });
    }
  }
  return value;
}

function crop(value, path) {
  if (!Array.isArray(value) || value.length !== 4) fail('INVALID_CROP', path + ' must be [x, y, width, height].', { path });
  return [
    integer(value[0], path + '[0]', 0, THEME_LIMITS.image),
    integer(value[1], path + '[1]', 0, THEME_LIMITS.image),
    integer(value[2], path + '[2]', 1, THEME_LIMITS.image),
    integer(value[3], path + '[3]', 1, THEME_LIMITS.image),
  ];
}

function normalizeReferences(value, path) {
  if (!Array.isArray(value)) fail('INVALID_FIELD', path + ' must be an array.', { path });
  if (value.length > THEME_LIMITS.references) {
    fail('THEME_LIMIT', path + ' supports at most ' + THEME_LIMITS.references + ' references.', { path, limit: THEME_LIMITS.references, count: value.length });
  }
  const result = [];
  const ids = new Set();
  for (let index = 0; index < value.length; index++) {
    const itemPath = path + '[' + index + ']';
    fields(value[index], ['id', 'path', 'sha256', 'role', 'note', 'crop', 'observations', 'inferences'], itemPath);
    requireFields(value[index], ['id'], itemPath);
    const id = nameId(value[index].id, itemPath + '.id');
    if (ids.has(id)) fail('DUPLICATE_ID', path + ' contains duplicate reference id "' + id + '".', { path, id });
    ids.add(id);
    const reference = { id };
    if (owns(value[index], 'path')) reference.path = referencePath(value[index].path, itemPath + '.path');
    if (owns(value[index], 'sha256')) reference.sha256 = sha256Hex(value[index].sha256, itemPath + '.sha256');
    reference.role = owns(value[index], 'role') ? oneOf(value[index].role, ['reference', 'positive', 'negative'], itemPath + '.role') : 'reference';
    if (owns(value[index], 'note')) reference.note = cleanText(value[index].note, itemPath + '.note', THEME_LIMITS.referenceText);
    if (owns(value[index], 'crop')) reference.crop = crop(value[index].crop, itemPath + '.crop');
    if (owns(value[index], 'observations')) reference.observations = stringList(value[index].observations, itemPath + '.observations', THEME_LIMITS.referenceLists, THEME_LIMITS.referenceText);
    if (owns(value[index], 'inferences')) reference.inferences = stringList(value[index].inferences, itemPath + '.inferences', THEME_LIMITS.referenceLists, THEME_LIMITS.referenceText);
    result.push(reference);
  }
  return result;
}

function normalizeSource(value, path) {
  if (value === undefined) return { kind: 'concept' };
  fields(value, ['kind', 'brief', 'observations', 'inferences', 'decisions', 'unknowns'], path);
  requireFields(value, ['kind'], path);
  const source = { kind: oneOf(value.kind, ['concept', 'reference', 'hybrid'], path + '.kind') };
  if (owns(value, 'brief')) source.brief = cleanText(value.brief, path + '.brief', THEME_LIMITS.sourceBrief);
  for (const key of ['observations', 'inferences', 'decisions', 'unknowns']) {
    if (owns(value, key)) source[key] = stringList(value[key], path + '.' + key, THEME_LIMITS.sourceLists, THEME_LIMITS.sourceText);
  }
  return source;
}

function buildTheme(spec, options) {
  fields(options, ['id', 'revision'], 'options');
  if (!owns(options, 'id')) fail('THEME_ID', 'options.id is required; the theme service assigns the theme id.', { path: 'options.id' });
  const id = themeId(options.id, 'options.id');
  const revision = owns(options, 'revision') ? integer(options.revision, 'options.revision', 0, Number.MAX_SAFE_INTEGER) : 0;
  for (const key of ['format', 'id', 'revision']) {
    if (owns(spec, key)) {
      fail('THEME_SPEC', 'spec must omit ' + key + '; the theme service assigns format, id and revision.', { path: 'spec.' + key });
    }
  }
  fields(spec, ['title', 'summary', 'tags', 'signature', 'language', 'tokens', 'rules', 'adaptations', 'references', 'source'], 'spec');
  requireFields(spec, ['title', 'summary'], 'spec');
  const title = cleanLine(spec.title, 'spec.title', THEME_LIMITS.title);
  const summary = cleanText(spec.summary, 'spec.summary', THEME_LIMITS.summary);
  const tags = normalizeTags(owns(spec, 'tags') ? spec.tags : [], 'spec.tags');
  const language = normalizeLanguage(owns(spec, 'language') ? spec.language : {}, 'spec.language');
  const tokens = normalizeTokens(owns(spec, 'tokens') ? spec.tokens : {}, 'spec.tokens');
  const rules = normalizeRules(owns(spec, 'rules') ? spec.rules : [], 'spec.rules', tokens);
  const signature = normalizeSignature(owns(spec, 'signature') ? spec.signature : [], 'spec.signature', rules);
  const adaptations = normalizeAdaptations(owns(spec, 'adaptations') ? spec.adaptations : [], 'spec.adaptations');
  const references = normalizeReferences(owns(spec, 'references') ? spec.references : [], 'spec.references');
  const source = normalizeSource(owns(spec, 'source') ? spec.source : undefined, 'spec.source');
  const theme = { format: THEME_FORMAT, id, revision, title, summary, tags, signature, language, tokens, rules, adaptations, references, source };
  const bytes = Buffer.byteLength(stableJSON(theme));
  if (bytes > THEME_LIMITS.themeBytes) {
    fail('THEME_LIMIT', 'Theme is ' + bytes + ' bytes; the limit is ' + THEME_LIMITS.themeBytes + ' bytes per revision.', { bytes, limit: THEME_LIMITS.themeBytes });
  }
  return theme;
}

function firstDifference(left, right, path = 'theme') {
  if (left === right) return null;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return path;
    for (let index = 0; index < left.length; index++) {
      const difference = firstDifference(left[index], right[index], path + '[' + index + ']');
      if (difference) return difference;
    }
    return null;
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      if (!owns(left, key) || !owns(right, key)) return path + '.' + key;
      const difference = firstDifference(left[key], right[key], path + '.' + key);
      if (difference) return difference;
    }
    return null;
  }
  return path;
}

/** Stable sorted-key JSON used for hashes, receipts and canonical comparison. */
export function stableJSON(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(item => stableJSON(item)).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => JSON.stringify(key) + ':' + stableJSON(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** Recursively freeze canonical data. Returns the same value. */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * Normalize an authoring spec into one deep-frozen canonical revision.
 * options.id is required; options.revision defaults to 0. The spec must omit
 * format/id/revision: the service assigns them, and a supplied value is a
 * THEME_SPEC error rather than a second source of truth.
 */
export function normalizeTheme(spec, options = {}) {
  return deepFreeze(buildTheme(spec, options));
}

/** Validate a canonical revision without mutation. Returns the same theme. */
export function validateTheme(theme) {
  fields(theme, ['format', 'id', 'revision', 'title', 'summary', 'tags', 'signature', 'language', 'tokens', 'rules', 'adaptations', 'references', 'source'], 'theme');
  requireFields(theme, ['format', 'id', 'revision', 'title', 'summary', 'tags', 'signature', 'language', 'tokens', 'rules', 'adaptations', 'references', 'source'], 'theme');
  if (theme.format !== THEME_FORMAT) {
    fail('THEME_FORMAT', 'theme.format must be ' + THEME_FORMAT + '.', { path: 'theme.format', value: theme.format });
  }
  const spec = {
    title: theme.title,
    summary: theme.summary,
    tags: theme.tags,
    signature: theme.signature,
    language: theme.language,
    tokens: theme.tokens,
    rules: theme.rules,
    adaptations: theme.adaptations,
    references: theme.references,
    source: theme.source,
  };
  const canonical = buildTheme(spec, { id: theme.id, revision: theme.revision });
  const difference = firstDifference(canonical, theme);
  if (difference) {
    fail('NONCANONICAL_THEME', 'Theme is not canonical at ' + difference + '. Build themes with normalizeTheme; validateTheme accepts only canonical revisions.', { path: difference });
  }
  return theme;
}

/** SHA-256 of the canonical revision's stable sorted-key JSON. */
export function themeHash(theme) {
  validateTheme(theme);
  return createHash('sha256').update(stableJSON(theme)).digest('hex');
}

/** Validate a read context without mutation. Returns the same object. */
export function validateThemeContext(context = {}) {
  fields(context, ['assetClass', 'nativeSize', 'view', 'channels'], 'context');
  if (owns(context, 'assetClass')) nameId(context.assetClass, 'context.assetClass');
  if (owns(context, 'nativeSize')) {
    if (!Array.isArray(context.nativeSize) || context.nativeSize.length !== 2) {
      fail('INVALID_CONTEXT', 'context.nativeSize must be [width, height].', { path: 'context.nativeSize' });
    }
    integer(context.nativeSize[0], 'context.nativeSize[0]', 1, THEME_LIMITS.size);
    integer(context.nativeSize[1], 'context.nativeSize[1]', 1, THEME_LIMITS.size);
  }
  if (owns(context, 'view')) oneOf(context.view, ['top_down', 'three_quarter'], 'context.view');
  if (owns(context, 'channels')) {
    if (!Array.isArray(context.channels) || context.channels.length > 6) {
      fail('INVALID_CONTEXT', 'context.channels must be an array of at most 6 channels.', { path: 'context.channels' });
    }
    const seen = new Set();
    for (let index = 0; index < context.channels.length; index++) {
      const channel = oneOf(context.channels[index], ['beauty', 'normalmap', 'depth', 'normals', 'silhouette', 'nodes'], 'context.channels[' + index + ']');
      if (seen.has(channel)) fail('DUPLICATE_ID', 'context.channels contains duplicate "' + channel + '".', { path: 'context.channels', value: channel });
      seen.add(channel);
    }
  }
  return context;
}

/** Validate a pinned scene binding without external store access. */
export function validateThemeBinding(binding) {
  fields(binding, ['id', 'revision', 'hash', 'adapterVersion', 'snapshot', 'context', 'overrides'], 'binding');
  requireFields(binding, ['id', 'revision', 'hash', 'adapterVersion', 'snapshot', 'context', 'overrides'], 'binding');
  const id = themeId(binding.id, 'binding.id');
  const revision = integer(binding.revision, 'binding.revision', 0, Number.MAX_SAFE_INTEGER);
  if (typeof binding.hash !== 'string' || !/^[0-9a-f]{64}$/.test(binding.hash)) {
    fail('BINDING_HASH', 'binding.hash must be a lowercase SHA-256 hex digest.', { path: 'binding.hash', value: binding.hash });
  }
  if (binding.adapterVersion !== '1') {
    fail('BINDING_ADAPTER', 'binding.adapterVersion must be "1".', { path: 'binding.adapterVersion', value: binding.adapterVersion });
  }
  const snapshot = validateTheme(binding.snapshot);
  if (snapshot.id !== id) {
    fail('BINDING_ID', 'binding.id "' + id + '" does not match snapshot.id "' + snapshot.id + '".', { path: 'binding.id', id, snapshotId: snapshot.id });
  }
  if (snapshot.revision !== revision) {
    fail('BINDING_REVISION', 'binding.revision ' + revision + ' does not match snapshot.revision ' + snapshot.revision + '.', { path: 'binding.revision', revision, snapshotRevision: snapshot.revision });
  }
  const actual = themeHash(snapshot);
  if (actual !== binding.hash) {
    fail('BINDING_HASH', 'binding.hash does not match the snapshot hash.', { path: 'binding.hash', expected: actual, actual: binding.hash });
  }
  validateThemeContext(binding.context);
  if (!Array.isArray(binding.overrides)) fail('INVALID_FIELD', 'binding.overrides must be an array.', { path: 'binding.overrides' });
  if (binding.overrides.length > THEME_LIMITS.overrides) {
    fail('THEME_LIMIT', 'binding.overrides supports at most ' + THEME_LIMITS.overrides + ' entries.', { path: 'binding.overrides', limit: THEME_LIMITS.overrides, count: binding.overrides.length });
  }
  const known = new Set(snapshot.rules.map(rule => rule.id));
  const seen = new Set();
  for (let index = 0; index < binding.overrides.length; index++) {
    const itemPath = 'binding.overrides[' + index + ']';
    fields(binding.overrides[index], ['rule', 'reason'], itemPath);
    requireFields(binding.overrides[index], ['rule', 'reason'], itemPath);
    const rule = nameId(binding.overrides[index].rule, itemPath + '.rule');
    if (!known.has(rule)) {
      fail('BINDING_OVERRIDE', itemPath + '.rule refers to unknown rule "' + rule + '".', { path: itemPath + '.rule', available: [...known] });
    }
    if (seen.has(rule)) fail('DUPLICATE_OVERRIDE', 'binding.overrides contains duplicate rule "' + rule + '".', { path: itemPath + '.rule', rule });
    seen.add(rule);
    cleanText(binding.overrides[index].reason, itemPath + '.reason', THEME_LIMITS.overrideReason);
  }
  return binding;
}
