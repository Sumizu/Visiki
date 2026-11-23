import { analyzeDawAutoMix, applyAutoMixPlan, countAutoMixBypassedEffects, defaultAutoMixOptions, isBalanceChange, type AutoMixOptions, type AutoMixPlan } from './auto-mix';
import { denoiseModes, EQ_MATCH_FREQUENCIES, getEffect, resolveEffectTarget, updateEffect } from './effects';
import { findComparisonEffect } from './effect-comparison';
import { sessionDuration, updateMusicalGrid, withoutDawWaveforms, type DawSession } from './model';
import { analyzeDawAudioRhythm, analyzeDawMatchEq, exportDawMix, learnDawNoise, type DawRhythmResult } from './services';

export type DawAgentJobKind = 'render' | 'rhythm' | 'auto_mix' | 'match_eq' | 'learn_noise' | 'compare';
export interface DawAgentJob { jobId: string; kind: DawAgentJobKind; revision: number; state: 'running' | 'complete' | 'cancelled' | 'error'; result?: unknown; message?: string }
interface Entry {
  job: DawAgentJob;
  sessionId: string;
  /** Keep the original for plan audition. The other jobs only retain results. */
  autoMixSource?: DawSession;
  controller: AbortController;
  context?: { target: string; effectId: string };
}
const clone = <T>(value: T): T => structuredClone(value);
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label}必须是对象`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}包含未知字段 ${key}`);
}
function str(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 165) throw new Error(`${label}无效`);
  return value;
}
function num(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label}超出范围`);
  return value;
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}必须是布尔值`);
  return value;
}
function choice<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${label}无效`);
  return value as T;
}
function optionsFor(session: DawSession, value: unknown): AutoMixOptions {
  const base = defaultAutoMixOptions(session), input = value === undefined ? {} : object(value, '自动混音选项');
  keys(input, ['roles', 'harmony', 'direction', 'genre', 'space', 'spaceAmount', 'handoffs', 'delivery', 'excludedChangeIds'], '自动混音选项');
  const roles = input.roles === undefined ? {} : object(input.roles, '音轨角色');
  keys(roles, ['lead', 'harmony', 'backing'], '音轨角色');
  const checkedTrack = (value: unknown, role: string) => {
    const id = str(value, role);
    if (!session.tracks.some(track => track.id === id && !track.muted && track.clips.length)) throw new Error('请选择含有片段且未静音的音轨');
    return id;
  };
  const lead = checkedTrack(roles.lead === undefined ? base.roles.lead : roles.lead, '主唱');
  const backing = checkedTrack(roles.backing === undefined ? base.roles.backing : roles.backing, '伴奏');
  const harmonyId = input.roles === undefined ? base.roles.harmony : roles.harmony;
  const harmony = harmonyId == null || harmonyId === '' ? undefined : checkedTrack(harmonyId, '和声');
  if (lead === backing || harmony === lead || harmony === backing) throw new Error('所选音轨必须各不相同');
  const delivery = input.delivery === undefined ? {} : object(input.delivery, '交付电平');
  keys(delivery, ['mode', 'ceilingDb', 'targetLufs'], '交付电平');
  const mergedDelivery = { ...base.delivery!, ...delivery };
  const handoffs = harmony ? input.handoffs : undefined;
  if (handoffs !== undefined && (!Array.isArray(handoffs) || handoffs.length > 64)) throw new Error('接唱区间无效');
  const ranges = (handoffs as unknown[] | undefined)?.map(raw => {
    const range = object(raw, '接唱区间'); keys(range, ['start', 'end'], '接唱区间');
    const start = num(range.start, 0, sessionDuration(session), '区间起点');
    const end = num(range.end, start, sessionDuration(session), '区间终点');
    if (end - start < .02 - 1e-9) throw new Error('接唱区间至少为 0.02 秒');
    return { start, end };
  }).sort((a, b) => a.start - b.start);
  const excluded = input.excludedChangeIds;
  if (excluded !== undefined && (!Array.isArray(excluded) || excluded.length > 128 || excluded.some(id => typeof id !== 'string' || !/^automix-[a-z0-9_-]{1,150}$/i.test(id)))) throw new Error('自动混音排除项无效');
  return { roles: { lead, harmony, backing },
    harmony: harmony ? choice((input.harmony === undefined ? base.harmony : input.harmony), ['support', 'duet', 'mixed'], '和声用途') : base.harmony,
    direction: choice((input.direction === undefined ? base.direction : input.direction), ['blended', 'natural', 'forward'], '混音方向'), genre: choice((input.genre === undefined ? base.genre : input.genre), ['none', 'pop', 'rock', 'acoustic'], '曲风'),
    space: choice((input.space === undefined ? base.space : input.space), ['unchanged', 'room', 'plate'], '空间'), spaceAmount: num((input.spaceAmount === undefined ? base.spaceAmount : input.spaceAmount), 0, 100, '空间强度'),
    ...(ranges === undefined ? {} : { handoffs: ranges }), ...(excluded === undefined ? {} : { excludedChangeIds: [...excluded as string[]] }),
    delivery: { mode: choice(mergedDelivery.mode, ['preserve', 'peak', 'custom'], '交付电平'), ceilingDb: num(mergedDelivery.ceilingDb, -12, 0, '峰值上限'), targetLufs: num(mergedDelivery.targetLufs, -36, -8, '响度目标') } };
}
function selection(plan: AutoMixPlan, excluded: readonly string[], mode: 'balance' | 'full', input: unknown): Set<string> {
  const available = plan.changes.filter(change => !excluded.includes(change.id));
  if (input !== undefined && (!Array.isArray(input) || input.length > 128 || input.some(id => typeof id !== 'string' || !available.some(change => change.id === id)) || new Set(input).size !== input.length)) throw new Error('变更标识无效或已排除');
  const selected = input === undefined ? new Set(available.map(change => change.id)) : new Set(input as string[]);
  return new Set(available.filter(change => selected.has(change.id) && (mode === 'full' || isBalanceChange(change))).map(change => change.id));
}

/** The registry can be reused after dispose, including React StrictMode effect cleanup. */
export class DawAgentJobs {
  private entries = new Map<string, Entry>();
  start(session: DawSession, revision: number, args: Record<string, unknown>): DawAgentJob {
    num(revision, 0, Number.MAX_SAFE_INTEGER, '版本'); if (!Number.isSafeInteger(revision)) throw new Error('版本必须是整数');
    const input = object(args, '任务参数');
    const kind = choice(input.kind, ['render', 'rhythm', 'auto_mix', 'match_eq', 'learn_noise', 'compare'] as const, '任务类型');
    if ([...this.entries.values()].filter(item => item.job.state === 'running').length >= 4) throw new Error('后台任务已满');
    const snapshot = withoutDawWaveforms(session), controller = new AbortController();
    let run: () => Promise<unknown>; let context: Entry['context'];
    if (kind === 'render') {
      keys(input, ['kind', 'includeTail'], '导出参数');
      if (!sessionDuration(snapshot)) throw new Error('请先加入音频片段。');
      const includeTail = input.includeTail === undefined ? undefined : bool(input.includeTail, 'includeTail');
      run = () => exportDawMix(snapshot, controller.signal, includeTail);
    } else if (kind === 'rhythm') {
      keys(input, ['kind', 'assetId', 'clipId', 'start', 'duration'], '节奏参数');
      if ((input.assetId === undefined) === (input.clipId === undefined)) throw new Error('请选择一个素材或片段');
      const clip = input.clipId === undefined ? undefined : snapshot.tracks.flatMap(track => track.clips).find(item => item.id === str(input.clipId, '片段标识'));
      if (input.clipId !== undefined && !clip) throw new Error('找不到片段');
      const assetId = clip?.assetId ?? str(input.assetId, '素材标识');
      const asset = snapshot.assets.find(item => item.id === assetId); if (!asset) throw new Error('找不到素材');
      const lower = clip?.sourceIn ?? 0, upper = Math.min(asset.duration, clip ? clip.sourceIn + clip.duration : asset.duration);
      const start = input.start === undefined ? lower : num(input.start, lower, upper, '分析起点');
      const duration = input.duration === undefined ? Math.min(90, upper - start) : num(input.duration, 6, 90, '分析时长');
      if (duration < 6 || start + duration > upper + 1e-6) throw new Error('分析范围须在音频内且持续 6–90 秒');
      run = () => analyzeDawAudioRhythm({ assetId, start, duration }, controller.signal);
    } else if (kind === 'auto_mix') {
      keys(input, ['kind', 'options'], '自动混音参数'); const options = optionsFor(snapshot, input.options);
      run = async () => ({ plan: await analyzeDawAutoMix(snapshot, options, controller.signal), options, excludedChangeIds: options.excludedChangeIds ?? [], previousBypassCount: countAutoMixBypassedEffects(snapshot) });
    } else if (kind === 'match_eq') {
      keys(input, ['kind', 'target', 'effectId', 'sourceTarget', 'reference'], '匹配均衡参数');
      const target = str(input.target, '效果目标'), effectId = str(input.effectId, '效果标识');
      if (getEffect(snapshot, target, effectId).type !== 'eq') throw new Error('目标效果不是均衡器');
      const sourceTarget = input.sourceTarget === undefined ? target : str(input.sourceTarget, '音源目标');
      if (!resolveEffectTarget(snapshot, sourceTarget)) throw new Error('找不到音源目标');
      const reference = object(input.reference, '参考音频'); keys(reference, ['kind', 'id'], '参考音频');
      const ref = { kind: choice(reference.kind, ['clip', 'asset'] as const, '参考类型'), id: str(reference.id, '参考标识') };
      if (!/^[a-zA-Z0-9_-]{1,160}$/.test(ref.id)) throw new Error('参考标识无效');
      if (ref.kind === 'clip' && !snapshot.tracks.some(track => track.clips.some(item => item.id === ref.id))) throw new Error('找不到参考片段');
      context = { target, effectId };
      run = async () => ({ target, effectId, sourceTarget, reference: ref, gains: await analyzeDawMatchEq(snapshot, sourceTarget, ref, controller.signal) });
    } else if (kind === 'learn_noise') {
      keys(input, ['kind', 'target', 'effectId', 'start', 'duration'], '噪声学习参数');
      const target = str(input.target, '效果目标'), effectId = str(input.effectId, '效果标识'), effect = getEffect(snapshot, target, effectId);
      if (effect.type !== 'denoise' || !effect.enabled || !denoiseModes(effect.params).spectralEnabled) throw new Error('请启用频谱去噪');
      const start = num(input.start, 0, sessionDuration(snapshot), '底噪起点'), duration = num(input.duration, .5, 3, '底噪时长');
      const owner = resolveEffectTarget(snapshot, target)!;
      if (start + duration > sessionDuration(snapshot) + .5 / snapshot.sampleRate || owner.kind === 'clip' && (start < owner.clip.start - .5 / snapshot.sampleRate || start + duration > owner.clip.start + owner.clip.duration + .5 / snapshot.sampleRate)) throw new Error('底噪范围超出工程或片段');
      context = { target, effectId }; run = async () => ({ target, effectId, start, duration, noiseProfile: await learnDawNoise(snapshot, target, effectId, start, duration, controller.signal) });
    } else {
      keys(input, ['kind', 'effectId', 'position'], '比较参数'); const effectId = str(input.effectId, '效果标识');
      const position = num(input.position, 0, 3630, '试听位置'), effect = findComparisonEffect(snapshot, effectId);
      if (!effect?.enabled || !effect.bState || effect.type === 'meter') throw new Error('请启用效果并准备 A、B 两组参数');
      run = async () => {
        const response = await fetch('/api/daw/native/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: snapshot, effectId, position }), signal: controller.signal });
        const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `比较失败 (${response.status})`); return data;
      };
    }
    if (this.entries.size >= 64) {
      const done = [...this.entries].find(([, item]) => item.job.state !== 'running');
      if (!done) throw new Error('后台任务已满');
      this.entries.delete(done[0]);
    }
    const job: DawAgentJob = { jobId: globalThis.crypto.randomUUID(), kind, revision, state: 'running' };
    this.entries.set(job.jobId, { job, sessionId: session.id, autoMixSource: kind === 'auto_mix' ? snapshot : undefined, controller, context });
    void (async () => {
      try {
        await Promise.resolve();
        controller.signal.throwIfAborted();
        const result = await run();
        if (job.state === 'running') {
          job.result = result;
          job.state = 'complete';
        }
      } catch (error) {
        if (job.state === 'running') {
          job.state = controller.signal.aborted ? 'cancelled' : 'error';
          job.message = error instanceof Error ? error.message : '任务失败';
        }
      }
    })();
    return clone(job);
  }
  get(jobId: string): DawAgentJob { const entry = this.entries.get(str(jobId, '任务标识')); if (!entry) throw new Error('找不到任务'); return clone(entry.job); }
  list(): DawAgentJob[] { return [...this.entries.values()].map(entry => clone(entry.job)); }
  cancel(jobId: string): DawAgentJob { const entry = this.entries.get(str(jobId, '任务标识')); if (!entry) throw new Error('找不到任务'); if (entry.job.state === 'running') { entry.job.state = 'cancelled'; entry.controller.abort(); } return clone(entry.job); }
  dispose(): void { for (const entry of this.entries.values()) if (entry.job.state === 'running') { entry.job.state = 'cancelled'; entry.controller.abort(); } this.entries.clear(); }
  private completed(session: DawSession, revision: number, jobId: unknown): Entry {
    const entry = this.entries.get(str(jobId, '任务标识')); if (!entry || entry.job.state !== 'complete') throw new Error('任务未完成或不存在');
    if (entry.job.revision !== revision || entry.sessionId !== session.id) throw new Error('工程已更改，请重新分析'); return entry;
  }
  apply(session: DawSession, revision: number, args: { jobId: string; mode?: 'balance' | 'full'; changeIds?: string[]; strength?: number; bpm?: number; applyMeter?: boolean }): DawSession {
    const input = object(args, '应用参数'); keys(input, ['jobId', 'mode', 'changeIds', 'strength', 'bpm', 'applyMeter'], '应用参数');
    const entry = this.completed(session, revision, input.jobId), next = session;
    if (entry.job.kind === 'auto_mix') {
      keys(input, ['jobId', 'mode', 'changeIds'], '自动混音应用参数'); const result = entry.job.result as { plan: AutoMixPlan; excludedChangeIds: string[] };
      const mode = input.mode === undefined ? 'full' : choice(input.mode, ['balance', 'full'], '应用模式');
      const ids = selection(result.plan, result.excludedChangeIds, mode, input.changeIds);
      const hasFader = result.plan.changes.some(change => ids.has(change.id) && change.kind === 'fader' && change.deltaDb !== 0);
      if (mode === 'balance' && !hasFader) throw new Error('没有可应用的推子调整');
      if (!ids.size && (result.plan.changes.length > 0 || !countAutoMixBypassedEffects(next))) throw new Error('没有选择可应用的混音调整');
      return applyAutoMixPlan(next, result.plan, ids);
    }
    if (entry.job.kind === 'match_eq') {
      keys(input, ['jobId', 'strength'], '均衡应用参数'); const strength = input.strength === undefined ? 60 : num(input.strength, 0, 100, '匹配强度');
      const result = entry.job.result as { gains: number[] }; if (!Array.isArray(result.gains) || result.gains.length !== EQ_MATCH_FREQUENCIES.length || result.gains.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < -6 || value > 6)) throw new Error('匹配结果无效');
      return updateEffect(next, entry.context!.target, entry.context!.effectId, { params: { ...Object.fromEntries(result.gains.map((gain, index) => [`matchGain${index + 1}`, gain])), matchStrength: strength } });
    }
    if (entry.job.kind === 'learn_noise') {
      keys(input, ['jobId'], '噪声应用参数'); const result = entry.job.result as { noiseProfile: number[] };
      return updateEffect(next, entry.context!.target, entry.context!.effectId, { noiseProfile: result.noiseProfile });
    }
    if (entry.job.kind === 'rhythm') {
      keys(input, ['jobId', 'bpm', 'applyMeter'], '节奏应用参数'); const result = entry.job.result as DawRhythmResult;
      const bpm = input.bpm === undefined ? result.bpm : num(input.bpm, 20, 300, 'BPM'); if (bpm == null) throw new Error('分析未检测到 BPM');
      const applyMeter = input.applyMeter === undefined ? false : bool(input.applyMeter, '应用拍号');
      if (applyMeter && !result.meter) throw new Error('分析未检测到拍号');
      return updateMusicalGrid(next, { bpm, ...(applyMeter && result.meter ? { beatsPerBar: result.meter.beatsPerBar, beatUnit: result.meter.beatUnit } : {}) });
    }
    throw new Error('此任务没有可应用的结果');
  }
  previewSource(session: DawSession, revision: number, args: { jobId?: string; variant?: 'original' | 'balance' | 'full'; changeIds?: string[]; start: number; end: number; preview?: boolean }): { session: DawSession; range: { start: number; end: number }; revision: number; preview: boolean } {
    num(revision, 0, Number.MAX_SAFE_INTEGER, '版本'); if (!Number.isSafeInteger(revision)) throw new Error('版本必须是整数');
    const input = object(args, '试听参数'); keys(input, ['jobId', 'variant', 'changeIds', 'start', 'end', 'preview'], '试听参数');
    let source = withoutDawWaveforms(session); let preview = true;
    if (input.jobId !== undefined) {
      const entry = this.completed(session, revision, input.jobId);
      if (!entry.autoMixSource) throw new Error('试听计划必须来自自动混音');
      source = entry.autoMixSource; preview = false;
      const variant = input.variant === undefined ? 'original' : choice(input.variant, ['original', 'balance', 'full'], '试听版本');
      const result = entry.job.result as { plan: AutoMixPlan; excludedChangeIds: string[] };
      if (variant !== 'original') {
        const ids = selection(result.plan, result.excludedChangeIds, variant, input.changeIds);
        const hasFader = result.plan.changes.some(change => ids.has(change.id) && change.kind === 'fader' && change.deltaDb !== 0);
        if (variant === 'balance' && !hasFader) throw new Error('没有可试听的推子调整');
        if (!ids.size && (result.plan.changes.length > 0 || !countAutoMixBypassedEffects(source))) throw new Error('没有选择可试听的混音调整');
        source = applyAutoMixPlan(source, result.plan, ids);
      } else if (input.changeIds !== undefined) selection(result.plan, result.excludedChangeIds, 'full', input.changeIds);
    } else if (input.variant !== undefined || input.changeIds !== undefined) throw new Error('试听版本需要自动混音任务');
    if (input.preview !== undefined) preview = bool(input.preview, 'preview');
    const start = num(input.start, 0, sessionDuration(source), '试听起点'), end = num(input.end, start, sessionDuration(source), '试听终点');
    if (end - start < .02 - 1e-9 || end - start > 20 + 1e-9) throw new Error('试听范围须持续 0.02–20 秒');
    return { session: source, range: { start, end }, revision, preview };
  }
}
