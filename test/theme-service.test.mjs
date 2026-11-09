import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createZPixelServiceForTest as createZPixelService} from './helpers.mjs';
import {loadDocument} from '../src/store.mjs';
import {renderScene} from '../src/renderer.mjs';
import {encodePNG} from '../src/png.mjs';
import {guide} from '../src/guides.mjs';
import {cameraBasis} from '../src/math.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
async function setup(t){
  await fs.mkdir(path.join(root,'.validation'),{recursive:true});
  const cwd=await fs.mkdtemp(path.join(root,'.validation','theme-service-'));
  t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const state={mode:'workspace-write'},saved=[];
  const ctx={workingDirectory:{async ensure(){return cwd;}},sandboxPolicy:{resolve(){return{mode:state.mode,workspaceRoot:cwd};}},llm:{async resolveModelInfo(){return{inputModalities:['text','image']};}},attachments:{imageLimits:{maxImageDimension:4096},async saveImages(images){saved.push(...images);return images.map((image,i)=>({path:'stub-'+i+'.png',mediaType:image.mediaType,name:image.name}));}}};
  const exec={agent:{id:'theme-service',session:{requestHeader(){return{config:{provider:'test',model:'test'}};}}},signal:new AbortController().signal};
  const service=createZPixelService(ctx);t.after(()=>service.dispose());
  return{cwd,state,saved,run:(name,args)=>service.run(name,args,exec)};
}
const spec=()=>({title:'Workshop',summary:'A complete, warm primary mass with crisp quiet detail.',signature:['palette','form'],language:{form:'One dominant mass; details remain subordinate.',pixel:'Keep coherent pixel clusters.'},tokens:{colors:{ink:{value:'#191827',role:'outline'},body:{value:'#886644',role:'base'},accent:{value:'#558877',role:'accent'}},ramps:{matte:{stops:[{at:0,color:'body'},{at:1,color:'accent'}]}},materials:{wood:{ramp:'matte'}},defaultMaterial:'wood',outline:{enabled:true,width:1,direction:'inside',color:'ink'},appearanceShading:'unlit',ambient:1,lights:[]},rules:[{id:'palette',strength:'must',statement:'Every opaque output pixel belongs to the palette.',check:{kind:'palette'}},{id:'form',strength:'must',statement:'Keep the large form readable.',check:{kind:'visual'}}],source:{kind:'concept',decisions:['Warm colors and a sparse accent.']}});
const body=()=>({id:'body',kind:'part',geometry:{type:'box',center:[0,0,0],size:[4,2,4]}});
const values=()=>({width:16,height:16,camera:{preset:'top_down',pixelsPerUnit:2},nodes:[body(),{id:'mark',kind:'layer',parent:'body',appearanceOf:'body',appearanceShading:'unlit',width:4,height:4,pixelSize:1,basis:{u:[1,0,0],v:[0,0,1]},transform:{position:[-2,1,-2]},pixels:Array(16).fill('theme.workshop.accent')}]});
const review={identity:true,nativeReadable:true,lighting:true,note:'Technical test of theme report and immutable source snapshot.'};
const add=(run,id='workshop',value=spec())=>run('zpixel_theme',{action:'add',theme:id,spec:value,txid:'add-'+id});

test('theme create preloads initial pixel/material references and read never certifies a scene',async t=>{
  const{cwd,run}=await setup(t);const added=await add(run);
  const pack=await run('zpixel_theme',{action:'read',theme:'workshop',revision:0,context:{assetClass:'prop',nativeSize:[16,16]},sections:['form']});
  assert.equal(pack.theme.id,'workshop');assert.equal(pack.evaluation,'pending');
  assert.ok(pack.rules.some(r=>r.id==='palette'));assert.ok(pack.tokens.colors.some(color=>color.key==='accent'));
  const input=values();input.nodes[0].material='theme.workshop.wood';
  await run('zpixel_scene',{action:'create',document:'asset',txid:'asset-create',theme:{id:'workshop',revision:0,hash:added.hash,context:{assetClass:'prop'}},scene:input});
  const scene=await loadDocument(cwd,'asset');assert.equal(scene.theme.hash,added.hash);assert.equal(scene.theme.snapshot.revision,0);
  assert.equal(scene.nodes.find(n=>n.id==='body').material,'theme.workshop.wood');
  assert.equal(scene.nodes.find(n=>n.id==='mark').pixels[0],'theme.workshop.accent');
  const check=await run('zpixel_inspect',{document:'asset',kind:'theme'});
  assert.equal(check.theme_report.blocked,false);assert.equal(check.theme_report.mechanical.status,'pass');assert.equal(check.theme_report.visual.status,'needs_review');
  const preview=await run('zpixel_render',{document:'asset',scale:1});assert.deepEqual(preview.theme_report,check.theme_report);
  const normal=await run('zpixel_normalmap',{document:'asset',scale:1});assert.deepEqual(normal.theme_report,check.theme_report);
});

