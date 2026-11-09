import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {createZPixelServiceForTest as createZPixelService} from './helpers.mjs';
import {TOOL_SCHEMAS,toolDefinitions} from '../src/protocol.mjs';
import {fingerprint} from '../src/store.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
async function workspace(t){await fs.mkdir(path.join(root,'.validation'),{recursive:true});const cwd=await fs.mkdtemp(path.join(root,'.validation','v033-normalmap-'));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));return cwd;}
const sceneValues={width:16,height:16,camera:{preset:'top_down',pixelsPerUnit:1},nodes:[{id:'root',kind:'group'},{id:'block',kind:'part',geometry:{type:'box',center:[0,1,0],size:[4,2,4]}}]};
// A tilted preset makes the green channel depend on the convention; a
// perfectly top-down axis-aligned box only shows normals with zero green.
const angledSceneValues={...sceneValues,camera:{preset:'three_quarter',pixelsPerUnit:1}};
function serviceFor(cwd,{mode='workspace-write',maxImageDimension=4096,inputModalities=['text']}={}){
  const state={mode},saved=[];
  const ctx={workingDirectory:{async ensure(){return cwd;}},sandboxPolicy:{resolve(){return{mode:state.mode,workspaceRoot:cwd};}},llm:{async resolveModelInfo(){return{inputModalities};}},attachments:{imageLimits:{maxImageDimension},async saveImages(images){return images.map(image=>{saved.push(image);return{path:`stub-${saved.length}.png`,mediaType:image.mediaType,name:image.name};});}}};
  const exec={agent:{id:'normalmap-tests',session:{requestHeader(){return{config:{provider:'test',model:'test'}};}}},signal:new AbortController().signal};
  return{service:createZPixelService(ctx),exec,saved,state};
}
/** Minimal PNG reader for the renderer's filter-0, RGBA8 output. */
function parsePng(bytes){
  assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10],'expected a PNG signature');
  let offset=8,header,idat=[];
  while(offset<bytes.length){
    const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,offset+8+length);
    if(type==='IHDR')header={width:data.readUInt32BE(0),height:data.readUInt32BE(4),depth:data[8],colorType:data[9]};
    if(type==='IDAT')idat.push(data);
    offset+=12+length;
  }
  const raw=inflateSync(Buffer.concat(idat)),rgba=new Uint8Array(header.width*header.height*4),stride=header.width*4+1;
  for(let y=0;y<header.height;y++){
    assert.equal(raw[y*stride],0,`PNG row ${y} must use filter 0`);
    raw.copy(rgba,y*header.width*4,y*stride+1,y*stride+1+header.width*4);
  }
  return{...header,rgba};
}
const metadataText=value=>JSON.stringify(value);

test('normal map preview returns image metadata and native dimensions without writing exports',async t=>{
  const cwd=await workspace(t),{service,exec,saved}=serviceFor(cwd);
  try{
    await service.run('zpixel_scene',{action:'create',document:'preview',txid:'normalmap-create',scene:sceneValues},exec);
    const result=await service.run('zpixel_normalmap',{document:'preview'},exec);
    assert.equal(result.document,'preview');assert.equal(result.revision,0);assert.equal(result.mode,'normalmap');
    assert.equal(result.convention,'opengl');assert.equal(result.version,'0.5.3-dev');assert.equal(result.exported,false);
    assert.deepEqual(result.nativeSize,{width:16,height:16});
    assert.ok(result.normalMap&&typeof result.normalMap==='object'&&!Array.isArray(result.normalMap));
    assert.equal(typeof result.space,'string');assert.ok(result.space.length>0);
    assert.equal(typeof result.encoding,'string');assert.match(result.encoding,/linear/);
    assert.equal(result.preview.scale,6);assert.equal(result.preview.board.width>0,true);assert.equal(result.preview.panels.native.width,16);
    assert.equal(result.preview.panels.native.height,16);assert.equal(result.preview.visualReview,'not-recorded');
    assert.ok(Array.isArray(result.preview.warnings));assert.equal(typeof result.preview.stats.visiblePixels,'number');
    assert.ok(Array.isArray(result.preview.colorsUsed));assert.ok(result.preview.colorsUsed.length<=32);
    assert.equal(result.preview.colorsUsed.length,Math.min(32,result.preview.colorCount));
    assert.equal(result.preview.colorsTruncated,result.preview.colorCount>32);
    assert.match(result.attachment.name,/normalmap-opengl\.png$/);assert.equal(saved.length,1);assert.equal(saved[0].mediaType,'image/png');
    assert.match(result.sceneHash,/^[0-9a-f]{64}$/);
    const metadata=metadataText(result.normalMap);
    assert.match(metadata,/right/i,'normalMap must state the +X right axis');
    assert.match(metadata,/up|down/i,'normalMap must state the vertical axis convention');
    assert.match(metadata,/view/i,'normalMap must state the view-space axis');
    assert.match(metadata,/neutral/i,'normalMap must state the outside-neutral policy');
    assert.match(metadata,/view[-_ ]?facing/i,'normalMap must state the view-facing layer policy');
    await assert.rejects(fs.access(path.join(cwd,'.zpixel','exports')),error=>error.code==='ENOENT');
  } finally{service.dispose();}
});

