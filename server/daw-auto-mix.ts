import { getEffectChain, remainingDawEffectSlots } from '../src/daw/effects';
import { sessionDuration, type DawSession } from '../src/daw/model';
import {
  DEFAULT_AUTO_MIX_DELIVERY, applyAutoMixPlan, autoMixEffectInstanceId, bypassAutoMixInserts, isBalanceChange,
  type AutoMixChange, type AutoMixOptions, type AutoMixPlan, type AutoMixProbe, type AutoMixRange, type AutoMixScan,
} from '../src/daw/auto-mix';
import { findAutoMixNoiseRange, proposeAutoMix } from './daw-auto-mix-rules';

const error = (message: string) => Object.assign(new Error(message), { status: 400 });
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('自动混音参数格式无效');
  return value as Record<string, unknown>;
};
function choice<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw error(`${label}选项无效`);
  return value as T;
}
function numeric(value: unknown, min: number, max: number, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw error(`${label}超出支持范围`);
  return value;
}
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number) => Math.round(value * 10) / 10;

export function readAutoMixRange(value: unknown, duration: number, maxLength = duration): AutoMixRange {
  const input = record(value);
  const start = numeric(input.start, 0, duration, '区间起点');
  const end = numeric(input.end, start, duration + 1e-6, '区间终点');
  if (end - start < .02 - 1e-9 || end - start > maxLength + 1e-9) throw error('自动混音区间时长无效');
  return { start, end: Math.min(end, duration) };
}

export function readAutoMixOptions(value: unknown, session: DawSession): AutoMixOptions {
  const input = record(value);
  const assignments = record(input.roles);
  const track = (id: unknown) => {
    const found = session.tracks.find(item => item.id === id);
    if (!found || found.muted || !found.clips.length) throw error('请选择含有片段且未静音的音轨');
    return found.id;
  };
  const lead = track(assignments.lead), backing = track(assignments.backing);
  const harmony = assignments.harmony == null || assignments.harmony === '' ? undefined : track(assignments.harmony);
  if (lead === backing || harmony === lead || harmony === backing) throw error('所选音轨必须各不相同');
  const delivery = input.delivery == null ? DEFAULT_AUTO_MIX_DELIVERY : record(input.delivery);
  const duration = sessionDuration(session);
  const handoffs = harmony ? input.handoffs : undefined;
  if (handoffs !== undefined && (!Array.isArray(handoffs) || handoffs.length > 64)) throw error('接唱区间数量无效');
  const excluded = input.excludedChangeIds;
  if (excluded !== undefined && (!Array.isArray(excluded) || excluded.length > 128 ||
      excluded.some(id => typeof id !== 'string' || !/^automix-[a-z0-9_-]{1,150}$/i.test(id)))) throw error('自动混音变更标识无效');
  return {
    roles: { lead, harmony, backing },
    harmony: harmony ? choice(input.harmony, ['support', 'duet', 'mixed'] as const, '和声用途') : 'support',
    direction: choice(input.direction, ['blended', 'natural', 'forward'] as const, '混音方向'),
    genre: choice(input.genre, ['none', 'pop', 'rock', 'acoustic'] as const, '曲风'),
    space: choice(input.space, ['unchanged', 'room', 'plate'] as const, '人声空间'),
    spaceAmount: numeric(input.spaceAmount, 0, 100, '空间强度'),
    handoffs: handoffs?.map(range => readAutoMixRange(range, duration)).sort((a, b) => a.start - b.start),
    excludedChangeIds: excluded as string[] | undefined,
    delivery: {
      mode: choice(delivery.mode, ['preserve', 'peak', 'custom'] as const, '交付电平'),
      ceilingDb: numeric(delivery.ceilingDb, -12, 0, '真峰值上限'),
      targetLufs: numeric(delivery.targetLufs, -36, -8, '综合响度目标'),
    },
  };
}

type ScanMix = (session: DawSession, roles: string[], probeIds?: string[], outputOnly?: boolean) => Promise<AutoMixScan>;
type LearnNoise = (session: DawSession, trackId: string, effectId: string, range: AutoMixRange) => Promise<number[] | null>;
type EffectChange = Extract<AutoMixChange, { kind: 'effect' }>;
const isDynamic = (change: AutoMixChange): change is EffectChange =>
  change.kind === 'effect' && ['compressor', 'deesser', 'ducker'].includes(change.type);
const outputGainId = 'automix-output-trim';
const outputLimiterId = 'automix-output-limiter';
const outputMeterId = 'automix-output-meter';

