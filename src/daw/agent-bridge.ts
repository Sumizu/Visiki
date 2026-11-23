import type { AgentExecutor } from '../agent-client';
import { applyDawAgentOperations, applyDawAgentOperationsAsync, dawAgentCatalog } from './agent-operations';
import { DawAgentJobs } from './agent-jobs';
import { findComparisonEffect } from './effect-comparison';
import { DAW_FAVORITES_KEY, DAW_PRESETS_KEY, createDawUserPreset, readDawEffectFavorites, readDawUserPresets, writeEffectPreference } from './effect-preferences';
import { applyEffectPreset, canAuditionDenoise, getEffect, getEffectDefaultParams, isDawEffectType, updateEffect } from './effects';
import { isDawGridDivision } from './grid-division';
import { DAW_MAX_DURATION, DAW_TRACK_COLORS, addAssetToSession, addClip, addTrack, createClip, createSession, createTrack, parseSession, sessionDuration, withoutDawWaveforms } from './model';
import type { DawSession } from './model';
import type { DawAudioEngine } from './native-engine';
import type { DawPanelLayout } from './panel-layout';
import type { DawPreferences } from './preferences';
import { getVst3Plugins, inspectVst3Parameters, type Vst3ParamUpdate } from './vst3';
import { hydrateDawSession, importDawRenderToEditor, loadDawAsset } from './services';

export type DawAgentSelection = { trackId: string; clipId?: string } | null;
export interface DawAgentViewPatch {
  selection?: DawAgentSelection;
  preferences?: Partial<DawPreferences>;
  zoom?: number;
  fit?: boolean;
  mixerOpen?: boolean;
  panels?: Partial<DawPanelLayout>;
}
export interface DawAgentTransportPatch { time?: number; playing?: boolean; monitorDb?: number }
interface DawAgentView {
  active: boolean;
  selection: DawAgentSelection;
  preferences: DawPreferences;
  zoom: number;
  mixerOpen: boolean;
  panels: DawPanelLayout;
}
interface DawAgentTransport {
  time: number;
  editTime: number;
  playing: boolean;
  monitorDb: number;
}
export interface DawAgentWorkspace {
  session: () => DawSession;
  revision: () => number;
  editing: () => boolean;
  history: () => { canUndo: boolean; canRedo: boolean };
  commit: (next: DawSession, replace?: boolean) => void;
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
  engine: () => DawAudioEngine;
  view: () => DawAgentView;
  setView: (patch: DawAgentViewPatch) => DawAgentView;
  transport: () => DawAgentTransport;
  setTransport: (patch: DawAgentTransportPatch, signal: AbortSignal) => Promise<DawAgentTransport>;
}

