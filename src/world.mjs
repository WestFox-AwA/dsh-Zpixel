import {worldTransforms,point,vector,inverse,normal,normalize,dot,sub} from './math.mjs';
import {localBounds,intersectLocal,containsLocal,surfaceSamples,supportLocal} from './geometry.mjs';

const scale=(v,n)=>v.map(x=>x*n);
const corners=b=>b?[0,1].flatMap(x=>[0,1].flatMap(y=>[0,1].map(z=>[x?b.max[0]:b.min[0],y?b.max[1]:b.min[1],z?b.max[2]:b.min[2]]))):[];
const bounds=points=>points.length?{min:[0,1,2].map(i=>Math.min(...points.map(p=>p[i]))),max:[0,1,2].map(i=>Math.max(...points.map(p=>p[i])))}:null;
const center=b=>b.min.map((v,i)=>(v+b.max[i])/2);
const normalizedFrame=(first,second)=>{
  const a=normalize(first),raw=normalize(second),departure=Math.abs(dot(a,raw));
  const b=sub(raw,a.map(v=>v*dot(a,raw))),length=Math.hypot(...b);
  if(length<1e-8)return {quality:'degenerate',forward:a,up:null};
  return {quality:departure<1e-6?'rigid':'orthogonalized',forward:a,up:b.map(v=>v/length)};
};
function worldAnchor(matrix,inverseMatrix,anchor){
  const result={point:point(matrix,anchor.point)};
  if(anchor.normal)result.normal=normalize(normal(inverseMatrix,anchor.normal));
  if(anchor.tangent){
    const raw=vector(matrix,anchor.tangent),tangent=result.normal?sub(raw,result.normal.map(v=>v*dot(raw,result.normal))):raw;
    const magnitude=Math.hypot(...tangent);
    if(magnitude<1e-8)result.quality='degenerate';
    else {result.tangent=tangent.map(v=>v/magnitude);result.quality=result.normal&&Math.abs(dot(normalize(raw),result.normal))<1e-6?'rigid':'orthogonalized';}
  }
  if(anchor.axis)result.axis=normalize(vector(matrix,anchor.axis));
  return result;
}
function localDirectionForSupport(matrix,direction){
  return [0,1,2].map(i=>matrix[i*4]*direction[0]+matrix[i*4+1]*direction[1]+matrix[i*4+2]*direction[2]);
}
export function compileWorld(scene){
  const transforms=worldTransforms(scene),nodes=new Map(scene.nodes.map(node=>[node.id,node])),entries=new Map();
  const descendants=id=>{const result=[];for(const entry of entries.values()){let parent=entry.node.parent;while(parent){if(parent===id){result.push(entry);break;}parent=nodes.get(parent)?.parent??null;}}return result;};
  for(const node of scene.nodes){
    const transform=transforms.get(node.id),inverseTransform=inverse(transform);
    // A bound appearance layer keeps its transform/inverse for planar sampling but
    // contributes no physical instance, bounds, support, samples, shadow or outline.
    const physical=node.kind!=='group'&&node.appearanceOf===undefined;
    const local=physical?localBounds(node):null,ownBounds=local?bounds(corners(local).map(p=>point(transform,p))):null;
    const instance=physical?{node,transform,inverse:inverseTransform,localBounds:local,worldBounds:ownBounds,
      ray(origin,direction){return intersectLocal(node,point(inverseTransform,origin),vector(inverseTransform,direction));},
      contains(worldPoint,tolerance=0){return containsLocal(node,point(inverseTransform,worldPoint),tolerance);},
      support(direction){return point(transform,supportLocal(node,localDirectionForSupport(transform,direction)));},
      samples(){return surfaceSamples(node).map(p=>point(transform,p));}}:null;
    const anchors=Object.fromEntries(Object.entries(node.anchors??{}).map(([name,anchor])=>[name,worldAnchor(transform,inverseTransform,anchor)]));
    const semanticFrame=node.semanticFrame?normalizedFrame(vector(transform,node.semanticFrame.forward),vector(transform,node.semanticFrame.up)):null;
    entries.set(node.id,{id:node.id,node,parentId:node.parent??null,transform,matrix:transform,inverse:inverseTransform,inv:inverseTransform,instance,localBounds:local,local,bounds:ownBounds,anchors,semanticFrame,visible:node.visible,children:[]});
  }
  for(const entry of entries.values())if(entry.parentId)entries.get(entry.parentId).children.push(entry.id);
  const effectiveVisible=new Map(),resolving=new Set();
  const resolveVisible=entry=>{
    if(effectiveVisible.has(entry.id))return effectiveVisible.get(entry.id);
    if(resolving.has(entry.id))throw new Error('Cycle in scene graph.');
    resolving.add(entry.id);
    const parent=entry.parentId===null?null:entries.get(entry.parentId);
    if(entry.parentId!==null&&!parent)throw new Error(`Unknown parent ${entry.parentId}`);
    const inherited=parent?resolveVisible(parent):true;
    resolving.delete(entry.id);
    const visible=Boolean(inherited&&entry.node.visible);
    effectiveVisible.set(entry.id,visible);
    return visible;
  };
  for(const entry of entries.values())entry.visible=resolveVisible(entry);
  const collectLeaves=entry=>entry.node.kind==='group'?entry.children.flatMap(id=>collectLeaves(entries.get(id))):entry.bounds?[entry]:[];
  for(const entry of entries.values())if(entry.node.kind==='group'){entry.leaves=collectLeaves(entry);entry.bounds=bounds(entry.leaves.flatMap(leaf=>corners(leaf.bounds)));}
  return {revision:scene.revision,coordinates:scene.coordinates,nodes,entries,transforms,descendants};
}
export {center as boundsCenter};