test('smooth normal preview bounds its color palette while keeping the full count',async t=>{
  const cwd=await workspace(t),{service,exec}=serviceFor(cwd);
  try{
    const smooth={width:32,height:32,camera:{preset:'three_quarter',pixelsPerUnit:4},nodes:[{id:'root',kind:'group'},{id:'ball',kind:'part',geometry:{type:'ellipsoid',center:[0,0,0],radii:[1.6,1.6,1.6]}}]};
    await service.run('zpixel_scene',{action:'create',document:'smooth',txid:'normalmap-smooth',scene:smooth},exec);
    const result=await service.run('zpixel_normalmap',{document:'smooth',scale:1},exec);
    assert.ok(result.preview.colorCount>32,`a smooth sphere should exceed 32 colors, got ${result.preview.colorCount}`);
    assert.equal(result.preview.colorsUsed.length,32);
    assert.equal(result.preview.colorsTruncated,true);
  } finally{service.dispose();}
});

test('normal map rejects stale revisions and unknown conventions before rendering',async t=>{
  const cwd=await workspace(t),{service,exec,saved}=serviceFor(cwd);
  try{
    await service.run('zpixel_scene',{action:'create',document:'revision',txid:'normalmap-revision',scene:sceneValues},exec);
    await assert.rejects(service.run('zpixel_normalmap',{document:'revision',revision:1},exec),error=>{
      assert.equal(error.code,'REVISION_CONFLICT');assert.equal(error.details.expected,1);assert.equal(error.details.actual,0);return true;
    });
    await assert.rejects(service.run('zpixel_normalmap',{document:'revision',convention:'blender'},exec),error=>{
      assert.equal(error.code,'CONVENTION');assert.match(error.message,/opengl.*directx/i);return true;
    });
    await assert.rejects(service.run('zpixel_normalmap',{document:'revision',scale:9},exec),error=>{
      assert.equal(error.code,'RANGE');assert.equal(error.details.field,'scale');return true;
    });
    await assert.rejects(service.run('zpixel_normalmap',{document:'revision',export:'true'},exec),error=>{
      assert.equal(error.code,'ARGUMENTS');assert.match(error.message,/boolean/i);return true;
    });
    assert.equal(saved.length,0,'rejected calls must not deliver a preview');
    await assert.rejects(fs.access(path.join(cwd,'.zpixel','exports')),error=>error.code==='ENOENT');
  } finally{service.dispose();}
});

test('normal map preview is read-only while export requires workspace writes',async t=>{
  const cwd=await workspace(t),{service,exec,saved,state}=serviceFor(cwd);
  try{
    await service.run('zpixel_scene',{action:'create',document:'readonly',txid:'normalmap-readonly',scene:sceneValues},exec);
    state.mode='read-only';
    const preview=await service.run('zpixel_normalmap',{document:'readonly',scale:1},exec);
    assert.equal(preview.exported,false);assert.equal(saved.length,1);
    await assert.rejects(service.run('zpixel_normalmap',{document:'readonly',export:true},exec),error=>{
      assert.equal(error.code,'READ_ONLY');return true;
    });
    await assert.rejects(fs.access(path.join(cwd,'.zpixel','exports')),error=>error.code==='ENOENT');
  } finally{service.dispose();}
});

test('an oversized preview rejects the export before any file is written',async t=>{
  const cwd=await workspace(t),{service,exec}=serviceFor(cwd,{maxImageDimension:100});
  try{
    await service.run('zpixel_scene',{action:'create',document:'oversize',txid:'normalmap-oversize',scene:sceneValues},exec);
    await assert.rejects(service.run('zpixel_normalmap',{document:'oversize',export:true},exec),error=>{
      assert.equal(error.code,'PREVIEW_SIZE');assert.match(error.message,/host image dimensions/i);return true;
    });
    await assert.rejects(fs.access(path.join(cwd,'.zpixel','exports')),error=>error.code==='ENOENT');
  } finally{service.dispose();}
});

