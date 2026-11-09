import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createZPixelServiceForTest as createZPixelService} from './helpers.mjs';
import {createScene} from '../src/scene.mjs';
import {loadDocument, fingerprint} from '../src/store.mjs';
import {structureHash} from '../src/observation.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const oblique={position:[10,10,10],target:[0,0,0],up:[0,1,0]};
const review={identity:true,nativeReadable:true,lighting:true,note:'Focused model-first service fixture review.'};
const partScene=id=>({width:16,height:16,camera:{preset:'top_down',pixelsPerUnit:2},nodes:[{id:'block',kind:'part',geometry:{type:'box',center:[0,1,0],size:[4,2,4]}}]});
const flatScene=()=>({width:8,height:8,camera:{preset:'top_down'},nodes:[{id:'icon',kind:'layer',width:8,height:8,plane:'xz',pixels:Array(64).fill('ink')}]});
async function setup(t){
  await fs.mkdir(path.join(root,'.validation'),{recursive:true});
  const cwd=await fs.mkdtemp(path.join(root,'.validation','model-first-service-'));
  t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const saved=[];
  const ctx={workingDirectory:{async ensure(){return cwd;}},sandboxPolicy:{resolve(){return{mode:'workspace-write',workspaceRoot:cwd};}},llm:{async resolveModelInfo(){return{inputModalities:['text','image']};}},attachments:{imageLimits:{maxImageDimension:4096},async saveImages(images){saved.push(...images);return images.map((image,index)=>({path:'stub-'+index+'.png',mediaType:image.mediaType,name:image.name}));}}};
  const exec={agent:{id:'model-first-service',session:{requestHeader(){return{config:{provider:'test',model:'test'}};}}},signal:new AbortController().signal};
  const service=createZPixelService(ctx);t.after(()=>service.dispose());
  return{cwd,saved,run:(name,args)=>service.run(name,args,exec)};
}
const readManifest=async file=>JSON.parse(await fs.readFile(file,'utf8'));

test('fresh creates are model-first, complete snapshots stay legacy, and the contract is immutable',async t=>{
  const{cwd,run}=await setup(t);
  const created=await run('zpixel_scene',{action:'create',document:'fresh',txid:'fresh-create',scene:partScene('fresh')});
  assert.equal(created.contract,'model-first/1');
  assert.equal((await loadDocument(cwd,'fresh')).contract,'model-first/1');
  const snapshot=createScene({id:'legacy-snap',width:16,height:16,camera:{preset:'top_down'},nodes:[{id:'block',kind:'part',geometry:{type:'box',center:[0,1,0],size:[2,2,2]}}]});
  await run('zpixel_scene',{action:'create',document:'legacy-snap',txid:'legacy-create',scene:snapshot});
  assert.equal(Object.hasOwn(await loadDocument(cwd,'legacy-snap'),'contract'),false);
  assert.equal(Object.hasOwn(createScene({id:'direct'}),'contract'),false);
  await assert.rejects(run('zpixel_scene',{action:'edit',document:'fresh',revision:0,txid:'remove-contract',ops:[{op:'scene_set',values:{contract:null}}]}),error=>error.code==='UNKNOWN_FIELD');
  assert.equal((await loadDocument(cwd,'fresh')).contract,'model-first/1');
  assert.equal((await run('zpixel_scene',{action:'open',document:'fresh'})).contract,'model-first/1');
  assert.equal((await run('zpixel_scene',{action:'create',document:'flat',txid:'flat-create',scene:flatScene()})).contract,'model-first/1');
});

