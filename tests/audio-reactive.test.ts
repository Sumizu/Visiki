import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudio } from '../src/audio-analysis';
import { audioBandWeights, audioReactiveAtTime, audioReactiveCacheStats, clearAudioReactiveCache } from '../src/audio-reactive';
import type { AudioAnalysis, LayerEffect, LayerParams } from '../src/types';
import { renderScene } from '../src/scene';
import type { DemoProject, Layer, SceneResources } from '../src/types';

const effect = (params: LayerParams = {}): LayerEffect => ({ id: 'reactive-test', type: 'audio-reactive', enabled: true, strength: 1,
  params: { band: 0, sensitivity: 1, threshold: 0, attack: 0, release: 0, scale: .2, brightness: .3, opacity: .4, ...params } });
function analysis(sequence: number[] = [1, 1, 1, 1]): AudioAnalysis {
  return { sampleRate: 48000, duration: sequence.length * .1, hopSec: .1, bands: 64,
    frames: sequence.map(value => new Float32Array(64).fill(value)), peaks: Float32Array.from(sequence), waveform: Float32Array.from(sequence) };
}
const base = { level: 0, scale: 1, brightness: 1, opacity: 1 };

test('missing/muted/out-of-source music leaves the component exactly unchanged', () => {
  const source = analysis(); const e = effect();
  assert.deepEqual(audioReactiveAtTime(e, null, .1), base);
  assert.deepEqual(audioReactiveAtTime(e, source, .1, { muted: true }), base);
  assert.deepEqual(audioReactiveAtTime(e, source, .1, { gain: 0 }), base);
  assert.deepEqual(audioReactiveAtTime(e, source, .1, { audioEnd: .1 }), base);
  for (const time of [-1, source.duration, 100, NaN, Infinity]) assert.deepEqual(audioReactiveAtTime(e, source, time), base);
  assert.deepEqual(audioReactiveAtTime({ ...e, enabled: false }, source, .1), base);
  assert.deepEqual(audioReactiveAtTime({ ...e, strength: 0 }, source, .1), base);
  assert.deepEqual(audioReactiveAtTime(e, analysis([0, 0]), .1), base);
});

test('Hz selection uses real sample rate and excludes ranges above Nyquist', () => {
  const audible = audioBandWeights(8000, 64, 35, 250);
  assert.ok(audible.some(value => value > 0));
  assert.ok(audioBandWeights(8000, 64, 4001, 16000).every(value => value === 0));
  assert.notDeepEqual(audioBandWeights(48000, 64, 220, 400), audioBandWeights(8000, 64, 220, 400));
  assert.deepEqual(audioBandWeights(48000, 64, 400, 220), audioBandWeights(48000, 64, 220, 400));
  assert.equal(audioBandWeights(48000, 5000, 20, 20000).length, 0);
});

test('real FFT bass, midrange and treble tones only drive the selected frequency range', async () => {
  const sampleRate = 48000;
  for (const [frequency, matchingBand] of [[100, 1], [1000, 2], [8000, 3]]) {
    const signal = Float32Array.from({ length: sampleRate / 2 }, (_, i) => .8 * Math.sin(i / sampleRate * frequency * Math.PI * 2));
    const source = await analyzeAudio({ sampleRate, numberOfChannels: 1, length: signal.length,
      getChannelData: () => signal } as unknown as AudioBuffer);
    const matched = audioReactiveAtTime(effect({ band: matchingBand }), source, .25).level;
    assert.ok(matched > .1, `a ${frequency} Hz tone should drive its frequency band`);
    for (const other of [1, 2, 3].filter(band => band !== matchingBand)) {
      assert.ok(audioReactiveAtTime(effect({ band: other }), source, .25).level < matched * .025,
        `a ${frequency} Hz tone must not drive unrelated band ${other}`);
    }
    const custom = audioReactiveAtTime(effect({ band: 4, lowHz: frequency * .8, highHz: frequency * 1.2 }), source, .25).level;
    assert.ok(custom > .1);
  }
});

test('quiet linear amplitude stays quiet instead of becoming a full-strength normalized beat', () => {
  const loud = audioReactiveAtTime(effect(), analysis([1, 1]), .1).level;
  // The fixed -72 dB analysis display maps -20 dB amplitude to 52/72.
  const quiet = audioReactiveAtTime(effect(), analysis([52 / 72, 52 / 72]), .1).level;
  assert.ok(quiet > .099 && quiet < .101); assert.ok(loud > quiet * 9);
  assert.equal(audioReactiveAtTime(effect({ threshold: .2 }), analysis([52 / 72, 52 / 72]), .1).level, 0);
});

test('attack and release smooth in song time and requests may arrive in any order', () => {
  clearAudioReactiveCache();
  const source = analysis([0, 0, 1, 1, 1, 0, 0, 0, 0]); const e = effect({ attack: .12, release: .3 });
  const first = audioReactiveAtTime(e, source, .2).level;
  const second = audioReactiveAtTime(e, source, .3).level;
  const fallen = audioReactiveAtTime(e, source, .5).level;
  assert.ok(first > 0 && first < second && second < 1); assert.ok(fallen > 0 && fallen < audioReactiveAtTime(e, source, .4).level);
  const snapshot = audioReactiveAtTime(e, source, .375);
  for (const time of [.8, 0, .6, .2, .1]) audioReactiveAtTime(e, source, time);
  assert.deepEqual(audioReactiveAtTime(e, source, .375), snapshot);
  assert.equal(audioReactiveCacheStats().builds, 1, 'seeking never rescans the whole song');
});

