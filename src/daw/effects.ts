import { DawValidationError, type DawSession, type DawTrack, type DawClip, type DawValidationIssue } from './model'

/** Stable numeric parameter protocol shared by project files, native DSP and editors. */
export const DAW_EFFECT_TYPES = ['eq', 'compressor', 'gate', 'deesser', 'transient', 'reverb', 'delay', 'saturation', 'stereo', 'limiter', 'meter', 'multiband', 'convolution', 'modulation', 'denoise', 'lofi', 'pedal', 'ducker'] as const
export type DawEffectType = typeof DAW_EFFECT_TYPES[number]
export const DAW_MAX_EFFECTS = 12
export const DAW_MAX_STORED_EFFECTS = 64
export type DawEffectTarget = 'master' | string
export interface DawEffect {
  id: string
  type: DawEffectType | 'vst3'
  vst3?: { classId: string }
  enabled: boolean
  params: Record<string, number>
  name?: string
  presetId?: string
  /** Inactive comparison snapshot. params always describes the audible slot. */
  bState?: Record<string, number>
  abSlot?: 'A' | 'B'
  noiseProfile?: number[]
  bNoiseProfile?: number[]
  sidechainTrackId?: string
  bSidechainTrackId?: string
}
export type DawBuiltinEffect = DawEffect & { type: DawEffectType }
export type DawEffectInstance = DawEffect
export interface DawEffectParameter {
  key: string; label: string; min: number; max: number; step: number; default: number; unit: string
  advanced: boolean; description: string; options?: readonly string[]; scale?: 'linear' | 'log'; group?: string; optional?: boolean
}
export interface DawEffectPreset { id: string; name: string; params: Readonly<Record<string, number>> }
export interface DawEffectDefinition {
  type: DawEffectType; name: string; subtitle: string; category: string; description: string; color: string
  parameters: readonly DawEffectParameter[]; presets: readonly DawEffectPreset[]
}
type ParameterOptions = Partial<Pick<DawEffectParameter, 'advanced' | 'options' | 'scale' | 'group'>>
const p = (key: string, label: string, min: number, max: number, value: number, step: number, unit: string, description: string, extra: ParameterOptions = {}): DawEffectParameter => Object.freeze({ key, label, min, max, default: value, step, unit, advanced: false, scale: 'linear', description, ...extra, ...(extra.options ? { options: Object.freeze([...extra.options]) } : {}) })
const toggle = (key: string, label: string, value = 0, advanced = true, description = '0 为关闭，1 为开启。') => p(key, label, 0, 1, value, 1, '', description, { advanced, options: ['关', '开'] })
const choice = (key: string, label: string, options: string[], value = 0, advanced = true, description = '选择处理模式。') => p(key, label, 0, options.length - 1, value, 1, '', description, { advanced, options })
const hz = (key: string, label: string, min: number, max: number, value: number, advanced = true, description = '设置滤波频率。') => p(key, label, min, max, value, 1, 'Hz', description, { advanced, scale: 'log' })
const db = (key: string, label: string, min: number, max: number, value: number, advanced = false, description = '以分贝调整电平。') => p(key, label, min, max, value, .1, 'dB', description, { advanced })
const ms = (key: string, label: string, min: number, max: number, value: number, advanced = false, description = '设置时间常数。') => p(key, label, min, max, value, .1, 'ms', description, { advanced, scale: min > 0 ? 'log' : 'linear' })
const percent = (key: string, label: string, value: number, advanced = false, max = 100, description = '干湿比例；0% 保留原声，100% 为处理声。') => p(key, label, 0, max, value, 1, '%', description, { advanced })
export const DENOISE_SWITCHES = ['spectralEnabled', 'humEnabled', 'dereverbEnabled'] as const
type DenoiseSwitch = typeof DENOISE_SWITCHES[number]
export function denoiseModes(params: Readonly<Record<string, number>>): Record<DenoiseSwitch, boolean> {
  const legacyMode = params.repairMode ?? 0
  return {
    spectralEnabled: (params.spectralEnabled ?? Number(legacyMode === 0)) === 1,
    humEnabled: (params.humEnabled ?? Number(legacyMode === 1)) === 1,
    dereverbEnabled: (params.dereverbEnabled ?? Number(legacyMode === 2)) === 1,
  }
}
export function canAuditionDenoise(effect: DawEffect): boolean {
  if (!effect.enabled || effect.type !== 'denoise') return false
  const modes = denoiseModes(effect.params)
  return modes.humEnabled || modes.dereverbEnabled || (modes.spectralEnabled && !!effect.noiseProfile)
}
// Keep missing switches absent when loading an older preset or A/B snapshot.
const parameterDefaults = (parameters: readonly DawEffectParameter[]) => Object.fromEntries(parameters
  .filter(parameter => !DENOISE_SWITCHES.some(key => key === parameter.key)).map(parameter => [parameter.key, parameter.default]))
const eqParameters: DawEffectParameter[] = []
for (let band = 1; band <= 8; band++) {
  const group = `频段 ${band}`, advanced = band !== 3
  eqParameters.push(
    hz(`band${band}Freq`, '频率', 20, 20000, [40, 100, 250, 750, 2000, 5000, 10000, 16000][band - 1], advanced, '频段的中心或截止频率。'),
    db(`band${band}Gain`, '增益', -24, 24, 0, advanced, 'Bell / Shelf 频段的提升或衰减。'),
    p(`band${band}Q`, 'Q 值', .1, 18, .707, .01, '', 'Q 越大，处理频带越窄。', { advanced, scale: 'log' }),
    choice(`band${band}Type`, '滤波类型', ['Bell', '低架', '高架', '高通', '低通', '陷波'], 0, advanced, 'Bell、低架和高架支持动态衰减。'),
    toggle(`band${band}Enabled`, '频段启用', band === 3 ? 1 : 0, advanced),
    choice(`band${band}Slope`, '滤波斜率', ['12 dB/oct', '24 dB/oct', '36 dB/oct', '48 dB/oct'], 0, true, '高通 / 低通的截止斜率。'),
  )
  for (const parameter of eqParameters.slice(-6)) eqParameters[eqParameters.indexOf(parameter)] = Object.freeze({ ...parameter, group })
  const dynamic = [
    toggle(`band${band}Dyn`, '动态衰减', 0, true, '所选频段的信号超过阈值时，降低该段增益。'),
    p(`band${band}Threshold`, '阈值', -72, 0, -30, .1, 'dBFS', '检测信号超过该电平时，开始动态衰减。', { advanced: true }),
    db(`band${band}Range`, '最大衰减', 0, 18, 6, true, '在静态增益基础上最多再衰减多少 dB。'),
    ms(`band${band}Attack`, '动态启动', .1, 200, 12, true),
    ms(`band${band}Release`, '动态释放', 5, 1500, 120, true),
  ]
  eqParameters.push(...dynamic.map(parameter => Object.freeze({ ...parameter, group, optional: true })))
}
eqParameters.push(db('inputDb', '输入增益', -24, 24, 0, true), db('outputDb', '输出增益', -24, 24, 0), choice('soloBand', '独听频段', ['关闭', '频段 1', '频段 2', '频段 3', '频段 4', '频段 5', '频段 6', '频段 7', '频段 8'], 0, true, '仅用于试听；导出仍使用完整 EQ。'))
export const EQ_MATCH_FREQUENCIES = Object.freeze([125, 250, 500, 1000, 2500, 6300])
export const EQ_MATCH_Q = .8
eqParameters.push(
  { ...percent('matchStrength', '匹配强度', 0, true, 100, '缩放音色匹配的建议增益。'), optional: true },
  ...EQ_MATCH_FREQUENCIES.map((frequency, index) => ({ ...db(`matchGain${index + 1}`, `${frequency} Hz`, -6, 6, 0, true), optional: true })),
)

