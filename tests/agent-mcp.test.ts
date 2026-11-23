import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

const executable = process.execPath;
const script = path.resolve(process.cwd(), 'mcp/server.cjs');
const token = 'a'.repeat(64);
type Json = Record<string, any>;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class Client {
  child: ChildProcessWithoutNullStreams;
  messages: Json[] = [];
  stderr = '';
  malformed: string[] = [];
  nextId = 1;
  constructor(endpoint: string, args: string[] = ['--endpoint-file', endpoint]) {
    this.child = spawn(executable, [script, ...args], { windowsHide: true, env: { ...process.env, VISIKI_AGENT_ENDPOINT_FILE: endpoint, ELECTRON_RUN_AS_NODE: '1' } });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => { try { this.messages.push(JSON.parse(line)); } catch { this.malformed.push(line); } });
    this.child.stderr.on('data', chunk => { this.stderr += chunk.toString(); });
  }
  send(value: Json) { this.child.stdin.write(`${JSON.stringify(value)}\n`); }
  async response(id: string | number | null, after = 0, timeout = 10000): Promise<Json> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = this.messages.slice(after).find(item => item.id === id);
      if (result) return result;
      if (this.child.exitCode !== null) throw new Error(`MCP exited: ${this.stderr}`);
      await delay(10);
    }
    throw new Error(`No MCP response for ${id}: ${this.stderr}`);
  }
  async request(method: string, params?: Json): Promise<Json> {
    const id = this.nextId++; this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    return this.response(id);
  }
  async initialize(protocolVersion = '2025-11-25') {
    const response = await this.request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'echo-test', version: '1' } });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return response;
  }
  call(name: string, args: Json = {}) { return this.request('tools/call', { name, arguments: args }); }
  async stop() {
    if (this.child.exitCode === null) {
      const exit = once(this.child, 'exit');
      this.child.stdin.end();
      const timer = setTimeout(() => this.child.kill(), 3000);
      try { await exit; } finally { clearTimeout(timer); }
    }
    assert.deepEqual(this.malformed, [], 'stdout must contain JSON-RPC only');
  }
}
async function fixture(handler?: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-mcp-test-'));
  const endpoint = path.join(directory, 'agent-endpoint.json');
  const requests: { url: string; auth: string; body: Buffer }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ url: req.url!, auth: req.headers.authorization || '', body });
    res.setHeader('Content-Type', 'application/json');
    if (handler) { handler(req, res, body); return; }
    if (req.url === '/api/agent/status') res.end(JSON.stringify({ editorReady: true }));
    else res.end(JSON.stringify({ id: 'request', result: { ok: true } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  await fs.writeFile(endpoint, JSON.stringify({ url, token, pid: process.pid, version: 1 }));
  const client = new Client(endpoint); await client.initialize();
  return { directory, endpoint, url, requests, server, client, async stop() { await client.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); } };
}
function text(response: Json) { return JSON.parse(response.result.content[0].text); }

test('MCP initializes without Visiki, negotiates supported versions and lists legacy and DAW tools offline', async () => {
  const missing = path.join(os.tmpdir(), 'echo-mcp-missing-discovery.json');
  for (const version of ['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2099-01-01']) {
    const client = new Client(missing, []);
    try {
      const init = await client.initialize(version);
      assert.equal(init.result.serverInfo.name, 'visiki-editor');
      if (init.result.protocolVersion === '2025-11-25') {
        const [icon] = init.result.serverInfo.icons;
        assert.equal(icon.mimeType, 'image/png');
        assert.deepEqual(icon.sizes, ['64x64']);
        const bytes = Buffer.from(icon.src.slice('data:image/png;base64,'.length), 'base64');
        assert.deepEqual(bytes, await fs.readFile(path.resolve('mcp/assets/visiki-64.png')));
        assert.equal(bytes.readUInt32BE(16), 64);
        assert.equal(bytes.readUInt32BE(20), 64);
      } else assert.equal(init.result.serverInfo.icons, undefined);
      assert.equal(init.result.protocolVersion, version === '2099-01-01' ? '2025-11-25' : version);
      assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
      const list = await client.request('tools/list');
      const names = list.result.tools.map((item: Json) => item.name);
      assert.equal(new Set(names).size, names.length);
      for (const name of ['visiki_status', 'visiki_edit', 'visiki_preview', 'visiki_download_export', 'visiki_daw_status', 'visiki_daw_edit', 'visiki_daw_preview', 'visiki_daw_download_wav']) assert(names.includes(name), name);
      assert(list.result.tools.every((item: Json) => item.name.startsWith('visiki_')));
      assert.equal((await client.call('visiki_status')).result.isError, true);
      assert.match((await client.call('visiki_status')).result.content[0].text, /Start Visiki first/);
      assert.equal(client.stderr, '');
    } finally { await client.stop(); }
  }
});

test('pre-rename MCP calls remain aliases of Visiki tools without duplicate tool listings', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(text(await f.client.call('echo_status')), text(await f.client.call('visiki_status')));
    const invalid = await f.client.call('echo_seek', { time: -1 });
    assert.equal(invalid.result.isError, true);
    assert.equal((await f.client.call('echo_unknown')).error.code, -32602);
    const project = { format: 'echo-demo', version: 1, title: '旧格式' };
    const oldFile = path.join(f.directory, 'legacy.echo.json');
    await fs.writeFile(oldFile, JSON.stringify(project));
    assert.equal((await f.client.call('echo_open_project', { path: oldFile })).result.isError, undefined);
    const replacement = JSON.parse(f.requests.at(-1)!.body.toString());
    assert.equal(replacement.type, 'replace_project');
    assert.deepEqual(replacement.args.project, project);
  } finally { await f.stop(); }
});