test('render separates delivery from observation, never saves, and validates expected revision/hash',async t=>{
  const{cwd,run}=await setup(t);
  await run('zpixel_scene',{action:'create',document:'spatial',txid:'spatial-create',scene:partScene('spatial')});
  const before=await loadDocument(cwd,'spatial'),file=path.join(cwd,'.zpixel','documents','spatial.json'),bytes=await fs.readFile(file);
  const delivery=await run('zpixel_render',{document:'spatial',scale:1});
  assert.equal(delivery.delivery,true);assert.equal(delivery.observation.delivery,true);assert.match(delivery.observationId,/^view-/);
  assert.equal(delivery.structureHash,structureHash(before));assert.equal(delivery.contentHash,fingerprint(before));
  const observation=await run('zpixel_render',{document:'spatial',scale:1,camera:oblique,physicalOnly:true,fit:true});
  assert.equal(observation.delivery,false);assert.equal(observation.observation.delivery,false);
  assert.ok(observation.view.deliveryAngleDegrees>=20);assert.ok(observation.view.separationDegrees>=20);assert.ok(observation.view.partPixels>0);assert.equal(observation.view.wholeScene,true);
  assert.equal(observation.observation.structureHash,delivery.structureHash);assert.equal(observation.observation.contentHash,delivery.contentHash);
  assert.deepEqual(observation.observation.deliveredTo,['model-first-service']);
  assert.deepEqual(await fs.readFile(file),bytes);assert.equal((await loadDocument(cwd,'spatial')).revision,0);
  await assert.rejects(run('zpixel_render',{document:'spatial',expectedRevision:9}),error=>error.code==='REVISION_CONFLICT');
  await assert.rejects(run('zpixel_render',{document:'spatial',expectedHash:'0'.repeat(64)}),error=>error.code==='HASH_CONFLICT');
  assert.equal((await run('zpixel_render',{document:'spatial',expectedRevision:0,expectedHash:delivery.contentHash,scale:1})).contentHash,delivery.contentHash);
});

test('reviewed export needs a delivered non-delivery observation; draft and waiver stay honest',async t=>{
  const{cwd,run}=await setup(t);
  await run('zpixel_scene',{action:'create',document:'gate',txid:'gate-create',scene:partScene('gate')});
  const draft=await run('zpixel_export',{document:'gate',draft:true});
  const draftManifest=await readManifest(draft.manifest);
  assert.equal(draftManifest.observation.status,'not-observed');assert.equal(draftManifest.observation.draft,true);
  await assert.rejects(run('zpixel_export',{document:'gate',draft:false,review}),error=>error.code==='PREVIEW_REQUIRED');
  const delivery=await run('zpixel_render',{document:'gate',scale:1});
  await assert.rejects(run('zpixel_export',{document:'gate',draft:false,review}),error=>error.code==='OBSERVATION_REQUIRED');
  const first=await run('zpixel_render',{document:'gate',scale:1,camera:oblique,physicalOnly:true});
  await run('zpixel_render',{document:'gate',scale:1,camera:{position:[-10,10,10],target:[0,0,0],up:[0,1,0]},physicalOnly:true});
  const reviewed=await run('zpixel_export',{document:'gate',draft:false,review});
  const manifest=await readManifest(reviewed.manifest);
  assert.equal(manifest.status,'reviewed');assert.equal(manifest.observation.status,'observed');
  assert.equal(manifest.observation.receipt.id,first.observation.id);
  assert.equal(manifest.structureHash,delivery.structureHash);assert.deepEqual(manifest.camera,delivery.view.camera);
  assert.ok(Array.isArray(manifest.spatial.edges));assert.equal(manifest.observation.minimumSeparationDegrees,20);assert.deepEqual(manifest.observation.qualifyingDeliveryAngleRange,[20,160]);
  await run('zpixel_scene',{action:'create',document:'waived',txid:'waived-create',scene:partScene('waived')});
  await run('zpixel_render',{document:'waived',scale:1});
  const reason='The user explicitly requested no extra observation for this fixture.';
  const waived=await run('zpixel_export',{document:'waived',draft:false,review,structureReview:{waived:true,reason}});
  const waivedManifest=await readManifest(waived.manifest);
  assert.equal(waivedManifest.observation.status,'waived');assert.equal(waivedManifest.observation.waiver.reason,reason);assert.equal(waived.structureReview.waived,true);
  await run('zpixel_scene',{action:'create',document:'flat-gate',txid:'flat-gate-create',scene:flatScene()});
  await run('zpixel_render',{document:'flat-gate',scale:1});
  const flatManifest=await readManifest((await run('zpixel_export',{document:'flat-gate',draft:false,review})).manifest);
  assert.equal(flatManifest.observation.status,'flat-only-exempt');assert.equal(flatManifest.observation.required,false);
  const snapshot=createScene({id:'legacy-gate',width:16,height:16,camera:{preset:'top_down'},nodes:[{id:'block',kind:'part',geometry:{type:'box',center:[0,1,0],size:[2,2,2]}}]});
  await run('zpixel_scene',{action:'create',document:'legacy-gate',txid:'legacy-gate-create',scene:snapshot});
  await run('zpixel_render',{document:'legacy-gate',scale:1});
  const legacyManifest=await readManifest((await run('zpixel_export',{document:'legacy-gate',draft:false,review})).manifest);
  assert.equal(legacyManifest.observation.status,'legacy-none');assert.equal(legacyManifest.observation.required,false);
});

