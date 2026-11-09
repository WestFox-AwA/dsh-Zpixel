import { add, dot } from './math.mjs';

// A one-pixel stroke is a morphological operation on each node's own projected
// alpha, then a depth-composited image effect. It is never shadow geometry.
const NEIGHBORS = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
const DEPTH_EPSILON = 1e-6;

// An outline stroke replaces the sampled color, so it also clears the
// appearance provenance that would otherwise claim the pixel.
function withoutAppearance(hit) {
  delete hit.appearanceNodeId;
  delete hit.appearancePixel;
  delete hit.appearanceShading;
  return hit;
}

/**
 * The geometry pass records a self-visible projection mask for each outlined
 * leaf before scene occlusion. Painted overlays do not punch holes in the
 * underlying part's silhouette. Only an actually visible boundary pixel may
 * emit a stroke, so fully hidden parts cannot leak a halo over foreground.
 */
export function compositeOutlines(hits, rgba, width, height, context, resolveColor) {
  const base = hits.slice();
  const strokes = new Map();
  const camera = context.camera;
  const order = new Map(context.prepared.map((entry, index) => [entry.id,index]));
  let clipped = false;

  function propose(index, sourceIndex, direction, depth) {
    const source = base[sourceIndex], underlying = base[index];
    // Depth is geometric; a rear line cannot paint through a nearer surface.
    if (underlying && underlying.depth < depth - DEPTH_EPSILON) return;
    const previous = strokes.get(index);
    if (previous) {
      if (previous.depth < depth - DEPTH_EPSILON) return;
      if (Math.abs(previous.depth-depth) <= DEPTH_EPSILON) {
        // Preserve the destination's own inner border at equal depth, then
        // use stable scene ordering for coincident external strokes.
        if (previous.direction === 'inside' && direction === 'outside') return;
        if (previous.direction === direction && order.get(previous.source.nodeId) <= order.get(source.nodeId)) return;
      }
    }
    strokes.set(index,{source,sourceIndex,direction,depth});
  }

  function externalDepth(source, dx, dy) {
    // Extend the boundary's local tangent plane to the neighboring camera
    // ray. Raw depth copying would let a rear line jump in front on slopes.
    const shift = add(camera.right.map(v=>v*dx/camera.pixelsPerUnit),camera.down.map(v=>v*dy/camera.pixelsPerUnit));
    const denominator = dot(source.normal,camera.direction);
    if (Math.abs(denominator) < 1e-8) return source.depth;
    return source.depth-dot(source.normal,shift)/denominator;
  }

  for (let index=0; index<base.length; index++) {
    const source=base[index];
    if (!source || !source._entry.outline.enabled) continue;
    const entry=source._entry,mask=entry.projectedMask;
    if (!mask) continue;
    const direction=entry.outline.direction??'inside';
    const x=index%width,y=Math.floor(index/width);
    let boundary=false;
    for(const [dx,dy] of NEIGHBORS){
      const nx=x+dx,ny=y+dy;
      const outside=nx<0||ny<0||nx>=width||ny>=height;
      if (!outside && mask[ny*width+nx]) continue;
      boundary=true;
      if(direction!=='outside') continue;
      if(outside){clipped=true;continue;}
      propose(ny*width+nx,index,'outside',externalDepth(source,dx,dy));
    }
    if(boundary && direction==='inside') propose(index,index,'inside',source.depth);
  }

  let expandedPixels=0;
  for(const [index,stroke] of strokes){
    const {source,sourceIndex,direction,depth}=stroke;
    const color=resolveColor(source._entry.outline.color??'ink',context.scene);
    const bytes=[parseInt(color.slice(1,3),16),parseInt(color.slice(3,5),16),parseInt(color.slice(5,7),16),255];
    const underlying=base[index];
    rgba.set(bytes,index*4);
    if(direction==='inside'){
      hits[index]=withoutAppearance({...underlying,color,outlineReason:'inside',outlineDirection:'inside',outlineSourcePixel:[index%width,Math.floor(index/width)]});
    }else{
      if(!underlying) expandedPixels++;
      hits[index]=withoutAppearance({...source,position:null,normal:null,depth,color,shadowBy:[],outlineReason:'outside',outlineDirection:'outside',outlineSourcePixel:[sourceIndex%width,Math.floor(sourceIndex/width)],geometryNodeId:underlying?.nodeId??null});
    }
  }
  context.stats.outlined=strokes.size;
  context.stats.outsidePixels=expandedPixels;
  if(clipped) context.warnings.push('An outside outline reaches the image edge and is clipped. Leave at least one transparent pixel of padding.');
  if(context.prepared.some(entry=>!entry.appearanceBound&&entry.outline.occlusion===false)) context.warnings.push('Legacy outline.occlusion:false does not suppress part boundaries. Use outline.enabled:false to disable a part outline.');
}