test('MCP separates JSON-RPC protocol errors from execution/argument errors and enforces lifecycle', async () => {
  const client = new Client(path.join(os.tmpdir(), 'missing-echo-endpoint.json'));
  try {
    assert.equal((await client.request('tools/list')).error.code, -32002);
    client.child.stdin.write('{broken}\n');
    assert.equal((await client.response(null)).error.code, -32700);
    const before = client.messages.length; client.child.stdin.write('[]\n');
    assert.equal((await client.response(null, before)).error.code, -32600);
    assert.equal((await client.request('initialize', {})).error.code, -32602);
    await client.initialize();
    assert.equal((await client.request('initialize', {})).error.code, -32600);
    assert.equal((await client.request('unrecognized')).error.code, -32601);
    assert.equal((await client.request('tools/list', { cursor: 'invalid' })).error.code, -32602);
    assert.equal((await client.request('tools/call', { name: 'visiki_status', arguments: [] as any })).error.code, -32602);
    assert.equal((await client.call('bad_tool')).error.code, -32602);
    for (const [name, args] of [ ['visiki_seek', { time: -1 }], ['visiki_seek', { time: '1' }], ['visiki_edit', { operations: [] }], ['visiki_edit', { operations: [{ op: 'eval', source: 'foo' }] }], ['visiki_status', { bad: true }], ['visiki_export_start', { fps: 12 }], ['visiki_preview', { width: 3840 }] ] as [string, Json][]) {
      const response = await client.call(name, args); assert.equal(response.result.isError, true, name);
    }
    assert.deepEqual((await client.request('ping')).result, {});
  } finally { await client.stop(); }
});

test('modern discovery probes return Method not found and allow legacy initialize fallback', async () => {
  const client = new Client(path.join(os.tmpdir(), 'echo-mcp-fallback-offline.json'));
  try {
    const probe = await client.request('server/discover', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } });
    assert.equal(probe.error.code, -32601);
    assert.equal((await client.initialize()).result.protocolVersion, '2025-11-25');
    const names = (await client.request('tools/list')).result.tools.map((item: Json) => item.name);
    assert(names.includes('visiki_status')); assert(names.includes('visiki_daw_status'));
    assert.equal((await client.request('server/discover')).error.code, -32601);
  } finally { await client.stop(); }
});

