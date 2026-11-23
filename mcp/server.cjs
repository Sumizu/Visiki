#!/usr/bin/env node
'use strict';
// Dependency-free MCP stdio bridge. stdout is exclusively newline JSON-RPC.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
function serverInfo(protocolVersion) {
  const info = { name: 'visiki-editor', version: '0.1.0' };
  if (protocolVersion === '2025-11-25') {
    try {
      info.icons = [{ src: 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'assets', 'visiki-64.png')).toString('base64'), mimeType: 'image/png', sizes: ['64x64'] }];
    } catch {} // Branding is optional; missing artwork must not prevent connection.
  }
  return info;
}
const MAX_LINE = 6 * 1024 * 1024;
const MAX_JSON = 16 * 1024 * 1024;
const TIMEOUT_MS = 35000;
const string = (maxLength = 500) => ({ type: 'string', minLength: 1, maxLength });
const number = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const revision = integer(0, Number.MAX_SAFE_INTEGER);
const localPath = { ...string(4096), description: 'Absolute local file path, never a URL or UNC/network path.' };
const opNames = ['update_project', 'add_layer', 'update_layer', 'remove_layer', 'reorder_layer', 'split_video', 'video_rate', 'move_layer', 'attach_asset', 'set_lyrics', 'add_effect'];
const tool = (name, description, inputSchema, readOnly = false, destructive = false, openWorld = false) => ({ name, description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: openWorld } });
const TOOLS = [
  tool('visiki_status', 'Check whether Visiki and its editor are connected. Does not start the application.', object(), true),
  tool('visiki_catalog', 'Read supported layer/effect types, templates, fonts and edit operation parameters before editing.', object(), true),
  tool('visiki_get_project', 'Read the live project, revision, playhead and undo/redo state. Use revision to prevent overwriting newer manual edits.', object(), true),
  tool('visiki_edit', 'Apply one atomic, undoable batch to the live project. Operations use op; consult visiki_catalog for operation fields. Layer params are merged, layer order bottom=0.', object({ operations: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { op: { type: 'string', enum: opNames } }, required: ['op'] } }, expectedRevision: revision }, ['operations'])),
  tool('visiki_apply_template', 'Apply a numbered built-in template; preserve custom text/video tracks by default. One undo step.', object({ id: string(100), keepCustomLayers: { type: 'boolean' }, expectedRevision: revision }, ['id'])),
  tool('visiki_open_project', 'Read an absolute local .visiki.json path (legacy .echo.json also accepted) and replace the live project, preserving undo. Media references must already exist in this Visiki data directory.', object({ path: localPath, expectedRevision: revision }, ['path']), false, true),
  tool('visiki_save_project', 'Save the live project snapshot to an absolute local .visiki.json path (legacy .echo.json also accepted). Refuse existing files unless overwrite=true. Snapshots reference media; they do not embed them.', object({ path: localPath, overwrite: { type: 'boolean' } }, ['path']), false, true),
  tool('visiki_import_media', 'Upload a local audio/image/video/font file and attach it to the live project in one undo step. Audio replaces the song; cover requires image; library imports images/videos/fonts. Partial failure reports the asset so it is not uploaded again.', object({ path: localPath, type: { type: 'string', enum: ['audio', 'image', 'video', 'font'] }, role: { type: 'string', enum: ['audio', 'cover', 'library'] }, expectedRevision: revision }, ['path', 'type'])),
  tool('visiki_search_lyrics', 'Search NetEase lyrics by song, artist, official link or song ID through Visiki. Requires internet; does not download music.', object({ query: string(500) }, ['query']), true, false, true),
  tool('visiki_get_lyrics', 'Fetch original/translated LRC for a NetEase song ID. apply=true applies timestamp-matched bilingual lyrics in one undo step; offsetMs optionally changes project delay.', object({ id: string(100), apply: { type: 'boolean' }, offsetMs: integer(-3600000, 3600000), expectedRevision: revision }, ['id']), false, false, true),
  tool('visiki_preview', 'Render an actual PNG at an optional time/resolution; returns image content without selection handles.', object({ time: number(0, 3600), width: integer(16, 1920), height: integer(16, 1920) }), true),
  tool('visiki_export_start', 'Start a background export and immediately return jobId. Poll visiki_export_status; do not repeatedly start. Uses configured Visiki FFmpeg.', object({ width: integer(320, 1920), height: integer(180, 1920), fps: { type: 'integer', enum: [24,25,30,60] }, start: number(0, 3600), end: number(0, 3600) })),
  tool('visiki_export_status', 'Query an export job for progress, completion or failure.', object({ jobId: string(100) }, ['jobId']), true),
  tool('visiki_export_cancel', 'Cancel a running Visiki export.', object({ jobId: string(100) }, ['jobId'])),
  tool('visiki_download_export', 'Download a completed export to an absolute local .mp4 path; refuses overwrites by default. Does not accept arbitrary download URLs.', object({ jobId: string(100), path: localPath, overwrite: { type: 'boolean' } }, ['jobId', 'path']), false, true),
  tool('visiki_undo', 'Undo one manual or agent edit.', object({ expectedRevision: revision })),
  tool('visiki_redo', 'Redo one project edit.', object({ expectedRevision: revision })),
  tool('visiki_seek', 'Set playhead seconds and optionally play/pause without editing project content.', object({ time: number(0, 3600), playing: { type: 'boolean' } }, ['time'])),
];

