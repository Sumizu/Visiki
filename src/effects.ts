import type { EffectType, LayerEffect, LayerParams } from './types';

export const MAX_LAYER_EFFECTS = 8;
export interface EffectControl { key: string; label: string; min: number; max: number; step: number; suffix?: string; integer?: boolean }
export type EffectTarget = 'visual' | 'audio';
export interface EffectDefinition { type: EffectType; name: string; category: string; description: string; targets: readonly EffectTarget[]; controls: readonly EffectControl[] }
const c = (key: string, label: string, min: number, max: number, step: number, suffix?: string, integer = false): EffectControl => ({ key, label, min, max, step, suffix, integer });
const seed = c('seed', '随机种子', 1, 999999, 1, undefined, true);
const speed = c('speed', '变化速度', 0, 3, .05, '倍');
export const EFFECT_DEFINITIONS: readonly EffectDefinition[] = [
  { type: 'color', name: '基础调色', category: '调色', description: '曝光、对比度、色温与明暗层次', targets: ['visual'], controls: [
    c('exposure', '曝光', -2, 2, .05, 'EV'), c('brightness', '亮度', -.5, .5, .01), c('contrast', '对比度', 0, 2, .01), c('saturation', '饱和度', 0, 2, .01),
    c('temperature', '色温', -1, 1, .01), c('tint', '色调', -1, 1, .01), c('highlights', '高光', -1, 1, .01), c('shadows', '阴影', -1, 1, .01),
  ] },
  { type: 'film', name: '胶片质感', category: '质感', description: '颗粒、褪色、暗角与轻微闪烁', targets: ['visual'], controls: [
    c('grain', '颗粒强度', 0, 1, .01), c('grainSize', '颗粒大小', 1, 8, .5, 'px'), c('faded', '褪色', 0, .5, .01), c('vignette', '暗角', 0, 1, .01),
    c('flicker', '胶片闪烁', 0, .3, .01), c('scratches', '划痕', 0, 1, .01), speed, seed,
  ] },
  { type: 'rgb-split', name: 'RGB 分离', category: '风格', description: '红蓝通道错位与轻微色散', targets: ['visual'], controls: [
    c('offset', '分离距离', 0, 40, .5, 'px'), c('angle', '分离方向', -180, 180, 1, '°'), c('animated', '分离波动', 0, 1, .01), speed, seed,
  ] },
  { type: 'glitch', name: '数字故障', category: '风格', description: '间歇切片错位、色偏与数字干扰', targets: ['visual'], controls: [
    c('amount', '故障幅度', 0, 1, .01), c('blockSize', '切片高度', 4, 180, 1, 'px'), c('frequency', '触发频率', .1, 30, .1, '次/秒'), c('colorShift', '故障色偏', 0, 30, .5, 'px'), speed, seed,
  ] },
  { type: 'crt', name: 'CRT 显示器', category: '质感', description: '扫描线、屏幕曲面与暗角', targets: ['visual'], controls: [
    c('scanlines', '扫描线强度', 0, 1, .01), c('lineSpacing', '扫描线间距', 1, 12, .5, 'px'), c('vignette', '屏幕暗角', 0, 1, .01),
    c('curvature', '屏幕曲率', 0, .3, .01), c('flicker', '屏幕闪烁', 0, .2, .01), speed, seed,
  ] },
  { type: 'audio-reactive', name: '音乐呼吸／频段联动', category: '音乐联动', description: '跟随全频、低中高频或自定义频段，联动缩放、亮度与透明度', targets: ['visual'], controls: [
    c('band', '驱动频段', 0, 4, 1, undefined, true), c('lowHz', '最低频率', 20, 20000, 1, 'Hz'), c('highHz', '最高频率', 20, 20000, 1, 'Hz'),
    c('sensitivity', '灵敏度', 0, 5, .05), c('threshold', '触发阈值', 0, 1, .01),
    c('attack', '响应时间', 0, 1, .01, '秒'), c('release', '回落时间', 0, 2, .01, '秒'),
    c('scale', '缩放幅度', 0, .5, .01), c('brightness', '亮度幅度', 0, 1, .01), c('opacity', '透明度变化', 0, 1, .01),
  ] },
  { type: 'fade', name: '淡入淡出', category: '过渡', description: '画面渐显、滑入与缩放；音轨音量淡入淡出', targets: ['visual', 'audio'], controls: [
    c('fadeIn', '淡入时长', 0, 10, .05, '秒'), c('fadeOut', '淡出时长', 0, 10, .05, '秒'),
    c('style', '过渡样式', 0, 5, 1, undefined, true), c('curve', '变化曲线', 0, 2, 1, undefined, true),
    c('timing', '过渡范围', 0, 1, 1, undefined, true), c('distance', '移动距离', 0, 200, 1, 'px'),
  ] },
];
const DEFAULTS: Record<EffectType, LayerParams> = {
  color: { exposure: 0, brightness: 0, contrast: 1, saturation: 1, temperature: 0, tint: 0, highlights: 0, shadows: 0 },
  film: { grain: .18, grainSize: 2, faded: .08, vignette: .22, flicker: .03, scratches: .1, speed: 1, seed: 41729 },
  'rgb-split': { offset: 6, angle: 0, animated: .25, speed: 1, seed: 41729 },
  glitch: { amount: .4, blockSize: 36, frequency: 8, colorShift: 7, speed: 1, seed: 41729 },
  crt: { scanlines: .25, lineSpacing: 3, vignette: .2, curvature: .08, flicker: .01, speed: 1, seed: 41729 },
  'audio-reactive': { band: 0, lowHz: 35, highHz: 250, sensitivity: 1.5, threshold: .08, attack: .06, release: .3, scale: .08, brightness: .12, opacity: 0 },
  fade: { fadeIn: .5, fadeOut: .5, style: 0, curve: 0, timing: 0, distance: 24 },
};
export const COLOR_EFFECT_PRESETS: readonly { value: string; label: string; params: LayerParams }[] = [
  { value: 'neutral', label: '还原原色', params: { ...DEFAULTS.color } },
  { value: 'warm', label: '暖调柔光', params: { ...DEFAULTS.color, temperature: .3, contrast: .94, saturation: .93, shadows: .13 } },
  { value: 'cool', label: '清冷蓝调', params: { ...DEFAULTS.color, temperature: -.3, tint: .04, contrast: 1.08, saturation: .86 } },
  { value: 'mono', label: '黑白影调', params: { ...DEFAULTS.color, saturation: 0, contrast: 1.15 } },
  { value: 'faded', label: '低饱和褪色', params: { ...DEFAULTS.color, contrast: .8, saturation: .6, shadows: .22, highlights: -.12 } },
];
const definition = (type: EffectType) => EFFECT_DEFINITIONS.find(item => item.type === type)!;
export function effectDefaults(type: EffectType): LayerParams { return { ...DEFAULTS[type] }; }
export function effectSupportsTarget(type: EffectType, target: EffectTarget): boolean { return definition(type)?.targets.includes(target) ?? false; }
export function makeEffect(type: EffectType): LayerEffect { return { id: crypto.randomUUID(), type, enabled: true, strength: 1, params: effectDefaults(type) }; }
export function cloneEffects(effects: readonly LayerEffect[]): LayerEffect[] { return effects.map(effect => ({ ...effect, id: crypto.randomUUID(), params: { ...effect.params } })); }
export function resetEffect(effect: LayerEffect): LayerEffect { return { ...effect, enabled: true, strength: 1, params: effectDefaults(effect.type) }; }
export function resolveEffect(effect: LayerEffect): LayerEffect {
  const defaults = effectDefaults(effect.type); const params = { ...defaults };
  for (const control of definition(effect.type).controls) {
    const raw = effect.params?.[control.key];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(control.min, Math.min(control.max, raw)) : Number(defaults[control.key]);
    params[control.key] = control.integer ? Math.round(value) : value;
  }
  return { ...effect, enabled: effect.enabled !== false, strength: Number.isFinite(effect.strength) ? Math.max(0, Math.min(1, effect.strength)) : 1, params };
}
export function isEffectActive(effect: LayerEffect): boolean {
  if (!effect.enabled || effect.strength <= 0) return false;
  const p = effect.params;
  switch (effect.type) {
    case 'color': return Object.entries(DEFAULTS.color).some(([key, value]) => p[key] !== value);
    case 'film': return ['grain', 'faded', 'vignette', 'flicker', 'scratches'].some(key => Number(p[key]) > 0);
    case 'rgb-split': return Number(p.offset) > 0;
    case 'glitch': return Number(p.amount) > 0;
    case 'crt': return ['scanlines', 'vignette', 'curvature', 'flicker'].some(key => Number(p[key]) > 0);
    case 'audio-reactive': return Number(p.sensitivity) > 0 && Number(p.threshold) < 1 && ['scale', 'brightness', 'opacity'].some(key => Number(p[key]) > 0);
    case 'fade': return Number(p.fadeIn) > 0 || Number(p.fadeOut) > 0;
  }
}

