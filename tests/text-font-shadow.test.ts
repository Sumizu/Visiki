import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProject, makeLayer } from '../src/default-project';
import { collectProjectFonts, normalizeLyricFonts, resolveLyricFontIds } from '../src/fonts';
import { validateProject } from '../src/project-io';
import { clearSceneCache, renderScene } from '../src/scene';
import { wrapTextLines } from '../src/text-layout';
import type { DemoProject, Layer, LayerParams, MediaAsset, SceneResources } from '../src/types';

interface Operation { name: string; args: unknown[]; font?: string; align?: string; color?: string }
function context(operations: Operation[]): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = { canvas: { width: 1920, height: 1080 }, globalAlpha: 1 };
  return new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'measureText') return (text: string) => ({ width: [...text].length * 10 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop: () => {} });
      return (...args: unknown[]) => operations.push({ name: String(key), args, font: String(target.font ?? ''), align: String(target.textAlign ?? ''), color: String(target.fillStyle ?? '') });
    },
    set(target, key, value) { operations.push({ name: `set:${String(key)}`, args: [value] }); target[key] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
}
const resources: SceneResources = { cover: null, analysis: null };
function projectFor(layer: Layer): DemoProject { const project = createDefaultProject(); project.layers = [layer]; return project; }

test('text boxes wrap words, CJK, explicit blank lines and complete emoji clusters', () => {
  assert.deepEqual(wrapTextLines('one two\n\n日本語の歌\n', 35, value => [...value].length * 10), ['one', 'two', '', '日本語', 'の歌', '']);
  assert.deepEqual(wrapTextLines('👨‍👩‍👧‍👦🙂', 1, value => value ? 10 : 0), ['👨‍👩‍👧‍👦', '🙂']);
  assert.deepEqual(wrapTextLines('abcdefgh', 30, value => value.length * 10), ['abc', 'def', 'gh']);
});

test('independent text boxes render their own content and clip wrapped lines to their bounds', () => {
  const layer = makeLayer('text'); layer.width = 30; layer.height = 27;
  layer.params = { ...layer.params, text: 'abcdef\nghi', fontSize: 10, lineHeight: 1.3, fontWeight: 600, align: 'right', fontId: 'klee-one' };
  const project = projectFor(layer); project.title = 'unrelated song title';
  const operations: Operation[] = [];
  renderScene(context(operations), project, 0, resources);
  const rows = operations.filter(operation => operation.name === 'fillText');
  assert.deepEqual(rows.map(row => row.args), [['abc', 15, -13.5], ['def', 15, -.5], ['ghi', 15, 12.5]]);
  assert.ok(rows.every(row => row.align === 'right' && row.font?.startsWith('600 10px "VisikiFont_klee_one"')));
  assert.ok(operations.findIndex(operation => operation.name === 'clip') < operations.findIndex(operation => operation.name === 'fillText'));
  layer.start = 1; operations.length = 0; renderScene(context(operations), project, 0, resources);
  assert.equal(operations.filter(operation => operation.name === 'fillText').length, 0);
  assert.equal(createDefaultProject().layers.some(item => item.type === 'text'), false, 'adding text is explicit, without altering the default composition');
});

test('lyric font migration freezes the previous shared font before independent edits', () => {
  const legacy = { fontId: 'noto-sans-jp', fontSize: 32 };
  const normalized = normalizeLyricFonts(legacy);
  assert.deepEqual(resolveLyricFontIds({ ...normalized, fontId: 'klee-one' }), { original: 'klee-one', translation: 'noto-sans-jp' });
  assert.deepEqual(resolveLyricFontIds(normalizeLyricFonts({})), { original: '', translation: '' });
  assert.equal('translationFontId' in legacy, false, 'normalization never mutates the undo snapshot');
  const layer = makeLayer('lyrics'); layer.params = legacy;
  const reopened = validateProject(projectFor(layer));
  assert.equal(reopened.layers[0].params.translationFontId, 'noto-sans-jp');
  assert.deepEqual(normalizeLyricFonts({ fontId: 'noto-sans-jp', translationFontId: '' }), { fontId: 'noto-sans-jp', translationFontId: '' }, 'explicit system translation font remains independent');
});

test('lyric rendering and export preparation use independent fonts while hidden translations do not load', () => {
  const layer = makeLayer('lyrics'); layer.params = { ...layer.params, fontId: 'noto-sans-jp', translationFontId: 'klee-one', mode: 'bilingual' };
  const project = projectFor(layer); project.lyrics = [{ time: 0, text: '日本語', translation: '译文' }];
  const operations: Operation[] = []; renderScene(context(operations), project, 1, resources);
  const rows = operations.filter(operation => operation.name === 'fillText');
  assert.ok(rows.find(row => row.args[0] === '日本語')?.font?.includes('VisikiFont_noto_sans_jp'));
  assert.ok(rows.find(row => row.args[0] === '译文')?.font?.includes('VisikiFont_klee_one'));
  const text = makeLayer('text'); text.params.fontId = 'yusei-magic'; project.layers.push(text);
  assert.deepEqual(collectProjectFonts(project).map(font => font.id), ['noto-sans-jp', 'klee-one', 'yusei-magic']);
  layer.params.mode = 'single'; layer.params.translationFontId = 'missing-hidden-font';
  assert.deepEqual(collectProjectFonts(project).map(font => font.id), ['noto-sans-jp', 'yusei-magic']);
  layer.params.mode = 'scroll'; project.lyrics[0].translation = '';
  assert.deepEqual(collectProjectFonts(project).map(font => font.id), ['noto-sans-jp', 'yusei-magic']);
  text.params.text = ''; assert.deepEqual(collectProjectFonts(project).map(font => font.id), ['noto-sans-jp']);
});