export const dawAgentError = (message: string, code = 'INVALID_ARGUMENT') => Object.assign(new Error(message), { code });
const fail = (message: string, code?: string): never => { throw dawAgentError(message, code); };
function object(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    return fail(`${name}格式无效或包含未知字段。`);
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 165): string {
  return typeof value === 'string' && value.length <= max && value.trim() ? value : fail(`${name}无效。`);
}
function number(value: unknown, min: number, max: number, name: string): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fail(`${name}须在 ${min}–${max} 之间。`);
}
function boolean(value: unknown, name: string): boolean {
  return typeof value === 'boolean' ? value : fail(`${name}须为布尔值。`);
}
function choice<const T extends string>(value: unknown, choices: readonly T[], name: string): T {
  return typeof value === 'string' && choices.includes(value as T) ? value as T : fail(`${name}无效。`);
}
function assetId(value: unknown): string {
  const id = text(value, '素材标识');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id : fail('素材或导出标识无效。');
}
function parseView(value: unknown, session: DawSession): DawAgentViewPatch {
  const args = object(value, ['selection', 'preferences', 'zoom', 'fit', 'mixerOpen', 'panels'], '视图参数');
  const patch: DawAgentViewPatch = {};
  if (args.selection !== undefined) {
    if (args.selection === null) patch.selection = null;
    else {
      const selected = object(args.selection, ['trackId', 'clipId'], '选区');
      const trackId = text(selected.trackId, '音轨标识');
      const track = session.tracks.find(item => item.id === trackId) ?? fail('找不到选中音轨。', 'TRACK_NOT_FOUND');
      const clipId = selected.clipId === undefined ? undefined : text(selected.clipId, '片段标识');
      if (clipId !== undefined && !track.clips.some(clip => clip.id === clipId)) fail('找不到选中片段。', 'CLIP_NOT_FOUND');
      patch.selection = { trackId, ...(clipId === undefined ? {} : { clipId }) };
    }
  }
  if (args.preferences !== undefined) {
    const options = object(args.preferences, ['snapEnabled', 'snapGrid', 'snapEdges', 'snapCursor', 'rulerUnit', 'gridDivision', 'restartMode'], '时间线偏好');
    const preferences: Partial<DawPreferences> = {};
    for (const key of ['snapEnabled', 'snapGrid', 'snapEdges', 'snapCursor'] as const) {
      if (options[key] !== undefined) preferences[key] = boolean(options[key], key);
    }
    if (options.rulerUnit !== undefined) preferences.rulerUnit = choice(options.rulerUnit, ['time', 'bars'], '标尺');
    if (options.restartMode !== undefined) preferences.restartMode = choice(options.restartMode, ['resume', 'from-cursor'], '自动返回选项');
    if (options.gridDivision !== undefined) preferences.gridDivision = isDawGridDivision(options.gridDivision) ? options.gridDivision : fail('网格细分无效。');
    patch.preferences = preferences;
  }
  if (args.zoom !== undefined) patch.zoom = number(args.zoom, 4, 250, '每秒像素');
  if (args.fit !== undefined) patch.fit = boolean(args.fit, '适配工程');
  if (patch.fit && patch.zoom !== undefined) fail('请在适配工程与明确缩放值中选择一项。');
  if (args.mixerOpen !== undefined) patch.mixerOpen = boolean(args.mixerOpen, '混音器开关');
  if (args.panels !== undefined) {
    const panels = object(args.panels, ['head', 'inspector', 'mixer'], '面板大小');
    patch.panels = {};
    if (panels.head !== undefined) patch.panels.head = number(panels.head, 140, 320, '音轨栏宽度');
    if (panels.inspector !== undefined) patch.panels.inspector = number(panels.inspector, 235, 460, '属性栏宽度');
    if (panels.mixer !== undefined) patch.panels.mixer = number(panels.mixer, 170, 420, '混音器高度');
  }
  return patch;
}
function parseTransport(value: unknown): DawAgentTransportPatch {
  const args = object(value, ['time', 'playing', 'monitorDb'], '播放参数');
  return {
    ...(args.time === undefined ? {} : { time: number(args.time, 0, DAW_MAX_DURATION, '游标位置') }),
    ...(args.playing === undefined ? {} : { playing: boolean(args.playing, '播放状态') }),
    ...(args.monitorDb === undefined ? {} : { monitorDb: number(args.monitorDb, -60, 0, '试听音量') }),
  };
}
function validateReference(value: unknown) {
  const ref = object(value, ['kind', 'id'], '参考声音');
  return { kind: choice(ref.kind, ['clip', 'asset'], '参考类型'), id: text(ref.id, '参考标识') };
}
async function dryReference(current: DawSession, reference: ReturnType<typeof validateReference>, signal: AbortSignal) {
  const clip = reference.kind === 'clip'
    ? current.tracks.flatMap(track => track.clips).find(clip => clip.id === reference.id) ?? fail('找不到参考片段。', 'CLIP_NOT_FOUND')
    : undefined;
  const id = clip?.assetId ?? reference.id;
  const asset = current.assets.find(source => source.id === id) ?? await loadDawAsset(assetId(id), signal, true);
  const track = createTrack(asset.name);
  const piece = createClip(asset);
  if (clip) { piece.sourceIn = clip.sourceIn; piece.duration = clip.duration; }
  return { ...createSession(asset.name), sampleRate: current.sampleRate, assets: [{ ...asset, peaks: [] }], tracks: [{ ...track, clips: [piece] }] };
}

