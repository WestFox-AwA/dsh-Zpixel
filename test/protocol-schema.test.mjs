import test from 'node:test';
import assert from 'node:assert/strict';
import {TOOL_SCHEMAS} from '../src/protocol.mjs';

/*
 * Source-level guard for the JSON Schema subset the Host declares for PTC tool
 * arguments in @deepseek-ai/dsh-tools: type, oneOf, properties, required,
 * boolean additionalProperties, items, scalar enum/const, and the
 * description/title/default/examples annotations. A schema outside that subset
 * makes jsonSchemaToTs degrade the whole tool signature to `unknown`.
 *
 * This is intentionally a cheap structural regression, NOT a runtime
 * conformance test: it does not import the Host bundle from app.asar. Keep it
 * aligned with the documented subset when the Host widens or narrows it.
 */

const CONSTRAINT_KEYS=new Set(['type','oneOf','properties','required','additionalProperties','items','enum','const']);
const ANNOTATION_KEYS=new Set(['description','title','default','examples']);
const SCHEMA_TYPES=new Set(['object','array','string','number','integer','boolean','null']);
const SCALAR_TYPES=new Set(['string','number','integer','boolean','null']);
const KEYWORD_TYPES={properties:['object'],required:['object'],additionalProperties:['object'],items:['array'],enum:[...SCALAR_TYPES],const:[...SCALAR_TYPES]};
const ONE_OF_SIBLINGS=['properties','required','additionalProperties','items','enum','const'];
const isRecord=value=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const matchesScalar=(type,value)=>type==='string'?typeof value==='string':type==='number'?typeof value==='number':type==='integer'?Number.isInteger(value):type==='boolean'?typeof value==='boolean':type==='null'?value===null:false;

function checkSchema(node,path){
  assert.ok(isRecord(node),`${path} must be a schema object`);
  for(const key of Object.keys(node))assert.ok(CONSTRAINT_KEYS.has(key)||ANNOTATION_KEYS.has(key),`${path}.${key} is not in the Host PTC schema subset`);
  if(Object.hasOwn(node,'description'))assert.equal(typeof node.description,'string',`${path}.description must be a string`);
  const hasType=Object.hasOwn(node,'type'),hasOneOf=Object.hasOwn(node,'oneOf');
  assert.ok(!(hasType&&hasOneOf),`${path} cannot declare both type and oneOf`);
  if(Object.hasOwn(node,'additionalProperties'))assert.equal(typeof node.additionalProperties,'boolean',`${path}.additionalProperties must be boolean`);
  if(hasOneOf){
    assert.ok(Array.isArray(node.oneOf)&&node.oneOf.length>=2,`${path}.oneOf needs at least two branches`);
    for(const key of ONE_OF_SIBLINGS)assert.ok(!Object.hasOwn(node,key),`${path}.${key} is not supported beside oneOf`);
    node.oneOf.forEach((branch,index)=>checkSchema(branch,`${path}.oneOf[${index}]`));
  }
  if(hasType){
    assert.ok(SCHEMA_TYPES.has(node.type),`${path}.type must be a single supported type string`);
    for(const [key,types] of Object.entries(KEYWORD_TYPES))if(Object.hasOwn(node,key))assert.ok(types.includes(node.type),`${path}.${key} is not supported on type "${node.type}"`);
  }else if(!hasOneOf){
    for(const key of ONE_OF_SIBLINGS)assert.ok(!Object.hasOwn(node,key),`${path}.${key} requires type or oneOf`);
  }
  if(Object.hasOwn(node,'const')){
    assert.ok(typeof node.type==='string'&&SCALAR_TYPES.has(node.type),`${path}.const must be typed; bare const is outside the Host subset`);
    assert.ok(matchesScalar(node.type,node.const),`${path}.const must match type "${node.type}"`);
  }
  if(Object.hasOwn(node,'enum')){
    assert.ok(Array.isArray(node.enum)&&node.enum.length>0,`${path}.enum must be a non-empty array`);
    assert.ok(typeof node.type==='string'&&SCALAR_TYPES.has(node.type),`${path}.enum requires a scalar type`);
    for(const value of node.enum)assert.ok(matchesScalar(node.type,value),`${path}.enum has a value outside type "${node.type}"`);
    if(Object.hasOwn(node,'const'))assert.ok(node.enum.includes(node.const),`${path}.const must be one of enum`);
  }
  if(node.type==='object'){
    if(Object.hasOwn(node,'properties')){
      assert.ok(isRecord(node.properties),`${path}.properties must be an object of schemas`);
      for(const [key,child] of Object.entries(node.properties))checkSchema(child,`${path}.properties.${key}`);
    }
    if(Object.hasOwn(node,'required')){
      assert.ok(Array.isArray(node.required)&&node.required.every(entry=>typeof entry==='string'),`${path}.required must be an array of strings`);
      const properties=isRecord(node.properties)?node.properties:{};
      for(const key of node.required)assert.ok(Object.hasOwn(properties,key),`${path}.required names "${key}" which is not in properties`);
    }
  }
  if(node.type==='array'&&Object.hasOwn(node,'items'))checkSchema(node.items,`${path}.items`);
}

