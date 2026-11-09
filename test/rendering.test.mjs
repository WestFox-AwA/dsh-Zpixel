import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createScene,applyOperations} from '../src/scene.mjs';
import {renderScene,traceScene} from '../src/renderer.mjs';
import {migrateLegacyScene,OLD_TO_NEW,convertLegacyVector} from '../src/migration.mjs';
import {dot,cross,point,worldTransforms} from '../src/math.mjs';

const box=(id,min,max,extra={})=>({id,kind:'part',geometry:{type:'box',min,max},...extra});

test('proper coordinate migration preserves both legacy camera rasters, geometry and layered paint',async()=>{
  assert.equal(dot(convertLegacyVector([1,0,0]),cross(convertLegacyVector([0,1,0]),convertLegacyVector([0,0,1]))),1);
  for(const preset of ['top_down','three_quarter']){
    const raw=await fs.readFile(new URL(`./fixtures/${preset}-legacy.json`,import.meta.url),'utf8'),source=JSON.parse(raw),saved=JSON.stringify(source),expected=await fs.readFile(new URL(`./fixtures/${preset}-legacy.rgba`,import.meta.url));
    const {scene,migration}=migrateLegacyScene(source),actual=renderScene(scene);
    assert.deepEqual(Buffer.from(actual.rgba),expected);assert.equal(JSON.stringify(source),saved);
    assert.equal(migration.cameraMirrorExplicit,preset==='top_down');
    const oldMatrix=source.nodes.find(n=>n.id==='assembly').transform,newMatrix=worldTransforms(scene).get('assembly');
    assert.ok(newMatrix.every(Number.isFinite));assert.ok(oldMatrix.rotation);assert.equal(scene.coordinates,'right-handed-y-up');
    const moved=applyOperations(scene,[{op:'node_set',id:'assembly',values:{name:'Migrated editable assembly'}}]);assert.equal(moved.nodes[1].name,'Migrated editable assembly');assert.equal(moved.nodes[1].semanticFrame,undefined);
  }
});

test('Y-up cylinder axes/endpoints and both cameras preserve X right and -Z upward',()=>{
  for(const preset of ['top_down','three_quarter']){
    const scene=createScene({id:'axes',width:32,height:32,camera:{preset,target:[0,0,0],pixelsPerUnit:2},nodes:[box('front',[-.5,0,-4],[.5,1,-3],{outline:{enabled:false}}),box('right',[3,0,-.5],[4,1,.5],{outline:{enabled:false}})]});
    const image=renderScene(scene),mean=id=>{const ids=image.hits.flatMap((h,i)=>h?.nodeId===id?[i]:[]);return [ids.reduce((s,i)=>s+i%32,0)/ids.length,ids.reduce((s,i)=>s+Math.floor(i/32),0)/ids.length];};
    assert.ok(mean('front')[1]<16);assert.ok(mean('right')[0]>16);
  }
  const s=createScene({id:'wheel',nodes:[{id:'wheel',kind:'part',geometry:{type:'cylinder',radius:1,from:[-2,1,0],to:[2,1,0]}}]});
  assert.deepEqual(s.nodes[1].geometry.axis,[1,0,0]);assert.equal(s.nodes[1].geometry.length,4);
  const hit=traceScene(s,[-5,1,0],[1,0,0]);assert.deepEqual(hit.position,[-2,1,0]);assert.ok(Math.hypot(hit.normal[0]+1,hit.normal[1],hit.normal[2])<1e-10);
});

test('inside and outside strokes remain exact image operations and respect foreground depth',()=>{
  const s=createScene({id:'outline',width:16,height:16,camera:{preset:'top_down'},nodes:[box('body',[-2,0,-2],[2,1,2],{outline:{direction:'inside'}})]});
  const inside=renderScene(s),outside=renderScene(applyOperations(s,[{op:'node_set',id:'body',values:{outline:{direction:'outside',enabled:true}}}]));
  assert.equal(inside.hits.filter(Boolean).length,16);assert.equal(inside.hits.filter(h=>h?.outlineReason).length,12);assert.equal(outside.hits.filter(Boolean).length,36);assert.equal(outside.stats.outsidePixels,20);
  assert.deepEqual(renderScene(s,{mode:'silhouette'}).rgba,renderScene(applyOperations(s,[{op:'node_set',id:'body',values:{outline:{direction:'outside'}}}]),{mode:'silhouette'}).rgba);
  const covered=applyOperations(s,[{op:'node_set',id:'body',values:{outline:{direction:'outside'}}},{op:'node_add',node:box('cover',[-3,2,-3],[3,3,3],{outline:{enabled:false}})}]);assert.ok(!renderScene(covered).hits.some(h=>h?.outlineReason));
});

test('shared Y-up extrusion sides, hard-shadow air gap and stable conic intersections',()=>{
  const s=createScene({id:'prism',nodes:[box('solid',[-1,0,-1],[1,2,1],{outline:{enabled:false}})]});
  const e=applyOperations(s,[{op:'node_set',id:'solid',values:{geometry:{type:'extrude',points:[[-1,-1],[1,-1],[1,1],[-1,1]],range:[0,2]}}}]);
  for(const [o,d]of[[[-3,1,0],[1,0,0]],[[3,1,0],[-1,0,0]],[[0,1,-3],[0,0,1]],[[0,1,3],[0,0,-1]]])assert.deepEqual(traceScene(e,o,d),traceScene(s,o,d));
  const gap=createScene({id:'gap',nodes:[box('low',[-.5,0,-.5],[.5,2,.5]),box('bridge',[-.5,6,-3],[.5,7,3])]});assert.equal(traceScene(gap,[-4,5,0],[8,-5,0],{shadowOnly:true}),null);
  for(const type of ['ellipsoid','cylinder']){
    const scene=createScene({id:'conic',nodes:[{id:'shape',kind:'part',geometry:type==='ellipsoid'?{type,center:[0,0,0],radii:[.25,.25,.25]}:{type,center:[0,0,0],axis:'y',radius:.25,length:2}}]});
    const direction=type==='ellipsoid'?[0,0,-1]:[0,0,1],origin=(x,n)=>[x,0,type==='ellipsoid'?n:-n];
    assert.equal(traceScene(scene,origin(.251,1e7),direction),null);
    const near=traceScene(scene,origin(.24,100),direction),far=traceScene(scene,origin(.24,1e7),direction);assert.ok(Math.hypot(...near.position.map((v,i)=>v-far.position[i]))<1e-7);
  }
});

test('region and workload rejection wording stays version-neutral',()=>{
  const scene=createScene({id:'limits',width:16,height:16,nodes:[box('body',[-1,0,-1],[1,1,1])]});
  assert.throws(()=>renderScene(scene,{region:{x:0,y:0,w:8,h:8}}),error=>{
    assert.match(error.message,/region is unsupported/);assert.ok(!/v0\.1/i.test(error.message));return true;
  });
  const boxes=Array.from({length:64},(_,index)=>box(`b${index}`,[index*2,0,-1],[index*2+1,1,1]));
  const lights=Array.from({length:8},(_,index)=>({id:`light-${index}`,type:'directional',direction:[0,-1,0]}));
  const heavy=createScene({id:'workload',width:256,height:256,camera:{preset:'top_down'},lights,nodes:boxes});
  assert.throws(()=>renderScene(heavy),error=>{
    assert.match(error.message,/exceeds the synchronous render limit 32000000/);assert.ok(!/v0\.1/i.test(error.message));return true;
  });
});
