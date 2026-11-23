import type { DemoProject, EffectType, Layer, LayerEffect, LayerParams, LayerType } from './types';
import { makeLayer } from './default-project';
import { makeEffect } from './effects';
import { atmosphereDefaults } from './atmosphere';
import { particleDefaults } from './particles';
import { migrateLegacyFade } from './effect-migration';

export interface ProjectTemplate {
  readonly id: string;
  readonly name: string;
  readonly accent: string;
}

/** Only metadata is shared. Applying a template creates independently editable layers. */
export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = Object.freeze([
  { id: 'vinyl-room', name: '模板1', accent: '#d5b492' },
  { id: 'paper-poem', name: '模板2', accent: '#89775e' },
  { id: 'neon-night', name: '模板3', accent: '#73e4ed' },
  { id: 'sunset-film', name: '模板4', accent: '#df9a70' },
  { id: 'mist-forest', name: '模板5', accent: '#b8d9ba' },
  { id: 'pulse-radio', name: '模板6', accent: '#d0ff76' },
].map(template => Object.freeze(template)));

export interface TemplateApplyOptions { keepCustomLayers?: boolean }

type Box = readonly [x: number, y: number, width: number, height: number];
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const effect = (type: EffectType, params: LayerParams, strength = 1): LayerEffect => {
  const value = makeEffect(type);
  return { ...value, strength, params: { ...value.params, ...params } };
};

