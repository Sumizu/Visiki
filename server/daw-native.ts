import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { parseSession, type DawSession } from '../src/daw/model';
import { validateEffectChain, type DawEffect } from '../src/daw/effects';
import { sameNativeLayout, type NativeMix } from '../src/daw/native-mix';
import type { Vst3ValueRequest } from '../src/daw/vst3';
import type { AutoMixScan } from '../src/daw/auto-mix';
import { resolveVst3Plugin } from './daw-vst3';

const executable = path.resolve('dist-native/VisikiAudioHost.exe');
const clients = new Map<string, NativeClient>();
const idPattern = /^[0-9a-f-]{36}$/i;
type NativeMessage = Record<string, any>;
type NativeAsset = { file: string; dataOffset: number; sampleCount: number; sampleRate: number; channels: number; duration: number };
type NativeEffect = DawEffect & { vst3?: { classId: string; modulePath?: string } };
type Vst3Edit = { seq: number; effectId: string; params: Record<string, number> };
const effectIdPattern = /^[a-z0-9_-]{1,160}$/i;
const maxVst3Edits = 2048;
const failure = (message: string, status = 400) => Object.assign(new Error(message), { status });
const sessionRequired = (message = '原生会话已失效，需要重新加载') => Object.assign(failure(message, 409), { code: 'DAW_SESSION_REQUIRED' });
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const revisionOf = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
export const nativeAudioAvailable = () => process.platform === 'win32' && existsSync(executable);
export function killNativeAudio(): void { for (const client of clients.values()) client.close(); clients.clear(); }
export async function nativeSession(input: unknown, lookup: (id: string) => Promise<NativeAsset | undefined>, preview: boolean): Promise<Omit<DawSession, 'assets'> & { assets: any[] }> {
  const session = parseSession(input);
  const hasSolo = preview && session.tracks.some(track => track.solo);
  const audibleTracks = session.tracks.filter(track => !track.muted && (!hasSolo || track.solo));
  const used = new Set(audibleTracks.flatMap(track => track.clips.map(clip => clip.assetId)));
  const assets = [];
  for (const asset of session.assets) {
    if (!used.has(asset.id)) continue;
    const actual = await lookup(asset.id);
    if (!actual) throw failure(`素材“${asset.name}”已失联，请重新导入或静音相关轨道`, 404);
    for (const track of audibleTracks) for (const clip of track.clips) if (clip.assetId === asset.id && clip.sourceIn + clip.duration > actual.duration + 1 / actual.sampleRate) throw failure('片段超出音频缓存范围');
    assets.push({ id: asset.id, ...actual });
  }
  const plugins = new Map<string, ReturnType<typeof resolveVst3Plugin>>();
  const bindPlugins = async (effects?: DawEffect[]): Promise<NativeEffect[] | undefined> => effects && Promise.all(effects.map(async effect => {
    if (effect.type !== 'vst3' || !effect.enabled) return effect;
    const classId = effect.vst3!.classId;
    let pending = plugins.get(classId);
    if (!pending) {
      pending = resolveVst3Plugin(classId);
      plugins.set(classId, pending);
    }
    const plugin = await pending;
    if (!plugin) throw failure(`VST3「${effect.name ?? classId}」不可用。请重新扫描或旁路此效果。`, 422);
    return { ...effect, vst3: { classId, modulePath: plugin.binaryPath } };
  }));
  const masterEffects = await bindPlugins(session.masterEffects);
  const tracks = await Promise.all(session.tracks.map(async track => track.effects?.some(effect => effect.type === 'vst3')
    ? { ...track, effects: await bindPlugins(track.effects) } : track));
  return { ...session, tracks, ...(masterEffects ? { masterEffects } : {}), assets };
}

