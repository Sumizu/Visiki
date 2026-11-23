import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProject, makeLayer } from '../src/default-project';
import { resolveLyricStyle, updateLyricStyles } from '../src/lyric-style';
import { validateProject } from '../src/project-io';
import { renderScene } from '../src/scene';
import { canvasFont, fontWeight, resolveTextTypography, withCanvasFontSynthesis } from '../src/text-typography';
import type { LayerParams } from '../src/types';

test('legacy lyric and text weights keep synthesis disabled until their weight control is edited', () => {
  const active = resolveLyricStyle({}, true); const inactive = resolveLyricStyle({}, false);
  assert.deepEqual([active.fontWeight, active.translationFontWeight, inactive.fontWeight, inactive.translationFontWeight], [600, 500, 400, 400]);
  assert.ok([active, inactive].every(style => !style.fontWeightSynthesis && !style.translationFontWeightSynthesis && !style.italic && !style.translationItalic));
  assert.deepEqual(resolveTextTypography({ fontWeight: 600, italic: true }, 'fontWeight', 'italic', 400, 'fontWeightSynthesis'), { weight: 600, italic: true, synthesizeWeight: false });
  assert.deepEqual(resolveTextTypography({ fontWeight: 900, fontWeightSynthesis: true }, 'fontWeight', 'italic', 400, 'fontWeightSynthesis'), { weight: 900, italic: false, synthesizeWeight: true });
  assert.equal(fontWeight(1000), 900); assert.equal(fontWeight(0), 100); assert.equal(fontWeight(NaN, 600), 600);
  assert.equal(canvasFont(35, 'serif', { weight: 300, italic: true, synthesizeWeight: false }), 'italic 300 35px serif');
});

test('all four lyric typography controls remain independent through edits and undo snapshots', () => {
  const initial: LayerParams = { activeFontWeight: 100, activeTranslationFontWeight: 300, inactiveFontWeight: 700, inactiveTranslationFontWeight: 900,
    activeItalic: true, activeTranslationItalic: false, inactiveItalic: false, inactiveTranslationItalic: true };
  const before = structuredClone(initial);
  const active = resolveLyricStyle(initial, true); const inactive = resolveLyricStyle(initial, false);
  assert.deepEqual([active.fontWeight, active.translationFontWeight, inactive.fontWeight, inactive.translationFontWeight], [100, 300, 700, 900]);
  assert.deepEqual([active.italic, active.translationItalic, inactive.italic, inactive.translationItalic], [true, false, false, true]);
  assert.ok([active, inactive].every(style => style.fontWeightSynthesis && style.translationFontWeightSynthesis));
  const edited = updateLyricStyles(initial, { activeFontWeight: 800, activeTranslationItalic: true });
  assert.deepEqual(resolveLyricStyle(edited, false), inactive);
  assert.equal(resolveLyricStyle(edited, true).translationFontWeight, 300);
  assert.equal(resolveLyricStyle(edited, true).italic, true);
  assert.deepEqual(initial, before);
});

function inlineStyle(initial = '', initialPriority = '') {
  let value = initial; let priority = initialPriority;
  return {
    getPropertyValue: (_key: string) => value,
    getPropertyPriority: (_key: string) => priority,
    setProperty: (_key: string, next: string, nextPriority = '') => { value = next; priority = nextPriority; },
    removeProperty: (_key: string) => { const previous = value; value = ''; priority = ''; return previous; },
  };
}

test('canvas synthesis scopes preserve inline priority and reset identical font strings even on errors', () => {
  const style = inlineStyle('none', 'important');
  const assignments: string[] = []; let assigned = '600 40px serif';
  const ctx = { canvas: { style }, get font() { return assigned; }, set font(value: string) { assigned = value; assignments.push(value); } } as unknown as CanvasRenderingContext2D;
  withCanvasFontSynthesis(ctx, { weight: 800, italic: true, synthesizeWeight: true }, () => {
    assert.equal(style.getPropertyValue('font-synthesis'), 'weight style');
    assert.equal(ctx.font, '10px serif'); ctx.font = '800 40px serif';
    withCanvasFontSynthesis(ctx, { weight: 500, italic: true, synthesizeWeight: false }, () => assert.equal(style.getPropertyValue('font-synthesis'), 'style'));
    assert.equal(style.getPropertyValue('font-synthesis'), 'weight style');
  });
  assert.equal(style.getPropertyValue('font-synthesis'), 'none'); assert.equal(style.getPropertyPriority('font-synthesis'), 'important');
  assert.equal(ctx.font, '600 40px serif'); assert.equal(assignments[0], '10px serif');
  assert.throws(() => withCanvasFontSynthesis(ctx, { weight: 800, italic: false, synthesizeWeight: true }, () => { throw new Error('paint failed'); }));
  assert.equal(style.getPropertyValue('font-synthesis'), 'none'); assert.equal(style.getPropertyPriority('font-synthesis'), 'important');
  style.removeProperty('font-synthesis');
  withCanvasFontSynthesis(ctx, { weight: 400, italic: true, synthesizeWeight: false }, () => {});
  assert.equal(style.getPropertyValue('font-synthesis'), '', 'an inherited policy is restored by removing the temporary declaration');
});

