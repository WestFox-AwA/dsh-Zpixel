/** Pure format-2 scene data, validation and atomic editing. No I/O or revision changes. */
import { compose, inverse, multiply, worldTransforms, axisVector, axisBasis, rotationBetween, point, dot, normalize, cameraBasis } from './math.mjs';
import { applySpatialOperation } from './spatial.mjs';
import { validateThemeBinding } from './theme-model.mjs';

const FORMAT = 'dsh-zpixel/2';
const COORDINATES = 'right-handed-y-up';
/** Optional authoring contract for new spatial documents; absent means legacy. */
export const MODEL_FIRST_CONTRACT = 'model-first/1';
const CONTRACTS = Object.freeze([MODEL_FIRST_CONTRACT]);

export class ZPixelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ZPixelError';
    this.code = code;
    this.details = details;
  }
}
export function assert(condition, code, message, details = {}) {
  if (!condition) throw new ZPixelError(code, message, details);
}

const LIMIT = Object.freeze({ canvas: 256, nodes: 256, depth: 32, colors: 256,
  lights: 8, operations: 512, coordinate: 1e6, scale: 1e4, matrix: 1e12 });
const SCENE_KEYS = ['coordinates', 'format', 'id', 'title', 'revision', 'width', 'height', 'camera', 'contract',
  'palette', 'ramps', 'materials', 'lights', 'ambient', 'exposure', 'nodes', 'spatialRelations', 'theme'];
const ARG_KEYS = SCENE_KEYS.filter(key => !['format','coordinates','revision'].includes(key));
const COMMON_KEYS = ['id', 'kind', 'parent', 'name', 'visible', 'locked', 'transform', 'material', 'outline', 'role', 'tags', 'semanticFrame', 'anchors'];
const LAYER_KEYS = ['width', 'height', 'pixelSize', 'basis', 'pixels', 'castShadow', 'appearanceOf', 'appearanceShading'];
const PALETTE = Object.freeze({ ink: '#191827',
  stone0: '#34384a', stone1: '#606779', stone2: '#929cad', stone3: '#c8d2dc',
  wood0: '#3b2831', wood1: '#724837', wood2: '#ad7546', wood3: '#e7bb73',
  metal0: '#283e50', metal1: '#527387', metal2: '#8eb6bd', metal3: '#e0ece8', white: '#ffffff' });
const MATERIAL = Object.freeze({ diffuse: 1, emission: 0, specular: 0, roughness: 0.5 });
const ROOT_OUTLINE = Object.freeze({ enabled: true, color: 'ink', direction: 'inside', group: 'root', width: 1, occlusion: true });
const TRS = () => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] });
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const supplied = (object, key, fallback) => owns(object, key) ? object[key] : fallback;

function clone(value, path = 'value') {
  try { return structuredClone(value); }
  catch { throw new ZPixelError('INVALID_DATA', `${path} must contain cloneable scene data.`, { path }); }
}
function object(value, path) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  'INVALID_FIELD', `${path} must be a plain object.`, { path });
  assert(Object.getOwnPropertySymbols(value).length === 0, 'UNKNOWN_FIELD', `${path} cannot have symbol fields.`, { path });
  return value;
}
function fields(value, allowed, path) {
  object(value, path);
  for (const field of Object.keys(value)) assert(allowed.includes(field), 'UNKNOWN_FIELD',
    `Unknown field ${path}.${field}. Allowed fields: ${allowed.join(', ')}.`,
    { path: `${path}.${field}`, field, allowed });
}
function number(value, path, min = -LIMIT.coordinate, max = LIMIT.coordinate) {
  assert(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max,
    'INVALID_NUMBER', `${path} must be finite and between ${min} and ${max}.`, { path, value, min, max });
  return value;
}
function integer(value, path, min, max) {
  number(value, path, min, max);
  assert(Number.isSafeInteger(value), 'INVALID_INTEGER', `${path} must be an integer.`, { path, value });
  return value;
}
function boolean(value, path) {
  assert(typeof value === 'boolean', 'INVALID_FIELD', `${path} must be a boolean.`, { path, value });
}
function text(value, path, max = 256) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= max,
    'INVALID_FIELD', `${path} must be a nonempty string of at most ${max} characters.`, { path });
}
function id(value, path) {
  assert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) &&
    !['__proto__', 'prototype', 'constructor'].includes(value), 'INVALID_ID',
  `${path} must be 1–128 ASCII letters, digits, dots, colons, underscores or hyphens, starting with a letter or digit.`, { path, value });
  return value;
}
function vector(value, length, path, min = -LIMIT.coordinate, max = LIMIT.coordinate) {
  assert(Array.isArray(value) && value.length === length, 'INVALID_FIELD', `${path} must be an array of ${length} numbers.`, { path });
  for (let index = 0; index < length; index++) number(value[index], `${path}[${index}]`, min, max);
  return value;
}
function oneOf(value, values, path) {
  assert(values.includes(value), 'INVALID_FIELD', `${path} must be one of: ${values.join(', ')}.`, { path, value, allowed: values });
}
function dictionary(value, path) {
  object(value, path);
  const entries = Object.entries(value);
  assert(entries.length <= LIMIT.colors, 'LIMIT_EXCEEDED', `${path} supports at most ${LIMIT.colors} entries.`, { path, limit: LIMIT.colors });
  for (const [key] of entries) id(key, `${path}.${key}`);
  return entries;
}
function hex(value, path) {
  assert(typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value), 'INVALID_COLOR', `${path} must be an opaque #RRGGBB color.`, { path, value });
  return value.toLowerCase();
}
function colorRef(value, scene, usedColors, path) {
  assert(typeof value === 'string', 'INVALID_COLOR', `${path} must be a palette ID or opaque #RRGGBB color; use null for transparent layer pixels.`, { path, value });
  let resolved;
  if (value.startsWith('#')) resolved = hex(value, path);
  else {
    assert(owns(scene.palette, value), 'INVALID_REFERENCE', `${path} refers to unknown palette color "${value}".`, { path, value, available: Object.keys(scene.palette) });
    resolved = scene.palette[value].toLowerCase();
  }
  usedColors.add(resolved);
}

