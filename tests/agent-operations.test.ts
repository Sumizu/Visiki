import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_OPERATION_TYPES, applyAgentOperations } from '../src/agent-operations';
import { createDefaultProject, makeLayer } from '../src/default-project';
import { makeEffect } from '../src/effects';
import { validateProject } from '../src/project-io';
import { videoSourceTime } from '../src/video-timing';
import type { DemoProject, Layer, MediaAsset } from '../src/types';

const clip: MediaAsset = { id: 'footage', type: 'video', name: 'footage.mp4', url: '/api/assets/footage', width: 640, height: 360, fps: 30, duration: 20 };
const fontId = '37dd0995-f4a4-4ddc-8c67-d75d84fb423a';
function project(): DemoProject {
  const current = createDefaultProject();
  current.duration = 12;
  current.layers = current.layers.map(layer => ({ ...layer, end: 12 }));
  return validateProject(current);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) freeze(item); }
  return value;
}
function withVideo(): { project: DemoProject; video: Layer } {
  const current = applyAgentOperations(project(), [{ op: 'attach_asset', asset: clip }, { op: 'add_layer', layerType: 'video', changes: { start: 2 }, params: { videoId: clip.id, sourceIn: 3, sourceOut: 13, reverse: true } }]);
  return { project: current, video: current.layers.at(-1)! };
}

test('agent edit catalog exposes every supported atomic operation', () => {
  assert.equal(new Set(AGENT_OPERATION_TYPES).size, 11);
  assert.ok(Object.isFrozen(AGENT_OPERATION_TYPES));
  assert.ok(AGENT_OPERATION_TYPES.includes('set_lyrics'));
});

test('agent batches leave the original untouched on failure and return independent valid snapshots', () => {
  const original = freeze(project()); const before = JSON.stringify(original);
  assert.throws(() => applyAgentOperations(original, [{ op: 'update_project', changes: { title: '修改了一半' } }, { op: 'update_layer', id: 'missing', changes: { x: 20 } }]), /第 2 项/);
  assert.equal(JSON.stringify(original), before);
  const next = applyAgentOperations(original, [{ op: 'update_project', changes: { title: '成功', artist: '演唱者', audioMuted: true } }]);
  assert.equal(next.title, '成功'); assert.equal(next.artist, '演唱者'); assert.equal(next.audioMuted, true);
  assert.equal(JSON.stringify(original), before);
  assert.notEqual(next.layers, original.layers); assert.notEqual(next.layers[0].params, original.layers[0].params);
  assert.deepEqual(validateProject(next), next);
});

