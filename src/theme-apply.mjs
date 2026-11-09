/** Authoring-time theme application. Compiles to ordinary atomic scene operations. */
import {isDeepStrictEqual} from 'node:util';
import {applyOperations,ZPixelError} from './scene.mjs';
import {compileTheme} from './theme-runtime.mjs';
import {assertThemeId,validateThemeContext,validateThemeBinding} from './theme-model.mjs';

const fail=(code,message,details={})=>{throw new ZPixelError(code,message,details);};
const own=(v,k)=>Object.prototype.hasOwnProperty.call(v,k);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fields=(v,allowed,label)=>{if(!plain(v))fail('THEME_ARGUMENT',label+' must be an object.');for(const k of Object.keys(v))if(!allowed.includes(k))fail('THEME_ARGUMENT','Unknown '+label+'.'+k,{field:k,allowed});};
export function validateThemeRequest(request){
  fields(request,['id','revision','hash','context','bindings','overwrite','replace','overrides','applyDefaults'],'theme');
  assertThemeId(request.id);
  if(!Number.isSafeInteger(request.revision)||request.revision<0)fail('THEME_REVISION','Bind an explicit nonnegative theme revision.');
  if(own(request,'hash')&&(typeof request.hash!=='string'||!/^[0-9a-f]{64}$/.test(request.hash)))fail('THEME_HASH','theme.hash must be a SHA256 hex string.');
  if(own(request,'context'))validateThemeContext(request.context);
  for(const k of ['overwrite','replace','applyDefaults'])if(own(request,k)&&typeof request[k]!=='boolean')fail('THEME_ARGUMENT','theme.'+k+' must be boolean.');
  if(own(request,'bindings')){
    if(!Array.isArray(request.bindings)||request.bindings.length>256)fail('THEME_ARGUMENT','theme.bindings must be an array of at most 256 node bindings.');
    const used=new Set();
    for(const binding of request.bindings){
      fields(binding,['node','material','outline','appearanceShading'],'theme.bindings[]');
      if(typeof binding.node!=='string'||!binding.node)fail('THEME_ARGUMENT','Each node binding requires node.');
      if(used.has(binding.node))fail('THEME_ARGUMENT','Duplicate theme binding for '+binding.node);used.add(binding.node);
      if(own(binding,'material')&&(typeof binding.material!=='string'||!binding.material))fail('THEME_ARGUMENT','Binding material must be a theme material token.');
      for(const k of ['outline','appearanceShading'])if(own(binding,k)&&typeof binding[k]!=='boolean')fail('THEME_ARGUMENT','Binding '+k+' must be boolean.');
    }
  }
  if(own(request,'overrides')&&!Array.isArray(request.overrides))fail('THEME_ARGUMENT','theme.overrides must be an array.');
  return request;
}

