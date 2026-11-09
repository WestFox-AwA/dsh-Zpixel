import {point,vector,normalize,axisVector,cross,dot,add,sub,multiply,identity,rotationBetween,rotationAround} from './math.mjs';
import {surfaceSamples} from './geometry.mjs';
import {compileWorld} from './world.mjs';

const EPS=1e-7;
const fail=(code,message,details={})=>{const e=new Error(message);e.code=code;e.details=details;throw e;};
const center=b=>b.min.map((v,i)=>(v+b.max[i])/2);
const scale=(v,n)=>v.map(x=>x*n);
const prepare=scene=>compileWorld(scene);
function boxSAT(a,b,tolerance){
  const box=e=>{const c=center(e.localBounds),extent=e.localBounds.max.map((v,i)=>(v-e.localBounds.min[i])/2);return{c:point(e.transform,c),edges:extent.map((v,i)=>vector(e.transform,[i===0?v:0,i===1?v:0,i===2?v:0]))};};
  const x=box(a),y=box(b),axes=[cross(x.edges[0],x.edges[1]),cross(x.edges[1],x.edges[2]),cross(x.edges[2],x.edges[0]),cross(y.edges[0],y.edges[1]),cross(y.edges[1],y.edges[2]),cross(y.edges[2],y.edges[0]),...x.edges.flatMap(u=>y.edges.map(v=>cross(u,v)))];
  let gap=-Infinity;for(const axis of axes){if(Math.hypot(...axis)<1e-12)continue;const n=normalize(axis),g=Math.abs(dot(sub(x.c,y.c),n))-x.edges.reduce((s,e)=>s+Math.abs(dot(e,n)),0)-y.edges.reduce((s,e)=>s+Math.abs(dot(e,n)),0);gap=Math.max(gap,g);}
  return{status:gap>tolerance?'separate':gap < -tolerance?'intersecting':'touching',method:'exact-box-SAT',certainty:'exact-classification-with-tolerance',axisGap:gap,tolerance};
}
function aabbGap(a,b){return Math.hypot(...[0,1,2].map(i=>Math.max(0,a.min[i]-b.max[i],b.min[i]-a.max[i])));}
function samplePoints(e){if(!e._samples){const all=e.instance.samples(),step=Math.max(1,Math.ceil(all.length/128));e._samples=all.filter((_,i)=>i%step===0);}return e._samples;}
function observePair(a,b,tolerance=0.02){
  if(a.node.kind==='group'||b.node.kind==='group'){
    const left=a.node.kind==='group'?a.leaves:[a],right=b.node.kind==='group'?b.leaves:[b],pairs=[];
    for(const x of left)for(const y of right)if(x.id!==y.id)pairs.push({nodes:[x.id,y.id],...observePair(x,y,tolerance)});
    const hit=pairs.find(v=>v.status==='intersecting')??pairs.find(v=>['touching','surface-proximity'].includes(v.status));
    if(hit)return{...hit,method:'group-leaf-pair:'+hit.method,evidence:{leafPairs:pairs.filter(v=>v.status===hit.status).slice(0,8)}};
    const separated=pairs.length>0&&pairs.every(v=>v.status==='separate');
    return{status:separated?'separate':'unresolved',method:'bounded-group-leaf-pairs',certainty:separated?'all-leaf-pairs-proved-separated':'incomplete-leaf-pair-evidence',evidence:{pairs:pairs.slice(0,32),totalPairs:left.length*right.length}};
  }
  if(!a.bounds||!b.bounds||!a.instance||!b.instance)return{status:'unresolved',method:'no-solid-geometry',certainty:'surface-or-empty'};
  const lower=aabbGap(a.bounds,b.bounds);if(lower>tolerance)return{status:'separate',method:'disjoint-world-bounds',certainty:'proved-separated',distanceLowerBound:lower,tolerance};
  if(a.node.geometry?.type==='box'&&b.node.geometry?.type==='box')return boxSAT(a,b,tolerance);
  const as=samplePoints(a),bs=samplePoints(b),witness=(ps,target)=>ps.find(p=>target.instance.contains(p,-EPS));
  const p=witness(as,b)??witness(bs,a);if(p)return{status:'intersecting',method:'geometry-interior-witness',certainty:'confirmed-local-intersection',evidence:{point:p},tolerance};
  let nearest=Infinity,points=null;for(const p of as)for(const q of bs){const d=Math.hypot(...sub(p,q));if(d<nearest){nearest=d;points=[p,q];}}
  if(nearest<=tolerance)return{status:a.node.kind==='layer'||b.node.kind==='layer'?'surface-proximity':'touching',method:'compiled-surface-samples',certainty:'witness-within-tolerance',evidence:{points,distance:nearest},tolerance};
  return{status:'unresolved',method:'compiled-surface-samples',certainty:'sample-miss-not-proof-of-separation',evidence:{distanceLowerBound:lower,distanceUpperBound:Number.isFinite(nearest)?nearest:null}};
}
function pairKey(a,b){return[a.node,b.node].sort().join('|');}
function intentObservations(scene,compiled,subjectId){
  const edges=scene.spatialRelations.filter(edge=>edge.from.node===subjectId||edge.to.node===subjectId);
  return edges.map(edge=>{
    const a=compiled.entries.get(edge.from.node),b=compiled.entries.get(edge.to.node),fromAnchor=edge.from.anchor?a.anchors[edge.from.anchor]:null,toAnchor=edge.to.anchor?b.anchors[edge.to.anchor]:null;
    let actual;
    if((edge.relation==='contact'||edge.relation==='support')&&fromAnchor&&toAnchor){
      const distance=Math.hypot(...sub(fromAnchor.point,toAnchor.point)),tolerance=edge.tolerance??.02;
      const normalsValid=edge.relation!=='support'||Boolean(fromAnchor.normal&&toAnchor.normal);
      const normalsOppose=edge.relation!=='support'||normalsValid&&dot(fromAnchor.normal,toAnchor.normal)<-.95;
      actual={status:edge.relation==='support'&&!normalsValid?'unresolved':distance<=tolerance&&normalsOppose?'touching':'separate',method:'named-anchor-distance',certainty:normalsValid?'measured-anchor-points-and-normals':'anchor-normal-missing',evidence:{from:fromAnchor.point,to:toAnchor.point,distance,normalsOppose},tolerance};
    }else if(edge.relation==='coaxial'&&fromAnchor?.axis&&toAnchor?.axis){
      const cosine=edge.signedAxis?dot(fromAnchor.axis,toAnchor.axis):Math.abs(dot(fromAnchor.axis,toAnchor.axis));const angle=Math.acos(Math.max(-1,Math.min(1,cosine)))*180/Math.PI;
      const axis=fromAnchor.axis,offset=Math.hypot(...cross(sub(toAnchor.point,fromAnchor.point),axis));
      actual={status:angle<=(edge.angleTolerance??2)&&offset<=(edge.distanceTolerance??.02)?'touching':'separate',method:'named-anchor-axes',certainty:'world-axis-lines',evidence:{angleDegrees:angle,axisDistance:offset},tolerance:edge.distanceTolerance??.02};
    }else actual=observePair(a,b,edge.tolerance??.02);
    let verdict='unresolved';
    if(edge.relation==='contact'||edge.relation==='support')verdict=['touching','surface-proximity'].includes(actual.status)?'met':actual.status==='intersecting'?'unmet':actual.status==='separate'?'unmet':'unresolved';
    else if(edge.relation==='avoid_intersection')verdict=actual.status==='intersecting'?'unmet':actual.status==='unresolved'?'unresolved':'met';
    else if(edge.relation==='allow_overlap')verdict=actual.status==='intersecting'?'met':actual.status==='unresolved'?'unresolved':'not-applicable';
    else if(edge.relation==='coaxial')verdict=actual.status==='touching'?'met':actual.status==='unresolved'?'unresolved':'unmet';
    return{intent:{...edge},observation:actual,verdict};
  });
}
function worldInfo(e){const g=e.geometryInstance,frame=e.semanticFrame;return{origin:point(e.transform,[0,0,0]),center:e.bounds?center(e.bounds):point(e.transform,[0,0,0]),semanticFrame:frame?{...frame}:null,geometryAxis:e.node.geometry?.axis?normalize(vector(e.transform,e.node.geometry.axis)):null,anchors:e.anchors,transformQuality:frame?.quality??'no-semantic-frame',revision:e.revision};}
function relationNeighbors(compiled,e,limit){
  if(e.node.appearanceOf!==undefined)return{total:0,truncated:false,items:[]};
  const candidates=[...compiled.entries.values()].filter(other=>other.id!==e.id&&other.node.kind!=='group'&&other.node.appearanceOf===undefined&&other.bounds&&other.instance);
  candidates.sort((a,b)=>(e.bounds?aabbGap(e.bounds,a.bounds)-aabbGap(e.bounds,b.bounds):0));
  return{total:candidates.length,truncated:candidates.length>limit,items:candidates.slice(0,limit).map(other=>({node:other.id,name:other.node.name,...observePair(e,other),pair:pairKey({node:e.id},{node:other.id})}))};
}
export function spatialTree(scene,{root='root',depth=3,limit=32}={}){
  if(!Number.isInteger(depth)||depth<0||depth>32||!Number.isInteger(limit)||limit<1||limit>256)fail('TREE_LIMIT','Tree depth is0..32 and limit1..256.');
  const compiled=prepare(scene);if(!compiled.entries.has(root))fail('NODE_NOT_FOUND','Unknown subtree '+root);let count=0,truncated=false;
  const build=(id,level)=>{if(count>=limit){truncated=true;return null;}count++;const e=compiled.entries.get(id),children=e.children,report={id,name:e.node.name,kind:e.node.kind,role:e.node.role,world:worldInfo(e),bounds:e.bounds,intent:intentObservations(scene,compiled,id),childCount:children.length,children:level<depth?children.map(n=>build(n,level+1)).filter(Boolean):[]};return report;};
  return{revision:scene.revision,coordinates:scene.coordinates,tree:build(root,0),returned:count,truncated};
}
export function findNodes(scene,{query='',role,tag,root}={}){
  const nodes=new Map(scene.nodes.map(n=>[n.id,n])),q=(query??'').toLowerCase();return scene.nodes.filter(n=>{if(q&&!`${n.id} ${n.name} ${n.role} ${(n.tags??[]).join(' ')}`.toLowerCase().includes(q))return false;if(role&&n.role!==role||tag&&!(n.tags??[]).includes(tag))return false;if(root&&n.id!==root){let p=n.parent;while(p&&p!==root)p=nodes.get(p)?.parent;if(p!==root)return false;}return true;}).map(({id,name,kind,parent,role,tags})=>({id,name,kind,parent,role,tags:[...(tags??[])]}));
}
export function spatialReport(scene,{node,other,query,role,tag,limit=12,includeProjection=false}={}){
  if(!Number.isInteger(limit)||limit<1||limit>32)fail('SPATIAL_LIMIT','Spatial limit must be an integer from1 to32.');const compiled=prepare(scene);
  if(node&&!compiled.entries.has(node)||other&&!compiled.entries.has(other))fail('NODE_NOT_FOUND','Spatial query references an unknown node.');
  const ids=node?[node]:findNodes(scene,{query,role,tag}).filter(n=>n.kind!=='group').map(n=>n.id),selected=ids.slice(0,limit);
  const nodes=selected.map(id=>{const e=compiled.entries.get(id),observations=relationNeighbors(compiled,e,limit);if(other){const target=compiled.entries.get(other);observations.items=observations.items.filter(v=>v.node===other);observations.total=e.node.appearanceOf===undefined&&target&&target.node.appearanceOf===undefined?1:0;observations.truncated=false;}return{id,name:e.node.name,kind:e.node.kind,role:e.node.role,tags:e.node.tags??[],world:worldInfo(e),bounds:e.bounds,intent:intentObservations(scene,compiled,id),worldObservations:observations,...(includeProjection?{projection:null}:{})};});
  return{revision:scene.revision,coordinates:scene.coordinates,nodes,totalMatches:ids.length,truncated:ids.length>limit};
}
export function spatialSummary(scene,nodeIds){
  const compiled=prepare(scene),affected=new Set(nodeIds??scene.nodes.map(n=>n.id));const edges=scene.spatialRelations.filter(e=>affected.has(e.from.node)||affected.has(e.to.node)).slice(0,32);
  const results=edges.map(edge=>{const pair=intentObservations(scene,compiled,edge.from.node).find(v=>v.intent.id===edge.id);return pair?{id:edge.id,relation:edge.relation,verdict:pair.verdict}:null;}).filter(Boolean);
  return{revision:scene.revision,coordinates:scene.coordinates,edges:results,unresolved:results.filter(e=>e.verdict==='unresolved').length,truncated:scene.spatialRelations.length>32};
}
function setWorld(entry,world,compiled){const parent=entry.parentId?compiled.entries.get(entry.parentId):null;entry.node.transform={matrix:parent?multiply(parent.inverse,world):world};}
function rotateAroundAnchor(entry,rotation,worldPoint,compiled){const t=identity(),back=identity();for(let i=0;i<3;i++){t[12+i]=worldPoint[i];back[12+i]=-worldPoint[i];}setWorld(entry,multiply(t,multiply(rotation,multiply(back,entry.transform))),compiled);}
function translated(entry,delta,compiled){const world=[...entry.transform];for(let i=0;i<3;i++)world[12+i]+=delta[i];setWorld(entry,world,compiled);}
function anchor(entry,name){if(!name||!entry.anchors[name])fail('ANCHOR_NOT_FOUND',`Node ${entry.id} has no anchor ${String(name)}.`);return entry.anchors[name];}
export function applySpatialOperation(scene,op){
  const compiled=prepare(scene),source=compiled.entries.get(op.id),target=compiled.entries.get(op.target);if(!source||!target)fail('NODE_NOT_FOUND','Source and target nodes must exist.');
  if(source.node.appearanceOf!==undefined)fail('APPEARANCE_NOT_PHYSICAL',`Source node ${source.id} is a bound appearance layer; it has no physical geometry for spatial operations.`,{id:source.id,appearanceOf:source.node.appearanceOf});
  if(target.node.appearanceOf!==undefined)fail('APPEARANCE_NOT_PHYSICAL',`Target node ${target.id} is a bound appearance layer; it has no physical geometry for spatial operations.`,{id:target.id,appearanceOf:target.node.appearanceOf});
  if(source.id===target.id||source.id==='root')fail('SPATIAL_TARGET','Choose two distinct non-root nodes.');
  let n=source;while(n){if(n.node.locked)fail('LOCKED_NODE','Source hierarchy contains locked node '+n.id);n=n.parentId?compiled.entries.get(n.parentId):null;}if(target.node.locked)fail('LOCKED_NODE','Target node is locked.');
  if(op.op==='node_align'){
    const allowed=['op','id','target','axis','targetAxis','space','position'];for(const k of Object.keys(op))if(!allowed.includes(k))fail('UNKNOWN_FIELD','Unknown node_align field '+k);
    const fromLocal=op.axis??source.node.semanticFrame?.forward,toLocal=op.targetAxis??target.node.semanticFrame?.forward;if(!fromLocal||!toLocal)fail('FRAME_UNDECLARED','Provide both axis and targetAxis, or declare semanticFrame on both nodes.');
    if(source.semanticFrame?.quality==='degenerate'||target.semanticFrame?.quality==='degenerate')fail('FRAME_DEGENERATE','Cannot align a degenerate transformed semantic frame.');
    const from=normalize(vector(source.transform,axisVector(fromLocal))),to=op.space==='world'?axisVector(toLocal):normalize(vector(target.transform,axisVector(toLocal)));
    const c=source.bounds?center(source.bounds):point(source.transform,[0,0,0]);rotateAroundAnchor(source,rotationBetween(from,to),c,compiled);
    if(op.position){const updated=prepare(scene),s=updated.entries.get(op.id),t=updated.entries.get(op.target);translated(s,sub(center(t.bounds),center(s.bounds)),updated);}
    return{method:'one-shot-axis-alignment',intentUnchanged:true,revision:scene.revision};
  }
  if(op.op!=='node_attach')fail('SPATIAL_OP','Unknown spatial operation.');
  const allowed=['op','id','target','mode','sourceAnchor','targetAnchor','rollPolicy','relationId','record','tolerance','gap'];for(const k of Object.keys(op))if(!allowed.includes(k))fail('UNKNOWN_FIELD','Unknown node_attach field '+k);
  const mode=op.mode??'frame';if(!['translate','frame','normal'].includes(mode))fail('ATTACH_MODE','Choose translate, frame or normal.');
  const sa=anchor(source,op.sourceAnchor),ta=anchor(target,op.targetAnchor),sourcePoint=[...sa.point],targetPoint=[...ta.point];
  if(mode==='frame'&&(!sa.normal||!sa.tangent||!ta.normal||!ta.tangent))fail('UNDERCONSTRAINED','Underconstrained: frame mode requires normal and tangent on both anchors.');
  if(mode==='normal'&&(!sa.normal||!ta.normal||!op.rollPolicy))fail('UNDERCONSTRAINED','Underconstrained: normal mode requires both normals and an explicit rollPolicy/reference.');
  if(op.gap!==undefined&&!Number.isFinite(op.gap))fail('ATTACH_GAP','gap must be finite.');
  if(op.gap&& !ta.normal)fail('UNDERCONSTRAINED','Underconstrained: A nonzero gap requires an explicit target anchor normal.');
  if(mode!=='translate'){
    const sw=anchor(source,op.sourceAnchor),tw=anchor(target,op.targetAnchor);if(!sw.normal||!tw.normal)fail('UNDERCONSTRAINED','Underconstrained: Rotation requires anchor normals.');
    const from=sw.normal,to=scale(tw.normal,-1);let rotation=rotationBetween(from,to);
    if(mode==='frame'||op.rollPolicy==='align_tangent'){
      if(!sw.tangent||!tw.tangent)fail('UNDERCONSTRAINED','Underconstrained: Tangent alignment requires tangents on both anchors.');
      const rotatedTangent=normalize(vector(rotation,sw.tangent)),targetTangent=normalize(tw.tangent),projected=sub(rotatedTangent,to.map(v=>v*dot(rotatedTangent,to))),desired=sub(targetTangent,to.map(v=>v*dot(targetTangent,to)));
      if(Math.hypot(...projected)<EPS||Math.hypot(...desired)<EPS)fail('UNDERCONSTRAINED','Underconstrained: Anchor tangents do not define a stable roll frame.');
      const a=normalize(projected),b=normalize(desired),angle=Math.atan2(dot(to,cross(a,b)),dot(a,b));rotation=multiply(rotationAround(to,angle*180/Math.PI),rotation);
    }else if(mode==='normal'&&op.rollPolicy!=='preserve_source')fail('ROLL_POLICY','normal mode requires rollPolicy align_tangent or preserve_source.');
    rotateAroundAnchor(source,rotation,sw.point,compiled);
  }
  const updated=prepare(scene),s=updated.entries.get(op.id),t=updated.entries.get(op.target),sa2=anchor(s,op.sourceAnchor),ta2=anchor(t,op.targetAnchor),delta=sub(ta2.point,sa2.point);
  translated(s,add(delta,op.gap?scale(ta2.normal,op.gap):[0,0,0]),updated);
  if(op.record){const pair=[`${op.id}#${op.sourceAnchor}`,`${op.target}#${op.targetAnchor}`].sort().join('|');const existing=scene.spatialRelations.find(edge=>edge.relation==='contact'&&[`${edge.from.node}#${edge.from.anchor??''}`,`${edge.to.node}#${edge.to.anchor??''}`].sort().join('|')===pair);if(!existing)scene.spatialRelations.push({id:op.relationId??`contact-${op.id}-${op.target}-${scene.revision+1}`,from:{node:op.id,anchor:op.sourceAnchor},relation:'contact',to:{node:op.target,anchor:op.targetAnchor},tolerance:op.tolerance??.02});}
  return{method:`anchor-${mode}-attach`,sourceAnchor:op.sourceAnchor,targetAnchor:op.targetAnchor,rollPolicy:op.rollPolicy??null,intentRecorded:Boolean(op.record),revision:scene.revision};
}