test('scene preview:true is a fitted physical-only working view for model-first spatial docs',async t=>{
  const{cwd,run}=await setup(t);
  const created=await run('zpixel_scene',{action:'create',document:'working',txid:'working-create',scene:partScene('working'),preview:true});
  assert.ok(created.attachment);assert.equal(created.preview.delivery,false);assert.equal(created.preview.workingView,true);
  assert.equal(created.preview.view.physicalOnly,true);assert.equal(created.preview.view.fit,true);
  assert.ok(created.preview.view.deliveryAngleDegrees>=20);assert.ok(created.preview.view.partPixels>0);
  assert.equal(created.preview.observation.delivery,false);
  await assert.rejects(run('zpixel_export',{document:'working',draft:false,review}),error=>error.code==='PREVIEW_REQUIRED');
  await run('zpixel_render',{document:'working',scale:1});
  const manifest=await readManifest((await run('zpixel_export',{document:'working',draft:false,review})).manifest);
  assert.equal(manifest.observation.status,'observed');assert.equal(manifest.observation.receipt.id,created.preview.observation.id);
  const flat=await run('zpixel_scene',{action:'create',document:'flat-preview',txid:'flat-preview-create',scene:flatScene(),preview:true});
  assert.equal(flat.preview.delivery,true);assert.equal(flat.preview.workingView,undefined);
  const snapshot=createScene({id:'legacy-preview',width:8,height:8,camera:{preset:'top_down'},nodes:[{id:'block',kind:'part',geometry:{type:'box',center:[0,1,0],size:[2,2,2]}}]});
  const legacy=await run('zpixel_scene',{action:'create',document:'legacy-preview',txid:'legacy-preview-create',scene:snapshot,preview:true});
  assert.equal(legacy.preview.delivery,true);assert.equal(legacy.preview.workingView,undefined);
  void cwd;
});

test('inspect shares the observation view, kind:view delivers an image, text-only probes never unlock',async t=>{
  const{run}=await setup(t);
  await run('zpixel_scene',{action:'create',document:'inspect',txid:'inspect-create',scene:partScene('inspect')});
  const render=await run('zpixel_render',{document:'inspect',scale:1,camera:oblique,physicalOnly:true});
  const pixel=await run('zpixel_inspect',{document:'inspect',kind:'pixel',x:8,y:8,camera:oblique,physicalOnly:true});
  assert.equal(pixel.delivery,false);assert.equal(pixel.viewHash,render.viewHash);assert.equal(pixel.structureHash,render.structureHash);
  assert.equal(pixel.pixels[0].hit.nodeId,'block');
  const region=await run('zpixel_inspect',{document:'inspect',kind:'region',x:7,y:7,w:2,h:2,camera:oblique,physicalOnly:true});
  assert.equal(region.viewHash,render.viewHash);
  const spatial=await run('zpixel_inspect',{document:'inspect',kind:'spatial',node:'block',camera:oblique,physicalOnly:true,include_projection:true});
  assert.equal(spatial.delivery,false);assert.equal(spatial.viewHash,render.viewHash);assert.ok(spatial.nodes[0].projectionInfo.visiblePixels>0);
  await assert.rejects(run('zpixel_inspect',{document:'inspect',kind:'tree',camera:oblique}),error=>error.code==='OBSERVATION_ARGUMENT');
  await run('zpixel_scene',{action:'create',document:'text-only',txid:'text-only-create',scene:partScene('text-only')});
  await run('zpixel_render',{document:'text-only',scale:1});
  await run('zpixel_inspect',{document:'text-only',kind:'pixel',x:8,y:8,camera:oblique,physicalOnly:true});
  await assert.rejects(run('zpixel_export',{document:'text-only',draft:false,review}),error=>error.code==='OBSERVATION_REQUIRED');
  const view=await run('zpixel_inspect',{document:'text-only',kind:'view',camera:oblique,physicalOnly:true,scale:1});
  assert.ok(view.attachment);assert.equal(view.delivery,false);assert.equal(view.observation.delivery,false);
  const manifest=await readManifest((await run('zpixel_export',{document:'text-only',draft:false,review})).manifest);
  assert.equal(manifest.observation.status,'observed');
});