test('MCP authenticates every request, reloads discovery after restart, rejects remote URLs and redirects', async () => {
  const f = await fixture((req, res) => {
    if (req.url === '/api/agent/status' && req.headers.authorization === `Bearer ${'b'.repeat(64)}`) { res.statusCode = 503; res.end(JSON.stringify({ error: 'Editor disconnected' })); }
    else { res.statusCode = 302; res.setHeader('Location', 'http://example.invalid/exfiltrate'); res.end('{}'); }
  });
  try {
    assert.equal((await f.client.call('visiki_status')).result.isError, true);
    assert.equal(f.requests[0].auth, `Bearer ${token}`);
    await fs.writeFile(f.endpoint, JSON.stringify({ url: f.url, token: 'b'.repeat(64), version: 1 }));
    const failed = await f.client.call('visiki_status');
    assert.match(failed.result.content[0].text, /503.*Editor disconnected/);
    assert.equal(f.requests[1].auth, `Bearer ${'b'.repeat(64)}`);
    for (const url of ['https://127.0.0.1:1234', 'http://localhost:1234', 'http://192.168.0.1:1234', 'file:///tmp/secret', `${f.url}/other`, `${f.url}?token=x`, `http://user:pass@127.0.0.1:1234`]) {
      await fs.writeFile(f.endpoint, JSON.stringify({ url, token, version: 1 }));
      const response = await f.client.call('visiki_status'); assert.equal(response.result.isError, true); assert.match(response.result.content[0].text, /Invalid Visiki/);
    }
    assert.equal(f.requests.length, 2, 'invalid endpoints must never reach the network');
  } finally { await f.stop(); }
});

test('MCP forwards revision, atomic edits, templates, seek/undo/redo, preview and export controls correctly', async () => {
  const project = { format: 'echo-demo', version: 1, title: '测试工程' };
  const commands: Json[] = [];
  const f = await fixture((req, res, body) => {
    if (req.url === '/api/agent/project') res.end(JSON.stringify({ id: 'p', result: { project, revision: 7 } }));
    else {
      const command = JSON.parse(body.toString()); commands.push(command);
      const result = command.type === 'preview' ? { mimeType: 'image/png', data: png, width: 1, height: 1, time: 0, revision: 7 } : { ok: true, type: command.type, jobId: 'controller-job' };
      res.end(JSON.stringify({ id: 'c', result }));
    }
  });
  try {
    assert.equal(text(await f.client.call('visiki_get_project')).project.title, '测试工程');
    await f.client.call('visiki_edit', { expectedRevision: 7, operations: [{ op: 'update_project', changes: { title: '新标题' } }] });
    assert.deepEqual(commands.at(-1), { type: 'edit', expectedRevision: 7, args: { operations: [{ op: 'update_project', changes: { title: '新标题' } }] } });
    await f.client.call('visiki_apply_template', { id: 'paper-poem', keepCustomLayers: false });
    assert.equal(commands.at(-1)!.type, 'apply_template');
    await f.client.call('visiki_seek', { time: 1.5, playing: false }); assert.equal(commands.at(-1)!.args.time, 1.5);
    await f.client.call('visiki_undo', { expectedRevision: 8 }); assert.equal(commands.at(-1)!.type, 'undo');
    await f.client.call('visiki_redo'); assert.equal(commands.at(-1)!.type, 'redo');
    await f.client.call('visiki_catalog'); assert.equal(commands.at(-1)!.type, 'catalog');
    const preview = await f.client.call('visiki_preview', { time: 0, width: 960, height: 540 });
    assert.equal(preview.result.content[0].type, 'image'); assert.equal(preview.result.content[0].data, png);
    assert.equal(text(await f.client.call('visiki_export_start', { width: 1280, height: 720, fps: 24 })).jobId, 'controller-job');
    await f.client.call('visiki_export_status', { jobId: 'controller-job' }); assert.equal(commands.at(-1)!.type, 'get_export');
    await f.client.call('visiki_export_cancel', { jobId: 'controller-job' }); assert.equal(commands.at(-1)!.type, 'cancel_export');
    assert.ok(f.requests.every(item => item.auth === `Bearer ${token}`));
  } finally { await f.stop(); }
});

