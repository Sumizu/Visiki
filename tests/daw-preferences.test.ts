import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DAW_PREFERENCES, parseDawPreferences } from '../src/daw/preferences';
import { DAW_GRID_DIVISIONS } from '../src/daw/grid-division';

test('old or invalid preference storage keeps the current time ruler and pause/resume behavior', () => {
  for (const value of [null, [], 'time', 42, { rulerUnit: 'frames', restartMode: 'stop', snapEnabled: 'false' }]) {
    assert.deepEqual(parseDawPreferences(value), DEFAULT_DAW_PREFERENCES);
  }
});

test('snap targets can be disabled individually without losing the master off state on reload', () => {
  const chosen = { ...DEFAULT_DAW_PREFERENCES, snapEnabled: false, snapGrid: false, snapCursor: false, rulerUnit: 'bars', restartMode: 'from-cursor' };
  assert.deepEqual(parseDawPreferences(JSON.parse(JSON.stringify(chosen))), chosen);
  assert.deepEqual(parseDawPreferences({ snapEdges: false }), { ...DEFAULT_DAW_PREFERENCES, snapEdges: false });
  assert.equal(DEFAULT_DAW_PREFERENCES.snapEdges, true, 'loading settings must not change the defaults for a new profile');
});

test('every supported grid division survives preference persistence independently from ruler and snap settings', () => {
  for (const option of DAW_GRID_DIVISIONS) {
    const chosen = { ...DEFAULT_DAW_PREFERENCES, gridDivision: option.value, rulerUnit: 'bars', snapEnabled: false };
    assert.deepEqual(parseDawPreferences(JSON.parse(JSON.stringify(chosen))), chosen);
  }
});

test('older preferences and invalid grid divisions migrate to auto without resetting other choices', () => {
  for (const gridDivision of [undefined, null, '', '1/3', 'quarter', 16, {}, []]) {
    const result = parseDawPreferences({ gridDivision, rulerUnit: 'bars', restartMode: 'from-cursor', snapEnabled: false });
    assert.equal(result.gridDivision, 'auto');
    assert.equal(result.rulerUnit, 'bars');
    assert.equal(result.restartMode, 'from-cursor');
    assert.equal(result.snapEnabled, false);
  }
});
