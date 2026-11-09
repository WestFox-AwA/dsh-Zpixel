import test from 'node:test';
import assert from 'node:assert/strict';
import {createScene,applyOperations} from '../src/scene.mjs';
import {compileWorld} from '../src/world.mjs';
import {renderScene} from '../src/renderer.mjs';

const group=(id,visible,parent)=>({id,kind:'group',visible,...(parent?{parent}:{})});
const part=(id,parent)=>({id,kind:'part',parent,geometry:{type:'box',min:[0,0,0],max:[2,1,2]}});
const build=nodes=>createScene({id:'visibility',width:16,height:16,camera:{preset:'top_down',target:[0,0,0],pixelsPerUnit:4},nodes});
const render=scene=>renderScene(scene,{mode:'beauty'});
const pixels=(scene,id)=>render(scene).hits.filter(hit=>hit?.nodeId===id).length;
const effective=(scene,id)=>compileWorld(scene).entries.get(id).visible;
const order=scene=>scene.nodes.map(node=>node.id);

test('parent visibility inheritance is independent of serialized node order',()=>{
  const open=build([part('child','root'),group('hidden',true)]);
  assert.equal(pixels(open,'child'),64);
  const reparented=applyOperations(open,[{op:'node_reparent',id:'child',parent:'hidden'}]);
  assert.equal(pixels(reparented,'child'),64);
  const hidden=applyOperations(reparented,[{op:'node_set',id:'hidden',values:{visible:false}}]);
  assert.deepEqual(order(hidden),['root','child','hidden']);
  assert.equal(effective(hidden,'child'),false);
  assert.equal(pixels(hidden,'child'),0);
  assert.equal(render(hidden).stats.visiblePixels,0);
  const reordered=build([group('hidden',false),part('child','hidden')]);
  assert.deepEqual(order(reordered),['root','hidden','child']);
  assert.equal(effective(reordered,'child'),false);
  assert.equal(render(reordered).stats.visiblePixels,0);
});

test('effective visibility follows every ancestor, not only the immediate parent',()=>{
  const hiddenTop=build([part('child','middle'),group('middle',true,'top'),group('top',false)]);
  assert.deepEqual(order(hiddenTop),['root','child','middle','top']);
  assert.equal(effective(hiddenTop,'middle'),false);
  assert.equal(effective(hiddenTop,'child'),false);
  assert.equal(render(hiddenTop).stats.visiblePixels,0);
  const reversed=build([group('top',false),group('middle',true,'top'),part('child','middle')]);
  assert.deepEqual(order(reversed),['root','top','middle','child']);
  assert.equal(effective(reversed,'child'),false);
  assert.equal(render(reversed).stats.visiblePixels,0);
});