test('MCP imports Unicode filenames, attaches font/media, and reports partial import without reupload', async () => {
  let failAttachment = true; let imports = 0; const edits: Json[] = [];
  const asset = { id: 'imported-asset', name: '中文 日本語.wav', type: 'audio', url: '/api/assets/imported-asset' };
  const f = await fixture((req, res, body) => {
    if (req.url!.startsWith('/api/import/')) { imports++; assert.ok(body.includes(Buffer.from('中文 日本語.wav'))); res.end(JSON.stringify(asset)); }
    else {
      const command = JSON.parse(body.toString()); edits.push(command);
      if (failAttachment) { res.statusCode = 409; res.end(JSON.stringify({ error: 'revision conflict' })); }
      else res.end(JSON.stringify({ id: 'edit', result: { revision: 3 } }));
    }
  });
  try {
    const filename = path.join(f.directory, asset.name); await fs.writeFile(filename, 'test fixture');
    const partial = await f.client.call('visiki_import_media', { path: filename, type: 'audio', expectedRevision: 1 });
    assert.equal(partial.result.isError, true); assert.equal(text(partial).importedAsset.id, asset.id); assert.match(text(partial).error, /Do not upload it again/);
    failAttachment = false;
    await f.client.call('visiki_edit', { operations: [{ op: 'attach_asset', asset: text(partial).importedAsset, role: 'audio' }] });
    assert.equal(imports, 1); assert.equal(edits.at(-1)!.args.operations[0].role, 'audio');
    assert.equal((await f.client.call('visiki_import_media', { path: filename, type: 'video', role: 'cover' })).result.isError, true);
    assert.equal(imports, 1);
    const font = await f.client.call('visiki_import_media', { path: filename, type: 'font', role: 'library' });
    assert.equal(font.result.isError, undefined); assert.equal(edits.at(-1)!.args.operations[0].role, 'library');
  } finally { await f.stop(); }
});

test('MCP project save/open and export download use atomic files, default non-overwrite and validated encoder URL', async () => {
  const project = { format: 'echo-demo', version: 1, title: '保存工程' }; let badDownload = false; const commands: Json[] = [];
  const f = await fixture((req, res, body) => {
    if (req.url === '/api/export/encoder-job/download') { res.setHeader('Content-Type', 'video/mp4'); res.end(Buffer.from('fake-mp4')); return; }
    const command = JSON.parse(body.toString()); commands.push(command);
    res.end(JSON.stringify({ id: 'ok', result: command.type === 'get_export' ? { state: 'complete', downloadUrl: badDownload ? 'http://example.invalid/file' : '/api/export/encoder-job/download' } : { project, revision: 4 } }));
  });
  try {
    const filename = path.join(f.directory, '工程.visiki.json');
    assert.equal((await f.client.call('visiki_save_project', { path: filename })).result.isError, undefined);
    assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).title, project.title);
    await fs.writeFile(filename, 'original');
    assert.equal((await f.client.call('visiki_save_project', { path: filename })).result.isError, true);
    assert.equal(await fs.readFile(filename, 'utf8'), 'original');
    assert.equal((await f.client.call('visiki_save_project', { path: filename, overwrite: true })).result.isError, undefined);
    await f.client.call('visiki_open_project', { path: filename, expectedRevision: 4 });
    assert.equal(commands.at(-1)!.type, 'replace_project'); assert.deepEqual(commands.at(-1)!.args.project, project);
    const movie = path.join(f.directory, '视频.mp4');
    assert.equal(text(await f.client.call('visiki_download_export', { jobId: 'controller-job', path: movie })).bytes, 8);
    assert.equal(await fs.readFile(movie, 'utf8'), 'fake-mp4');
    assert.equal((await f.client.call('visiki_download_export', { jobId: 'controller-job', path: movie })).result.isError, true);
    badDownload = true;
    assert.match((await f.client.call('visiki_download_export', { jobId: 'controller-job', path: movie, overwrite: true })).result.content[0].text, /invalid export download route/);
    assert.equal(await fs.readFile(movie, 'utf8'), 'fake-mp4');
    for (const filename of ['relative.visiki.json', 'https://example.invalid/test.visiki.json', '\\\\server\\share\\test.visiki.json']) assert.equal((await f.client.call('visiki_open_project', { path: filename })).result.isError, true);
    assert.equal((await fs.readdir(f.directory)).filter(name => name.endsWith('.tmp')).length, 0, 'failed writes must remove temporary files');
  } finally { await f.stop(); }
});