test('card shadow intensity preserves legacy opacity and zero disables its shadow drawing', () => {
  const layer = makeLayer('image'); layer.params = { imageId: 'source', shadow: true }; const project = projectFor(layer);
  const source = { width: 20, height: 20 } as CanvasImageSource;
  const imageResources = { ...resources, images: new Map([['source', source]]) };
  const operations: Operation[] = []; renderScene(context(operations), project, 0, imageResources);
  assert.deepEqual(operations.find(operation => operation.name === 'set:shadowColor')?.args, [`rgba(8, 10, 22, ${160 / 255})`]);
  layer.params.shadowOpacity = .2; operations.length = 0; renderScene(context(operations), project, 0, imageResources);
  assert.deepEqual(operations.find(operation => operation.name === 'set:shadowColor')?.args, ['rgba(8, 10, 22, 0.2)']);
  layer.params.shadowOpacity = 0; operations.length = 0; renderScene(context(operations), project, 0, imageResources);
  assert.equal(operations.some(operation => operation.name === 'set:shadowColor'), false);
});

test('text, translation fonts, card shadows and video background references survive validation', () => {
  const text = makeLayer('text'); text.params.text = 'ひらがな\n独立文本'; text.params.fontId = 'noto-sans-jp';
  const lyrics = makeLayer('lyrics'); lyrics.params.translationFontId = 'noto-serif-sc';
  const image = makeLayer('image'); image.params.shadowOpacity = .35;
  const background = makeLayer('background'); background.params = { ...background.params, backgroundType: 'video', videoId: 'my-video', videoLoop: false, fit: 'stretch' };
  const video: MediaAsset = { id: 'my-video', name: 'video.mp4', type: 'video', url: '/api/assets/my-video', duration: 2, width: 320, height: 180, fps: 30 };
  const project = projectFor(text); project.layers = [text, lyrics, image, background]; project.videos = [video];
  const reopened = validateProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(reopened.layers.map(layer => layer.params), project.layers.map(layer => layer.params));
  for (const [index, patch] of [[0, { text: 42 }], [0, { fontWeight: '600' }], [0, { lineHeight: 0 }], [0, { fontSize: 400 }], [1, { translationFontId: 'missing' }], [2, { shadowOpacity: 2 }], [3, { backgroundType: 'movie' }], [3, { videoLoop: 'yes' }], [3, { videoId: 'missing' }]] as [number, LayerParams][]) {
    const invalid = structuredClone(project); Object.assign(invalid.layers[index].params, patch);
    assert.throws(() => validateProject(invalid), `${JSON.stringify(patch)} must be rejected`);
  }
  background.params.videoId = ''; assert.doesNotThrow(() => validateProject(project), 'an empty source is a valid unconfigured background');
});

test('video backgrounds draw their own changing frame outside the static image cache and keep full edges at zero blur', () => {
  clearSceneCache();
  const layer = makeLayer('background'); layer.width = 640; layer.height = 360;
  layer.params = { ...layer.params, backgroundType: 'video', fit: 'stretch', blur: 0, brightness: 1, color: '#123456' };
  const project = projectFor(layer);
  const cover = { width: 800, height: 800 } as CanvasImageSource;
  const first = { width: 320, height: 180 } as CanvasImageSource;
  const second = { width: 320, height: 180 } as CanvasImageSource;
  const operations: Operation[] = [];
  const videoResources = { ...resources, cover, videos: new Map([[layer.id, first]]) };
  renderScene(context(operations), project, 0, videoResources);
  assert.deepEqual(operations.find(operation => operation.name === 'drawImage')?.args, [first, -320, -180, 640, 360]);
  videoResources.videos.set(layer.id, second); operations.length = 0;
  renderScene(context(operations), project, 1, videoResources);
  assert.equal(operations.find(operation => operation.name === 'drawImage')?.args[0], second);
  videoResources.videos.clear(); operations.length = 0;
  renderScene(context(operations), project, 1, videoResources);
  assert.equal(operations.some(operation => operation.name === 'drawImage'), false, 'missing frame never borrows the cover');
  assert.deepEqual(operations.filter(operation => operation.name === 'fillRect').at(-1)?.color, '#123456', 'missing video paints the selected plain base color');
});