class NativeClient {
  process: ChildProcessWithoutNullStreams;
  status: NativeMessage = { playing: false, position: 0, meters: {}, effects: {} };
  readonly vst3HostId = randomUUID();
  vst3Editors: string[] = [];
  vst3Edits: Vst3Edit[] = [];
  latestVst3Seq = 0;
  touched = Date.now();
  pending = new Map<string, { resolve: (result: NativeMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  dead = false;
  updating = false;
  revision?: number;
  layout?: { master: NativeEffect[]; tracks: Map<string, { effects: NativeEffect[]; clips: Map<string, NativeEffect[]> }> };
  constructor() {
    this.process = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.process.stdout }).on('line', line => {
      let parsed: unknown; try { parsed = JSON.parse(line); } catch { return; }
      if (!isRecord(parsed)) return;
      const message: NativeMessage = parsed;
      if (Array.isArray(message.vst3Editors) && message.vst3Editors.length <= 4096 && message.vst3Editors.every((id: unknown) => typeof id === 'string' && effectIdPattern.test(id))) this.vst3Editors = message.vst3Editors;
      const edit = message.vst3Edit;
      if (isRecord(edit) && Number.isSafeInteger(edit.seq) && Number(edit.seq) > this.latestVst3Seq && typeof edit.effectId === 'string' && effectIdPattern.test(edit.effectId) && isRecord(edit.params)) {
        const entries = Object.entries(edit.params);
        const effects = [...this.layout?.master ?? [], ...[...this.layout?.tracks.values() ?? []].flatMap(track => track.effects)];
        if (effects.some(effect => effect.id === edit.effectId && effect.type === 'vst3') && entries.length > 0 && entries.length <= 4096 && entries.every(([key, value]) => /^(0|[1-9][0-9]*)$/.test(key) && Number(key) <= 4294967295 && bounded(value, 0, 1))) {
          this.latestVst3Seq = Number(edit.seq);
          this.vst3Edits.push({ seq: Number(edit.seq), effectId: edit.effectId, params: Object.fromEntries(entries) as Record<string, number> });
          if (this.vst3Edits.length > maxVst3Edits) this.vst3Edits.shift();
        }
      }
      if (message.status) this.status = { ...message, receivedAt: Date.now() };
      if (message.error) this.status = { ...this.status, playing: false, error: message.error };
      const request = this.pending.get(message.reply);
      if (request) { clearTimeout(request.timer); this.pending.delete(message.reply); message.error ? request.reject(failure(message.error)) : request.resolve(message); }
    });
    this.process.stderr.on('data', () => {});
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', () => this.fail(sessionRequired('原生音频引擎已停止；请重新播放。工程已保留。')));
  }
  fail(error: Error) { this.dead = true; this.status = { ...this.status, playing: false, error: error.message }; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  command(command: NativeMessage): Promise<NativeMessage> {
    if (this.dead) throw sessionRequired();
    if (this.pending.size >= 32) throw failure('音频操作过于频繁，请稍后重试', 409);
    this.touched = Date.now(); const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(sessionRequired('原生音频引擎响应超时')); this.close(); }, 15000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ ...command, requestId }) + '\n', error => { if (error) this.fail(error); });
    });
  }
  close() { this.process.stdin.end(); this.process.kill(); this.fail(failure('原生音频引擎已关闭')); }
}
function clientFor(id: string, create: boolean): NativeClient | undefined {
  if (!idPattern.test(id)) throw failure('音频客户端标识无效');
  let client = clients.get(id);
  if (client?.dead && create) { client.close(); clients.delete(id); client = undefined; }
  if (!client && create) {
    if (!nativeAudioAvailable()) throw failure('原生音频组件缺失，请先构建或恢复 dist-native/VisikiAudioHost.exe', 503);
    if (clients.size >= 4) throw failure('当前音频工作区过多，请关闭其他窗口', 409);
    client = new NativeClient(); clients.set(id, client);
  }
  return client;
}
function vst3Cursor(client: NativeClient, cursor: unknown, hostId: unknown): number {
  if (cursor !== undefined && !revisionOf(cursor)) throw failure('VST3 编辑游标无效');
  if (hostId !== undefined && (typeof hostId !== 'string' || !idPattern.test(hostId))) throw failure('VST3 主机标识无效');
  if (hostId !== undefined && hostId !== client.vst3HostId) return 0;
  const after = cursor === undefined ? 0 : Number(cursor);
  if (after > client.latestVst3Seq) throw failure('VST3 编辑游标超出当前范围');
  return after;
}
export function nativeStatus(id: string, cursor?: unknown, hostId?: unknown): NativeMessage {
  const client = clientFor(id, false);
  if (client && !client.dead && (client.status.playing || client.vst3Editors.length)) client.touched = Date.now();
  const after = client ? vst3Cursor(client, cursor, hostId) : 0;
  return { available: nativeAudioAvailable(), ...(client?.status ?? { playing: false, position: 0, meters: {}, effects: {} }), loaded: client?.revision !== undefined && !client.dead,
    vst3Editors: client?.vst3Editors ?? [], ...(client ? { vst3HostId: client.vst3HostId, vst3Edits: client.vst3Edits.filter(edit => edit.seq > after) } : {}) };
}