test('agent input rejects unknown fields, prototype pollution, accessors, inherited objects and non-JSON payloads', () => {
  const current = project(); let invoked = false;
  const accessor = { op: 'update_project', get changes() { invoked = true; return { title: 'bad' }; } };
  const arrayAccessor: unknown[] = []; Object.defineProperty(arrayAccessor, '0', { enumerable: true, get() { invoked = true; return {}; } });
  const polluted = JSON.parse('[{"op":"update_project","changes":{"__proto__":{"polluted":true}}}]');
  const cases = [[], Array.from({ length: 101 }, () => ({ op: 'update_project', changes: {} })), {}, [{ type: 'update_project', changes: {} }], [{ op: 'update_project', surprise: true, changes: {} }],
    [{ op: 'update_project', changes: { audio: null } }], [{ op: 'update_project', changes: { title: undefined } }], [{ op: 'update_project', changes: { width: Infinity } }],
    [accessor], arrayAccessor, polluted, [Object.assign(Object.create({ inherited: true }), { op: 'update_project', changes: {} })], [{ op: 'update_project', changes: { constructor: {} } }]];
  for (const input of cases) assert.throws(() => applyAgentOperations(current, input));
  assert.equal(invoked, false); assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('project geometry edits preserve component placement and duration edits use the existing trim behavior', () => {
  const current = project(); const positions = current.layers.map(layer => [layer.x, layer.y, layer.width, layer.height]);
  const resized = applyAgentOperations(current, [{ op: 'update_project', changes: { width: 1080, height: 1920, fps: 24, duration: 5, lyricsOffsetMs: -250 } }]);
  assert.equal(resized.duration, 5); assert.equal(resized.fps, 24); assert.equal(resized.lyricsOffsetMs, -250);
  assert.deepEqual(resized.layers.map(layer => [layer.x, layer.y, layer.width, layer.height]), positions);
  assert.ok(resized.layers.every(layer => layer.end === 5));
  for (const changes of [{ width: 20 }, { height: 200.5 }, { fps: 0 }, { duration: 3601 }, { audioMuted: 1 }, { lyricsOffsetMs: 3600001 }]) assert.throws(() => applyAgentOperations(current, [{ op: 'update_project', changes }]));
});

test('new components use scaled factory geometry and cannot override identity or exceed capacity', () => {
  const current = project(); current.width = 960; current.height = 540;
  const next = applyAgentOperations(current, [{ op: 'add_layer', layerType: 'text', params: { text: '新文本', fontSize: 56 } }, { op: 'add_layer', layerType: 'particles', params: { preset: 'snow', count: 120 } }]);
  const text = next.layers.at(-2)!;
  assert.equal(text.x, 480); assert.equal(text.y, 270); assert.equal(text.width, 400); assert.equal(text.height, 120); assert.equal(text.params.fontSize, 56);
  assert.equal(text.end, 12); assert.ok(text.id); assert.equal(next.layers.at(-1)!.params.preset, 'snow');
  for (const changes of [{ id: 'injected' }, { type: 'video' }]) assert.throws(() => applyAgentOperations(current, [{ op: 'add_layer', layerType: 'text', changes }]));
  assert.throws(() => applyAgentOperations(current, [{ op: 'add_layer', layerType: 'unknown' }]));
  const full = { ...current, layers: Array.from({ length: 100 }, () => makeLayer('text', 12)) };
  assert.throws(() => applyAgentOperations(full, [{ op: 'add_layer', layerType: 'text' }]), /容量/);
  assert.equal(full.layers.length, 100);
});

test('lyric style edits merge parameters while keeping active and inactive typography independent', () => {
  const current = project(); const lyrics = current.layers.find(layer => layer.type === 'lyrics')!;
  const inactiveSize = lyrics.params.inactiveFontSize; const mode = lyrics.params.mode;
  const next = applyAgentOperations(current, [{ op: 'update_layer', id: lyrics.id, changes: { x: 420, params: { fontSize: 80, color: '#ff0000' } } }]);
  const result = next.layers.find(layer => layer.id === lyrics.id)!;
  assert.equal(result.id, lyrics.id); assert.equal(result.type, 'lyrics'); assert.equal(result.params.fontSize, 80); assert.equal(result.params.inactiveFontSize, inactiveSize);
  assert.equal(result.params.mode, mode); assert.equal(lyrics.params.color, '#ffffff');
  assert.throws(() => applyAgentOperations(current, [{ op: 'update_layer', id: lyrics.id, changes: { id: 'new' } }]));
  assert.throws(() => applyAgentOperations(current, [{ op: 'update_layer', id: lyrics.id, changes: { params: { fontSize: '80' } } }]));
  assert.throws(() => applyAgentOperations(current, [{ op: 'update_layer', id: lyrics.id, changes: { params: { mode: 'wrong' } } }]));
  assert.throws(() => applyAgentOperations(current, [{ op: 'update_layer', id: lyrics.id, changes: { params: { arbitrary: true } } }]));
});

test('locked tracks allow visibility or explicit unlock; all other mutations require a prior unlock operation', () => {
  const current = project(); const background = current.layers.find(layer => layer.type === 'background')!;
  assert.equal(background.locked, true);
  assert.equal(applyAgentOperations(current, [{ op: 'update_layer', id: background.id, changes: { visible: false } }]).layers[0].visible, false);
  const mutations = [
    { op: 'update_layer', id: background.id, changes: { locked: false, x: 5 } },
    { op: 'remove_layer', id: background.id }, { op: 'reorder_layer', id: background.id, index: 2 },
    { op: 'move_layer', id: background.id, start: 3 }, { op: 'add_effect', targetId: background.id, type: 'film' },
  ];
  for (const operation of mutations) assert.throws(() => applyAgentOperations(current, [operation]), /锁定/);
  const next = applyAgentOperations(current, [{ op: 'update_layer', id: background.id, changes: { locked: false } }, { op: 'update_layer', id: background.id, changes: { x: 5 } }]);
  assert.equal(next.layers[0].x, 5); assert.equal(next.layers[0].locked, false);
});

test('image, video and custom font attachments use canonical local URLs and maintain explicit roles', () => {
  const current = project();
  const next = applyAgentOperations(current, [
    { op: 'attach_asset', asset: { id: 'picture', type: 'image', name: '图片.png', url: 'https://ignored.invalid/image' } },
    { op: 'attach_asset', asset: { id: 'cover', type: 'image', name: '封面.png' }, role: 'cover' },
    { op: 'attach_asset', asset: clip },
    { op: 'attach_asset', asset: { id: fontId, type: 'font', name: '日本語.ttf', family: 'untrusted', url: 'https://ignored.invalid/font' } },
    { op: 'add_layer', layerType: 'text', params: { fontId, text: 'こんにちは' } },
  ]);
  assert.equal(next.images?.length, 2); assert.equal(next.images?.[0].url, '/api/assets/picture'); assert.equal(next.cover?.id, 'cover');
  assert.equal(next.videos?.[0].posterUrl, '/api/video/footage/poster');
  assert.equal(next.fonts?.[0].family, `VisikiFont_${fontId.replaceAll('-', '_')}`); assert.equal(next.fonts?.[0].url, `/api/fonts/${fontId}`);
  assert.equal(next.layers.at(-1)!.params.fontId, fontId);
  assert.equal(current.images?.length, 0); assert.equal(current.cover, null);
  const twice = applyAgentOperations(next, [{ op: 'attach_asset', asset: clip }, { op: 'attach_asset', asset: { id: fontId, type: 'font', name: '日本語.ttf' } }]);
  assert.equal(twice.videos?.length, 1); assert.equal(twice.fonts?.length, 1);
  assert.throws(() => applyAgentOperations(next, [{ op: 'attach_asset', asset: { id: 'picture', type: 'video', name: 'bad', duration: 2, width: 640, height: 360 } }]), /占用/);
  assert.throws(() => applyAgentOperations(current, [{ op: 'attach_asset', asset: clip, role: 'cover' }]));
  assert.throws(() => applyAgentOperations(current, [{ op: 'attach_asset', asset: { id: 'not-uuid', type: 'font', name: 'bad' } }]));
  assert.throws(() => applyAgentOperations(current, [{ op: 'attach_asset', asset: { id: fontId, type: 'font', name: 'bad', builtin: true } }]));
});

test('attaching music matches complete component ends without truncating an existing video', () => {
  const { project: current, video } = withVideo();
  const partial = current.layers.find(layer => layer.type === 'title')!; partial.start = 1; partial.end = 6;
  const audio = { id: 'music', name: 'song.wav', type: 'audio', duration: 8, url: '/api/assets/music', sampleRate: 48000, channels: 2 };
  const next = applyAgentOperations(current, [{ op: 'attach_asset', asset: audio }]);
  assert.equal(next.audio?.id, 'music'); assert.equal(next.duration, video.end);
  assert.equal(next.layers.find(layer => layer.id === video.id)!.end, video.end);
  assert.equal(next.layers.find(layer => layer.type === 'background')!.end, video.end);
  assert.equal(next.layers.find(layer => layer.id === partial.id)!.end, 6);
  const short = applyAgentOperations(project(), [{ op: 'attach_asset', asset: { ...audio, duration: 3 } }]);
  assert.equal(short.duration, 3); assert.ok(short.layers.every(layer => layer.end === 3));
  const extended = applyAgentOperations(project(), [{ op: 'attach_asset', asset: { ...audio, duration: 24 } }]);
  assert.equal(extended.duration, 24); assert.ok(extended.layers.every(layer => layer.end === 24));
  assert.throws(() => applyAgentOperations(current, [{ op: 'attach_asset', asset: audio, role: 'library' }]));
  assert.throws(() => applyAgentOperations(current, [{ op: 'attach_asset', asset: { ...audio, duration: 3601 } }]));
});

test('video add, source changes, rate and movement preserve source mapping and extend the timeline', () => {
  const current = applyAgentOperations(project(), [{ op: 'attach_asset', asset: clip }, { op: 'add_layer', layerType: 'video', changes: { start: 8 }, params: { videoId: clip.id, sourceIn: 4, sourceOut: 16, playbackRate: 2, reverse: true } }]);
  const video = current.layers.at(-1)!;
  assert.equal(video.start, 8); assert.equal(video.end, 14); assert.equal(current.duration, 14);
  const rated = applyAgentOperations(current, [{ op: 'video_rate', id: video.id, rate: .5 }]);
  const slow = rated.layers.at(-1)!;
  assert.equal(slow.end, 32); assert.equal(rated.duration, 32); assert.equal(slow.params.reverse, true); assert.equal(slow.params.sourceIn, 4); assert.equal(slow.params.sourceOut, 16);
  const moved = applyAgentOperations(rated, [{ op: 'move_layer', id: video.id, start: 40.011 }]);
  const result = moved.layers.at(-1)!;
  assert.equal(result.start, 40); assert.equal(result.end, 64); assert.equal(moved.duration, 64); assert.deepEqual(result.params, slow.params);
  const trimmed = applyAgentOperations(current, [{ op: 'update_layer', id: video.id, changes: { params: { sourceOut: 10 } } }]);
  assert.equal(trimmed.layers.at(-1)!.end, 11);
  assert.throws(() => applyAgentOperations(current, [{ op: 'update_layer', id: video.id, changes: { end: 50 } }]), /不一致/);
  assert.throws(() => applyAgentOperations(current, [{ op: 'update_layer', id: video.id, changes: { params: { sourceOut: 25 } } }]));
  assert.throws(() => applyAgentOperations(current, [{ op: 'video_rate', id: video.id, rate: 9 }]));
  assert.throws(() => applyAgentOperations(current, [{ op: 'move_layer', id: video.id, start: 3598 }]));
});

test('video cuts preserve reverse continuity and clone effect identities independently', () => {
  const { project: current, video } = withVideo(); video.effects = [makeEffect('film')];
  const next = applyAgentOperations(current, [{ op: 'split_video', id: video.id, at: 6 }]);
  const pieces = next.layers.filter(layer => layer.type === 'video');
  assert.equal(pieces.length, 2); assert.equal(pieces[0].id, video.id); assert.notEqual(pieces[1].id, video.id);
  assert.equal(pieces[0].end, 6); assert.equal(pieces[1].start, 6);
  assert.notEqual(pieces[0].effects![0].id, pieces[1].effects![0].id); assert.equal(pieces[1].effectTimeOffset, 4);
  for (const time of [2, 3.25, 5.5, 6, 8, 11.9]) {
    const piece = time < 6 ? pieces[0] : pieces[1];
    assert.equal(videoSourceTime(piece, time, clip), videoSourceTime(video, time, clip));
  }
  assert.throws(() => applyAgentOperations(current, [{ op: 'split_video', id: video.id, at: 2.01 }]), /一工程帧/);
  assert.throws(() => applyAgentOperations(current, [{ op: 'split_video', id: current.layers[1].id, at: 6 }]), /视频/);
});

test('duration shrink trims reversed video with valid source timing and removes later tracks', () => {
  const { project: current, video } = withVideo();
  const result = applyAgentOperations(current, [{ op: 'update_project', changes: { duration: 7 } }]);
  const trimmed = result.layers.find(layer => layer.id === video.id)!;
  assert.equal(trimmed.start, 2); assert.equal(trimmed.end, 7); assert.equal(trimmed.params.sourceIn, 8); assert.equal(trimmed.params.sourceOut, 13);
  assert.equal(videoSourceTime(trimmed, 5, clip), videoSourceTime(video, 5, clip));
  assert.deepEqual(validateProject(result), result);
});

test('reordering uses bottom-up indexes and removals preserve all remaining track IDs', () => {
  const current = project(); const target = current.layers[1]; const originalIds = current.layers.map(layer => layer.id);
  const next = applyAgentOperations(current, [{ op: 'reorder_layer', id: target.id, index: current.layers.length - 1 }]);
  assert.deepEqual(next.layers.map(layer => layer.id), [...originalIds.filter(id => id !== target.id), target.id]);
  const removed = applyAgentOperations(next, [{ op: 'remove_layer', id: target.id }]);
  assert.deepEqual(removed.layers.map(layer => layer.id), originalIds.filter(id => id !== target.id));
  assert.throws(() => applyAgentOperations(current, [{ op: 'reorder_layer', id: target.id, index: current.layers.length }]));
});

test('set lyrics supports sorted cues, translated LRC, offsets and explicit source metadata', () => {
  const current = project();
  const cues = [{ time: 3, end: 5, text: '后一句', translation: 'later' }, { time: -1, text: '首句' }];
  const sorted = applyAgentOperations(current, [{ op: 'set_lyrics', lyrics: cues, offsetMs: 250 }]);
  assert.equal(sorted.lyrics[0].time, -1); assert.equal(cues[0].time, 3); assert.equal(sorted.lyricsOffsetMs, 250);
  const source = { provider: 'netease', id: '123', url: 'https://music.163.com/song?id=123' };
  const parsed = applyAgentOperations(current, [{ op: 'set_lyrics', originalLrc: '[offset:100]\n[00:01.00]こんにちは\n[00:02.00]世界', translatedLrc: '[00:00.90]你好\n[00:01.90]世界', source }]);
  assert.equal(parsed.lyrics[0].time, .9); assert.equal(parsed.lyrics[0].translation, '你好'); assert.deepEqual(parsed.lyricsSource, source);
  const cleared = applyAgentOperations(parsed, [{ op: 'set_lyrics', lyrics: [] }]); assert.equal(cleared.lyrics.length, 0); assert.equal(cleared.lyricsSource, undefined);
  for (const operation of [{ op: 'set_lyrics', lyrics: [], originalLrc: '' }, { op: 'set_lyrics', originalLrc: '无时间戳的歌词' }, { op: 'set_lyrics', lyrics: [{ time: 0, text: 'x', extra: 1 }] }, { op: 'set_lyrics', lyrics: [{ time: 2, end: 1, text: 'x' }] }, { op: 'set_lyrics', lyrics: [], source: { ...source, unexpected: true } }]) assert.throws(() => applyAgentOperations(current, [operation]));
});

test('effect operations enforce target compatibility, stack capacity, complete-stack edits and strict parameter validation', () => {
  const current = project(); const target = current.layers[1];
  const next = applyAgentOperations(current, [{ op: 'add_effect', targetId: target.id, type: 'audio-reactive', params: { scale: .2 }, strength: .5 }, { op: 'add_effect', targetId: 'audio', type: 'fade', params: { fadeIn: 2, fadeOut: 3 } }]);
  assert.equal(next.layers[1].effects![0].params.scale, .2); assert.equal(next.layers[1].effects![0].strength, .5); assert.equal(next.audioEffects![0].params.fadeIn, 2);
  const changed = structuredClone(next.layers[1].effects!); changed[0].enabled = false;
  const edited = applyAgentOperations(next, [{ op: 'update_layer', id: target.id, changes: { effects: changed } }, { op: 'update_project', changes: { audioEffects: [] } }]);
  assert.equal(edited.layers[1].effects![0].enabled, false); assert.deepEqual(edited.audioEffects, []);
  assert.throws(() => applyAgentOperations(current, [{ op: 'add_effect', targetId: 'audio', type: 'color' }]), /不支持/);
  assert.throws(() => applyAgentOperations(current, [{ op: 'add_effect', targetId: target.id, type: 'film', params: { surprise: 1 } }]));
  assert.throws(() => applyAgentOperations(current, [{ op: 'add_effect', targetId: target.id, type: 'film', params: { grain: 2 } }]));
  assert.throws(() => applyAgentOperations(current, [{ op: 'add_effect', targetId: target.id, type: 'film', params: { grain: '1' } }]));
  assert.throws(() => applyAgentOperations(current, [{ op: 'update_layer', id: target.id, changes: { effects: [{ ...makeEffect('film'), surprise: true }] } }]));
  assert.throws(() => applyAgentOperations(current, Array.from({ length: 9 }, () => ({ op: 'add_effect', targetId: target.id, type: 'film' }))), /最多/);
  assert.equal(current.layers[1].effects, undefined);
});