function invert(matrix, path) {
  try {
    const result = inverse(matrix);
    assert(result.every(Number.isFinite), 'INVALID_TRANSFORM', `${path} has no finite inverse.`, { path });
    return result;
  } catch (error) {
    if (error instanceof ZPixelError) throw error;
    throw new ZPixelError('INVALID_TRANSFORM', `${path} is singular or too close to singular. Use nonzero scales.`, { path });
  }
}
function validateTransform(value, path) {
  fields(value, ['position', 'rotation', 'scale', 'pivot', 'matrix'], path);
  if (owns(value, 'matrix')) {
    assert(Object.keys(value).length === 1, 'INVALID_TRANSFORM', `${path}.matrix cannot be combined with position, rotation, scale or pivot.`, { path });
    const matrix = vector(value.matrix, 16, `${path}.matrix`, -LIMIT.matrix, LIMIT.matrix);
    assert(matrix[3] === 0 && matrix[7] === 0 && matrix[11] === 0 && matrix[15] === 1,
      'INVALID_TRANSFORM', `${path}.matrix must be affine, with column-major last row [0,0,0,1].`, { path });
    for (const index of [12, 13, 14]) number(matrix[index], `${path}.matrix[${index}]`);
    invert(matrix, path);
    return;
  }
  for (const [key, fallback] of Object.entries(TRS())) {
    const item = owns(value, key) ? value[key] : fallback;
    vector(item, 3, `${path}.${key}`, key === 'rotation' ? -360000 : -LIMIT.coordinate,
      key === 'rotation' ? 360000 : LIMIT.coordinate);
    if (key === 'scale') item.forEach((scale, index) => assert(Math.abs(scale) >= 1e-6 && Math.abs(scale) <= LIMIT.scale,
      'INVALID_TRANSFORM', `${path}.scale[${index}] must have absolute value between 0.000001 and ${LIMIT.scale}.`, { path, value: scale }));
  }
}
function normalizeTransform(value, path) {
  validateTransform(value, path);
  return owns(value, 'matrix') ? clone(value) : { ...TRS(), ...clone(value) };
}
function normalizeCamera(value, width, height, base) {
  fields(value, ['preset','position','target','up','mirrorX','pixelsPerUnit','center'], 'camera');
  assert(!(owns(value,'preset') && owns(value,'position')), 'CAMERA_FIELDS', 'Use preset or position, not both.');
  const target = clone(value.target ?? base?.target ?? [0,0,0]);
  const preset = value.preset ?? (!base && !owns(value,'position') ? 'three_quarter' : undefined);
  if (preset !== undefined) oneOf(preset,['top_down','three_quarter'],'camera.preset');
  const angle=55*Math.PI/180;
  const offset=preset==='top_down'?[0,100,0]:[0,100*Math.sin(angle),100*Math.cos(angle)];
  const position=clone(value.position ?? (preset?target.map((v,i)=>v+offset[i]):base?.position ?? [0,100,0]));
  const up=normalize(clone(value.up ?? (preset==='top_down'?[0,0,-1]:preset?[0,1,0]:base?.up ?? [0,1,0])));
  return {position,target,up,mirrorX:value.mirrorX ?? base?.mirrorX ?? false,pixelsPerUnit:value.pixelsPerUnit ?? base?.pixelsPerUnit ?? 1,center:clone(value.center ?? base?.center ?? [width/2,height/2])};
}
function validateCamera(value, path='scene.camera') {
  fields(value,['position','target','up','mirrorX','pixelsPerUnit','center'],path);
  vector(value.position,3,path+'.position',-1e8,1e8); vector(value.target,3,path+'.target'); vector(value.up,3,path+'.up');
  assert(Math.abs(Math.hypot(...value.up)-1)<1e-6,'CAMERA_UP','Camera up must be a unit vector.');
  boolean(value.mirrorX,path+'.mirrorX'); number(value.pixelsPerUnit,path+'.pixelsPerUnit',1e-4,1e4);vector(value.center,2,path+'.center');
  cameraBasis(value);
}
/** Resolve a camera request (preset sugar or explicit fields) against the stored delivery camera. */
export function resolveSceneCamera(value, scene) {
  fields(value, ['preset','position','target','up','mirrorX','pixelsPerUnit','center'], 'camera');
  const camera=normalizeCamera(value,scene.width,scene.height,scene.camera);
  try{validateCamera(camera);}catch(error){
    // Preserve specific camera field errors (pixelsPerUnit/center/up); only a
    // raw cameraBasis failure is a degenerate-view error.
    if(error instanceof ZPixelError)throw error;
    throw new ZPixelError('CAMERA_BASIS','camera position, target and up must define a nondegenerate orthographic view.',{path:'camera',cause:error.message});
  }
  return camera;
}
function normalizeGeometry(value,path) {
  object(value,path);
  const g=clone(value);
  if(g.type==='box') {
    fields(g,['type','min','max','center','size'],path);
    if(owns(g,'center')||owns(g,'size')) {
      assert(!owns(g,'min')&&!owns(g,'max'),'GEOMETRY_FIELDS','Box uses center+size OR min+max.');
      vector(g.center,3,path+'.center');vector(g.size,3,path+'.size',1e-6,LIMIT.coordinate);
      return {type:'box',min:g.center.map((v,i)=>v-g.size[i]/2),max:g.center.map((v,i)=>v+g.size[i]/2)};
    }
    return g;
  }
  if(g.type==='cylinder') {
    fields(g,['type','center','radius','length','axis','from','to'],path);
    if(owns(g,'from')||owns(g,'to')) {
      assert(!owns(g,'center')&&!owns(g,'length')&&!owns(g,'axis'),'GEOMETRY_FIELDS','Cylinder uses from+to OR center+length+axis.');
      vector(g.from,3,path+'.from');vector(g.to,3,path+'.to');const delta=g.to.map((v,i)=>v-g.from[i]);
      assert(Math.hypot(...delta)>=1e-6,'INVALID_GEOMETRY','Cylinder from/to endpoints must be distinct.');
      return {type:'cylinder',center:g.from.map((v,i)=>(v+g.to[i])/2),radius:g.radius,length:Math.hypot(...delta),axis:axisVector(delta)};
    }
    return {type:'cylinder',center:g.center??[0,0,0],radius:g.radius,length:g.length,axis:axisVector(g.axis??'y')};
  }
  if(g.type==='extrude') {
    fields(g,['type','points','range','axis'],path);
    return {type:'extrude',points:g.points,range:g.range,axis:axisVector(g.axis??'y')};
  }
  return g;
}
function normalizeSemanticFrame(value,path='node.semanticFrame') {
  fields(value,['forward','up'],path);
  const forward=axisVector(value.forward),up=axisVector(value.up);
  assert(Math.abs(dot(forward,up))<1e-6,'FRAME_AXES',`${path}.forward/up must be perpendicular.`);
  return {forward,up};
}
function normalizeAnchors(value={},path='node.anchors') {
  object(value,path);const result={};
  for(const [name,anchor] of Object.entries(value)){
    text(name,`${path} key`,64);fields(anchor,['point','normal','tangent','axis'],`${path}.${name}`);
    const normalized={point:vector(anchor.point,3,`${path}.${name}.point`)};
    for(const key of ['normal','tangent','axis'])if(anchor[key]!==undefined)normalized[key]=axisVector(anchor[key]);
    if(normalized.normal&&normalized.tangent)assert(Math.abs(dot(normalized.normal,normalized.tangent))<1e-6,'ANCHOR_FRAME',`${path}.${name} normal/tangent must be perpendicular.`);
    result[name]=normalized;
  }
  return result;
}
/** Complete-scene validation only; canonical unit vectors are required and never rewritten. */
function validateAnchors(value,path) {
  object(value,path);
  for(const [name,anchor] of Object.entries(value)){
    text(name,`${path} key`,64);fields(anchor,['point','normal','tangent','axis'],`${path}.${name}`);
    vector(anchor.point,3,`${path}.${name}.point`);
    for(const key of ['normal','tangent','axis'])if(anchor[key]!==undefined){
      vector(anchor[key],3,`${path}.${name}.${key}`);
      assert(Math.abs(Math.hypot(...anchor[key])-1)<1e-6,'ANCHOR_FRAME',`${path}.${name}.${key} must be a unit vector; normalize the anchor before validation.`,{path:`${path}.${name}.${key}`});
    }
    if(anchor.normal!==undefined&&anchor.tangent!==undefined)assert(Math.abs(dot(anchor.normal,anchor.tangent))<1e-6,'ANCHOR_FRAME',`${path}.${name} normal/tangent must be perpendicular.`);
  }
}
function validateSemanticFrame(value,path) {
  fields(value,['forward','up'],path);
  vector(value.forward,3,`${path}.forward`);vector(value.up,3,`${path}.up`);
  assert(Math.abs(Math.hypot(...value.forward)-1)<1e-6&&Math.abs(Math.hypot(...value.up)-1)<1e-6,'FRAME_AXES',`${path}.forward/up must be unit vectors; normalize the semantic frame before validation.`);
  assert(Math.abs(dot(value.forward,value.up))<1e-6,'FRAME_AXES',`${path}.forward/up must be perpendicular.`);
}
function normalizeSpatialRelation(value,path='spatialRelations[]') {
  fields(value,['id','from','relation','to','tolerance','angleTolerance','distanceTolerance','signedAxis'],path);
  id(value.id,path+'.id');oneOf(value.relation,['contact','support','avoid_intersection','allow_overlap','coaxial'],path+'.relation');
  const endpoint=(v,p)=>{fields(v,['node','anchor'],p);id(v.node,p+'.node');if(v.anchor!==undefined)text(v.anchor,p+'.anchor',64);return {...v};};
  const edge={id:value.id,from:endpoint(value.from,path+'.from'),relation:value.relation,to:endpoint(value.to,path+'.to')};
  if(value.tolerance!==undefined)edge.tolerance=number(value.tolerance,path+'.tolerance',0,LIMIT.coordinate);
  if(value.angleTolerance!==undefined)edge.angleTolerance=number(value.angleTolerance,path+'.angleTolerance',0,180);
  if(value.distanceTolerance!==undefined)edge.distanceTolerance=number(value.distanceTolerance,path+'.distanceTolerance',0,LIMIT.coordinate);
  if(value.signedAxis!==undefined){boolean(value.signedAxis,path+'.signedAxis');edge.signedAxis=value.signedAxis;}
  return edge;
}
const endpointKey=e=>`${e.node}#${e.anchor??''}`;
const canonicalPair=(a,b)=>[endpointKey(a),endpointKey(b)].sort().join('|');
function validateSpatialRelations(scene) {
  assert(Array.isArray(scene.spatialRelations)&&scene.spatialRelations.length<=2048,'RELATION_LIMIT','scene.spatialRelations must be an array with at most2048 edges.');
  const ids=new Set(),pairs=new Map(),nodeMap=new Map(scene.nodes.map(n=>[n.id,n]));
  for(const [index,raw] of scene.spatialRelations.entries()){
    const edge=normalizeSpatialRelation(raw,`scene.spatialRelations[${index}]`);
    assert(!ids.has(edge.id),'DUPLICATE_ID',`Duplicate spatial relation id ${edge.id}.`);ids.add(edge.id);
    assert(edge.from.node!==edge.to.node,'RELATION_REFERENCE','Spatial relation endpoints must refer to distinct nodes.');
    for(const endpoint of [edge.from,edge.to]){const node=nodeMap.get(endpoint.node);assert(node,'RELATION_REFERENCE',`Spatial relation ${edge.id} refers to unknown node ${endpoint.node}.`);assert(node.appearanceOf===undefined,'APPEARANCE_NOT_PHYSICAL',`Spatial relation ${edge.id} endpoint ${endpoint.node} is a bound appearance layer; it has no physical geometry and cannot participate in spatial relations.`,{relation:edge.id,node:endpoint.node,appearanceOf:node.appearanceOf});if(endpoint.anchor!==undefined)assert(Object.hasOwn(node.anchors??{},endpoint.anchor),'ANCHOR_NOT_FOUND',`Spatial relation ${edge.id} refers to unknown anchor ${endpoint.node}#${endpoint.anchor}.`);}
    const pair=canonicalPair(edge.from,edge.to),old=pairs.get(pair)??new Set();
    if(edge.relation==='avoid_intersection')assert(!old.has('allow_overlap'),'RELATION_CONTRADICTION','avoid_intersection conflicts with allow_overlap for the same canonical pair.');
    if(edge.relation==='allow_overlap')assert(!old.has('avoid_intersection'),'RELATION_CONTRADICTION','allow_overlap conflicts with avoid_intersection for the same canonical pair.');
    const normalizedPair=pair.split('|').join('|');assert(!old.has(edge.relation)||edge.relation==='contact'&&raw.replaceable===true,'DUPLICATE_RELATION',`Duplicate ${edge.relation} edge for ${normalizedPair}.`);old.add(edge.relation);pairs.set(pair,old);
  }
}