const multibandParameters: DawEffectParameter[] = [
  hz('crossoverLowHz', '低 / 中分频点', 60, 600, 160, false, '低频和中频的分界频率。'),
  hz('crossoverHighHz', '中 / 高分频点', 900, 12000, 3200, false, '中频和高频的分界频率。'),
  percent('mix', '混合', 100), db('outputDb', '输出增益', -24, 12, 0),
]
for (let band = 1; band <= 3; band++) {
  const group = `频段 ${band}`
  multibandParameters.push(...[
    db(`band${band}ThresholdDb`, '阈值', -60, 0, -18, true, '超过阈值后按压缩比衰减。'),
    p(`band${band}Ratio`, '压缩比', 1, 20, 1, .1, ':1', '1:1 不压缩。', { advanced: true }),
    ms(`band${band}AttackMs`, '启动', .1, 200, 15, true),
    ms(`band${band}ReleaseMs`, '释放', 5, 2000, 150, true),
    db(`band${band}MakeupDb`, '补偿增益', -18, 18, 0, true),
  ].map(parameter => Object.freeze({ ...parameter, group })))
}

const define = (type: DawEffectType, name: string, subtitle: string, category: string, description: string, color: string, parameters: DawEffectParameter[], presets: [string, string, Record<string, number>][]): DawEffectDefinition => {
  const defaults = parameterDefaults(parameters)
  return Object.freeze({ type, name, subtitle, category, description, color, parameters: Object.freeze(parameters), presets: Object.freeze([Object.freeze({ id: 'default', name: '默认', params: Object.freeze({ ...defaults }) }), ...presets.map(([id, presetName, params]) => Object.freeze({ id, name: presetName, params: Object.freeze({ ...defaults, ...params }) }))]) })
}
/** Note lengths in quarter-note beats; shared with native tempo synchronization. */
export const DAW_DELAY_NOTE_BEATS = Object.freeze([.125, 1 / 6, .1875, .25, 1 / 3, .375, .5, 2 / 3, .75, 1, 4 / 3, 1.5, 2, 3, 4, 8])
const noteNames = ['1/32', '1/16 三连', '1/32 附点', '1/16', '1/8 三连', '1/16 附点', '1/8', '1/4 三连', '1/8 附点', '1/4', '1/2 三连', '1/4 附点', '1/2', '1/2 附点', '全音符']

