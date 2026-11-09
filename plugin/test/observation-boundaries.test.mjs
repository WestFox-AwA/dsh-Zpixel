import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createZPixelServiceForTest as createZPixelService} from './helpers.mjs';
import {loadDocument} from '../src/store.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const input=()=>({width:16,height:16,camera:{preset:'top_down',pixelsPerUnit:2},nodes:[{id:'block',kind:'part',geometry:{type:'box',center:[0,0,0],size:[4,2,4]}}]});
const review={identity:true,nativeReadable:true,lighting:true,note:'Technical fixture: source camera and observed geometry remain distinct.'};
async function setup(t){
  await fs.mkdir(path.join(root,'.validation'),{recursive:true});
  const a=await fs.mkdtemp(path.join(root,'.validation','obs-boundary-a-'));
  const b=await fs.mkdtemp(path.join(root,'.validation','obs-boundary-b-'));
  t.after(()=>Promise.all([a,b].map(p=>fs.rm(p,{recursive:true,force:true}))));
  const state={cwd:a,failImages:false};
  const ctx={workingDirectory:{async ensure(){return state.cwd;}},sandboxPolicy:{resolve(){return{mode:'workspace-write',workspaceRoot:state.cwd};}},llm:{async resolveModelInfo(){return{inputModalities:['text','image']};}},attachments:{imageLimits:{maxImageDimension:4096},async saveImages(images){if(state.failImages)throw new Error('simulated image delivery failure');return images.map((image,i)=>({path:'stub-'+i+'.png',mediaType:image.mediaType,name:image.name}));}}};
  const service=createZPixelService(ctx);t.after(()=>service.dispose());
  const exec={agent:{id:'same-agent',session:{requestHeader(){return{config:{provider:'test',model:'test'}};}}},signal:new AbortController().signal};
  return{a,b,state,run:(name,args)=>service.run(name,args,exec)};
}
const create=run=>run('zpixel_scene',{action:'create',document:'same',txid:'create-same',scene:input()});
const observe=run=>run('zpixel_render',{document:'same',camera:{preset:'three_quarter'},physicalOnly:true,scale:1});
const deliver=run=>run('zpixel_render',{document:'same',scale:1});
const exportReviewed=run=>run('zpixel_export',{document:'same',draft:false,review});

test('observation evidence cannot cross workspace even for identical scene and agent ids',async t=>{
  const{b,state,run}=await setup(t);
  await create(run);await observe(run);await deliver(run);await exportReviewed(run);
  state.cwd=b;
  await create(run);await deliver(run);
  await assert.rejects(exportReviewed(run),e=>e.code==='OBSERVATION_REQUIRED');
  await observe(run);assert.equal((await exportReviewed(run)).status,'reviewed');
});

test('explicit same-camera observation and text probes cannot unlock delivery or geometry review',async t=>{
  const{a,run}=await setup(t);await create(run);
  const scene=await loadDocument(a,'same');
  const view=await run('zpixel_render',{document:'same',camera:scene.camera,fit:false,scale:1});
  assert.equal(view.delivery,false);
  await assert.rejects(exportReviewed(run),e=>e.code==='PREVIEW_REQUIRED');
  await deliver(run);
  const pixel=await run('zpixel_inspect',{document:'same',kind:'pixel',x:8,y:8,camera:{preset:'three_quarter'},physicalOnly:true});
  assert.equal(pixel.delivery,false);
  await assert.rejects(exportReviewed(run),e=>e.code==='OBSERVATION_REQUIRED');
  await assert.rejects(run('zpixel_inspect',{document:'same',kind:'pixel',x:8,y:8,expectedRevision:99}),e=>e.code==='REVISION_CONFLICT');
  await assert.rejects(run('zpixel_inspect',{document:'same',kind:'spatial',node:'block',expectedHash:'0'.repeat(64)}),e=>e.code==='HASH_CONFLICT');
  await assert.rejects(run('zpixel_render',{document:'same',fit:true}),e=>e.code==='OBSERVATION_FIT');
});

test('failed default working image keeps committed document but cannot become delivery evidence',async t=>{
  const{a,state,run}=await setup(t);state.failImages=true;
  const result=await run('zpixel_scene',{action:'create',document:'same',txid:'create-same',scene:input(),preview:true});
  assert.ok(result.previewError);assert.equal(result.preview,undefined);
  assert.equal((await loadDocument(a,'same')).contract,'model-first/1');
  state.failImages=false;
  await assert.rejects(exportReviewed(run),e=>e.code==='PREVIEW_REQUIRED');
  await deliver(run);
  await assert.rejects(exportReviewed(run),e=>e.code==='OBSERVATION_REQUIRED');
});
