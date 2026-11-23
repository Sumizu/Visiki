import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDawBars, getDawGrid, getDawGridLines, getDawMusicalTiming, snapDawTime } from '../src/daw/timeline-interactions';
import { DAW_GRID_DIVISIONS } from '../src/daw/grid-division';

test('time grid stays readable, becomes finer monotonically, and reaches subsecond ticks', () => {
  let previousMajor = Infinity;
  let previousMinor = Infinity;
  for (let scale = 4; scale <= 250; scale++) {
    const grid = getDawGrid(scale);
    assert.ok(grid.majorStep * scale >= 90 - 1e-9);
    assert.ok(grid.majorStep * scale <= 225 + 1e-9);
    assert.ok(grid.minorStep * scale >= 18 - 1e-9);
    assert.ok(grid.minorStep * scale <= 45 + 1e-9);
    assert.ok(grid.majorStep <= previousMajor);
    assert.ok(grid.minorStep <= previousMinor);
    assert.ok(Math.abs(grid.majorStep / grid.minorStep - Math.round(grid.majorStep / grid.minorStep)) < 1e-8);
    assert.equal(grid.snapStep, grid.minorStep);
    previousMajor = grid.majorStep;
    previousMinor = grid.minorStep;
  }
  assert.deepEqual(getDawGrid(250), { majorStep: .5, minorStep: .1, snapStep: .1 });
  assert.equal(getDawGrid(4).minorStep, 5);
});

test('time grid guards invalid scale and honors supported zoom limits', () => {
  for (const scale of [NaN, Infinity, -5, 0]) assert.deepEqual(getDawGrid(scale), getDawGrid(35));
  assert.deepEqual(getDawGrid(1), getDawGrid(4));
  assert.deepEqual(getDawGrid(500), getDawGrid(250));
});

test('grid lines keep ruler and lane positions aligned while rendering only the viewport', () => {
  const lines = getDawGridLines({ scale: 250, left: 720, width: 960, totalSeconds: 3600 });
  assert.ok(lines.length < 45);
  assert.equal(lines[0].time, 2.7);
  for (const line of lines) {
    assert.equal(line.x, line.time * 250);
    assert.equal(line.major, Math.abs(line.time * 2 - Math.round(line.time * 2)) < 1e-8);
  }
  assert.ok(lines.some(line => line.time === 3 && line.major));
  assert.ok(lines.some(line => line.time === 3.1 && !line.major));
});

test('grid lines stop at the project extent and handle empty or invalid viewport values', () => {
  const lines = getDawGridLines({ scale: 100, left: 0, width: 800, totalSeconds: 2.3 });
  assert.equal(lines[0].time, 0);
  assert.ok(lines.every(line => line.time <= 2.3));
  assert.deepEqual(getDawGridLines({ scale: 35, left: 10000, width: 800, totalSeconds: 60 }), []);
  assert.deepEqual(getDawGridLines({ scale: 35, left: 0, width: 0, totalSeconds: 60 }), []);
  assert.deepEqual(getDawGridLines({ scale: 35, left: NaN, width: Infinity, totalSeconds: 60 }), []);
});

const options = { scale: 100, enabled: true, gridStep: .2, targets: [] };

test('cursor snaps only inside the pixel tolerance rather than quantizing every position', () => {
  assert.deepEqual(snapDawTime(2.249, options), { time: 2.2, snapped: true, label: '时间网格', kind: 'grid' });
  assert.deepEqual(snapDawTime(2.3, options), { time: 2.3, snapped: false, label: null, kind: null });
  assert.equal(snapDawTime(2.28, options).snapped, true);
  assert.equal(snapDawTime(2.281, options).snapped, false);
});

test('clip edges and playhead win against the grid within tolerance; closest edge wins', () => {
  const result = snapDawTime(2.205, { ...options, targets: [
    { time: 2.26, label: '游标' }, { time: 2.24, label: '人声片尾' }, { time: 2.3, label: '远处片段' },
  ] });
  assert.deepEqual(result, { time: 2.24, snapped: true, label: '人声片尾', kind: 'edge' });
  assert.equal(snapDawTime(2.205, { ...options, targets: [{ time: 2.3, label: '远处片段' }] }).kind, 'grid');
});

