import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProject, makeLayer } from '../src/default-project';
import { makeEffect } from '../src/effects';
import { collectProjectFonts } from '../src/fonts';
import { validateProject } from '../src/project-io';
import { collectExportImageAssets } from '../src/services';
import { layoutLyricBlocks, resolveLyricStyle } from '../src/lyric-style';
import { applyProjectTemplate, PROJECT_TEMPLATES } from '../src/templates';
import type { DemoProject, Layer } from '../src/types';

function contentProject(): DemoProject {
  const project = createDefaultProject();
  project.title = '保留我的曲名 / 日本語の歌'; project.artist = '保留我的歌手';
  project.duration = 12; project.fps = 24; project.lyricsOffsetMs = 370;
  project.audio = { id: 'music', type: 'audio', name: 'my-song.wav', url: '/api/assets/music', duration: 12, sampleRate: 48000, channels: 2 };
  project.audioMuted = true; project.audioEffects = [makeEffect('fade')];
  project.cover = { id: 'cover', type: 'image', name: 'cover.png', url: '/api/assets/cover' };
  project.images = [project.cover, { id: 'other', type: 'image', name: 'second.png', url: '/api/assets/other' }];
  project.videos = [{ id: 'footage', type: 'video', name: 'clip.mp4', url: '/api/assets/footage', duration: 12, width: 640, height: 360, fps: 30 }];
  project.fonts = [{ id: '37dd0995-f4a4-4ddc-8c67-d75d84fb423a', type: 'font', name: 'my-font.ttf', family: 'my-custom-font', url: '/api/fonts/37dd0995-f4a4-4ddc-8c67-d75d84fb423a' }];
  project.lyrics = [{ time: 0, text: '用户自己的歌词', translation: '自分の歌詞' }, { time: 6, end: 12, text: '下一句保留', translation: '次の行もそのまま' }];
  project.lyricsSource = { provider: 'netease', id: '1234', url: 'https://music.163.com/song?id=1234' };
  const video = makeLayer('video', 12);
  Object.assign(video, { x: 560, y: 310, width: 380, height: 214, start: 2, end: 6, opacity: .7, rotation: 12 });
  video.params = { videoId: 'footage', sourceIn: 1, sourceOut: 5, playbackRate: 1, reverse: true, fit: 'stretch' };
  video.effects = [makeEffect('color')];
  const text = makeLayer('text', 12);
  text.name = '用户署名'; text.params.text = '我的文字'; text.params.fontId = project.fonts[0].id;
  text.start = 1; text.end = 10; text.effects = [makeEffect('fade')];
  const oldDecoration = makeLayer('text', 12); oldDecoration.params.templateId = 'previous-template';
  project.layers = [makeLayer('background', 12), makeLayer('image', 12), video, oldDecoration, text];
  return project;
}

function withoutLayers(project: DemoProject): Omit<DemoProject, 'layers'> {
  const { layers: _layers, ...content } = project;
  return content;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test('six simply numbered templates expose no descriptions or tags and remain editable without external media', () => {
  assert.deepEqual(PROJECT_TEMPLATES.map(template => [template.id, template.name]), [
    ['vinyl-room', '模板1'], ['paper-poem', '模板2'], ['neon-night', '模板3'],
    ['sunset-film', '模板4'], ['mist-forest', '模板5'], ['pulse-radio', '模板6'],
  ]);
  assert.ok(Object.isFrozen(PROJECT_TEMPLATES));
  const styles = new Set<string>();
  for (const template of PROJECT_TEMPLATES) {
    assert.ok(Object.isFrozen(template));
    assert.deepEqual(Object.keys(template).sort(), ['accent', 'id', 'name']);
    const project = applyProjectTemplate(createDefaultProject(), template.id);
    assert.ok(project.layers.length >= 4 && project.layers.length <= 8);
    assert.ok(project.layers.every(layer => layer.params.templateId === template.id));
    assert.ok(project.layers.some(layer => layer.type === 'title'));
    assert.ok(project.layers.some(layer => layer.type === 'lyrics'));
    assert.ok(project.layers.filter(layer => layer.type !== 'background').every(layer => !layer.locked));
    assert.deepEqual(collectExportImageAssets(project, { start: 0, end: project.duration }), []);
    assert.ok(collectProjectFonts(project).every(font => font.builtin));
    assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(project))));
    styles.add(JSON.stringify(project.layers.map(layer => [layer.type, layer.x, layer.y, layer.width, layer.height, layer.params])));
  }
  assert.equal(styles.size, 6);
  const paper = applyProjectTemplate(createDefaultProject(), 'paper-poem');
  assert.equal(paper.layers[0].params.backgroundType, 'color');
  assert.equal(paper.layers[0].params.color, '#f5f1e9');
  assert.equal(paper.layers.find(layer => layer.type === 'lyrics')?.params.fontId, 'noto-serif-sc');
  assert.equal(applyProjectTemplate(paper, 'pulse-radio').layers.find(layer => layer.type === 'spectrum')?.params.mode, 'ecg-wave');
});