test('physicalOnly hides layers, isolate rejects physical ancestors, and isolate is not gate-qualifying',async t=>{
  const{run}=await setup(t);
  const occluded={width:16,height:16,camera:{preset:'top_down',pixelsPerUnit:2},nodes:[
    {id:'block',kind:'part',geometry:{type:'box',center:[0,1,0],size:[4,2,4]}},
    {id:'paint',kind:'layer',width:16,height:16,pixelSize:1,plane:'xz',transform:{position:[-8,3,8]},pixels:Array(256).fill('ink')}
  ]};
  await run('zpixel_scene',{action:'create',document:'occluded',txid:'occluded-create',scene:occluded});
  assert.equal((await run('zpixel_inspect',{document:'occluded',kind:'pixel',x:8,y:8})).pixels[0].hit.nodeId,'paint');
  assert.equal((await run('zpixel_inspect',{document:'occluded',kind:'pixel',x:8,y:8,physicalOnly:true})).pixels[0].hit.nodeId,'block');
  const nested={width:16,height:16,camera:{preset:'top_down'},nodes:[
    {id:'hull',kind:'part',geometry:{type:'box',center:[0,1,0],size:[4,2,4]}},
    {id:'turret',kind:'part',parent:'hull',geometry:{type:'cylinder',center:[0,3,0],radius:1,length:1,axis:'y'}}
  ]};
  await run('zpixel_scene',{action:'create',document:'nested',txid:'nested-create',scene:nested});
  await assert.rejects(run('zpixel_render',{document:'nested',isolate:'turret',camera:oblique}),error=>error.code==='OBSERVATION_ISOLATE');
  assert.equal((await run('zpixel_render',{document:'nested',isolate:'hull',camera:oblique,physicalOnly:true})).observation.isolate,'hull');
  const hiddenIsolate={width:16,height:16,camera:{preset:'top_down'},nodes:[
    {id:'rig',kind:'group',visible:false},
    {id:'gun',kind:'part',parent:'rig',geometry:{type:'box',center:[0,1,0],size:[2,2,2]}},
    {id:'solo',kind:'part',visible:false,geometry:{type:'box',center:[0,1,0],size:[2,2,2]}}
  ]};
  await run('zpixel_scene',{action:'create',document:'hidden-isolate',txid:'hidden-isolate-create',scene:hiddenIsolate});
  await assert.rejects(run('zpixel_render',{document:'hidden-isolate',isolate:'gun',camera:oblique}),error=>error.code==='OBSERVATION_ISOLATE');
  await assert.rejects(run('zpixel_render',{document:'hidden-isolate',isolate:'solo',camera:oblique}),error=>error.code==='OBSERVATION_ISOLATE');
  const appearance={width:16,height:16,camera:{preset:'top_down'},nodes:[
    {id:'body',kind:'part',geometry:{type:'box',center:[0,1,0],size:[4,2,4]}},
    {id:'decal',kind:'layer',parent:'body',appearanceOf:'body',width:4,height:4,pixelSize:1,basis:{u:[1,0,0],v:[0,0,1]},transform:{position:[-2,2,-2]},pixels:Array(16).fill('ink')}
  ]};
  await run('zpixel_scene',{action:'create',document:'appearance',txid:'appearance-create',scene:appearance});
  await assert.rejects(run('zpixel_render',{document:'appearance',isolate:'decal',camera:oblique}),error=>error.code==='OBSERVATION_ISOLATE');
  const grouped={width:16,height:16,camera:{preset:'top_down'},nodes:[
    {id:'rig',kind:'group'},
    {id:'gun',kind:'part',parent:'rig',geometry:{type:'box',center:[0,1,0],size:[4,2,4]}}
  ]};
  await run('zpixel_scene',{action:'create',document:'grouped',txid:'grouped-create',scene:grouped});
  const groupObs=await run('zpixel_render',{document:'grouped',isolate:'rig',camera:oblique,physicalOnly:true});
  assert.equal(groupObs.observation.isolate,'rig');assert.ok(groupObs.view.partPixels>0);
  await run('zpixel_render',{document:'grouped',scale:1});
  await assert.rejects(run('zpixel_export',{document:'grouped',draft:false,review}),error=>error.code==='OBSERVATION_REQUIRED');
});