const DAW = require('./daw-tools.cjs')({ string, number, integer, object, revision, localPath, tool, filePath, atomicFile, checkTree, textResult });
TOOLS.push(...DAW.tools);

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function checkTree(value, depth = 0) {
  if (depth > 32) throw new Error('Nesting exceeds 32 levels');
  if (Array.isArray(value)) { for (const item of value) checkTree(item, depth + 1); }
  else if (isObject(value)) for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Forbidden property');
    checkTree(item, depth + 1);
  }
}
function validate(schema, value, location = 'arguments', depth = 0) {
  if (depth > 32) throw new Error(`${location}: nesting exceeds 32 levels`);
  if (schema.anyOf) { for (const choice of schema.anyOf) { try { validate(choice, value, location, depth + 1); return; } catch {} } throw new Error(`${location}: invalid value`); }
  if (schema.type === 'null') { if (value !== null) throw new Error(`${location}: expected null`); return; }
  if (schema.type === 'object') {
    if (!isObject(value)) throw new Error(`${location}: expected object`);
    for (const key of schema.required || []) if (!(key in value)) throw new Error(`${location}.${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`${location}: forbidden property`);
      const child = schema.properties?.[key];
      if (child) validate(child, item, `${location}.${key}`, depth + 1);
      else if (schema.additionalProperties === false) throw new Error(`${location}.${key}: unknown property`);
      else checkTree(item, depth + 1);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw new Error(`${location}: invalid array length`);
    for (let i = 0; i < value.length; i++) validate(schema.items, value[i], `${location}[${i}]`, depth + 1);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) throw new Error(`${location}: invalid string`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${location}: expected boolean`);
  } else if (['number', 'integer'].includes(schema.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value)) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new Error(`${location}: invalid number`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${location}: unsupported value`);
}
function filePath(value, suffix) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /^[\\/]{2}/.test(value) || /[\x00-\x1f]/.test(value) || /^[a-z]+:\/\//i.test(value)) throw new Error('Use an absolute local file path; URLs and network paths are not accepted.');
  if (suffix && !(Array.isArray(suffix) ? suffix : [suffix]).some(item => value.toLowerCase().endsWith(item))) throw new Error(`File must end in ${Array.isArray(suffix) ? suffix.join(' or ') : suffix}`);
  return path.resolve(value);
}
function endpointPath(argv = process.argv.slice(2)) {
  if (!argv.length) return filePath(process.env.VISIKI_AGENT_ENDPOINT_FILE || process.env.ECHO_AGENT_ENDPOINT_FILE || path.join(__dirname, '..', '.demo-data', 'agent-endpoint.json'));
  if (argv.length !== 2 || argv[0] !== '--endpoint-file') throw new Error('Usage: node mcp/server.cjs [--endpoint-file ABSOLUTE_PATH]');
  return filePath(argv[1]);
}
async function readEndpoint(filename) {
  let item;
  try {
    const stat = await fsp.stat(filename);
    if (!stat.isFile() || stat.size > 8192) throw new Error('invalid discovery file');
    item = JSON.parse(await fsp.readFile(filename, 'utf8'));
  } catch { throw new Error('Visiki is unavailable. Start Visiki first, then verify --endpoint-file / VISIKI_AGENT_ENDPOINT_FILE points to its data directory/agent-endpoint.json.'); }
  let url;
  try { url = new URL(item.url); } catch { throw new Error('Invalid Visiki discovery URL'); }
  if (item.version !== 1 || url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/' || typeof item.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(item.token)) throw new Error('Invalid Visiki discovery file: only authenticated numeric-loopback HTTP endpoints are accepted.');
  return { url: url.origin, token: item.token };
}
async function readJson(response, maxBytes = MAX_JSON) {
  const chunks = []; let bytes = 0;
  if (response.body) for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error(`Visiki response exceeds ${maxBytes / 1024 ** 2} MiB`);
    chunks.push(chunk);
  }
  let json;
  try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error(`Visiki returned non-JSON (HTTP ${response.status})`); }
  if (!response.ok) throw new Error(`Visiki HTTP ${response.status}: ${typeof json.error === 'string' ? json.error : json.error?.message || 'request failed'}`);
  return json;
}
function requester(endpoint, signal) {
  return async (route, init = {}, raw = false) => {
    if (!route.startsWith('/api/') || route.includes('\\')) throw new Error('Invalid Visiki API route');
    const target = new URL(route, endpoint.url);
    if (target.origin !== endpoint.url) throw new Error('Cross-origin Visiki request refused');
    const response = await fetch(target, { ...init, redirect: 'error', signal, headers: { Accept: 'application/json', ...init.headers, Authorization: `Bearer ${endpoint.token}` } });
    if (raw && response.ok) return response;
    return readJson(response, route.startsWith('/api/agent/daw/') ? 32 * 1024 * 1024 : MAX_JSON);
  };
}
async function atomicFile(destination, overwrite, writer, signal) {
  const temporary = path.join(path.dirname(destination), `.visiki-agent-${randomUUID()}.tmp`);
  try {
    await writer(temporary);
    signal.throwIfAborted();
    if (overwrite) await fsp.rename(temporary, destination);
    else await fsp.link(temporary, destination);
  } finally { await fsp.unlink(temporary).catch(() => {}); }
}
function textResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }
async function execute(name, args, config, signal) {
  const endpoint = await readEndpoint(config);
  const request = requester(endpoint, signal);
  const command = async (type, data, expectedRevision) => {
    const json = await request('/api/agent/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, ...(data ? { args: data } : {}), ...(expectedRevision !== undefined ? { expectedRevision } : {}) }) });
    if (!isObject(json) || !('result' in json)) throw new Error('Visiki command returned an invalid result');
    return json.result;
  };
  if (name.startsWith('visiki_daw_')) return DAW.execute(name, args, request, signal);
  let result;
  switch (name) {
    case 'visiki_status': result = await request('/api/agent/status'); break;
    case 'visiki_catalog': result = await command('catalog'); break;
    case 'visiki_get_project': {
      const json = await request('/api/agent/project');
      if (!isObject(json) || !('result' in json)) throw new Error('Visiki project returned an invalid result');
      result = json.result; break;
    }
    case 'visiki_edit': result = await command('edit', { operations: args.operations }, args.expectedRevision); break;
    case 'visiki_apply_template': result = await command('apply_template', { id: args.id, ...(args.keepCustomLayers === undefined ? {} : { keepCustomLayers: args.keepCustomLayers }) }, args.expectedRevision); break;
    case 'visiki_open_project': {
      const filename = filePath(args.path, ['.visiki.json', '.echo.json']);
      const stat = await fsp.stat(filename);
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error('Project must be a regular file no larger than 5 MiB');
      const project = JSON.parse(await fsp.readFile(filename, 'utf8'));
      checkTree(project);
      result = await command('replace_project', { project }, args.expectedRevision); break;
    }
    case 'visiki_save_project': {
      const destination = filePath(args.path, ['.visiki.json', '.echo.json']);
      const snapshot = await command('get_project');
      if (!isObject(snapshot?.project)) throw new Error('Visiki did not return a project snapshot');
      await atomicFile(destination, !!args.overwrite, temporary => fsp.writeFile(temporary, `${JSON.stringify(snapshot.project, null, 2)}\n`, { flag: 'wx', signal }), signal);
      result = { path: destination, revision: snapshot.revision }; break;
    }
    case 'visiki_import_media': {
      const filename = filePath(args.path);
      const role = args.role || (args.type === 'audio' ? 'audio' : 'library');
      if ((role === 'audio' && args.type !== 'audio') || (role === 'cover' && args.type !== 'image') || (role === 'library' && args.type === 'audio')) throw new Error('Audio requires role=audio; cover requires type=image; images/videos/fonts may use role=library.');
      const stat = await fsp.stat(filename);
      if (!stat.isFile() || stat.size > 512 * 1024 * 1024 || stat.size === 0) throw new Error('Media must be a non-empty regular file no larger than 512 MiB');
      const form = new FormData(); form.set('file', await fs.openAsBlob(filename), path.basename(filename));
      const asset = await request(`/api/import/${args.type}`, { method: 'POST', body: form });
      try { result = { asset, attachment: await command('edit', { operations: [{ op: 'attach_asset', asset, role }] }, args.expectedRevision) }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'Asset was imported, but attachment failed. Do not upload it again; use visiki_edit with attach_asset and the asset below.', detail: error.message, importedAsset: asset, role }) }] }; }
      break;
    }
    case 'visiki_search_lyrics': result = await request(`/api/lyrics/search?${new URLSearchParams({ q: args.query, provider: 'netease' })}`); break;
    case 'visiki_get_lyrics': {
      const lyrics = await request(`/api/lyrics/song/${encodeURIComponent(args.id)}?provider=netease`);
      if (!args.apply) result = lyrics;
      else {
        if (lyrics.noLyrics || !lyrics.originalLrc && !lyrics.translatedLrc) throw new Error('This song has no available lyrics; project lyrics were not changed.');
        const operation = { op: 'set_lyrics', originalLrc: lyrics.originalLrc || '', translatedLrc: lyrics.translatedLrc || '', source: { provider: 'netease', id: String(lyrics.id), url: lyrics.sourceUrl } };
        if (args.offsetMs !== undefined) operation.offsetMs = args.offsetMs;
        result = { lyrics, application: await command('edit', { operations: [operation] }, args.expectedRevision) };
      }
      break;
    }
    case 'visiki_preview': {
      const preview = await command('preview', args);
      if (preview?.mimeType !== 'image/png' || typeof preview.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(preview.data) || !Buffer.from(preview.data, 'base64').subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Visiki returned invalid PNG preview content');
      const { data, ...metadata } = preview;
      return { content: [{ type: 'image', mimeType: 'image/png', data }, { type: 'text', text: JSON.stringify(metadata) }] };
    }
    case 'visiki_export_start': result = await command('start_export', args); break;
    case 'visiki_export_status': result = await command('get_export', args); break;
    case 'visiki_export_cancel': result = await command('cancel_export', args); break;
    case 'visiki_download_export': {
      const destination = filePath(args.path, '.mp4');
      const job = await command('get_export', { jobId: args.jobId });
      if (job?.state !== 'complete') throw new Error('Export is not complete; use visiki_export_status first.');
      // Controller job ID differs from the encoder ID. Accept only the known local route.
      if (typeof job.downloadUrl !== 'string' || !/^\/api\/export\/[a-zA-Z0-9-]+\/download$/.test(job.downloadUrl)) throw new Error('Visiki returned an invalid export download route');
      const response = await request(job.downloadUrl, {}, true);
      let bytes = 0;
      await atomicFile(destination, !!args.overwrite, async temporary => {
        if (!response.body) throw new Error('Empty export download');
        const counter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; callback(bytes > 8 * 1024 ** 3 ? new Error('Export exceeds 8 GiB transfer limit') : null, chunk); } });
        await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(temporary, { flags: 'wx' }), { signal });
      }, signal);
      result = { path: destination, bytes, jobId: args.jobId }; break;
    }
    case 'visiki_undo': result = await command('undo', undefined, args.expectedRevision); break;
    case 'visiki_redo': result = await command('redo', undefined, args.expectedRevision); break;
    case 'visiki_seek': result = await command('seek', args); break;
    default: throw new Error('Unknown tool');
  }
  return textResult(result);
}

function start(config = endpointPath(), input = process.stdin, output = process.stdout, diagnostic = process.stderr) {
  let initialized = false, ready = false, closed = false, buffer = Buffer.alloc(0), discarding = false;
  const active = new Map();
  const write = value => { if (!closed && !output.destroyed) output.write(`${JSON.stringify(value)}\n`); };
  const rpcError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
  const stop = () => { closed = true; for (const request of active.values()) request.abort(); active.clear(); buffer = Buffer.alloc(0); };
  async function message(line) {
    let message;
    try { message = JSON.parse(line.toString('utf8')); } catch { rpcError(null, -32700, 'Parse error'); return; }
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (message.id !== undefined && !(typeof message.id === 'string' || (typeof message.id === 'number' && Number.isSafeInteger(message.id))))) { rpcError(null, -32600, 'Invalid Request'); return; }
    const { id, method, params } = message;
    if (id === undefined) {
      if (method === 'notifications/initialized' && initialized) ready = true;
      else if (method === 'notifications/cancelled' && isObject(params)) active.get(params.requestId)?.abort();
      return;
    }
    if (method === 'initialize') {
      if (initialized) { rpcError(id, -32600, 'Already initialized'); return; }
      if (!isObject(params) || typeof params.protocolVersion !== 'string' || !isObject(params.capabilities) || !isObject(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') { rpcError(id, -32602, 'Invalid initialize parameters'); return; }
      initialized = true;
      const protocolVersion = VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0];
      write({ jsonrpc: '2.0', id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: serverInfo(protocolVersion), instructions: 'Controls a running local Visiki app. Use visiki_daw_activate to enter the DAW and visiki_daw_catalog to inspect audio editing. Video tools use the separate editor and visiki_catalog. Pass the current expectedRevision to edits and check project or job status after a timeout.' } }); return;
    }
    if (method === 'ping') { write({ jsonrpc: '2.0', id, result: {} }); return; }
    // A dual-era client probes discovery first, then falls back to initialize.
    // We implement the legacy handshake only; never advertise modern versions.
    if (method === 'server/discover') { rpcError(id, -32601, 'Method not found; use the legacy initialize handshake'); return; }
    if (!ready) { rpcError(id, -32002, 'Initialize and send notifications/initialized first'); return; }
    if (method === 'tools/list') {
      if (params !== undefined && (!isObject(params) || Object.keys(params).some(key => key !== '_meta'))) { rpcError(id, -32602, 'Invalid tools/list parameters; all tools are returned without pagination'); return; }
      write({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return;
    }
    if (method !== 'tools/call') { rpcError(id, -32601, 'Method not found'); return; }
    if (!isObject(params) || typeof params.name !== 'string' || (params.arguments !== undefined && !isObject(params.arguments))) { rpcError(id, -32602, 'Invalid tools/call parameters'); return; }
    // Accept cached pre-rename calls without advertising duplicate tools.
    const name = params.name.startsWith('echo_') ? 'visiki_' + params.name.slice(5) : params.name;
    const selected = TOOLS.find(item => item.name === name);
    if (!selected) { rpcError(id, -32602, 'Unknown tool'); return; }
    if (active.has(id)) { rpcError(id, -32600, 'Duplicate active request ID'); return; }
    if (active.size >= 8) { write({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'Too many concurrent calls (maximum 8); wait for a response.' }] } }); return; }
    const controller = new AbortController(); active.set(id, controller);
    const timeoutMs = ['visiki_import_media','visiki_download_export','visiki_daw_import_audio','visiki_daw_download_wav','visiki_daw_preview'].includes(name) ? 600000 : TIMEOUT_MS;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(new Error(`Visiki request exceeded ${timeoutMs / 1000} seconds. Check project/export state before retrying a mutation.`)); }, timeoutMs);
    try {
      const args = params.arguments || {}; validate(selected.inputSchema, args);
      const result = await execute(name, args, config, controller.signal);
      if (!closed && !controller.signal.aborted) write({ jsonrpc: '2.0', id, result });
    } catch (error) {
      if (!closed && (!controller.signal.aborted || timedOut)) write({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: controller.signal.aborted ? controller.signal.reason.message : error.message || 'Visiki operation failed' }] } });
    } finally { clearTimeout(timeout); active.delete(id); }
  }
  input.on('data', chunk => {
    let remaining = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (remaining.length) {
      const newline = remaining.indexOf(10);
      const part = newline < 0 ? remaining : remaining.subarray(0, newline);
      if (!discarding) {
        if (buffer.length + part.length > MAX_LINE) { buffer = Buffer.alloc(0); discarding = true; rpcError(null, -32600, 'Message exceeds 6 MiB'); }
        else buffer = buffer.length ? Buffer.concat([buffer, part]) : Buffer.from(part);
      }
      if (newline < 0) break;
      if (!discarding && buffer.length) void message(buffer).catch(() => { diagnostic.write('Visiki MCP request failed unexpectedly\n'); rpcError(null, -32603, 'Internal error'); });
      buffer = Buffer.alloc(0); discarding = false; remaining = remaining.subarray(newline + 1);
    }
  });
  input.on('end', stop); input.on('error', stop); output.on('error', stop);
  return { stop };
}
module.exports = { TOOLS, VERSIONS, MAX_LINE, validate, readEndpoint, start };
if (require.main === module) {
  try { start(); } catch (error) { process.stderr.write(`Visiki MCP: ${error.message}\n`); process.exitCode = 1; }
}