test('applying presentation preserves all media, lyrics, audio effects and custom video/text geometry', () => {
  const source = contentProject(); const snapshot = structuredClone(source); deepFreeze(source);
  const custom = snapshot.layers.filter(layer => (layer.type === 'text' || layer.type === 'video') && !layer.params.templateId);
  const result = applyProjectTemplate(source, 'mist-forest');
  assert.deepEqual(source, snapshot, 'frozen inputs are never mutated');
  assert.deepEqual(withoutLayers(result), withoutLayers(snapshot));
  assert.deepEqual(result.layers.slice(-custom.length), custom, 'custom tracks retain their IDs, order, transforms, timing and effects');
  assert.ok(result.layers.slice(0, -custom.length).every(layer => layer.params.templateId === 'mist-forest'));
  assert.equal(result.layers.some(layer => layer.id === source.layers[3].id), false, 'old template decorations are replaced');
  const copiedVideo = result.layers.find(layer => layer.type === 'video')!;
  copiedVideo.params.playbackRate = 2; copiedVideo.effects![0].params.temperature = .5;
  result.audioEffects![0].params.fadeIn = 2; result.images![0].name = 'changed';
  result.lyrics[0].text = 'changed'; result.fonts![0].name = 'changed';
  assert.deepEqual(source, snapshot, 'mutating the result never changes the previous undo snapshot');
  assert.notEqual(result.audio, source.audio);
  assert.notEqual(result.lyricsSource, source.lyricsSource);
  assert.notEqual(result.cover, source.cover);
});

test('replacing all visual tracks is explicit and repeated template applications do not accumulate layers', () => {
  let project = contentProject();
  const customIds = project.layers.filter(layer => (layer.type === 'text' || layer.type === 'video') && !layer.params.templateId).map(layer => layer.id);
  for (const template of [...PROJECT_TEMPLATES, ...PROJECT_TEMPLATES].reverse()) {
    project = applyProjectTemplate(project, template.id);
    const own = project.layers.filter(layer => layer.params.templateId);
    assert.ok(own.length >= 4 && own.length <= 8);
    assert.ok(own.every(layer => layer.params.templateId === template.id));
    assert.deepEqual(project.layers.filter(layer => !layer.params.templateId).map(layer => layer.id), customIds);
  }
  const replaced = applyProjectTemplate(project, 'paper-poem', { keepCustomLayers: false });
  assert.equal(replaced.layers.length, 4);
  assert.ok(replaced.layers.every(layer => layer.params.templateId === 'paper-poem'));
  assert.deepEqual(withoutLayers(replaced), withoutLayers(project), 'replacing visual tracks still retains the complete content library');
});