test('MCP lyric search preserves Unicode query and applies LRC through shared parser with source', async () => {
  const commands: Json[] = [];
  const f = await fixture((req, res, body) => {
    if (req.url!.startsWith('/api/lyrics/search')) { assert.equal(new URL(req.url!, 'http://localhost').searchParams.get('q'), '歌名 日本語'); res.end('[]'); }
    else if (req.url!.startsWith('/api/lyrics/song')) res.end(JSON.stringify({ id: '123', originalLrc: '[00:01]原文', translatedLrc: '[00:01]译文', sourceUrl: 'https://music.163.com/song?id=123' }));
    else { commands.push(JSON.parse(body.toString())); res.end(JSON.stringify({ id: 'ok', result: { revision: 9 } })); }
  });
  try {
    assert.deepEqual(text(await f.client.call('visiki_search_lyrics', { query: '歌名 日本語' })), []);
    const fetched = await f.client.call('visiki_get_lyrics', { id: '123' }); assert.match(text(fetched).originalLrc, /原文/); assert.equal(commands.length, 0);
    await f.client.call('visiki_get_lyrics', { id: '123', apply: true, offsetMs: 500, expectedRevision: 8 });
    const command = commands[0]; assert.equal(command.expectedRevision, 8);
    assert.deepEqual(command.args.operations, [{ op: 'set_lyrics', originalLrc: '[00:01]原文', translatedLrc: '[00:01]译文', offsetMs: 500, source: { provider: 'netease', id: '123', url: 'https://music.163.com/song?id=123' } }]);
  } finally { await f.stop(); }
});

test('MCP cancels in-flight requests without a response, aborts on EOF and bounds oversized lines', async () => {
  let started = 0, disconnected = 0;
  const f = await fixture((_req, res) => { started++; res.on('close', () => { disconnected++; }); });
  try {
    const id = f.client.nextId++; f.client.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'visiki_status', arguments: {} } });
    while (!started) await delay(10);
    f.client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
    await delay(100); assert.equal(f.client.messages.some(item => item.id === id), false); assert.equal(disconnected, 1);
    const before = f.client.messages.length;
    f.client.child.stdin.write(`${'x'.repeat(6 * 1024 * 1024 + 1)}\n`);
    assert.match((await f.client.response(null, before)).error.message, /exceeds 6 MiB/);
    assert.deepEqual((await f.client.request('ping')).result, {});
    f.client.send({ jsonrpc: '2.0', id: f.client.nextId++, method: 'tools/call', params: { name: 'visiki_status' } });
    while (started < 2) await delay(10);
    await f.client.stop(); await delay(100); assert.equal(disconnected, 2);
  } finally { await f.stop(); }
});

test('MCP CLI diagnostics use stderr only for invalid startup arguments', async () => {
  const client = new Client(path.join(os.tmpdir(), 'absent.json'), ['--unsupported']);
  try {
    await once(client.child, 'exit'); assert.equal(client.child.exitCode, 1); assert.match(client.stderr, /Usage:/); assert.equal(client.messages.length, 0);
  } finally { await client.stop(); }
});


test('DAW MCP routes commands, validates schemas, and atomically saves snapshots', async () => {
  const session = { id: 'session-one', tracks: [] };
  const f = await fixture((req, res, body) => {
    if (req.url === '/api/agent/daw/status') { res.end(JSON.stringify({ editorReady: true })); return; }
    const input = JSON.parse(body.toString());
    res.end(JSON.stringify({ result: input.type === 'get_session' ? { session, revision: 9 } : { received: input } }));
  });
  try {
    assert.equal(text(await f.client.call('visiki_daw_status')).editorReady, true);
    const edit = text(await f.client.call('visiki_daw_edit', { operations: [{ op: 'add_track' }, { op: 'add_clip', trackId: '$0.trackId' }], expectedRevision: 9 }));
    assert.equal(edit.received.expectedRevision, 9); assert.equal(edit.received.args.operations[1].trackId, '$0.trackId');
    const mixRoles = { lead: 'lead', backing: 'instrumental' };
    for (const harmony of [undefined, '', null]) {
      const roles = harmony === undefined ? mixRoles : { ...mixRoles, harmony };
      const job = text(await f.client.call('visiki_daw_job_start', { kind: 'auto_mix', options: { roles }, expectedRevision: 9 }));
      assert.deepEqual(job.received.args.options.roles, roles);
    }
    assert.equal((await f.client.call('visiki_daw_job_start', {
      kind: 'auto_mix', options: { roles: { ...mixRoles, harmony: false } },
    })).result.isError, true);
    const source = path.join(f.directory, 'source.visiki-daw.json'); await fs.writeFile(source, JSON.stringify(session));
    const opened = text(await f.client.call('visiki_daw_open_session', { path: source, expectedRevision: 9 }));
    assert.equal(opened.received.type, 'replace_session'); assert.deepEqual(opened.received.args.session, session);
    const destination = path.join(f.directory, 'session.visiki-daw.json');
    assert.equal(text(await f.client.call('visiki_daw_save_session', { path: destination })).revision, 9);
    assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), session);
    assert.equal((await f.client.call('visiki_daw_save_session', { path: destination })).result.isError, true);
    assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), session);
    const n = f.requests.length;
    for (const args of [{ selection: { trackId: 'x', bad: true } }, { preferences: { gridDivision: 16 } }, { zoom: -1 }]) assert.equal((await f.client.call('visiki_daw_view', args)).result.isError, true);
    assert.equal(f.requests.length, n);
    assert.equal((await f.client.call('visiki_daw_view', { selection: null, preferences: { rulerUnit: 'bars', gridDivision: '1/16' } })).result.isError, undefined);
  } finally { await f.stop(); }
});

