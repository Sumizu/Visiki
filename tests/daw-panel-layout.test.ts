import assert from 'node:assert/strict';
import test from 'node:test';
import {DAW_PANEL_DEFAULTS,dawPanelBounds,resolveDawPanelLayout} from '../src/daw/panel-layout';

test('panel preferences fall back safely when storage is invalid',() => {
  const viewport={width:1600,height:952};
  for (const value of [undefined,null,[],42,'invalid']) {
    assert.deepEqual(resolveDawPanelLayout(value,viewport),DAW_PANEL_DEFAULTS);
  }
  assert.deepEqual(resolveDawPanelLayout({head:NaN,inspector:'400',mixer:Infinity},viewport),DAW_PANEL_DEFAULTS);
});

test('panel preferences are rounded and constrained to usable limits',() => {
  assert.deepEqual(resolveDawPanelLayout({head:1000,inspector:-1,mixer:900},{width:1600,height:1000}),{
    head:320,inspector:235,mixer:420,
  });
  assert.deepEqual(resolveDawPanelLayout({head:188.4,inspector:291.8,mixer:229.6},{width:1600,height:1000}),{
    head:188,inspector:292,mixer:230,
  });
});

test('window resizing preserves at least 130 pixels for the audio roll',() => {
  const preferred={head:320,inspector:460,mixer:420};
  const narrow=resolveDawPanelLayout(preferred,{width:700,height:800});
  assert.equal(narrow.head,140);
  assert.equal(narrow.inspector,424);
  assert.equal(700-narrow.head-narrow.inspector-6,130);
  assert.deepEqual(preferred,{head:320,inspector:460,mixer:420});
  assert.deepEqual(resolveDawPanelLayout(preferred,{width:1600,height:1000}),preferred);
});

test('individual width handles use the opposite pane to bound the drag',() => {
  const layout={head:270,inspector:310,mixer:230};
  assert.deepEqual(dawPanelBounds('head',layout,{width:700,height:900}),{min:140,max:254});
  assert.deepEqual(dawPanelBounds('inspector',layout,{width:700,height:900}),{min:235,max:294});
});

test('mixer uses the measured toolbar and transport space when available',() => {
  const layout={head:188,inspector:292,mixer:420};
  assert.equal(resolveDawPanelLayout(layout,{width:1200,height:750,mixerSpace:281.8}).mixer,281);
  assert.deepEqual(dawPanelBounds('mixer',layout,{width:1200,height:750,mixerSpace:281.8}),{min:170,max:281});
  assert.equal(resolveDawPanelLayout(layout,{width:1200,height:750,mixerSpace:500}).mixer,420);
});

test('short windows constrain the mixer and hidden windows keep a valid remembered layout',() => {
  const preferred={head:240,inspector:340,mixer:420};
  assert.equal(resolveDawPanelLayout(preferred,{width:1080,height:620}).mixer,265);
  assert.deepEqual(resolveDawPanelLayout(preferred,{width:0,height:0}),preferred);
  assert.deepEqual(resolveDawPanelLayout(preferred,{width:300,height:350,mixerSpace:40}),{
    head:140,inspector:235,mixer:170,
  });
});