test('fit is an outer render argument that centers observed bounds and shifts the eye with the target',async t=>{
  const{run}=await setup(t);
  await run('zpixel_scene',{action:'create',document:'fit',txid:'fit-create',scene:partScene('fit')});
  const fitted=await run('zpixel_render',{document:'fit',scale:1,camera:{position:[5,100,5],target:[5,0,5],up:[0,0,-1],pixelsPerUnit:1,center:[8,8]},fit:true});
  assert.deepEqual(fitted.view.camera.target,[0,1,0]);
  assert.deepEqual(fitted.view.camera.position,[0,101,0]);
  assert.equal(fitted.view.camera.pixelsPerUnit,3.5);
  assert.deepEqual(fitted.view.camera.center,[8,8]);
  const unfitted=await run('zpixel_render',{document:'fit',scale:1,camera:{position:[5,100,5],target:[5,0,5],up:[0,0,-1],pixelsPerUnit:1,center:[8,8]},fit:false});
  assert.deepEqual(unfitted.view.camera.target,[5,0,5]);assert.deepEqual(unfitted.view.camera.position,[5,100,5]);
  assert.equal(unfitted.view.camera.pixelsPerUnit,1);assert.deepEqual(unfitted.view.camera.center,[8,8]);
});

test('normalmap manifests carry structure/spatial/observation without unlocking the gate',async t=>{
  const{run}=await setup(t);
  await run('zpixel_scene',{action:'create',document:'normal',txid:'normal-create',scene:partScene('normal')});
  const exported=await run('zpixel_normalmap',{document:'normal',export:true,scale:1});
  const manifest=await readManifest(exported.manifest);
  assert.equal(manifest.structureHash,exported.structureHash);
  assert.ok(Array.isArray(manifest.spatial.edges));
  assert.equal(manifest.observation.countsAsObservation,false);assert.equal(manifest.observation.status,'not-observed');
  assert.deepEqual(manifest.camera,manifest.renderer.camera);
  await run('zpixel_render',{document:'normal',scale:1});
  await assert.rejects(run('zpixel_export',{document:'normal',draft:false,review}),error=>error.code==='OBSERVATION_REQUIRED');
});
async function setupSwitchable(t){
  await fs.mkdir(path.join(root,'.validation'),{recursive:true});
  const first=await fs.mkdtemp(path.join(root,'.validation','model-first-service-a-'));
  const second=await fs.mkdtemp(path.join(root,'.validation','model-first-service-b-'));
  t.after(()=>Promise.all([fs.rm(first,{recursive:true,force:true}),fs.rm(second,{recursive:true,force:true})]));
  const state={current:first},saved=[];
  const ctx={workingDirectory:{async ensure(){return state.current;}},sandboxPolicy:{resolve(){return{mode:'workspace-write',workspaceRoot:state.current};}},llm:{async resolveModelInfo(){return{inputModalities:['text','image']};}},attachments:{imageLimits:{maxImageDimension:4096},async saveImages(images){saved.push(...images);return images.map((image,index)=>({path:'stub-'+index+'.png',mediaType:image.mediaType,name:image.name}));}}};
  const exec={agent:{id:'model-first-service',session:{requestHeader(){return{config:{provider:'test',model:'test'}};}}},signal:new AbortController().signal};
  const service=createZPixelService(ctx);t.after(()=>service.dispose());
  return{first,second,state,run:(name,args)=>service.run(name,args,exec)};
}