function validatedMix(input: unknown, layout: NonNullable<NativeClient['layout']>): NativeMix {
  if (!isRecord(input) || !Array.isArray(input.tracks) || input.tracks.length > layout.tracks.size) throw failure('混音更新无效');
  const mix: NativeMix = { tracks: [] }, seen = new Set<string>();
  const chain = (value: unknown, before: NativeEffect[]): NativeEffect[] => {
    const issues = validateEffectChain(value);
    if (issues.length) throw failure(issues[0].message);
    if (!sameNativeLayout(before, value as DawEffect[])) throw sessionRequired('效果链结构已改变，需要完整会话');
    return (value as DawEffect[]).map((effect, index) => {
      if (effect.type !== 'vst3' || !effect.enabled) return effect;
      const binding = before[index].vst3;
      if (!binding?.modulePath) throw sessionRequired('VST3 插件需要重新加载');
      return { ...effect, vst3: binding };
    });
  };
  if (input.masterDb !== undefined) {
    if (!bounded(input.masterDb, -96, 12)) throw failure('主输出音量无效');
    mix.masterDb = input.masterDb;
  }
  if (input.bpm !== undefined) {
    if (!bounded(input.bpm, 20, 300)) throw failure('速度无效');
    mix.bpm = input.bpm;
  }
  if (input.masterEffects !== undefined) mix.masterEffects = chain(input.masterEffects, layout.master);
  for (const track of input.tracks) {
    if (!isRecord(track) || typeof track.id !== 'string' || seen.has(track.id) || !bounded(track.volumeDb, -96, 24) || !bounded(track.pan, -1, 1)) throw failure('音轨混音更新无效');
    const previous = layout.tracks.get(track.id); if (!previous) throw sessionRequired();
    seen.add(track.id);
    const update: NativeMix['tracks'][number] = { id: track.id, volumeDb: track.volumeDb, pan: track.pan };
    if (track.effects !== undefined) update.effects = chain(track.effects, previous.effects);
    if (track.clipEffects !== undefined) {
      if (!Array.isArray(track.clipEffects) || track.clipEffects.length > previous.clips.size) throw failure('片段效果更新无效');
      const clipIds = new Set<string>();
      update.clipEffects = track.clipEffects.map(clip => {
        if (!isRecord(clip) || typeof clip.id !== 'string' || clipIds.has(clip.id)) throw failure('片段效果更新无效');
        const before = previous.clips.get(clip.id);
        if (!before) throw sessionRequired();
        clipIds.add(clip.id);
        return { id: clip.id, effects: chain(clip.effects, before) };
      });
    }
    mix.tracks.push(update);
  }
  return mix;
}

function vst3ValueRequests(value: unknown): Vst3ValueRequest[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw failure('VST3 实时读回须包含 1–32 个效果实例');
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    if (!isRecord(item) || Object.keys(item).some(key => key !== 'effectId' && key !== 'paramIds') ||
        typeof item.effectId !== 'string' || !effectIdPattern.test(item.effectId) || seen.has(item.effectId) ||
        !Array.isArray(item.paramIds) || !item.paramIds.length || item.paramIds.length > 128 ||
        new Set(item.paramIds).size !== item.paramIds.length ||
        item.paramIds.some(id => !Number.isInteger(id) || !bounded(id, 0, 0xffffffff))) throw failure('VST3 实时读回参数无效');
    seen.add(item.effectId);
    return { effectId: item.effectId, paramIds: item.paramIds };
  });
}