export const DAW_EFFECT_CATALOG: readonly DawEffectDefinition[] = Object.freeze([
  define('eq', '参数 EQ', '8 段均衡与动态 EQ', '频率', '八个可独立启用的滤波频段，Bell 和搁架频段可按信号电平动态衰减。', '#a39bf5', eqParameters, [
    ['vocal-cleanup', '人声去低频', { band1Enabled: 1, band1Type: 3, band1Freq: 80, band1Slope: 1, band3Freq: 300, band3Gain: -2.5, band3Q: 1.2, band6Enabled: 1, band6Type: 2, band6Freq: 9000, band6Gain: 1.5 }],
    ['air', '清晰空气感', { band3Freq: 3000, band3Gain: 1.5, band7Enabled: 1, band7Type: 2, band7Freq: 10000, band7Gain: 2 }],
    ['warmth', '温暖低频', { band2Enabled: 1, band2Type: 1, band2Freq: 130, band2Gain: 2, band3Freq: 350, band3Gain: -1 }],
    ['vocal-female-pop', '女声流行', { band1Enabled: 1, band1Type: 3, band1Freq: 92, band3Freq: 280, band3Q: 1.15, band3Gain: -2, band5Enabled: 1, band5Freq: 3400, band5Gain: 1.8, band6Enabled: 1, band6Freq: 7400, band6Q: 2, band6Dyn: 1, band6Threshold: -28, band6Range: 3, band6Attack: 3, band6Release: 85, band7Enabled: 1, band7Type: 2, band7Freq: 12000, band7Gain: 2 }],
    ['vocal-female-rock', '女声摇滚', { band1Enabled: 1, band1Type: 3, band1Freq: 105, band1Slope: 1, band3Freq: 390, band3Q: 1.1, band3Gain: -3, band4Enabled: 1, band4Freq: 1850, band4Gain: 2.4, band5Enabled: 1, band5Freq: 3600, band5Q: 1.6, band5Dyn: 1, band5Threshold: -24, band5Range: 4, band5Attack: 7, band7Enabled: 1, band7Type: 2, band7Freq: 10000, band7Gain: 1 }],
    ['vocal-female-classical', '女声古典', { band1Enabled: 1, band1Type: 3, band1Freq: 68, band3Freq: 530, band3Q: 1.25, band3Gain: -1, band5Enabled: 1, band5Freq: 2900, band5Q: 1, band5Gain: .8, band7Enabled: 1, band7Type: 2, band7Freq: 11500, band7Gain: .8 }],
    ['vocal-male-pop', '男声流行', { band1Enabled: 1, band1Type: 3, band1Freq: 72, band2Enabled: 1, band2Freq: 160, band2Q: 1.1, band2Gain: -1, band3Freq: 330, band3Q: 1.25, band3Gain: -2.4, band5Enabled: 1, band5Freq: 2700, band5Gain: 2, band6Enabled: 1, band6Freq: 5900, band6Q: 1.85, band6Dyn: 1, band6Threshold: -27, band6Range: 3, band7Enabled: 1, band7Type: 2, band7Freq: 10000, band7Gain: 1.4 }],
    ['vocal-male-rock', '男声摇滚', { band1Enabled: 1, band1Type: 3, band1Freq: 75, band1Slope: 1, band3Freq: 270, band3Q: 1.3, band3Gain: -2.7, band4Enabled: 1, band4Freq: 1450, band4Gain: 1.6, band5Enabled: 1, band5Freq: 3100, band5Gain: 1, band5Q: 1.4, band5Dyn: 1, band5Threshold: -25, band5Range: 3.5, band5Attack: 8 }],
    ['vocal-male-classical', '男声古典', { band1Enabled: 1, band1Type: 3, band1Freq: 57, band3Freq: 240, band3Q: 1, band3Gain: -1.3, band5Enabled: 1, band5Freq: 2400, band5Q: .9, band5Gain: .8, band7Enabled: 1, band7Type: 2, band7Freq: 10500, band7Gain: .7 }],
    ['spoken-voice', '清晰旁白', { band1Enabled: 1, band1Type: 3, band1Freq: 83, band3Freq: 230, band3Q: 1.1, band3Gain: -2.2, band5Enabled: 1, band5Freq: 2350, band5Gain: 1.7, band6Enabled: 1, band6Freq: 6000, band6Q: 2, band6Dyn: 1, band6Threshold: -30, band6Range: 4, band6Attack: 4.5, band6Release: 90 }],
    ['bass-tame', '动态控制低频', { band2Enabled: 1, band2Type: 1, band2Freq: 115, band2Dyn: 1, band2Threshold: -24, band2Range: 4, band2Attack: 25, band2Release: 180, band3Freq: 260, band3Gain: -1.2 }],
  ]),
  define('compressor', '压缩器', '平稳动态与并行压缩', '动态', '可调软拐点、Peak / RMS 检测及立体声联动的宽带压缩器。', '#e7b478', [
    db('thresholdDb', '阈值', -60, 0, -18, false, '超过阈值后按压缩比衰减。'), p('ratio', '压缩比', 1, 20, 3, .1, ':1', '输入超过阈值时的压缩比例。'), ms('attackMs', '启动', .1, 200, 15), ms('releaseMs', '释放', 5, 2000, 150), db('kneeDb', '软拐点', 0, 24, 6, true), db('makeupDb', '补偿增益', -24, 24, 0), percent('mix', '混合', 100), choice('detector', '检测方式', ['Peak', 'RMS']), hz('sidechainHpHz', '检测高通', 20, 1000, 20), percent('stereoLink', '声道联动', 100, true, 100, '检测器的左右声道联动程度。'), toggle('autoRelease', '自动释放'),
  ], [['gentle', '轻度压缩', { thresholdDb: -20, ratio: 2, attackMs: 25, releaseMs: 180, kneeDb: 8 }], ['vocal', '人声平稳', { thresholdDb: -22, ratio: 3.5, attackMs: 8, releaseMs: 110, sidechainHpHz: 90 }], ['parallel', '鼓组并行', { thresholdDb: -28, ratio: 8, attackMs: 20, releaseMs: 90, mix: 35 }]]),
  define('gate', '门限 / 扩展器', '控制间隙噪声', '动态', '带迟滞、保持和检测频段的向下扩展器 / 噪声门。', '#d68eb7', [
    db('thresholdDb', '阈值', -96, 0, -45), db('rangeDb', '最大衰减', 0, 96, 60), ms('attackMs', '启动', .1, 200, 2), ms('holdMs', '保持', 0, 2000, 70), ms('releaseMs', '释放', 5, 3000, 180), db('hysteresisDb', '迟滞', 0, 24, 4, true, '开门阈值与关门阈值之差，减少反复开关。'), p('ratio', '扩展比', 1, 20, 8, .1, ':1', '低于阈值后的扩展比例。', { advanced: true }), hz('sidechainHpHz', '检测高通', 20, 2000, 20), hz('sidechainLpHz', '检测低通', 100, 20000, 20000), toggle('listen', '独听检测信号', 0, true, '只在试听时播放检测信号，导出仍使用正常处理。'),
  ], [['vocal-gaps', '人声间隙', { thresholdDb: -42, rangeDb: 24, holdMs: 100, releaseMs: 220, ratio: 3, sidechainHpHz: 80 }], ['drum-tight', '紧致鼓声', { thresholdDb: -30, attackMs: .5, holdMs: 40, releaseMs: 100, rangeDb: 60 }]]),
  define('deesser', '去齿音', '针对齿音的动态抑制', '动态', '选择检测频率、阈值与最大衰减，可独听检测信号。', '#80c7cf', [
    hz('freqHz', '目标频率', 1500, 14000, 6500, false, '齿音检测频带的中心频率。'), p('bandwidthOct', '检测宽度', .25, 4, 1, .05, 'oct', '以八度为单位的检测频带宽度。', { advanced: true }), db('thresholdDb', '阈值', -60, 0, -28), db('rangeDb', '最大抑制', 0, 18, 6), ms('attackMs', '启动', .1, 50, 1, true), ms('releaseMs', '释放', 5, 500, 80, true), choice('mode', '处理方式', ['宽带', '分频'], 1, false, '宽带衰减整体，分频仅衰减齿音频带。'), toggle('listen', '独听齿音', 0, false, '只在试听时播放检测频带，导出仍使用正常处理。'), percent('mix', '混合', 100, true),
  ], [['soft-vocal', '柔和齿音', { freqHz: 6500, thresholdDb: -25, rangeDb: 4 }], ['bright-vocal', '明亮人声抑制', { freqHz: 8000, bandwidthOct: 1.5, thresholdDb: -30, rangeDb: 8, releaseMs: 100 }]]),
  define('transient', '瞬态塑形', '调整起音与延续', '动态', '分别增强或柔化声音的起音与延续。适合突出鼓点、收紧尾音或柔化拨弦。', '#f0a88c', [
    p('attack', '起音', -100, 100, 0, 1, '%', '正值突出鼓点等快速起音，负值柔化起音。'),
    p('sustain', '延续', -100, 100, 0, 1, '%', '正值保留更多声响尾部，负值收紧尾部。'),
    percent('mix', '混合', 100), db('outputDb', '输出增益', -24, 24, 0, true),
  ], [['clear-drums', '鼓点更清晰', { attack: 38, sustain: -14, mix: 80, outputDb: -1 }], ['tight-tail', '收紧尾音', { attack: 8, sustain: -56 }], ['soft-attack', '柔化起音', { attack: -42, sustain: 8, mix: 85 }]]),
  define('reverb', '算法混响', '从短空间到长尾', '空间', '同一反馈延迟网络的空间配置；预设不代表不同物理建模算法。', '#8cbbf2', [
    percent('size', '空间大小', 60, false, 100, '调节内部延迟网络的相对空间尺度。'), p('decaySec', '衰减时间', .1, 15, 1.8, .05, 's', '混响尾音的衰减时间。', { scale: 'log' }), ms('preDelayMs', '预延迟', 0, 250, 20), hz('dampingHz', '高频阻尼', 500, 20000, 6500, false, '控制尾音高频衰减。'), hz('lowCutHz', '低切', 20, 2000, 120), hz('highCutHz', '高切', 1000, 20000, 14000), percent('earlyMix', '早反射比例', 25, true, 100, '早反射相对于混响尾音的比例。'), percent('width', '宽度', 100, true, 200, '混响左右声道的空间展开程度。'), percent('mix', '混合', 20), db('outputDb', '输出增益', -24, 12, 0, true),
    { ...percent('diffusion', '扩散密度', 60, true, 100, '控制尾音扩散密度；较低值保留更明显的间隔。'), optional: true },
    { ...p('earlySize', '早反射间距', 25, 200, 100, 1, '%', '缩放早反射的时间间距；100% 为原始间距。', { advanced: true }), optional: true },
    { ...choice('earlyPattern', '早反射形态', ['原始双反射', '紧凑房间', '展开大厅', '密集板式'], 0, true, '选择早反射的时间与声道分布。'), optional: true },
    { ...p('modRateHz', '调制速率', .05, 3, .17, .01, 'Hz', '混响尾音内部延迟的缓慢调制速率。', { advanced: true, scale: 'log' }), optional: true },
    { ...p('modDepthMs', '调制深度', 0, 1.2, .12, .01, 'ms', '混响尾音内部延迟的调制幅度。', { advanced: true }), optional: true },
    { ...p('bassDecay', '低频衰减比例', .25, 1, 1, .01, '×', '低频尾音相对主衰减时间的比例；降低可减少低频残留。', { advanced: true }), optional: true },
    { ...hz('bassCrossHz', '低频分界', 80, 800, 250, true, '低频尾音衰减的分界频率。'), optional: true },
  ], [
    ['short-room', '短空间', { size: 25, decaySec: .55, preDelayMs: 8, earlyMix: 55, mix: 16 }],
    ['vocal-hall', '人声长尾', { size: 85, decaySec: 2.8, preDelayMs: 45, dampingHz: 5800, mix: 22 }],
    ['ambient', '氛围尾音', { size: 100, decaySec: 7, preDelayMs: 70, earlyMix: 10, dampingHz: 4500, mix: 40 }],
    ['small-booth', '小录音间', { size: 12, decaySec: .28, preDelayMs: 3, dampingHz: 4100, lowCutHz: 160, earlyMix: 68, width: 60, mix: 15, diffusion: 34, earlySize: 40, earlyPattern: 1, modRateHz: .12, modDepthMs: .03, bassDecay: .48, bassCrossHz: 330 }],
    ['drum-room', '鼓房', { size: 35, decaySec: .8, preDelayMs: 9, dampingHz: 7200, lowCutHz: 105, earlyMix: 62, width: 110, mix: 24, diffusion: 48, earlySize: 78, earlyPattern: 1, modRateHz: .2, modDepthMs: .07, bassDecay: .54, bassCrossHz: 260 }],
    ['chamber', '室内乐厅', { size: 52, decaySec: 1.35, preDelayMs: 18, dampingHz: 7800, earlyMix: 45, width: 115, mix: 22, diffusion: 65, earlySize: 105, earlyPattern: 2, modRateHz: .2, modDepthMs: .13, bassDecay: .72, bassCrossHz: 220 }],
    ['stairwell', '楼梯间', { size: 45, decaySec: 1.9, preDelayMs: 13, dampingHz: 9500, highCutHz: 12500, earlyMix: 75, width: 82, mix: 25, diffusion: 25, earlySize: 155, earlyPattern: 2, modRateHz: .08, modDepthMs: .03, bassDecay: .6, bassCrossHz: 300 }],
    ['vocal-plate', '人声板式', { size: 65, decaySec: 1.8, preDelayMs: 32, dampingHz: 8500, lowCutHz: 180, earlyMix: 20, width: 125, mix: 22, diffusion: 88, earlySize: 62, earlyPattern: 3, modRateHz: .38, modDepthMs: .22, bassDecay: .65, bassCrossHz: 300 }],
    ['scoring-hall', '配乐大厅', { size: 88, decaySec: 3.4, preDelayMs: 38, dampingHz: 6800, earlyMix: 32, width: 145, mix: 28, diffusion: 82, earlySize: 145, earlyPattern: 2, modRateHz: .14, modDepthMs: .16, bassDecay: .76, bassCrossHz: 200 }],
    ['cathedral', '大教堂', { size: 100, decaySec: 6.8, preDelayMs: 60, dampingHz: 5300, earlyMix: 25, width: 155, mix: 32, diffusion: 90, earlySize: 190, earlyPattern: 2, modRateHz: .1, modDepthMs: .2, bassDecay: .62, bassCrossHz: 180 }],
    ['dark-tunnel', '暗色隧道', { size: 76, decaySec: 4.4, preDelayMs: 24, dampingHz: 2300, highCutHz: 4200, earlyMix: 58, width: 70, mix: 30, diffusion: 31, earlySize: 180, earlyPattern: 2, modRateHz: .09, modDepthMs: .08, bassDecay: .4, bassCrossHz: 360 }],
    ['shimmering-ambient', '流动氛围', { size: 100, decaySec: 10, preDelayMs: 90, dampingHz: 5200, earlyMix: 8, width: 170, mix: 42, diffusion: 95, earlySize: 125, earlyPattern: 3, modRateHz: .32, modDepthMs: .48, bassDecay: .58, bassCrossHz: 230 }],
  ]),
  define('delay', '立体声延迟', '独立左右与节拍同步', '空间', '左右时间、附点 / 三连音同步、反馈滤波与乒乓延迟。', '#75c4ae', [
    ms('timeMs', '左延迟', 1, 4000, 375), ms('timeRightMs', '右延迟', 1, 4000, 500, true), toggle('sync', 'BPM 同步', 0, false, '按照工程 BPM 计算音符时值；开启后毫秒旋钮暂不生效。'), choice('noteL', '左音符', noteNames, 8, false), choice('noteR', '右音符', noteNames, 9, true), percent('feedback', '反馈', 30, false, 95, '每次重复保留的电平，限制在 95% 以下以保证有限尾音。'), hz('lowCutHz', '反馈低切', 20, 2000, 100), hz('highCutHz', '反馈高切', 1000, 20000, 8000), toggle('pingPong', '乒乓'), percent('width', '宽度', 100, true, 200, '重复声的立体声宽度。'), percent('mix', '混合', 20), db('outputDb', '输出增益', -24, 12, 0, true),
  ], [['slap', '短促回声', { timeMs: 95, timeRightMs: 115, feedback: 12, mix: 18 }], ['dotted', '附点八分', { sync: 1, noteL: 8, noteR: 6, feedback: 35, pingPong: 1, mix: 24 }], ['tape-echo', '暗色重复', { timeMs: 420, timeRightMs: 470, feedback: 48, lowCutHz: 200, highCutHz: 3500, mix: 22 }]]),
  define('saturation', '饱和 / 削波', '谐波色彩与软削波', '音色', '三种静态波形整形与可选过采样；过采样会增加处理延迟。', '#e6a485', [
    db('driveDb', '驱动', 0, 36, 3), p('tone', '音色', -100, 100, 0, 1, '%', '负值偏暗，正值偏亮。'), percent('mix', '混合', 100), db('outputDb', '输出增益', -36, 12, -3), choice('mode', '算法', ['软饱和', 'Tanh', '硬削波'], 0, false), choice('oversample', '过采样', ['1×', '2×', '4×'], 1, true, '更高倍数减少混叠，同时增加计算量和延迟。'), toggle('dcBlock', '移除直流', 1), p('bias', '偏置', -1, 1, 0, .01, '', '引入非对称波形色彩；建议保持直流滤波开启。', { advanced: true }),
  ], [['warm', '温暖染色', { driveDb: 4, outputDb: -3, tone: -20, mix: 55 }], ['parallel-crush', '并行失真', { driveDb: 18, outputDb: -12, mix: 25, mode: 1, oversample: 2 }], ['clip', '峰值削波', { driveDb: 6, outputDb: -6, mode: 2, oversample: 2 }]]),
  define('stereo', '立体声 / 实用工具', '声道与相位检查', '实用', '增益、平衡、宽度、极性和中侧监听；超宽设置可能引起单声道相消。', '#b7c779', [
    db('gainDb', '增益', -60, 24, 0), p('balance', '平衡', -100, 100, 0, 1, '%', '左右声道电平平衡。'), percent('width', '宽度', 100, false, 200, '0% 为单声道；超过 100% 增强侧声道，需检查单声道相消。'), toggle('mono', '单声道检查', 0, false, '临时以单声道试听，不影响导出。'), toggle('phaseLeft', '左声道反相'), toggle('phaseRight', '右声道反相'), toggle('swapChannels', '交换左右'), Object.freeze({ ...choice('channelMode', '声道转换（写入导出）', ['保留立体声', '合并为单声道', '仅侧声道 Side', '左声道复制到两侧', '右声道复制到两侧'], 0, false, '将选择的声道处理写入混音及导出；WAV 文件仍是双声道。'), optional: true }), choice('listen', '监听模式', ['正常监听', 'Mid', 'Side', '左声道', '右声道'], 0, true, '临时检查，不影响导出。'), hz('monoBelowHz', '低频单声道', 0, 500, 0, true, '0 为关闭；仅将此频率以下的低频合为单声道。'),
  ], [['mono-check', '单声道检查', { mono: 1 }], ['wide', '轻微扩宽', { width: 125, monoBelowHz: 120 }], ['mid-listen', '中声道检查', { listen: 1 }]]),
  define('limiter', '限幅器', '采样峰值 / 真峰值', '动态', '可选采样峰值或 8× 真峰值检测；输出成品时建议放在主输出效果链末尾。', '#e4bc67', [
    { ...choice('truePeak', '峰值模式', ['采样峰值', '真峰值 (dBTP)'], 0, false, '真峰值检测采样点之间的峰值，并引入少量自动补偿的延迟。'), optional: true },
    db('inputDb', '驱动', 0, 24, 0), db('ceilingDb', '输出上限', -24, 0, -1), ms('releaseMs', '释放', 5, 2000, 100), ms('lookaheadMs', '前瞻', 0, 20, 5), percent('stereoLink', '声道联动', 100, true, 100, '左右声道共用衰减的程度。'), db('outputDb', '后级增益', -24, 0, 0, true, '限幅后额外衰减；不提升已设置的输出上限。'), toggle('autoRelease', '自动释放'),
  ], [['safe', '轻度峰值保护', { ceilingDb: -1, lookaheadMs: 5, releaseMs: 150 }], ['loud', '增加密度', { inputDb: 5, ceilingDb: -1, lookaheadMs: 8, releaseMs: 80, autoRelease: 1 }], ['delivery-true-peak', '成品真峰值保护', { truePeak: 1, ceilingDb: -1, lookaheadMs: 5, releaseMs: 120 }]]),
  define('meter', '计量 / 分析器', '电平、响度与相关度', '分析', '只分析信号，不改变声音。响度目标用于比较，不自动归一化输出。', '#8fb5ca', [
    p('targetLufs', '响度目标', -36, -5, -14, .1, 'LUFS', '用户比较目标；不代表所有平台的统一要求。'), ms('peakHoldMs', '峰值保持', 0, 10000, 2000), choice('fftSize', '频谱分辨率', ['1024', '2048', '4096', '8192'], 1, false), ms('smoothingMs', '表头平滑', 0, 2000, 250), choice('view', '主视图', ['频谱', '响度', '立体声'], 0, false),
  ], [['mix-check', '混音检查', { targetLufs: -18, fftSize: 2, smoothingMs: 300 }], ['loudness', '响度比较', { view: 1, targetLufs: -14, peakHoldMs: 3000 }], ['stereo-check', '立体声检查', { view: 2, smoothingMs: 150 }]]),
  define('multiband', '三段压缩', '多频段动态控制', '动态', '分别控制低、中、高频段的动态。', '#dfaa79', multibandParameters, [
    ['low-control', '收紧低频', { band1ThresholdDb: -24, band1Ratio: 3, band1AttackMs: 25, band1ReleaseMs: 180, band1MakeupDb: 1 }],
    ['vocal-balance', '平衡人声', { band2ThresholdDb: -22, band2Ratio: 2.5, band2AttackMs: 12, band2ReleaseMs: 120, band3ThresholdDb: -24, band3Ratio: 2, band3AttackMs: 4, band3ReleaseMs: 90 }],
    ['mix-glue', '混音轻压', { band1ThresholdDb: -20, band1Ratio: 1.7, band1AttackMs: 35, band2ThresholdDb: -18, band2Ratio: 1.5, band2AttackMs: 25, band3ThresholdDb: -18, band3Ratio: 1.4, mix: 80 }],
  ]),
  define('convolution', '卷积混响', '合成空间脉冲响应', '空间', '使用四种内置合成脉冲响应塑造空间音色。', '#89bce8', [
    choice('space', '空间', ['录音间', '室内乐厅', '板式风格', '大厅'], 0, false, '选择内置合成空间脉冲响应。'),
    ms('preDelayMs', '预延迟', 0, 180, 0), hz('lowCutHz', '低切', 20, 2000, 100, false), hz('highCutHz', '高切', 1000, 20000, 14000, false),
    percent('mix', '混合', 25), db('outputDb', '输出增益', -24, 12, 0),
  ], [
    ['booth', '紧凑录音间', { space: 0, preDelayMs: 4, mix: 18 }],
    ['chamber', '室内乐厅', { space: 1, preDelayMs: 15, mix: 24 }],
    ['plate', '人声板式风格', { space: 2, preDelayMs: 30, lowCutHz: 180, mix: 22 }],
    ['hall', '宽广大厅', { space: 3, preDelayMs: 40, lowCutHz: 130, highCutHz: 11000, mix: 30 }],
  ]),
  define('modulation', '调制', '合唱、镶边、移相与颤动', '空间', '用周期性调制为空间和音色增加运动。', '#93c9ca', [
    choice('mode', '模式', ['合唱', '镶边', '移相', '颤音', '音高颤动'], 0, false),
    p('rateHz', '速率', .05, 10, .35, .01, 'Hz', '自由调制速率。', { scale: 'log' }), percent('depth', '深度', 45), percent('mix', '混合', 35),
    ms('delayMs', '基础延迟', 8, 30, 16, true), ms('flangeMs', '镶边延迟', .5, 8, 3, true),
    p('phaseDegrees', '立体声相位', 0, 180, 90, 1, '°', '左右调制的相位差。', { advanced: true }), p('feedback', '反馈', -80, 80, 20, 1, '%', '调制反馈量。', { advanced: true }),
    choice('stages', '移相级数', ['4 级', '6 级', '8 级'], 1), hz('centerHz', '中心频率', 150, 2500, 950, true),
    choice('waveform', '波形', ['正弦', '三角', '软方波'], 0), ms('vibratoMs', '延迟摆幅', 0, 5, 2, true),
    toggle('sync', '同步节拍', 0, false), choice('note', '节拍时值', [...noteNames, '2 小节'], 9, false),
  ], [
    ['light-chorus', '轻合唱', { depth: 25, mix: 25, rateHz: .3 }], ['double-vocal', '双重人声', { depth: 40, mix: 32, delayMs: 22, phaseDegrees: 150 }],
    ['jet-flanger', '喷气镶边', { mode: 1, rateHz: .16, depth: 70, mix: 50, feedback: 55 }], ['vintage-phaser', '复古移相', { mode: 2, rateHz: .28, depth: 60, mix: 45, feedback: 25 }],
    ['beat-tremolo', '节拍颤音', { mode: 3, sync: 1, note: 9, depth: 65, mix: 100 }], ['slow-vibrato', '慢速变调', { mode: 4, rateHz: 3, depth: 45, mix: 100, vibratoMs: 1.2 }],
  ]),
  define('denoise', '去噪', '频谱去噪、去嗡声与去混响', '修复', '可独立启用稳态底噪、电源嗡声和混响拖尾的处理。', '#80c7cf', [
    { ...choice('repairMode', '修复模式', ['频谱去噪', '去嗡声', '去混响']), optional: true },
    { ...toggle('spectralEnabled', '频谱去噪', 1), optional: true },
    { ...toggle('humEnabled', '去嗡声'), optional: true },
    { ...toggle('dereverbEnabled', '去混响'), optional: true },
    db('reductionDb', '去噪量', 0, 24, 8), percent('sensitivity', '灵敏度', 50, false, 100, '控制接近噪声基线时的处理程度。'),
    percent('transient', '瞬态保护', 60, false, 100, '减轻对鼓点和辅音的削弱。'), choice('smoothing', '平滑', ['轻', '标准', '强'], 1, false),
    hz('lowHz', '处理下限', 20, 20000, 20, true), hz('highHz', '处理上限', 20, 24000, 24000, true), percent('mix', '混合', 100, true),
    ...[
      choice('humFrequency', '电源基频', ['50 Hz', '60 Hz']),
      p('humHarmonics', '谐波数', 1, 8, 3, 1, '', '包含基频。例如 50 Hz 的前三项为 50、100 和 150 Hz。', { advanced: true }),
      percent('humStrength', '去嗡强度', 100, true, 100, '控制陷波处理的比例。'),
      p('humQ', '陷波 Q 值', 12, 36, 24, 1, '', 'Q 越大，受影响的频率范围越窄。', { advanced: true }),
      db('reverbReductionDb', '拖尾衰减上限', 0, 18, 8, true, '估计的混响拖尾最多可降低此数值。'),
      ms('reverbDecayMs', '房间衰减时间', 120, 1500, 550, true, '按原录音中听到的拖尾长度估计。'),
      percent('reverbProtect', '起音保护', 65, true, 100, '较高的保护保留更多字头、拨弦和鼓点。'),
    ].map(parameter => ({ ...parameter, optional: true })),
  ], [['gentle', '轻度去噪', { reductionDb: 5, transient: 75 }], ['voice', '对白底噪', { reductionDb: 10, sensitivity: 55, transient: 70 }], ['strong', '较强去噪', { reductionDb: 16, sensitivity: 65, smoothing: 2 }],
    ['hum-50', '50 Hz 嗡声', { repairMode: 1 }], ['hum-60', '60 Hz 嗡声', { repairMode: 1, humFrequency: 1 }], ['room-tail', '轻度房间拖尾', { repairMode: 2, reverbReductionDb: 6, reverbProtect: 75 }]]),
  define('lofi', 'Lo-Fi', '磁带、黑胶、数字与收音机', '声音设计', '用带限、抖动、噪声和数字降质塑造复古质感。', '#d2a981', [
    choice('style', '风格', ['磁带', '黑胶', '复古数字', '旧收音机'], 0, false), percent('amount', '强度', 50, false, 100, '整体效果强度。'), percent('mix', '混合', 65),
    p('tone', '色调', -100, 100, 0, 1, '%', '负值偏暗，正值偏亮。', { advanced: true }), percent('saturation', '饱和', 25, true), percent('wow', '慢速抖动', 15, true), percent('flutter', '快速抖动', 10, true),
    db('noiseDb', '底噪', -70, -24, -55, true), percent('crackle', '爆点密度', 22, true), p('bits', '位深', 4, 16, 10, 1, 'bit', '数字量化位深。', { advanced: true }),
    hz('rateHz', '目标采样率', 2000, 24000, 11000, true), toggle('smooth', '平滑', 1), hz('lowCutHz', '低切', 80, 800, 300, true), hz('highCutHz', '高切', 1000, 12000, 3600, true), toggle('mono', '单声道', 1),
  ], [['tape', '柔和磁带', { style: 0, amount: 45, mix: 65 }], ['vinyl', '旧黑胶', { style: 1, amount: 55, crackle: 28, noiseDb: -52 }], ['digital', '复古数字', { style: 2, bits: 8, rateHz: 9000, smooth: 0 }], ['radio', '旧收音机', { style: 3, lowCutHz: 350, highCutHz: 3200, mono: 1 }]]),
  define('pedal', '踏板音色', '吉他／贝斯效果器', '声音设计', '清音、过载、失真及箱体音色。', '#e0a98d', [
    choice('mode', '模式', ['清音', '过载', '失真'], 0, false), db('inputDb', '输入增益', -18, 18, 0, true), db('driveDb', '驱动', 0, 30, 6),
    p('tone', '音色', -100, 100, 0, 1, '%', '负值偏暗，正值偏亮。'), choice('cab', '箱体', ['关闭', '小箱体', '开放式', '封闭式', '贝斯箱体'], 0, false),
    percent('mix', '混合', 100), percent('lowKeep', '低频保留', 0, true, 100, '保留低频干声。'), hz('lowHz', '低频分界', 70, 250, 130, true),
    p('oversample', '过采样', 1, 2, 1, 1, '', '驱动部分的过采样。', { advanced: true, options: ['2×', '4×'] }), db('outputDb', '输出增益', -24, 12, 0),
  ], [['clean-guitar', '干净吉他', { mode: 0, driveDb: 3, cab: 2 }], ['warm-drive', '温暖过载', { mode: 1, driveDb: 12, tone: -10, cab: 2, outputDb: -3 }], ['tight-distortion', '紧实失真', { mode: 2, driveDb: 18, cab: 3, outputDb: -6 }], ['bass', '贝斯保底', { mode: 1, driveDb: 10, cab: 4, lowKeep: 70, outputDb: -3 }]]),
  define('ducker', '回避（Ducking）', '让声音为另一轨道让位', '动态', '当触发音轨的声音超过阈值时，自动降低当前声音。', '#df9a85', [
    { ...choice('mode', '回避方式', ['固定深度', '动态平衡', '频段回避'], 0, false, '频段回避根据两路选定频带的电平，仅压低当前声音的该频带。'), optional: true },
    db('thresholdDb', '阈值', -60, 0, -30, false, '触发音轨超过此电平时开始回避。'),
    db('depthDb', '回避深度', 0, 36, 12, false, '触发时的目标衰减量。'),
    { ...db('marginDb', '人声领先', 0, 12, 3, true, '动态平衡希望触发音轨比当前音轨高出的电平。'), optional: true },
    { ...hz('bandHz', '回避中心频率', 250, 8000, 1800, true, '检测与衰减围绕这个频率进行。'), optional: true },
    { ...p('bandQ', '回避 Q 值', .35, 3, .8, .01, '', 'Q 越大，回避频带越窄。', { advanced: true, scale: 'log' }), optional: true },
    { ...toggle('smoothTrigger', '平滑人声触发', 0, true, '跟踪触发轨的宽带有效电平。频段回避仍只衰减选定的频带。'), optional: true },
    ms('attackMs', '启动', 1, 250, 12), ms('holdMs', '保持', 0, 500, 100), ms('releaseMs', '释放', 10, 2500, 300),
    db('hysteresisDb', '迟滞', 0, 12, 4, true, '触发与恢复阈值之间的间隔，减少反复切换。'),
  ], [
    ['gentle-narration', '轻柔旁白', { thresholdDb: -32, depthDb: 8, attackMs: 30, holdMs: 180, releaseMs: 600, hysteresisDb: 4 }],
    ['clear-dialogue', '清晰对白', { thresholdDb: -30, depthDb: 14, attackMs: 12, holdMs: 150, releaseMs: 350, hysteresisDb: 4 }],
    ['rhythmic-ducking', '节奏闪避', { thresholdDb: -24, depthDb: 12, attackMs: 3, holdMs: 20, releaseMs: 120, hysteresisDb: 3 }],
    ['adaptive-dialogue', '动态对白', { mode: 1, marginDb: 3, thresholdDb: -30, depthDb: 14, attackMs: 12, holdMs: 150, releaseMs: 350, hysteresisDb: 4 }],
    ['vocal-band', '人声频段让位', { mode: 2, bandHz: 1800, bandQ: .8, depthDb: 6, thresholdDb: -35, attackMs: 18, holdMs: 100, releaseMs: 280 }],
  ]),
])
export const DAW_EFFECT_DEFINITIONS = Object.freeze(Object.fromEntries(DAW_EFFECT_CATALOG.map(definition => [definition.type, definition]))) as Readonly<Record<DawEffectType, DawEffectDefinition>>
export const isDawEffectType = (type: unknown): type is DawEffectType => typeof type === 'string' && (DAW_EFFECT_TYPES as readonly string[]).includes(type)
export function getEffectDefinition(type: DawEffectType): DawEffectDefinition {
  if (!isDawEffectType(type)) throw new DawValidationError([{ path: 'effect.type', message: '未知内置效果类型' }])
  return DAW_EFFECT_DEFINITIONS[type]
}
export function getAutoMixEffectName(type: DawEffectType | 'outputGain'): string {
  return `自动混音·${type === 'outputGain' ? '输出增益' : getEffectDefinition(type).name}`
}
export function getEffectDisplayName(effect: DawEffect): string {
  const { id, name, type } = effect
  if (type !== 'vst3' && id.startsWith('automix-') && name?.startsWith('自动混音 · ')) {
    return getAutoMixEffectName(name === '自动混音 · 输出增益' ? 'outputGain' : type)
  }
  return name || (type === 'vst3' ? 'VST3 插件' : getEffectDefinition(type).name)
}
export const getEffectDefaultParams = (type: DawEffectType): Record<string, number> => parameterDefaults(getEffectDefinition(type).parameters)
export const getEffectParameters = (type: DawEffectType, advanced = false): readonly DawEffectParameter[] => getEffectDefinition(type).parameters.filter(parameter => advanced || !parameter.advanced)
export function formatEffectParameter(parameter: DawEffectParameter, value: number): string {
  if (parameter.options) return parameter.options[value - parameter.min] ?? String(value)
  if (parameter.unit === 'Hz' && value >= 1000) return `${Number((value / 1000).toFixed(2))} kHz`
  const precision = parameter.step >= 1 ? 0 : parameter.step >= .1 ? 1 : 2
  return `${Number(value.toFixed(precision))}${parameter.unit ? ` ${parameter.unit}` : ''}`
}
/** Display the same active settings in the plan and the saved EQ editor. */
export function describeEnabledEqBands(params: Record<string, number>) {
  const parameters = new Map(eqParameters.map(parameter => [parameter.key, parameter]))
  const read = (key: string) => params[key] ?? parameters.get(key)!.default
  const format = (key: string) => formatEffectParameter(parameters.get(key)!, read(key))
  return Array.from({ length: 8 }, (_, index) => index + 1).flatMap(band => {
    const prefix = `band${band}`
    if (!read(`${prefix}Enabled`)) return []
    const type = read(`${prefix}Type`)
    const details = [format(`${prefix}Freq`)]
    if (type === 3 || type === 4) details.push(format(`${prefix}Slope`))
    else {
      if (type !== 5) details.push(format(`${prefix}Gain`))
      details.push(`Q ${format(`${prefix}Q`)}`)
    }
    return [{ band, filter: format(`${prefix}Type`), details: details.join(' · ') }]
  })
}
export function createEffect(type: DawEffectType | 'vst3', presetId = 'default'): DawBuiltinEffect {
  if (type === 'vst3') throw new DawValidationError([{ path: 'effect.type', message: 'VST3 需要插件信息' }])
  const preset = getEffectDefinition(type).presets.find(item => item.id === presetId)
  if (!preset) throw new DawValidationError([{ path: 'effect.presetId', message: '找不到内置预设' }])
  return { id: globalThis.crypto.randomUUID(), type, enabled: true, params: { ...preset.params }, presetId }
}

