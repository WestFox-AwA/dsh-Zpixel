import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createScene,validateScene} from '../src/scene.mjs';
import {createDocument,loadDocument,listDocuments} from '../src/store.mjs';
import {createZPixelServiceForTest as createZPixelService} from './helpers.mjs';
import {topDownAssetScene} from '../src/examples.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const deepFreeze=value=>{if(value&&typeof value==='object'){for(const key of Object.keys(value))deepFreeze(value[key]);Object.freeze(value);}return value;};
async function workspace(){await fs.mkdir(path.join(root,'.validation'),{recursive:true});return fs.mkdtemp(path.join(root,'.validation','v03-boundaries-'));}
function serviceFor(cwd){
  const ctx={workingDirectory:{async ensure(){return cwd;}},sandboxPolicy:{resolve(){return{mode:'workspace-write',workspaceRoot:cwd};}},llm:{async resolveModelInfo(){return{inputModalities:['text']};}},attachments:{imageLimits:{maxImageDimension:4096},async saveImages(images){return images.map(image=>({path:'stub.png',mediaType:image.mediaType,name:image.name}));}}};
  const exec={agent:{id:'create-boundaries',session:{requestHeader(){return{config:{provider:'test',model:'test'}};}}},signal:new AbortController().signal};
  return {service:createZPixelService(ctx),exec};
}

test('validateScene validates a deep-frozen canonical scene with a relation without rewriting it',()=>{
  const scene=createScene({id:'frozen-boundaries',width:16,height:16,camera:{preset:'top_down'},nodes:[
    {id:'mount',kind:'part',geometry:{type:'box',center:[0,1,0],size:[2,2,2]},anchors:{base:{point:[0,0,-1],normal:'y',tangent:[1,0,0],axis:'z'}},semanticFrame:{forward:'-z',up:'y'}},
    {id:'rail',kind:'part',geometry:{type:'box',center:[0,1,-2],size:[2,2,2]},anchors:{socket:{point:[0,0,-1],normal:'y',tangent:[1,0,0],axis:'z'}}},
    {id:'plate',kind:'layer',parent:'mount',width:2,height:2,plane:'xz',pixels:['white',null,null,'white']}
  ],spatialRelations:[{id:'mount-rail-coaxial',from:{node:'mount',anchor:'base'},relation:'coaxial',to:{node:'rail',anchor:'socket'},angleTolerance:1e-6,distanceTolerance:1e-6}]});
  const before=JSON.stringify(scene);
  assert.equal(validateScene(deepFreeze(scene)),scene);
  assert.equal(JSON.stringify(scene),before);
});

test('create accepts a frozen format-marked partial scene, stores canonical values, then open and render accept it',async t=>{
  const cwd=await workspace();t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const {service,exec}=serviceFor(cwd);
  const initial={
    format:'dsh-zpixel/2',coordinates:'right-handed-y-up',width:16,height:16,camera:{preset:'top_down'},
    nodes:[
      {id:'block',kind:'part',geometry:{type:'box',center:[0,1,0],size:[2,2,2]}},
      {id:'rod',kind:'part',geometry:{type:'cylinder',from:[0,0,0],to:[0,2,0],radius:.5}},
      {id:'paint',kind:'layer',width:2,height:2,plane:'xz',pixels:['ink',null,null,'ink']}
    ]
  };
  const initialBytes=JSON.stringify(initial);deepFreeze(initial);
  try{
    const created=await service.run('zpixel_scene',{action:'create',document:'partial-boundary',txid:'boundary-create',scene:initial},exec);
    assert.equal(JSON.stringify(initial),initialBytes);
    assert.equal(created.format,'dsh-zpixel/2');assert.equal(created.revision,0);
    const opened=await service.run('zpixel_scene',{action:'open',document:'partial-boundary'},exec);
    assert.deepEqual(opened.camera,{position:[0,100,0],target:[0,0,0],up:[0,0,-1],mirrorX:false,pixelsPerUnit:1,center:[8,8]});
    const loaded=JSON.parse(await fs.readFile(path.join(cwd,'.zpixel','documents','partial-boundary.json'),'utf8')).scene;
    const box=loaded.nodes.find(node=>node.id==='block'),cylinder=loaded.nodes.find(node=>node.id==='rod'),layer=loaded.nodes.find(node=>node.id==='paint');
    assert.deepEqual(box.geometry,{type:'box',min:[-1,0,-1],max:[1,2,1]});
    assert.deepEqual(cylinder.geometry,{type:'cylinder',center:[0,1,0],radius:.5,length:2,axis:[0,1,0]});
    assert.deepEqual(layer.basis,{u:[1,0,0],v:[0,0,-1]});assert.equal(Object.hasOwn(layer,'plane'),false);
    const rendered=await service.run('zpixel_render',{document:'partial-boundary',scale:1},exec);
    assert.ok(rendered.stats.visiblePixels>0);
  } finally {service.dispose();}
});

