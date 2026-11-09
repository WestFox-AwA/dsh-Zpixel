import {add,sub,dot,cross,normalize,axisBasis} from './math.mjs';

const EPS=1e-9;
const along=(o,d,t)=>add(o,d.map(v=>v*t));
const scale=(a,s)=>a.map(v=>v*s);
const inRange=(v,a,b)=>v>=a-EPS&&v<=b+EPS;
function pointOnEdge(p,a,b){const e=sub(b,a),q=sub(p,a);return Math.abs(e[0]*q[1]-e[1]*q[0])<=EPS&&dot(q,e)>=-EPS&&dot(sub(p,b),e)<=EPS;}
export function polygonContains(p,points){
  let inside=false;
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    const a=points[j],b=points[i];if(pointOnEdge(p,a,b))return true;
    if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}
function boxHit(g,o,d){
  let near=-Infinity,far=Infinity,nn=[0,0,0],fn=[0,0,0];
  for(let a=0;a<3;a++){
    if(Math.abs(d[a])<1e-14){if(!inRange(o[a],g.min[a],g.max[a]))return null;continue;}
    let t1=(g.min[a]-o[a])/d[a],t2=(g.max[a]-o[a])/d[a];let n1=[0,0,0],n2=[0,0,0];n1[a]=-1;n2[a]=1;
    if(t1>t2){[t1,t2]=[t2,t1];[n1,n2]=[n2,n1];}
    if(t1>near){near=t1;nn=n1;}if(t2<far){far=t2;fn=n2;}if(near>far+EPS)return null;
  }
  return near>EPS?{t:near,normal:nn}:far>EPS?{t:far,normal:fn}:null;
}
function ellipsoidHit(g,o,d){
  const q=sub(o,g.center).map((v,i)=>v/g.radii[i]),v=d.map((v,i)=>v/g.radii[i]),a=dot(v,v);
  if(!(a>0))return null;const mid=-dot(q,v)/a,closest=along(q,v,mid),remaining=1-dot(closest,closest);
  if(remaining<0)return null;const delta=Math.sqrt(remaining/a),t=[mid-delta,mid+delta].find(v=>v>EPS);
  if(t===undefined)return null;const p=along(o,d,t);return {t,normal:normalize(p.map((v,i)=>(v-g.center[i])/g.radii[i]**2))};
}
function cylinderHit(g,o,d){
  const {u,v,n}=axisBasis(g.axis),q=sub(o,g.center);
  const ox=dot(q,u),oy=dot(q,v),oz=dot(q,n),dx=dot(d,u),dy=dot(d,v),dz=dot(d,n),half=g.length/2;
  const candidates=[],a=dx*dx+dy*dy;
  if(a>1e-24){const mid=-(ox*dx+oy*dy)/a,qx=ox+dx*mid,qy=oy+dy*mid,remaining=g.radius*g.radius-qx*qx-qy*qy;
    if(remaining>=0){const delta=Math.sqrt(remaining/a);for(const t of [mid-delta,mid+delta])if(t>EPS&&inRange(oz+dz*t,-half,half))candidates.push({t,normal:normalize(add(scale(u,ox+dx*t),scale(v,oy+dy*t)))});}
  }
  if(Math.abs(dz)>1e-14)for(const end of [-half,half]){const t=(end-oz)/dz;if(t>EPS&&(ox+dx*t)**2+(oy+dy*t)**2<=g.radius*g.radius+EPS)candidates.push({t,normal:scale(n,Math.sign(end))});}
  candidates.sort((a,b)=>a.t-b.t);return candidates[0]??null;
}
function extrudeHit(g,o,d){
  const {u,v,n}=axisBasis(g.axis),q=[dot(o,u),dot(o,v)],r=[dot(d,u),dot(d,v)],on=dot(o,n),dn=dot(d,n),[lo,hi]=g.range;
  const hits=[];
  if(Math.abs(dn)>1e-14)for(const [h,sign] of [[lo,-1],[hi,1]]){const t=(h-on)/dn;if(t>EPS&&polygonContains([q[0]+r[0]*t,q[1]+r[1]*t],g.points))hits.push({t,normal:scale(n,sign)});}
  let area=0;for(let i=0;i<g.points.length;i++){const a=g.points[i],b=g.points[(i+1)%g.points.length];area+=a[0]*b[1]-b[0]*a[1];}
  const orientation=area>=0?1:-1;
  for(let i=0;i<g.points.length;i++){
    const a=g.points[i],b=g.points[(i+1)%g.points.length],edge=sub(b,a),den=r[0]*edge[1]-r[1]*edge[0];if(Math.abs(den)<1e-14)continue;
    const ao=sub(a,q),t=(ao[0]*edge[1]-ao[1]*edge[0])/den,s=(ao[0]*r[1]-ao[1]*r[0])/den;
    if(t>EPS&&inRange(s,0,1)&&inRange(on+dn*t,lo,hi))hits.push({t,normal:normalize(add(scale(u,orientation*edge[1]),scale(v,-orientation*edge[0])))});
  }
  hits.sort((a,b)=>a.t-b.t);return hits[0]??null;
}
const boundAppearance=node=>node?.kind==='layer'&&node.appearanceOf!==undefined;
function layerPixelAtUV(node,u,v){
  const x=u/node.pixelSize,y=v/node.pixelSize;
  if(x<-EPS||y<-EPS||x>=node.width-EPS||y>=node.height-EPS)return null;
  const pixelX=Math.max(0,Math.floor(x+EPS)),pixelY=Math.max(0,Math.floor(y+EPS));
  const colorRef=node.pixels[pixelY*node.width+pixelX];return colorRef===null?null:{colorRef,pixelX,pixelY};
}
function layerPixel(node,p,tolerance=0){
  const {u,v}=node.basis,n=normalize(cross(u,v));if(Math.abs(dot(p,n))>Math.max(1e-7,tolerance))return null;
  return layerPixelAtUV(node,dot(p,u),dot(p,v));
}
/** Bound-appearance sampling: orthographic planar projection through the target only. */
export function sampleAppearanceLocal(node,localPoint){
  if(!boundAppearance(node))return null;
  return layerPixelAtUV(node,dot(localPoint,node.basis.u),dot(localPoint,node.basis.v));
}
export function intersectLocal(node,origin,direction){
  if(node.kind==='layer'){
    if(boundAppearance(node))return null;
    const n=normalize(cross(node.basis.u,node.basis.v)),den=dot(n,direction);if(Math.abs(den)<1e-14)return null;
    const t=-dot(n,origin)/den;if(t<=EPS)return null;const pixel=layerPixel(node,along(origin,direction,t));return pixel?{t,normal:n,...pixel}:null;
  }
  if(node.kind!=='part')return null;
  const g=node.geometry;
  if(g.type==='box')return boxHit(g,origin,direction);
  if(g.type==='ellipsoid')return ellipsoidHit(g,origin,direction);
  if(g.type==='cylinder')return cylinderHit(g,origin,direction);
  if(g.type==='extrude')return extrudeHit(g,origin,direction);
  throw new Error('Unknown canonical geometry '+g.type);
}
function pointBounds(points){if(!points.length)return null;return {min:[0,1,2].map(i=>Math.min(...points.map(p=>p[i]))),max:[0,1,2].map(i=>Math.max(...points.map(p=>p[i])))};}
export function localBounds(node){
  if(node.kind==='part'){
    const g=node.geometry;
    if(g.type==='box')return {min:[...g.min],max:[...g.max]};
    if(g.type==='ellipsoid')return {min:sub(g.center,g.radii),max:add(g.center,g.radii)};
    if(g.type==='cylinder'){
      const a=normalize(g.axis),extent=a.map(v=>Math.abs(v)*g.length/2+g.radius*Math.sqrt(Math.max(0,1-v*v)));
      return {min:sub(g.center,extent),max:add(g.center,extent)};
    }
    if(g.type==='extrude'){const {u,v,n}=axisBasis(g.axis);return pointBounds(g.points.flatMap(p=>g.range.map(t=>add(add(scale(u,p[0]),scale(v,p[1])),scale(n,t)))));}
  }
  if(node.kind==='layer'){
    if(boundAppearance(node))return null;
    let x0=node.width,y0=node.height,x1=0,y1=0;
    for(let i=0;i<node.pixels.length;i++)if(node.pixels[i]!==null){const x=i%node.width,y=Math.floor(i/node.width);x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x+1);y1=Math.max(y1,y+1);}
    if(x1===0)return null;
    return pointBounds([x0,x1].flatMap(x=>[y0,y1].map(y=>add(scale(node.basis.u,x*node.pixelSize),scale(node.basis.v,y*node.pixelSize)))));
  }
  return null;
}
export function containsLocal(node,p,tolerance=0){
  if(node.kind==='layer')return boundAppearance(node)?false:layerPixel(node,p,tolerance)!==null;
  if(node.kind!=='part')return false;const g=node.geometry;
  if(g.type==='box')return p.every((v,i)=>v>=g.min[i]-tolerance&&v<=g.max[i]+tolerance);
  if(g.type==='ellipsoid')return p.reduce((s,v,i)=>s+((v-g.center[i])/Math.max(EPS,g.radii[i]+tolerance))**2,0)<=1;
  const {u,v,n}=axisBasis(g.axis),q=g.center?sub(p,g.center):p,uv=[dot(q,u),dot(q,v)],height=dot(q,n);
  if(g.type==='cylinder')return Math.abs(height)<=g.length/2+tolerance&&dot(uv,uv)<=(g.radius+tolerance)**2;
  if(g.type==='extrude'){
    if(height<g.range[0]-tolerance||height>g.range[1]+tolerance)return false;
    const inside=polygonContains(uv,g.points);if(tolerance===0)return inside;
    let distance=Infinity;
    for(let i=0;i<g.points.length;i++){const a=g.points[i],b=g.points[(i+1)%g.points.length],edge=sub(b,a),delta=sub(uv,a),t=Math.max(0,Math.min(1,dot(delta,edge)/dot(edge,edge)));distance=Math.min(distance,Math.hypot(...sub(uv,add(a,scale(edge,t)))));}
    return tolerance<0?inside&&distance>=-tolerance:inside||distance<=tolerance;
  }
  return false;
}
export function surfaceSamples(node){
  if(node.kind==='layer'){
    if(boundAppearance(node))return [];
    const samples=[],step=Math.max(1,Math.ceil(node.pixels.length/128));
    for(let i=0;i<node.pixels.length;i+=step)if(node.pixels[i]!==null)samples.push(add(scale(node.basis.u,(i%node.width+0.5)*node.pixelSize),scale(node.basis.v,(Math.floor(i/node.width)+0.5)*node.pixelSize)));
    return samples;
  }
  if(node.kind!=='part')return [];const g=node.geometry;
  if(g.type==='box'){
    const axis=g.min.map((lo,i)=>[lo,(lo+g.max[i])/2,g.max[i]]),out=[];
    for(let x=0;x<3;x++)for(let y=0;y<3;y++)for(let z=0;z<3;z++)if(x!==1||y!==1||z!==1)out.push([axis[0][x],axis[1][y],axis[2][z]]);return out;
  }
  if(g.type==='ellipsoid'){
    const out=[];for(const x of [-1,0,1])for(const y of [-1,0,1])for(const z of [-1,0,1])if(x||y||z){const v=normalize([x,y,z]);out.push(add(g.center,v.map((v,i)=>v*g.radii[i])));}return out;
  }
  const {u,v,n}=axisBasis(g.axis);
  if(g.type==='cylinder'){
    const out=[];for(const h of [-g.length/2,0,g.length/2]){for(let i=0;i<16;i++){const a=i*Math.PI/8;out.push(add(g.center,add(add(scale(u,g.radius*Math.cos(a)),scale(v,g.radius*Math.sin(a))),scale(n,h))));}if(h!==0)out.push(add(g.center,scale(n,h)));}return out;
  }
  const points=g.points.flatMap((p,i)=>[p,p.map((x,k)=>(x+g.points[(i+1)%g.points.length][k])/2)]);
  return points.flatMap(p=>[g.range[0],(g.range[0]+g.range[1])/2,g.range[1]].map(t=>add(add(scale(u,p[0]),scale(v,p[1])),scale(n,t))));
}

