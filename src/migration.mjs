import {createScene,ZPixelError} from './scene.mjs';
import {compose,multiply,inverse,point,vector,normalize,dot,cross} from './math.mjs';

/** Proper rotation (det=+1), not a reflection or an Euler-component swap. */
export const OLD_TO_NEW=[1,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,1];
const BACK=inverse(OLD_TO_NEW);
export const convertLegacyPoint=p=>point(OLD_TO_NEW,p);
export const convertLegacyVector=p=>vector(OLD_TO_NEW,p);
export const convertLegacyTransform=t=>({matrix:multiply(OLD_TO_NEW,multiply(compose(t??{}),BACK))});
const fail=message=>{throw new ZPixelError('MIGRATION_INPUT',message);};
function oldCamera(scene){
  const c=scene.camera,elevation=55*Math.PI/180;
  if(!c||!['top_down','three_quarter'].includes(c.preset))fail('Legacy camera must be top_down or three_quarter.');
  const oldDirection=c.preset==='top_down'?[0,0,-1]:[0,Math.cos(elevation),-Math.sin(elevation)];
  const oldDown=c.preset==='top_down'?[0,1,0]:[0,-Math.sin(elevation),-Math.cos(elevation)];
  const target=convertLegacyPoint(c.target),direction=convertLegacyVector(oldDirection),down=convertLegacyVector(oldDown),right=convertLegacyVector([1,0,0]);
  const up=down.map(v=>-v),physicalRight=normalize(cross(direction,up));
  return {camera:{position:target.map((v,i)=>v-direction[i]*1e7),target,up,mirrorX:dot(physicalRight,right)<0,pixelsPerUnit:c.pixelsPerUnit,center:[...c.center]},oldRight:[1,0,0],oldDown};
}
function geometry(g){
  if(!g||typeof g!=='object')fail('Legacy part has no geometry.');
  if(g.type==='box'){
    const a=convertLegacyPoint(g.min),b=convertLegacyPoint(g.max);
    return {type:'box',min:a.map((v,i)=>Math.min(v,b[i])),max:a.map((v,i)=>Math.max(v,b[i]))};
  }
  if(g.type==='ellipsoid')return {type:'ellipsoid',center:convertLegacyPoint(g.center),radii:[g.radii[0],g.radii[2],g.radii[1]]};
  if(g.type==='cylinder')return {type:'cylinder',center:convertLegacyPoint(g.center),radius:g.radius,length:g.height,axis:[0,1,0]};
  if(g.type==='extrude')return {type:'extrude',points:structuredClone(g.points),range:[...g.z],axis:[0,1,0]};
  fail('Unsupported legacy geometry '+g.type);
}
export function migrateLegacyScene(input,{id}={}){
  if(!input||input.format!=='dsh-zpixel/1'||!Array.isArray(input.nodes)||input.nodes.length>256)fail('Expected an exported dsh-zpixel/1 scene. New-format scenes do not need migration.');
  const old=structuredClone(input),view=oldCamera(old),notes=['Format1 has no semantic role/frame fields; v2 defaults are placeholders. Set frame.forward/up for nodes used by spatial attach/align.'];
  const nodes=old.nodes.map(node=>{
    const n={...node,transform:convertLegacyTransform(node.transform)};delete n.frame;delete n.frameDeclared;delete n.relations;
    // Legacy scenes did not declare semantic front/up; migration preserves their
    // local vector meaning rather than silently inventing an asset facing.
    if(n.kind==='part')n.geometry=geometry(n.geometry);
    if(n.kind==='layer'){
      const bases={xy:{u:[1,0,0],v:[0,1,0]},xz:{u:[1,0,0],v:[0,0,-1]},yz:{u:[0,1,0],v:[0,0,-1]},view:{u:view.oldRight,v:view.oldDown}};
      const basis=bases[n.plane];if(!basis)fail('Unknown legacy painting plane '+n.plane);
      n.basis={u:convertLegacyVector(basis.u),v:convertLegacyVector(basis.v)};
      if(n.plane==='view')notes.push(`Layer ${n.id}: view basis fixed at migration camera; it is now explicit spatial data.`);
      delete n.plane;
    }
    return n;
  });
  const lights=old.lights.map(l=>({...l,position:convertLegacyPoint(l.position),direction:convertLegacyVector(l.direction)}));
  const scene=createScene({id:id??`${old.id}-yup`,title:old.title,width:old.width,height:old.height,camera:view.camera,ambient:old.ambient,exposure:old.exposure,palette:old.palette,ramps:old.ramps,materials:old.materials,lights,nodes});
  return {scene,migration:{fromFormat:old.format,toFormat:scene.format,sourceId:old.id,sourceRevision:old.revision,coordinates:scene.coordinates,conversion:'[x,y,z] -> [x,z,-y]; Mnew=C*Mold*C^-1',cameraMirrorExplicit:view.camera.mirrorX,notes}};
}