test('exactly equidistant edges preserve target order for deterministic feedback', () => {
  const result = snapDawTime(2, { ...options, targets: [{ time: 1.95, label: '第一条' }, { time: 2.05, label: '第二条' }] });
  assert.equal(result.time, 1.95);
  assert.equal(result.label, '第一条');
});

test('Shift bypass and disabled snap retain the unquantized pointer position', () => {
  for (const state of [{ enabled: false }, { bypass: true }]) {
    assert.deepEqual(snapDawTime(2.205, { ...options, ...state, targets: [{ time: 2.21, label: '片段' }] }), {
      time: 2.205, snapped: false, label: null, kind: null,
    });
  }
});

test('snap tolerance remains the same pixel distance at different zooms', () => {
  for (const scale of [4, 35, 100, 250]) {
    const target = 10;
    assert.equal(snapDawTime(target + 7.9 / scale, { ...options, scale, gridStep: NaN, targets: [{ time: target, label: '片段' }] }).snapped, true);
    assert.equal(snapDawTime(target + 8.1 / scale, { ...options, scale, gridStep: NaN, targets: [{ time: target, label: '片段' }] }).snapped, false);
  }
});

test('snap rejects invalid targets and grid steps without returning invalid or negative time', () => {
  const invalid = { ...options, gridStep: 0, targets: [{ time: NaN, label: '坏数据' }, { time: -1, label: '负数' }] };
  assert.deepEqual(snapDawTime(2.25, invalid), { time: 2.25, snapped: false, label: null, kind: null });
  for (const time of [-1, NaN, Infinity]) {
    assert.equal(snapDawTime(time, options).time, 0);
    assert.equal(snapDawTime(time, { ...options, enabled: false }).time, 0);
  }
  assert.equal(snapDawTime(2.01, { ...options, tolerancePx: 0 }).snapped, false);
  assert.equal(snapDawTime(2, { ...options, tolerancePx: 0 }).snapped, true);
});

test('bar labels use quarter-note BPM and the signature denominator for 4/4, 3/4 and 6/8', () => {
  assert.equal(formatDawBars(0), '1.1');
  assert.equal(formatDawBars(.5), '1.2');
  assert.equal(formatDawBars(2), '2.1');
  const triple = { bpm: 120, beatsPerBar: 3, beatUnit: 4 };
  assert.equal(getDawMusicalTiming(triple).barSeconds, 1.5);
  assert.equal(formatDawBars(1, triple), '1.3');
  assert.equal(formatDawBars(1.5, triple), '2.1');
  const compound = { bpm: 120, beatsPerBar: 6, beatUnit: 8 };
  assert.equal(getDawMusicalTiming(compound).beatSeconds, .25);
  assert.equal(getDawMusicalTiming(compound).barSeconds, 1.5);
  assert.equal(formatDawBars(.25, compound), '1.2');
  assert.equal(formatDawBars(1.25, compound), '1.6');
  assert.equal(formatDawBars(1.5, compound), '2.1');
  assert.equal(formatDawBars(2, { ...triple, bpm: 60 }), '1.3');
});

test('musical grids stay nested and readable across all supported meters, tempos and zooms', () => {
  for (const bpm of [20, 73, 137.5, 300]) for (let beatsPerBar = 2; beatsPerBar <= 12; beatsPerBar++) for (const beatUnit of [2, 4, 8, 16]) {
    let previousMajor = Infinity, previousMinor = Infinity;
    for (let scale = 4; scale <= 250; scale += 3) {
      const options = { unit: 'bars' as const, bpm, beatsPerBar, beatUnit };
      const grid = getDawGrid(scale, options);
      const { barSeconds } = getDawMusicalTiming(options);
      assert.ok(grid.majorStep * scale >= 90 - 1e-9);
      assert.ok(grid.minorStep * scale >= 18 - 1e-9);
      assert.ok(grid.majorStep <= previousMajor + 1e-9);
      assert.ok(grid.minorStep <= previousMinor + 1e-9);
      assert.ok(Math.abs(grid.majorStep / grid.minorStep - Math.round(grid.majorStep / grid.minorStep)) < 1e-8);
      const barDivision = Math.max(barSeconds, grid.minorStep) / Math.min(barSeconds, grid.minorStep);
      assert.ok(Math.abs(barDivision - Math.round(barDivision)) < 1e-8);
      previousMajor = grid.majorStep; previousMinor = grid.minorStep;
    }
  }
});