export async function nativeCommand(id: string, command: NativeMessage): Promise<NativeMessage> {
  if (!idPattern.test(id)) throw failure('音频客户端标识无效');
  if (command.op === 'dispose') { clients.get(id)?.close(); clients.delete(id); return { ok: true }; }
  if (!['session', 'mix', 'play', 'pause', 'seek', 'monitor', 'reset-meters', 'listen-noise', 'vst3-open', 'vst3-close', 'vst3-sync', 'vst3-parameter-values'].includes(command.op)) throw failure('不支持的音频操作');
  if ((command.op === 'seek' || command.op === 'play') && (command.position !== undefined && (typeof command.position !== 'number' || !Number.isFinite(command.position) || command.position < 0 || command.position > 3630))) throw failure('播放位置无效');
  if (command.op === 'monitor' && !bounded(command.db, -96, 0)) throw failure('监听音量无效');
  if (command.op === 'listen-noise' && !(typeof command.effectId === 'string' && /^(?:[a-z0-9_-]{1,160})?$/i.test(command.effectId))) throw failure('去噪监听标识无效');
  if (command.op === 'vst3-open' && !(typeof command.effectId === 'string' && effectIdPattern.test(command.effectId))) throw failure('VST3 效果标识无效');
  if (command.op === 'vst3-parameter-values') command = { op: command.op, requests: vst3ValueRequests(command.requests) };
  if (command.compareDb !== undefined && !bounded(command.compareDb, -60, 0)) throw failure('试听补偿无效');
  const client = clientFor(id, command.op === 'session');
  if (!client || client.dead || (client.revision === undefined && command.op !== 'session')) {
    if (command.op === 'play' || command.op === 'mix') throw sessionRequired();
    if (command.op === 'vst3-open') return { ok: true, loaded: false, editorOpened: false, editorError: '原生音频会话尚未加载', vst3Editors: [] };
    return { ok: true, playing: false, loaded: false };
  }
  const updating = command.op === 'session' || command.op === 'mix' || command.op === 'vst3-open';
  if (updating && client.updating) throw failure('上一项混音更新正在处理，请稍后重试', 409);
  if (command.op === 'session' && command.revision !== undefined && !revisionOf(command.revision)) throw failure('会话修订号无效');
  if (command.op === 'mix') {
    if (!client.layout || client.revision !== command.baseRevision || !revisionOf(command.revision) || command.revision <= command.baseRevision) throw sessionRequired();
    command = { ...command, mix: validatedMix(command.mix, client.layout) };
  }
  if (command.op === 'session' || command.op === 'mix') {
    command = { ...command, vst3After: vst3Cursor(client, command.vst3After, command.vst3HostId) };
    delete command.vst3HostId;
  }
  if (updating) client.updating = true;
  try {
    if (command.op === 'vst3-open') {
      const effects = [...client.layout?.master ?? [], ...[...client.layout?.tracks.values() ?? []].flatMap(track => track.effects)];
      const matches = effects.filter(effect => effect.id === command.effectId && effect.type === 'vst3');
      if (matches.length !== 1 || !matches[0].vst3?.classId) return { ok: true, editorOpened: false, editorError: '当前会话中找不到此 VST3 效果', vst3Editors: client.vst3Editors, vst3HostId: client.vst3HostId };
      const classId = matches[0].vst3.classId;
      let plugin: Awaited<ReturnType<typeof resolveVst3Plugin>>;
      try { plugin = await resolveVst3Plugin(classId); } catch { plugin = undefined; }
      if (!plugin) return { ok: true, editorOpened: false, editorError: '找不到已扫描的 VST3 插件，请重新扫描后重试', vst3Editors: client.vst3Editors, vst3HostId: client.vst3HostId };
      command = { op: 'vst3-open', effectId: command.effectId, plugin: { classId, modulePath: plugin.binaryPath } };
    }
    const result = await client.command(command);
    if (command.op === 'vst3-parameter-values') return { ...result, loaded: true };
    if (command.op === 'session') {
      const session = command.session as DawSession;
      client.layout = { master: session.masterEffects ?? [], tracks: new Map(session.tracks.map(track => [track.id, {
        effects: track.effects ?? [], clips: new Map(track.clips.map(clip => [clip.id, clip.effects ?? []])),
      }])) };
      client.revision = command.revision ?? 0;
    } else if (command.op === 'mix') client.revision = command.revision;
    client.status = { ...client.status, ...result }; delete client.status.error;
    return { ...result, loaded: client.revision !== undefined, vst3Editors: client.vst3Editors, vst3HostId: client.vst3HostId };
  } finally { if (updating) client.updating = false; }
}
const cleanup = setInterval(() => { for (const [id, client] of clients) if (Date.now() - client.touched > 120000) { client.close(); clients.delete(id); } }, 30000); cleanup.unref();

