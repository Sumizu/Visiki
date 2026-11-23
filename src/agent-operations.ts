import type { DemoProject, EffectType, FontAsset, Layer, LayerParams, LayerType, MediaAsset } from './types';
import { makeLayer } from './default-project';
import { effectSupportsTarget, EFFECT_DEFINITIONS, makeEffect, validateAudioEffects, validateLayerEffects } from './effects';
import { normalizeLyricFonts } from './fonts';
import { updateLyricStyles } from './lyric-style';
import { mergeBilingual, parseLyrics } from './lyrics';
import { moveLayer } from './layer-timing';
import { validateProject } from './project-io';
import { resizeProjectDuration, setVideoRate, splitVideoLayer } from './video-timing';

/** One batch becomes one editor history entry. These operations never commit themselves. */
export const AGENT_OPERATION_TYPES = Object.freeze([
  'update_project', 'add_layer', 'update_layer', 'remove_layer', 'reorder_layer',
  'split_video', 'video_rate', 'move_layer', 'attach_asset', 'set_lyrics', 'add_effect',
] as const);

/** Machine-readable discovery: field names here match the strict transaction boundary below. */
export const AGENT_OPERATION_FIELDS = Object.freeze({
  update_project: {
    required: ['op', 'changes'], optional: [],
    fields: {
      op: { type: 'string', enum: ['update_project'], description: '修改工程参数。' },
      changes: { type: 'object', description: '局部合并；仅允许 title/artist:string，duration:秒（至少一工程帧、最多3600），width:整数320–3840，height:整数180–3840，fps:1–60，lyricsOffsetMs:-3600000–3600000，audioMuted:boolean，audioEffects:完整效果数组。效果对象为{id,type,enabled,strength,params}，主音轨仅支持fade。' },
    },
    notes: ['尺寸变化保留现有图层坐标及尺寸；不自动缩放。', '缩短duration会移除超出区间的图层，并按原有源时间映射裁剪视频。', 'audioEffects替换完整效果栈；空数组清空。'],
    example: { op: 'update_project', changes: { title: '新歌名', width: 1920, height: 1080, fps: 30, lyricsOffsetMs: 200 } },
  },
  add_layer: {
    required: ['op', 'layerType'], optional: ['changes', 'params'],
    fields: {
      op: { type: 'string', enum: ['add_layer'], description: '新增组件；返回工程中的新图层ID供后续操作使用。' },
      layerType: { type: 'string', enum: ['background', 'image', 'video', 'disc', 'lyrics', 'spectrum', 'player', 'title', 'text', 'particles', 'atmosphere'], description: '组件类型。' },
      changes: { type: 'object', description: '可选图层字段：name、x/y（中心坐标px）、width/height（px）、rotation（度）、opacity（0–1）、visible/locked（boolean）、start/end（工程秒）、params（局部参数）、effects（完整效果栈）、effectTimeOffset（秒）。禁止指定id/type。' },
      params: { type: 'object', description: '所选组件的参数局部对象，值只能是string/number/boolean；例如text:{text,fontSize,color,fontId}，image:{imageId,fit,mask}，lyrics:{mode,fontSize,inactiveFontSize}。与changes.params不能有重复键。' },
    },
    notes: ['默认几何按当前画布与1920×1080的比例缩放；新增图层位于最上方。最多100个图层。', 'video必须给出已附加素材的videoId；源入点sourceIn默认0，源出点sourceOut默认素材全长，playbackRate默认1，reverse默认false。终点由源范围÷速度计算，可自动延长工程至最多3600秒；显式end必须与计算一致。', '图片需绑定imageId或followCover:true；仅导入素材不会自动添加图片组件。', 'background默认locked:true；创建后继续修改内容需先单独解锁。effects数组中的对象为{id,type,enabled,strength,params}。'],
    example: { op: 'add_layer', layerType: 'text', changes: { name: '署名', x: 960, y: 900, width: 800, height: 120, start: 0, end: 10 }, params: { text: '音乐，让画面流动', fontSize: 48, color: '#ffffff', align: 'center' } },
  },
  update_layer: {
    required: ['op', 'id', 'changes'], optional: [],
    fields: {
      op: { type: 'string', enum: ['update_layer'], description: '按已有图层ID修改组件。' },
      id: { type: 'string', description: '当前工程中的图层ID；先读取工程，不使用名称代替。' },
      changes: { type: 'object', description: '允许name、x、y、width、height、rotation、opacity、visible、locked、start、end、params、effects、effectTimeOffset。params为局部合并；effects为完整替换。禁止id/type及未知键。坐标为组件中心px，时间为工程秒，opacity为0–1。' },
    },
    notes: ['锁定图层仅允许修改locked/visible；需在一项操作中{locked:false}，再用下一项修改其他内容，可放在同一批。', '歌词播放中/非当前样式独立：fontSize/color控制播放中，inactiveFontSize/inactiveColor控制非当前；译文使用translationSize/translationFontId/inactiveTranslationSize。', '视频源区间、速度或起点变化会重新计算终点；若同时指定end，须自行保持(end-start)=(sourceOut-sourceIn)/playbackRate。正放/倒放用params.reverse布尔开关。移动整段并保持长度宜用move_layer。'],
    example: { op: 'update_layer', id: 'existing-layer-id', changes: { x: 960, y: 700, params: { fontSize: 72, inactiveFontSize: 44, planeYaw: -20, planePerspective: 150 } } },
  },
  remove_layer: {
    required: ['op', 'id'], optional: [],
    fields: { op: { type: 'string', enum: ['remove_layer'], description: '移除一个图层。' }, id: { type: 'string', description: '当前工程中未锁定的图层ID。' } },
    notes: ['仅移除组件；素材库、音乐和歌词保留。锁定图层需先解锁。'],
    example: { op: 'remove_layer', id: 'existing-layer-id' },
  },
  reorder_layer: {
    required: ['op', 'id', 'index'], optional: [],
    fields: {
      op: { type: 'string', enum: ['reorder_layer'], description: '改变图层叠放顺序。' },
      id: { type: 'string', description: '当前工程中未锁定的图层ID。' },
      index: { type: 'integer', description: '重排后的数组索引，范围0至图层数-1；0最底层，数值越大越靠前。' },
    },
    notes: ['不改变组件位置、出现时间或任何素材引用。'],
    example: { op: 'reorder_layer', id: 'existing-layer-id', index: 0 },
  },
  split_video: {
    required: ['op', 'id', 'at'], optional: [],
    fields: {
      op: { type: 'string', enum: ['split_video'], description: '在指定时间切分视频组件。' },
      id: { type: 'string', description: '未锁定的video类型图层ID；背景视频不属于可切片视频组件。' },
      at: { type: 'number', description: '工程时间秒，必须位于该片段内部，切分后左右各至少保留一工程帧。' },
    },
    notes: ['保留正放或倒放的源时间连续性、播放速度和效果；左段保留原ID，右段生成新ID及独立效果ID。'],
    example: { op: 'split_video', id: 'existing-video-layer-id', at: 5 },
  },
  video_rate: {
    required: ['op', 'id', 'rate'], optional: [],
    fields: {
      op: { type: 'string', enum: ['video_rate'], description: '修改视频片段播放速度，保留源区间。' },
      id: { type: 'string', description: '未锁定的video类型图层ID。背景调速请用update_layer params.playbackRate，背景时长不随速度改变。' },
      rate: { type: 'number', description: '播放倍速0.1–8；0.5为半速，2为两倍速。倒放独立使用update_layer params.reverse:true。' },
    },
    notes: ['保持起点及sourceIn/sourceOut，重新计算终点，必要时延长工程。结果不得短于一工程帧或超出3600秒；不合法时整批拒绝。'],
    example: { op: 'video_rate', id: 'existing-video-layer-id', rate: 0.5 },
  },
  move_layer: {
    required: ['op', 'id', 'start'], optional: [],
    fields: {
      op: { type: 'string', enum: ['move_layer'], description: '移动任意未锁定组件在时间线上的出现区间。' },
      id: { type: 'string', description: '当前工程中的未锁定图层ID。' },
      start: { type: 'number', description: '目标起点，单位工程秒，非负；按当前工程帧吸附；移动后的终点须不超过3600秒。' },
    },
    notes: ['保持组件长度及视频源区间、播放速度；必要时延长工程。歌词仍按配乐时间同步，校准歌词时间需修改lyricsOffsetMs。'],
    example: { op: 'move_layer', id: 'existing-layer-id', start: 12.5 },
  },
  attach_asset: {
    required: ['op', 'asset'], optional: ['role'],
    fields: {
      op: { type: 'string', enum: ['attach_asset'], description: '把已导入本机的素材引用附加到当前工程；此操作不上传或下载文件。' },
      asset: { type: 'object', description: '使用导入接口返回的原始素材对象。媒体字段:id/name/type/url，以及duration/sampleRate/channels/sampleCount/width/height/fps/posterUrl等实际元数据。type为audio/image/video/font；video必须有真实duration/width/height；audio必须有duration；自定义font必须为UUID并含name，可含family/url。链接和字体family会归一化为本机素材路由。' },
      role: { type: 'string', enum: ['audio', 'cover', 'library'], description: 'audio仅允许audio（默认）；image默认library，也可cover；video/font仅允许library（默认）。' },
    },
    notes: ['音频替换主配乐，并按实际音乐时长调整完整非视频轨道；已有视频片段会保留并可能使工程比配乐更长。', '图片进入images，role=cover同时设置默认封面；视频进入videos，字体进入fonts。重复附加同ID同类型为更新，不增加重复条目；不同类型同ID拒绝。', '附加素材后，用add_layer或update_layer引用其ID。'],
    example: { op: 'attach_asset', asset: { id: 'imported-image-id', name: 'background.png', type: 'image', url: '/api/assets/imported-image-id' }, role: 'cover' },
  },
  set_lyrics: {
    required: ['op'], optional: ['lyrics', 'originalLrc', 'translatedLrc', 'offsetMs', 'source'],
    fields: {
      op: { type: 'string', enum: ['set_lyrics'], description: '替换工程歌词；lyrics与originalLrc必须且只能提供一个。' },
      lyrics: { type: 'array', description: '完整歌词数组，最多10000项；每项{time:number,text:string,end?:number,translation?:string}，time/end单位秒，time范围-3600–7200，end不得早于time。按time排序；空数组清空歌词。' },
      originalLrc: { type: 'string', description: '带时间戳的原文LRC/SRT文字，最多200万字；非空内容必须可解析。与lyrics互斥。' },
      translatedLrc: { type: 'string', description: '可选译文LRC，仅能与originalLrc同时使用；按时间戳合并，保留原文文件的offset语义。' },
      offsetMs: { type: 'number', description: '工程歌词偏移毫秒，范围-3600000–3600000；正值延后，负值提前；省略则保留。' },
      source: { type: 'object', description: '可选歌词来源{provider:string,id:string,url:string}；省略时清除旧来源。仅保存元数据，不访问网络。' },
    },
    notes: ['不会更改图层样式、歌名或歌手；歌曲信息可另用update_project设置。', '在线获取歌词后，将返回的originalLrc/translatedLrc送入本操作即可。'],
    example: { op: 'set_lyrics', originalLrc: '[00:00.00]第一句\n[00:03.00]第二句', translatedLrc: '[00:00.00]First line\n[00:03.00]Second line', offsetMs: 200 },
  },
  add_effect: {
    required: ['op', 'targetId', 'type'], optional: ['params', 'strength'],
    fields: {
      op: { type: 'string', enum: ['add_effect'], description: '向图层或主音轨的效果栈末尾添加效果。' },
      targetId: { type: 'string', description: '未锁定图层的ID，或特殊值audio表示主音轨。' },
      type: { type: 'string', enum: ['color', 'film', 'rgb-split', 'glitch', 'crt', 'audio-reactive', 'fade'], description: '画面支持全部效果；主音轨audio仅支持fade。详细参数范围从catalog.effects读取。' },
      params: { type: 'object', description: '局部效果参数，均为数值；与默认参数合并。fade示例{fadeIn:1,fadeOut:1,style:0,curve:0,timing:0}，时长秒范围0–10，style为0透明度/1上移/2下移/3左移/4右移/5缩放；curve为0平滑/1线性/2正弦（音频为等功率）；timing为0组件出入场/1每句歌词。' },
      strength: { type: 'number', description: '整体强度0–1，默认1。' },
    },
    notes: ['每个目标最多8个效果；自动创建效果ID并启用。后续编辑或删除效果请用update_layer changes.effects替换完整栈；主音轨用update_project changes.audioEffects。', 'audio-reactive只支持画面目标，需要配乐分析驱动；主音轨淡入淡出使用fade，style/timing不影响音频。'],
    example: { op: 'add_effect', targetId: 'audio', type: 'fade', params: { fadeIn: 1.5, fadeOut: 3 }, strength: 1 },
  },
} as const);