/** Preserve the user's content and rebuild only the presentation. No source references escape. */
export function applyProjectTemplate(project: DemoProject, id: string, options: TemplateApplyOptions = {}): DemoProject {
  if (!PROJECT_TEMPLATES.some(template => template.id === id)) throw new Error('找不到所选模板');
  const result = structuredClone(project);
  const customLayers = options.keepCustomLayers === false ? [] : result.layers.filter(layer =>
    (layer.type === 'text' || layer.type === 'video') && !layer.params.templateId);
  const w = result.width; const h = result.height; const portrait = w / h < 1.15;
  const scale = Math.min(w / (portrait ? 1080 : 1920), h / (portrait ? 1920 : 1080));
  const px = (value: number, minimum = 0, maximum = Infinity): number => clamp(value * scale, minimum, maximum);
  const font = (value: number): number => px(value, 8, 300);
  const cover = result.cover ?? result.images?.[0];
  const binding: LayerParams = { imageId: cover?.id ?? '', followCover: !!result.cover || !cover };
  // Reuse an explicitly selected background video, never an unrelated library item.
  const videoBackground = [...result.layers].reverse().find(layer => layer.type === 'background'
    && layer.params.backgroundType === 'video' && result.videos?.some(video => video.id === layer.params.videoId));
  const layers: Layer[] = [];
  const box = (landscape: Box, vertical: Box): Box => portrait ? vertical : landscape;
  function put(type: LayerType, name: string, area: Box, params: LayerParams = {}, effects?: LayerEffect[]): Layer {
    const layer = makeLayer(type, result.duration);
    const [x, y, width, height] = area;
    Object.assign(layer, { name, x: w * x, y: h * y, width: Math.max(1, w * width), height: Math.max(1, h * height) });
    layer.params = { ...layer.params, ...params, templateId: id };
    if (effects !== undefined) layer.effects = effects;
    layers.push(layer);
    return layer;
  }
  function square(type: 'image' | 'disc', name: string, area: Box, params: LayerParams = {}, effects?: LayerEffect[]): Layer {
    const layer = put(type, name, area, { ...binding, ...params }, effects);
    layer.width = layer.height = Math.min(layer.width, layer.height);
    return layer;
  }
  const full: Box = [.5, .5, 1, 1];
  const fade = () => effect('fade', { fadeIn: .45, fadeOut: .65, timing: 1 });
  function background(color: string, image = false, params: LayerParams = {}, inheritVideo = false, effects?: LayerEffect[]): void {
    const media: LayerParams = image ? { ...binding } : { imageId: '', followCover: false };
    if (inheritVideo && videoBackground) {
      media.backgroundType = 'video'; media.imageId = ''; media.followCover = false;
      for (const key of ['videoId', 'playbackRate', 'reverse', 'videoLoop', 'fit']) {
        if (videoBackground.params[key] !== undefined) media[key] = videoBackground.params[key];
      }
    }
    put('background', '模板背景', full, { backgroundType: image ? 'image' : 'color', color, blur: px(48), brightness: .28, ...params, ...media }, effects);
  }
  function atmosphere(kind: 'leak' | 'fog' | 'rays', preset: string, params: LayerParams): void {
    put('atmosphere', kind === 'fog' ? '薄雾' : kind === 'rays' ? '光束' : '边光', full,
      { ...atmosphereDefaults(kind, preset), fadeIn: 0, fadeOut: 0, ...params }, [fade()]);
  }
  function title(area: Box, color: string, size: number, fontId = 'noto-sans-sc', params: LayerParams = {}): void {
    const layer = put('title', '曲目信息', area, { color, fontId, fontSize: font(size), fontWeight: 600, subtitleFontWeight: 400, ...params }, [fade()]);
    // The artist starts at 1.45 × font size and the title renderer has a 4 px inset.
    layer.height = Math.max(layer.height, Math.min(h * .2, Number(layer.params.fontSize) * 2.1 + 6));
    layer.y = clamp(layer.y, layer.height / 2, h - layer.height / 2);
  }
  function lyrics(area: Box, color: string, translationColor: string, size = 40, fontId = 'noto-sans-sc', params: LayerParams = {}): void {
    const layer = put('lyrics', params.mode === 'single' ? '单句歌词' : params.mode === 'bilingual' ? '双语歌词' : '滚动双语歌词', area, {
      fontId, translationFontId: fontId, mode: 'scroll', lines: 3, align: 'center',
      fontSize: font(size), translationSize: font(size * .61),
      inactiveFontSize: font(size * .74), inactiveTranslationSize: font(size * .48),
      color, translationColor, inactiveColor: color, inactiveTranslationColor: translationColor,
      activeOpacity: 1, inactiveOpacity: .32, activeFontWeight: 600, inactiveFontWeight: 400,
      activeTranslationFontWeight: 400, inactiveTranslationFontWeight: 400,
      activeShadowEnabled: false, inactiveShadowEnabled: false, activeShadowBlur: 0, inactiveShadowBlur: 0,
      activeStrokeWidth: 0, inactiveStrokeWidth: 0, lineGap: px(18), translationGap: px(7),
      planeYaw: 0, planePerspective: 0, ...params,
    });
    // Single modes reserve only their active cue. Scrolling modes also reserve
    // the neighbors when the first/last active cue is centered in the display.
    const originalRows = Math.max(1, ...result.lyrics.map(cue => cue.text.split(/\r?\n/).filter(line => line.trim()).length));
    const translatedRows = layer.params.mode === 'single' ? 0
      : Math.max(0, ...result.lyrics.map(cue => (cue.translation ?? '').split(/\r?\n/).filter(line => line.trim()).length));
    const occupiedHalf = (): number => {
      const p = layer.params;
      const active = Number(p.fontSize) * 1.23 * originalRows + Number(p.translationSize) * 1.23 * translatedRows + (translatedRows ? Number(p.translationGap) : 0);
      const inactive = Number(p.inactiveFontSize) * 1.23 * originalRows + Number(p.inactiveTranslationSize) * 1.23 * translatedRows + (translatedRows ? Number(p.translationGap) : 0);
      return p.mode === 'single' || p.mode === 'bilingual' ? active / 2 : active / 2 + 2 * inactive + 2 * Number(p.lineGap);
    };
    const room = Math.max(1, layer.height / 2 - px(10));
    const reduction = Math.min(1, room / Math.max(1, occupiedHalf()));
    if (reduction < 1) {
      for (const key of ['fontSize', 'translationSize', 'inactiveFontSize', 'inactiveTranslationSize']) layer.params[key] = Math.max(8, Number(layer.params[key]) * reduction);
      for (const key of ['lineGap', 'translationGap']) layer.params[key] = Number(layer.params[key]) * reduction;
    }
    if (occupiedHalf() > room) layer.params.lines = 1;
    Object.assign(layer, migrateLegacyFade(layer));
  }
  function spectrum(area: Box, mode: string, color: string, params: LayerParams = {}): void {
    put('spectrum', mode === 'ecg-wave' ? '心电单曲线' : mode === 'dual-wave' ? '交错双曲线' : mode === 'wave' ? '振幅包络' : '节拍频谱', area,
      { mode, color, gain: 1.3, barCount: 96, smoothing: .68, lineWidth: px(2.8, .5, 8), flowSpeed: .8, envelopeWindow: 1.8, ...params });
  }
  function player(area: Box, color: string): void { put('player', '播放进度', area, { color, progress: true, time: true }); }

  switch (id) {
    case 'vinyl-room': {
      background('#28242a', true);
      atmosphere('leak', 'warm-edge', { intensity: .18, speed: .2, color: '#d5ae83', secondaryColor: '#9e6e7c' });
      put('image', '专辑封面', box([.265, .43, .31, .65], [.285, .25, .4, .25]), { ...binding, radius: px(5), shadow: true, shadowOpacity: .38 }, [fade()]);
      square('disc', '黑胶唱片', box([.73, .28, .28, .47], [.72, .25, .43, .27]), { skin: 'vinyl', rpm: 6, tonearm: true, labelRatio: .46 });
      title(box([.265, .83, .33, .1], [.5, .44, .82, .075]), '#f5e6d8', 34);
      lyrics(box([.73, .66, .44, .39], [.5, .655, .86, .29]), '#fff4eb', '#cbbbad', 38);
      spectrum(box([.265, .94, .4, .055], [.5, .875, .82, .06]), 'bars', '#d5b492', { barCount: 72 });
      player(box([.73, .925, .37, .09], [.5, .955, .80, .06]), '#e9d6c5');
      break;
    }
    case 'paper-poem': {
      background('#f5f1e9');
      title(box([.25, .15, .34, .075], [.37, .15, .60, .065]), '#6b695e', 28, 'noto-serif-sc', { fontWeight: 400 });
      lyrics(box([.5, .49, .82, .32], [.5, .49, .84, .32]), '#363a31', '#8b877c', 88, 'noto-serif-sc', {
        mode: 'single', lines: 1, activeFontWeight: 400, transition: 'fade', transitionDuration: .5,
      });
      spectrum(box([.5, .84, .26, .025], [.5, .82, .42, .025]), 'bars', '#b3a995', { gain: .65, barCount: 40 });
      break;
    }
    case 'neon-night': {
      background('#101426', true, { blur: 0, brightness: .62 }, true);
      put('particles', '星尘', full, { ...particleDefaults('stardust'), count: 18, size: px(2.5, 1, 40), particleOpacity: .22, color: '#c3e4ee', speed: .24 });
      title(box([.27, .11, .40, .075], [.42, .10, .70, .055]), '#e5eef2', 28);
      lyrics(box([.5, .79, .86, .20], [.5, .78, .88, .20]), '#ffffff', '#e5edf3', 54, 'noto-sans-sc', {
        mode: 'single', lines: 1, activeFontWeight: 500, transition: 'fade-up', transitionDuration: .4,
        activeStrokeWidth: px(1.2), activeStrokeColor: '#080e1b',
        activeShadowEnabled: true, activeShadowBlur: px(12, 0, 100), activeShadowOpacity: .8,
      });
      spectrum(box([.5, .945, .88, .025], [.5, .93, .88, .035]), 'bars', '#d3edf2', { gain: .85, barCount: 128 });
      break;
    }
    case 'sunset-film': {
      background('#3d2d2c', true, { blur: 0, brightness: .55 }, true, [
        effect('color', { saturation: .76, temperature: .20, contrast: .94 }),
        effect('film', { grain: .06, grainSize: 1.5, faded: .06, vignette: .12, flicker: .004, scratches: 0 }, .75),
      ]);
      atmosphere('leak', 'warm-edge', { intensity: .16, color: '#efb17e', secondaryColor: '#af7479', speed: .16, sourceX: .97 });
      title(box([.285, .15, .40, .085], [.43, .13, .70, .07]), '#f5dec9', 34, 'noto-serif-sc', { fontWeight: 500 });
      lyrics(box([.36, .56, .55, .53], [.47, .51, .78, .52]), '#fff0df', '#e3c7b1', 48, 'noto-serif-sc', {
        align: 'left', inactiveOpacity: .38, lineGap: px(20), activeFontWeight: 500,
        activeStrokeWidth: px(.8), activeStrokeColor: '#281a15', inactiveStrokeWidth: px(.7), inactiveStrokeColor: '#281a15',
        activeShadowEnabled: true, inactiveShadowEnabled: true, activeShadowBlur: px(10, 0, 100), inactiveShadowBlur: px(8, 0, 100),
      });
      spectrum(box([.285, .91, .40, .055], [.40, .885, .64, .055]), 'wave', '#dfb695', { gain: 1.05, envelopeWindow: 2.3, smoothing: .78 });
      break;
    }
    case 'mist-forest': {
      background('#0b151b');
      atmosphere('rays', 'radial-rays', { intensity: .45, color: '#8ac5d1', secondaryColor: '#d1dfef', sourceX: .5, sourceY: .02, spread: 92, rayCount: 8, speed: .14, length: 1.5 });
      atmosphere('fog', 'cool-mist', { intensity: .15, density: .28, color: '#a3c8cf', secondaryColor: '#547e89', speed: .15 });
      title(box([.265, .12, .37, .08], [.40, .12, .66, .065]), '#a5c4ce', 28, 'lxgw-wenkai', { fontWeight: 400 });
      lyrics(box([.5, .44, .82, .28], [.5, .43, .86, .31]), '#e8f8fb', '#b9d4df', 76, 'lxgw-wenkai', {
        mode: 'bilingual', lines: 1, activeFontWeight: 400, activeTranslationFontWeight: 400, translationSize: font(28),
        transition: 'fade-zoom', transitionDuration: .65,
        glowEnabled: true, glowColor: '#a6d7e5', glowIntensity: .18, glowRadius: px(10, 0, 80),
      });
      spectrum(box([.5, .77, .90, .18], [.5, .77, .90, .17]), 'dual-wave', '#a6d7e5', { flowSpeed: .45, gain: 1.45, smoothing: .82 });
      break;
    }
    case 'pulse-radio': {
      background('#131713');
      square('image', '电台封面', box([.13, .18, .13, .20], [.15, .13, .20, .15]), { mask: 'rounded', radius: px(12), shadow: false });
      title(box([.55, .185, .61, .135], [.61, .135, .62, .09]), '#e7e9df', 54, 'noto-sans-sc', { fontWeight: 800 });
      lyrics(box([.5, .505, .82, .44], [.5, .49, .86, .48]), '#e8ffbd', '#b1c39a', 62, 'noto-sans-sc', { activeFontWeight: 800, inactiveFontWeight: 500, inactiveOpacity: .21, lineGap: px(25) });
      spectrum(box([.5, .83, .84, .15], [.5, .815, .86, .15]), 'ecg-wave', '#d0ff76', { envelopeWindow: 2.1, smoothing: .35, gain: 1.7 });
      player(box([.5, .965, .82, .05], [.5, .955, .82, .06]), '#a9ba8e');
      break;
    }
  }
  if (layers.length + customLayers.length > 100) throw new Error('套用模板后将超过 100 条轨道，请取消保留额外文字与视频，或先减少轨道');
  result.layers = [...layers, ...customLayers];
  return result;
}
