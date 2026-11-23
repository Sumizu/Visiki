import test from 'node:test';
import assert from 'node:assert/strict';
import type { AudioAnalysis } from '../src/types';
import { makeLayer, createDefaultProject } from '../src/default-project';
import { validateProject } from '../src/project-io';
import { clearSpectrumSignalCache, createSpectrumPeakSampler, sampleSpectrumPeak, sampleSpectrumSignal, spectrumSignalCacheStats } from '../src/spectrum-signal';

function source(peaks: Float32Array, hopSec = 1 / 30): AudioAnalysis {
  const bands=new Float32Array(64).fill(.6);
  return {peaks,hopSec,frames:Array(peaks.length).fill(bands),bands:64,waveform:new Float32Array(1),sampleRate:48000,duration:(peaks.length-1)*hopSec};
}
test('signal interpolation is continuous at frame knots, seek-independent and flat at song boundaries', () => {
  const a=source(Float32Array.from({length:151},(_,i)=>i%6===0?.9:.1));
  const once=sampleSpectrumSignal(a,1.523,.7);
  for(const time of [3,0,4.5,.1,2])sampleSpectrumSignal(a,time,.7);
  assert.deepEqual(sampleSpectrumSignal(a,1.523,.7),once);
  const sample=createSpectrumPeakSampler(a,.7),eps=1e-5;
  for(let frame=10;frame<50;frame++) {
    const time=frame*a.hopSec,left=(sample(time)-sample(time-eps))/eps,right=(sample(time+eps)-sample(time))/eps;
    assert.ok(Math.abs(left-right)<.02,'value and velocity do not jump at FFT hops');
  }
  assert.equal(sample(0),0);assert.equal(sample(a.duration),0);
  assert.ok(sample(a.duration-1e-6)<1e-7);
  for(const t of [-1,NaN,Infinity,a.duration+1])assert.equal(sampleSpectrumPeak(a,t),0);
  assert.equal(sampleSpectrumSignal(null,2).level,0);
});
test('greater smoothing damps fast peak alternation without normalizing quiet music to loud music', () => {
  const a=source(Float32Array.from({length:151},(_,i)=>i%2?.95:.05));
  const variation=(smooth:number)=>{
    let total=0,previous=sampleSpectrumPeak(a,1,smooth);
    for(let n=1;n<=240;n++){const v=sampleSpectrumPeak(a,1+n/120,smooth);total+=Math.abs(v-previous);previous=v;}
    return total;
  };
  assert.ok(variation(1)<variation(0)*.7);
  const quiet=source(new Float32Array(151).fill(.03)),loud=source(new Float32Array(151).fill(.8));
  assert.ok(sampleSpectrumPeak(loud,2)>sampleSpectrumPeak(quiet,2)*20);
  assert.equal(sampleSpectrumSignal(source(new Float32Array(151)),2).level,0);
});

test('first-interval transients and sub-hop audio remain visible without a discontinuous entrance', () => {
  const a = source(Float32Array.from([.9, 0, 0, 0, 0, 0, 0]));
  const sample = createSpectrumPeakSampler(a, .6);
  assert.equal(sample(0), 0);
  assert.ok(sample(a.hopSec / 2) > .1, 'the first source interval contributes during the first hop');
  assert.ok(sample(a.hopSec) > sample(a.hopSec * 3), 'the initial transient decays after its attack');
  const short = { ...source(Float32Array.from([.8, 0])), duration: .012 };
  const shortSample = createSpectrumPeakSampler(short, .6);
  assert.ok(shortSample(.006) > .05, 'audio shorter than one analysis hop is not omitted');
  assert.equal(shortSample(0), 0); assert.equal(shortSample(short.duration), 0);
  assert.ok(shortSample(short.duration - 1e-7) < 1e-7);
  const single = { ...short, peaks: Float32Array.from([.8]) };
  assert.ok(sampleSpectrumPeak(single, .006, .6) > .05, 'a peak cache without the trailing sentinel is accepted');
});

test('one hundred differently smoothed layers do not reprocess source peaks on each playback frame', () => {
  clearSpectrumSignalCache();
  const peaks = new Float32Array(3001).fill(.7), a = source(peaks);
  let reads = 0;
  Object.defineProperty(a, 'peaks', { get() { reads++; return peaks; } });
  const smoothing = Array.from({ length: 100 }, (_, n) => n / 100);
  for (const value of smoothing) sampleSpectrumPeak(a, 2, value);
  const before = reads;
  for (const value of smoothing) sampleSpectrumPeak(a, 2 + 1 / 60, value);
  assert.ok(reads - before <= 200, 'cache hits only inspect metadata, not the full song');
  assert.equal(spectrumSignalCacheStats().entries, 100);
});
test('bounded weak-identity caches reuse peak samplers and do not retain unbounded smoothing variants', () => {
  clearSpectrumSignalCache();
  const a=source(new Float32Array(100001).fill(.7));
  const sample=createSpectrumPeakSampler(a,.6),expected=sample(1.3);
  for(let n=0;n<140;n++)sampleSpectrumPeak(a,2,n/140);
  const stats=spectrumSignalCacheStats();assert.ok(stats.entries<=128);assert.ok(stats.bytes<=128*1024*1024);
  assert.equal(sample(1.3),expected);
  const long=source(new Float32Array(300001).fill(.5));
  for(const time of [.1,100,9999.9])assert.ok(Number.isFinite(sampleSpectrumPeak(long,time,.6)));
  assert.ok(spectrumSignalCacheStats().bytes<=128*1024*1024);
  clearSpectrumSignalCache();assert.equal(spectrumSignalCacheStats().bytes,0);
});
test('curve controls roundtrip and reject malformed values while absent controls remain absent', () => {
  const p=createDefaultProject(),layer=makeLayer('spectrum');p.layers=[layer];
  assert.deepEqual(validateProject(p).layers[0],layer);
  Object.assign(layer.params,{mode:'wave',flowSpeed:1.7,smoothing:.81,lineWidth:3.2,envelopeWindow:2.4});
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(p))).layers,[layer]);
  for(const [key,values] of Object.entries({flowSpeed:[-1,3.1,'1'],smoothing:[-.1,1.1,true],lineWidth:[0,8.1,NaN],envelopeWindow:[0,4.1,Infinity]})) {
    for(const value of values)assert.throws(()=>validateProject({...p,layers:[{...layer,params:{...layer.params,[key]:value}}]}),/频谱|图层参数/);
  }
});
