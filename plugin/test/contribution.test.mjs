import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createScene} from '../src/scene.mjs';
import {renderScene} from '../src/renderer.mjs';
import {contributionReport} from '../src/contribution.mjs';
import {createZPixelServiceForTest as createZPixelService} from './helpers.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const box=(id,min,max)=>({id,kind:'part',geometry:{type:'box',min,max}});
const paint=(id,{width=16,height=16,position=[-8,2,-8],color='ink'}={})=>({id,kind:'layer',width,height,pixelSize:1,basis:{u:[1,0,0],v:[0,0,1]},transform:{position},pixels:Array(width*height).fill(color)});
const camera={preset:'top_down',pixelsPerUnit:1};
const sceneWith=nodes=>createScene({id:'contribution',width:16,height:16,camera,nodes:[{id:'root',kind:'group'},...nodes]});

test('contribution names geometry-only delivery and keeps layer totals at zero',()=>{
  const scene=sceneWith([box('body',[-6,0,-2],[-2,1,2])]),image=renderScene(scene);
  const report=contributionReport(scene,image);
  assert.equal(report.revision,0);assert.equal(report.mode,'beauty');
  assert.equal(report.representation,'geometry');
  assert.equal(report.pixelsByKind.layer,0);assert.ok(report.pixelsByKind.part>0);
  assert.equal(report.visiblePixels,report.pixelsByKind.part+report.pixelsByKind.layer);
  assert.deepEqual(report.layerPixels,{total:0,painted:0,visible:0});
  assert.deepEqual(report.zeroVisible,{parts:[],layers:[]});
  assert.deepEqual(report.nodes.map(node=>node.id),['body']);
});

test('contribution names appearance-only delivery and reports occluded parts',()=>{
  const scene=sceneWith([box('body',[-6,0,-2],[-2,1,2]),paint('paint')]),image=renderScene(scene);
  const report=contributionReport(scene,image);
  assert.equal(report.representation,'appearance');
  assert.equal(report.pixelsByKind.part,0);assert.equal(report.pixelsByKind.layer,256);
  assert.deepEqual(report.zeroVisible,{parts:['body'],layers:[]});
  assert.deepEqual(report.layerPixels,{total:256,painted:256,visible:256});
  assert.deepEqual(report.nodes,[{id:'paint',name:'paint',kind:'layer',visiblePixels:256,totalPixels:256,paintedPixels:256}]);
});

test('contribution names mixed delivery without inventing a threshold',()=>{
  const scene=sceneWith([box('body',[-6,0,-2],[-2,1,2]),paint('paint',{width:8,position:[0,2,-8]})]),image=renderScene(scene);
  const report=contributionReport(scene,image);
  assert.equal(report.representation,'mixed');
  assert.ok(report.pixelsByKind.part>0);assert.ok(report.pixelsByKind.layer>0);
  assert.deepEqual(report.zeroVisible,{parts:[],layers:[]});
});

test('contribution reports painted-but-occluded layers and empty delivery',()=>{
  const covered=sceneWith([box('cover',[-8,3,-8],[8,4,8]),paint('paint')]),image=renderScene(covered);
  const report=contributionReport(covered,image);
  assert.equal(report.representation,'geometry');
  assert.deepEqual(report.zeroVisible,{parts:[],layers:['paint']});
  assert.equal(report.layerPixels.painted,256);assert.equal(report.layerPixels.visible,0);
  const empty=contributionReport(sceneWith([]),renderScene(sceneWith([])));
  assert.equal(empty.representation,'empty');assert.equal(empty.visiblePixels,0);assert.equal(empty.transparentPixels,256);
});

test('contribution is a pure read of the current hit buffer',()=>{
  const scene=sceneWith([box('body',[-6,0,-2],[-2,1,2]),paint('paint')]),image=renderScene(scene);
  const beforeScene=JSON.stringify(scene),beforeHits=JSON.stringify(image.hits);
  const first=contributionReport(scene,image),second=contributionReport(scene,image);
  assert.deepEqual(first,second);
  assert.equal(JSON.stringify(scene),beforeScene);assert.equal(JSON.stringify(image.hits),beforeHits);
  assert.equal(image.contribution,undefined);
});

function serviceFor(cwd){
  const saved=[];
  const ctx={workingDirectory:{async ensure(){return cwd;}},sandboxPolicy:{resolve(){return{mode:'workspace-write',workspaceRoot:cwd};}},llm:{async resolveModelInfo(){return{inputModalities:['text']};}},attachments:{imageLimits:{maxImageDimension:4096},async saveImages(images){return images.map(image=>{saved.push(image);return{path:`stub-${saved.length}.png`,mediaType:image.mediaType,name:image.name};});}}};
  const exec={agent:{id:'contribution-tests',session:{requestHeader(){return{config:{provider:'test',model:'test'}};}}},signal:new AbortController().signal};
  return{service:createZPixelService(ctx),exec,saved};
}
const sceneValues={width:16,height:16,camera,nodes:[{id:'root',kind:'group'},box('body',[-6,0,-2],[-2,1,2]),paint('paint')]};

test('render preview and draft export carry the same additive contribution facts',async t=>{
  await fs.mkdir(path.join(root,'.validation'),{recursive:true});
  const cwd=await fs.mkdtemp(path.join(root,'.validation','v034-contribution-'));
  t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const{service,exec}=serviceFor(cwd);
  try{
    await service.run('zpixel_scene',{action:'create',document:'contrib',txid:'contrib-create',scene:sceneValues},exec);
    const preview=await service.run('zpixel_render',{document:'contrib'},exec);
    assert.equal(preview.contribution.representation,'appearance');
    assert.deepEqual(preview.contribution.zeroVisible,{parts:['body'],layers:[]});
    assert.equal(preview.contribution.layerPixels.painted,256);
    // Existing preview fields are preserved.
    assert.equal(typeof preview.stats.visiblePixels,'number');assert.ok(Array.isArray(preview.colorsUsed));
    assert.ok(Array.isArray(preview.warnings));assert.equal(preview.visualReview,'not-recorded');
    assert.ok(preview.attachment&&preview.nativeSize.width===16);

    const exported=await service.run('zpixel_export',{document:'contrib',draft:true},exec);
    assert.equal(exported.status,'draft');
    assert.deepEqual(exported.contribution,preview.contribution);
    assert.equal(typeof exported.png,'string');assert.equal(typeof exported.project,'string');
    const manifest=JSON.parse(await fs.readFile(exported.manifest,'utf8'));
    assert.deepEqual(manifest.contribution,preview.contribution);
    assert.equal(manifest.status,'draft');assert.equal(manifest.revision,0);
    assert.ok(Array.isArray(manifest.colorsUsed));
  } finally{service.dispose();}
});