const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const idPattern = /^[a-zA-Z0-9_-]{1,160}$/
const fields = new Set(['id', 'type', 'enabled', 'params', 'name', 'presetId', 'bState', 'abSlot', 'noiseProfile', 'bNoiseProfile', 'sidechainTrackId', 'bSidechainTrackId', 'vst3'])
export function remainingDawEffectSlots(effects: readonly DawEffect[]): number {
  return Math.max(0, Math.min(DAW_MAX_STORED_EFFECTS - effects.length, DAW_MAX_EFFECTS - effects.filter(effect => effect.enabled).length))
}
function capacityIssue(effects: readonly unknown[]): string | undefined {
  if (effects.length > DAW_MAX_STORED_EFFECTS) return `每条效果链最多保留 ${DAW_MAX_STORED_EFFECTS} 项`
  if (effects.filter(effect => plainObject(effect) && effect.enabled === true).length > DAW_MAX_EFFECTS) {
    return `每条效果链最多同时启用 ${DAW_MAX_EFFECTS} 项`
  }
}
/** Unknown fields are errors: a saved parameter may never silently stop affecting audio. */
export function validateEffectChain(input: unknown, path = 'effects', ids = new Set<string>()): DawValidationIssue[] {
  const issues: DawValidationIssue[] = []
  const error = (at: string, message: string) => { if (issues.length < 100) issues.push({ path: at, message }) }
  if (!Array.isArray(input)) return [{ path, message: '效果链必须为数组' }]
  const capacity = capacityIssue(input)
  if (capacity) return [{ path, message: capacity }]
  for (const [index, raw] of input.entries()) {
    const at = `${path}[${index}]`
    if (!plainObject(raw)) { error(at, '效果实例必须是普通对象'); continue }
    for (const key of Object.keys(raw)) if (!fields.has(key)) error(`${at}.${key}`, '未知效果字段')
    if (typeof raw.id !== 'string' || !idPattern.test(raw.id)) error(`${at}.id`, '效果标识格式不合法')
    else { if (ids.has(raw.id)) error(`${at}.id`, '效果实例标识重复'); ids.add(raw.id) }
    if (typeof raw.enabled !== 'boolean') error(`${at}.enabled`, '启用状态必须为布尔值')
    if (raw.name !== undefined && (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 240)) error(`${at}.name`, '名称必须为 1–240 字符文字')
    if (raw.abSlot !== undefined && raw.abSlot !== 'A' && raw.abSlot !== 'B') error(`${at}.abSlot`, '比较槽必须为 A 或 B')
    if (raw.type === 'vst3') {
      for (const key of Object.keys(raw)) if (!['id', 'type', 'enabled', 'params', 'name', 'vst3'].includes(key)) error(`${at}.${key}`, 'VST3 不支持此字段')
      if (!plainObject(raw.vst3) || Object.keys(raw.vst3).length !== 1 || typeof raw.vst3.classId !== 'string' || !/^[0-9A-F]{32}$/.test(raw.vst3.classId)) error(`${at}.vst3`, 'VST3 classId 必须为 32 位大写十六进制字符')
      if (!plainObject(raw.params)) error(`${at}.params`, '效果参数必须是普通对象')
      else for (const [key, value] of Object.entries(raw.params)) {
        if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) > 4294967295 || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) error(`${at}.params.${key}`, '参数 ID 必须为无符号 32 位整数，值必须在 0–1 之间')
      }
      continue
    }
    if (!isDawEffectType(raw.type)) { error(`${at}.type`, '未知效果类型'); continue }
    if (raw.vst3 !== undefined) error(`${at}.vst3`, '内置效果不能包含 VST3 信息')
    for (const field of ['noiseProfile', 'bNoiseProfile']) {
      const profile = raw[field]
      if (profile === undefined) continue
      if (raw.type !== 'denoise' || !Array.isArray(profile) || profile.length !== 128 || Array.from(profile).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < -180 || value > 40)) error(`${at}.${field}`, '噪声曲线仅适用于去噪，必须包含 128 个 −180–40 dB 的有限数值')
    }
    for (const field of ['sidechainTrackId', 'bSidechainTrackId']) {
      const source = raw[field]
      if (source !== undefined && (raw.type !== 'ducker' || typeof source !== 'string' || !idPattern.test(source))) error(`${at}.${field}`, '触发音轨标识仅适用于回避效果，且必须是有效标识')
    }
    const definition = getEffectDefinition(raw.type)
    if (raw.presetId !== undefined && !definition.presets.some(item => item.id === raw.presetId)) error(`${at}.presetId`, '未知内置预设')
    for (const field of ['params', ...(raw.bState === undefined ? [] : ['bState'])]) {
      const params = raw[field]
      if (!plainObject(params)) { error(`${at}.${field}`, '效果参数必须是普通对象'); continue }
      const keys = new Set(definition.parameters.map(parameter => parameter.key))
      for (const key of Object.keys(params)) if (!keys.has(key)) error(`${at}.${field}.${key}`, '未知效果参数')
      for (const parameter of definition.parameters) {
        const value = params[parameter.key]
        if (value === undefined && parameter.optional) continue
        if (typeof value !== 'number' || !Number.isFinite(value) || value < parameter.min || value > parameter.max || ((parameter.options || parameter.key === 'bits') && !Number.isInteger(value))) error(`${at}.${field}.${parameter.key}`, `必须是 ${parameter.min}–${parameter.max} 范围内的${parameter.options ? '枚举整数' : '有限数字'}`)
      }
    }
  }
  return issues
}
export function cloneEffect(effect: DawEffect, newId = false): DawEffect {
  return { id: newId ? globalThis.crypto.randomUUID() : effect.id, type: effect.type, ...(effect.vst3 ? { vst3: { classId: effect.vst3.classId } } : {}), enabled: effect.enabled, params: { ...effect.params }, ...(effect.name === undefined ? {} : { name: effect.name }), ...(effect.presetId === undefined ? {} : { presetId: effect.presetId }), ...(effect.bState === undefined ? {} : { bState: { ...effect.bState } }), ...(effect.abSlot === undefined ? {} : { abSlot: effect.abSlot }), ...(effect.noiseProfile === undefined ? {} : { noiseProfile: [...effect.noiseProfile] }), ...(effect.bNoiseProfile === undefined ? {} : { bNoiseProfile: [...effect.bNoiseProfile] }), ...(effect.sidechainTrackId === undefined ? {} : { sidechainTrackId: effect.sidechainTrackId }), ...(effect.bSidechainTrackId === undefined ? {} : { bSidechainTrackId: effect.bSidechainTrackId }) }
}
export const cloneEffectChain = (chain: readonly DawEffect[], newIds = false): DawEffect[] => chain.map(effect => cloneEffect(effect, newIds))
const emptyChain: readonly DawEffect[] = Object.freeze([])
function fail(path: string, message: string): never { throw new DawValidationError([{ path, message }]) }
/** Clip IDs cannot contain colons, so the prefix is unambiguous with track IDs. */
export const clipEffectTarget = (clipId: string): DawEffectTarget => `clip:${clipId}`
export function resolveEffectTarget(session: DawSession, target: DawEffectTarget):
  | { kind: 'master' }
  | { kind: 'track'; track: DawTrack }
  | { kind: 'clip'; track: DawTrack; clip: DawClip }
  | undefined {
  if (target === 'master') return { kind: 'master' }
  if (target.startsWith('clip:')) {
    const clipId = target.slice(5)
    for (const track of session.tracks) {
      const clip = track.clips.find(item => item.id === clipId)
      if (clip) return { kind: 'clip', track, clip }
    }
    return undefined
  }
  const track = session.tracks.find(item => item.id === target)
  return track ? { kind: 'track', track } : undefined
}
export function getEffectChain(session: DawSession, target: DawEffectTarget): readonly DawEffect[] {
  const resolved = resolveEffectTarget(session, target) ?? fail('effect.target', '找不到效果目标')
  if (resolved.kind === 'master') return session.masterEffects ?? emptyChain
  return (resolved.kind === 'track' ? resolved.track.effects : resolved.clip.effects) ?? emptyChain
}
export const getEffect = (session: DawSession, target: DawEffectTarget, id: string): DawEffect => getEffectChain(session, target).find(effect => effect.id === id) ?? fail('effect.id', '找不到效果实例')
const allIds = (session: DawSession, excluding?: string) => new Set([...session.masterEffects ?? [], ...session.tracks.flatMap(track => [...track.effects ?? [], ...track.clips.flatMap(clip => clip.effects ?? [])])].filter(effect => effect.id !== excluding).map(effect => effect.id))
function replaceChain(session: DawSession, target: DawEffectTarget, effects: DawEffect[]): DawSession {
  const capacity = capacityIssue(effects)
  if (capacity) fail('effects', capacity)
  const resolved = resolveEffectTarget(session, target) ?? fail('effect.target', '找不到效果目标')
  if (resolved.kind === 'clip' && effects.some(effect => effect.type === 'vst3')) fail('effects', 'VST3 暂不支持片段效果链')
  if (resolved.kind === 'master') return { ...session, masterEffects: effects }
  return { ...session, tracks: session.tracks.map(track => track.id !== resolved.track.id ? track : resolved.kind === 'track' ? { ...track, effects } : { ...track, clips: track.clips.map(clip => clip.id === resolved.clip.id ? { ...clip, effects } : clip) }) }
}
/** Return a replacement chain only when at least one insert was enabled. */
export function bypassEnabledEffects(effects?: readonly DawEffect[]): DawEffect[] | undefined {
  if (!effects?.some(effect => effect.enabled)) return undefined
  return effects.map(effect => effect.enabled ? { ...effect, enabled: false } : effect)
}
export function bypassEffectChain(session: DawSession, target: DawEffectTarget): DawSession {
  const effects = bypassEnabledEffects(getEffectChain(session, target))
  return effects ? replaceChain(session, target, effects) : session
}
function assertChain(chain: unknown, ids?: Set<string>): void {
  const issues = validateEffectChain(chain, 'effects', ids)
  if (issues.length) throw new DawValidationError(issues)
}
export function addEffect(session: DawSession, target: DawEffectTarget, effect: DawEffectType | DawEffect, index?: number): DawSession {
  const chain = getEffectChain(session, target), source = typeof effect === 'string' ? createEffect(effect) : effect
  assertChain([source], allIds(session))
  const next = cloneEffect(source)
  const position = index ?? chain.length
  if (!Number.isInteger(position) || position < 0 || position > chain.length) fail('effect.index', '插入位置超出范围')
  return replaceChain(session, target, [...chain.slice(0, position), next, ...chain.slice(position)])
}
export interface DawEffectPatch { enabled?: boolean; name?: string; params?: Record<string, number>; presetId?: string | null; bState?: Record<string, number> | null; abSlot?: 'A' | 'B'; noiseProfile?: number[] | null; bNoiseProfile?: number[] | null; sidechainTrackId?: string | null; bSidechainTrackId?: string | null }
export function updateEffect(session: DawSession, target: DawEffectTarget, id: string, patch: DawEffectPatch): DawSession {
  const current = getEffect(session, target, id)
  if (!plainObject(patch)) fail('effect.patch', '效果更新必须是普通对象')
  for (const key of Object.keys(patch)) if (!['enabled', 'name', 'params', 'presetId', 'bState', 'abSlot', 'noiseProfile', 'bNoiseProfile', 'sidechainTrackId', 'bSidechainTrackId'].includes(key)) fail(`effect.${key}`, '未知效果更新字段')
  if (patch.params !== undefined && !plainObject(patch.params)) fail('effect.params', '效果参数更新必须是普通对象')
  const next = { ...current, ...patch, params: { ...current.params, ...patch.params } } as DawEffect
  if (patch.params && patch.presetId === undefined || patch.presetId === null) delete next.presetId
  if (patch.bState === null) delete next.bState
  else if (next.bState) next.bState = { ...next.bState }
  for (const field of ['noiseProfile', 'bNoiseProfile'] as const) {
    if (patch[field] === null) delete next[field]
    else if (next[field]) next[field] = [...next[field]!]
  }
  for (const field of ['sidechainTrackId', 'bSidechainTrackId'] as const) if (patch[field] === null) delete next[field]
  assertChain([next], allIds(session, id))
  return replaceChain(session, target, getEffectChain(session, target).map(effect => effect.id === id ? next : effect))
}
export function removeEffect(session: DawSession, target: DawEffectTarget, id: string): DawSession {
  getEffect(session, target, id)
  return replaceChain(session, target, getEffectChain(session, target).filter(effect => effect.id !== id))
}
export const deleteEffect = removeEffect
export function moveEffect(session: DawSession, target: DawEffectTarget, id: string, index: number): DawSession {
  const chain = [...getEffectChain(session, target)], from = chain.findIndex(effect => effect.id === id)
  if (from < 0) fail('effect.id', '找不到效果实例')
  if (!Number.isInteger(index) || index < 0 || index >= chain.length) fail('effect.index', '排序位置超出范围')
  if (from === index) return session
  const [effect] = chain.splice(from, 1); chain.splice(index, 0, effect)
  return replaceChain(session, target, chain)
}
export const reorderEffect = moveEffect
export function copyEffect(session: DawSession, target: DawEffectTarget, id: string, destination = target): DawSession {
  const chain = getEffectChain(session, target)
  return addEffect(session, destination, cloneEffect(getEffect(session, target, id), true), target === destination ? chain.findIndex(effect => effect.id === id) + 1 : undefined)
}
export function resetEffect(session: DawSession, target: DawEffectTarget, id: string): DawSession {
  const current = getEffect(session, target, id)
  return updateEffect(session, target, id, { params: getEffectDefaultParams(current.type === 'vst3' ? fail('effect.type', 'VST3 不支持内置预设') : current.type), presetId: 'default' })
}
export function applyEffectPreset(session: DawSession, target: DawEffectTarget, id: string, presetId: string): DawSession {
  const type = getEffect(session, target, id).type
  if (type === 'vst3') fail('effect.type', 'VST3 不支持内置预设')
  const preset = getEffectDefinition(type).presets.find(item => item.id === presetId) ?? fail('effect.presetId', '找不到内置预设')
  return updateEffect(session, target, id, { params: { ...preset.params }, presetId })
}
export function copyEffectChain(session: DawSession, source: DawEffectTarget, destination: DawEffectTarget): DawSession {
  getEffectChain(session, destination)
  return replaceChain(session, destination, cloneEffectChain(getEffectChain(session, source), true))
}
/** Switch the one active instance; no second DSP chain is created. */
export function switchEffectAB(session: DawSession, target: DawEffectTarget, id: string): DawSession {
  const effect = getEffect(session, target, id)
  if (effect.type === 'vst3') fail('effect.type', 'VST3 暂不支持 A/B 比较')
  return updateEffect(session, target, id, { params: { ...getEffectDefaultParams(effect.type), ...(effect.bState ?? effect.params) }, bState: { ...effect.params }, noiseProfile: (effect.bState ? effect.bNoiseProfile : effect.noiseProfile) ?? null, bNoiseProfile: effect.noiseProfile ?? null, sidechainTrackId: (effect.bState ? effect.bSidechainTrackId : effect.sidechainTrackId) ?? null, bSidechainTrackId: effect.sidechainTrackId ?? null, abSlot: effect.abSlot === 'B' ? 'A' : 'B', presetId: null })
}
/** Clone the audible slot into the other slot without changing which slot is audible. */
export function copyActiveEffectSlot(effect: DawEffect): DawEffect {
  return { ...effect, bState: { ...effect.params }, bNoiseProfile: effect.noiseProfile?.slice(), bSidechainTrackId: effect.sidechainTrackId }
}
export function copyEffectAToB(session: DawSession, target: DawEffectTarget, id: string): DawSession {
  const effect = getEffect(session, target, id)
  if (effect.type === 'vst3') fail('effect.type', 'VST3 暂不支持 A/B 比较')
  if (effect.abSlot === 'B') return updateEffect(session, target, id, { params: { ...getEffectDefaultParams(effect.type), ...(effect.bState ?? effect.params) }, noiseProfile: effect.bNoiseProfile ?? null, sidechainTrackId: effect.bSidechainTrackId ?? null, presetId: null })
  return updateEffect(session, target, id, { bState: { ...effect.params }, bNoiseProfile: effect.noiseProfile ?? null, bSidechainTrackId: effect.sidechainTrackId ?? null })
}