function appendDelivery(session: DawSession, plan: AutoMixPlan, options: AutoMixOptions, measured: AutoMixScan['output']) {
  const delivery = options.delivery ?? DEFAULT_AUTO_MIX_DELIVERY;
  const skipped = new Set(options.excludedChangeIds);
  const ceiling = delivery.mode === 'preserve' ? -1 : delivery.ceilingDb;
  let available = remainingDawEffectSlots(getEffectChain(session, 'master'));
  if (!available) {
    plan.notes.push('主输出效果链已满，无法添加新的输出处理。');
    return;
  }
  const limitSelected = !skipped.has(outputLimiterId);
  const linearRoom = measured.truePeak === null ? 0 : ceiling - measured.truePeak;
  const limitAllowance = limitSelected ? (delivery.mode === 'custom' ? 1.5 : 1) : 0;
  const desiredGain = delivery.mode === 'custom' && measured.integrated !== null
    ? delivery.targetLufs - measured.integrated : Math.min(0, linearRoom + limitAllowance);
  const trim = Math.floor(clamp(Math.min(desiredGain, linearRoom + limitAllowance), -60, 24) * 10) / 10;
  if (Math.abs(trim) >= .1 && available > Number(limitSelected)) {
    plan.changes.push({ id: outputGainId, target: 'master', kind: 'outputGain', deltaDb: trim,
      label: '输出增益', reason: delivery.mode === 'custom'
        ? '按实测响度与峰值余量调整交付电平。' : '优先用输出增益留出余量，减少持续限幅。' });
    if (!skipped.has(outputGainId)) available--;
  }
  plan.changes.push({ id: outputLimiterId, target: 'master', kind: 'effect', type: 'limiter',
    params: { truePeak: 1, inputDb: 0, ceilingDb: ceiling, lookaheadMs: 5, releaseMs: 120 },
    label: '主输出真峰值保护', reason: '控制超过输出上限的峰值，并复测实际衰减。' });
  if (limitSelected) available--;
  if (available > 0) {
    plan.changes.push({ id: outputMeterId, target: 'master', kind: 'effect', type: 'meter',
      params: { view: 1, targetLufs: delivery.targetLufs }, label: '主输出计量',
      reason: '在输出处理之后显示实际响度和真峰值。' });
  } else if (!skipped.has(outputMeterId)) {
    plan.notes.push('主输出效果链剩余位置有限，导出页仍可查看最终计量。');
  }
}

function calibrateDynamic(change: EffectChange, probe: AutoMixProbe, scan: AutoMixScan) {
  const previous = { ...change.params };
  const voice = scan.tracks.find(track => track.id === (change.sidechainTrackId ?? change.target));
  const level = (index: number) => voice?.frames[index]?.keyRmsDb ?? voice?.frames[index]?.rmsDb ?? -120;
  const loudest = (voice?.frames ?? []).reduce((db, frame) => Math.max(db, frame.keyRmsDb ?? frame.rmsDb), -120);
  const voiceFloor = Math.max(-70, loudest - 33);
  const audibleReductions = probe.frames?.filter((_value, index) => level(index) >= voiceFloor).sort((a, b) => a - b);
  if (change.type === 'compressor') {
    const reduction = audibleReductions?.length ? audibleReductions[Math.floor(.9 * (audibleReductions.length - 1))] : probe.p90Db;
    const excess = Math.max(0, reduction - 4, probe.maxDb - 7);
    const under = probe.maxDb > .05 && probe.maxDb < .35 ? 1.5 : 0;
    change.params.thresholdDb = round(clamp(change.params.thresholdDb + excess - under, -60, 0));
    const compensation = (probe.levelLossDb ?? 0) - excess * .4;
    if (Number.isFinite(compensation)) change.params.makeupDb = round(clamp(compensation, 0, 2));
  } else if (change.type === 'deesser') {
    const activeShare = audibleReductions?.length
      ? audibleReductions.filter(value => value >= .5).length / audibleReductions.length : probe.activeFraction;
    if (activeShare > .46) change.params.thresholdDb = round(clamp(change.params.thresholdDb + 3, -60, 0));
  } else if (voice && probe.frames?.length) {
    let silentRun = 0;
    let intrusions = 0;
    let silentFrames = 0;
    voice.frames.forEach((frame, index) => {
      silentRun = level(index) < voiceFloor ? silentRun + frame.duration : 0;
      if (silentRun < 1.2) return;
      silentFrames++;
      if ((probe.frames?.[index] ?? 0) > .65) intrusions++;
    });
    if (intrusions > Math.max(2, .08 * silentFrames)) {
      change.params.thresholdDb = round(clamp(change.params.thresholdDb + 3, -60, -14));
      change.params.depthDb = round(change.params.depthDb * .75);
    }
  }
  return Object.keys(previous).some(key => previous[key] !== change.params[key]);
}

