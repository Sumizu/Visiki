import { DawPlaybackEngine, type DawPlaybackRestartMode } from './engine';
import { serializeSession, sessionDuration, type DawSession } from './model';
import type { DawMeterLevels } from './meter';
import type { EffectMeterReadings } from './effects-view';
import { nativeMixDelta } from './native-mix';
import { comparisonMatches, comparisonTrim, findComparisonEffect, type EffectComparison } from './effect-comparison';
import { canAuditionDenoise } from './effects';
import type { Vst3ValueRequest, Vst3ValueResult } from './vst3';

export type Vst3Edit = { seq: number; effectId: string; params: Record<string, number> };
type NativeStatus = { vst3Editors?: string[]; vst3Edits?: Vst3Edit[]; vst3HostId?: string; vst3Values?: Vst3ValueResult[]; editorOpened?: boolean; editorError?: string; available?: boolean; loaded?: boolean; playing?: boolean; position?: number; error?: string; meters?: DawMeterLevels; effects?: Record<string, any>; loudness?: Record<string, number | null>; underruns?: number; sampleRate?: number };
const meterDb = (value?: number) => value && Number.isFinite(value) && value > 0 ? 20 * Math.log10(value) : -120;
const sessionRequired = (error: unknown) => error instanceof Error && (('code' in error && error.code === 'DAW_SESSION_REQUIRED') || error.message === 'Load a session first');
const MIX_UPDATE_MS = 40;
const hasEffects = (session: DawSession) => !!(session.masterEffects?.length ||
  session.tracks.some(track => track.effects?.length || track.clips.some(clip => clip.effects?.length)));