test('both conventions export distinct PNGs, hashes and the same source project idempotently',async t=>{
  const cwd=await workspace(t),{service,exec}=serviceFor(cwd);
  try{
    await service.run('zpixel_scene',{action:'create',document:'exports',txid:'normalmap-export',scene:angledSceneValues},exec);
    const opengl=await service.run('zpixel_normalmap',{document:'exports',export:true,convention:'opengl',scale:2},exec);
    const directx=await service.run('zpixel_normalmap',{document:'exports',export:true,convention:'directx',scale:2},exec);
    assert.equal(opengl.status,'technical-data');assert.equal(directx.status,'technical-data');assert.equal(opengl.exported,true);
    assert.equal(opengl.generation,'v0.5.3-dev-normalmap-opengl');assert.equal(directx.generation,'v0.5.3-dev-normalmap-directx');
    assert.notEqual(opengl.png,directx.png);assert.notEqual(opengl.manifest,directx.manifest);
    for(const [result,convention] of [[opengl,'opengl'],[directx,'directx']]){
      assert.equal(path.basename(result.png),'normal.png');assert.equal(path.basename(result.beauty),'sprite.png');
      assert.equal(result.sprite,result.beauty);assert.ok(path.dirname(result.png).endsWith(`exports-r0-v0.5.3-dev-normalmap-${convention}`));
      assert.equal(path.basename(result.project),'project.zpixel.json');assert.equal(path.basename(result.manifest),'normalmap.json');
      const normalBytes=await fs.readFile(result.png),beautyBytes=await fs.readFile(result.beauty);
      const normal=parsePng(normalBytes),beauty=parsePng(beautyBytes);
      assert.deepEqual([normal.width,normal.height],[16,16]);assert.deepEqual([beauty.width,beauty.height],[16,16]);
      assert.equal(normal.depth,8);assert.equal(normal.colorType,6);
      const alphas=new Set();for(let index=3;index<normal.rgba.length;index+=4)alphas.add(normal.rgba[index]);
      assert.deepEqual([...alphas].filter(alpha=>alpha!==0&&alpha!==255),[],'normal PNG alpha must be binary');
      assert.ok(alphas.has(255),'covered geometry must remain opaque');
      const manifest=JSON.parse(await fs.readFile(result.manifest,'utf8'));
      assert.equal(manifest.format,'dsh-zpixel-normalmap-export/1');assert.equal(manifest.version,'0.5.3-dev');
      assert.equal(manifest.renderer.version,'0.3.6');assert.equal(manifest.document,'exports');assert.equal(manifest.revision,0);
      assert.equal(manifest.convention,convention);assert.equal(manifest.space,result.space);assert.equal(manifest.encoding,result.encoding);
      assert.equal(manifest.status,'technical-data');assert.equal(manifest.review,null);
      assert.match(manifest.import,/linear/i);assert.match(manifest.import,/non-color|noncolor|srgb/i);
      assert.equal(manifest.png.normal.sha256,createHash('sha256').update(normalBytes).digest('hex'));
      assert.equal(manifest.png.beauty.sha256,createHash('sha256').update(beautyBytes).digest('hex'));
      assert.deepEqual(manifest.normalMap,result.normalMap);assert.equal(manifest.sceneHash,result.sceneHash);
      const project=JSON.parse(await fs.readFile(result.project,'utf8'));
      const stored=JSON.parse(await fs.readFile(path.join(cwd,'.zpixel','documents','exports.json'),'utf8')).scene;
      assert.deepEqual(project,stored,'exported project must match the stored revision');
      assert.equal(fingerprint(project),result.sceneHash);
    }
    const openglNormal=parsePng(await fs.readFile(opengl.png)),directxNormal=parsePng(await fs.readFile(directx.png));
    assert.notDeepEqual([...openglNormal.rgba],[...directxNormal.rgba],'conventions must differ in the encoded normal bytes');
    const manifestBytes=await fs.readFile(opengl.manifest),pngBytes=await fs.readFile(opengl.png);
    const repeat=await service.run('zpixel_normalmap',{document:'exports',export:true,convention:'opengl',scale:2},exec);
    assert.equal(repeat.png,opengl.png);assert.equal(repeat.manifest,opengl.manifest);
    assert.deepEqual(await fs.readFile(repeat.png),pngBytes);assert.deepEqual(await fs.readFile(repeat.manifest),manifestBytes);
  } finally{service.dispose();}
});