test('pinned snapshot survives theme revision changes and deletion for both export families',async t=>{
  const{cwd,run}=await setup(t);const first=await add(run);
  await run('zpixel_scene',{action:'create',document:'fixed',txid:'fixed-create',theme:{id:'workshop',revision:0},scene:values()});
  const original=await loadDocument(cwd,'fixed'),before=renderScene(original).rgba;
  const next=spec();next.tokens.colors.accent.value='#996633';
  await run('zpixel_theme',{action:'revise',theme:'workshop',expected_revision:0,spec:next,txid:'theme-update'});
  assert.equal((await run('zpixel_theme',{action:'read',theme:'workshop'})).theme.revision,1);
  assert.equal((await run('zpixel_theme',{action:'read',theme:'workshop',revision:0})).theme.revision,0);
  assert.deepEqual(renderScene(await loadDocument(cwd,'fixed')).rgba,before);
  await fs.unlink(path.join(cwd,'.zpixel','themes','workshop.json'));
  await run('zpixel_render',{document:'fixed',scale:1});
  await run('zpixel_render',{document:'fixed',camera:{preset:'three_quarter'},physicalOnly:true,scale:1});
  const result=await run('zpixel_export',{document:'fixed',draft:false,review});
  const manifest=JSON.parse(await fs.readFile(result.manifest,'utf8'));
  assert.equal(manifest.version,'0.5.3-dev');assert.equal(manifest.renderer.version,'0.3.6');assert.equal(manifest.theme.hash,first.hash);
  const snapshot=JSON.parse(await fs.readFile(path.join(path.dirname(result.manifest),'theme.json'),'utf8'));
  assert.deepEqual(snapshot,original.theme.snapshot);assert.equal(manifest.theme_report.blocked,false);
  const normal=await run('zpixel_normalmap',{document:'fixed',export:true,scale:1});
  const nm=JSON.parse(await fs.readFile(normal.manifest,'utf8'));
  assert.deepEqual(nm.theme_report,manifest.theme_report);assert.equal(nm.theme.hash,first.hash);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(path.dirname(normal.manifest),'theme.json'),'utf8')),snapshot);
  const imported=await run('zpixel_scene',{action:'create',document:'portable',txid:'portable-create',scene:{...original,id:'portable'}});
  assert.equal(imported.theme.hash,first.hash);
});

test('final hard failures block reviewed claims before writing, drafts and explicit deviations remain honest',async t=>{
  const{cwd,run}=await setup(t);await add(run);
  const input={width:8,height:8,camera:{preset:'top_down'},nodes:[{id:'paint',kind:'layer',width:8,height:8,basis:{u:[1,0,0],v:[0,0,1]},transform:{position:[-4,2,-4]},pixels:Array(64).fill('#ff00ff')}]};
  await run('zpixel_scene',{action:'create',document:'bad',txid:'bad-create',theme:{id:'workshop',revision:0},scene:input});
  const preview=await run('zpixel_render',{document:'bad',scale:1});assert.equal(preview.theme_report.blocked,true);
  await assert.rejects(run('zpixel_export',{document:'bad',draft:false,review}),e=>e.code==='THEME_RULES');
  await assert.rejects(fs.access(path.join(cwd,'.zpixel','exports')),e=>e.code==='ENOENT');
  const draft=await run('zpixel_export',{document:'bad',draft:true});assert.equal(draft.theme_report.blocked,true);
  const raw=JSON.parse(await fs.readFile(draft.manifest,'utf8'));assert.equal(raw.theme_report.checks.find(x=>x.id==='palette').status,'fail');
  await run('zpixel_scene',{action:'edit',document:'bad',revision:0,txid:'palette-exception',theme:{id:'workshop',revision:0,overrides:[{rule:'palette',reason:'The user explicitly requested a magenta quest marker.'}]}});
  const updated=await run('zpixel_render',{document:'bad',scale:1});assert.equal(updated.theme_report.blocked,false);
  assert.equal(updated.theme_report.checks.find(x=>x.id==='palette').status,'waived');assert.equal(updated.theme_report.deviations.length,1);
});

