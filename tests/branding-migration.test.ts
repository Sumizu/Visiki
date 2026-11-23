import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProject } from '../src/default-project';
import { validateProject } from '../src/project-io';

test('Visiki creates its new format and reads legacy projects without losing editable content', () => {
  const current = createDefaultProject();
  assert.equal(current.format, 'visiki-project');
  const legacy = structuredClone(current);
  legacy.format = 'echo-demo';
  legacy.title = '旧工程';
  legacy.lyrics = [{ time: 0, text: '原文', translation: 'Translation' }];
  const before = structuredClone(legacy);
  const migrated = validateProject(legacy);
  assert.equal(migrated.format, 'visiki-project');
  assert.equal(migrated.title, legacy.title);
  assert.equal(migrated.duration, legacy.duration);
  assert.deepEqual(migrated.lyrics, legacy.lyrics);
  assert.deepEqual(migrated.layers.map(layer => layer.id), legacy.layers.map(layer => layer.id));
  assert.deepEqual(validateProject(migrated), migrated);
  assert.deepEqual(legacy, before);
  assert.throws(() => validateProject({ ...current, format: 'unrelated-document' }));
});