test('a normal map preview never satisfies the reviewed beauty export gate',async t=>{
  const cwd=await workspace(t),{service,exec}=serviceFor(cwd,{inputModalities:['text','image']});
  try{
    await service.run('zpixel_scene',{action:'create',document:'gate',txid:'normalmap-gate',scene:sceneValues},exec);
    const preview=await service.run('zpixel_normalmap',{document:'gate',scale:1},exec);
    assert.equal(preview.exported,false);
    await assert.rejects(service.run('zpixel_export',{document:'gate',draft:false,review:{identity:true,nativeReadable:true,lighting:true,note:'Checked the asset at native size.'}},exec),error=>{
      assert.equal(error.code,'PREVIEW_REQUIRED');assert.match(error.message,/beauty/i);return true;
    });
    const beautyPreview=await service.run('zpixel_render',{document:'gate',scale:1},exec);
    assert.ok(beautyPreview.attachment,'a beauty render still delivers the reviewed export preview');
    await service.run('zpixel_render',{document:'gate',camera:{preset:'three_quarter'},physicalOnly:true,scale:1},exec);
    const reviewed=await service.run('zpixel_export',{document:'gate',draft:false,review:{identity:true,nativeReadable:true,lighting:true,note:'Checked the asset at native size.'}},exec);
    assert.equal(reviewed.status,'reviewed');assert.ok(reviewed.manifest.endsWith('reviewed.json'));
  } finally{service.dispose();}
});

test('normal map schema keeps the PTC subset, guide topic and read-only concurrency',()=>{
  const tool=TOOL_SCHEMAS.find(({name})=>name==='zpixel_normalmap'),parameters=tool.parameters;
  assert.ok(tool,'zpixel_normalmap must be registered');
  assert.match(tool.description,/normalmap/i,'description must point at the normalmap guide');
  assert.deepEqual(parameters.required,['document']);assert.equal(parameters.additionalProperties,false);
  assert.equal(parameters.properties.revision.type,'integer');
  assert.deepEqual(parameters.properties.convention.enum,['opengl','directx']);assert.equal(parameters.properties.convention.type,'string');
  assert.equal(parameters.properties.scale.type,'integer');
  assert.ok(!Object.hasOwn(parameters.properties.scale,'minimum')&&!Object.hasOwn(parameters.properties.scale,'maximum'),'PTC subset has no bounds keywords');
  assert.equal(parameters.properties.export.type,'boolean');
  const guide=TOOL_SCHEMAS.find(({name})=>name==='zpixel_guide');
  assert.ok(guide.parameters.properties.topic.enum.includes('normalmap'));
  const render=TOOL_SCHEMAS.find(({name})=>name==='zpixel_render');
  assert.match(render.parameters.properties.mode.description,/world-space diagnostic/i);
  const definitions=new Map(toolDefinitions({}).map(definition=>[definition.name,definition]));
  assert.equal(definitions.get('zpixel_normalmap').timeoutMs,definitions.get('zpixel_render').timeoutMs);
  assert.equal(definitions.get('zpixel_normalmap').isConcurrencySafe({document:'gate'}),true);
  assert.equal(definitions.get('zpixel_normalmap').isConcurrencySafe({document:'gate',export:false}),true);
  assert.equal(definitions.get('zpixel_normalmap').isConcurrencySafe({document:'gate',export:true}),false);
});

test('unknown normal-map fields fail with UNSUPPORTED_FIELD instead of being ignored',async t=>{
  const cwd=await workspace(t),{service,exec,saved}=serviceFor(cwd);
  try{
    await service.run('zpixel_scene',{action:'create',document:'strict',txid:'normalmap-strict',scene:sceneValues},exec);
    for(const field of ['strength','height','heightScale','normalSource','normalConvention','blur','edge']){
      await assert.rejects(service.run('zpixel_normalmap',{document:'strict',[field]:1},exec),error=>{
        assert.equal(error.code,'UNSUPPORTED_FIELD');
        assert.equal(error.details.field,field);
        assert.deepEqual(error.details.allowed,['document','revision','convention','scale','export']);
        assert.match(error.details.hint,/no strength, height/i);
        return true;
      });
    }
    assert.equal(saved.length,0,'rejected calls must not deliver a preview');
    const open=await service.run('zpixel_normalmap',{document:'strict',convention:'opengl',scale:2,export:false},exec);
    assert.equal(open.convention,'opengl');assert.equal(saved.length,1);
    const direct=await service.run('zpixel_normalmap',{document:'strict',convention:'directx'},exec);
    assert.equal(direct.convention,'directx');assert.equal(saved.length,2);
    assert.equal(direct.diagnostics.flatness,'flat');
  }finally{service.dispose();}
});