test('create rejects legacy and unknown formats and revision without a format2 marker',async t=>{
  const cwd=await workspace();t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const {service,exec}=serviceFor(cwd);
  const legacy=JSON.parse(await fs.readFile(new URL('./fixtures/top_down-legacy.json',import.meta.url),'utf8'));
  try{
    await assert.rejects(service.run('zpixel_scene',{action:'create',document:'legacy-create',txid:'boundary-legacy',scene:legacy},exec),error=>{
      assert.equal(error.code,'MIGRATION_REQUIRED');assert.match(error.message,/migrat/i);return true;
    });
    await assert.rejects(service.run('zpixel_scene',{action:'create',document:'future-create',txid:'boundary-future',scene:{format:'dsh-zpixel/9'}},exec),error=>{
      assert.equal(error.code,'INVALID_FORMAT');assert.match(error.message,/dsh-zpixel\/2/);assert.match(error.message,/migrat/i);return true;
    });
    for(const revision of [-1,1.5,'7',Number.MAX_SAFE_INTEGER+1]){
      await assert.rejects(service.run('zpixel_scene',{action:'create',document:'invalid-revision',txid:'boundary-invalid-revision',scene:{format:'dsh-zpixel/2',revision}},exec),error=>{
        assert.equal(error.code,'RANGE');assert.match(error.message,/scene\.revision/);return true;
      });
    }
    await assert.rejects(service.run('zpixel_scene',{action:'create',document:'revision-create',txid:'boundary-revision',scene:{revision:0}},exec),error=>{
      assert.equal(error.code,'UNKNOWN_FIELD');assert.match(error.message,/revision/);return true;
    });
    await assert.rejects(fs.access(path.join(cwd,'.zpixel','documents','legacy-create.json')));
  } finally {service.dispose();}
});

test('create accepts a frozen complete format2 snapshot, validates revision and stores fresh revision 0 with content preserved',async t=>{
  const cwd=await workspace();t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const {service,exec}=serviceFor(cwd);
  const snapshot=topDownAssetScene('snapshot-boundary');
  snapshot.revision=7;
  const bytes=JSON.stringify(snapshot);deepFreeze(snapshot);
  try{
    const created=await service.run('zpixel_scene',{action:'create',document:'snapshot-boundary',txid:'boundary-snapshot',scene:snapshot},exec);
    assert.equal(JSON.stringify(snapshot),bytes);
    assert.equal(created.revision,0);
    const stored=await loadDocument(cwd,'snapshot-boundary');
    assert.equal(stored.revision,0);
    assert.deepEqual(stored,{...snapshot,revision:0});
    assert.deepEqual(stored.camera,snapshot.camera);
    assert.deepEqual(stored.materials,snapshot.materials);
    assert.deepEqual(stored.nodes.find(node=>node.id==='gate').anchors,snapshot.nodes.find(node=>node.id==='gate').anchors);
    assert.deepEqual(stored.nodes.find(node=>node.id==='wall-left').geometry,snapshot.nodes.find(node=>node.id==='wall-left').geometry);
  } finally {service.dispose();}
});

test('create requires a supplied nested scene.id to match the outer document',async t=>{
  const cwd=await workspace();t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const {service,exec}=serviceFor(cwd);
  try{
    await assert.rejects(service.run('zpixel_scene',{action:'create',document:'outer-id',txid:'boundary-id',scene:{id:'inner-id'}},exec),error=>{
      assert.equal(error.code,'DOCUMENT_ID');assert.match(error.message,/scene\.id/);return true;
    });
    const created=await service.run('zpixel_scene',{action:'create',document:'matching-id',txid:'boundary-id-match',scene:{id:'matching-id',camera:{preset:'top_down'}}},exec);
    assert.equal(created.id,'matching-id');
  } finally {service.dispose();}
});

test('create on an existing legacy ID reports ALREADY_EXISTS and leaves bytes untouched; current tx replay still works',async t=>{
  const cwd=await workspace();t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const legacy=JSON.parse(await fs.readFile(new URL('./fixtures/top_down-legacy.json',import.meta.url),'utf8'));
  const file=path.join(cwd,'.zpixel','documents','legacy-taken.json');
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,JSON.stringify({format:'dsh-zpixel-store/1',scene:{...legacy,id:'legacy-taken'},history:[],future:[],receipts:[]}));
  const before=await fs.readFile(file);
  await assert.rejects(createDocument(cwd,createScene({id:'legacy-taken'}),'boundary-legacy-taken',{create:'boundary'}),error=>{
    assert.equal(error.code,'ALREADY_EXISTS');assert.match(error.message,/legacy|new ID|migrat/i);return true;
  });
  assert.deepEqual(await fs.readFile(file),before);
  const replayRequest={create:'boundary-replay'};
  const first=await createDocument(cwd,createScene({id:'replay-doc'}),'boundary-replay',replayRequest);
  const replay=await createDocument(cwd,createScene({id:'replay-doc'}),'boundary-replay',replayRequest);
  assert.equal(first.replayed,false);assert.equal(replay.replayed,true);assert.equal(replay.appliedRevision,0);
});

test('case-only document ID collision reports the stored scene ID and listing keeps exact case',async t=>{
  const cwd=await workspace();t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const stored=createScene({id:'layerTest',width:8,height:8});
  const file=path.join(cwd,'.zpixel','documents','layertest.json');
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,JSON.stringify({format:'dsh-zpixel-store/1',scene:stored,history:[],future:[],receipts:[]}));
  const before=await fs.readFile(file);
  await assert.rejects(createDocument(cwd,createScene({id:'layertest'}),'collision-create',{create:'collision'}),error=>{
    assert.equal(error.code,'DOCUMENT_ID_COLLISION');
    assert.equal(error.details.document,'layertest');
    assert.equal(error.details.storedId,'layerTest');
    assert.match(error.message,/layerTest/);
    return true;
  });
  await assert.rejects(loadDocument(cwd,'layertest'),error=>{
    assert.equal(error.code,'DOCUMENT_ID_COLLISION');
    assert.equal(error.details.storedId,'layerTest');
    return true;
  });
  assert.deepEqual(await fs.readFile(file),before);
  const listing=await listDocuments(cwd);
  assert.equal(listing.total,1);
  assert.equal(listing.documents[0].id,'layerTest');
  assert.equal(listing.documents[0].revision,0);
});
