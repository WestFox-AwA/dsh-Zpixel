import test from 'node:test';
import assert from 'node:assert/strict';
import {guide, WORKFLOW} from '../src/guides.mjs';
import {createScene, ZPixelError} from '../src/scene.mjs';

test('workflow names only the standalone zpixel seven-tool family', () => {
  for (const name of ['zpixel_scene', 'zpixel_render', 'zpixel_inspect', 'zpixel_normalmap', 'zpixel_export', 'zpixel_guide', 'zpixel_theme']) {
    assert.ok(WORKFLOW.includes(name), `WORKFLOW must name ${name}`);
  }
  assert.ok(!/pixel_asset|pixel_edit|Pixel Drawer/i.test(WORKFLOW));
});

test('painting guide carries a runnable 4x4 layer createScene example', () => {
  // guides.mjs is a template-literal module, so a template syntax error fails the import above.
  const result = guide('painting');
  assert.equal(result.topic, 'painting');
  const text = result.text;
  assert.ok(!text.includes('${'), 'guide must not contain an unexpanded template expression');
  assert.match(text, /unlit/);
  assert.match(text, /no solid geometry/);

  const callLine = text.split('\n').find(line => line.startsWith('zpixel_scene('));
  assert.ok(callLine, 'painting guide must include a zpixel_scene create call');
  assert.ok(callLine.endsWith(')'));
  const args = Function(`return (${callLine.slice('zpixel_scene('.length, -1)})`)();
  assert.equal(args.action, 'create');
  assert.equal(args.document, 'plot');
  const input = args.scene;
  assert.equal(input.width, 16);
  assert.equal(input.height, 16);
  assert.deepEqual(input.camera, {preset: 'top_down', target: [2, 0, -2], pixelsPerUnit: 4});
  assert.deepEqual(input.palette, {grass: '#4f7a3a'});
  const layerInput = input.nodes.find(node => node.id === 'plot');
  assert.ok(layerInput, 'example must define the painted layer node');
  assert.equal(layerInput.kind, 'layer');
  assert.equal(layerInput.parent, 'root');
  assert.equal(layerInput.width, 4);
  assert.equal(layerInput.height, 4);
  assert.equal(layerInput.pixelSize, 1);
  assert.deepEqual(layerInput.basis, {u: [1, 0, 0], v: [0, 0, -1]});
  assert.equal(layerInput.pixels.length, 16);
  assert.equal(layerInput.pixels.filter(pixel => pixel === null).length, 14);
  assert.deepEqual(layerInput.pixels.filter(pixel => pixel !== null), ['grass', 'grass']);

  const scene = createScene({...input, id: args.document});
  const layer = scene.nodes.find(node => node.id === 'plot');
  assert.equal(layer.pixels.length, 16);
  assert.deepEqual(layer.basis, {u: [1, 0, 0], v: [0, 0, -1]});
  assert.equal(layer.pixels[0], 'grass');
  assert.equal(layer.pixels.filter(pixel => pixel === null).length, 14);
  assert.ok(!('geometry' in layer), 'a painted layer must not gain solid geometry');
});

test('colored light rejection stays white-only with neutral current wording', () => {
  assert.throws(
    () => createScene({id: 'colored-light', lights: [{id: 'warm', type: 'directional', color: '#ff0000'}]}),
    error => {
      assert.ok(error instanceof ZPixelError);
      assert.equal(error.code, 'UNSUPPORTED_LIGHT_COLOR');
      assert.match(error.message, /Only white light colors are supported\./);
      assert.ok(!/Version\s+0\.1|v0\.1/i.test(error.message));
      return true;
    }
  );
  assert.equal(createScene({id: 'white-light'}).lights[0].color, '#ffffff');
});