test('review fixes: workspace scoping, fit validation, same-camera requests, inspect pins, no delivery fallback, authoring status',async t=>{
  // One service instance, one agent, two workspaces: a deterministic receipt id
  // from workspace A must never satisfy the gate in workspace B.
  const{first,second,state,run:runShared}=await setupSwitchable(t);
  state.current=first;
  await runShared('zpixel_scene',{action:'create',document:'shared',txid:'shared-a',scene:partScene('shared')});
  await runShared('zpixel_render',{document:'shared',scale:1,camera:oblique,physicalOnly:true});
  state.current=second;
  await runShared('zpixel_scene',{action:'create',document:'shared',txid:'shared-b',scene:partScene('shared')});
  await runShared('zpixel_render',{document:'shared',scale:1});
  await assert.rejects(runShared('zpixel_export',{document:'shared',draft:false,review}),error=>error.code==='OBSERVATION_REQUIRED');
  await runShared('zpixel_render',{document:'shared',scale:1,camera:oblique,physicalOnly:true});
  assert.equal((await runShared('zpixel_export',{document:'shared',draft:false,review})).status,'reviewed');

  const{cwd,run}=await setup(t);
  await run('zpixel_scene',{action:'create',document:'fit-guard',txid:'fit-guard-create',scene:partScene('fit-guard')});
  await assert.rejects(run('zpixel_render',{document:'fit-guard',fit:true}),error=>error.code==='OBSERVATION_FIT');
  await assert.rejects(run('zpixel_render',{document:'fit-guard',fit:false}),error=>error.code==='OBSERVATION_FIT');

  await run('zpixel_scene',{action:'create',document:'same-camera',txid:'same-camera-create',scene:partScene('same-camera')});
  const stored=await loadDocument(cwd,'same-camera');
  const same=await run('zpixel_render',{document:'same-camera',scale:1,camera:stored.camera,fit:false});
  assert.equal(same.delivery,false);assert.equal(same.observation.delivery,false);assert.equal(same.view.deliveryAngleDegrees,0);
  assert.equal(same.authoring.deliveryPreview,'none');assert.equal(same.authoring.observation,'none');
  await assert.rejects(run('zpixel_export',{document:'same-camera',draft:false,review}),error=>error.code==='PREVIEW_REQUIRED');
  const delivery=await run('zpixel_render',{document:'same-camera',scale:1});
  assert.equal(delivery.authoring.deliveryPreview,'current');
  await assert.rejects(run('zpixel_export',{document:'same-camera',draft:false,review}),error=>error.code==='OBSERVATION_REQUIRED');
  await assert.rejects(run('zpixel_inspect',{document:'same-camera',kind:'pixel',x:8,y:8,expectedRevision:9}),error=>error.code==='REVISION_CONFLICT');
  await assert.rejects(run('zpixel_inspect',{document:'same-camera',kind:'tree',expectedHash:'0'.repeat(64)}),error=>error.code==='HASH_CONFLICT');
  await run('zpixel_scene',{action:'create',document:'camera-errors',txid:'camera-errors-create',scene:partScene('camera-errors')});
  await assert.rejects(run('zpixel_render',{document:'camera-errors',camera:{position:[0,10,0],target:[0,0,0],up:[0,0,-1],pixelsPerUnit:0}}),error=>error.code==='INVALID_NUMBER');
  await assert.rejects(run('zpixel_render',{document:'camera-errors',camera:{position:[0,10,0],target:[0,0,0],up:[0,0,-1],center:[8]}}),error=>error.code==='INVALID_FIELD');
  await assert.rejects(run('zpixel_render',{document:'camera-errors',camera:{position:[0,0,0],target:[0,0,0],up:[0,0,-1]}}),error=>error.code==='CAMERA_BASIS');

  const hidden={width:16,height:16,camera:{preset:'top_down'},nodes:[{id:'block',kind:'part',visible:false,geometry:{type:'box',center:[0,1,0],size:[4,2,4]}}]};
  const hiddenCreated=await run('zpixel_scene',{action:'create',document:'hidden',txid:'hidden-create',scene:hidden,preview:true});
  assert.equal(hiddenCreated.preview,undefined);assert.equal(hiddenCreated.attachment,undefined);
  assert.equal(hiddenCreated.previewError.code,'NO_VISIBLE_STRUCTURE');
  assert.equal(hiddenCreated.authoring.observation,'none');assert.equal(hiddenCreated.authoring.deliveryPreview,'none');
  await assert.rejects(run('zpixel_export',{document:'hidden',draft:false,review}),error=>error.code==='PREVIEW_REQUIRED');
  await run('zpixel_render',{document:'hidden',scale:1});
  await assert.rejects(run('zpixel_export',{document:'hidden',draft:false,review}),error=>error.code==='OBSERVATION_REQUIRED');

  const created=await run('zpixel_scene',{action:'create',document:'status',txid:'status-create',scene:partScene('status'),preview:true});
  assert.equal(created.authoring.contract,'model-first/1');assert.equal(created.authoring.observation,'valid');assert.equal(created.authoring.deliveryPreview,'none');
  assert.equal(created.authoring.structureHash,created.preview.structureHash);assert.equal(created.authoring.contentHash,created.preview.contentHash);
  const statusDelivery=await run('zpixel_render',{document:'status',scale:1});
  assert.equal(statusDelivery.authoring.deliveryPreview,'current');assert.equal(statusDelivery.authoring.observation,'valid');
  const moved=await run('zpixel_scene',{action:'edit',document:'status',revision:0,txid:'status-move',ops:[{op:'transform',id:'block',translate:[1,0,0]}]});
  assert.equal(moved.authoring.observation,'stale');assert.equal(moved.authoring.deliveryPreview,'none');
  await run('zpixel_render',{document:'status',scale:1});
  await assert.rejects(run('zpixel_export',{document:'status',draft:false,review}),error=>error.code==='OBSERVATION_REQUIRED');
  await run('zpixel_render',{document:'status',scale:1,camera:oblique,physicalOnly:true});
  assert.equal((await run('zpixel_export',{document:'status',draft:false,review})).status,'reviewed');
  const painted=await run('zpixel_scene',{action:'edit',document:'status',revision:1,txid:'status-paint',ops:[{op:'palette_set',id:'ink',color:'#000000'}]});
  assert.equal(painted.authoring.observation,'valid');assert.equal(painted.authoring.deliveryPreview,'none');
  await run('zpixel_render',{document:'status',scale:1});
  assert.equal((await run('zpixel_export',{document:'status',draft:false,review})).status,'reviewed');
});
test('delivery preview evidence survives cache eviction by other observation views',async t=>{
  const{run}=await setup(t);
  const scene={width:256,height:256,camera:{preset:'top_down',pixelsPerUnit:1},nodes:[{id:'block',kind:'part',geometry:{type:'box',center:[0,1,0],size:[200,2,200]}}]};
  await run('zpixel_scene',{action:'create',document:'evict',txid:'evict-create',scene});
  await run('zpixel_render',{document:'evict',scale:1});
  await run('zpixel_render',{document:'evict',scale:1,camera:oblique,physicalOnly:true});
  for(let index=0;index<4;index++){
    await run('zpixel_inspect',{document:'evict',kind:'pixel',x:128,y:128,camera:{position:[20,20,20],target:[0,0,0],up:[0,1,0],mirrorX:false,pixelsPerUnit:2,center:[128+index,128]},fit:false,physicalOnly:true});
  }
  const opened=await run('zpixel_scene',{action:'open',document:'evict'});
  assert.equal(opened.authoring.deliveryPreview,'current');
  assert.equal(opened.authoring.observation,'valid');
  const reviewed=await run('zpixel_export',{document:'evict',draft:false,review});
  assert.equal(reviewed.status,'reviewed');
});
test('exactly opposite observation views do not satisfy the gate',async t=>{
  const{run}=await setup(t);
  await run('zpixel_scene',{action:'create',document:'opposite',txid:'opposite-create',scene:partScene('opposite')});
  await run('zpixel_render',{document:'opposite',scale:1});
  const opposite=await run('zpixel_render',{document:'opposite',scale:1,camera:{position:[0,-100,0],target:[0,0,0],up:[0,0,-1],mirrorX:false,pixelsPerUnit:2,center:[8,8]},fit:false});
  assert.ok(opposite.view.deliveryAngleDegrees>=179.999);
  assert.ok(opposite.view.separationDegrees<1e-6);
  assert.ok(opposite.view.partPixels>0);
  await assert.rejects(run('zpixel_export',{document:'opposite',draft:false,review}),error=>error.code==='OBSERVATION_REQUIRED');
  await run('zpixel_render',{document:'opposite',scale:1,camera:oblique,physicalOnly:true});
  assert.equal((await run('zpixel_export',{document:'opposite',draft:false,review})).status,'reviewed');
});

