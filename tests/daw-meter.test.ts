import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceDawMeter, createDawMeterState, gainToMeterDb, meterDbToUnit, measureDawSamples, measureDawChannels } from '../src/daw/meter';

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-5, `${a} ≈ ${b}`);
test('meter measures actual signed peaks and RMS energy, retaining overloads', () => {
  const reading = measureDawSamples(new Float32Array([-2, 0, 1, 0]));
  assert.equal(reading.peak, 2); close(reading.rms, Math.sqrt(5 / 4));
  assert.deepEqual(measureDawSamples(new Float32Array()), { peak: 0, rms: 0 });
  assert.deepEqual(measureDawSamples(new Float32Array([NaN, Infinity])), { peak: 0, rms: 0 });
});

test('decibel display gives quiet signals useful height and clamps only visual geometry', () => {
  close(gainToMeterDb(.1), -20); close(gainToMeterDb(.01), -40);
  close(meterDbToUnit(gainToMeterDb(.01)), 1 / 3);
  assert.equal(gainToMeterDb(0), -60); assert.equal(gainToMeterDb(NaN), -60);
  assert.equal(meterDbToUnit(-100), 0); assert.equal(meterDbToUnit(6), 1);
  close(gainToMeterDb(2), 6.020599913);
});

test('stereo levels retain opposite phases and hard-panned peaks instead of summing channels', () => {
  assert.deepEqual(measureDawChannels([new Float32Array([.5, -.5]), new Float32Array([-.5, .5])]), { peak: .5, rms: .5 });
  const hardLeft = measureDawChannels([new Float32Array([.5, -.5]), new Float32Array([0, 0])]);
  assert.equal(hardLeft.peak, .5); close(hardLeft.rms, .5 / Math.sqrt(2));
  assert.deepEqual(measureDawChannels([]), { peak: 0, rms: 0 });
});

test('peak attacks immediately, falls at a controlled rate, and holds a readable maximum', () => {
  let state = advanceDawMeter(createDawMeterState(), { peak: 1, rms: .5 }, 0);
  assert.equal(state.peakDb, 0); assert.equal(state.holdDb, 0);
  state = advanceDawMeter(state, { peak: .001, rms: .001 }, 100);
  close(state.peakDb, -3); assert.equal(state.holdDb, 0);
  close(state.rmsDb, gainToMeterDb(.5) - 2);
  state = advanceDawMeter(state, undefined, 1250);
  close(state.holdDb, -5);
  state = advanceDawMeter(state, undefined, 5000);
  assert.equal(state.peakDb, -60); assert.equal(state.rmsDb, -60); assert.equal(state.holdDb, -60);
});

test('meter decay depends on elapsed time, and clipping is latched briefly for readability', () => {
  const initial = advanceDawMeter(createDawMeterState(), { peak: 1.2, rms: .8 }, 100);
  assert.equal(initial.clipUntil, 1300);
  let many = initial;
  for (let t = 200; t <= 900; t += 100) many = advanceDawMeter(many, undefined, t);
  const once = advanceDawMeter(initial, undefined, 900);
  close(many.peakDb, once.peakDb); close(many.rmsDb, once.rmsDb); close(many.holdDb, once.holdDb);
  assert.equal(once.clipUntil, 1300);
  const backwards = advanceDawMeter(once, undefined, 800);
  assert.equal(backwards.peakDb, once.peakDb);
});
