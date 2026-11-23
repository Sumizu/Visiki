import test from 'node:test';
import assert from 'node:assert/strict';
import { colorWithOpacity, layoutLyricBlocks, lyricTransitionAtTime, normalizeLyricStyles, resolveLyricLayout, resolveLyricStyle, updateLyricStyles } from '../src/lyric-style';
import { activeLyricIndex } from '../src/lyrics';
import { renderScene } from '../src/scene';
import { createDefaultProject, makeLayer } from '../src/default-project';
import { validateProject } from '../src/project-io';
import type { DemoProject, LayerParams, LyricCue } from '../src/types';

const near = (actual: number, expected: number, message?: string): void => assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} differs from ${expected}`);

test('legacy lyric styles retain original sizes and colors while states resolve independently', () => {
  const params: LayerParams = { fontSize: 63, translationSize: 41, color: '#e9abcd', translationColor: '#aabbcc' };
  const active = resolveLyricStyle(params, true);
  const inactive = resolveLyricStyle(params, false);
  assert.equal(inactive.fontSize, 63); assert.equal(inactive.translationSize, 41);
  assert.equal(inactive.color, active.color); assert.equal(inactive.translationColor, active.translationColor);
  assert.equal(active.opacity, 1); assert.equal(inactive.opacity, 0.24);
  assert.equal(active.strokeWidth, 0); assert.equal(inactive.strokeWidth, 0);
  const custom = resolveLyricStyle({ ...params, activeOpacity: 0, activeShadowEnabled: false, activeStrokeWidth: 9,
    inactiveFontSize: 22, inactiveTranslationSize: 16, inactiveColor: '#123456', inactiveTranslationColor: '#654321',
    inactiveShadowBlur: 30, inactiveShadowX: -14, inactiveStrokeWidth: 2 }, false);
  assert.equal(custom.fontSize, 22); assert.equal(custom.translationSize, 16);
  assert.equal(custom.color, '#123456'); assert.equal(custom.translationColor, '#654321');
  assert.equal(custom.opacity, 0.24); assert.equal(custom.shadowEnabled, true);
  assert.equal(custom.strokeWidth, 2); assert.equal(custom.shadowBlur, 30); assert.equal(custom.shadowX, -14);
  assert.equal(resolveLyricStyle({ activeOpacity: 0 }, true).opacity, 0, 'fully transparent text remains fully transparent');
  assert.equal(active.fontSize, 63, 'resolving or changing another state cannot mutate an existing style');
});

test('legacy inherited sizes and colors are frozen before the first active edit', () => {
  const legacy: LayerParams = { fontSize: 43, translationSize: 36, color: '#abcdef', translationColor: '#fedcba', mode: 'scroll' };
  const unchanged = structuredClone(legacy);
  const normalized = normalizeLyricStyles(legacy);
  assert.deepEqual(resolveLyricStyle(normalized, true), resolveLyricStyle(legacy, true));
  assert.deepEqual(resolveLyricStyle(normalized, false), resolveLyricStyle(legacy, false), 'migrating a legacy project preserves its initial appearance');
  const edited = updateLyricStyles(legacy, { fontSize: 80, translationSize: 62, color: '#112233', translationColor: '#445566' });
  assert.deepEqual(resolveLyricStyle(edited, false), resolveLyricStyle(normalized, false));
  assert.equal(resolveLyricStyle(edited, false).fontSize, 43);
  assert.equal(resolveLyricStyle(edited, false).translationSize, 36);
  assert.equal(resolveLyricStyle(edited, true).fontSize, 80);
  assert.equal(resolveLyricStyle(edited, true).translationSize, 62);
  assert.equal(resolveLyricStyle(edited, false).color, '#abcdef');
  assert.equal(resolveLyricStyle(edited, false).translationColor, '#fedcba');
  assert.deepEqual(legacy, unchanged, 'normalizing and editing do not mutate the undo snapshot');
  assert.deepEqual(normalizeLyricStyles(normalized), normalized, 'migration is idempotent');
});

test('new lyric layers have independent states from the first edit in either direction', () => {
  const initial = makeLayer('lyrics').params;
  const initialActive = resolveLyricStyle(initial, true);
  const initialInactive = resolveLyricStyle(initial, false);
  for (const key of ['inactiveFontSize', 'inactiveTranslationSize', 'inactiveColor', 'inactiveTranslationColor']) {
    assert.ok(Object.hasOwn(initial, key), `${key} is saved explicitly on new layers`);
  }
  const activeEdited = updateLyricStyles(initial, { fontSize: 80, translationSize: 58, color: '#123456', translationColor: '#654321' });
  assert.deepEqual(resolveLyricStyle(activeEdited, false), initialInactive);
  const inactiveEdited = updateLyricStyles(activeEdited, { inactiveFontSize: 21, inactiveTranslationSize: 15, inactiveColor: '#abc123', inactiveTranslationColor: '#321cba' });
  assert.deepEqual(resolveLyricStyle(inactiveEdited, true), resolveLyricStyle(activeEdited, true));
  const activeAgain = updateLyricStyles(inactiveEdited, { fontSize: 92, translationSize: 65, color: '#010203', translationColor: '#040506' });
  assert.deepEqual(resolveLyricStyle(activeAgain, false), resolveLyricStyle(inactiveEdited, false));
  const inactiveFirst = updateLyricStyles(initial, { inactiveFontSize: 28, inactiveTranslationSize: 19, inactiveColor: '#cccccc', inactiveTranslationColor: '#dddddd' });
  assert.deepEqual(resolveLyricStyle(inactiveFirst, true), initialActive);
  assert.equal(initial.fontSize, 43); assert.equal(initial.inactiveFontSize, 43);
});

test('original and translation font sizes and colors never overwrite the other controls', () => {
  let params = normalizeLyricStyles({ fontSize: 43, translationSize: 36, color: '#ffffff', translationColor: '#e5e2f0' });
  const assignments: [string, string | number][] = [
    ['fontSize', 81], ['translationSize', 54], ['color', '#112233'], ['translationColor', '#445566'],
    ['inactiveFontSize', 23], ['inactiveTranslationSize', 18], ['inactiveColor', '#aabbcc'], ['inactiveTranslationColor', '#ddeeff'],
  ];
  for (const [key, value] of assignments) {
    const before = structuredClone(params);
    params = updateLyricStyles(params, { [key]: value });
    for (const [other] of assignments) if (other !== key) assert.equal(params[other], before[other], `changing ${key} preserves ${other}`);
  }
});

test('opening and resaving a legacy project preserves inactive appearance after current-style edits', () => {
  const legacy = createDefaultProject();
  const layer = makeLayer('lyrics');
  layer.params = { fontSize: 57, translationSize: 34, color: '#ab12cd', translationColor: '#dc21ba', mode: 'scroll', lines: 3 };
  const title = makeLayer('title');
  legacy.layers = [layer, title];
  const before = structuredClone(legacy);
  const loaded = validateProject(legacy);
  assert.deepEqual(legacy, before, 'opening an old project cannot rewrite the source or undo history');
  assert.deepEqual(loaded.layers[1].params, title.params, 'unrelated text layer parameters are unchanged');
  const initialInactive = resolveLyricStyle(loaded.layers[0].params, false);
  loaded.layers[0].params = updateLyricStyles(loaded.layers[0].params, { fontSize: 96, translationSize: 68, color: '#111111', translationColor: '#222222' });
  const reopened = validateProject(JSON.parse(JSON.stringify(loaded)));
  assert.deepEqual(resolveLyricStyle(reopened.layers[0].params, false), initialInactive);
  assert.equal(resolveLyricStyle(reopened.layers[0].params, true).fontSize, 96);
  assert.equal(reopened.layers[0].params.inactiveFontSize, 57);
  assert.equal(reopened.layers[0].params.inactiveTranslationSize, 34);
});

test('cue spacing uses independent font sizes and complete multiline translation height', () => {
  const cues: LyricCue[] = [
    { time: 0, text: 'Before', translation: '译前' },
    { time: 4, text: 'Now\nsecond original row', translation: '译一\n译二\n译三' },
    { time: 8, text: 'After' },
  ];
  const params = { fontSize: 50, translationSize: 30, inactiveFontSize: 20, inactiveTranslationSize: 10 };
  const active = resolveLyricStyle(params, true); const inactive = resolveLyricStyle(params, false);
  const blocks = layoutLyricBlocks(cues, 1, active, inactive, { visibleCount: 3, lineGap: 37, translationGap: 7 });
  assert.equal(blocks.length, 3);
  near(blocks[1].height, 2 * 50 * 1.23 + 7 + 3 * 30 * 1.23);
  near(blocks[1].top + blocks[1].height / 2, 0);
  near(blocks[1].top - (blocks[0].top + blocks[0].height), 37);
  near(blocks[2].top - (blocks[1].top + blocks[1].height), 37);
  near(blocks[0].height, 20 * 1.23 + 7 + 10 * 1.23);
  near(blocks[2].height, 20 * 1.23, 'a cue without a translation has no empty translation gap');
  near(resolveLyricLayout(cues[1], active, { originalOnly: true, translationGap: 90 }).height, 2 * 50 * 1.23);
  const wider = layoutLyricBlocks(cues, 1, active, inactive, { visibleCount: 3, lineGap: 37, translationGap: 27 });
  near(wider[1].height - blocks[1].height, 20);
});

test('non-scrolling transitions reach endpoints and remain deterministic across arbitrary seeks', () => {
  const cues = [{ time: 4, end: 8, text: 'Now' }, { time: 10, text: 'Next' }];
  for (const mode of ['fade', 'fade-up', 'fade-down', 'fade-zoom']) {
    assert.equal(lyricTransitionAtTime(cues, 0, 4, 15, mode, 0.5).alpha, 0);
    assert.equal(lyricTransitionAtTime(cues, 0, 8, 15, mode, 0.5).alpha, 0);
    near(lyricTransitionAtTime(cues, 0, 4.25, 15, mode, 0.5).alpha, 0.5);
    near(lyricTransitionAtTime(cues, 0, 7.75, 15, mode, 0.5).alpha, 0.5);
    assert.equal(lyricTransitionAtTime(cues, 0, 6, 15, mode, 0.5).alpha, 1);
    const initial = lyricTransitionAtTime(cues, 0, 4.125, 15, mode, 0.5);
    lyricTransitionAtTime(cues, 1, 14, 15, mode, 0.5);
    lyricTransitionAtTime(cues, 0, 7.95, 15, mode, 0.5);
    assert.deepEqual(lyricTransitionAtTime(cues, 0, 4.125, 15, mode, 0.5), initial);
  }
  const incomingUp = lyricTransitionAtTime(cues, 0, 4.25, 15, 'fade-up', 0.5);
  const outgoingUp = lyricTransitionAtTime(cues, 0, 7.75, 15, 'fade-up', 0.5);
  assert.ok(incomingUp.offsetY > 0 && outgoingUp.offsetY < 0);
  assert.equal(lyricTransitionAtTime(cues, 0, 4.25, 15, 'fade-down', 0.5).offsetY, -incomingUp.offsetY);
  assert.ok(lyricTransitionAtTime(cues, 0, 4.25, 15, 'fade-zoom', 0.5).scale < 1);
  assert.equal(lyricTransitionAtTime(cues, 0, 4, 15, 'none', 0.5).alpha, 1);
});

test('short cues compress transitions and honor subtitle gaps, next cue, and project end', () => {
  const cues: LyricCue[] = [{ time: 1, end: 1.1, text: 'Quick' }, { time: 3, end: 9, text: 'Second' }, { time: 4, text: 'Last' }];
  const middle = lyricTransitionAtTime(cues, 0, 1.05, 5, 'fade', 2);
  near(middle.duration, 0.05); near(middle.alpha, 1);
  assert.equal(lyricTransitionAtTime(cues, 0, 1.2, 5, 'fade', 2).alpha, 0);
  assert.equal(activeLyricIndex(cues, 2), -1, 'explicit SRT gaps display no cue');
  assert.equal(lyricTransitionAtTime(cues, 1, 4, 5, 'fade', 0.5).alpha, 0, 'next cue closes the preceding cue even if its explicit end overlaps');
  const last = lyricTransitionAtTime(cues, 2, 4.9, 5, 'fade', 0.5);
  assert.equal(last.end, 5); assert.ok(last.alpha > 0 && last.alpha < 1);
  assert.equal(lyricTransitionAtTime(cues, 2, 5, 5, 'fade', 0.5).alpha, 0);
  assert.equal(lyricTransitionAtTime([{ time: 4, end: 4, text: 'Zero' }], 0, 4, 5, 'fade', 0.5).alpha, 0);
});

test('shadow color alpha composes without changing the text or neighboring cue opacity', () => {
  assert.equal(colorWithOpacity('#2468ac', 0.5), 'rgba(36, 104, 172, 0.5)');
  assert.equal(colorWithOpacity('#abc', 0), 'rgba(170, 187, 204, 0)');
  assert.equal(colorWithOpacity('rgba(10, 20, 30, 0.5)', 0.4), 'rgba(10, 20, 30, 0.2)');
});

test('renderer isolates active and inactive opacity, outline, shadow, and custom font selection', () => {
  type Snapshot = { text: string; kind: 'fill' | 'stroke'; alpha: number; color: string; font: string; shadow: string; blur: number; x: number; y: number; lineWidth: number };
  const drawn: Snapshot[] = []; const stack: Record<string, unknown>[] = [];
  const keys = ['globalAlpha', 'fillStyle', 'strokeStyle', 'font', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'lineWidth', 'lineJoin', 'miterLimit', 'textAlign', 'textBaseline', 'filter'];
  const context: Record<string, any> = { canvas: { width: 1000, height: 900 }, globalAlpha: 1, shadowColor: 'rgba(0,0,0,0)', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, font: '', fillStyle: '', strokeStyle: '', lineWidth: 1,
    save: () => stack.push(Object.fromEntries(keys.map(key => [key, context[key]]))), restore: () => Object.assign(context, stack.pop()),
    setTransform: () => {}, translate: () => {}, rotate: () => {}, scale: () => {}, fillRect: () => {}, beginPath: () => {}, rect: () => {}, clip: () => {},
    measureText: (value: string) => ({ width: value.length * 10 }),
    fillText: (text: string) => record(text, 'fill'), strokeText: (text: string) => record(text, 'stroke'),
  };
  function record(text: string, kind: 'fill' | 'stroke'): void {
    drawn.push({ text, kind, alpha: context.globalAlpha, color: String(kind === 'fill' ? context.fillStyle : context.strokeStyle), font: context.font,
      shadow: context.shadowColor, blur: context.shadowBlur, x: context.shadowOffsetX, y: context.shadowOffsetY, lineWidth: context.lineWidth });
  }
  const project: DemoProject = { format: 'echo-demo', version: 1, width: 1000, height: 900, fps: 30, duration: 15, title: 'Title', artist: '', audio: null, cover: null,
    lyrics: [{ time: 0, text: 'Before', translation: '前' }, { time: 4, text: 'Now', translation: '现在' }, { time: 8, text: 'After', translation: '后' }], lyricsOffsetMs: 0,
    layers: [{ id: 'lyrics', type: 'lyrics', name: 'Lyrics', x: 500, y: 450, width: 1000, height: 900, rotation: 0, opacity: 0.75, visible: true, locked: false, start: 0, end: 15,
      params: { mode: 'scroll', lines: 3, fontId: 'noto-serif-sc', fontSize: 40, translationSize: 20, color: '#ff0000', translationColor: '#ffaaaa', activeOpacity: 0.8,
        activeStrokeWidth: 3, activeStrokeColor: '#123456', activeShadowEnabled: false,
        inactiveFontSize: 22, inactiveTranslationSize: 12, inactiveColor: '#00ff00', inactiveTranslationColor: '#aaffaa', inactiveOpacity: 0.25,
        inactiveStrokeWidth: 0, inactiveShadowEnabled: true, inactiveShadowColor: '#0000ff', inactiveShadowOpacity: 0.5, inactiveShadowBlur: 9, inactiveShadowX: -3, inactiveShadowY: 5 } },
    ] };
  renderScene(context as unknown as CanvasRenderingContext2D, project, 6, { cover: null, analysis: null });
  const now = drawn.find(value => value.text === 'Now' && value.kind === 'fill')!;
  const nowStroke = drawn.find(value => value.text === 'Now' && value.kind === 'stroke')!;
  const before = drawn.find(value => value.text === 'Before' && value.kind === 'fill')!;
  near(now.alpha, 0.6); near(before.alpha, 0.1875);
  assert.equal(now.color, '#ff0000'); assert.equal(before.color, '#00ff00');
  assert.match(now.font, /40px "VisikiFont_noto_serif_sc"/); assert.match(before.font, /22px "VisikiFont_noto_serif_sc"/);
  assert.equal(nowStroke.lineWidth, 6); assert.equal(nowStroke.color, '#123456');
  assert.equal(now.shadow, 'rgba(0, 0, 0, 0)'); assert.equal(now.blur, 0); assert.equal(now.x, 0); assert.equal(now.y, 0);
  assert.equal(before.shadow, 'rgba(0, 0, 255, 0.5)'); assert.equal(before.blur, 9); assert.equal(before.x, -3); assert.equal(before.y, 5);
  assert.deepEqual(drawn.filter(value => value.kind === 'stroke').map(value => value.text), ['Now', '现在']);
  assert.equal(context.globalAlpha, 1); assert.equal(context.shadowBlur, 0, 'no lyric shadow can leak into the next layer');
});
