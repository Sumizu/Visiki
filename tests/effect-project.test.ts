import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProject, makeLayer } from '../src/default-project';
import { activeLayerEffects, cloneEffects, COLOR_EFFECT_PRESETS, EFFECT_DEFINITIONS, makeEffect, MAX_LAYER_EFFECTS, resetEffect, validateLayerEffects } from '../src/effects';
import { validateProject } from '../src/project-io';
import { moveLayer } from '../src/layer-timing';
import { splitVideoLayer, trimVideoLayer, stretchVideoLayer, setVideoRate, resizeProjectDuration } from '../src/video-timing';
import type { MediaAsset } from '../src/types';

test('old projects keep absent effect stacks; ordered effects and all color looks roundtrip independently', () => {
  const original=createDefaultProject();assert.deepEqual(validateProject(structuredClone(original)),original);
  assert.ok(original.layers.every(layer=>!Object.hasOwn(layer,'effects')));
  for(const type of ['background','image','text','lyrics','atmosphere','particles'] as const) {
    const project=createDefaultProject();const layer=makeLayer(type);layer.effects=EFFECT_DEFINITIONS.map(item=>makeEffect(item.type));project.layers=[layer];
    assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))).layers,[layer]);
    for(const preset of COLOR_EFFECT_PRESETS) {
      layer.effects[0].params={...preset.params};assert.deepEqual(validateProject(project).layers[0].effects,layer.effects);
    }
  }
  assert.deepEqual(validateLayerEffects([]),[]);
});

test('project boundary rejects malformed effects, duplicate IDs, unknown parameters, limits and invalid clocks', () => {
  const base=makeEffect('film');
  for(const value of [null,{},'film',Array.from({length:MAX_LAYER_EFFECTS+1},()=>makeEffect('film')),[base,base], [{...base,id:''}], [{...base,type:'audio'}], [{...base,enabled:1}], [{...base,strength:-1}], [{...base,strength:NaN}], [{...base,strength:1.01}], [{...base,params:[]}], [{...base,params:{unknown:1}}]]) assert.throws(()=>validateLayerEffects(value),/效果/);
  for(const def of EFFECT_DEFINITIONS) for(const control of def.controls) {
    const effect=makeEffect(def.type);
    for(const raw of [control.min-1,control.max+1,Infinity,'0',true,...(control.integer?[1.5]:[])]) assert.throws(()=>validateLayerEffects([{...effect,params:{[control.key]:raw}}]),/效果/);
  }
  const partial={...makeEffect('color'),params:{exposure:1}};assert.equal(validateLayerEffects([partial])[0].params.contrast,1);
  const project=createDefaultProject();
  for(const value of [NaN,Infinity,'0',7201]) assert.throws(()=>validateProject({...project,layers:[{...project.layers[0],effectTimeOffset:value}]}),/效果/);
});

test('disabled, zero-strength and neutral effects bypass without losing configured stack order', () => {
  const effects=EFFECT_DEFINITIONS.map(item=>makeEffect(item.type));
  assert.deepEqual(activeLayerEffects(effects).map(item=>item.type),['film','rgb-split','glitch','crt','audio-reactive','fade']);
  effects[0].params.saturation=0;
  assert.deepEqual(activeLayerEffects(effects).map(item=>item.type),effects.map(item=>item.type));
  assert.deepEqual(activeLayerEffects(effects.map(effect=>({...effect,enabled:false}))),[]);
  assert.deepEqual(activeLayerEffects(effects.map(effect=>({...effect,strength:0}))),[]);
  const film=makeEffect('film');for(const key of ['grain','faded','vignette','flicker','scratches'])film.params[key]=0;
  const rgb={...makeEffect('rgb-split'),params:{offset:0}};
  const glitch={...makeEffect('glitch'),params:{amount:0,colorShift:30}};
  const crt={...makeEffect('crt'),params:{scanlines:0,vignette:0,curvature:0,flicker:0}};
  assert.deepEqual(activeLayerEffects([film,rgb,glitch,crt]),[]);
});

test('copied effects have fresh IDs and independent parameters; reset retains identity', () => {
  const original=EFFECT_DEFINITIONS.map(item=>makeEffect(item.type));const copy=cloneEffects(original);
  assert.equal(new Set([...original,...copy].map(effect=>effect.id)).size,2*EFFECT_DEFINITIONS.length);
  copy[0].params.exposure=2;assert.equal(original[0].params.exposure,0);
  assert.equal(resetEffect(copy[0]).id,copy[0].id);assert.deepEqual(resetEffect(copy[0]).params,original[0].params);
  assert.deepEqual(activeLayerEffects(),[]);
});

test('move, trim, split, rate and duration edits retain effects and continuous split clocks', () => {
  const asset:MediaAsset={id:crypto.randomUUID(),type:'video',name:'test.mp4',url:'/api/assets/video',duration:20,fps:30,width:1280,height:720};
  const layer={...makeLayer('video'),start:2,end:12,effectTimeOffset:1,params:{videoId:asset.id,sourceIn:2,sourceOut:12,playbackRate:1,reverse:false},effects:[makeEffect('film')]};
  const moved=moveLayer(layer,6,30);assert.deepEqual(moved.effects,layer.effects);assert.equal(moved.effectTimeOffset,1);
  const [left,right]=splitVideoLayer(layer,6,asset)!;
  assert.equal(right.effectTimeOffset,5);assert.notEqual(right.effects![0].id,left.effects![0].id);assert.deepEqual(right.effects![0].params,left.effects![0].params);
  right.effects![0].params.grain=1;assert.equal(left.effects![0].params.grain,.18);
  assert.equal((6-layer.start)+layer.effectTimeOffset,(6-right.start)+right.effectTimeOffset!);
  const trimmed=trimVideoLayer(layer,'start',4,asset);assert.equal(trimmed.effectTimeOffset,3);assert.deepEqual(trimmed.effects,layer.effects);
  for(const edit of [trimVideoLayer(layer,'end',10,asset),stretchVideoLayer(layer,'end',15,asset),setVideoRate(layer,2,asset)])assert.deepEqual(edit.effects,layer.effects);
  const project={...createDefaultProject(),videos:[asset],layers:[layer]};
  assert.deepEqual(resizeProjectDuration(project,8).layers[0].effects,layer.effects);
  assert.deepEqual(validateProject(project).layers[0].effects,layer.effects);
});