const LAYER_TYPES: readonly LayerType[] = ['background', 'image', 'video', 'disc', 'lyrics', 'spectrum', 'player', 'title', 'text', 'particles', 'atmosphere'];
const LAYER_KEYS = ['name', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible', 'locked', 'start', 'end', 'params', 'effects', 'effectTimeOffset'];
const PROJECT_KEYS = ['title', 'artist', 'duration', 'width', 'height', 'fps', 'lyricsOffsetMs', 'audioMuted', 'audioEffects'];
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const EPSILON = 1e-7;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label}需要普通对象`);
  return value as Record<string, unknown>;
}

/** Reject non-JSON values, inherited payloads and accessors before spreading any input. */
function copyInput(value: unknown, depth = 0): unknown {
  if (depth > 15) throw new Error('操作参数嵌套过深');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 10000) throw new Error('操作数组超出容量');
    if (Reflect.ownKeys(value).some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key))) || Object.keys(value).length !== value.length) throw new Error('操作数组含无效字段');
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('操作数组不能含访问器或空位');
      return copyInput(descriptor.value, depth + 1);
    });
  }
  const input = record(value, '操作参数');
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || DANGEROUS_KEYS.has(key)) throw new Error('操作参数包含不允许的字段');
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('操作参数不能含访问器或隐藏字段');
    result[key] = copyInput(descriptor.value, depth + 1);
  }
  return result;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key) || DANGEROUS_KEYS.has(key)) throw new Error(`${label}含未知字段：${key}`);
}
function number(value: unknown, label: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${label}需要${integer ? '整数' : '数值'}，范围 ${min}–${max}`);
  return value;
}
function text(value: unknown, label: string, max = 500, nonempty = false): string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value)) throw new Error(`${label}需要${nonempty ? '非空' : ''}文字，最多 ${max} 字`);
  return value;
}
function boolean(value: unknown, label: string): void { if (typeof value !== 'boolean') throw new Error(`${label}需要布尔值`); }
function choice(value: unknown, options: readonly string[], label: string): string {
  if (typeof value !== 'string' || !options.includes(value)) throw new Error(`${label}无效`);
  return value;
}