test('edit binding preserves global defaults, composes with paint, replays, rolls back and detaches through undo',async t=>{
  const{cwd,run}=await setup(t);await add(run);
  const v=values();v.nodes[1].pixels=Array(16).fill('white');
  await run('zpixel_scene',{action:'create',document:'editable',txid:'unthemed-create',scene:v});
  const previous=await loadDocument(cwd,'editable');
  const request={action:'edit',document:'editable',revision:0,txid:'bind-with-paint',theme:{id:'workshop',revision:0,bindings:[{node:'body',material:'wood',outline:true}]},ops:[{op:'paint',id:'mark',ops:[{op:'rect',x:0,y:0,w:4,h:4,color:'theme.workshop.accent'}]}]};
  const applied=await run('zpixel_scene',request);assert.equal(applied.revision,1);assert.equal(applied.theme_changes.defaultsApplied,false);
  const stored=await loadDocument(cwd,'editable');assert.deepEqual(stored.lights,previous.lights);assert.equal(stored.ambient,previous.ambient);assert.deepEqual(stored.camera,previous.camera);
  assert.equal(stored.nodes.find(n=>n.id==='mark').pixels[0],'theme.workshop.accent');
  assert.equal((await run('zpixel_scene',request)).replayed,true);
  const file=path.join(cwd,'.zpixel','documents','editable.json'),bytes=await fs.readFile(file);
  await assert.rejects(run('zpixel_scene',{action:'edit',document:'editable',revision:1,txid:'invalid-target',theme:{id:'workshop',revision:0,bindings:[{node:'missing',material:'wood'}]}}),e=>e.code==='NODE_NOT_FOUND');
  assert.deepEqual(await fs.readFile(file),bytes);
  await run('zpixel_scene',{action:'edit',document:'editable',revision:1,txid:'detach',theme:null});
  let scene=await loadDocument(cwd,'editable');assert.equal(scene.theme,undefined);assert.deepEqual(scene.palette,stored.palette);assert.deepEqual(scene.nodes,stored.nodes);
  await run('zpixel_scene',{action:'undo',document:'editable',revision:2,txid:'undo-detach'});
  scene=await loadDocument(cwd,'editable');assert.equal(scene.theme.id,'workshop');
});

test('unsupported requested tokens are storable and readable but cannot silently bind',async t=>{
  const{cwd,run}=await setup(t);const unsupported=spec();unsupported.tokens.outline.width=2;
  const result=await add(run,'thick',unsupported);assert.ok(result.capabilities.unsupported.some(x=>x.feature==='outline width'));
  const pack=await run('zpixel_theme',{action:'read',theme:'thick'});assert.equal(pack.bindings.blocked,true);
  await assert.rejects(run('zpixel_scene',{action:'create',document:'unsupported',txid:'unsupported-create',theme:{id:'thick',revision:0},scene:{nodes:[body()]}}),e=>e.code==='THEME_UNSUPPORTED');
  await assert.rejects(fs.access(path.join(cwd,'.zpixel','documents','unsupported.json')),e=>e.code==='ENOENT');
});

test('selected reference delivery verifies hash, availability, read-only policy and action fields',async t=>{
  const{cwd,state,run,saved}=await setup(t);
  const image=encodePNG(1,1,new Uint8Array([1,2,3,255]));await fs.writeFile(path.join(cwd,'reference.png'),image);
  const value=spec();value.source={kind:'reference',observations:['One measured technical pixel.'],inferences:['No style inference from this technical image.']};
  value.references=[{id:'r',path:'reference.png',sha256:createHash('sha256').update(image).digest('hex'),role:'reference'}];
  await add(run,'reference-theme',value);
  state.mode='read-only';
  const pack=await run('zpixel_theme',{action:'read',theme:'reference-theme',reference:'r'});assert.ok(pack.attachment);assert.ok(saved.length);assert.equal(pack.reference.sha256,value.references[0].sha256);
  assert.equal((await run('zpixel_theme',{action:'list',query:'reference-theme'})).themes.length,1);
  await assert.rejects(add(run,'denied'),e=>e.code==='READ_ONLY');
  await assert.rejects(run('zpixel_theme',{action:'read',theme:'reference-theme',spec:{}}),e=>e.code==='THEME_ARGUMENT');
  await fs.writeFile(path.join(cwd,'reference.png'),Buffer.from('changed'));
  await assert.rejects(run('zpixel_theme',{action:'read',theme:'reference-theme',reference:'r'}),e=>e.code==='THEME_REFERENCE_CHANGED');
});