function orientTransform(transform,orientation,frame) {
  fields(orientation,['axis','toward'],'node.orientation');
  assert(!transform.matrix && (!transform.rotation || transform.rotation.every(v=>v===0)),'ORIENTATION_CONFLICT','Use orientation OR transform.rotation/matrix.');
  const rot=rotationBetween(axisVector(orientation.axis??frame.forward),axisVector(orientation.toward));
  const scale=compose({scale:transform.scale??[1,1,1]}),matrix=multiply(rot,scale),pivot=transform.pivot??[0,0,0],position=transform.position??[0,0,0],q=point(matrix,pivot);
  [12,13,14].forEach((k,i)=>matrix[k]=position[i]+pivot[i]-q[i]);return {matrix};
}
function validateRamp(value, scene, usedColors, path) {
  fields(value, ['stops', 'response'], path);
  number(value.response, `${path}.response`, 1e-4, 16);
  assert(Array.isArray(value.stops) && value.stops.length >= 1 && value.stops.length <= 256,
    'INVALID_RAMP', `${path}.stops must contain 1–256 strictly ordered stops.`, { path });
  for (let index = 0; index < value.stops.length; index++) {
    const stop = value.stops[index], stopPath = `${path}.stops[${index}]`;
    fields(stop, ['at', 'color'], stopPath);
    number(stop.at, `${stopPath}.at`, 0, 64);
    assert(index === 0 || stop.at > value.stops[index - 1].at, 'INVALID_RAMP', `${stopPath}.at must be greater than the previous stop.`, { path: stopPath });
    colorRef(stop.color, scene, usedColors, `${stopPath}.color`);
  }
}
function validateMaterial(value, scene, path) {
  fields(value, ['ramp', 'diffuse', 'emission', 'specular', 'roughness'], path);
  assert(typeof value.ramp === 'string' && owns(scene.ramps, value.ramp), 'INVALID_REFERENCE',
    `${path}.ramp refers to unknown ramp "${value.ramp}".`, { path: `${path}.ramp`, available: Object.keys(scene.ramps) });
  number(value.diffuse, `${path}.diffuse`, 0, 16); number(value.emission, `${path}.emission`, 0, 16);
  assert(value.specular === 0, 'UNSUPPORTED_MATERIAL', `${path}.specular must be 0 in version 0.3; specular highlights are not implemented.`, { path: `${path}.specular` }); number(value.roughness, `${path}.roughness`, 0, 1);
}
function validateLight(value, path) {
  fields(value, ['id', 'type', 'position', 'direction', 'intensity', 'range', 'color'], path);
  id(value.id, `${path}.id`); oneOf(value.type, ['point', 'directional'], `${path}.type`);
  vector(value.position, 3, `${path}.position`); vector(value.direction, 3, `${path}.direction`);
  if (value.type === 'directional') assert(Math.hypot(...value.direction) > 1e-8, 'INVALID_LIGHT', `${path}.direction must be nonzero for a directional light.`, { path });
  number(value.intensity, `${path}.intensity`, 0, 64); number(value.range, `${path}.range`, 0, LIMIT.coordinate);
  assert(hex(value.color, `${path}.color`) === '#ffffff', 'UNSUPPORTED_LIGHT_COLOR', `${path}.color must be #ffffff. Only white light colors are supported.`, { path: `${path}.color`, value: value.color });
}
function normalizeLight(value, path, fixedId) {
  fields(value, ['id', 'type', 'position', 'direction', 'intensity', 'range', 'color'], path);
  if (fixedId !== undefined && owns(value, 'id')) assert(value.id === fixedId, 'INVALID_ID', `${path}.id must equal the operation id; light_set cannot rename a light.`, { path, id: fixedId });
  return { type: 'point', position: [-40, 80, 60], direction: [1, -2, -1], intensity: 1, range: 0,
    color: '#ffffff', ...clone(value), ...(fixedId === undefined ? {} : { id: fixedId }) };
}
function validateOutline(value, scene, usedColors, path) {
  fields(value, ['enabled', 'color', 'direction', 'group', 'width', 'occlusion'], path);
  if (owns(value, 'enabled')) boolean(value.enabled, `${path}.enabled`);
  if (owns(value, 'direction')) oneOf(value.direction, ['inside', 'outside'], `${path}.direction`);
  if (owns(value, 'color')) colorRef(value.color, scene, usedColors, `${path}.color`);
  if (owns(value, 'group')) text(value.group, `${path}.group`, 128);
  if (owns(value, 'width')) assert(value.width === 1, 'INVALID_OUTLINE', `${path}.width must be 1 in version 0.3.`, { path, value: value.width });
  if (owns(value, 'occlusion')) boolean(value.occlusion, `${path}.occlusion`);
}

