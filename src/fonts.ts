import type { DemoProject, FontAsset, LayerParams } from './types';
import { sfntWeightDescriptor } from './font-axis';

/** Freeze the legacy shared font before the first independent font edit. */
export function normalizeLyricFonts(params: LayerParams): LayerParams {
  return { ...params, translationFontId: typeof params.translationFontId === 'string' ? params.translationFontId : typeof params.fontId === 'string' ? params.fontId : '' };
}

export function resolveLyricFontIds(params: LayerParams): { original: string; translation: string } {
  const original = typeof params.fontId === 'string' ? params.fontId : '';
  return { original, translation: typeof params.translationFontId === 'string' ? params.translationFontId : original };
}

export const SYSTEM_FONT_FAMILY = '"Noto Sans CJK SC", "Microsoft YaHei", "Segoe UI", sans-serif';
const safeId = /^[a-zA-Z0-9-]{1,100}$/;
const nativeWeightFonts = new Set<string>();
export function fontFamilyForId(id?: string, useNativeWeight = false): string {
  return id && safeId.test(id) ? `"VisikiFont_${id.replaceAll('-', '_')}${useNativeWeight && nativeWeightFonts.has(id) ? '_Variable' : ''}", ${SYSTEM_FONT_FAMILY}` : SYSTEM_FONT_FAMILY;
}
const familyName = (id: string): string => `VisikiFont_${id.replaceAll('-', '_')}`;
export const BUILTIN_FONTS: FontAsset[] = [
  { id: 'noto-sans-sc', name: '思源黑体 · Noto Sans SC', type: 'font', family: familyName('noto-sans-sc'), url: '/fonts/NotoSansSC.ttf', builtin: true, license: 'SIL OFL 1.1', weight: '100 900' },
  { id: 'noto-serif-sc', name: '思源宋体 · Noto Serif SC', type: 'font', family: familyName('noto-serif-sc'), url: '/fonts/NotoSerifSC.ttf', builtin: true, license: 'SIL OFL 1.1', weight: '200 900' },
  { id: 'lxgw-wenkai', name: '霞鹜文楷', type: 'font', family: familyName('lxgw-wenkai'), url: '/fonts/LXGWWenKai-Regular.ttf', builtin: true, license: 'SIL OFL 1.1', weight: '400' },
  { id: 'zcool-xiaowei', name: '站酷小薇体', type: 'font', family: familyName('zcool-xiaowei'), url: '/fonts/ZCOOLXiaoWei-Regular.ttf', builtin: true, license: 'SIL OFL 1.1', weight: '400' },
  { id: 'zcool-kuaile', name: '站酷快乐体', type: 'font', family: familyName('zcool-kuaile'), url: '/fonts/ZCOOLKuaiLe-Regular.ttf', builtin: true, license: 'SIL OFL 1.1', weight: '400' },
  { id: 'ma-shan-zheng', name: '马善政楷书', type: 'font', family: familyName('ma-shan-zheng'), url: '/fonts/MaShanZheng-Regular.ttf', builtin: true, license: 'SIL OFL 1.1', weight: '400' },
  { id: 'long-cang', name: '龙藏行书', type: 'font', family: familyName('long-cang'), url: '/fonts/LongCang-Regular.ttf', builtin: true, license: 'SIL OFL 1.1', weight: '400' },
  { id: 'noto-sans-jp', name: 'Noto Sans JP · 日语黑体', type: 'font', family: familyName('noto-sans-jp'), url: '/fonts/NotoSansJP.ttf', builtin: true, license: 'SIL OFL 1.1', weight: '100 900' },
  { id: 'noto-serif-jp', name: 'Noto Serif JP · 日语明朝', type: 'font', family: familyName('noto-serif-jp'), url: '/fonts/NotoSerifJP.ttf', builtin: true, license: 'SIL OFL 1.1', weight: '200 900' },
  { id: 'zen-maru-gothic', name: 'Zen Maru Gothic · 日语圆体', type: 'font', family: familyName('zen-maru-gothic'), url: '/fonts/ZenMaruGothic-Regular.ttf', builtin: true, license: 'SIL OFL 1.1', weight: '400' },
  { id: 'klee-one', name: 'Klee One · 日语手写', type: 'font', family: familyName('klee-one'), url: '/fonts/KleeOne-Regular.ttf', builtin: true, license: 'SIL OFL 1.1', weight: '400' },
  { id: 'yusei-magic', name: 'Yusei Magic · 日语手写', type: 'font', family: familyName('yusei-magic'), url: '/fonts/YuseiMagic-Regular.ttf', builtin: true, license: 'SIL OFL 1.1', weight: '400' },
];
const loaded = new Map<string, Promise<void>>();
let loadedFontRevision = 0;
export const getLoadedFontRevision = (): number => loadedFontRevision;
export async function loadFont(asset: FontAsset): Promise<void> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') throw new Error('当前环境不支持字体加载');
  if (!safeId.test(asset.id)) throw new Error('字体 ID 无效');
  const builtin = BUILTIN_FONTS.find(font => font.id === asset.id);
  const url = builtin?.url ?? `/api/fonts/${asset.id}`;
  const key = `${asset.id}:${url}`;
  let pending = loaded.get(key);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`字体“${asset.name}”无法读取，请重新导入`);
      const buffer = await response.arrayBuffer();
      // Existing imported faces were registered as 400. Keep that family for
      // unedited projects; exposing its native range would silently turn their
      // old requested 600 into real 600. Explicit weight controls opt into the
      // additional family, while an italic-only edit keeps the legacy face.
      const descriptor = builtin?.weight ?? sfntWeightDescriptor(buffer);
      const faces = [new FontFace(familyName(asset.id), buffer, { weight: builtin?.weight ?? '400', style: 'normal' })];
      const nativeWeight = !builtin && descriptor !== '400';
      if (nativeWeight) faces.push(new FontFace(`${familyName(asset.id)}_Variable`, buffer, { weight: descriptor, style: 'normal' }));
      await Promise.all(faces.map(face => face.load()));
      for (const face of faces) document.fonts.add(face);
      if (nativeWeight) nativeWeightFonts.add(asset.id);
      loadedFontRevision++;
    })().catch(error => { loaded.delete(key); throw error instanceof Error ? error : new Error('字体加载失败'); });
    loaded.set(key, pending);
  }
  await pending;
}
export function collectProjectFonts(project: DemoProject, range?: { start: number; end: number }): FontAsset[] {
  const fonts = new Map([...BUILTIN_FONTS, ...(project.fonts ?? [])].map(font => [font.id, font]));
  const used = new Map<string, FontAsset>();
  for (const layer of project.layers) {
    if (!layer.visible || layer.opacity <= 0 || !['lyrics', 'title', 'text'].includes(layer.type) || (range && (layer.end <= range.start || layer.start >= range.end))) continue;
    let ids: (string | number | boolean | undefined)[];
    if (layer.type === 'lyrics') {
      const lyricFonts = resolveLyricFontIds(layer.params);
      ids = [project.lyrics.some(cue => cue.text.trim()) ? lyricFonts.original : ''];
      if (layer.params.mode !== 'single' && project.lyrics.some(cue => cue.translation?.trim())) ids.push(lyricFonts.translation);
    } else ids = layer.type === 'text' && !String(layer.params.text ?? '').trim() ? [] : [layer.params.fontId];
    for (const id of ids) {
      if (id === undefined || id === '') continue;
      const font = typeof id === 'string' ? fonts.get(id) : undefined;
      if (!font) throw new Error(`“${layer.name}”的字体引用已丢失，请重新选择字体`);
      used.set(font.id, font);
    }
  }
  return [...used.values()];
}
export async function loadProjectFonts(project: DemoProject, range?: { start: number; end: number }): Promise<void> {
  const results = await Promise.allSettled(collectProjectFonts(project, range).map(loadFont));
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
export async function uploadFont(file: File): Promise<FontAsset> {
  const data = new FormData(); data.append('file', file);
  const response = await fetch('/api/import/font', { method: 'POST', body: data });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '字体导入失败');
  const asset = value as FontAsset;
  await loadFont(asset);
  return asset;
}