test('continuous interpolation prevents a 30 Hz staircase at 60 fps and export subranges', () => {
  const source = analysis([0, 1, 0]); const e = effect();
  assert.ok(Math.abs(audioReactiveAtTime(e, source, .05).level - .5) < 1e-6);
  assert.ok(Math.abs(audioReactiveAtTime(e, source, .15).level - .5) < 1e-6);
  assert.deepEqual(audioReactiveAtTime(e, source, .15), audioReactiveAtTime(e, source, .15), 'absolute song seconds are sufficient; no clip-relative clock');
});

test('strength, audio fade gain and visual amounts are independent and do not mutate source geometry', () => {
  const source = analysis(); const e = effect();
  const state = audioReactiveAtTime({ ...e, strength: .5 }, source, .1, { gain: .5 });
  assert.equal(state.level, .25); assert.equal(state.scale, 1.05); assert.equal(state.brightness, 1.075); assert.equal(state.opacity, .9);
  const copy = structuredClone(e); audioReactiveAtTime(e, source, .1); assert.deepEqual(e, copy);
  const noVisualAmount = audioReactiveAtTime(effect({ scale: 0, brightness: 0, opacity: 0 }), source, .1);
  assert.deepEqual(noVisualAmount, { ...base, level: 1 });
});

test('bounded envelope cache reuses signal data when only visual amounts change', () => {
  clearAudioReactiveCache(); const source = analysis();
  audioReactiveAtTime(effect(), source, .1);
  audioReactiveAtTime(effect({ scale: .5, brightness: 1, opacity: 1 }), source, .1);
  assert.equal(audioReactiveCacheStats().builds, 1);
  for (let index = 0; index < 35; index++) audioReactiveAtTime(effect({ attack: index / 40 }), source, .1);
  const stats = audioReactiveCacheStats(); assert.ok(stats.entries <= 16); assert.ok(stats.bytes <= 4194304);
  clearAudioReactiveCache(); assert.deepEqual(audioReactiveCacheStats(), { entries: 0, samples: 0, bytes: 0, builds: 0 });
});

test('malformed caches and nonfinite user controls cannot produce NaN transforms', () => {
  for (const source of [{ ...analysis(), hopSec: 0 }, { ...analysis(), sampleRate: NaN }, { ...analysis(), bands: 8000 }])
    assert.deepEqual(audioReactiveAtTime(effect(), source, .1), base);
  const e = effect({ sensitivity: Infinity, attack: NaN, lowHz: NaN, highHz: Infinity, band: 4, scale: NaN, brightness: Infinity, opacity: NaN });
  const state = audioReactiveAtTime(e, analysis([NaN, Infinity, 0]), .1);
  assert.ok(Object.values(state).every(Number.isFinite));
});

test('very long music uses a bounded envelope and retains its final sample', () => {
  clearAudioReactiveCache();
  const count = 300001; const zero = new Float32Array(64);
  const source: AudioAnalysis = { sampleRate: 48000, duration: count * .1, hopSec: .1, bands: 64,
    frames: Array(count).fill(zero), peaks: new Float32Array(0), waveform: new Float32Array(0) };
  source.frames[count - 1] = new Float32Array(64).fill(1);
  const e = effect();
  assert.equal(audioReactiveAtTime(e, source, 0).level, 0);
  assert.ok(audioReactiveCacheStats().samples <= 262144);
  assert.equal(audioReactiveAtTime(e, source, (count - 1) * .1).level, 1);
  assert.equal(audioReactiveCacheStats().builds, 1);
});

test('neutral temporal effects bypass isolation before allocating a stage canvas', () => {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');let allocations=0,painted=0;
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>{allocations++;throw new Error('neutral effect allocated an isolation canvas');}}});
  try {
    const noop=():void=>{};
    const ctx={canvas:{width:320,height:180},save:noop,restore:noop,setTransform:noop,fillRect:noop,translate:noop,rotate:noop,
      beginPath:noop,rect:noop,clip:noop,measureText:(text:string)=>({width:text.length*10}),fillText:()=>painted++} as unknown as CanvasRenderingContext2D;
    const layer:Layer={id:'text',type:'text',name:'text',x:160,y:90,width:200,height:60,rotation:0,opacity:1,visible:true,locked:false,start:0,end:4,params:{text:'HHHH',fontSize:20}};
    const audio={id:'audio',name:'audio.wav',type:'audio' as const,url:'/qa.wav',duration:4};
    const project:DemoProject={format:'echo-demo',version:1,width:320,height:180,fps:24,duration:4,title:'',artist:'',audio,cover:null,lyrics:[],lyricsOffsetMs:0,layers:[layer]};
    const source=analysis(Array(40).fill(1));
    const fade:LayerEffect={id:'fade',type:'fade',enabled:true,strength:1,params:{fadeIn:.5,fadeOut:.5,style:0,curve:0,timing:0,distance:24}};
    const cases:Array<[DemoProject,SceneResources,number]>=[
      [{...project,audio:null},{cover:null,analysis:source},1],
      [{...project,audioMuted:true},{cover:null,analysis:source},1],
      [project,{cover:null,analysis:null},1],
      [{...project,audioEffects:[fade]},{cover:null,analysis:source},0],
    ];
    for(const [p,res,time]of cases){layer.effects=[effect()];renderScene(ctx,p,time,res);}
    layer.effects=[fade];renderScene(ctx,project,2,{cover:null,analysis:source});
    layer.type='lyrics';layer.params.mode='scroll';layer.effects=[{...fade,params:{...fade.params,timing:1}}];renderScene(ctx,project,.1,{cover:null,analysis:source});
    assert.equal(allocations,0);assert.equal(painted,5);
  } finally {if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}
});
