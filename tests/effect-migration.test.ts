import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLayer, createDefaultProject } from '../src/default-project';
import { makeEffect, MAX_LAYER_EFFECTS, validateAudioEffects, effectSupportsTarget } from '../src/effects';
import { migrateLegacyFade } from '../src/effect-migration';
import { validateProject } from '../src/project-io';
import { textTransitionAtTime } from '../src/text-transition';
import { lyricTransitionAtTime } from '../src/lyric-style';
import { atmosphereDefaults, atmosphereFade } from '../src/atmosphere';
import { fadeAtTime } from '../src/fade-effect';

test('legacy title and text transitions become editable effects without applying both envelopes', () => {
  for (const type of ['title', 'text'] as const) for (const mode of ['fade','fade-up','fade-down','fade-left','fade-right','fade-zoom']) {
    const layer = makeLayer(type); layer.start=2;layer.end=3;
    layer.params={...layer.params,textTransition:mode,textTransitionDuration:1,fontSize:66};
    const migrated=migrateLegacyFade(layer);
    assert.equal(migrated.params.textTransition,'none');assert.equal(migrated.effects?.length,1);
    for (const time of [2,2.1,2.4,2.5,2.7,2.99]) {
      const before=textTransitionAtTime(layer,time),after=fadeAtTime(migrated.effects![0],layer.start,layer.end,time);
      for (const key of ['opacity','offsetX','offsetY','scale'] as const)assert.ok(Math.abs(after[key]-before[key])<1e-10, `${type} ${mode} ${key}`);
    }
    assert.equal(migrateLegacyFade(migrated),migrated);
  }
});

test('legacy lyric fades retain per-cue timing while atmosphere edges keep their asymmetric durations', () => {
  const layer=makeLayer('lyrics');layer.params={...layer.params,mode:'bilingual',transition:'fade-up',transitionDuration:.35};
  const migrated=migrateLegacyFade(layer),effect=migrated.effects![0];
  assert.equal(effect.params.timing,1);assert.equal(migrated.params.transition,'none');
  const cues=[{time:1,end:2,text:'test'}];
  for(const time of [1,1.1,1.5,1.9]) {
    const before=lyricTransitionAtTime(cues,0,time,30,'fade-up',.35),after=fadeAtTime(effect,1,2,time);
    assert.ok(Math.abs(before.alpha-after.opacity)<1e-10);
    assert.ok(Math.abs(before.offsetY-after.offsetY)<1e-10);
  }
  const atmosphere={...makeLayer('atmosphere'),effects:undefined,params:{...atmosphereDefaults(),fadeIn:2,fadeOut:1},start:2,end:3};
  const upgraded=migrateLegacyFade(atmosphere);
  assert.equal(upgraded.params.fadeIn,0);assert.equal(upgraded.params.fadeOut,0);
  for(const time of [2,2.1,2.5,2.8,2.99])assert.ok(Math.abs(atmosphereFade(atmosphere,time)-fadeAtTime(upgraded.effects![0],2,3,time).opacity)<1e-10);
});

test('migration is save/reopen stable, leaves full old stacks intact and avoids implicit atmosphere double fades', () => {
  const project=createDefaultProject();const layer=makeLayer('text');layer.params.textTransition='fade-down';project.layers=[layer];
  const upgraded=validateProject(project);assert.equal(upgraded.layers[0].effects!.length,1);
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(upgraded))),upgraded);
  const full={...layer,effects:Array.from({length:MAX_LAYER_EFFECTS},()=>makeEffect('film'))};
  assert.equal(migrateLegacyFade(full),full);assert.equal(validateProject({...project,layers:[full]}).layers[0].params.textTransition,'fade-down');
  const atmosphere=makeLayer('atmosphere');atmosphere.params={};
  const result=validateProject({...project,layers:[atmosphere]}).layers[0];
  assert.equal(result.effects!.length,1);assert.equal(result.params.fadeIn,0);assert.equal(result.params.fadeOut,0);
});

test('audio effects serialize independently, only accept envelopes, and enforce the same stack limits', () => {
  assert.ok(effectSupportsTarget('fade','audio'));assert.ok(effectSupportsTarget('audio-reactive','visual'));
  assert.equal(effectSupportsTarget('audio-reactive','audio'),false);
  const project={...createDefaultProject(),audioEffects:[makeEffect('fade')]};
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))).audioEffects,project.audioEffects);
  assert.deepEqual(validateAudioEffects([]),[]);
  for(const type of ['color','film','crt','audio-reactive'] as const)assert.throws(()=>validateAudioEffects([makeEffect(type)]),/主音轨/);
  for(const value of [null,{},[project.audioEffects[0],project.audioEffects[0]],Array.from({length:9},()=>makeEffect('fade'))])assert.throws(()=>validateAudioEffects(value),/效果/);
  assert.throws(()=>validateProject({...project,audioEffects:[makeEffect('film')]}),/主音轨/);
  const music={id:'song',name:'test',type:'audio',url:'/api/assets/song',duration:NaN};
  assert.throws(()=>validateProject({...project,audio:music}),/音乐素材时长/);
});