test('outline-only part frames do not count as visible part pixels',async t=>{
  const{run}=await setup(t);
  const scene={width:16,height:16,camera:{preset:'top_down',pixelsPerUnit:2},nodes:[{id:'pin',kind:'part',geometry:{type:'box',center:[0,1,0],size:[0.5,0.5,0.5]}}]};
  await run('zpixel_scene',{action:'create',document:'outline-only',txid:'outline-only-create',scene});
  await run('zpixel_render',{document:'outline-only',scale:1});
  const outlineOnly=await run('zpixel_render',{document:'outline-only',scale:1,camera:{position:[10,10,10],target:[0,0,0],up:[0,1,0],mirrorX:false,pixelsPerUnit:2,center:[8,8]},fit:false});
  assert.equal(outlineOnly.view.partPixels,0);
  assert.ok(outlineOnly.view.separationDegrees>=20);
  await assert.rejects(run('zpixel_export',{document:'outline-only',draft:false,review}),error=>error.code==='OBSERVATION_REQUIRED');
  await run('zpixel_render',{document:'outline-only',scale:1,camera:oblique});
  assert.equal((await run('zpixel_export',{document:'outline-only',draft:false,review})).status,'reviewed');
});

test('physicalOnly suppresses free-layer surfaces without hiding child parts',async t=>{
  const{run}=await setup(t);
  const scene={width:16,height:16,camera:{preset:'top_down',pixelsPerUnit:2},nodes:[
    {id:'deck',kind:'layer',width:16,height:16,pixelSize:1,plane:'xz',transform:{position:[-8,3,8]},pixels:Array(256).fill('ink')},
    {id:'mast',kind:'part',parent:'deck',transform:{position:[8,-3,-8]},geometry:{type:'box',center:[0,1,0],size:[2,2,2]}}
  ]};
  await run('zpixel_scene',{action:'create',document:'layer-parent',txid:'layer-parent-create',scene});
  assert.equal((await run('zpixel_inspect',{document:'layer-parent',kind:'pixel',x:8,y:8})).pixels[0].hit.nodeId,'deck');
  assert.equal((await run('zpixel_inspect',{document:'layer-parent',kind:'pixel',x:8,y:8,physicalOnly:true})).pixels[0].hit.nodeId,'mast');
  const observation=await run('zpixel_render',{document:'layer-parent',scale:1,camera:oblique,physicalOnly:true});
  assert.ok(observation.view.partPixels>0);
});