test('rendering uses independent lyric, text and title typography for both measurement and paint', () => {
  const style = inlineStyle('none'); const drawn: { text: string; font: string; synthesis: string }[] = [];
  const measured: { font: string; synthesis: string }[] = [];
  const state: Record<string, any> = { canvas: { width: 1920, height: 1080, style }, globalAlpha: 1, font: '10px sans-serif' };
  const stack: Record<string, any>[] = [];
  const ctx = new Proxy(state, { get(target, key: string) {
    if (key in target) return target[key];
    if (key === 'save') return () => stack.push({ ...target });
    if (key === 'restore') return () => Object.assign(target, stack.pop());
    if (key === 'measureText') return (text: string) => { measured.push({ font: target.font, synthesis: style.getPropertyValue('font-synthesis') }); return { width: text.length * 10 }; };
    if (key === 'fillText') return (text: string) => drawn.push({ text, font: target.font, synthesis: style.getPropertyValue('font-synthesis') });
    return () => {};
  } }) as unknown as CanvasRenderingContext2D;
  const project = createDefaultProject();
  const lyrics = makeLayer('lyrics'); lyrics.height = 900;
  lyrics.params = { ...lyrics.params, mode: 'scroll', activeFontWeight: 900, activeItalic: true, activeTranslationFontWeight: 300,
    inactiveFontWeight: 200, inactiveTranslationFontWeight: 700, inactiveTranslationItalic: true };
  const text = makeLayer('text'); text.params = { ...text.params, text: 'independent text', fontWeight: 800, fontWeightSynthesis: true, italic: true };
  const metadata = makeLayer('title'); metadata.params = { ...metadata.params, italic: true, subtitleFontWeight: 900 };
  project.title = 'main title'; project.artist = 'subtitle'; project.layers = [lyrics, text, metadata];
  project.lyrics = [{ time: 0, text: 'previous', translation: 'previous translation' }, { time: 5, text: 'current', translation: 'current translation' }];
  renderScene(ctx, project, 6, { cover: null, analysis: null });
  const row = (value: string) => drawn.find(item => item.text === value)!;
  assert.match(row('current').font, /^italic 900 /); assert.equal(row('current').synthesis, 'weight style');
  assert.match(row('current translation').font, /^300 /); assert.equal(row('current translation').synthesis, 'weight');
  assert.match(row('previous').font, /^200 /); assert.equal(row('previous').synthesis, 'weight');
  assert.match(row('previous translation').font, /^italic 700 /); assert.equal(row('previous translation').synthesis, 'weight style');
  assert.match(row('independent text').font, /^italic 800 /); assert.equal(row('independent text').synthesis, 'weight style');
  assert.match(row('main title').font, /^italic 600 /); assert.equal(row('main title').synthesis, 'style', 'italic alone must not synthesize the legacy title weight');
  assert.match(row('subtitle').font, /^900 /); assert.equal(row('subtitle').synthesis, 'weight');
  assert.ok(measured.some(item => item.font.startsWith('italic 800 ') && item.synthesis === 'weight style'), 'text wrapping measures the exact painted font and policy');
  assert.equal(style.getPropertyValue('font-synthesis'), 'none');
});

test('typography validation saves every independent setting and rejects invalid weights or switches', () => {
  const project = createDefaultProject(); const text = makeLayer('text'); const lyrics = makeLayer('lyrics'); const title = makeLayer('title');
  text.params = { ...text.params, fontWeight: 100, italic: true, fontWeightSynthesis: true };
  lyrics.params = { ...lyrics.params, activeFontWeight: 900, activeTranslationFontWeight: 200, inactiveFontWeight: 300, inactiveTranslationFontWeight: 800,
    activeItalic: true, activeTranslationItalic: false, inactiveItalic: true, inactiveTranslationItalic: false };
  title.params = { ...title.params, fontWeight: 500, subtitleFontWeight: 700, italic: false, subtitleItalic: true };
  project.layers = [text, lyrics, title];
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))).layers.map(layer => layer.params), project.layers.map(layer => layer.params));
  const invalid: [number, LayerParams][] = [
    [0, { fontWeight: 99 }], [0, { fontWeight: 901 }], [0, { fontWeight: '600' }], [0, { italic: 1 }], [0, { fontWeightSynthesis: 'yes' }],
    [1, { activeFontWeight: 0 }], [1, { activeTranslationFontWeight: 901 }], [1, { inactiveFontWeight: -1 }], [1, { inactiveTranslationFontWeight: '400' }],
    [1, { activeItalic: 'yes' }], [1, { activeTranslationItalic: 1 }], [1, { inactiveItalic: 'true' }], [1, { inactiveTranslationItalic: 0 }],
    [2, { fontWeight: 950 }], [2, { subtitleFontWeight: '400' }], [2, { italic: 'false' }], [2, { subtitleItalic: 1 }],
  ];
  for (const [index, patch] of invalid) {
    const corrupted = structuredClone(project); Object.assign(corrupted.layers[index].params, patch);
    assert.throws(() => validateProject(corrupted), JSON.stringify(patch));
  }
  text.params = { text: 'legacy', fontWeight: 600 }; title.params = { fontSize: 26 }; lyrics.params = { mode: 'scroll' };
  const reopened = validateProject(project);
  assert.equal('fontWeightSynthesis' in reopened.layers[0].params, false);
  assert.equal('fontWeight' in reopened.layers[2].params, false);
  assert.equal('activeFontWeight' in reopened.layers[1].params, false, 'loading must not opt an old single-face font into synthetic weight');
});