/** Exact support point for the supported solid primitives, in local coordinates. */
export function supportLocal(node,d){
  if(node.kind==='part'){
    const g=node.geometry;
    if(g.type==='box')return d.map((v,i)=>v>=0?g.max[i]:g.min[i]);
    if(g.type==='ellipsoid'){const denominator=Math.hypot(...d.map((v,i)=>v*g.radii[i]));return denominator>0?g.center.map((v,i)=>v+g.radii[i]**2*d[i]/denominator):[...g.center];}
    const {u,v,n}=axisBasis(g.axis),du=dot(d,u),dv=dot(d,v),dn=dot(d,n);
    if(g.type==='cylinder'){const radial=Math.hypot(du,dv),a=radial?g.radius*du/radial:0,b=radial?g.radius*dv/radial:0;return add(g.center,add(add(scale(u,a),scale(v,b)),scale(n,(dn>=0?1:-1)*g.length/2)));}
    if(g.type==='extrude'){let best=g.points[0];for(const p of g.points)if(p[0]*du+p[1]*dv>best[0]*du+best[1]*dv)best=p;return add(add(scale(u,best[0]),scale(v,best[1])),scale(n,dn>=0?g.range[1]:g.range[0]));}
  }
  if(node.kind==='layer'){
    if(boundAppearance(node))return null;
    const u=node.basis.u,v=node.basis.v,du=dot(d,u),dv=dot(d,v);let best=null,value=-Infinity;
    for(let i=0;i<node.pixels.length;i++)if(node.pixels[i]!==null){const x=i%node.width+(du>=0?1:0),y=Math.floor(i/node.width)+(dv>=0?1:0),p=add(scale(u,x*node.pixelSize),scale(v,y*node.pixelSize)),n=dot(p,d);if(n>value){value=n;best=p;}}
    return best;
  }
  return null;
}
