import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import { dataRoot } from './media';
import type { Vst3ParameterRequest, Vst3ParameterResult, Vst3ParamUpdate } from '../src/daw/vst3';

type Parameter = { id: number; name: string; unit: string; defaultValue: number; stepCount: number; readOnly: boolean };
export type Vst3Plugin = { classId: string; name: string; vendor: string; version: string; category: string; parameters: Parameter[]; latencySamples?: number; tailSamples?: number };
type Fingerprint = { binaryPath: string; size: number; mtimeMs: number };
type Module = { modulePath: string; fingerprint: Fingerprint };
type Issue = { module?: string; classId?: string; name?: string; message: string };
type Entry = Module & { plugins: Vst3Plugin[]; issues: Issue[] };
type Snapshot = { available: boolean; scanning: boolean; plugins: Vst3Plugin[]; issues: Issue[] };
type Options = { roots?: () => string[]; cacheFile?: string; executable?: string; timeoutMs?: number; parallelism?: number; scanner?: (modulePath: string) => Promise<unknown>; available?: () => boolean };
const classIdPattern = /^[0-9A-F]{32}$/;
const limitText = (value: unknown, max = 512): string | undefined => typeof value === 'string' && value.length <= max ? value : undefined;
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const nonnegativeInt = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const paramId = (value: unknown): value is number => typeof value === 'number' && nonnegativeInt(value) && value <= 0xffffffff;
const normalized = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const paramKey = (key: string) => /^(0|[1-9][0-9]*)$/.test(key) && paramId(Number(key));
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const pathKey = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const isNetworkPath = (value: string) => /^(?:\\\\|\/\/)/.test(value);
const sameFingerprint = (a: Fingerprint, b: Fingerprint) => pathKey(a.binaryPath) === pathKey(b.binaryPath) && a.size === b.size && a.mtimeMs === b.mtimeMs;
const displayPath = (value: string) => path.basename(value);
const scanners = new Set<ChildProcess>();
let stopping = false;
export function killVst3Scans() {
  stopping = true;
  for (const scanner of scanners) scanner.kill();
}