test('every new template layer and effect has a fresh UUID without sharing mutable template data', () => {
  const source = createDefaultProject(); const seen = new Set(source.layers.map(layer => layer.id));
  for (let repeat = 0; repeat < 2; repeat++) {
    for (const template of PROJECT_TEMPLATES) {
      const applied = applyProjectTemplate(source, template.id);
      for (const layer of applied.layers) {
        for (const item of [layer, ...(layer.effects ?? [])]) {
          assert.match(item.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
          assert.equal(seen.has(item.id), false); seen.add(item.id);
        }
      }
      const second = applyProjectTemplate(source, template.id);
      applied.layers[0].params.color = '#ff0000';
      assert.notEqual(second.layers[0].params.color, '#ff0000');
    }
  }
});

test('image roles follow an existing/default future cover and can bind an image-only library', () => {
  for (const template of PROJECT_TEMPLATES) {
    const empty = applyProjectTemplate(createDefaultProject(), template.id);
    const imageLayers = (project: DemoProject): Layer[] => project.layers.filter(layer => layer.type === 'image' || layer.type === 'disc' || (layer.type === 'background' && layer.params.backgroundType === 'image'));
    const pureColor = template.id === 'paper-poem' || template.id === 'mist-forest';
    assert.equal(imageLayers(empty).length === 0, pureColor);
    assert.ok(imageLayers(empty).every(layer => layer.params.followCover === true && layer.params.imageId === ''));
    const populated = contentProject();
    const bound = applyProjectTemplate(populated, template.id);
    assert.ok(imageLayers(bound).every(layer => layer.params.imageId === 'cover' && layer.params.followCover === true));
    populated.cover = null;
    const libraryOnly = applyProjectTemplate(populated, template.id);
    assert.ok(imageLayers(libraryOnly).every(layer => layer.params.imageId === 'cover' && layer.params.followCover === false));
    assert.equal(libraryOnly.cover, null, 'selecting a presentation does not silently change the user default cover');
    assert.doesNotThrow(() => validateProject(libraryOnly));
  }
});

test('templates fit landscape, portrait, square and small canvases at short/long durations and reopen', () => {
  const canvases = [[1920, 1080], [1080, 1920], [1080, 1080], [320, 180], [320, 568], [3840, 2160], [3840, 180], [320, 3840]];
  for (const [width, height] of canvases) {
    for (const duration of [.01, 1.2, 3600]) {
      for (const template of PROJECT_TEMPLATES) {
        const source = createDefaultProject(); Object.assign(source, { width, height, duration });
        source.lyrics = [{ time: 0, end: duration, text: '保留歌曲文字', translation: 'Keep my lyrics' }];
        const project = applyProjectTemplate(source, template.id);
        assert.deepEqual([project.width, project.height, project.duration, project.fps], [width, height, duration, source.fps]);
        for (const layer of project.layers) {
          assert.equal(layer.start, 0); assert.equal(layer.end, duration);
          assert.ok(layer.width > 0 && layer.height > 0);
          assert.ok(layer.x - layer.width / 2 >= -1e-6 && layer.x + layer.width / 2 <= width + 1e-6, `${template.id}: horizontal bounds`);
          assert.ok(layer.y - layer.height / 2 >= -1e-6 && layer.y + layer.height / 2 <= height + 1e-6, `${template.id}: vertical bounds`);
          if (layer.type === 'disc' || layer.params.mask === 'circle') assert.equal(layer.width, layer.height, 'circles are never stretched by aspect ratio');
          if (layer.type === 'lyrics') {
            for (const key of ['fontSize', 'translationSize', 'inactiveFontSize', 'inactiveTranslationSize']) assert.ok(Number(layer.params[key]) >= 8 && Number(layer.params[key]) <= 300);
          }
        }
        const saved = JSON.parse(JSON.stringify(project)); const reopened = validateProject(saved);
        assert.equal(reopened.layers.length, project.layers.length);
        assert.deepEqual(reopened.layers.map(layer => [layer.id, layer.x, layer.y, layer.width, layer.height]), project.layers.map(layer => [layer.id, layer.x, layer.y, layer.width, layer.height]));
        assert.ok(reopened.layers.every(layer => layer.params.templateId === template.id));
      }
    }
  }
});

test('unknown templates and track-capacity overflow fail before dropping or changing user content', () => {
  const project = createDefaultProject(); const before = structuredClone(project);
  assert.throws(() => applyProjectTemplate(project, 'unknown'), /找不到/);
  assert.deepEqual(project, before);
  project.layers = Array.from({ length: 96 }, () => makeLayer('text'));
  assert.throws(() => applyProjectTemplate(project, 'neon-night'), /100 条轨道/);
  assert.equal(project.layers.length, 96);
  assert.equal(applyProjectTemplate(project, 'neon-night', { keepCustomLayers: false }).layers.length, 5);
});

test('middle templates use four clearly different background-led layouts without foreground cards or discs', () => {
  const source = contentProject();
  const ids = ['paper-poem', 'neon-night', 'sunset-film', 'mist-forest'];
  const projects = ids.map(id => applyProjectTemplate(source, id, { keepCustomLayers: false }));
  for (const project of projects) {
    assert.equal(project.layers.some(layer => layer.type === 'image' || layer.type === 'disc'), false);
    const background = project.layers.find(layer => layer.type === 'background')!;
    assert.deepEqual([background.x, background.y, background.width, background.height], [960, 540, 1920, 1080]);
    assert.ok(project.layers.length >= 4 && project.layers.length <= 6);
  }
  const [paper, image, film, rays] = projects;
  const lyric = (project: DemoProject): Layer => project.layers.find(layer => layer.type === 'lyrics')!;
  assert.equal(paper.layers[0].params.backgroundType, 'color');
  assert.equal(lyric(paper).params.mode, 'single');
  assert.equal(lyric(paper).x / paper.width, .5);
  assert.equal(Number(lyric(paper).params.fontSize), 88, 'single-line display retains its designed large type');
  assert.ok(lyric(image).y / image.height > .75, 'image-led template places a single subtitle near the bottom');
  assert.equal(lyric(image).params.mode, 'single');
  assert.equal(lyric(film).params.align, 'left');
  assert.equal(lyric(film).params.mode, 'scroll');
  assert.ok(lyric(film).x / film.width < .4);
  assert.ok(film.layers[0].effects?.some(effect => effect.type === 'film'));
  assert.equal(lyric(rays).params.mode, 'bilingual');
  assert.ok(rays.layers.some(layer => layer.type === 'atmosphere' && layer.params.kind === 'rays'));
  assert.ok(rays.layers.some(layer => layer.type === 'atmosphere' && layer.params.kind === 'fog'));
  assert.ok(Number(rays.layers.find(layer => layer.type === 'spectrum')!.width) / rays.width >= .9);
  for (const [project, style, duration] of [[paper, 0, .5], [image, 1, .4], [rays, 5, .65]] as const) {
    const layer = lyric(project);
    assert.equal(layer.params.transition, 'none', 'legacy rendering cannot apply the same transition twice');
    const fades = layer.effects?.filter(effect => effect.type === 'fade') ?? [];
    assert.equal(fades.length, 1, 'a normal immediately editable fade is included in the layer effect stack');
    assert.equal(fades[0].params.style, style);
    assert.equal(fades[0].params.timing, 1, 'lyrics fade once per cue');
    assert.equal(fades[0].params.fadeIn, duration);
    assert.equal(fades[0].params.fadeOut, duration);
    const reopened = validateProject(JSON.parse(JSON.stringify(project)));
    assert.deepEqual(lyric(reopened).effects, layer.effects, 'save/reopen neither duplicates nor changes the transition');
  }
  for (const project of [image, film]) {
    assert.equal(project.layers[0].params.backgroundType, 'image');
    assert.equal(project.layers[0].params.blur, 0, 'the cover is a clear full-frame background');
    assert.ok(Number(project.layers[0].params.brightness) >= .5);
    assert.ok(lyric(project).params.activeShadowEnabled);
    assert.ok(Number(lyric(project).params.activeStrokeWidth) > 0);
  }
});

test('clear full-frame templates inherit the selected video background rather than the first video asset', () => {
  for (const template of ['neon-night', 'sunset-film']) {
    const source = contentProject();
    source.videos!.push({ id: 'selected-background', type: 'video', name: 'background.mp4', url: '/api/assets/selected-background', duration: 25, width: 1920, height: 1080, fps: 24 });
    const selected = source.layers.find(layer => layer.type === 'background')!;
    selected.params = { ...selected.params, backgroundType: 'video', videoId: 'selected-background', playbackRate: .75, reverse: true, videoLoop: false, fit: 'contain' };
    const snapshot = structuredClone(source);
    const applied = applyProjectTemplate(source, template);
    const background = applied.layers.find(layer => layer.type === 'background')!;
    assert.equal(background.params.backgroundType, 'video');
    for (const key of ['videoId', 'playbackRate', 'reverse', 'videoLoop', 'fit']) assert.equal(background.params[key], selected.params[key], key);
    assert.equal(background.params.imageId, '');
    assert.equal(background.params.followCover, false);
    assert.equal(background.params.blur, 0);
    assert.notEqual(background.id, selected.id, 'rebuilt presentation has a fresh layer identity');
    assert.deepEqual(withoutLayers(applied), withoutLayers(snapshot));
    assert.deepEqual(source, snapshot);
    assert.doesNotThrow(() => validateProject(applied));
    const reapplied = applyProjectTemplate(applied, template);
    assert.equal(reapplied.layers[0].params.videoId, 'selected-background');
    assert.equal(reapplied.layers[0].params.reverse, true);
  }
});

test('solid backgrounds do not bind images and image templates do not infer a video background from the library', () => {
  const source = contentProject();
  const before = structuredClone(source);
  for (const id of ['paper-poem', 'mist-forest']) {
    const applied = applyProjectTemplate(source, id, { keepCustomLayers: false });
    const background = applied.layers[0];
    assert.equal(background.params.backgroundType, 'color');
    assert.equal(background.params.imageId, '');
    assert.equal(background.params.followCover, false);
    assert.deepEqual(collectExportImageAssets(applied, { start: 0, end: applied.duration }), []);
  }
  for (const backgroundType of ['color', 'image', 'video']) {
    const project = structuredClone(source);
    project.layers[0].params = { ...project.layers[0].params, backgroundType, videoId: 'missing-background-video' };
    for (const id of ['neon-night', 'sunset-film']) {
      const background = applyProjectTemplate(project, id).layers[0];
      assert.equal(background.params.backgroundType, 'image');
      assert.equal(background.params.imageId, 'cover');
      assert.equal(background.params.videoId, '');
    }
  }
  assert.deepEqual(source, before);
});

test('single and bilingual large-type layouts fit actual active glyph rows rather than phantom scroll neighbors', () => {
  for (const [width, height] of [[1920, 1080], [1080, 1920], [320, 180], [320, 568]]) {
    for (const id of ['paper-poem', 'neon-night', 'mist-forest']) {
      const source = contentProject(); Object.assign(source, { width, height });
      source.lyrics = [{ time: 0, text: '第一句\n第二行', translation: 'A translation\nSecond line' }, { time: 6, text: '下一句', translation: 'Next line' }];
      const project = applyProjectTemplate(source, id);
      const layer = project.layers.find(layer => layer.type === 'lyrics')!;
      const params = layer.params;
      const blocks = layoutLyricBlocks(project.lyrics, 0, resolveLyricStyle(params, true), resolveLyricStyle(params, false), {
        visibleCount: 1, originalOnly: params.mode === 'single', translationGap: Number(params.translationGap),
      });
      assert.equal(blocks.length, 1);
      assert.ok(blocks[0].height <= layer.height + 1e-6, `${id}: original and translated multiline cues fit`);
      assert.ok(layer.y - blocks[0].height / 2 >= 0 && layer.y + blocks[0].height / 2 <= height, `${id}: first/last glyph rows stay inside canvas`);
      if (params.mode === 'single') assert.deepEqual(blocks[0].translationLines, []);
      assert.ok(Number(params.fontSize) > Number(params.inactiveFontSize), `${id}: single mode keeps its intended typographic hierarchy`);
    }
  }
});
