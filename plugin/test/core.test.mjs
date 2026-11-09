import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createScene,applyOperations,validateScene} from '../src/scene.mjs';
import {renderScene} from '../src/renderer.mjs';
import {createDocument,editDocument,loadDocument,listDocuments} from '../src/store.mjs';
import {createZPixelServiceForTest as createZPixelService} from './helpers.mjs';
import {worldTransforms,point} from '../src/math.mjs';
import {findNodes,spatialReport,spatialSummary} from '../src/spatial.mjs';
import {topDownAssetScene} from '../src/examples.mjs';
import {apply} from '../src/index.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
async function workspace(){await fs.mkdir(path.join(root,'.validation'),{recursive:true});return fs.mkdtemp(path.join(root,'.validation','v03-core-'));}
const box=(id,min,max,extra={})=>({id,kind:'part',geometry:{type:'box',min,max},...extra});

test('Y-up transforms, ground layers and atomic transactions remain stable',()=>{
  const s=createScene({id:'scene-tree',camera:{preset:'top_down'},nodes:[{id:'module',kind:'group',name:'Built assembly'},box('body',[-2,0,-2],[2,1,2],{parent:'module',role:'wall',tags:['stone']}),{id:'paint',kind:'layer',parent:'module',width:2,height:2,plane:'xz',pixels:['ink','white','white','ink'],transform:{position:[0,1.01,0]}}]});
  assert.equal(s.coordinates,'right-handed-y-up');assert.ok(!('plane'in s.nodes[3]));
  const moved=applyOperations(s,[{op:'transform',id:'module',translate:[3,0,0]}]);assert.deepEqual(point(worldTransforms(moved).get('paint'),[0,0,0]),[3,1.01,0]);
  const reparent=applyOperations(moved,[{op:'node_reparent',id:'paint',parent:'root',keepWorld:true}]);assert.deepEqual(worldTransforms(reparent).get('paint'),worldTransforms(moved).get('paint'));
  assert.equal(findNodes(s,{role:'wall',tag:'stone'})[0].id,'body');
  const original=JSON.stringify(s);assert.throws(()=>applyOperations(s,[{op:'transform',id:'module',translate:[9,0,0]},{op:'node_reparent',id:'module',parent:'body'}]));assert.equal(JSON.stringify(s),original);
  assert.throws(()=>createScene({coordinates:'z-up'}));assert.throws(()=>createScene({nodes:[{id:'bad',kind:'part',geometry:{type:'cylinder',height:2,radius:1}}]}));validateScene(s);
});

test('generic wall gate tree rock arrow and ground layer share anchors, relation graph and evidence',()=>{
  const s=topDownAssetScene('generic-assembly'),render=renderScene(s),stats=spatialSummary(s);
  assert.equal(s.coordinates,'right-handed-y-up');assert.ok(render.stats.visiblePixels>100);assert.ok(stats.edges.some(e=>e.id==='gate-hinge'));
  assert.equal(spatialReport(s,{node:'gate'}).nodes[0].world.semanticFrame,null);
  const gate=spatialReport(s,{node:'gate'}).nodes[0].intent;assert.equal(gate.find(e=>e.intent.id==='gate-hinge').verdict,'met');
  const tree=spatialReport(s,{node:'trunk'}).nodes[0].intent;assert.equal(tree.find(e=>e.intent.id==='tree-ground-support').verdict,'met');
  const arrow=spatialReport(s,{node:'arrow'}).nodes[0];assert.equal(arrow.world.semanticFrame.quality,'rigid');assert.deepEqual(findNodes(s,{role:'rock-prop'}),[]);
  const report=spatialReport(s,{node:'canopy'}).nodes[0];assert.ok(report.intent.some(e=>e.intent.relation==='allow_overlap'));
  assert.ok(report.worldObservations.items.some(e=>e.node==='trunk'&&e.status==='intersecting'));
  assert.ok(report.worldObservations.items.every(e=>e.method));
});

test('anchor placement rejects underconstraint and resolves hinge frame transactionally',()=>{
  const s=topDownAssetScene('anchor-assembly');
  const bad=structuredClone(s);bad.nodes.find(n=>n.id==='gate').anchors.hinge={point:[-3,1.5,0],normal:[-1,0,0]};
  assert.throws(()=>applyOperations(bad,[{op:'node_attach',id:'gate',target:'wall-left',mode:'normal',sourceAnchor:'hinge',targetAnchor:'hinge'}]),/underconstrained/i);
  const placementScene=structuredClone(s);placementScene.spatialRelations=placementScene.spatialRelations.filter(e=>e.id!=='gate-wall-contact');
  const placed=applyOperations(placementScene,[{op:'node_attach',id:'gate',target:'wall-left',mode:'frame',sourceAnchor:'hinge',targetAnchor:'hinge',record:true,relationId:'gate-placed'}]);
  assert.ok(placed.spatialRelations.some(e=>e.id==='gate-placed'));assert.equal(s.spatialRelations.some(e=>e.id==='gate-placed'),false);
  const restored=applyOperations(placed,[{op:'spatial_relation_delete',id:'gate-placed'}]);assert.ok(!restored.spatialRelations.some(e=>e.id==='gate-placed'));
});