const TYPOGRAPHY = ['fontId', 'fontSize', 'color', 'fontWeight', 'italic', 'fontWeightSynthesis'];
const GLOW = ['glowEnabled', 'glowColor', 'glowIntensity', 'glowRadius'];
const EXTRA_PARAMS: Record<LayerType, readonly string[]> = {
  background: ['fit'], image: [],
  video: ['chromaEnabled', 'chromaColor', 'chromaTolerance', 'chromaSoftness', 'chromaSpill'],
  disc: ['imageId', 'followCover'],
  lyrics: [...GLOW, 'fontId', 'translationFontId', 'planeYaw', 'planePerspective', 'activeFontWeight', 'activeTranslationFontWeight', 'inactiveFontWeight', 'inactiveTranslationFontWeight',
    'activeItalic', 'activeTranslationItalic', 'inactiveItalic', 'inactiveTranslationItalic', 'activeFontWeightSynthesis', 'activeTranslationFontWeightSynthesis', 'inactiveFontWeightSynthesis', 'inactiveTranslationFontWeightSynthesis',
    'activeOpacity', 'inactiveOpacity', 'activeStrokeWidth', 'inactiveStrokeWidth', 'activeStrokeColor', 'inactiveStrokeColor',
    'activeShadowEnabled', 'inactiveShadowEnabled', 'activeShadowColor', 'inactiveShadowColor', 'activeShadowOpacity', 'inactiveShadowOpacity',
    'activeShadowBlur', 'inactiveShadowBlur', 'activeShadowX', 'activeShadowY', 'inactiveShadowX', 'inactiveShadowY', 'lineGap', 'translationGap', 'transition', 'transitionDuration'],
  spectrum: ['smoothing', 'lineWidth', 'flowSpeed', 'envelopeWindow'], player: [],
  title: [...TYPOGRAPHY, ...GLOW, 'subtitleFontWeight', 'subtitleItalic', 'subtitleFontWeightSynthesis'],
  text: [...TYPOGRAPHY, ...GLOW], particles: [], atmosphere: [],
};