test('diagnostics report a top_down solid box as flat by design and keep fallback neutral separate',async t=>{
  const cwd=await workspace(t),{service,exec}=serviceFor(cwd);
  try{
    await service.run('zpixel_scene',{action:'create',document:'flatdiag',txid:'normalmap-flatdiag',scene:sceneValues},exec);
    const result=await service.run('zpixel_normalmap',{document:'flatdiag',scale:1},exec),d=result.diagnostics;
    assert.equal(d.sourceMode,'geometry');assert.equal(d.relief,'none');
    assert.equal(d.representation,'solid-parts');assert.equal(d.camera.view,'top_down');
    assert.equal(d.uniqueColorCount,1);assert.equal(d.dominantColor,'#8080ff');
    assert.equal(d.dominantShare,1);assert.equal(d.neutralEncodedShare,1);
    assert.equal(d.flatness,'flat');
    assert.equal(d.visiblePixels,result.preview.stats.visiblePixels);
    assert.ok(d.visiblePixels>0);
    assert.equal(result.normalMap.fallbackCounts.neutralPixels,0,'fallback neutralPixels is a different counter');
    assert.ok(d.warnings.some(w=>/top_down/.test(w)));
    assert.ok(d.warnings.some(w=>/128,128,255/.test(w)));
    assert.ok(result.preview.warnings.includes(d.warnings[0]));
  }finally{service.dispose();}
});

test('diagnostics distinguish oblique or curved geometry from a flat top-down box',async t=>{
  const cwd=await workspace(t),{service,exec}=serviceFor(cwd);
  try{
    const oblique={width:32,height:32,camera:{preset:'three_quarter',pixelsPerUnit:4},nodes:[{id:'root',kind:'group'},{id:'body',kind:'part',outline:{enabled:false},geometry:{type:'box',min:[-2,0,-2],max:[2,1,2]}}]};
    await service.run('zpixel_scene',{action:'create',document:'varied',txid:'normalmap-varied',scene:oblique},exec);
    const box=await service.run('zpixel_normalmap',{document:'varied',scale:1},exec);
    assert.ok(box.diagnostics.uniqueColorCount>1);
    assert.equal(box.diagnostics.flatness,'varied');
    assert.equal(box.diagnostics.camera.view,'oblique');
    assert.ok(box.diagnostics.neutralEncodedShare<1);
    const sphere={width:32,height:32,camera:{preset:'three_quarter',pixelsPerUnit:4},nodes:[{id:'root',kind:'group'},{id:'ball',kind:'part',outline:{enabled:false},geometry:{type:'ellipsoid',center:[0,0,0],radii:[1.6,1.6,1.6]}}]};
    await service.run('zpixel_scene',{action:'create',document:'sphere',txid:'normalmap-sphere',scene:sphere},exec);
    const ball=await service.run('zpixel_normalmap',{document:'sphere',scale:1},exec);
    assert.ok(ball.diagnostics.uniqueColorCount>32,'exact count must not be truncated to the 32-color preview list');
    assert.equal(ball.preview.colorsUsed.length,32);
    assert.equal(ball.preview.colorsTruncated,true);
    assert.equal(ball.diagnostics.uniqueColorCount,ball.preview.colorCount);
    assert.equal(ball.diagnostics.flatness,'varied');
  }finally{service.dispose();}
});

test('diagnostics explain painted-layer neutral without claiming a height input',async t=>{
  const cwd=await workspace(t),{service,exec}=serviceFor(cwd);
  try{
    const paint={width:16,height:16,camera:{preset:'top_down',pixelsPerUnit:1},nodes:[{id:'root',kind:'group'},{id:'paint',kind:'layer',parent:'root',width:4,height:4,pixelSize:1,basis:{u:[1,0,0],v:[0,0,-1]},pixels:Array(16).fill('#ff0000')}]};
    await service.run('zpixel_scene',{action:'create',document:'paintdiag',txid:'normalmap-paintdiag',scene:paint},exec);
    const result=await service.run('zpixel_normalmap',{document:'paintdiag',scale:1},exec),d=result.diagnostics;
    assert.equal(d.representation,'painted-layers');
    assert.equal(d.flatness,'flat');
    assert.equal(d.layerPixels,d.visiblePixels);
    assert.equal(d.surfacePixels,0);
    assert.ok(d.warnings.some(w=>/painted layers/.test(w)));
    assert.ok(d.warnings.some(w=>/height relief/.test(w)));
    assert.ok(!d.warnings.some(w=>/top_down/.test(w)),'no camera hint when no solid surface is visible');
  }finally{service.dispose();}
});