test('relation edges validate conflicts and follow node delete/duplicate semantics',()=>{
  const scene=createScene({id:'edge-test',nodes:[box('a',[0,0,0],[1,1,1]),box('b',[2,0,0],[3,1,1])],spatialRelations:[{id:'avoid-a-b',from:{node:'a'},relation:'avoid_intersection',to:{node:'b'}}]});
  assert.throws(()=>createScene({id:'contradiction',nodes:[box('a',[0,0,0],[1,1,1]),box('b',[2,0,0],[3,1,1])],spatialRelations:[{id:'x',from:{node:'a'},relation:'avoid_intersection',to:{node:'b'}},{id:'y',from:{node:'b'},relation:'allow_overlap',to:{node:'a'}}]}),/conflicts/i);
  const copied=applyOperations(scene,[{op:'node_duplicate',id:'a',newId:'a-copy'}]);assert.equal(copied.spatialRelations.length,1);
  const deleted=applyOperations(scene,[{op:'node_delete',id:'a'}]);assert.equal(deleted.spatialRelations.length,0);
  assert.equal(spatialReport(scene,{node:'a',other:'b'}).nodes[0].intent[0].intent.id,'avoid-a-b');
});

test('revision transactions, undo, replay and legacy listing preserve existing documents',async()=>{
  const cwd=await workspace(),s=createScene({id:'transaction'});await createDocument(cwd,s,'create-one',{create:1});
  const req={ops:[{op:'node_add',node:box('shape',[-1,0,-1],[1,2,1])}]};const a=await editDocument(cwd,s.id,0,'edit-one',req,current=>applyOperations(current,req.ops));assert.equal(a.scene.revision,1);
  assert.equal((await editDocument(cwd,s.id,0,'edit-one',req,()=>{throw Error('must not run');})).replayed,true);await assert.rejects(editDocument(cwd,s.id,0,'stale',{},x=>x),/changed/i);
  const undone=await editDocument(cwd,s.id,1,'undo-one',{undo:true},null,'undo');assert.equal(undone.scene.nodes.length,1);
  const legacy=JSON.parse(await fs.readFile(new URL('./fixtures/top_down-legacy.json',import.meta.url),'utf8'));await fs.writeFile(path.join(cwd,'.zpixel/documents/legacy.json'),JSON.stringify({format:'dsh-zpixel-store/1',scene:{...legacy,id:'legacy'},history:[],future:[],receipts:[]}));
  const listing=await listDocuments(cwd);assert.equal(listing.documents.find(d=>d.id==='legacy').migrationRequired,true);await assert.rejects(loadDocument(cwd,'legacy'),/migrat/i);
});

test('native service exposes generic world observations, export and source-preserving migration',async()=>{
  const cwd=await workspace(),ctx={workingDirectory:{async ensure(){return cwd;}},sandboxPolicy:{resolve(){return{mode:'workspace-write',workspaceRoot:cwd};}},llm:{async resolveModelInfo(){return{inputModalities:['text']};}}};
  const exec={agent:{id:'core-native',session:{requestHeader(){return{config:{provider:'test',model:'test'}};}}},signal:new AbortController().signal},svc=createZPixelService(ctx);
  const created=await svc.run('zpixel_scene',{action:'create',document:'native',txid:'create-native',scene:topDownAssetScene('native')},exec);assert.equal(created.coordinates,'right-handed-y-up');
  const r=await svc.run('zpixel_inspect',{document:'native',kind:'spatial',node:'gate',include_projection:true},exec);assert.equal(r.nodes[0].intent.find(e=>e.intent.id==='gate-hinge').verdict,'met');assert.ok(r.nodes[0].projectionInfo.visiblePixels>0);
  const exported=await svc.run('zpixel_export',{document:'native',draft:true},exec);assert.ok(exported.png.includes('v0.5.3-dev'));assert.deepEqual([...(await fs.readFile(exported.png)).subarray(0,8)],[137,80,78,71,13,10,26,10]);
  const legacy=JSON.parse(await fs.readFile(new URL('./fixtures/top_down-legacy.json',import.meta.url),'utf8')),original=JSON.stringify(legacy);const converted=await svc.run('zpixel_scene',{action:'migrate',document:'migrated',txid:'migrate-one',scene:legacy},exec);assert.equal(converted.format,'dsh-zpixel/2');assert.equal(JSON.stringify(legacy),original);await assert.rejects(svc.run('zpixel_scene',{action:'create',document:'no-implicit',txid:'bad-create',scene:legacy},exec),/migrat/i);svc.dispose();
});

test('seven host registrations dispose and read-only policy blocks mutations',async()=>{
  const cwd=await workspace(),registered=new Map(),disposers=[],ctx={workingDirectory:{async ensure(){return cwd;}},sandboxPolicy:{resolve(){return{mode:'read-only',workspaceRoot:cwd};}},tools:{register(d){registered.set(d.name,d);return()=>registered.delete(d.name);},get(name){return registered.get(name);}},systemPrompt:{section(){return()=>{};}},effect(fn){const dispose=fn();disposers.push(dispose);},attachments:{imageLimits:{maxImageDimension:4096},async saveImages(images){return images.map(image=>({path:'stub.png',mediaType:image.mediaType,name:image.name}));}},llm:{async resolveModelInfo(){return{inputModalities:['text']};}}};
  apply(ctx);assert.equal(registered.size,7);const exec={agent:{id:'readonly',session:{id:'readonly-session',requestHeader(){return{config:{provider:'test',model:'test'}};}}},callId:'readonly-call',rootCallId:'readonly-root',signal:new AbortController().signal};await assert.rejects(registered.get('zpixel_scene').execute({action:'create',document:'denied',txid:'denied-create'},exec),/read-only/i);disposers.forEach(d=>d());assert.equal(registered.size,0);
});