function highDetectorLevel(scan: AutoMixScan, trackId: string) {
  const frames = scan.tracks.find(track => track.id === trackId)?.frames ?? [];
  const values = frames.map(frame => frame.detectorDb ?? frame.rmsDb).filter(value => value > -65).sort((a, b) => a - b);
  return values.length ? values[Math.floor(.8 * (values.length - 1))] : null;
}

export async function analyzeAutoMix(session: DawSession, options: AutoMixOptions, scan: ScanMix, learnNoise: LearnNoise): Promise<AutoMixPlan> {
  const { lead, harmony, backing } = options.roles;
  const vocalIds = harmony ? [lead, harmony] : [lead];
  const bypassed = bypassAutoMixInserts(session);
  const baseline = await scan(bypassed, [...vocalIds, backing]);
  const plan = proposeAutoMix(bypassed, options, baseline);
  plan.output = bypassed === session ? baseline.output : (await scan(session, [], [], true)).output;
  const skipped = new Set(options.excludedChangeIds);
  const selectedChanges = () => plan.changes.filter(change => !skipped.has(change.id));
  const apply = (changes = selectedChanges()) => applyAutoMixPlan(session, plan, new Set(changes.map(change => change.id)));
  const denoise = selectedChanges().find(change => change.kind === 'effect' && change.type === 'denoise');
  const leadFrames = baseline.tracks.find(track => track.id === options.roles.lead)?.frames;
  if (denoise?.kind === 'effect' && leadFrames) {
    const range = findAutoMixNoiseRange(leadFrames);
    if (range) {
      const profile = await learnNoise(apply([denoise]), denoise.target, autoMixEffectInstanceId(session, denoise.id), range);
      if (profile) {
        denoise.noiseProfile = profile;
        denoise.reason = '从主唱停顿中学习稳定底噪，轻度抑制并保护辅音起音。';
      }
    }
  }
  const dynamics = selectedChanges().filter(isDynamic);
  const inputChanges = selectedChanges().filter(change => isBalanceChange(change) ||
    change.kind === 'effect' && (change.type === 'gate' || change.type === 'eq' || change.type === 'denoise' && !!change.noiseProfile));
  const recalibrate = dynamics.filter(change => change.type === 'compressor' && inputChanges.some(preceding =>
    preceding.kind === 'effect' && preceding.target === change.target));
  if (recalibrate.length) {
    const postEq = await scan(apply(inputChanges), vocalIds);
    for (const change of recalibrate) {
      const old = highDetectorLevel(baseline, change.target), lower = highDetectorLevel(postEq, change.target);
      if (old !== null && lower !== null) change.params.thresholdDb = round(clamp(change.params.thresholdDb + lower - old, -60, 0));
    }
  }

  let current = apply();
  const dynamicsIds = dynamics.map(change => autoMixEffectInstanceId(session, change.id));
  let trial = selectedChanges().length ? await scan(current, [], dynamicsIds, true) : baseline;
  let adjusted = false;
  for (const [index, change] of dynamics.entries()) {
    const probe = trial.probes?.[dynamicsIds[index]];
    if (probe && calibrateDynamic(change, probe, baseline)) adjusted = true;
  }
  if (adjusted) {
    current = apply();
    trial = await scan(current, [], [], true);
  }

  const beforeDelivery = plan.changes.length;
  appendDelivery(current, plan, options, trial.output);
  const outputChanges = plan.changes.slice(beforeDelivery).filter(change => !skipped.has(change.id));
  const limiterId = autoMixEffectInstanceId(session, outputLimiterId);
  const hasLimiter = outputChanges.some(change => change.id === outputLimiterId);
  const measured = outputChanges.length ? await scan(apply(), [], hasLimiter ? [limiterId] : [], true) : trial;
  const limit = measured.probes?.[limiterId]?.maxDb;
  plan.proposedOutput = { ...measured.output, ...(limit === undefined ? {} : { limitingDb: limit }) };
  const delivery = options.delivery;
  if (delivery?.mode === 'custom' && measured.output.integrated !== null && measured.output.integrated < delivery.targetLufs - .6) {
    plan.notes.push('在当前峰值上限和轻度限幅范围内，成品响度低于目标。');
  }
  if (delivery && delivery.mode !== 'preserve' && measured.output.truePeak !== null && measured.output.truePeak > delivery.ceilingDb + .08) {
    plan.notes.push('所选建议的真峰值仍高于目标上限。');
  }
  return plan;
}