function effectPresets(workspace: DawAgentWorkspace, session: DawSession, raw: unknown, writable: () => void) {
  const all = ['action', 'effectType', 'target', 'effectId', 'presetId', 'name', 'favorite'];
  const args = object(raw, all, '预设参数');
  const presets = readDawUserPresets();
  const action = choice(args.action, ['list', 'save', 'delete', 'apply', 'favorite'], '预设操作');
  const matchType = () => isDawEffectType(args.effectType) ? args.effectType : fail('未知效果类型。');
  switch (action) {
    case 'list': {
      object(args, ['action', 'effectType'], '查询预设参数');
      const type = args.effectType === undefined ? undefined : matchType();
      return { presets: type ? presets.filter(item => item.type === type) : presets, favorites: readDawEffectFavorites() };
    }
    case 'favorite': {
      object(args, ['action', 'effectType', 'favorite'], '收藏效果参数');
      const type = matchType();
      const next = new Set(readDawEffectFavorites());
      if (boolean(args.favorite, '收藏开关')) next.add(type); else next.delete(type);
      writeEffectPreference(DAW_FAVORITES_KEY, [...next]);
      return { favorites: [...next] };
    }
    case 'delete': {
      object(args, ['action', 'presetId'], '删除预设参数');
      const id = text(args.presetId, '预设标识');
      if (!presets.some(item => item.id === id)) fail('找不到用户预设。', 'PRESET_NOT_FOUND');
      writeEffectPreference(DAW_PRESETS_KEY, presets.filter(item => item.id !== id));
      return { removed: id };
    }
    case 'save': {
      object(args, ['action', 'target', 'effectId', 'name'], '保存预设参数');
      const effect = getEffect(session, text(args.target, '效果目标'), text(args.effectId, '效果标识'));
      const preset = createDawUserPreset(effect, text(args.name, '预设名称', 80).trim());
      writeEffectPreference(DAW_PRESETS_KEY, [...presets, preset]);
      return { preset };
    }
    case 'apply': {
      object(args, ['action', 'target', 'effectId', 'presetId'], '应用预设参数');
      writable();
      const target = text(args.target, '效果目标'), id = text(args.effectId, '效果标识'), presetId = text(args.presetId, '预设标识');
      const effect = getEffect(session, target, id);
      if (effect.type === 'vst3') return fail('VST3 插件暂不支持内置或个人预设。');
      const preset = presets.find(item => item.id === presetId && item.type === effect.type);
      const next = preset
        ? updateEffect(session, target, id, { presetId: null, params: { ...getEffectDefaultParams(effect.type), ...preset.params } })
        : applyEffectPreset(session, target, id, presetId);
      workspace.commit(next);
      return { revision: workspace.revision(), effect: getEffect(next, target, id) };
    }
  }
}