test('DAW VST3 MCP discovery, scanning, catalog and edits use generic authenticated routes', async () => {
  const f = await fixture((req, res, body) => {
    if (req.url === '/api/daw/vst3/scan') {
      assert.equal(req.method, 'POST');
      res.end(JSON.stringify({ scanning: true })); return;
    }
    assert.equal(req.url, '/api/agent/daw/commands');
    res.end(JSON.stringify({ result: { received: JSON.parse(body.toString()) } }));
  });
  try {
    const tools = (await f.client.request('tools/list')).result.tools;
    const catalog = tools.find((item: Json) => item.name === 'visiki_daw_catalog');
    const scan = tools.find((item: Json) => item.name === 'visiki_daw_scan_vst3');
    const edit = tools.find((item: Json) => item.name === 'visiki_daw_edit');
    assert.ok(catalog && scan && edit);
    assert.equal(catalog.inputSchema.properties.limit.maximum, 128);
    assert.match(edit.description, /add_vst3/);
    assert.match(edit.description, /vst3Params/);
    const args = { vst3: true, classId: 'A'.repeat(32), effectId: 'fx1', query: '滤波', offset: 3, limit: 128, includeChoices: true };
    assert.deepEqual(text(await f.client.call('visiki_daw_catalog', args)).received, { type: 'catalog', args });
    assert.deepEqual(text(await f.client.call('visiki_daw_catalog', { effectType: 'eq' })).received, { type: 'catalog', args: { effectType: 'eq' } });
    assert.equal(text(await f.client.call('visiki_daw_scan_vst3', { force: true })).scanning, true);
    assert.equal(f.requests.at(-1)!.url, '/api/daw/vst3/scan');
    assert.deepEqual(JSON.parse(f.requests.at(-1)!.body.toString()), { force: true, background: true });
    await f.client.call('visiki_daw_scan_vst3');
    assert.deepEqual(JSON.parse(f.requests.at(-1)!.body.toString()), { background: true });
    const operations = [
      { op: 'add_vst3', target: 'track1', classId: 'A'.repeat(32), index: 0, name: 'Plugin', enabled: true, params: { '2': 0.5 }, vst3Params: [{ paramId: 3, format: 'text', value: '1 kHz' }] },
      { op: 'update_effect', target: 'track1', effectId: '$0.effectId', vst3Params: [{ paramId: 4, format: 'choice', value: 'High' }, { paramId: 5, format: 'plain', value: 12, unit: 'dB' }, { paramId: 6, format: 'normalized', value: 0.25 }] }
    ];
    assert.deepEqual(text(await f.client.call('visiki_daw_edit', { operations, expectedRevision: 7 })).received, { type: 'edit', args: { operations }, expectedRevision: 7 });
    const count = f.requests.length;
    for (const invalid of [{ limit: 129 }, { limit: 0 }, { offset: -1 }, { offset: 0.5 }, { includeChoices: 'yes' }]) {
      assert.equal((await f.client.call('visiki_daw_catalog', invalid)).result.isError, true);
    }
    assert.equal((await f.client.call('visiki_daw_scan_vst3', { path: 'C:\\plugins' })).result.isError, true);
    assert.equal(f.requests.length, count);
    assert.ok(f.requests.every(item => item.auth === `Bearer ${token}`));
  } finally { await f.stop(); }
});