function walkSchemas(node,path,visit){
  if(!isRecord(node))return;
  visit(node,path);
  for(const [key,child] of Object.entries(node.properties??{}))walkSchemas(child,`${path}.properties.${key}`,visit);
  if(Object.hasOwn(node,'items'))walkSchemas(node.items,`${path}.items`,visit);
  (node.oneOf??[]).forEach((branch,index)=>walkSchemas(branch,`${path}.oneOf[${index}]`,visit));
}

test('all seven tool schemas stay inside the Host PTC schema subset',()=>{
  assert.deepEqual(TOOL_SCHEMAS.map(tool=>tool.name).sort(),['zpixel_export','zpixel_guide','zpixel_inspect','zpixel_normalmap','zpixel_render','zpixel_scene','zpixel_theme']);
  for(const tool of TOOL_SCHEMAS){
    assert.equal(tool.parameters.type,'object',`${tool.name}.parameters must be an object`);
    checkSchema(tool.parameters,`${tool.name}.parameters`);
  }
});

test('zpixel_scene keeps its oneOf unions and typed discriminator values',()=>{
  const tool=TOOL_SCHEMAS.find(({name})=>name==='zpixel_scene');
  const parameters=tool.parameters;
  const scene=parameters.properties.scene;
  assert.ok(scene.properties.camera.oneOf?.length>=2,'camera oneOf must stay intact');
  const geometry=scene.properties.nodes.items.properties.geometry;
  assert.ok(geometry.oneOf?.length>=2,'geometry oneOf must stay intact');
  assert.ok(parameters.properties.ops.items.oneOf?.length>=2,'operation oneOf must stay intact');
  for(const branch of geometry.oneOf){
    assert.equal(branch.properties.type.type,'string');
    assert.equal(branch.properties.type.enum.length,1);
    assert.ok(!Object.hasOwn(branch.properties.type,'const'));
  }
  assert.equal(scene.properties.nodes.items.properties.anchors.additionalProperties,true);
  assert.deepEqual(scene.properties.format.enum,['dsh-zpixel/2']);
  assert.deepEqual(scene.properties.coordinates.enum,['right-handed-y-up']);
  assert.ok(parameters.properties.ops.items.oneOf.some(branch=>branch.properties.op.enum.includes('node_add')),'node_add discriminator must keep its value');
  const sized=geometry.oneOf.find(branch=>Object.hasOwn(branch.properties,'size'));
  assert.ok(sized,'geometry oneOf must keep the center/size box branch');
  assert.match(sized.properties.size.description,/exactly 3 numbers/i,'3-number vectors must state their length in description');
});

test('numeric tuple items pass the subset and advertise their length',()=>{
  const tuples=[];
  for(const tool of TOOL_SCHEMAS)walkSchemas(tool.parameters,tool.name,(node,path)=>{
    if(node.type==='array'&&node.items?.type==='number')tuples.push([path,node.description]);
    if(node.type==='array'&&node.items?.type==='array'){
      assert.equal(node.items.items?.type,'number',`${path}.items.items must be a number schema`);
      assert.match(node.items.description??'',/exactly 2 numbers/i,`${path}.items.description must state the 2-number tuple length`);
    }
  });
  assert.ok(tuples.length>=1,'expected at least one numeric tuple schema');
  for(const [path,description] of tuples)assert.match(description??'',/exactly (2|3) numbers/i,`${path}.description must state the tuple length`);
});