function parsePlugin(value: unknown): Vst3Plugin | undefined {
  if (!isRecord(value) || typeof value.classId !== 'string' || !classIdPattern.test(value.classId) || !Array.isArray(value.parameters) || value.parameters.length > 4096) return;
  const name = limitText(value.name), vendor = limitText(value.vendor), version = limitText(value.version), category = limitText(value.category);
  if (!name || vendor === undefined || version === undefined || category === undefined) return;
  const parameters: Parameter[] = []; const ids = new Set<number>();
  for (const p of value.parameters) {
    if (!isRecord(p) || !nonnegativeInt(p.id) || Number(p.id) > 0xffffffff || ids.has(Number(p.id)) || !limitText(p.name) || limitText(p.unit) === undefined || !finite(p.defaultValue) || Number(p.defaultValue) < 0 || Number(p.defaultValue) > 1 || !nonnegativeInt(p.stepCount) || Number(p.stepCount) > 0x7fffffff || typeof p.readOnly !== 'boolean') return;
    ids.add(Number(p.id)); parameters.push({ id: Number(p.id), name: p.name as string, unit: p.unit as string, defaultValue: Number(p.defaultValue), stepCount: Number(p.stepCount), readOnly: p.readOnly });
  }
  if (value.latencySamples !== undefined && !nonnegativeInt(value.latencySamples)) return;
  if (value.tailSamples !== undefined && !nonnegativeInt(value.tailSamples)) return;
  return { classId: value.classId, name, vendor, version, category, parameters,
    ...(value.latencySamples !== undefined ? { latencySamples: Number(value.latencySamples) } : {}),
    ...(value.tailSamples !== undefined ? { tailSamples: Number(value.tailSamples) } : {}) };
}
function parseResult(value: unknown, modulePath: string): { plugins: Vst3Plugin[]; issues: Issue[] } {
  if (!isRecord(value) || value.complete !== true || !Array.isArray(value.plugins) || value.plugins.length > 1024 || (value.issues !== undefined && (!Array.isArray(value.issues) || value.issues.length > 1024))) throw new Error('扫描器返回了不完整或无效的结果');
  const plugins: Vst3Plugin[] = []; const issues: Issue[] = []; const seen = new Set<string>();
  for (const raw of value.plugins) {
    const plugin = parsePlugin(raw);
    if (!plugin || seen.has(plugin.classId)) { issues.push({ module: displayPath(modulePath), message: '插件元数据无效或类标识重复' }); continue; }
    seen.add(plugin.classId); plugins.push(plugin);
  }
  for (const raw of (value.issues ?? []) as unknown[]) {
    if (!isRecord(raw) || !limitText(raw.message, 2000)) continue;
    issues.push({ module: displayPath(modulePath), message: raw.message as string,
      ...(typeof raw.classId === 'string' && classIdPattern.test(raw.classId) ? { classId: raw.classId } : {}),
      ...(limitText(raw.name) ? { name: raw.name as string } : {}) });
  }
  return { plugins, issues };
}
function defaultRoots() {
  if (process.env.VISIKI_VST3_SCAN_ROOTS !== undefined) return process.env.VISIKI_VST3_SCAN_ROOTS.split(path.delimiter).filter(Boolean);
  return [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Common', 'VST3'), process.env.CommonProgramFiles && path.join(process.env.CommonProgramFiles, 'VST3'), path.resolve('VST3')].filter((p): p is string => !!p);
}
async function fingerprint(modulePath: string): Promise<Fingerprint> {
  const stat = await fs.stat(modulePath); let binaryPath = modulePath;
  if (stat.isDirectory()) {
    const directory = path.join(modulePath, 'Contents', 'x86_64-win');
    const candidates = (await fs.readdir(directory, { withFileTypes: true })).filter(x => x.name.toLowerCase().endsWith('.vst3')).map(x => x.name).sort((a, b) => a.localeCompare(b, 'en'));
    const expected = path.basename(modulePath).toLowerCase();
    const selected = candidates.find(x => x.toLowerCase() === expected) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!selected) throw new Error('找不到唯一的 Windows x64 插件二进制文件');
    binaryPath = await fs.realpath(path.join(directory, selected));
  }
  if (isNetworkPath(binaryPath)) throw new Error('不扫描网络路径');
  const binary = await fs.stat(binaryPath);
  if (!binary.isFile()) throw new Error('插件二进制文件无效');
  return { binaryPath, size: binary.size, mtimeMs: binary.mtimeMs };
}
async function discover(roots: string[]): Promise<{ modules: Module[]; issues: Issue[] }> {
  const modules: Module[] = [], issues: Issue[] = []; const visited = new Set<string>(); let count = 0;
  const walk = async (input: string, depth: number): Promise<void> => {
    if (depth > 12 || count >= 10000 || isNetworkPath(input)) return;
    count++;
    let resolved: string; try { resolved = await fs.realpath(input); } catch { return; }
    if (isNetworkPath(resolved) || visited.has(pathKey(resolved))) return;
    visited.add(pathKey(resolved));
    let stat; try { stat = await fs.stat(resolved); } catch { return; }
    if (resolved.toLowerCase().endsWith('.vst3')) {
      try { modules.push({ modulePath: resolved, fingerprint: await fingerprint(resolved) }); }
      catch (error) { issues.push({ module: displayPath(resolved), message: error instanceof Error ? error.message : '无法读取插件模块' }); }
      return;
    }
    if (!stat.isDirectory()) return;
    const children: string[] = [];
    try {
      const directory = await fs.opendir(resolved);
      for await (const child of directory) { children.push(child.name); if (children.length >= 10000 - count) break; }
    } catch { return; }
    children.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), 'en') || a.localeCompare(b, 'en'));
    for (const child of children) { if (count >= 10000) break; await walk(path.join(resolved, child), depth + 1); }
  };
  for (const root of roots) { if (count >= 10000) break; await walk(path.resolve(root), 0); }
  if (count >= 10000) issues.push({ message: '扫描达到文件数量上限，部分插件可能未列出' });
  return { modules, issues };
}
function runVst3Child(executable: string, args: string[], timeoutMs: number, label: string, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    if (stopping) { reject(new Error('VST3 服务已停止')); return; }
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    scanners.add(child);
    let stdout = '', stderr = '', finished = false;
    const finish = (error?: Error, result?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    const abort = () => {
      child.kill();
      finish(new Error(`${label}已取消`));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(Object.assign(new Error(`${label}超时`), { code: 'VST3_TIMEOUT', status: 504 }));
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (finished) return;
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) {
        child.kill();
        finish(new Error(`${label}结果过大`));
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', error => finish(error));
    child.on('close', code => {
      scanners.delete(child);
      if (finished) return;
      let result: unknown, message: string | undefined;
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const parsed: unknown = JSON.parse(line);
          if (isRecord(parsed) && parsed.complete === true) result = parsed;
          if (isRecord(parsed) && typeof parsed.error === 'string') message = parsed.error.slice(0, 2000);
        } catch { /* Plug-ins may print diagnostics alongside the host's JSON. */ }
      }
      if (code === 0 && result) finish(undefined, result);
      else finish(new Error(message || stderr || (code === 0 ? `${label}未返回完整结果` : `${label}退出 (${code})`)));
    });
  });
}