test('published theme guide calls execute through the actual service',async t=>{
  const{run}=await setup(t),text=guide('theme').text,results=[];
  for(const line of text.split('\n')){
    const match=line.match(/^(zpixel_theme|zpixel_scene|zpixel_inspect|zpixel_render|zpixel_export)[(]/);
    if(!match)continue;
    const name=match[1],args=Function('return ('+line.slice(name.length+1,-1)+')')();
    results.push({name,result:await run(name,args)});
  }
  assert.ok(results.some(x=>x.name==='zpixel_theme'));
  assert.ok(results.some(x=>x.name==='zpixel_export'&&x.result.theme_report));
});

test('explicit initial resources win and theme camera is resolved before view-plane shorthand',async t=>{
  const{cwd,run}=await setup(t);const themed=spec();themed.tokens.camera={preset:'three_quarter',pixelsPerUnit:3};
  await add(run,'framed',themed);
  const initial={width:16,height:16,palette:{'theme.framed.accent':'#ABCDEF'},ramps:{'theme.framed.matte':{stops:[{at:0,color:'theme.framed.body'}]}},materials:{'theme.framed.wood':{ramp:'theme.framed.matte',diffuse:.5}},nodes:[body(),{id:'view',kind:'layer',width:1,height:1,plane:'view',pixels:[null]}]};
  const result=await run('zpixel_scene',{action:'create',document:'framed',txid:'framed-create',theme:{id:'framed',revision:0},scene:initial});
  const stored=await loadDocument(cwd,'framed');
  assert.equal(stored.palette['theme.framed.accent'],'#ABCDEF');
  assert.equal(stored.ramps['theme.framed.matte'].stops.length,1);
  assert.equal(stored.materials['theme.framed.wood'].diffuse,.5);
  assert.ok(result.theme_changes.preservedExplicit.palette.includes('theme.framed.accent'));
  const basis=cameraBasis(stored),view=stored.nodes.find(n=>n.id==='view');
  assert.deepEqual(view.basis,{u:basis.right.map(v=>v||0),v:basis.down.map(v=>v||0)});
  const plain={width:16,height:16,camera:{preset:'top_down',pixelsPerUnit:2},nodes:[body()]};
  await run('zpixel_scene',{action:'create',document:'later',txid:'later-create',scene:plain});
  await run('zpixel_scene',{action:'edit',document:'later',revision:0,txid:'later-theme-view',theme:{id:'framed',revision:0,applyDefaults:true},ops:[{op:'node_add',node:{id:'view',kind:'layer',width:1,height:1,plane:'view',pixels:[null]}}]});
  const edited=await loadDocument(cwd,'later'),eb=cameraBasis(edited);
  assert.deepEqual(edited.nodes.find(n=>n.id==='view').basis,{u:eb.right.map(v=>v||0),v:eb.down.map(v=>v||0)});
});

test('theme revision replacement requires explicit conflict handling and reports retained resources',async t=>{
  const{cwd,run}=await setup(t);await add(run);
  await run('zpixel_scene',{action:'create',document:'switch',txid:'switch-create',theme:{id:'workshop',revision:0},scene:values()});
  const next=spec();next.tokens.colors.accent.value='#996633';
  await run('zpixel_theme',{action:'revise',theme:'workshop',expected_revision:0,spec:next,txid:'workshop-r1'});
  await assert.rejects(run('zpixel_scene',{action:'edit',document:'switch',revision:0,txid:'replace-required',theme:{id:'workshop',revision:1}}),e=>e.code==='THEME_CONFLICT');
  await assert.rejects(run('zpixel_scene',{action:'edit',document:'switch',revision:0,txid:'overwrite-required',theme:{id:'workshop',revision:1,replace:true}}),e=>e.code==='THEME_RESOURCE_CONFLICT');
  await run('zpixel_scene',{action:'edit',document:'switch',revision:0,txid:'switch-r1',theme:{id:'workshop',revision:1,replace:true,overwrite:true}});
  assert.equal((await loadDocument(cwd,'switch')).theme.revision,1);
  const other=spec();await add(run,'other',other);
  const changed=await run('zpixel_scene',{action:'edit',document:'switch',revision:1,txid:'switch-other',theme:{id:'other',revision:0,replace:true}});
  assert.ok(changed.theme_changes.retainedResources.palette.includes('theme.workshop.accent'));
  assert.equal((await loadDocument(cwd,'switch')).theme.id,'other');
});