/** Applies Agent commands to the live DAW and its shared undo history. */
export function createDawAgentBridge(bound: () => DawAgentWorkspace) {
  const jobs = new DawAgentJobs();
  const execute: AgentExecutor = async (command, signal) => {
    signal.throwIfAborted();
    const { type, expectedRevision } = command;
    const args = command.args ?? {};
    const workspace = bound();
    let session = workspace.session();
    let revision = workspace.revision();
    const writable = () => {
      signal.throwIfAborted();
      const current = bound();
      if (current.revision() !== revision) fail('DAW 工程已变化，请重新读取后再编辑。', 'DAW_REVISION_CONFLICT');
      if (current.editing()) fail('DAW 正在导入、编辑或拖动，请在当前操作结束后重试。', 'DAW_BUSY');
    };
    if (expectedRevision !== undefined && expectedRevision !== revision) fail('DAW 工程已变化，请重新读取后再编辑。', 'DAW_REVISION_CONFLICT');
    const hasVst3 = () => [...session.masterEffects ?? [], ...session.tracks.flatMap(track => track.effects ?? [])].some(effect => effect.type === 'vst3');
    // Synchronization can itself commit a plugin editor change. Accept that new revision only
    // when the caller did not supply an expected revision, and never mask unrelated edits.
    const syncEditors = async () => {
      if (!hasVst3()) return;
      if (bound().revision() !== revision) fail('DAW 工程已变化，请重新读取后再编辑。', 'DAW_REVISION_CONFLICT');
      await workspace.engine().syncVst3Editors();
      signal.throwIfAborted();
      const current = bound();
      if (expectedRevision !== undefined && current.revision() !== expectedRevision) fail('DAW 工程已变化，请重新读取后再编辑。', 'DAW_REVISION_CONFLICT');
      session = current.session(); revision = current.revision();
    };
    const snapshot = () => {
      const current = bound();
      const document = current.session();
      const playback = current.engine();
      return { session: withoutDawWaveforms(document), revision: current.revision(), duration: sessionDuration(document),
        missingAssetIds: document.assets.filter(asset => !asset.peaks.length).map(asset => asset.id),
        ...current.history(), ...current.view(), ...current.transport(),
        comparison: playback.getComparison() ?? null, noiseListenId: playback.getNoiseListenId() ?? null };
    };
    switch (type) {
      case 'catalog': {
        object(args, ['effectType', 'vst3', 'classId', 'effectId', 'query', 'offset', 'limit', 'includeChoices'], '目录参数');
        if (args.vst3 !== undefined && args.vst3 !== true) fail('vst3 必须为 true。');
        if (args.vst3 !== true) {
          object(args, ['effectType'], '目录参数');
          if (args.effectType !== undefined && !isDawEffectType(args.effectType)) return fail('未知效果类型。');
          return { ...dawAgentCatalog(args.effectType), targetFormat: { master: 'master', track: '<trackId>', clip: 'clip:<clipId>' },
            capabilities: { builtinEffects: true, vst3: true, audioFormat: 'WAV PCM 24-bit stereo', revisions: true },
            autoMix: { harmony: ['support', 'duet', 'mixed'], direction: ['natural', 'forward', 'blended'],
              genre: ['none', 'pop', 'rock', 'acoustic'], space: ['unchanged', 'room', 'plate'], delivery: ['preserve', 'peak', 'custom'] } };
        }
        if (args.effectType !== undefined || (args.classId !== undefined && args.effectId !== undefined)) fail('VST3 目录须选择 classId 或 effectId，不能与 effectType 同时使用。');
        const query = args.query === undefined ? undefined : text(args.query, '搜索内容', 240);
        const offset = args.offset === undefined ? undefined : number(args.offset, 0, Number.MAX_SAFE_INTEGER, '偏移');
        const limit = args.limit === undefined ? undefined : number(args.limit, 1, 128, '数量');
        if ((offset !== undefined && !Number.isInteger(offset)) || (limit !== undefined && !Number.isInteger(limit))) fail('偏移和数量须为整数。');
        const includeChoices = args.includeChoices === undefined ? undefined : boolean(args.includeChoices, '包含选项');
        const registry = await getVst3Plugins(false, false, signal);
        if (args.classId === undefined && args.effectId === undefined) {
          const matched = query ? registry.plugins.filter(plugin => [plugin.classId, plugin.name, plugin.vendor, plugin.category].some(value => value.toLowerCase().includes(query.toLowerCase()))) : registry.plugins;
          const start = offset ?? 0;
          const page = matched.slice(start, start + (limit ?? 100)).map(({ parameters, ...plugin }) => ({ ...plugin, parameterCount: parameters.length }));
          return { ...registry, plugins: page, total: matched.length, nextOffset: start + page.length < matched.length ? start + page.length : null, capabilities: { vst3: registry.available, runtimeParameters: registry.available } };
        }
        let effect = undefined;
        if (args.effectId !== undefined) {
          await syncEditors();
          effect = findComparisonEffect(session, text(args.effectId, '效果标识'));
          if (!effect || effect.type !== 'vst3' || !effect.vst3) fail('找不到 VST3 效果实例。', 'EFFECT_NOT_FOUND');
        }
        const classId = effect?.vst3?.classId ?? text(args.classId, '插件 classId', 32);
        if (!registry.plugins.some(plugin => plugin.classId === classId)) fail('找不到已发现的 VST3 插件。', 'VST3_NOT_FOUND');
        const parameters = await inspectVst3Parameters({ classId, sampleRate: session.sampleRate, params: effect?.params ?? {}, query, offset, limit, includeChoices }, signal);
        if (effect && bound().revision() !== revision) fail('DAW 工程已变化，请重新读取后再查询。', 'DAW_REVISION_CONFLICT');
        return { ...parameters, ...(effect ? { effectId: effect.id, revision } : {}), capabilities: { vst3: registry.available, runtimeParameters: true } };
      }
      case 'get_session': object(args, [], '读取会话参数'); await syncEditors(); return snapshot();
      case 'new_session': {
        object(args, ['name'], '新建会话参数'); writable();
        workspace.commit(createSession(args.name === undefined ? undefined : text(args.name, '会话名称', 240)), true);
        return snapshot();
      }
      case 'replace_session': {
        object(args, ['session'], '打开会话参数'); writable();
        // Drop any derived waveform supplied in the file; hydrate against the local asset registry.
        const raw = args.session;
        const { session: next, missing } = await hydrateDawSession(compactSessionInput(raw), signal);
        writable(); bound().commit(next, true);
        return { ...snapshot(), missingAssets: missing };
      }
      case 'attach_asset': {
        object(args, ['assetId', 'placement', 'trackId', 'start', 'name'], '附加素材参数'); writable();
        const id = assetId(args.assetId);
        const placement = args.placement === undefined ? (args.trackId === undefined ? 'new_track' : 'existing_track')
          : choice(args.placement, ['new_track', 'existing_track', 'library'], '素材放置方式');
        if (placement === 'library' && (args.name !== undefined || args.start !== undefined || args.trackId !== undefined)) fail('仅加入素材库时无需提供轨道、位置或名称。');
        if (placement === 'new_track' && args.trackId !== undefined) fail('新建轨道时无需提供现有轨道标识。');
        const trackId = placement === 'existing_track' ? text(args.trackId, '音轨标识') : undefined;
        if (trackId && !session.tracks.some(track => track.id === trackId)) fail('找不到音轨。', 'TRACK_NOT_FOUND');
        const start = args.start !== undefined ? number(args.start, 0, DAW_MAX_DURATION, '开始位置') : 0;
        const name = args.name === undefined ? undefined : text(args.name, '片段或音轨名称', 240);
        const existing = session.assets.find(asset => asset.id === id);
        const asset = existing?.peaks.length ? existing : await loadDawAsset(id, signal);
        writable();
        let next = existing ? existing === asset ? session : { ...session, assets: session.assets.map(source => source.id === id ? asset : source) }
          : addAssetToSession(session, asset);
        let selection: DawAgentSelection | undefined;
        if (placement !== 'library') {
          if (start + asset.duration > DAW_MAX_DURATION + 1 / asset.sampleRate) fail('素材放置后会超出 1 小时工程范围。');
          let owner = trackId;
          if (!owner) {
            const track = createTrack(name ?? asset.name.replace(/\.[^.]+$/, ''), DAW_TRACK_COLORS[next.tracks.length % DAW_TRACK_COLORS.length]);
            next = addTrack(next, track);
            owner = track.id;
          }
          next = addClip(next, owner, id, start);
          const clip = next.tracks.find(track => track.id === owner)!.clips.at(-1)!;
          if (placement === 'existing_track' && name !== undefined) {
            next = applyDawAgentOperations(next, [{ op: 'update_clip', trackId: owner, clipId: clip.id, name }]).session;
          }
          selection = { trackId: owner, clipId: clip.id };
        }
        const latest = bound();
        latest.commit(next);
        if (selection) latest.setView({ selection });
        const { peaks: _peaks, ...assetSummary } = asset;
        return { ...snapshot(), asset: assetSummary, ...(selection ?? {}) };
      }
      case 'edit': {
        object(args, ['operations'], '批量编辑参数'); writable();
        const ops = args.operations;
        const needsVst3 = hasVst3() || (Array.isArray(ops) && ops.some(op => op && typeof op === 'object' && (op as Record<string, unknown>).op === 'add_vst3'));
        if (!needsVst3) {
          const { session: next, results } = applyDawAgentOperations(session, ops);
          workspace.commit(next);
          return { ...snapshot(), results };
        }
        await syncEditors(); writable();
        let registry: Awaited<ReturnType<typeof getVst3Plugins>> | undefined;
        const { session: next, results } = await applyDawAgentOperationsAsync(session, ops, async request => {
          registry ??= await getVst3Plugins(false, false, signal);
          writable();
          const classId = request.kind === 'add' ? request.classId : request.effect.vst3!.classId;
          const plugin = registry.plugins.find(item => item.classId === classId) ?? fail('找不到已发现的 VST3 插件。', 'VST3_NOT_FOUND');
          let updates: Vst3ParamUpdate[] = request.vst3Params ?? [];
          if (request.params !== undefined) updates = Object.entries(request.params).map(([id, value]) => {
            if (!/^(0|[1-9][0-9]*)$/.test(id) || Number(id) > 4294967295 || value < 0 || value > 1) fail('VST3 参数 ID 或归一化值无效。');
            return { paramId: Number(id), format: 'normalized' as const, value };
          });
          if (!updates.length) return { plugin, params: {} };
          const existing = request.kind === 'update' ? request.effect.params : Object.fromEntries(plugin.parameters.filter(p => !p.readOnly).map(p => [String(p.id), p.defaultValue]));
          const inspected = await inspectVst3Parameters({ classId, sampleRate: request.session.sampleRate, params: existing, updates, paramIds: updates.map(update => update.paramId) }, signal);
          writable();
          if (!inspected.resolved || updates.some(update => !Object.hasOwn(inspected.resolved!, String(update.paramId)))) fail('插件未返回所有参数解析结果。', 'VST3_UNAVAILABLE');
          return { plugin, params: inspected.resolved! };
        });
        writable(); bound().commit(next);
        const committed = { ...snapshot(), results };
        const requests = new Map<string, Set<number>>();
        const committedVst3 = new Map([...next.masterEffects ?? [], ...next.tracks.flatMap(track => track.effects ?? [])]
          .filter(effect => effect.type === 'vst3').map(effect => [effect.id, effect]));
        for (const result of results) if (typeof result.effectId === 'string' && Array.isArray(result.vst3ParamIds)) {
          if (!result.vst3ParamIds.length || !committedVst3.has(result.effectId)) continue;
          const ids = requests.get(result.effectId) ?? new Set<number>();
          for (const id of result.vst3ParamIds) ids.add(id as number);
          requests.set(result.effectId, ids);
        }
        if (!requests.size) return committed;
        try {
          const values = await bound().engine().readVst3Values([...requests].map(([effectId, ids]) => ({ effectId, paramIds: [...ids] })), signal);
          const byEffect = new Map(values.map(effect => [effect.effectId, effect]));
          const pending = [...requests].some(([effectId, ids]) => {
            const readback = byEffect.get(effectId);
            if (readback?.state !== 'active') return true;
            const stored = committedVst3.get(effectId)!.params;
            const observed = new Map(readback.values.map(param => [param.id, param]));
            return [...ids].some(id => {
              const value = observed.get(id);
              return !value?.processed || Math.abs(value.normalizedValue - stored[String(id)]) > 1e-6;
            });
          });
          return { ...committed, vst3Readback: { status: pending ? 'pending' : 'ok', effects: values } };
        } catch (error) {
          return { ...committed, vst3Readback: { status: 'error', message: error instanceof Error ? error.message : '插件读回失败' } };
        }
      }
      case 'undo':
      case 'redo':
        object(args, [], '编辑历史参数'); writable(); await workspace[type](); return snapshot();
      case 'view': {
        const patch = parseView(args, session); writable();
        if (patch.fit && !workspace.view().active) fail('请先激活 DAW 再适配时间线。', 'DAW_NOT_READY');
        return { ...workspace.setView(patch), revision };
      }
      case 'transport': {
        const patch = parseTransport(args);
        if (Object.keys(patch).length) writable();
        if (patch.playing && (!workspace.view().active || !sessionDuration(session))) fail('请先激活 DAW 并加入音频片段。', 'DAW_NOT_READY');
        return { ...await workspace.setTransport(patch, signal), revision };
      }
      case 'meters': {
        object(args, ['effectId', 'reset'], '电平参数');
        const engine = workspace.engine();
        const id = args.effectId === undefined ? undefined : text(args.effectId, '效果标识');
        if (id && !findComparisonEffect(session, id)) fail('找不到效果实例。', 'EFFECT_NOT_FOUND');
        // Read the last actual device readings. A paused stream may have no track data.
        if (args.reset !== undefined && boolean(args.reset, '重置电平')) await engine.resetMeters();
        return { revision, playing: engine.isPlaying(), time: engine.getPosition(), tracks: engine.getMeterLevels(),
          ...(id === undefined ? {} : { effectId: id, effect: engine.getEffectReading(id) ?? null }) };
      }
      case 'monitor_effect': {
        object(args, ['action', 'effectId', 'enabled'], '监听参数'); writable();
        const action = choice(args.action, ['compare', 'noise', 'clear'], '监听操作');
        const engine = workspace.engine();
        if (action === 'clear') {
          object(args, ['action'], '清除监听参数');
          engine.clearComparison(); engine.clearNoiseListening();
        } else {
          const id = text(args.effectId, '效果标识');
          const enabled = args.enabled === undefined ? true : boolean(args.enabled, '监听开关');
          const effect = findComparisonEffect(session, id) ?? fail('找不到效果实例。', 'EFFECT_NOT_FOUND');
          if (enabled && !workspace.view().active) fail('请先激活 DAW 再监听。', 'DAW_NOT_READY');
          if (action === 'compare') {
            if (!enabled) engine.clearComparison(id);
            else {
              if (!effect.enabled || !effect.bState || effect.type === 'meter') fail('请启用效果并准备 A、B 两组参数。');
              if (engine.getComparison()?.effectId !== id) void engine.toggleComparison(id);
              if (!engine.getComparison()) fail('等响度 A/B 监听不可用。', 'DAW_UNAVAILABLE');
            }
          } else {
            if (!enabled) engine.clearNoiseListening(id);
            else {
              if (!canAuditionDenoise(effect)) fail('请先启用去噪处理。');
              if (engine.getNoiseListenId() !== id) await engine.toggleNoiseListening(id);
              if (engine.getNoiseListenId() !== id) fail('当前去噪实例不可监听，请检查音轨的静音和独奏状态。', 'DAW_UNAVAILABLE');
            }
          }
        }
        return { revision, comparison: engine.getComparison() ?? null, noiseListenId: engine.getNoiseListenId() ?? null };
      }
      case 'effect_presets': return effectPresets(workspace, session, args, writable);
      case 'job_start': await syncEditors(); writable(); return jobs.start(session, revision, args);
      case 'job_status':
        object(args, ['jobId'], '查询任务参数');
        if (args.jobId === undefined) return { jobs: jobs.list() };
        return jobs.get(text(args.jobId, '任务标识'));
      case 'job_cancel': object(args, ['jobId'], '取消任务参数'); return jobs.cancel(text(args.jobId, '任务标识'));
      case 'job_apply': {
        writable();
        const jobId = text(args.jobId, '任务标识');
        const job = jobs.get(jobId);
        if (job.revision !== revision) fail('DAW 工程已变化，请重新分析。', 'DAW_REVISION_CONFLICT');
        workspace.commit(jobs.apply(session, revision, { ...args, jobId }));
        if (job.kind === 'rhythm') workspace.setView({ preferences: { rulerUnit: 'bars' } });
        return snapshot();
      }
      case 'preview_source': {
        await syncEditors();
        const start = number(args.start, 0, DAW_MAX_DURATION, '试听起点'), end = number(args.end, 0, DAW_MAX_DURATION, '试听终点');
        if (args.reference !== undefined) {
          object(args, ['reference', 'start', 'end', 'preview'], '参考试听参数');
          if (args.preview !== undefined) boolean(args.preview, '试听模式');
          const source = await dryReference(session, validateReference(args.reference), signal);
          return jobs.previewSource(source, revision, { start, end, preview: false });
        }
        return jobs.previewSource(session, revision, { ...args, start, end });
      }
      case 'send_to_editor':
        object(args, ['renderId'], '发送到剪辑参数');
        return importDawRenderToEditor(assetId(args.renderId), signal);
      default: return fail('不支持的 DAW 命令。');
    }
  };
  return { execute, dispose: () => jobs.dispose() };
}

function compactSessionInput(raw: unknown): DawSession {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('DAW 会话必须是对象。');
  const document = raw as Record<string, unknown>;
  const session = parseSession({ ...document, assets: Array.isArray(document.assets)
    ? document.assets.map(asset => asset && typeof asset === 'object' && !Array.isArray(asset) ? { ...asset, peaks: [] } : asset)
    : document.assets });
  return { ...session, assets: session.assets.map(source => ({ ...source, url: `/api/daw/assets/${source.id}` })) };
}