export function createVst3Catalog(options: Options = {}) {
  const executable = options.executable ?? path.resolve('dist-native/VisikiAudioHost.exe');
  const cacheFile = options.cacheFile ?? path.join(dataRoot, 'daw', 'vst3-cache.json');
  const roots = options.roots ?? defaultRoots;
  const available = options.available ?? (() => process.platform === 'win32' && existsSync(executable));
  // The scan and the audio host open the exact same verified x64 DLL.
  const scanner = (module: Module) => options.scanner
    ? options.scanner(module.modulePath)
    : runVst3Child(executable, ['--scan-vst3', module.fingerprint.binaryPath], options.timeoutMs ?? 15000, 'VST3 扫描');
  let entries: Entry[] = [], discoveryIssues: Issue[] = []; let initialized: Promise<void> | undefined; let active: Promise<Snapshot> | undefined; let activeForce = false;
  const refreshCache = async () => {
    const found = await discover(roots()); discoveryIssues = found.issues;
    let raw: unknown; try { raw = JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch { raw = undefined; }
    const cached = isRecord(raw) && raw.version === 1 && Array.isArray(raw.entries) && raw.entries.length <= 10000 ? raw.entries : [];
    const map = new Map<string, Record<string, unknown>>();
    for (const item of cached) if (isRecord(item) && typeof item.modulePath === 'string') map.set(pathKey(item.modulePath), item);
    entries = [];
    for (const module of found.modules) {
      const item = map.get(pathKey(module.modulePath));
      if (!item || !isRecord(item.fingerprint) || typeof item.fingerprint.binaryPath !== 'string' || !finite(item.fingerprint.size) || !finite(item.fingerprint.mtimeMs) || !sameFingerprint(module.fingerprint, item.fingerprint as Fingerprint)) continue;
      try { const result = parseResult({ complete: true, plugins: item.plugins, issues: item.issues }, module.modulePath); entries.push({ ...module, ...result }); } catch {}
    }
  };
  const init = () => initialized ??= refreshCache();
  const snapshot = (): Snapshot => {
    const plugins: Vst3Plugin[] = [], issues = [...discoveryIssues]; const seen = new Set<string>();
    for (const entry of entries) {
      issues.push(...entry.issues);
      for (const plugin of entry.plugins) {
        if (seen.has(plugin.classId)) { issues.push({ module: displayPath(entry.modulePath), classId: plugin.classId, name: plugin.name, message: '类标识重复，已使用优先目录中的插件' }); continue; }
        seen.add(plugin.classId); plugins.push(plugin);
      }
    }
    if (!available()) issues.push({ message: 'VST3 扫描组件不可用；请构建或恢复原生音频组件' });
    return { available: available(), scanning: !!active, plugins, issues };
  };
  const persist = async () => {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const temp = `${cacheFile}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temp, JSON.stringify({ version: 1, entries }), 'utf8'); await fs.rename(temp, cacheFile); }
    finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  };
  const scan = async (force = false): Promise<Snapshot> => {
    await init();
    if (active) { if (!force || activeForce) { await active; return snapshot(); } await active; return scan(true); }
    activeForce = force;
    active = (async () => {
      if (!available()) return snapshot();
      const found = await discover(roots()); discoveryIssues = found.issues;
      const previous = new Map(entries.map(entry => [pathKey(entry.modulePath), entry]));
      const results: Entry[] = new Array(found.modules.length); let next = 0;
      const worker = async () => { for (;;) {
        const index = next++; if (index >= found.modules.length) break;
        const module = found.modules[index], old = previous.get(pathKey(module.modulePath));
        if (!force && old && sameFingerprint(old.fingerprint, module.fingerprint)) { results[index] = old; continue; }
        try {
          const result = parseResult(await scanner(module), module.modulePath);
          const after = await fingerprint(module.modulePath);
          if (!sameFingerprint(module.fingerprint, after)) throw new Error('扫描期间插件文件发生变化，请重新扫描');
          results[index] = { ...module, ...result };
        } catch (error) { results[index] = { ...module, plugins: [], issues: [{ module: displayPath(module.modulePath), message: (error instanceof Error ? error.message : '插件扫描失败').slice(0, 2000) }] }; }
      } };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(4, options.parallelism ?? 2)) }, worker));
      entries = results;
      try { await persist(); } catch { discoveryIssues.push({ message: '无法保存 VST3 扫描缓存' }); }
      return snapshot();
    })();
    try { await active; } finally { active = undefined; activeForce = false; }
    return snapshot();
  };
  return {
    async status() {
      await init();
      const checkedEntries = entries;
      const verified = await Promise.all(checkedEntries.map(async entry => { try { return sameFingerprint(entry.fingerprint, await fingerprint(entry.modulePath)); } catch { return false; } }));
      // Do not overwrite results being committed by a concurrent scan.
      if (!active && entries === checkedEntries) entries = checkedEntries.filter((_, index) => verified[index]);
      return snapshot();
    }, scan,
    async startScan(force = false) {
      await init();
      if (!available()) return snapshot();
      void scan(force).catch(error => {
        discoveryIssues.push({ message: error instanceof Error ? error.message : 'VST3 扫描失败' });
      });
      return { ...snapshot(), scanning: true };
    },
    async resolve(classId: string) {
      if (!classIdPattern.test(classId)) return undefined;
      await init();
      for (const entry of entries) {
        const plugin = entry.plugins.find(p => p.classId === classId); if (!plugin) continue;
        try { if (sameFingerprint(entry.fingerprint, await fingerprint(entry.modulePath))) return { ...plugin, modulePath: entry.modulePath, binaryPath: entry.fingerprint.binaryPath }; } catch {}
        return undefined;
      }
      return undefined;
    },
  };
}
const catalog = createVst3Catalog();
export const resolveVst3Plugin = (classId: string) => catalog.resolve(classId);
const vst3Failure = (error: string, status: number, code: string) => Object.assign(new Error(error), { status, code });
const badProbe = (error: string): never => { throw vst3Failure(error, 400, 'VST3_INVALID_ARGUMENT'); };

function parseUpdates(value: unknown): Vst3ParamUpdate[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.length || value.length > 128) return badProbe('VST3 参数更新须包含 1–128 项');
  const used = new Set<number>();
  return value.map((entry: unknown) => {
    if (!isRecord(entry) || Object.keys(entry).some(key => !['paramId', 'format', 'value', 'unit'].includes(key)) ||
        !paramId(entry.paramId) || used.has(entry.paramId)) return badProbe('VST3 参数 ID 无效或重复');
    const { paramId: id, format, value: input, unit } = entry;
    used.add(id);
    if (format === 'plain') {
      if (typeof input !== 'number' || !Number.isFinite(input) || (unit !== undefined && (typeof unit !== 'string' || !unit.trim() || unit.length > 128))) return badProbe('VST3 普通数值或单位无效');
      return { paramId: id, format, value: input, ...(unit === undefined ? {} : { unit }) };
    }
    if (unit !== undefined) return badProbe('只有 plain 形式可以提供单位');
    if (format === 'normalized' && normalized(input)) return { paramId: id, format, value: input };
    if (format === 'choice' && typeof input === 'number' && nonnegativeInt(input) && input <= 0x7fffffff) return { paramId: id, format, value: input };
    if (format === 'choice' && typeof input === 'string' && input.trim() && input.length <= 127) return { paramId: id, format, value: input };
    if (format === 'text' && typeof input === 'string' && input.trim() && input.length <= 127) return { paramId: id, format, value: input };
    return badProbe('VST3 参数格式或数值无效');
  });
}

function parseProbe(value: unknown): Vst3ParameterRequest {
  if (!isRecord(value) || Object.keys(value).some(key => !['classId', 'sampleRate', 'params', 'query', 'offset', 'limit', 'paramIds', 'includeChoices', 'updates'].includes(key))) return badProbe('VST3 查询字段无效');
  const { classId, sampleRate, params, query, offset, limit, paramIds, includeChoices } = value;
  if (typeof classId !== 'string' || !classIdPattern.test(classId)) return badProbe('VST3 插件 classId 无效');
  if (typeof sampleRate !== 'number' || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) return badProbe('VST3 查询采样率无效');
  if (!isRecord(params) || Object.keys(params).length > 4096 || Object.entries(params).some(([key, val]) => !paramKey(key) || !normalized(val))) return badProbe('VST3 工程参数无效');
  if (query !== undefined && (typeof query !== 'string' || query.length > 240)) return badProbe('VST3 搜索词无效');
  if (offset !== undefined && (typeof offset !== 'number' || !nonnegativeInt(offset))) return badProbe('VST3 分页起点无效');
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 128)) return badProbe('VST3 分页大小须为 1–128');
  if (paramIds !== undefined && (!Array.isArray(paramIds) || paramIds.length > 128 || !paramIds.every(paramId) || new Set(paramIds).size !== paramIds.length)) return badProbe('VST3 查询参数 ID 无效或重复');
  if (includeChoices !== undefined && typeof includeChoices !== 'boolean') return badProbe('VST3 查询选项无效');
  return { classId, sampleRate, params: params as Record<string, number>, query, offset, limit, paramIds, includeChoices, updates: parseUpdates(value.updates) };
}

function parameterResult(input: Vst3ParameterRequest, value: unknown): Vst3ParameterResult {
  const malformed = () => vst3Failure('原生宿主返回的 VST3 参数结果无效', 502, 'VST3_INVALID_RESULT');
  if (!isRecord(value) || !Array.isArray(value.parameters) || value.parameters.length > 128 ||
      !nonnegativeInt(value.total) || (value.nextOffset !== null && !nonnegativeInt(value.nextOffset))) throw malformed();
  const ids = new Set<number>();
  for (const parameter of value.parameters) {
    if (!isRecord(parameter) || !paramId(parameter.id) || ids.has(parameter.id) ||
        !normalized(parameter.normalizedValue) || !normalized(parameter.defaultValue) ||
        typeof parameter.name !== 'string' || typeof parameter.unit !== 'string' ||
        !nonnegativeInt(parameter.stepCount) || typeof parameter.readOnly !== 'boolean') throw malformed();
    ids.add(parameter.id);
  }
  const result: Vst3ParameterResult = { classId: input.classId, parameters: value.parameters, total: Number(value.total), nextOffset: value.nextOffset === null ? null : Number(value.nextOffset) };
  if (input.updates) {
    const resolved = value.resolved;
    if (!isRecord(resolved) || Object.keys(resolved).length !== input.updates.length ||
        input.updates.some(update => !ids.has(update.paramId) || !normalized(resolved[String(update.paramId)]))) throw malformed();
    result.resolved = resolved as Record<string, number>;
  }
  return result;
}

export const vst3Router = Router();
vst3Router.get('/plugins', async (_req, res) => { res.json(await catalog.status()); });
vst3Router.post('/scan', async (req, res) => {
  const body = req.body ?? {};
  if (!isRecord(body) || Object.entries(body).some(([key, value]) => !['force', 'background'].includes(key) || typeof value !== 'boolean')) return res.status(400).json({ error: '扫描请求无效' });
  return res.json(await (body.background ? catalog.startScan(body.force === true) : catalog.scan(body.force === true)));
});
vst3Router.post('/parameters', async (req, res) => {
  const input = parseProbe(req.body);
  const executable = path.resolve('dist-native/VisikiAudioHost.exe');
  if (process.platform !== 'win32' || !existsSync(executable)) throw vst3Failure('原生 VST3 宿主不可用', 503, 'VST3_NOT_AVAILABLE');
  const plugin = await catalog.resolve(input.classId);
  if (!plugin) throw vst3Failure('找不到已扫描的 VST3 插件，请重新扫描', 404, 'VST3_PLUGIN_NOT_FOUND');
  const abort = new AbortController();
  const close = () => abort.abort();
  res.once('close', close);
  let directory: string | undefined;
  let job: string | undefined;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'visiki-vst3-params-'));
    job = path.join(directory, 'query.json');
    await fs.writeFile(job, JSON.stringify({ ...input, modulePath: plugin.binaryPath }), { signal: abort.signal });
    const result = await runVst3Child(executable, ['--vst3-parameters', job], 12000, 'VST3 参数查询', abort.signal).catch(error => {
      if (error?.code === 'VST3_TIMEOUT') throw error;
      throw vst3Failure(error instanceof Error ? error.message : 'VST3 参数查询失败', 422, 'VST3_PARAMETER_ERROR');
    });
    if (!abort.signal.aborted) res.json(parameterResult(input, result));
  } finally {
    res.off('close', close);
    if (job) await fs.unlink(job).catch(() => {});
    if (directory) await fs.rmdir(directory).catch(() => {});
  }
});