function params(value: unknown, type: LayerType): LayerParams {
  const patch = record(value, '图层参数');
  keys(patch, [...Object.keys(makeLayer(type).params), ...EXTRA_PARAMS[type], 'templateId'], '图层参数');
  for (const [key, raw] of Object.entries(patch)) {
    if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`图层参数需要文字、数值或布尔值：${key}`);
    if (typeof raw === 'number' && !Number.isFinite(raw)) throw new Error(`图层参数需要有限数值：${key}`);
    if (typeof raw === 'string') text(raw, `图层参数 ${key}`, key === 'text' ? 20000 : 500);
  }
  const bools = ['followCover', 'videoLoop', 'reverse', 'shadow', 'tonearm', 'progress', 'time', 'chromaEnabled', 'glowEnabled', 'italic', 'fontWeightSynthesis', 'subtitleItalic', 'subtitleFontWeightSynthesis',
    'activeItalic', 'activeTranslationItalic', 'inactiveItalic', 'inactiveTranslationItalic', 'activeFontWeightSynthesis', 'activeTranslationFontWeightSynthesis', 'inactiveFontWeightSynthesis', 'inactiveTranslationFontWeightSynthesis', 'activeShadowEnabled', 'inactiveShadowEnabled'];
  for (const key of bools) if (patch[key] !== undefined) boolean(patch[key], key);
  const ranges: Record<string, [number, number]> = {
    fontSize: [8, 300], translationSize: [8, 300], inactiveFontSize: [8, 300], inactiveTranslationSize: [8, 300],
    fontWeight: [100, 900], subtitleFontWeight: [100, 900], activeFontWeight: [100, 900], activeTranslationFontWeight: [100, 900], inactiveFontWeight: [100, 900], inactiveTranslationFontWeight: [100, 900],
    glowIntensity: [0, 2], glowRadius: [0, 80], planeYaw: [-75, 75], planePerspective: [0, 300],
    activeOpacity: [0, 1], inactiveOpacity: [0, 1], activeStrokeWidth: [0, 30], inactiveStrokeWidth: [0, 30], activeShadowOpacity: [0, 1], inactiveShadowOpacity: [0, 1],
    activeShadowBlur: [0, 100], inactiveShadowBlur: [0, 100], activeShadowX: [-100, 100], activeShadowY: [-100, 100], inactiveShadowX: [-100, 100], inactiveShadowY: [-100, 100],
    lineGap: [0, 600], translationGap: [0, 300], lineHeight: [.5, 4], transitionDuration: [.05, 2], textTransitionDuration: [.05, 3],
    playbackRate: [.1, 8], sourceIn: [0, 86400], sourceOut: [0, 86400], chromaTolerance: [0, 1], chromaSoftness: [0, 1], chromaSpill: [0, 1],
    brightness: [0, 1], blur: [0, 100], radius: [0, 100000], shadowOpacity: [0, 1], rpm: [-120, 120], labelRatio: [.2, .9], gain: [.2, 4], barCount: [16, 160], lines: [1, 7],
    smoothing: [0, 1], lineWidth: [.5, 8], flowSpeed: [0, 3], envelopeWindow: [.25, 4],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) if (patch[key] !== undefined) number(patch[key], key, min, max, key === 'lines' || key === 'barCount');
  for (const key of ['fontId', 'translationFontId', 'imageId', 'videoId', 'templateId']) if (patch[key] !== undefined) text(patch[key], key, 120);
  for (const key of ['color', 'translationColor', 'inactiveColor', 'inactiveTranslationColor', 'glowColor', 'chromaColor', 'activeStrokeColor', 'inactiveStrokeColor', 'activeShadowColor', 'inactiveShadowColor', 'secondaryColor']) if (patch[key] !== undefined) text(patch[key], key, 100);
  if (patch.align !== undefined) choice(patch.align, ['left', 'center', 'right'], '文字对齐');
  if (patch.fit !== undefined) choice(patch.fit, type === 'image' ? ['cover', 'contain'] : ['cover', 'contain', 'stretch'], '素材适配');
  if (patch.mode !== undefined) choice(patch.mode, type === 'lyrics' ? ['scroll', 'bilingual', 'single'] : ['bars', 'ecg-wave', 'dual-wave', 'wave', 'ring'], '显示模式');
  if (patch.skin !== undefined) choice(patch.skin, ['vinyl', 'cd'], '唱片样式');
  return patch as LayerParams;
}

