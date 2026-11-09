import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createZPixelServiceForTest as createZPixelService} from './helpers.mjs';
import {loadDocument} from '../src/store.mjs';
import {renderNormalmap} from '../src/normalmap.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
async function setup(t){
  await fs.mkdir(path.join(root,'.validation'),{recursive:true});
  const cwd=await fs.mkdtemp(path.join(root,'.validation','appearance-service-'));
  t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const ctx={workingDirectory:{async ensure(){return cwd;}},sandboxPolicy:{resolve(){return{mode:'workspace-write',workspaceRoot:cwd};}},llm:{async resolveModelInfo(){return{inputModalities:['text','image']};}},attachments:{imageLimits:{maxImageDimension:4096},async saveImages(images){return images.map((image,index)=>({path:'stub-'+index+'.png',name:image.name,mediaType:image.mediaType}));}}};
  const exec={agent:{id:'appearance-service',session:{requestHeader(){return{config:{provider:'test',model:'test'}};}}},signal:new AbortController().signal};
  const service=createZPixelService(ctx);t.after(()=>service.dispose());
  const run=(name,args)=>service.run(name,args,exec);
  return{cwd,run};
}
const scene={width:16,height:16,camera:{preset:'top_down',pixelsPerUnit:3},nodes:[
  {id:'surface',kind:'part',geometry:{type:'ellipsoid',center:[0,0,0],radii:[1.6,1.2,1.6]}},
  {id:'label',kind:'layer',parent:'surface',appearanceOf:'surface',appearanceShading:'unlit',width:8,height:8,pixelSize:.5,basis:{u:[1,0,0],v:[0,0,1]},transform:{position:[-2,0,-2]},pixels:Array(64).fill('white')}
]};
const review={identity:true,nativeReadable:true,lighting:true,note:'Technical fixture for revision and contribution plumbing.'};

test('bound appearance survives store, inspected hits, reviewed export and normalmap export',async t=>{
  const{cwd,run}=await setup(t);
  await run('zpixel_scene',{action:'create',document:'surface-asset',txid:'appearance-create',scene});
  await assert.rejects(run('zpixel_export',{document:'surface-asset',draft:false,review}),e=>e.code==='PREVIEW_REQUIRED');
  const normals=await run('zpixel_normalmap',{document:'surface-asset',scale:1});
  assert.equal(normals.normalMap.fallbackCounts.paintedLayerPixels,0);
  await assert.rejects(run('zpixel_export',{document:'surface-asset',draft:false,review}),e=>e.code==='PREVIEW_REQUIRED');
  const preview=await run('zpixel_render',{document:'surface-asset',scale:1});
  assert.ok(preview.contribution.appearancePixels>0);
  assert.equal(preview.contribution.pixelsByKind.layer,0);
  assert.equal(preview.contribution.appearances[0].appearanceOf,'surface');
  const pixel=await run('zpixel_inspect',{document:'surface-asset',kind:'pixel',x:8,y:8});
  assert.equal(pixel.pixels[0].hit.nodeId,'surface');
  assert.equal(pixel.pixels[0].hit.appearanceNodeId,'label');
  const projection=await run('zpixel_inspect',{document:'surface-asset',kind:'spatial',node:'label',include_projection:true});
  assert.equal(projection.nodes[0].projectionInfo.source,'appearance');
  assert.equal(projection.nodes[0].projectionInfo.appearanceOf,'surface');
  assert.equal(projection.nodes[0].projectionInfo.visiblePixels,preview.contribution.appearancePixels);
  const previous=path.join(cwd,'.zpixel','exports','surface-asset-r0-v0.3.5');
  await fs.mkdir(previous,{recursive:true});
  await fs.writeFile(path.join(previous,'reviewed.json'),'old-generation');
  await run('zpixel_render',{document:'surface-asset',camera:{preset:'three_quarter'},physicalOnly:true,scale:1});
  const exported=await run('zpixel_export',{document:'surface-asset',draft:false,review});
  assert.match(exported.png,/v0[.]5[.]3-dev/);
  assert.deepEqual(exported.contribution,preview.contribution);
  const manifest=JSON.parse(await fs.readFile(exported.manifest,'utf8'));
  assert.equal(manifest.version,'0.5.3-dev');assert.equal(manifest.renderer.version,'0.3.6');
  assert.deepEqual(manifest.contribution,preview.contribution);
  assert.equal(await fs.readFile(path.join(previous,'reviewed.json'),'utf8'),'old-generation');
  const normalExport=await run('zpixel_normalmap',{document:'surface-asset',export:true,scale:1});
  const normalManifest=JSON.parse(await fs.readFile(normalExport.manifest,'utf8'));
  assert.deepEqual(normalManifest.contribution,preview.contribution);
  assert.equal(normalManifest.normalMap.fallbackCounts.paintedLayerPixels,0);
  const stored=await loadDocument(cwd,'surface-asset');
  const original={...stored,nodes:stored.nodes.filter(n=>n.id!=='label')};
  const a=renderNormalmap(stored),b=renderNormalmap(original);
  assert.deepEqual(a.rgba,b.rgba,'appearance changes color, not the exported curved normal map');
  assert.deepEqual(JSON.parse(await fs.readFile(exported.project,'utf8')),stored);
});

test('bound pixel edits retain transaction replay, rollback, undo/redo and fresh-review requirements',async t=>{
  const{cwd,run}=await setup(t);
  await run('zpixel_scene',{action:'create',document:'editable',txid:'editable-create',scene});
  await run('zpixel_render',{document:'editable',scale:1});
  const edit={action:'edit',document:'editable',revision:0,txid:'label-paint',ops:[{op:'paint',id:'label',ops:[{op:'rect',x:1,y:1,w:1,h:1,color:'ink'}]}]};
  const changed=await run('zpixel_scene',edit);assert.equal(changed.revision,1);
  const replay=await run('zpixel_scene',edit);assert.equal(replay.replayed,true);assert.equal(replay.revision,1);
  const file=path.join(cwd,'.zpixel','documents','editable.json'),bytes=await fs.readFile(file);
  await assert.rejects(run('zpixel_scene',{action:'edit',document:'editable',revision:1,txid:'bad-binding',ops:[{op:'node_set',id:'label',values:{appearanceOf:'missing'}}]}));
  assert.deepEqual(await fs.readFile(file),bytes,'invalid binding must not commit any partial edit');
  await assert.rejects(run('zpixel_export',{document:'editable',revision:1,draft:false,review}),e=>e.code==='PREVIEW_REQUIRED');
  await run('zpixel_scene',{action:'undo',document:'editable',revision:1,txid:'label-undo'});
  let stored=await loadDocument(cwd,'editable');assert.equal(stored.nodes.find(n=>n.id==='label').pixels[9],'white');
  await run('zpixel_scene',{action:'redo',document:'editable',revision:2,txid:'label-redo'});
  stored=await loadDocument(cwd,'editable');assert.equal(stored.nodes.find(n=>n.id==='label').pixels[9],'ink');
  await run('zpixel_scene',{action:'edit',document:'editable',revision:3,txid:'label-unbind',ops:[{op:'node_set',id:'label',values:{appearanceOf:null}}]});
  stored=await loadDocument(cwd,'editable');const layer=stored.nodes.find(n=>n.id==='label');
  assert.equal(Object.hasOwn(layer,'appearanceOf'),false);assert.equal(Object.hasOwn(layer,'appearanceShading'),false);
  assert.equal(layer.pixels[9],'ink');assert.equal(layer.parent,'surface');
});