async function runNativeAudioJob(session: object, jobFile: string, args: string[], signal: AbortSignal, timeoutMs: number, label: string): Promise<NativeMessage> {
  if (!nativeAudioAvailable()) throw failure(`原生音频组件缺失，无法${label}`, 503);
  signal.throwIfAborted(); await fs.writeFile(jobFile, JSON.stringify(session));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let result: NativeMessage | undefined, error = ''; let settled = false;
    const finish = (cause?: Error) => { if (settled) return; settled = true; clearTimeout(timeout); signal.removeEventListener('abort', cancel); cause ? reject(cause) : result ? resolve(result) : reject(failure(`原生${label}未生成完整结果`)); };
    const cancel = () => { child.kill(); };
    const timeout = setTimeout(() => { error = `${label}超时`; child.kill(); }, timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    createInterface({ input: child.stdout }).on('line', line => { try { const value = JSON.parse(line); if (value.complete) result = value; if (value.error) error = value.error; } catch {} });
    child.stderr.on('data', data => { error = (error + data).slice(-2000); });
    child.on('error', finish);
    // Wait for stdout to drain, including the final completion record.
    child.on('close', code => finish(signal.aborted ? failure(`${label}已取消`, 499) : code !== 0 ? failure(error || `原生${label}失败`) : undefined));
    if (signal.aborted) cancel();
  });
}

export function renderNativeAudio(session: object, jobFile: string, outputFile: string, signal: AbortSignal): Promise<NativeMessage> {
  return runNativeAudioJob(session, jobFile, ['--render', jobFile, outputFile], signal, 20 * 60 * 1000, '音频导出');
}

export async function scanNativeAutoMix(session: object, jobFile: string, signal: AbortSignal): Promise<AutoMixScan> {
  const result = await runNativeAudioJob(session, jobFile, ['--automix-scan', jobFile], signal, 120_000, '分析自动混音');
  if (!Array.isArray(result.tracks) || !bounded(result.hopSec, .01, 2) || !result.output) {
    throw failure('自动混音分析结果不完整', 500);
  }
  return result as AutoMixScan;
}

export function renderNativeAutoMixPreview(session: object, jobFile: string, outputFile: string, signal: AbortSignal) {
  return runNativeAudioJob(session, jobFile, ['--automix-preview', jobFile, outputFile], signal, 60_000, '生成混音试听');
}

export interface NativeComparison { activeLufs: number | null; otherLufs: number | null; start: number; end: number }
export async function measureNativeComparison(session: object, jobFile: string, signal: AbortSignal): Promise<NativeComparison> {
  const result = await runNativeAudioJob(session, jobFile, ['--compare', jobFile], signal, 30_000, '等响度测量');
  const loudness = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return { activeLufs: loudness(result.activeLufs), otherLufs: loudness(result.otherLufs), start: result.start, end: result.end };
}

export async function learnNativeNoise(session: object, jobFile: string, signal: AbortSignal): Promise<number[]> {
  const result = await runNativeAudioJob(session, jobFile, ['--learn-noise', jobFile], signal, 30_000, '学习噪声');
  if (!Array.isArray(result.noiseProfile) || result.noiseProfile.length !== 128 ||
      !result.noiseProfile.every((value: unknown) => bounded(value, -180, 40))) {
    throw failure('这里没有足够的底噪可供学习。请选取 0.5–3 秒实际听得到底噪的片段。', 422);
  }
  return result.noiseProfile;
}
