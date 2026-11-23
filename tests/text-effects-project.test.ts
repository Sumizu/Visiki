import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProject, makeLayer } from '../src/default-project';
import { validateProject } from '../src/project-io';

test('text effects save and reopen independently across text, title and lyrics', () => {
  const project = createDefaultProject();
  project.layers = ['text', 'title', 'lyrics'].map(type => makeLayer(type as 'text' | 'title' | 'lyrics'));
  project.layers.forEach((layer, index) => Object.assign(layer.params, {
    glowEnabled: index !== 1, glowColor: ['#ff4099', '#ddff88', '#a0e8ff'][index],
    glowIntensity: index / 2, glowRadius: index * 20,
    ...(layer.type === 'lyrics' ? { planeYaw: -38, planePerspective: 72 } : {}),
  }));
  const opened = validateProject(JSON.parse(JSON.stringify(project)));
  for (let index = 0; index < project.layers.length; index++) assert.deepEqual(opened.layers[index].params, project.layers[index].params);
  const legacy = validateProject(createDefaultProject());
  assert.equal(legacy.layers.find(layer => layer.type === 'lyrics')!.params.planeYaw, undefined);
  assert.equal(legacy.layers.find(layer => layer.type === 'title')!.params.glowEnabled, undefined);
});

test('invalid perspective and glow parameters cannot enter a saved project', () => {
  for (const [key, value] of Object.entries({ planeYaw: 76, planePerspective: -1, glowEnabled: 'true', glowColor: 'url(x)', glowRadius: 81, glowIntensity: 2.01 })) {
    const project = createDefaultProject();
    const lyrics = project.layers.find(layer => layer.type === 'lyrics')!;
    lyrics.params[key] = value;
    assert.throws(() => validateProject(project), key);
  }
  for (const type of ['text', 'title'] as const) {
    const project = createDefaultProject();
    const layer = makeLayer(type); layer.params.glowIntensity = -1; project.layers = [layer];
    assert.throws(() => validateProject(project), type);
  }
});

test('extended lyric perspective saves and reopens through 300 percent while rejecting out-of-range values', () => {
  for (const perspective of [0, 72, 100, 200, 300]) {
    const project = createDefaultProject();
    const lyrics = project.layers.find(layer => layer.type === 'lyrics')!;
    lyrics.params.planePerspective = perspective;
    const reopened = validateProject(JSON.parse(JSON.stringify(project)));
    assert.equal(reopened.layers.find(layer => layer.type === 'lyrics')!.params.planePerspective, perspective);
  }
  for (const perspective of [-1, 301, Infinity, NaN, '300']) {
    const project = createDefaultProject();
    project.layers.find(layer => layer.type === 'lyrics')!.params.planePerspective = perspective;
    assert.throws(() => validateProject(project), String(perspective));
  }
});