function effectStack(value: unknown, audio = false) {
  if (!Array.isArray(value)) throw new Error('效果栈需要数组');
  for (const entry of value) keys(record(entry, '效果'), ['id', 'type', 'enabled', 'strength', 'params'], '效果');
  return audio ? validateAudioEffects(value) : validateLayerEffects(value);
}
function layerPatch(value: unknown, type: LayerType): Partial<Layer> {
  const patch = record(value, '图层修改'); keys(patch, LAYER_KEYS, '图层修改');
  if (patch.name !== undefined) text(patch.name, '图层名称', 500);
  for (const key of ['x', 'y', 'rotation']) if (patch[key] !== undefined) number(patch[key], key, -100000, 100000);
  for (const key of ['width', 'height']) if (patch[key] !== undefined) number(patch[key], key, 1, 20000);
  if (patch.opacity !== undefined) number(patch.opacity, '图层透明度', 0, 1);
  for (const key of ['visible', 'locked']) if (patch[key] !== undefined) boolean(patch[key], key);
  for (const key of ['start', 'end']) if (patch[key] !== undefined) number(patch[key], key, 0, 3600);
  if (patch.effectTimeOffset !== undefined) number(patch.effectTimeOffset, '效果时间偏移', -7200, 7200);
  if (patch.params !== undefined) patch.params = params(patch.params, type);
  if (patch.effects !== undefined) patch.effects = effectStack(patch.effects);
  return patch as Partial<Layer>;
}
function layerById(project: DemoProject, value: unknown, editable = true): Layer {
  const id = text(value, '图层 ID', 500, true);
  const layer = project.layers.find(item => item.id === id);
  if (!layer) throw new Error(`找不到图层：${id}`);
  if (editable && layer.locked) throw new Error(`图层已锁定，请先解锁：${id}`);
  return layer;
}
function videoAsset(project: DemoProject, layer: Layer): MediaAsset {
  if (layer.type !== 'video') throw new Error('操作需要视频片段');
  const asset = project.videos?.find(asset => asset.id === layer.params.videoId);
  if (!asset || !asset.duration) throw new Error('视频素材不存在或没有有效时长');
  return asset;
}
function extend(project: DemoProject, end: number): void {
  number(end, '图层终点', 0, 3600);
  project.duration = Math.max(project.duration, end);
}
function replaceLayer(project: DemoProject, layer: Layer): void { project.layers = project.layers.map(current => current.id === layer.id ? layer : current); }

