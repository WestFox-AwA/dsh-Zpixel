/** Right-handed affine math. Scene semantics: +Y up, ground XZ, asset forward -Z. */
export const identity=()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
export const add=(a,b)=>a.map((v,i)=>v+b[i]);
export const sub=(a,b)=>a.map((v,i)=>v-b[i]);
export const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
export const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const normalize=a=>{const n=Math.hypot(...a);return n>1e-12?a.map(v=>v/n):[0,0,0];};
export function multiply(a,b){const out=Array(16).fill(0);for(let c=0;c<4;c++)for(let r=0;r<4;r++)for(let k=0;k<4;k++)out[c*4+r]+=a[k*4+r]*b[c*4+k];return out;}
export const point=(m,p)=>[m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]];
export const vector=(m,p)=>[m[0]*p[0]+m[4]*p[1]+m[8]*p[2],m[1]*p[0]+m[5]*p[1]+m[9]*p[2],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]];
export function inverse(m){const a=Array.from({length:4},(_,r)=>[...Array.from({length:4},(_,c)=>m[c*4+r]),...Array.from({length:4},(_,c)=>r===c?1:0)]);for(let c=0;c<4;c++){let p=c;for(let r=c+1;r<4;r++)if(Math.abs(a[r][c])>Math.abs(a[p][c]))p=r;if(Math.abs(a[p][c])<1e-12)throw new Error('Transform is singular. Use nonzero scales.');[a[c],a[p]]=[a[p],a[c]];const d=a[c][c];for(let j=0;j<8;j++)a[c][j]/=d;for(let r=0;r<4;r++)if(r!==c){const f=a[r][c];for(let j=0;j<8;j++)a[r][j]-=f*a[c][j];}}return Array.from({length:16},(_,i)=>a[i%4][4+Math.floor(i/4)]);}
export const normal=(inv,n)=>normalize([inv[0]*n[0]+inv[1]*n[1]+inv[2]*n[2],inv[4]*n[0]+inv[5]*n[1]+inv[6]*n[2],inv[8]*n[0]+inv[9]*n[1]+inv[10]*n[2]]);
export function axisVector(value='y'){
  const names={x:[1,0,0],y:[0,1,0],z:[0,0,1],'-x':[-1,0,0],'-y':[0,-1,0],'-z':[0,0,-1]};
  const v=typeof value==='string'?names[value]:value;
  if(!Array.isArray(v)||v.length!==3||!v.every(Number.isFinite)||Math.hypot(...v)<1e-10)throw new Error('Axis must be x, y, z, a negative axis name, or a nonzero 3-vector.');
  return normalize(v);
}
export function axisBasis(axis='y'){
  const n=axisVector(axis),seed=Math.abs(n[0])<0.95?[1,0,0]:[0,0,1];
  const u=normalize(sub(seed,n.map(v=>v*dot(seed,n))));
  return {u,v:normalize(cross(n,u)),n};
}
export function rotationAround(axis,degrees){
  const [x,y,z]=axisVector(axis),a=degrees*Math.PI/180,c=Math.cos(a),s=Math.sin(a),t=1-c;
  return [t*x*x+c,t*x*y+s*z,t*x*z-s*y,0,t*x*y-s*z,t*y*y+c,t*y*z+s*x,0,t*x*z+s*y,t*y*z-s*x,t*z*z+c,0,0,0,0,1];
}
export function rotationBetween(from,to){
  const a=axisVector(from),b=axisVector(to),c=Math.max(-1,Math.min(1,dot(a,b)));
  if(c>1-1e-12)return identity();
  if(c<-1+1e-12)return rotationAround(axisBasis(a).u,180);
  return rotationAround(cross(a,b),Math.acos(c)*180/Math.PI);
}
export function compose(t={}){
  if(t.matrix)return [...t.matrix];
  const p=t.position??[0,0,0],q=t.pivot??[0,0,0],s=t.scale??[1,1,1],[x,y,z]=t.rotation??[0,0,0];
  const tr=v=>{const m=identity();m[12]=v[0];m[13]=v[1];m[14]=v[2];return m;};
  const scale=[s[0],0,0,0,0,s[1],0,0,0,0,s[2],0,0,0,0,1];
  return multiply(multiply(multiply(tr(add(p,q)),multiply(rotationAround('z',z),multiply(rotationAround('y',y),rotationAround('x',x)))),scale),tr(q.map(v=>-v)));
}
export function worldTransforms(scene){
  const nodes=new Map(scene.nodes.map(n=>[n.id,n])),out=new Map(),visiting=new Set();
  const visit=id=>{if(out.has(id))return out.get(id);if(visiting.has(id))throw new Error('Cycle in scene graph.');const n=nodes.get(id);if(!n)throw new Error('Unknown parent '+id);visiting.add(id);const m=n.parent?multiply(visit(n.parent),compose(n.transform)):compose(n.transform);visiting.delete(id);out.set(id,m);return m;};
  for(const n of scene.nodes)visit(n.id);return out;
}
export function cameraBasis(input){
  const c=input.camera??input,target=c.target,direction=normalize(sub(target,c.position));
  const baseRight=normalize(cross(direction,c.up));
  if(Math.hypot(...direction)<0.9||Math.hypot(...baseRight)<0.9)throw new Error('Camera position/target/up must define a nondegenerate view.');
  const down=normalize(cross(direction,baseRight)),right=c.mirrorX?baseRight.map(v=>-v):baseRight;
  return {target:[...target],position:[...c.position],right,down,direction,pixelsPerUnit:c.pixelsPerUnit,center:[...c.center]};
}
