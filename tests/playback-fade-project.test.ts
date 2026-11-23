import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLayer, createDefaultProject } from '../src/default-project';
import { validateProject } from '../src/project-io';

test('background rate/reverse and independent title/text fades survive save and reopen without changing track spans', () => {
  const project = createDefaultProject();
  const background = makeLayer('background'), title = makeLayer('title'), text = makeLayer('text');
  project.videos = [{ type: 'video', id: 'local-bg', name: '背景.mp4', url: '/api/assets/local-bg', duration: 1.013, width: 320, height: 180, fps: 30 }];
  Object.assign(background.params, { backgroundType: 'video', videoId: 'local-bg', playbackRate: 2.5, reverse: true, videoLoop: false });
  Object.assign(title.params, { textTransition: 'fade-left', textTransitionDuration: .75 });
  Object.assign(text.params, { textTransition: 'fade-zoom', textTransitionDuration: 3 });
  project.layers = [background, title, text];
  const restored = validateProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(restored.layers[0],background);
  for(const [index,style,duration] of [[1,3,.75],[2,5,3]]) {
    const layer=restored.layers[index];assert.equal(layer.effects!.length,1);
    assert.equal(layer.effects![0].params.style,style);
    assert.equal(layer.effects![0].params.fadeIn,duration);assert.equal(layer.effects![0].params.fadeOut,duration);
    const {effects,...base}=layer;
    assert.deepEqual(base,{...project.layers[index],params:{...project.layers[index].params,textTransition:'none'}});
  }
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(restored))),restored);
  const legacy = structuredClone(project);
  for (const layer of legacy.layers) {
    delete layer.params.playbackRate; delete layer.params.reverse;
    delete layer.params.textTransition; delete layer.params.textTransitionDuration;
  }
  assert.deepEqual(validateProject(legacy).layers, legacy.layers, 'legacy projects need no new mandatory fields');
});

test('background clocks and text fades reject malformed settings instead of loading an invalid project', () => {
  for (const [key, values] of Object.entries({ playbackRate: [0, .09, 8.1, '2'], reverse: ['true', 1] })) {
    for (const value of values) {
      const p = createDefaultProject(), background = makeLayer('background'); p.layers = [background];
      background.params[key] = value; assert.throws(() => validateProject(p), key + '=' + value);
    }
  }
  for (const type of ['text', 'title'] as const) {
    for (const [key, values] of Object.entries({ textTransition: ['spin', true, 1], textTransitionDuration: [0, .049, 3.01, '1'] })) {
      for (const value of values) {
        const p = createDefaultProject(), layer = makeLayer(type); p.layers = [layer];
        layer.params[key] = value; assert.throws(() => validateProject(p), type + ':' + key + '=' + value);
      }
    }
  }
});