function mergeLayer(project: DemoProject, layer: Layer, patch: Partial<Layer>, adding = false): Layer {
  const next: Layer = { ...layer, ...patch, params: patch.params === undefined ? layer.params : layer.type === 'lyrics' ? updateLyricStyles(normalizeLyricFonts(layer.params), patch.params) : { ...layer.params, ...patch.params } };
  if (next.type === 'video') {
    const asset = videoAsset(project, next);
    const changedSource = adding || (patch.params && ['videoId', 'sourceIn', 'sourceOut', 'playbackRate'].some(key => key in patch.params!));
    if (adding || (patch.params?.videoId !== undefined && patch.params.videoId !== layer.params.videoId)) {
      next.params = { ...next.params, sourceIn: patch.params?.sourceIn ?? 0, sourceOut: patch.params?.sourceOut ?? asset.duration!, playbackRate: patch.params?.playbackRate ?? 1, reverse: patch.params?.reverse ?? false };
    }
    if (patch.end === undefined && (changedSource || patch.start !== undefined)) next.end = next.start + (Number(next.params.sourceOut) - Number(next.params.sourceIn)) / Number(next.params.playbackRate);
    extend(project, next.end);
  }
  return next;
}

function sourceMetadata(value: unknown): DemoProject['lyricsSource'] {
  const source = record(value, '歌词来源'); keys(source, ['provider', 'id', 'url'], '歌词来源');
  return { provider: text(source.provider, '歌词来源平台', 100, true), id: text(source.id, '歌词来源 ID', 500, true), url: text(source.url, '歌词来源链接', 2000) };
}

function attachAsset(project: DemoProject, value: unknown, roleValue: unknown): void {
  const asset = record(value, '素材');
  const type = choice(asset.type, ['audio', 'image', 'video', 'font'], '素材类型');
  const role = roleValue === undefined ? (type === 'audio' ? 'audio' : 'library') : choice(roleValue, ['audio', 'cover', 'library'], '素材用途');
  if ((type === 'audio' && role !== 'audio') || (type === 'image' && !['cover', 'library'].includes(role)) || (['video', 'font'].includes(type) && role !== 'library')) throw new Error('素材类型与用途不匹配');
  keys(asset, type === 'font' ? ['id', 'name', 'type', 'family', 'url', 'builtin', 'license', 'weight'] : ['id', 'name', 'type', 'url', 'duration', 'sampleRate', 'channels', 'sampleCount', 'width', 'height', 'fps', 'posterUrl'], '素材');
  const id = text(asset.id, '素材 ID', 100, true);
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('素材 ID 无效');
  text(asset.name, '素材名称', 180, true);
  if (asset.url !== undefined) text(asset.url, '素材链接', 2000);
  const existingTypes = [project.audio, project.cover, ...(project.images ?? []), ...(project.videos ?? []), ...(project.fonts ?? [])].filter(item => item?.id === id).map(item => item!.type);
  if (existingTypes.some(existing => existing !== type)) throw new Error('素材 ID 已被其他类型占用');
  if (type === 'font') {
    if (asset.builtin !== undefined && asset.builtin !== false) throw new Error('导入字体不能声明为内置字体');
    for (const key of ['family', 'license', 'weight']) if (asset[key] !== undefined) text(asset[key], `字体 ${key}`, 500);
    const font: FontAsset = { id, type: 'font', name: String(asset.name), family: `VisikiFont_${id.replaceAll('-', '_')}`, url: `/api/fonts/${id}` };
    project.fonts = [...(project.fonts ?? []).filter(current => current.id !== id), font];
    return;
  }
  const media = { ...asset, url: `/api/assets/${id}` } as unknown as MediaAsset;
  for (const key of ['duration', 'sampleRate', 'channels', 'sampleCount', 'width', 'height', 'fps']) if (asset[key] !== undefined) number(asset[key], `素材 ${key}`, .001, key === 'sampleCount' ? 1e12 : 1e7);
  if (asset.posterUrl !== undefined) text(asset.posterUrl, '视频预览链接', 2000);
  if (type === 'audio') {
    const audioDuration = number(asset.duration, '音乐时长', .001, 3600);
    const previousDuration = project.duration;
    project.audio = media;
    project.duration = Math.max(audioDuration, 1 / project.fps, ...project.layers.filter(layer => layer.type === 'video').map(layer => layer.end));
    project.layers = project.layers.map(layer => layer.type === 'video' ? layer : { ...layer,
      start: Math.min(layer.start, Math.max(0, project.duration - Math.min(.1, 1 / project.fps))),
      end: Math.abs(layer.end - previousDuration) < .2 ? project.duration : Math.min(layer.end, project.duration),
    });
  } else if (type === 'image') {
    project.images = [...(project.images ?? []).filter(current => current.id !== id), media];
    if (role === 'cover') project.cover = media;
    else if (project.cover?.id === id) project.cover = media;
  } else {
    project.videos = [...(project.videos ?? []).filter(current => current.id !== id), media];
  }
}