const turn = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function onSegment(a, b, p) {
  return Math.abs(turn(a, b, p)) <= 1e-10 && p[0] >= Math.min(a[0], b[0]) - 1e-10 &&
    p[0] <= Math.max(a[0], b[0]) + 1e-10 && p[1] >= Math.min(a[1], b[1]) - 1e-10 && p[1] <= Math.max(a[1], b[1]) + 1e-10;
}
function segmentsIntersect(a, b, c, d) {
  const t1 = turn(a, b, c), t2 = turn(a, b, d), t3 = turn(c, d, a), t4 = turn(c, d, b);
  return ((t1 > 0 && t2 < 0 || t1 < 0 && t2 > 0) && (t3 > 0 && t4 < 0 || t3 < 0 && t4 > 0)) ||
    onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
function validateGeometry(value, path) {
  object(value, path);
  oneOf(value.type, ['box', 'ellipsoid', 'cylinder', 'extrude'], `${path}.type`);
  const keys = { box: ['type', 'min', 'max'], ellipsoid: ['type', 'center', 'radii'],
    cylinder: ['type', 'center', 'radius', 'length', 'axis'], extrude: ['type', 'points', 'range', 'axis'] };
  fields(value, keys[value.type], path);
  if (value.type === 'box') {
    vector(value.min, 3, `${path}.min`); vector(value.max, 3, `${path}.max`);
    assert(value.max.every((component, index) => component - value.min[index] >= 1e-6), 'INVALID_GEOMETRY', `${path}.max must exceed min by at least 0.000001 on every axis.`, { path });
  } else if (value.type === 'ellipsoid') {
    vector(value.center, 3, `${path}.center`); vector(value.radii, 3, `${path}.radii`, 1e-6, LIMIT.coordinate);
  } else if (value.type === 'cylinder') {
    vector(value.center, 3, `${path}.center`); number(value.radius, `${path}.radius`, 1e-6, LIMIT.coordinate);
    number(value.length, `${path}.length`, 1e-6, LIMIT.coordinate); vector(value.axis,3,`${path}.axis`); assert(Math.abs(Math.hypot(...value.axis)-1)<1e-6,'GEOMETRY_AXIS','Cylinder axis must be unit.');
  } else {
    assert(Array.isArray(value.points) && value.points.length >= 3 && value.points.length <= 256, 'INVALID_GEOMETRY', `${path}.points must contain 3–256 distinct vertices of a simple polygon.`, { path });
    vector(value.range, 2, `${path}.range`);
    assert(value.range[1] - value.range[0] >= 1e-6, 'INVALID_GEOMETRY', `${path}.range must have increasing bounds.`, { path });
    vector(value.axis,3,`${path}.axis`); assert(Math.abs(Math.hypot(...value.axis)-1)<1e-6,'GEOMETRY_AXIS','Extrude axis must be unit.');
    const points = value.points, count = points.length;
    for (let index = 0; index < count; index++) vector(points[index], 2, `${path}.points[${index}]`);
    let area = 0;
    for (let index = 0; index < count; index++) {
      const a = points[index], b = points[(index + 1) % count], c = points[(index + 2) % count];
      assert(Math.hypot(a[0] - b[0], a[1] - b[1]) >= 1e-6, 'INVALID_GEOMETRY', `${path}.points has adjacent duplicate vertices; do not repeat the closing vertex.`, { path, index });
      assert(!(Math.abs(turn(a, b, c)) <= 1e-10 && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0), 'INVALID_GEOMETRY', `${path}.points doubles back along an adjacent edge.`, { path, index });
      area += a[0] * b[1] - b[0] * a[1];
      for (let other = index + 1; other < count; other++) {
        if (other === index + 1 || index === 0 && other === count - 1) continue;
        assert(!segmentsIntersect(a, b, points[other], points[(other + 1) % count]), 'INVALID_GEOMETRY', `${path}.points must not intersect or touch nonadjacent edges.`, { path, edges: [index, other] });
      }
    }
    assert(Math.abs(area) > 1e-10, 'INVALID_GEOMETRY', `${path}.points must enclose nonzero area.`, { path });
  }
}
function nodeKeys(kind) {
  return [...COMMON_KEYS, ...(kind === 'part' ? ['geometry', 'castShadow'] : kind === 'layer' ? LAYER_KEYS : [])];
}
function normalizeNode(value, scene, path) {
  object(value, path); oneOf(value.kind, ['group', 'part', 'layer'], `${path}.kind`);
  fields(value,[...nodeKeys(value.kind),'orientation',...(value.kind==='layer'?['plane']:[])],path);id(value.id,`${path}.id`);
  const root=value.id==='root';
  const node={id:value.id,kind:value.kind,parent:root?null:'root',name:value.id,visible:true,locked:false,transform:TRS(),role:'',tags:[],anchors:{},...clone(value)};
  node.anchors=normalizeAnchors(value.anchors??{},`${path}.anchors`);
  if(value.semanticFrame!==undefined)node.semanticFrame=normalizeSemanticFrame(value.semanticFrame,`${path}.semanticFrame`);
  if(value.orientation){assert(value.orientation.axis!==undefined||node.semanticFrame,'FRAME_UNDECLARED','orientation.axis or semanticFrame.forward is required; no default asset front exists.');node.transform=orientTransform(node.transform,value.orientation,node.semanticFrame??{forward:[0,0,0]});delete node.orientation;}
  if(node.kind==='part')node.geometry=normalizeGeometry(node.geometry,path+'.geometry');
  node.transform = normalizeTransform(node.transform, `${path}.transform`);
  if (root) {
    node.material = value.material ?? 'stone';
    if (value.outline !== undefined && value.outline !== null) fields(value.outline, ['enabled', 'color', 'direction', 'group', 'width', 'occlusion'], `${path}.outline`);
    node.outline = { ...ROOT_OUTLINE, ...(value.outline ?? {}) };
  } else if (node.material === null) delete node.material;
  if (!root && node.outline === null) delete node.outline;
  if (node.kind === 'part' && !owns(value, 'castShadow')) node.castShadow = true;
  if (node.kind === 'layer') {
    node.width = supplied(value, 'width', scene.width); node.height = supplied(value, 'height', scene.height);
    integer(node.width, `${path}.width`, 1, LIMIT.canvas); integer(node.height, `${path}.height`, 1, LIMIT.canvas);
    node.pixelSize = supplied(value, 'pixelSize', 1);
    assert(!(owns(value,'basis')&&owns(value,'plane')),'LAYER_BASIS','Use layer basis OR plane.');
    const view=cameraBasis(scene),bases={xz:{u:[1,0,0],v:[0,0,-1]},xy:{u:[1,0,0],v:[0,-1,0]},yz:{u:[0,0,1],v:[0,-1,0]},view:{u:view.right,v:view.down}};
    if(value.plane!==undefined)oneOf(value.plane,Object.keys(bases),path+'.plane');
    node.basis=clone(value.basis??bases[value.plane??'xz']);delete node.plane;
    node.castShadow = supplied(value, 'castShadow', false);
    if (owns(value, 'appearanceOf')) {
      id(value.appearanceOf, `${path}.appearanceOf`);
      node.appearanceOf = value.appearanceOf;
    }
    if (owns(value, 'appearanceShading')) {
      assert(node.appearanceOf !== undefined, 'APPEARANCE_SHADING',
        `${path}.appearanceShading is valid only on a layer bound by appearanceOf.`, { path: `${path}.appearanceShading` });
      oneOf(value.appearanceShading, ['lit', 'unlit'], `${path}.appearanceShading`);
      node.appearanceShading = value.appearanceShading;
    }
    if (!owns(value, 'pixels')) node.pixels = Array(node.width * node.height).fill(null);
    if (node.outline !== undefined) fields(node.outline, ['enabled', 'color', 'direction', 'group', 'width', 'occlusion'], `${path}.outline`);
    node.outline = { enabled: false, ...(node.outline ?? {}) };
  }
  return node;
}
function validateNode(node, scene, usedColors, path) {
  object(node, path); oneOf(node.kind, ['group', 'part', 'layer'], `${path}.kind`); fields(node, nodeKeys(node.kind), path);
  id(node.id, `${path}.id`);
  if (node.id === 'root') assert(node.kind === 'group' && node.parent === null, 'INVALID_ROOT', 'The root node must have id "root", kind "group" and parent null.', { path });
  else id(node.parent, `${path}.parent`);
  text(node.name, `${path}.name`);
  assert(typeof node.role==='string'&&node.role.length<=128,'NODE_ROLE','Node role must be a bounded string.');
  assert(Array.isArray(node.tags)&&node.tags.length<=32,'NODE_TAGS','Node tags must be a bounded array.');node.tags.forEach(v=>text(v,path+'.tags',64));
  validateAnchors(node.anchors??{},path+'.anchors');
  if(node.semanticFrame!==undefined)validateSemanticFrame(node.semanticFrame,path+'.semanticFrame');
  boolean(node.visible, `${path}.visible`); boolean(node.locked, `${path}.locked`);
  validateTransform(node.transform, `${path}.transform`);
  if (owns(node, 'material')) assert(typeof node.material === 'string' && owns(scene.materials, node.material), 'INVALID_REFERENCE', `${path}.material refers to unknown material "${node.material}".`, { path: `${path}.material`, available: Object.keys(scene.materials) });
  if (owns(node, 'outline')) validateOutline(node.outline, scene, usedColors, `${path}.outline`);
  if (node.kind === 'part') {
    validateGeometry(node.geometry, `${path}.geometry`); boolean(node.castShadow, `${path}.castShadow`);
  } else if (node.kind === 'layer') {
    integer(node.width, `${path}.width`, 1, LIMIT.canvas); integer(node.height, `${path}.height`, 1, LIMIT.canvas);
    number(node.pixelSize, `${path}.pixelSize`, 1e-6, 1e4);fields(node.basis,['u','v'],path+'.basis');
    vector(node.basis.u,3,path+'.basis.u');vector(node.basis.v,3,path+'.basis.v');assert(Math.abs(Math.hypot(...node.basis.u)-1)<1e-6&&Math.abs(Math.hypot(...node.basis.v)-1)<1e-6&&Math.abs(dot(node.basis.u,node.basis.v))<1e-6,'LAYER_BASIS','Layer basis vectors must be perpendicular unit vectors.');
    boolean(node.castShadow, `${path}.castShadow`);
    if (owns(node, 'appearanceOf')) {
      id(node.appearanceOf, `${path}.appearanceOf`);
      assert(node.castShadow === false, 'APPEARANCE_CAST_SHADOW', `${path}.castShadow must be false on a bound appearance layer; it has no shadow geometry of its own.`, { path: `${path}.castShadow`, value: node.castShadow });
      assert(node.outline === undefined || node.outline.enabled === false, 'APPEARANCE_OUTLINE', `${path}.outline.enabled must be false on a bound appearance layer; it has no outline of its own.`, { path: `${path}.outline.enabled`, value: node.outline?.enabled });
      assert(Object.keys(node.anchors ?? {}).length === 0, 'APPEARANCE_ANCHORS', `${path}.anchors must be empty on a bound appearance layer; it has no physical anchors.`, { path: `${path}.anchors`, anchors: Object.keys(node.anchors ?? {}) });
      if (owns(node, 'appearanceShading')) oneOf(node.appearanceShading, ['lit', 'unlit'], `${path}.appearanceShading`);
    } else {
      assert(!owns(node, 'appearanceShading'), 'APPEARANCE_SHADING', `${path}.appearanceShading is valid only on a layer bound by appearanceOf.`, { path: `${path}.appearanceShading` });
    }
    assert(Array.isArray(node.pixels) && node.pixels.length === node.width * node.height, 'INVALID_PIXELS', `${path}.pixels must contain exactly width*height (${node.width * node.height}) entries.`, { path });
    for (let index = 0; index < node.pixels.length; index++) if (node.pixels[index] !== null) colorRef(node.pixels[index], scene, usedColors, `${path}.pixels[${index}]`);
  }
}
function hierarchy(scene) {
  const nodes = new Map();
  for (const node of scene.nodes) {
    assert(!nodes.has(node.id), 'DUPLICATE_ID', `Duplicate node id "${node.id}".`, { id: node.id });
    nodes.set(node.id, node);
  }
  assert(nodes.has('root'), 'INVALID_ROOT', 'Scene must contain a group with id "root" and parent null.');
  const depths = new Map(), visiting = new Set();
  const visit = node => {
    if (depths.has(node.id)) return depths.get(node.id);
    assert(!visiting.has(node.id), 'CYCLE', `Cycle detected at node "${node.id}".`, { id: node.id });
    visiting.add(node.id);
    let depth = 0;
    if (node.id !== 'root') {
      assert(nodes.has(node.parent), 'NODE_NOT_FOUND', `Node "${node.id}" has unknown parent "${node.parent}".`, { id: node.id, parent: node.parent });
      depth = visit(nodes.get(node.parent)) + 1;
    }
    assert(depth <= LIMIT.depth, 'LIMIT_EXCEEDED', `Node "${node.id}" exceeds maximum tree depth ${LIMIT.depth} (root depth 0).`, { id: node.id, depth, limit: LIMIT.depth });
    visiting.delete(node.id); depths.set(node.id, depth); return depth;
  };
  for (const node of nodes.values()) visit(node);
  return { nodes, depths };
}
/** Final opt-in appearance binding checks; requires the validated hierarchy. */
function validateAppearances(scene) {
  const nodes = new Map(scene.nodes.map(node => [node.id, node]));
  const children = new Map(scene.nodes.map(node => [node.id, []]));
  for (const node of scene.nodes) if (node.parent !== null) children.get(node.parent)?.push(node.id);
  const owners = new Map();
  for (const node of scene.nodes) {
    if (node.kind !== 'layer') continue;
    if (!owns(node, 'appearanceOf')) {
      assert(!owns(node, 'appearanceShading'), 'APPEARANCE_SHADING', `Layer "${node.id}" has appearanceShading but no appearanceOf.`, { id: node.id, path: 'appearanceShading' });
      continue;
    }
    const owner = nodes.get(node.appearanceOf);
    assert(owner, 'INVALID_REFERENCE', `Layer "${node.id}" appearanceOf refers to unknown node "${node.appearanceOf}".`, { id: node.id, appearanceOf: node.appearanceOf });
    assert(owner.kind === 'part', 'APPEARANCE_OWNER', `Layer "${node.id}" appearanceOf must refer to a part; "${node.appearanceOf}" is a ${owner.kind}.`, { id: node.id, appearanceOf: node.appearanceOf, kind: owner.kind });
    assert(node.parent === node.appearanceOf, 'APPEARANCE_PARENT', `Layer "${node.id}" is bound to part "${node.appearanceOf}" but its parent is "${node.parent}"; a bound appearance layer must be a direct child of its part.`, { id: node.id, parent: node.parent, appearanceOf: node.appearanceOf });
    const childIds = children.get(node.id) ?? [];
    assert(childIds.length === 0, 'APPEARANCE_LEAF', `Layer "${node.id}" is a bound appearance and must be a leaf; it has child "${childIds[0]}".`, { id: node.id, children: childIds });
    assert(!owners.has(node.appearanceOf), 'APPEARANCE_DUPLICATE', `Part "${node.appearanceOf}" already has bound appearance layer "${owners.get(node.appearanceOf)}"; layer "${node.id}" is a second one. A part may have at most one bound appearance layer, including hidden layers.`, { part: node.appearanceOf, existing: owners.get(node.appearanceOf), duplicate: node.id });
    owners.set(node.appearanceOf, node.id);
  }
}

/** Validate a complete normalized scene without modifying it. Returns the same scene. */
export function validateScene(scene) {
  assert(scene?.format!=='dsh-zpixel/1','MIGRATION_REQUIRED','Legacy Z-up scene: use zpixel_scene action:migrate to create a Y-up copy.');
  fields(scene, SCENE_KEYS, 'scene');
  assert(scene.format==='dsh-zpixel/2'&&scene.coordinates==='right-handed-y-up','INVALID_FORMAT','Expected dsh-zpixel/2 with right-handed-y-up coordinates.');
  if(owns(scene,'contract'))oneOf(scene.contract,CONTRACTS,'scene.contract');
  id(scene.id, 'scene.id'); text(scene.title, 'scene.title'); integer(scene.revision, 'scene.revision', 0, Number.MAX_SAFE_INTEGER);
  integer(scene.width, 'scene.width', 1, LIMIT.canvas); integer(scene.height, 'scene.height', 1, LIMIT.canvas);
  validateCamera(scene.camera); number(scene.ambient, 'scene.ambient', 0, 1); number(scene.exposure, 'scene.exposure', 0, 16);
  if(owns(scene,'theme'))validateThemeBinding(scene.theme);
  const usedColors = new Set(), colors = dictionary(scene.palette, 'scene.palette');
  assert(colors.length > 0, 'INVALID_PALETTE', 'scene.palette must contain at least one opaque color.');
  for (const [key, color] of colors) usedColors.add(hex(color, `scene.palette.${key}`));
  for (const [key, ramp] of dictionary(scene.ramps, 'scene.ramps')) validateRamp(ramp, scene, usedColors, `scene.ramps.${key}`);
  for (const [key, material] of dictionary(scene.materials, 'scene.materials')) validateMaterial(material, scene, `scene.materials.${key}`);
  assert(owns(scene.materials, 'stone'), 'INVALID_REFERENCE', 'scene.materials must contain the default "stone" material.');
  assert(Array.isArray(scene.lights) && scene.lights.length <= LIMIT.lights, 'LIMIT_EXCEEDED', `scene.lights must be an array containing at most ${LIMIT.lights} lights.`, { path: 'scene.lights', limit: LIMIT.lights });
  const lightIds = new Set();
  for (let index = 0; index < scene.lights.length; index++) {
    const light = scene.lights[index];
    validateLight(light, `scene.lights[${index}]`);
    assert(!lightIds.has(light.id), 'DUPLICATE_ID', `Duplicate light id "${light.id}".`, { id: light.id }); lightIds.add(light.id);
  }
  assert(Array.isArray(scene.nodes) && scene.nodes.length >= 1 && scene.nodes.length <= LIMIT.nodes, 'LIMIT_EXCEEDED', `scene.nodes must contain 1–${LIMIT.nodes} nodes including root.`, { path: 'scene.nodes', limit: LIMIT.nodes });
  for (let index = 0; index < scene.nodes.length; index++) validateNode(scene.nodes[index], scene, usedColors, `scene.nodes[${index}]`);
  hierarchy(scene);
  validateAppearances(scene);
  validateSpatialRelations(scene);
  for (const [nodeId, matrix] of worldTransforms(scene)) {
    assert(matrix.every(value => Number.isFinite(value) && Math.abs(value) <= LIMIT.matrix), 'INVALID_TRANSFORM', `Node "${nodeId}" has an overflowing world transform. Reduce the transform magnitudes.`, { id: nodeId });
    invert(matrix, `Node "${nodeId}" world transform`);
  }
  assert(usedColors.size <= LIMIT.colors, 'LIMIT_EXCEEDED', `Scene uses ${usedColors.size} palette colors and literal colors; maximum is ${LIMIT.colors}.`, { path: 'scene.palette', count: usedColors.size, limit: LIMIT.colors });
  return scene;
}

/** Construct normalized data; supplied palette/ramp/material entries extend defaults. */
export function createScene(args = {}) {
  fields(args, ARG_KEYS, 'args');
  assert(args.coordinates===undefined||args.coordinates==='right-handed-y-up','COORDINATES','New scenes use only right-handed-y-up. Migrate legacy scenes explicitly.');
  const width = supplied(args, 'width', 64), height = supplied(args, 'height', 64);
  integer(width, 'args.width', 1, LIMIT.canvas); integer(height, 'args.height', 1, LIMIT.canvas);
  const sceneId = supplied(args, 'id', 'scene');
  const scene = { coordinates: 'right-handed-y-up', format: 'dsh-zpixel/2', id: sceneId, title: supplied(args, 'title', owns(args, 'id') ? sceneId : 'Untitled scene'), revision: 0,
    width, height, camera: normalizeCamera({},width,height),
    palette: { ...PALETTE }, ramps: {}, materials: {}, lights: [normalizeLight({ id: 'key', type: 'directional' }, 'default light')],
    ambient: supplied(args, 'ambient', 0.25), exposure: supplied(args, 'exposure', 1), nodes: [], spatialRelations: clone(args.spatialRelations??[]) };
  for (const materialId of ['stone', 'wood', 'metal']) {
    scene.ramps[materialId] = { response: 1, stops: [0, 0.35, 0.7, 1].map((at, index) => ({ at, color: `${materialId}${index}` })) };
    scene.materials[materialId] = { ramp: materialId, ...MATERIAL };
  }
  if (owns(args, 'camera')) {
    scene.camera=normalizeCamera(args.camera,width,height);
  }
  if (owns(args, 'palette')) { dictionary(args.palette, 'args.palette'); scene.palette = { ...scene.palette, ...clone(args.palette) }; }
  for (const key of ['ramps', 'materials']) if (owns(args, key)) {
    for (const [entryId, value] of dictionary(args[key], `args.${key}`)) {
      fields(value, key === 'ramps' ? ['stops', 'response'] : ['ramp', 'diffuse', 'emission', 'specular', 'roughness'], `args.${key}.${entryId}`);
      scene[key][entryId] = { ...(key === 'ramps' ? { response: 1 } : MATERIAL), ...scene[key][entryId], ...clone(value) };
    }
  }
  if (owns(args, 'lights')) {
    assert(Array.isArray(args.lights) && args.lights.length <= LIMIT.lights, 'LIMIT_EXCEEDED', `args.lights must be an array of at most ${LIMIT.lights} lights.`, { path: 'args.lights', limit: LIMIT.lights });
    scene.lights = args.lights.map((light, index) => normalizeLight(light, `args.lights[${index}]`));
  }
  const inputNodes = supplied(args, 'nodes', []);
  assert(Array.isArray(inputNodes) && inputNodes.length <= LIMIT.nodes, 'LIMIT_EXCEEDED', `args.nodes must be an array of at most ${LIMIT.nodes} nodes.`, { path: 'args.nodes', limit: LIMIT.nodes });
  for (let index = 0; index < inputNodes.length; index++) object(inputNodes[index], `args.nodes[${index}]`);
  const roots = inputNodes.filter(node => node.id === 'root');
  assert(roots.length <= 1, 'DUPLICATE_ID', 'args.nodes contains more than one root node.');
  scene.nodes.push(normalizeNode(roots[0] ?? { id: 'root', kind: 'group' }, scene, 'root node'));
  for (const [index, node] of inputNodes.entries()) if (node.id !== 'root') scene.nodes.push(normalizeNode(node, scene, `args.nodes[${index}]`));
  if(owns(args,'theme')){validateThemeBinding(args.theme);scene.theme=clone(args.theme);}
  if(owns(args,'contract'))scene.contract=args.contract;
  return validateScene(scene);
}

function findNode(scene, nodeId) {
  id(nodeId, 'node id'); const node = scene.nodes.find(item => item.id === nodeId);
  assert(node, 'NODE_NOT_FOUND', `Unknown node "${nodeId}".`, { id: nodeId }); return node;
}
function editable(scene, nodeId, allowOwnUnlock = false) {
  const node = findNode(scene, nodeId);
  for (let current = node; current; current = current.parent === null ? null : findNode(scene, current.parent)) assert(!current.locked || allowOwnUnlock && current === node,
    'LOCKED_NODE', `Node "${nodeId}" is locked by "${current.id}". Unlock that node first.`, { id: nodeId, lockedBy: current.id });
  return node;
}
function descendants(scene, nodeId) {
  const ids = new Set([nodeId]); let grew = true;
  while (grew) {
    grew = false;
    for (const node of scene.nodes) if (!ids.has(node.id) && ids.has(node.parent)) { ids.add(node.id); grew = true; }
  }
  return ids;
}
function reparent(scene, nodeId, parentId, keepWorld = true) {
  const node = editable(scene, nodeId);
  assert(nodeId !== 'root', 'INVALID_ROOT', 'The root node cannot be reparented.', { id: nodeId }); editable(scene, parentId);
  assert(!descendants(scene, nodeId).has(parentId), 'CYCLE', `Cannot reparent "${nodeId}" under itself or a descendant.`, { id: nodeId, parent: parentId });
  if (node.parent === parentId) return;
  if (keepWorld) {
    const worlds = worldTransforms(scene);
    node.transform = { matrix: multiply(invert(worlds.get(parentId), `Parent "${parentId}" transform`), worlds.get(nodeId)) };
    validateTransform(node.transform, `Node "${nodeId}" transform`);
  }
  node.parent = parentId;
}
function setNode(scene, operation, path) {
  const node=editable(scene,operation.id,Object.keys(operation.values??{}).length===1&&operation.values?.locked===false);
  const allowed=[...COMMON_KEYS.filter(key=>!['id','parent','kind'].includes(key)),...(node.kind==='part'?['geometry','castShadow']:node.kind==='layer'?LAYER_KEYS:[]),'orientation',...(node.kind==='layer'?['plane']:[])];
  fields(operation.values,allowed,`${path}.values`);
  for(const key of ['id','kind','parent'])assert(!owns(operation.values,key),'INVALID_OPERATION','Use dedicated identity/reparent operations, not node_set.');
  const values=clone(operation.values);
  if(owns(values,'appearanceShading'))oneOf(values.appearanceShading,['lit','unlit'],`${path}.values.appearanceShading`);
  if(owns(values,'orientation')&&owns(values,'transform'))assert(!owns(values.transform,'rotation')&&!owns(values.transform,'matrix'),'ORIENTATION_CONFLICT','Set orientation separately from transform.rotation/matrix.');
  const candidate={...clone(node),...values};
  if(owns(values,'appearanceOf')&&values.appearanceOf===null){delete candidate.appearanceOf;delete candidate.appearanceShading;}
  if(owns(values,'semanticFrame')&&values.semanticFrame===null)delete candidate.semanticFrame;
  if(owns(values,'anchors')&&values.anchors===null)candidate.anchors={};
  if(owns(values,'plane'))delete candidate.basis;
  if(node.kind==='layer'&&!owns(values,'pixels')&&(candidate.width!==node.width||candidate.height!==node.height)){
    integer(candidate.width,`${path}.values.width`,1,LIMIT.canvas);integer(candidate.height,`${path}.values.height`,1,LIMIT.canvas);
    candidate.pixels=Array(candidate.width*candidate.height).fill(null);
    for(let y=0;y<Math.min(node.height,candidate.height);y++)for(let x=0;x<Math.min(node.width,candidate.width);x++)candidate.pixels[y*candidate.width+x]=node.pixels[y*node.width+x];
  }
  const normalized=normalizeNode(candidate,scene,`${path}.values`);validateNode(normalized,scene,new Set(),`${path}.result`);
  for(const key of Object.keys(node))delete node[key];Object.assign(node,normalized);
}
function duplicate(scene, operation) {
  const source = editable(scene, operation.id); id(operation.newId, 'node_duplicate.newId');
  assert(!scene.nodes.some(node => node.id === operation.newId), 'DUPLICATE_ID', `Node "${operation.newId}" already exists. Choose a new newId.`, { id: operation.newId });
  const parent = supplied(operation, 'parent', source.parent ?? 'root'); editable(scene, parent);
  const subtree = descendants(scene, source.id), originals = scene.nodes.filter(node => subtree.has(node.id));
  assert(scene.nodes.length + originals.length <= LIMIT.nodes, 'LIMIT_EXCEEDED', `Duplicating this subtree would exceed ${LIMIT.nodes} nodes.`, { limit: LIMIT.nodes });
  const mapping = new Map([[source.id, operation.newId]]), used = new Set(scene.nodes.map(node => node.id)); used.add(operation.newId);
  for (const node of originals) if (node.id !== source.id) {
    const base = `${operation.newId}.${node.id}`.slice(0, 120); let candidate = base, suffix = 2;
    while (used.has(candidate)) candidate = `${base}.${suffix++}`;
    mapping.set(node.id, candidate); used.add(candidate);
  }
  for(const original of originals){
    const node=clone(original);node.id=mapping.get(original.id);node.parent=original.id===source.id?parent:mapping.get(original.parent);
    if(node.appearanceOf!==undefined&&mapping.has(node.appearanceOf))node.appearanceOf=mapping.get(node.appearanceOf);
    if(node.outline&&mapping.has(node.outline.group))node.outline.group=mapping.get(node.outline.group);
    scene.nodes.push(node);
  }
  const internalEdges=(scene.spatialRelations??[]).filter(edge=>mapping.has(edge.from.node)&&mapping.has(edge.to.node)).map(edge=>clone(edge));
  for(const edge of internalEdges)scene.spatialRelations.push({...edge,id:`${operation.newId}.${edge.id}`,from:{...edge.from,node:mapping.get(edge.from.node)},to:{...edge.to,node:mapping.get(edge.to.node)}});
}
function groupNodes(scene, operation, path) {
  id(operation.id, `${path}.id`);
  assert(!scene.nodes.some(node => node.id === operation.id), 'DUPLICATE_ID', `Node "${operation.id}" already exists.`, { id: operation.id });
  assert(Array.isArray(operation.children) && operation.children.length > 0 && operation.children.length <= LIMIT.nodes, 'INVALID_OPERATION', `${path}.children must be a nonempty array of node IDs.`, { path });
  const selected = new Set(operation.children);
  assert(selected.size === operation.children.length, 'INVALID_OPERATION', `${path}.children must not contain duplicate IDs.`, { path });
  const children = operation.children.map(nodeId => editable(scene, nodeId));
  assert(!selected.has('root'), 'INVALID_ROOT', 'The root node cannot be grouped.');
  for (const node of children) for (let parent = node.parent; parent !== null; parent = findNode(scene, parent).parent) assert(!selected.has(parent), 'INVALID_OPERATION', `${path}.children selects both an ancestor and its descendant. Select the ancestor alone.`, { id: node.id, ancestor: parent });
  const commonParent = children.every(node => node.parent === children[0].parent) ? children[0].parent : 'root';
  const parent = supplied(operation, 'parent', commonParent); editable(scene, parent);
  for (const child of children) assert(!descendants(scene, child.id).has(parent), 'CYCLE', 'The new group parent cannot be inside a selected subtree.', { id: child.id, parent });
  const worlds = worldTransforms(scene), parentInverse = invert(worlds.get(parent), `Parent "${parent}" transform`);
  const group = normalizeNode({ id: operation.id, kind: 'group', parent }, scene, path);
  const index = Math.min(...children.map(child => scene.nodes.indexOf(child))); scene.nodes.splice(index, 0, group);
  for (const child of children) { child.parent = group.id; child.transform = { matrix: multiply(parentInverse, worlds.get(child.id)) }; }
}
function paint(scene, operation, path) {
  const node = editable(scene, operation.id);
  assert(node.kind === 'layer', 'WRONG_NODE_KIND', `Node "${node.id}" is ${node.kind}; paint requires a layer.`, { id: node.id });
  assert(Array.isArray(operation.ops), 'INVALID_OPERATION', `${path}.ops must be an array of paint operations.`, { path });
  const checkedColor = (color, colorPath) => { if (color !== null) colorRef(color, scene, new Set(), colorPath); return color; };
  const position = (x, y, positionPath) => { integer(x, `${positionPath}.x`, 0, node.width - 1); integer(y, `${positionPath}.y`, 0, node.height - 1); };
  const region = (item, regionPath, full = false) => {
    const present = ['x', 'y', 'w', 'h'].filter(key => owns(item, key));
    if (full && present.length === 0) return { x: 0, y: 0, w: node.width, h: node.height };
    const missing = ['x', 'y', 'w', 'h'].filter(key => !owns(item, key));
    assert(missing.length === 0, 'INVALID_OPERATION', `${regionPath} requires all of x, y, w and h.`, { path: regionPath, fields: ['x', 'y', 'w', 'h'], missing });
    position(item.x, item.y, regionPath); integer(item.w, `${regionPath}.w`, 1, node.width); integer(item.h, `${regionPath}.h`, 1, node.height);
    assert(item.x + item.w <= node.width && item.y + item.h <= node.height, 'PAINT_BOUNDS', `${regionPath} extends beyond layer ${node.width}x${node.height}.`, { path: regionPath, width: node.width, height: node.height });
    return item;
  };
  for (let index = 0; index < operation.ops.length; index++) {
    const item = operation.ops[index], itemPath = `${path}.ops[${index}]`; object(item, itemPath);
    oneOf(item.op, ['rect', 'line', 'pixels', 'clear'], `${itemPath}.op`);
    if (item.op === 'rect' || item.op === 'clear') {
      fields(item, item.op === 'rect' ? ['op', 'x', 'y', 'w', 'h', 'color'] : ['op', 'x', 'y', 'w', 'h'], itemPath);
      const box = region(item, itemPath, item.op === 'clear'), color = item.op === 'clear' ? null : checkedColor(item.color, `${itemPath}.color`);
      for (let y = box.y; y < box.y + box.h; y++) node.pixels.fill(color, y * node.width + box.x, y * node.width + box.x + box.w);
    } else if (item.op === 'line') {
      fields(item, ['op', 'x', 'y', 'x2', 'y2', 'color'], itemPath);
      const missing = ['x', 'y', 'x2', 'y2'].filter(key => !owns(item, key));
      assert(missing.length === 0, 'INVALID_OPERATION', `${itemPath} requires all of x, y, x2 and y2 for a line.`, { path: `${itemPath}.${missing[0]}`, field: missing[0], fields: ['x', 'y', 'x2', 'y2'], missing });
      position(item.x, item.y, itemPath);
      integer(item.x2, `${itemPath}.x2`, 0, node.width - 1); integer(item.y2, `${itemPath}.y2`, 0, node.height - 1);
      const color = checkedColor(item.color, `${itemPath}.color`);
      let x = item.x, y = item.y, error = Math.abs(item.x2 - x) - Math.abs(item.y2 - y);
      const dx = Math.abs(item.x2 - x), dy = Math.abs(item.y2 - y), sx = x < item.x2 ? 1 : -1, sy = y < item.y2 ? 1 : -1;
      for (;;) {
        node.pixels[y * node.width + x] = color;
        if (x === item.x2 && y === item.y2) break;
        const twice = error * 2; if (twice > -dy) { error -= dy; x += sx; } if (twice < dx) { error += dx; y += sy; }
      }
    } else {
      fields(item, ['op', 'pixels', 'points', 'x', 'y', 'w', 'h', 'color'], itemPath);
      assert(!(owns(item, 'pixels') && owns(item, 'points')), 'INVALID_OPERATION', `${itemPath} must use either pixels or points, not both.`, { path: itemPath });
      const dataKey = owns(item, 'pixels') ? 'pixels' : owns(item, 'points') ? 'points' : null;
      assert(dataKey !== null, 'INVALID_PIXELS', `${itemPath} requires a pixels array; points is an accepted alias.`, { path: itemPath, fields: ['pixels', 'points'] });
      const dataPath = `${itemPath}.${dataKey}`, data = item[dataKey];
      assert(Array.isArray(data), 'INVALID_PIXELS', `${dataPath} must be an array of colors or pixel points.`, { path: dataPath });
      assert(data.length <= LIMIT.canvas * LIMIT.canvas, 'INVALID_PIXELS', `${dataPath} must contain at most ${LIMIT.canvas * LIMIT.canvas} entries.`, { path: dataPath, limit: LIMIT.canvas * LIMIT.canvas });
      if (['x', 'y', 'w', 'h'].some(key => owns(item, key))) {
        assert(dataKey === 'pixels' && !owns(item, 'color'), 'INVALID_OPERATION', `${itemPath} rectangular pixels use pixels, x, y, w and h only.`, { path: itemPath, fields: ['pixels', 'x', 'y', 'w', 'h'] });
        const box = region(item, itemPath);
        assert(data.length === box.w * box.h, 'INVALID_PIXELS', `${dataPath} must contain exactly w*h (${box.w * box.h}) entries for the rectangle.`, { path: dataPath, expected: box.w * box.h, actual: data.length });
        for (let pixelIndex = 0; pixelIndex < data.length; pixelIndex++) node.pixels[(box.y + Math.floor(pixelIndex / box.w)) * node.width + box.x + pixelIndex % box.w] = checkedColor(data[pixelIndex], `${dataPath}[${pixelIndex}]`);
      } else {
        for (let pixelIndex = 0; pixelIndex < data.length; pixelIndex++) {
          const pixel = data[pixelIndex], pixelPath = `${dataPath}[${pixelIndex}]`;
          let x, y, color;
          if (Array.isArray(pixel)) {
            assert(pixel.length === 3, 'INVALID_PIXELS', `${pixelPath} must be [x,y,color].`, { path: pixelPath });
            [x, y, color] = pixel;
          } else {
            assert(typeof pixel !== 'string' && pixel !== null, 'INVALID_PIXELS', `${pixelPath}: flat color arrays require x, y, w and h; otherwise use [x,y,color] entries or {x,y,color} objects.`, { path: pixelPath, hint: 'Add x, y, w and h for a dense rectangle, or use pixel points.' });
            fields(pixel, ['x', 'y', 'color'], pixelPath); x = pixel.x; y = pixel.y; color = owns(pixel, 'color') ? pixel.color : item.color;
          }
          position(x, y, pixelPath); node.pixels[y * node.width + x] = checkedColor(color, `${pixelPath}.color`);
        }
      }
    }
  }
}

const OP_KEYS = Object.freeze({ node_add: ['node'], node_set: ['id', 'values'], node_delete: ['id'],
  node_duplicate: ['id', 'newId', 'parent'], node_reparent: ['id', 'parent', 'keepWorld'], node_group: ['id', 'children', 'parent'],
  transform: ['id', 'translate', 'rotate', 'scale', 'space'], paint: ['id', 'ops'], palette_set: ['id', 'color'],
  node_align:['id','target','axis','targetAxis','space','position'], node_attach:['id','target','mode','sourceAnchor','targetAnchor','rollPolicy','rollAxis','rollReference','relationId','record','tolerance','gap'],
  spatial_relation_add:['edge'], spatial_relation_delete:['id'],
  ramp_set: ['id', 'value'], material_set: ['id', 'value'], light_set: ['id', 'value'], light_delete: ['id'], scene_set: ['values'] });
/** Apply a complete operation batch to a private clone. Any failure discards it. */
export function applyOperations(scene, ops) {
  validateScene(scene);
  assert(Array.isArray(ops) && ops.length <= LIMIT.operations, 'LIMIT_EXCEEDED', `ops must be an array of at most ${LIMIT.operations} operations.`, { path: 'ops', limit: LIMIT.operations });
  let count = ops.length;
  for (let index = 0; index < ops.length; index++) {
    const operation = ops[index], path = `ops[${index}]`; object(operation, path);
    assert(owns(OP_KEYS, operation.op), 'UNKNOWN_OPERATION', `Unknown operation "${operation.op}".`, { path: `${path}.op`, available: Object.keys(OP_KEYS) });
    if (operation.op === 'paint') {
      const hints = {
        pixels: 'Put pixels in an ops entry: {op:"paint",id:"layer-id",ops:[{op:"pixels",x:0,y:0,w:2,h:1,pixels:["ink","ink"]}]}.',
        points: 'Put points in an ops entry: {op:"paint",id:"layer-id",ops:[{op:"pixels",points:[[0,0,"ink"]]}]}.',
        values: 'paint uses ops; use node_set with values for node fields: {op:"node_set",id:"node-id",values:{...}}.'
      };
      for (const field of Object.keys(hints)) assert(!owns(operation, field), 'UNKNOWN_FIELD', `paint does not take ${field} at the operation level. ${hints[field]}`, { path: `${path}.${field}`, field, hint: hints[field] });
    }
    if (operation.op === 'node_set') assert(!owns(operation, 'pixels'), 'UNKNOWN_FIELD', 'node_set does not take pixels at the operation level. Use {op:"node_set",id:"layer-id",values:{pixels:[...]}} or a paint operation.', { path: `${path}.pixels`, field: 'pixels', hint: 'Put pixels inside node_set.values or use paint.' });
    fields(operation, ['op', ...OP_KEYS[operation.op]], path);
    if (operation.op === 'paint') { assert(Array.isArray(operation.ops), 'INVALID_OPERATION', `${path}.ops must be an array.`, { path }); count += operation.ops.length; }
  }
  assert(count <= LIMIT.operations, 'LIMIT_EXCEEDED', `The batch contains ${count} operations including nested paint operations; maximum is ${LIMIT.operations}.`, { count, limit: LIMIT.operations });
  const next = clone(scene, 'scene');
  for (let index = 0; index < ops.length; index++) {
    const operation = ops[index], path = `ops[${index}]`;
    switch (operation.op) {
      case 'node_add': {
        const node = normalizeNode(operation.node, next, `${path}.node`);
        assert(!next.nodes.some(item => item.id === node.id), 'DUPLICATE_ID', `Node "${node.id}" already exists.`, { id: node.id });
        editable(next, node.parent); validateNode(node, next, new Set(), `${path}.node`); next.nodes.push(node); break;
      }
      case 'node_set': setNode(next, operation, path); break;
      case 'node_delete': {
        editable(next, operation.id); assert(operation.id !== 'root', 'INVALID_ROOT', 'The root node cannot be deleted.');
        const removed = descendants(next, operation.id); for (const nodeId of removed) editable(next, nodeId);
         next.nodes=next.nodes.filter(node=>!removed.has(node.id));
         next.spatialRelations=next.spatialRelations.filter(edge=>!removed.has(edge.from.node)&&!removed.has(edge.to.node));
         break;
      }
      case 'node_duplicate': duplicate(next, operation); break;
      case 'node_reparent':
        if (owns(operation, 'keepWorld')) boolean(operation.keepWorld, `${path}.keepWorld`);
        reparent(next, operation.id, operation.parent, operation.keepWorld ?? true); break;
      case 'node_group': groupNodes(next, operation, path); break;
      case 'transform': {
        const node = editable(next, operation.id); oneOf(supplied(operation, 'space', 'parent'), ['parent', 'local'], `${path}.space`);
        assert(['translate', 'rotate', 'scale'].some(key => owns(operation, key)), 'INVALID_OPERATION', `${path} requires translate, rotate or scale.`, { path });
        const delta = normalizeTransform({ position: supplied(operation, 'translate', [0, 0, 0]), rotation: supplied(operation, 'rotate', [0, 0, 0]), scale: supplied(operation, 'scale', [1, 1, 1]) }, path);
        const before = compose(node.transform), change = compose(delta);
        node.transform = { matrix: operation.space === 'local' ? multiply(before, change) : multiply(change, before) };
        validateTransform(node.transform, `${path}.result`); break;
      }
      case 'paint': paint(next, operation, path); break;
      case 'palette_set': id(operation.id, `${path}.id`); next.palette[operation.id] = hex(operation.color, `${path}.color`); break;
      case 'ramp_set':
      case 'material_set': {
        id(operation.id, `${path}.id`); const ramp = operation.op === 'ramp_set', key = ramp ? 'ramps' : 'materials';
        fields(operation.value, ramp ? ['stops', 'response'] : ['ramp', 'diffuse', 'emission', 'specular', 'roughness'], `${path}.value`);
        next[key][operation.id] = { ...(ramp ? { response: 1 } : MATERIAL), ...next[key][operation.id], ...clone(operation.value) }; break;
      }
      case 'light_set': {
        id(operation.id, `${path}.id`); fields(operation.value, ['id', 'type', 'position', 'direction', 'intensity', 'range', 'color'], `${path}.value`);
        const lightIndex = next.lights.findIndex(light => light.id === operation.id);
        const light = normalizeLight({ ...(next.lights[lightIndex] ?? {}), ...operation.value }, `${path}.value`, operation.id); validateLight(light, `${path}.value`);
        if (lightIndex === -1) next.lights.push(light); else next.lights[lightIndex] = light; break;
      }
      case 'light_delete':
        id(operation.id, `${path}.id`); assert(next.lights.some(light => light.id === operation.id), 'LIGHT_NOT_FOUND', `Unknown light "${operation.id}".`, { id: operation.id });
        next.lights = next.lights.filter(light => light.id !== operation.id); break;
      case 'node_align':
      case 'node_attach': applySpatialOperation(next,operation);break;
      case 'spatial_relation_add': next.spatialRelations.push(normalizeSpatialRelation(operation.edge,`${path}.edge`));break;
      case 'spatial_relation_delete': {
        id(operation.id,`${path}.id`);const before=next.spatialRelations.length;next.spatialRelations=next.spatialRelations.filter(edge=>edge.id!==operation.id);assert(next.spatialRelations.length<before,'RELATION_NOT_FOUND',`Unknown spatial relation ${operation.id}.`);break;
      }
      case 'scene_set':
        fields(operation.values, ['camera', 'ambient', 'exposure', 'title','spatialRelations','theme'], `${path}.values`);
        for (const [key, value] of Object.entries(operation.values)) {
          if (key === 'camera') { next.camera=normalizeCamera(value,next.width,next.height,next.camera); }
          else if(key==='theme'){if(value===null)delete next.theme;else{validateThemeBinding(value);next.theme=clone(value);}}
          else next[key] = clone(value);
        }
        break;
    }
    assert(next.nodes.length <= LIMIT.nodes, 'LIMIT_EXCEEDED', `Scene supports at most ${LIMIT.nodes} nodes.`, { limit: LIMIT.nodes }); hierarchy(next);
  }
  return validateScene(next);
}
/** A compact data summary; counts include the mandatory root group. */
export function summarizeScene(scene) {
  validateScene(scene); const { depths } = hierarchy(scene), counts = { group: 0, part: 0, layer: 0 };
  let layerPixelCount = 0, paintedPixelCount = 0;
  for (const node of scene.nodes) {
    counts[node.kind]++;
    if (node.kind === 'layer') { layerPixelCount += node.pixels.length; paintedPixelCount += node.pixels.reduce((total, color) => total + (color === null ? 0 : 1), 0); }
  }
  return { format: scene.format, coordinates:scene.coordinates, id: scene.id, title: scene.title, revision: scene.revision, ...(scene.contract?{contract:scene.contract}:{}), width: scene.width, height: scene.height,
    nodeCount: scene.nodes.length, counts, layerPixelCount, paintedPixelCount, paletteSize: Object.keys(scene.palette).length,
    rampCount: Object.keys(scene.ramps).length, materialCount: Object.keys(scene.materials).length,
    lightCount: scene.lights.length, maxDepth: Math.max(...depths.values()), camera: clone(scene.camera),
    ...(scene.theme?{theme:{id:scene.theme.id,revision:scene.theme.revision,hash:scene.theme.hash}}:{}) }; 
}
/** Nested authoring order, with effective visibility/locks/material for inspection. */
export function tree(scene, rootId = 'root') {
  validateScene(scene); const { nodes } = hierarchy(scene); findNode(scene, rootId);
  const children = new Map(scene.nodes.map(node => [node.id, []]));
  for (const node of scene.nodes) if (node.parent !== null) children.get(node.parent).push(node);
  const build = (node, visible, locked, material) => {
    const effectiveVisible = visible && node.visible, effectiveLocked = locked || node.locked, materialId = node.material ?? material;
    return { id: node.id, parent: node.parent, kind: node.kind, name: node.name, role:node.role,tags:clone(node.tags), visible: node.visible, locked: node.locked,
      effectiveVisible, effectiveLocked, materialId, children: children.get(node.id).map(child => build(child, effectiveVisible, effectiveLocked, materialId)) };
  };
  const ancestors = [];
  for (let parent = nodes.get(rootId).parent; parent !== null; parent = nodes.get(parent).parent) ancestors.unshift(nodes.get(parent));
  let visible = true, locked = false, material = 'stone';
  for (const ancestor of ancestors) { visible &&= ancestor.visible; locked ||= ancestor.locked; material = ancestor.material ?? material; }
  return build(nodes.get(rootId), visible, locked, material);
}