export class DawAudioEngine {
  private legacy: DawPlaybackEngine;
  private session?: DawSession;
  private native = false;
  private nativeAvailable?: boolean;
  private clientId = crypto.randomUUID();
  private status: NativeStatus = {};
  private running = false;
  private position = 0;
  private editPosition = 0;
  private receivedAt = performance.now();
  private monitorDb = 0;
  private monitorComparisonDb = 0;
  private comparison?: { state: EffectComparison; snapshot: DawSession; controller: AbortController };
  private noiseListenId?: string;
  private restart: DawPlaybackRestartMode = 'resume';
  private serial: Promise<unknown> = Promise.resolve();
  private sent?: { session: DawSession; revision: number };
  private revision = 0;
  private sessionEpoch = 0;
  private update?: Promise<void>;
  private urgentUpdate = false;
  private failedSession?: DawSession;
  private disposed = false;
  private generation = 0;
  private timer?: ReturnType<typeof setInterval>;
  private updateTimer?: ReturnType<typeof setTimeout>;
  private polling?: Promise<void>;
  private vst3Cursor = 0;
  private vst3HostId?: string;
  private vst3Editors: string[] = [];
  private vst3OpenToken = 0;
  private vst3Opening = 0;
  constructor(private readonly onError?: (message: string) => void, private readonly onComparison?: (value?: EffectComparison) => void, private readonly onNoiseListening?: (effectId?: string) => void, private readonly onVst3Edit?: (sessionId: string, edit: Vst3Edit) => void) { this.legacy = new DawPlaybackEngine(onError); }
  private command(op: string, values: Record<string, unknown> = {}, signal?: AbortSignal): Promise<NativeStatus> {
    const run = this.serial.catch(() => {}).then(async () => {
      if (this.disposed && op !== 'dispose' && op !== 'vst3-close') return {};
      const response = await fetch(`/api/daw/native/command/${this.clientId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, ...values }), signal });
      const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error || '原生音频操作失败'), { code: result.code }); return result;
    }); this.serial = run; return run;
  }
  private clearUpdateTimer() {
    if (this.updateTimer) { clearTimeout(this.updateTimer); this.updateTimer = undefined; }
  }
  private scheduleUpdate() {
    if (this.disposed || !this.native || this.update || this.updateTimer || !this.session || this.sent?.session === this.session || this.failedSession === this.session) return;
    const epoch = this.sessionEpoch;
    const flush = () => void this.flushSession().catch(error => { if (epoch === this.sessionEpoch) this.report(error); });
    if (this.urgentUpdate) flush();
    else this.updateTimer = setTimeout(flush, MIX_UPDATE_MS);
  }
  private async flushSession(): Promise<void> {
    this.clearUpdateTimer();
    if (this.update) return this.update;
    const snapshot = this.session, before = this.sent;
    if (!this.native || !snapshot || before?.session === snapshot || this.disposed) return;
    this.urgentUpdate = false;
    this.failedSession = undefined;
    const epoch = this.sessionEpoch, revision = ++this.revision;
    const vst3Ack = { vst3After: this.vst3Cursor, ...(this.vst3HostId ? { vst3HostId: this.vst3HostId } : {}) };
    const send = async () => {
      const mix = before && nativeMixDelta(before.session, snapshot);
      if (mix && !mix.tracks.length && mix.masterDb === undefined && mix.bpm === undefined && !mix.masterEffects) {
        await this.sendMonitor(this.comparisonDb(snapshot));
        return before.revision;
      }
      const nextTrim = this.comparisonDb(snapshot);
      const compare = nextTrim !== this.monitorComparisonDb ? { compareDb: nextTrim } : {};
      if (mix) {
        try {
          await this.command('mix', { baseRevision: before.revision, revision, mix, ...vst3Ack, ...compare });
          if (compare.compareDb !== undefined) this.monitorComparisonDb = nextTrim;
          await this.sendMonitor(this.comparisonDb(snapshot)); return revision;
        }
        catch (error) { if (!sessionRequired(error) || this.running) throw error; }
      }
      if (epoch !== this.sessionEpoch || this.disposed) return revision;
      await this.command('session', { revision, session: JSON.parse(serializeSession(snapshot)), ...vst3Ack, ...compare });
      if (compare.compareDb !== undefined) this.monitorComparisonDb = nextTrim;
      await this.sendMonitor(this.comparisonDb(snapshot));
      return revision;
    };
    this.update = send().then(ack => { if (epoch === this.sessionEpoch) this.sent = { session: snapshot, revision: ack }; }).catch(error => {
      if (epoch === this.sessionEpoch) { this.sent = undefined; this.failedSession = snapshot; }
      throw error;
    }).finally(() => { this.update = undefined; this.scheduleUpdate(); });
    return this.update;
  }
  commitSession() { this.urgentUpdate = true; this.clearUpdateTimer(); this.scheduleUpdate(); }
  private stopPolling() { if (this.timer) { clearInterval(this.timer); this.timer = undefined; } }
  private report(error: unknown) {
    if (this.disposed) return;
    this.position = this.getPosition(); this.running = false; this.sent = undefined; this.stopPolling();
    this.onError?.(error instanceof Error ? error.message : '原生音频处理失败');
  }
  setSession(session: DawSession) {
    const wasRunning = this.isPlaying(), before = this.getPosition();
    const nextNative = this.nativeAvailable === true || hasEffects(session);
    const changedProject = !!this.session && this.session.id !== session.id;
    if (this.native !== nextNative || changedProject) this.pause();
    const changedMode = this.native !== nextNative;
    if (changedProject || changedMode) { if (this.vst3Editors.length || this.vst3Opening) void this.closeVst3Editors().catch(() => {}); ++this.generation; ++this.sessionEpoch; this.status = {}; this.sent = undefined; this.clearUpdateTimer(); }
    this.native = nextNative; this.session = session;
    if (this.noiseListenId && (changedProject || !this.canListenToNoise(this.noiseListenId))) this.clearNoiseListening();
    if (this.comparison && !comparisonMatches(this.comparison.snapshot, session, this.comparison.state.effectId)) this.clearComparison(undefined, false);
    else if (this.comparison?.state.status === 'ready') this.publishComparison();
    if (changedProject) { this.position = 0; this.editPosition = 0; }
    else if (changedMode) { this.position = before; this.editPosition = before; }
    this.legacy.setSession(session);
    const end = sessionDuration(session); this.position = Math.min(this.position, end); this.editPosition = Math.min(this.editPosition, end);
    if (this.native) this.scheduleUpdate();
    else if (changedMode) void this.command('dispose').catch(() => {});
    if (changedMode && wasRunning && !changedProject) void this.play(before).catch(error => this.report(error));
  }
  isPlaying() { return this.native ? this.running : this.legacy.isPlaying(); }
  getNoiseListenId() { return this.noiseListenId; }
  getComparison() {
    const setup = this.comparison;
    return setup && { ...setup.state, trimDb: this.comparisonDb(this.session) };
  }
  getPosition() { return this.native ? Math.min(this.session ? sessionDuration(this.session) + 30 : 0, this.position + (this.running ? Math.min(.5, Math.max(0, performance.now() - this.receivedAt) / 1000) : 0)) : this.legacy.getPosition(); }
  getEditPosition() { return this.native ? this.editPosition : this.legacy.getEditPosition(); }
  setPlaybackRestartMode(mode: DawPlaybackRestartMode) { this.restart = mode; this.legacy.setPlaybackRestartMode(mode); }
  async play(time?: number) {
    if (!this.native && this.nativeAvailable !== false && this.session && sessionDuration(this.session) && !this.disposed) {
      const generation = ++this.generation;
      const available = await fetch(`/api/daw/native/status/${this.clientId}`).then(async response => response.ok && (await response.json()).available === true).catch(() => false);
      if (this.disposed || generation !== this.generation) return;
      this.nativeAvailable = available;
      if (available) {
        this.position = this.legacy.getPosition(); this.editPosition = this.legacy.getEditPosition();
        this.legacy.pause(); this.native = true;
      }
    }
    if (!this.native) return this.legacy.play(time);
    if (!this.session || !sessionDuration(this.session) || this.disposed) return;
    const generation = ++this.generation;
    let start = time ?? (this.restart === 'from-cursor' ? this.editPosition : this.position);
    start = Math.max(0, Math.min(sessionDuration(this.session), start));
    if (start >= sessionDuration(this.session)) start = 0;
    if (time !== undefined) this.editPosition = start;
    const current = () => generation === this.generation && !this.disposed && this.native;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.flushSession(); if (!current()) return;
        if (this.sent?.session !== this.session) await this.flushSession();
        if (!current()) return;
        await this.sendMonitor(this.comparisonDb(this.sent?.session), true); if (!current()) return;
        if (this.noiseListenId) await this.command('listen-noise', { effectId: this.noiseListenId });
        if (!current()) return;
        const response = await this.command('play', { position: start });
        if (!current()) return;
        this.nativeAvailable = true;
        this.position = response.position ?? start; this.receivedAt = performance.now(); this.running = true;
        this.startPolling();
        await this.poll();
        return;
      } catch (error) {
        if (!current()) return;
        this.sent = undefined;
        if (!attempt && sessionRequired(error)) continue;
        if (this.session && !hasEffects(this.session)) {
          this.nativeAvailable = false; this.native = false; ++this.sessionEpoch; this.running = false; this.stopPolling();
          this.legacy.seek(start, { editPosition: this.editPosition });
          void this.command('dispose').catch(() => {});
          return this.legacy.play();
        }
        throw error;
      }
    }
  }
  private startPolling() { if (!this.timer) this.timer = setInterval(() => void this.poll().catch(() => {}), 50); }
  private acceptVst3Status(status: NativeStatus, sessionId: string) {
    if (status.vst3HostId && this.vst3HostId !== status.vst3HostId) {
      this.vst3Cursor = 0;
      this.vst3HostId = status.vst3HostId;
    }
    if (status.vst3Editors) this.vst3Editors = status.vst3Editors;
    for (const edit of status.vst3Edits ?? []) {
      if (!Number.isSafeInteger(edit.seq) || edit.seq <= this.vst3Cursor) continue;
      this.vst3Cursor = edit.seq;
      this.onVst3Edit?.(sessionId, edit);
    }
  }
  private poll(): Promise<void> {
    if (this.polling) return this.polling;
    if (this.disposed || !this.native || !this.session) return Promise.resolve();
    const generation = this.generation, sessionId = this.session.id;
    const query = new URLSearchParams({ vst3After: String(this.vst3Cursor) });
    if (this.vst3HostId) query.set('vst3HostId', this.vst3HostId);
    const run = async () => {
      try {
        const response = await fetch(`/api/daw/native/status/${this.clientId}?${query}`);
        const status: NativeStatus = await response.json();
        if (!this.native || this.disposed || generation !== this.generation || this.session?.id !== sessionId) return;
        if (!response.ok || status.error || (status.loaded === false && this.running)) throw new Error(status.error || '原生音频会话已停止；请重新播放。');
        this.acceptVst3Status(status, sessionId);
        if (status.loaded === false) { this.sent = undefined; this.vst3Editors = []; this.stopPolling(); return; }
        this.status = status;
        this.position = status.position ?? this.position; this.receivedAt = performance.now(); this.running = !!status.playing;
        if (!this.running && !this.vst3Editors.length) this.stopPolling();
      } catch (error) { if (generation === this.generation) { this.report(error); throw error; } }
    };
    this.polling = run().finally(() => { this.polling = undefined; });
    return this.polling;
  }
  async openVst3Editor(effectId: string): Promise<{ opened: boolean; error?: string }> {
    if (!this.native || !this.session || this.disposed) return { opened: false, error: '原生音频引擎不可用。' };
    const epoch = this.sessionEpoch, sessionId = this.session.id, token = this.vst3OpenToken;
    const current = () => this.sessionEpoch === epoch && !this.disposed && token === this.vst3OpenToken;
    this.vst3Opening++;
    try {
      for (let attempt = 0; attempt < 2 && current(); attempt++) {
        while (current() && this.sent?.session !== this.session) await this.flushSession();
        if (!current()) break;
        const result = await this.command('vst3-open', { effectId });
        if (!current()) break;
        if (!attempt && result.loaded === false) { this.sent = undefined; continue; }
        this.acceptVst3Status(result, sessionId);
        if (result.editorOpened) { this.startPolling(); void this.poll().catch(() => {}); }
        return { opened: !!result.editorOpened, error: result.editorError };
      }
      return { opened: false, error: '会话已更改或插件窗口已关闭。' };
    } catch (error) { return { opened: false, error: error instanceof Error ? error.message : '无法打开插件窗口。' }; }
    finally { this.vst3Opening--; }
  }
  async syncVst3Editors() {
    if (!this.native || !this.vst3Editors.length || this.disposed) return;
    await this.command('vst3-sync');
    if (this.polling) await this.polling;
    await this.poll();
  }
  async readVst3Values(requests: Vst3ValueRequest[], signal?: AbortSignal): Promise<Vst3ValueResult[]> {
    if (!requests.length) return [];
    const snapshot = this.session;
    if (!this.native || !snapshot || this.disposed) throw new Error('原生音频会话不可用');
    const check = () => {
      signal?.throwIfAborted();
      if (this.disposed || this.session !== snapshot) throw new Error('工程已变化，请重新查询插件参数');
    };
    const sync = async () => {
      check();
      while (this.sent?.session !== snapshot) {
        await this.flushSession();
        check();
      }
    };
    const read = async (batch: Vst3ValueRequest[]) => {
      await sync();
      let result = await this.command('vst3-parameter-values', { requests: batch }, signal);
      check();
      if (result.loaded === false) {
        this.sent = undefined;
        await sync();
        result = await this.command('vst3-parameter-values', { requests: batch }, signal);
        check();
      }
      if (!Array.isArray(result.vst3Values)) throw new Error(result.editorError || '原生音频宿主未返回插件参数');
      return result.vst3Values;
    };
    const values: Vst3ValueResult[] = [];
    for (let index = 0; index < requests.length; index += 32) {
      const group = requests.slice(index, index + 32);
      const grouped = new Map<string, Vst3ValueResult>();
      for (let start = 0; group.some(item => item.paramIds.length > start); start += 128) {
        const batch = group.filter(item => item.paramIds.length > start).map(item => ({
          effectId: item.effectId, paramIds: item.paramIds.slice(start, start + 128),
        }));
        for (const entry of await read(batch)) {
          const previous = grouped.get(entry.effectId);
          if (previous) previous.values.push(...entry.values);
          else grouped.set(entry.effectId, entry);
        }
      }
      values.push(...grouped.values());
    }
    return values;
  }
  async closeVst3Editors() {
    ++this.vst3OpenToken;
    if (!this.native || (!this.vst3Editors.length && !this.vst3Opening) || this.disposed) return;
    await this.command('vst3-close');
    if (this.polling) await this.polling;
    await this.poll();
    this.vst3Editors = [];
    if (!this.running) this.stopPolling();
  }
  pause() {
    if (!this.native) { ++this.generation; this.legacy.pause(); return; }
    const generation = ++this.generation; this.position = this.getPosition(); this.running = false; this.receivedAt = performance.now(); if (!this.vst3Editors.length) this.stopPolling();
    void this.command('pause').then(result => { if (!this.running && generation === this.generation) this.position = result.position ?? this.position; }).catch(error => { if (generation === this.generation) this.report(error); });
  }
  pauseTransport() { if (!this.native) { ++this.generation; return this.legacy.pauseTransport(); } this.pause(); if (this.restart === 'from-cursor') this.seek(this.editPosition); }
  seek(time: number, options?: { editPosition?: number }) {
    if (!this.native) { if (Number.isFinite(time)) ++this.generation; return this.legacy.seek(time, options); }
    if (!Number.isFinite(time)) return;
    const generation = ++this.generation;
    const end = this.session ? sessionDuration(this.session) : 0;
    this.position = Math.max(0, Math.min(end, time)); this.editPosition = options?.editPosition !== undefined && Number.isFinite(options.editPosition) ? Math.max(0, Math.min(end, options.editPosition)) : this.position; this.receivedAt = performance.now();
    void this.command('seek', { position: this.position }).catch(error => { if (generation === this.generation) this.report(error); });
  }
  private comparisonDb(session?: DawSession) {
    const setup = this.comparison;
    if (!session || !setup || setup.state.status !== 'ready' || !comparisonMatches(setup.snapshot, session, setup.state.effectId)) return 0;
    const { effectId, aLufs, bLufs } = setup.state;
    return comparisonTrim(findComparisonEffect(session, effectId)?.abSlot ?? 'A', aLufs!, bLufs!);
  }
  private async sendMonitor(compareDb: number, force = false) {
    if (!force && this.monitorComparisonDb === compareDb) return;
    this.monitorComparisonDb = compareDb;
    await this.command('monitor', { db: this.monitorDb, compareDb });
  }
  setMonitorGain(db: number) { this.monitorDb = db; this.legacy.setMonitorGain(db); if (this.native) void this.command('monitor', { db }).catch(error => this.report(error)); }
  private canListenToNoise(id: string) {
    const session = this.session;
    if (!session) return false;
    const owner = session.tracks.find(track => track.effects?.some(effect => effect.id === id) ||
      track.clips.some(clip => clip.effects?.some(effect => effect.id === id)));
    if (owner && (owner.muted || !owner.solo && session.tracks.some(track => track.solo))) return false;
    const effect = findComparisonEffect(session, id);
    return !!effect && canAuditionDenoise(effect);
  }
  clearNoiseListening(id?: string) {
    if (!this.noiseListenId || id && this.noiseListenId !== id) return;
    this.noiseListenId = undefined;
    this.onNoiseListening?.();
    void this.command('listen-noise', { effectId: '' }).catch(() => {});
  }
  async toggleNoiseListening(id: string) {
    if (this.noiseListenId === id) { this.clearNoiseListening(id); return; }
    if (!this.native || !this.canListenToNoise(id)) return;
    this.clearComparison();
    this.noiseListenId = id; this.onNoiseListening?.(id);
    try {
      await this.flushSession();
      if (this.noiseListenId === id) await this.command('listen-noise', { effectId: id });
    } catch (error) {
      if (this.noiseListenId !== id) return;
      this.clearNoiseListening(id);
      this.onError?.(error instanceof Error ? error.message : '无法试听移除的噪声。');
    }
  }
  private publishComparison() {
    this.onComparison?.(this.getComparison());
  }
  clearComparison(effectId?: string, apply = true) {
    if (!this.comparison || effectId && this.comparison.state.effectId !== effectId) return;
    this.comparison.controller.abort(); this.comparison = undefined;
    this.publishComparison();
    if (apply && this.native && this.sent) void this.sendMonitor(0, true).catch(() => {});
  }
  async toggleComparison(effectId: string) {
    if (this.comparison?.state.effectId === effectId) { this.clearComparison(effectId); return; }
    this.clearComparison();
    this.clearNoiseListening();
    const snapshot = this.session, effect = snapshot && findComparisonEffect(snapshot, effectId);
    if (!snapshot || !this.native || !effect?.enabled || !effect.bState || effect.type === 'meter' || this.disposed) return;
    const controller = new AbortController();
    const setup = { state: { effectId, status: 'measuring' } as EffectComparison, snapshot, controller };
    this.comparison = setup; this.publishComparison();
    try {
      const response = await fetch('/api/daw/native/compare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ session: JSON.parse(serializeSession(snapshot)), effectId, position: this.getPosition() }),
      });
      const { activeLufs, otherLufs, start, end, error } = await response.json();
      if (controller.signal.aborted || this.comparison !== setup || this.disposed) return;
      if (!response.ok) throw new Error(error || '无法测量 A/B 响度。');
      if (!Number.isFinite(activeLufs) || !Number.isFinite(otherLufs)) throw new Error('这一段没有足够的有效声音。请将游标移到有声音的位置，然后再试。');
      const [aLufs, bLufs] = effect.abSlot === 'B' ? [otherLufs, activeLufs] : [activeLufs, otherLufs];
      setup.state = { effectId, status: 'ready', start, end, aLufs, bLufs };
      this.publishComparison();
      await this.update;
      if (this.comparison === setup && this.sent) await this.sendMonitor(this.comparisonDb(this.sent.session), true);
    } catch (error) {
      if (this.comparison !== setup || controller.signal.aborted || this.disposed) return;
      this.clearComparison(effectId);
      this.onError?.(error instanceof Error ? error.message : '无法测量 A/B 响度。');
    }
  }
  getLevels(): Record<string, number> { return Object.fromEntries(Object.entries(this.getMeterLevels()).map(([id, reading]) => [id, reading.peak])); }
  getMeterLevels(): DawMeterLevels { return this.native ? this.running ? this.status.meters ?? {} : {} : this.legacy.getMeterLevels(); }
  getEffectReading(id: string): EffectMeterReadings | undefined {
    if (!this.native) return undefined;
    const value = this.status.effects?.[id], loud = value?.loudness ?? this.status.loudness;
    if (!value) return undefined;
    const active = this.running;
    return { inputDb: active ? meterDb(value.inputPeak) : -120, outputDb: active ? meterDb(value.outputPeak) : -120, inputRmsDb: active ? meterDb(value.inputRms) : -120, outputRmsDb: active ? meterDb(value.outputRms) : -120,
      bandReductionDb: active ? value.bandReductionDb : undefined, transientGainDb: active ? value.transientGainDb : undefined,
      multibandReductionDb: active ? value.multibandReductionDb : undefined,
      sidechainInputDb: active ? value.sidechainInputDb : undefined,
      duckerKeyDb: active ? value.duckerKeyDb : undefined,
      duckerProgramDb: active ? value.duckerProgramDb : undefined,
      reductionDb: active ? value.gainReductionDb : 0, peakDb: meterDb(value.peakLeft === undefined ? value.outputPeak : Math.max(value.peakLeft, value.peakRight)), rmsDb: meterDb(value.rmsLeft === undefined ? value.outputRms : Math.hypot(value.rmsLeft, value.rmsRight) / Math.SQRT2), correlation: value.correlation,
      spectrum: value.spectrum?.map((sample: number) => meterDb(sample)), leftDb: meterDb(value.peakLeft), rightDb: meterDb(value.peakRight),
      sampleRate: this.status.sampleRate, spectrumMaxHz: this.status.sampleRate ? this.status.sampleRate / 2 : undefined,
      integratedLufs: loud?.integrated ?? undefined, shortTermLufs: loud?.shortTerm ?? undefined, momentaryLufs: loud?.momentary ?? undefined, truePeakDb: loud?.truePeak ?? undefined, loudnessRange: loud?.lra ?? undefined, crestDb: value.crestDb };
  }
  async resetMeters() {
    if (!this.native) return;
    const epoch = this.sessionEpoch;
    await this.command('reset-meters').then(result => {
      if (this.disposed || epoch !== this.sessionEpoch) return;
      this.status = { ...this.status, meters: result.meters ?? {}, effects: result.effects ?? {}, loudness: result.loudness };
    }).catch(error => { if (epoch === this.sessionEpoch) this.report(error); });
  }
  dispose() { ++this.vst3OpenToken; if (this.vst3Editors.length || this.vst3Opening) void this.command('vst3-close').catch(() => {}); this.disposed = true; this.comparison?.controller.abort(); this.comparison = undefined; this.legacy.dispose(); this.stopPolling(); this.clearUpdateTimer(); void this.command('dispose').catch(() => {}); }
}