export function applyTheme(scene,record,request,{initial=false,explicitFields=[],explicitRoot={},explicitResources={}}={}){
  validateThemeRequest(request);
  const theme=record.theme,hash=record.hash;
  if(request.id!==theme.id||request.revision!==theme.revision||(request.hash!==undefined&&request.hash!==hash))fail('THEME_HASH','The requested theme identity or hash differs from the stored revision.');
  if(scene.theme&&scene.theme.hash!==hash&&!request.replace)fail('THEME_CONFLICT','This scene is pinned to another theme revision; set theme.replace:true to replace it explicitly.',{current:{id:scene.theme.id,revision:scene.theme.revision,hash:scene.theme.hash}});
  const context={...(scene.theme?.hash===hash?scene.theme.context:{}),...(request.context??{}),nativeSize:[scene.width,scene.height]};
  validateThemeContext(context);
  const binding={id:theme.id,revision:theme.revision,hash,adapterVersion:'1',snapshot:structuredClone(theme),context,overrides:structuredClone(request.overrides??(scene.theme?.hash===hash?scene.theme.overrides:[])??[])};
  validateThemeBinding(binding);
  const applyDefaults=request.applyDefaults??initial,explicit=new Set(explicitFields);
  const ops=[],changes={id:theme.id,revision:theme.revision,hash,defaultsApplied:applyDefaults,resources:{palette:[],ramps:[],materials:[],lights:[]},preservedExplicit:{palette:[],ramps:[],materials:[]},retainedResources:{palette:[],ramps:[],materials:[]},removedLights:[],globalFields:[],nodeBindings:[],metadataOnly:false};
  // Resolve screen-frame light directions against the final normalized camera.
  let cameraScene=scene;
  if(applyDefaults&&theme.tokens.camera&&!(initial&&explicit.has('camera')))cameraScene=applyOperations(scene,[{op:'scene_set',values:{camera:theme.tokens.camera}}]);
  const compiled=compileTheme(theme,context,{camera:cameraScene.camera});
  const unsupported=compiled.capabilities?.unsupported??[];
  const blockers=unsupported.filter(item=>item.required!==false);
  if(blockers.length)fail('THEME_UNSUPPORTED','Theme resources require capabilities this renderer cannot execute. Read its capabilities and choose an explicit compatible revision.',{unsupported:blockers});
  changes.capabilities=compiled.capabilities;
  const defaults=compiled.defaults;
  for(const key of ['palette','ramps','materials'])for(const[id,value]of Object.entries(defaults[key]??{})){
    if(initial&&own(explicitResources[key]??{},id)){changes.preservedExplicit[key].push(id);continue;}
    const existing=scene[key][id];
    const same=key==='palette'&&typeof existing==='string'?existing.toLowerCase()===value:isDeepStrictEqual(existing,value);
    if(existing!==undefined&&!same&&!request.overwrite)fail('THEME_RESOURCE_CONFLICT','Resource '+id+' already has different values; use overwrite:true for an explicit resource update.',{resource:key,id});
    const op=key==='palette'?{op:'palette_set',id,color:value}:{op:key==='ramps'?'ramp_set':'material_set',id,value};
    ops.push(op);changes.resources[key].push(id);
  }
  if(scene.theme){
    const previousPrefix='theme.'+scene.theme.id+'.';
    for(const key of ['palette','ramps','materials'])changes.retainedResources[key]=Object.keys(scene[key]).filter(id=>id.startsWith(previousPrefix)&&!own(defaults[key]??{},id));
  }
  const settings={};
  if(applyDefaults){
    for(const key of ['ambient','exposure','camera'])if(own(defaults,key)&&!(initial&&explicit.has(key))){settings[key]=defaults[key];changes.globalFields.push(key);}
    if(own(defaults,'lights')&&!(initial&&explicit.has('lights'))){
      for(const light of scene.lights){ops.push({op:'light_delete',id:light.id});changes.removedLights.push(light.id);}
      for(const light of defaults.lights){ops.push({op:'light_set',id:light.id,value:light});changes.resources.lights.push(light.id);}
      changes.globalFields.push('lights');
    }
    const root=scene.nodes.find(node=>node.id==='root'),values={};
    if(defaults.outline&&!(initial&&own(explicitRoot,'outline')))values.outline={...root.outline,...defaults.outline};
    if(defaults.defaultMaterial&&!(initial&&own(explicitRoot,'material')))values.material=defaults.defaultMaterial;
    if(Object.keys(values).length){ops.push({op:'node_set',id:'root',values});changes.globalFields.push('root');}
  }
  if(Object.keys(settings).length)ops.push({op:'scene_set',values:settings});
  for(const target of request.bindings??[]){
    const node=scene.nodes.find(value=>value.id===target.node);
    if(!node)fail('NODE_NOT_FOUND','Theme binding refers to unknown node '+target.node,{node:target.node});
    const values={};
    if(target.material!==undefined){
      if(!own(theme.tokens.materials,target.material))fail('THEME_TOKEN','Unknown theme material '+target.material);
      values.material=compiled.namespace.materials[target.material];
    }
    if(target.outline===true){if(!defaults.outline)fail('THEME_TOKEN','This theme defines no outline token.');values.outline={...(node.outline??{}),...defaults.outline};}
    else if(target.outline===false)values.outline={...(node.outline??{}),enabled:false};
    if(target.appearanceShading===true){
      if(node.kind!=='layer'||node.appearanceOf===undefined)fail('THEME_BINDING','appearanceShading binding requires a bound appearance layer.',{node:node.id});
      if(defaults.appearanceShading===undefined)fail('THEME_TOKEN','This theme defines no appearanceShading token.');
      values.appearanceShading=defaults.appearanceShading;
    }
    if(Object.keys(values).length)ops.push({op:'node_set',id:node.id,values});
    if(Object.keys(values).length)changes.nodeBindings.push({node:node.id,fields:Object.keys(values)});
  }
  ops.push({op:'scene_set',values:{theme:binding}});
  return{scene:applyOperations(scene,ops),changes};
}