/** Audio targets accept envelopes, never image-processing or music-driven effects. */
export function validateAudioEffects(value: unknown): LayerEffect[] {
  const effects = validateLayerEffects(value);
  if (effects.some(effect => !effectSupportsTarget(effect.type, 'audio'))) throw new Error('主音轨仅支持淡入淡出效果');
  return effects;
}
export function activeLayerEffects(effects: readonly LayerEffect[] = []): LayerEffect[] { return effects.filter(effect => EFFECT_DEFINITIONS.some(item => item.type === effect.type)).map(resolveEffect).filter(isEffectActive); }

/** Project input boundary. Missing effects must stay missing for legacy save compatibility. */
export function validateLayerEffects(value: unknown): LayerEffect[] {
  if (!Array.isArray(value) || value.length > MAX_LAYER_EFFECTS) throw new Error(`轨道效果需要数组，最多 ${MAX_LAYER_EFFECTS} 项`);
  const ids = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('轨道效果字段无效');
    const effect = item as Record<string, unknown>;
    const def = EFFECT_DEFINITIONS.find(entry => entry.type === effect.type);
    if (!def || typeof effect.id !== 'string' || !effect.id || effect.id.length > 120 || ids.has(effect.id) || typeof effect.enabled !== 'boolean' || typeof effect.strength !== 'number' || !Number.isFinite(effect.strength) || effect.strength < 0 || effect.strength > 1 || !effect.params || typeof effect.params !== 'object' || Array.isArray(effect.params)) throw new Error('轨道效果类型、标识、开关或强度无效');
    const params = effect.params as Record<string, unknown>;
    if (Object.keys(params).length > 32) throw new Error('轨道效果参数过多');
    for (const [key, raw] of Object.entries(params)) {
      const control = def.controls.find(entry => entry.key === key);
      if (!control || typeof raw !== 'number' || !Number.isFinite(raw) || raw < control.min || raw > control.max || (control.integer && !Number.isInteger(raw))) throw new Error(`轨道效果参数无效：${key}`);
    }
    ids.add(effect.id);
    return resolveEffect(effect as unknown as LayerEffect);
  });
}