/** Clone and validate every step. A failed operation cannot partially change the caller's project. */
export function applyAgentOperations(project: DemoProject, operations: unknown): DemoProject {
  const commands = copyInput(operations);
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 100) throw new Error('每批操作需要 1–100 项');
  let next = validateProject(structuredClone(project));
  for (let index = 0; index < commands.length; index++) {
    try {
      const command = record(commands[index], '操作');
      const op = choice(command.op, AGENT_OPERATION_TYPES, '操作类型');
      switch (op) {
        case 'update_project': {
          keys(command, ['op', 'changes'], '操作');
          const patch = record(command.changes, '工程修改'); keys(patch, PROJECT_KEYS, '工程修改');
          for (const key of ['title', 'artist']) if (patch[key] !== undefined) text(patch[key], key, 2000);
          if (patch.fps !== undefined) number(patch.fps, '帧率', 1, 60);
          for (const key of ['width', 'height']) if (patch[key] !== undefined) number(patch[key], key, key === 'width' ? 320 : 180, 3840, true);
          if (patch.lyricsOffsetMs !== undefined) number(patch.lyricsOffsetMs, '歌词偏移', -3600000, 3600000);
          if (patch.audioMuted !== undefined) boolean(patch.audioMuted, '主音轨静音');
          if (patch.audioEffects !== undefined) patch.audioEffects = effectStack(patch.audioEffects, true);
          if (patch.duration !== undefined) number(patch.duration, '工程时长', 1 / Number(patch.fps ?? next.fps), 3600);
          const duration = patch.duration;
          next = { ...next, ...patch } as DemoProject;
          if (duration !== undefined) next = resizeProjectDuration(next, Number(duration));
          break;
        }
        case 'add_layer': {
          keys(command, ['op', 'layerType', 'changes', 'params'], '操作');
          const type = choice(command.layerType, LAYER_TYPES, '组件类型') as LayerType;
          const layer = makeLayer(type, next.duration);
          const sx = next.width / 1920, sy = next.height / 1080;
          Object.assign(layer, { x: layer.x * sx, y: layer.y * sy, width: Math.max(1, layer.width * sx), height: Math.max(1, layer.height * sy) });
          const patch = command.changes === undefined ? {} : layerPatch(command.changes, type);
          if (command.params !== undefined) {
            const extra = params(command.params, type);
            if (patch.params && Object.keys(extra).some(key => key in patch.params!)) throw new Error('图层参数在 changes.params 和 params 中重复');
            patch.params = { ...patch.params, ...extra };
          }
          next.layers.push(mergeLayer(next, layer, patch, true));
          break;
        }
        case 'update_layer': {
          keys(command, ['op', 'id', 'changes'], '操作');
          const layer = layerById(next, command.id, false);
          const patch = layerPatch(command.changes, layer.type);
          if (layer.locked && Object.keys(patch).some(key => !['locked', 'visible'].includes(key))) throw new Error('锁定图层只允许修改 locked 或 visible；请先单独解锁');
          replaceLayer(next, mergeLayer(next, layer, patch));
          break;
        }
        case 'remove_layer': {
          keys(command, ['op', 'id'], '操作'); const layer = layerById(next, command.id);
          next.layers = next.layers.filter(item => item.id !== layer.id); break;
        }
        case 'reorder_layer': {
          keys(command, ['op', 'id', 'index'], '操作'); const layer = layerById(next, command.id);
          const position = number(command.index, '图层序号', 0, next.layers.length - 1, true);
          next.layers = next.layers.filter(item => item.id !== layer.id); next.layers.splice(position, 0, layer); break;
        }
        case 'split_video': {
          keys(command, ['op', 'id', 'at'], '操作'); const layer = layerById(next, command.id);
          const at = number(command.at, '视频切分时间', 0, 3600);
          const pieces = splitVideoLayer(layer, at, videoAsset(next, layer), next.fps);
          if (!pieces) throw new Error('切分点两侧至少保留一工程帧');
          next.layers.splice(next.layers.indexOf(layer), 1, ...pieces); break;
        }
        case 'video_rate': {
          keys(command, ['op', 'id', 'rate'], '操作'); const layer = layerById(next, command.id);
          const rate = number(command.rate, '视频速度', .1, 8);
          const changed = setVideoRate(layer, rate, videoAsset(next, layer), next.fps);
          if (Math.abs(Number(changed.params.playbackRate) - rate) > EPSILON) throw new Error('此视频速度会超出一小时或短于一工程帧');
          extend(next, changed.end); replaceLayer(next, changed); break;
        }
        case 'move_layer': {
          keys(command, ['op', 'id', 'start'], '操作'); const layer = layerById(next, command.id);
          const start = number(command.start, '图层起点', 0, 3600 - (layer.end - layer.start));
          const changed = moveLayer(layer, start, next.fps);
          extend(next, changed.end); replaceLayer(next, changed); break;
        }
        case 'attach_asset':
          keys(command, ['op', 'asset', 'role'], '操作'); attachAsset(next, command.asset, command.role); break;
        case 'set_lyrics': {
          keys(command, ['op', 'lyrics', 'originalLrc', 'translatedLrc', 'offsetMs', 'source'], '操作');
          if ((command.lyrics !== undefined) === (command.originalLrc !== undefined)) throw new Error('歌词 cues 和 originalLrc 需要二选一');
          if (command.lyrics !== undefined) {
            if (command.translatedLrc !== undefined || !Array.isArray(command.lyrics) || command.lyrics.length > 10000) throw new Error('歌词数组无效');
            for (const cue of command.lyrics) {
              const item = record(cue, '歌词'); keys(item, ['time', 'end', 'text', 'translation'], '歌词');
              number(item.time, '歌词时间', -3600, 7200); text(item.text, '歌词原文', 10000);
              if (item.translation !== undefined) text(item.translation, '歌词译文', 10000);
              if (item.end !== undefined) number(item.end, '歌词结束时间', Number(item.time), 7200);
            }
            next.lyrics = command.lyrics as DemoProject['lyrics'];
          } else {
            const original = text(command.originalLrc, '原文歌词', 2000000);
            const translated = command.translatedLrc === undefined ? '' : text(command.translatedLrc, '译文歌词', 2000000);
            next.lyrics = translated ? mergeBilingual(original, translated) : parseLyrics(original);
            if (original.trim() && !next.lyrics.length) throw new Error('没有解析到带时间戳的歌词');
          }
          if (command.offsetMs !== undefined) next.lyricsOffsetMs = number(command.offsetMs, '歌词偏移', -3600000, 3600000);
          if (command.source !== undefined) next.lyricsSource = sourceMetadata(command.source);
          else delete next.lyricsSource;
          break;
        }
        case 'add_effect': {
          keys(command, ['op', 'targetId', 'type', 'params', 'strength'], '操作');
          const type = choice(command.type, EFFECT_DEFINITIONS.map(definition => definition.type), '效果类型') as EffectType;
          const target = text(command.targetId, '效果目标', 500, true);
          if (!effectSupportsTarget(type, target === 'audio' ? 'audio' : 'visual')) throw new Error('该效果不支持此目标');
          const layer = target === 'audio' ? undefined : layerById(next, target);
          const effect = makeEffect(type);
          if (command.params !== undefined) effect.params = { ...effect.params, ...record(command.params, '效果参数') } as LayerParams;
          if (command.strength !== undefined) effect.strength = number(command.strength, '效果强度', 0, 1);
          if (layer) layer.effects = effectStack([...(layer.effects ?? []), effect]);
          else next.audioEffects = effectStack([...(next.audioEffects ?? []), effect], true);
          break;
        }
      }
      next = validateProject(next);
    } catch (error) {
      throw new Error(`第 ${index + 1} 项操作失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return next;
}