test('odd and compound meter grid lines remain aligned far into the project at fractional tempo', () => {
  for (const beatsPerBar of [3, 6, 7]) for (const scale of [4, 35, 250]) {
    const options = { unit: 'bars' as const, bpm: 137, beatsPerBar, beatUnit: 8 };
    const lines = getDawGridLines({ scale, left: 1700 * scale, width: 960, totalSeconds: 3600, ...options });
    const grid = getDawGrid(scale, options);
    assert.ok(lines.length < 60);
    assert.ok(lines.some(line => line.major));
    for (const line of lines) {
      assert.ok(Math.abs(line.time / grid.minorStep - Math.round(line.time / grid.minorStep)) < 1e-7);
      assert.equal(line.x, line.time * scale);
      if (line.major) assert.ok(Math.abs(line.time / grid.majorStep - Math.round(line.time / grid.majorStep)) < 1e-7);
    }
  }
  const grid = { unit: 'bars' as const, bpm: 137, beatsPerBar: 3, beatUnit: 4 };
  const { barSeconds } = getDawMusicalTiming(grid);
  for (const bar of [1, 7, 101, 1001]) assert.equal(formatDawBars(Math.round((bar - 1) * barSeconds * 1e9) / 1e9, grid), `${bar}.1`);
});

test('bar grid snapping uses subdivisions and changing ruler units does not modify elapsed seconds', () => {
  const grid = getDawGrid(250, { unit: 'bars', bpm: 120, beatsPerBar: 3, beatUnit: 4 });
  assert.equal(grid.majorStep, .5);
  assert.equal(grid.minorStep, .125);
  const snapped = snapDawTime(1.49, { scale: 250, enabled: true, gridStep: grid.snapStep, targets: [] });
  assert.equal(snapped.time, 1.5);
  assert.equal(formatDawBars(snapped.time, { bpm: 120, beatsPerBar: 3, beatUnit: 4 }), '2.1');
  assert.deepEqual(getDawGrid(35, { unit: 'time', bpm: 90, beatsPerBar: 6, beatUnit: 8 }), getDawGrid(35));
  assert.equal(formatDawBars(NaN), '1.1');
  assert.equal(formatDawBars(-1), '1.1');
});

test('selecting auto preserves both existing ruler algorithms at every zoom', () => {
  for (const unit of ['time', 'bars'] as const) for (const scale of [4, 35, 100, 250]) {
    const options = { unit, bpm: 137, beatsPerBar: 7, beatUnit: 8 };
    assert.deepEqual(getDawGrid(scale, { ...options, gridDivision: 'auto' }), getDawGrid(scale, options));
    assert.deepEqual(getDawGridLines({ scale, left: 800, width: 960, totalSeconds: 3600, ...options, gridDivision: 'auto' }),
      getDawGridLines({ scale, left: 800, width: 960, totalSeconds: 3600, ...options }));
  }
});

test('quarter, eighth and sixteenth note choices follow quarter-note BPM', () => {
  for (const bpm of [90, 120]) for (const [gridDivision, multiplier] of [['1/4', 1], ['1/8', .5], ['1/16', .25]] as const) {
    const grid = getDawGrid(100, { bpm, gridDivision });
    assert.equal(grid.snapStep, 60 / bpm * multiplier);
  }
  assert.equal(getDawGrid(100, { bpm: 120, gridDivision: '1/4' }).snapStep, .5);
  assert.equal(getDawGrid(100, { bpm: 120, gridDivision: '1/8' }).snapStep, .25);
  assert.equal(getDawGrid(100, { bpm: 120, gridDivision: '1/16' }).snapStep, .125);
});

test('fixed note snapping does not change when zoom, ruler units or time signature change', () => {
  for (const option of DAW_GRID_DIVISIONS.filter(option => option.value !== 'auto' && option.value !== 'bar')) {
    const expected = 60 / 137 * 4 / Number(option.value.slice(2));
    for (const scale of [4, 35, 250]) for (const unit of ['time', 'bars'] as const) for (const signature of [{ beatsPerBar: 3, beatUnit: 4 }, { beatsPerBar: 6, beatUnit: 8 }]) {
      const grid = getDawGrid(scale, { bpm: 137, gridDivision: option.value, unit, ...signature });
      assert.equal(grid.snapStep, expected);
      assert.ok(grid.minorStep * scale >= 6 - 1e-9, 'dense subdivisions are thinned only for drawing');
      assert.ok(Math.abs(grid.minorStep / grid.snapStep - Math.round(grid.minorStep / grid.snapStep)) < 1e-9);
    }
  }
});

