import test from 'node:test';
import assert from 'node:assert/strict';
import { compressorTransfer, deesserResponse, deesserLimitDb, delayEvents, saturationTransfer } from '../src/daw/effect-graph-math';

const near = (actual: number, expected: number, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
test('compressor mixes linear dry and makeup-adjusted wet levels', () => {
  near(compressorTransfer(-12, -18, 3, 0, 6, 0), -12);
  near(compressorTransfer(-12, -18, 3, 0, 6, 100), -10);
  near(compressorTransfer(-12, -18, 3, 0, 6, 50), -12 + 20 * Math.log10((1 + 10 ** (2 / 20)) / 2));
  near(compressorTransfer(-18, -18, 2, 6, 0, 100), -18.375);
});
test('deesser uses native bandwidth Q and digital phase in split limit', () => {
  const center = deesserResponse(6500, 6500, 1, 48000);
  near(center.q, 1 / (2 * Math.sinh(Math.log(2) / 2)));
  near(Math.hypot(center.re, center.im), 1);
  near(deesserLimitDb(6500, 6500, 1, 48000, 6, 100, true), -6);
  near(deesserLimitDb(300, 6500, 1, 48000, 6, 100, false), -6);
  near(deesserLimitDb(6500, 6500, 1, 48000, 6, 0, true), 0);
  assert.notEqual(deesserResponse(8000, 6500, 1, 44100).re, deesserResponse(8000, 6500, 1, 96000).re);
  near(deesserResponse(12000, 14000, 4, 24000).hz, 11400);
});
test('first delay echo survives zero feedback and ping-pong alternates timed sides', () => {
  const plain = delayEvents(100, 200, 0, 50, false, 2);
  assert.deepEqual(plain.map(e => e.amplitude), [.5, 0, .5, 0]);
  const ping = delayEvents(100, 200, 50, 40, true, 3);
  assert.deepEqual(ping.map(e => [e.side, e.time, e.amplitude]), [['L', 100, .4], ['R', 300, .2], ['L', 400, .1]]);
});
test('saturation reflects each native shape, bias, mix, output gain', () => {
  near(saturationTransfer(.5, 0, 0, 0, 100, 0), .5 - .5 ** 3 / 3);
  near(saturationTransfer(.5, 0, 0, 1, 100, 0), Math.tanh(.5));
  near(saturationTransfer(.5, 6, .5, 2, 100, 0), .5);
  near(saturationTransfer(.5, 6, .5, 2, 0, 6), .5 * 10 ** (6 / 20));
  near(saturationTransfer(0, 12, .4, 1, 100, 0), 0);
});