test('DAW preview and download stream WAV from fixed routes and reject unsafe paths and invalid bytes', async () => {
  const renderId = '01234567-89ab-cdef-0123-456789abcdef';
  const wav = Buffer.from('524946462400000057415645666d7420', 'hex');
  let bad = false;
  const f = await fixture((req, res, body) => {
    if (req.url === '/api/daw/auto-mix/preview' || req.url === `/api/daw/renders/${renderId}`) {
      res.setHeader('X-Visiki-LUFS', '-14'); res.setHeader('X-Visiki-True-Peak', '-1'); res.end(bad ? Buffer.from('not wav data') : wav); return;
    }
    const input = JSON.parse(body.toString());
    const result = input.type === 'preview_source' ? { session: { id: 's' }, range: { start: 1, end: 2 }, revision: 3, preview: true } : { state: 'complete', kind: 'render', result: { id: renderId } };
    res.end(JSON.stringify({ result }));
  });
  try {
    const preview = await f.client.call('visiki_daw_preview', { start: 1, end: 2, reference: { kind: 'asset', id: 'asset1' } });
    assert.equal(preview.result.content[0].mimeType, 'audio/wav'); assert.deepEqual(Buffer.from(preview.result.content[0].data, 'base64'), wav);
    assert.equal(JSON.parse(preview.result.content[1].text).lufs, -14);
    assert.deepEqual(JSON.parse(f.requests[0].body.toString()).args.reference, { kind: 'asset', id: 'asset1' });
    assert.equal(JSON.parse(f.requests[1].body.toString()).preview, true);
    const dest = path.join(f.directory, 'mix.wav');
    assert.equal(text(await f.client.call('visiki_daw_download_wav', { jobId: 'job', path: dest })).renderId, renderId);
    assert.deepEqual(await fs.readFile(dest), wav);
    assert.equal((await f.client.call('visiki_daw_download_wav', { renderId: '../bad', path: dest })).result.isError, true);
    bad = true;
    assert.equal((await f.client.call('visiki_daw_download_wav', { renderId, path: dest, overwrite: true })).result.isError, true);
    assert.deepEqual(await fs.readFile(dest), wav);
    assert.equal((await f.client.call('visiki_daw_preview', { start: 0, end: 1, reference: { kind: 'clip', id: 'c' }, variant: 'full' })).result.isError, true);
  } finally { await f.stop(); }
});


test('DAW import preserves registered asset when attachment conflicts', async () => {
  const f = await fixture((req, res, body) => {
    if (req.url === '/api/daw/assets?summary=1') { res.end(JSON.stringify({ id: 'asset1', name: 'input.wav' })); return; }
    const input = JSON.parse(body.toString()); assert.equal(input.type, 'attach_asset'); assert.equal(input.args.placement, 'existing_track');
    res.statusCode = 409; res.end(JSON.stringify({ error: 'revision conflict' }));
  });
  try {
    const source = path.join(f.directory, 'input.wav'); await fs.writeFile(source, Buffer.from('sound'));
    const failed = await f.client.call('visiki_daw_import_audio', { path: source, trackId: 'track1', expectedRevision: 1 });
    assert.equal(failed.result.isError, true);
    const detail = JSON.parse(failed.result.content[0].text); assert.equal(detail.importedAsset.id, 'asset1'); assert.match(detail.detail, /revision conflict/);
    assert.equal(f.requests.filter(item => item.url === '/api/daw/assets?summary=1').length, 1);
  } finally { await f.stop(); }
});

test('DAW cancellation removes a partial download and never replaces an existing destination', async () => {
  const renderId = '01234567-89ab-cdef-0123-456789abcdef';
  const f = await fixture((req, res) => {
    if (req.url === `/api/daw/renders/${renderId}`) { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.write(Buffer.from('524946462400000057415645666d7420', 'hex')); return; }
    res.end('{}');
  });
  try {
    const dest = path.join(f.directory, 'cancel.wav'); await fs.writeFile(dest, 'original');
    const id = f.client.nextId++; f.client.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'visiki_daw_download_wav', arguments: { renderId, path: dest, overwrite: true } } });
    for (let i = 0; i < 100 && !f.requests.length; i++) await delay(10);
    assert(f.requests.length); f.client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
    for (let i = 0; i < 100 && (await fs.readdir(f.directory)).some(name => name.startsWith('.visiki-agent-')); i++) await delay(10);
    assert.equal(await fs.readFile(dest, 'utf8'), 'original');
    assert(!(await fs.readdir(f.directory)).some(name => name.startsWith('.visiki-agent-')));
    assert(!f.client.messages.some(message => message.id === id));
  } finally { await f.stop(); }
});