test('a bar follows the current meter while whole notes retain their musical duration', () => {
  for (const signature of [{ beatsPerBar: 3, beatUnit: 4 }, { beatsPerBar: 6, beatUnit: 8 }]) for (const unit of ['time', 'bars'] as const) {
    const options = { bpm: 120, ...signature, unit };
    assert.equal(getDawGrid(100, { ...options, gridDivision: 'bar' }).snapStep, 1.5);
    assert.equal(getDawGrid(100, { ...options, gridDivision: '1/1' }).snapStep, 2);
  }
  assert.equal(getDawGrid(100, { bpm: 120, beatsPerBar: 4, beatUnit: 4, gridDivision: 'bar' }).snapStep, 2);
});

test('fixed grids retain selected precision when drawing is too dense to show every division', () => {
  const grid = getDawGrid(4, { bpm: 120, gridDivision: '1/64' });
  assert.equal(grid.snapStep, .03125);
  assert.equal(grid.minorStep, 2);
  assert.equal(snapDawTime(1.03, { scale: 4, enabled: true, gridStep: grid.snapStep, targets: [] }).time, 1.03125);
  const lines = getDawGridLines({ scale: 4, left: 0, width: 1000, totalSeconds: 3600, bpm: 120, gridDivision: '1/64' });
  assert.ok(lines.length < 185, 'visible line count is bounded by viewport width, rather than project length');
  assert.ok(lines.some(line => line.major && line.time === 50));
});

test('a seconds ruler keeps exact readable major labels independently from arbitrary-tempo note divisions', () => {
  const options = { scale: 100, unit: 'time' as const, bpm: 137, gridDivision: '1/8' as const, left: 0, width: 960, totalSeconds: 60 };
  const grid = getDawGrid(options.scale, options);
  const lines = getDawGridLines(options);
  assert.equal(grid.majorStep, 1);
  assert.ok(lines.some(line => line.major && line.time === 1));
  assert.ok(lines.some(line => !line.major && Math.abs(line.time - 60 / 137 / 2) < 1e-9));
  for (const line of lines) {
    if (line.major) assert.ok(Math.abs(line.time / grid.majorStep - Math.round(line.time / grid.majorStep)) < 1e-7);
    else assert.ok(Math.abs(line.time / grid.minorStep - Math.round(line.time / grid.minorStep)) < 1e-7);
  }
  assert.equal(lines.filter(line => line.time === 0).length, 1, 'coincident major and minor lines merge');
});

test('whole-note grid and bar ruler preserve different boundaries in three-four time', () => {
  const options = { scale: 100, unit: 'bars' as const, bpm: 120, beatsPerBar: 3, beatUnit: 4, gridDivision: '1/1' as const, left: 0, width: 960, totalSeconds: 60 };
  const lines = getDawGridLines(options);
  assert.ok(lines.some(line => line.major && line.time === 1.5));
  assert.ok(lines.some(line => !line.major && line.time === 2));
  assert.equal(snapDawTime(1.51, { scale: 100, enabled: true, gridStep: getDawGrid(100, options).snapStep, targets: [] }).snapped, false,
    'bar labels do not silently add unselected snap targets');
});

test('manual grids stay aligned and bounded at fractional tempo near the end of a long session', () => {
  for (const unit of ['time', 'bars'] as const) for (const gridDivision of ['1/64', '1/8', '1/1', 'bar'] as const) for (const scale of [4, 35, 250]) {
    const options = { unit, gridDivision, bpm: 137.5, beatsPerBar: 7, beatUnit: 8, scale, left: 3500 * scale, width: 960, totalSeconds: 3600 };
    const grid = getDawGrid(scale, options);
    const lines = getDawGridLines(options);
    assert.ok(lines.length < 185);
    assert.ok(lines.some(line => line.major));
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      assert.ok(line.time <= options.totalSeconds);
      assert.equal(line.x, line.time * scale);
      assert.ok(Math.abs(line.time / (line.major ? grid.majorStep : grid.minorStep) - Math.round(line.time / (line.major ? grid.majorStep : grid.minorStep))) < 1e-7);
      if (index > 0) assert.ok(line.time > lines[index - 1].time + 1e-8, 'no duplicate grid lines');
    }
  }
});
