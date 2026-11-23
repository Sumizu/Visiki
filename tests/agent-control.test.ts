import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer, request as httpRequest } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installAgentControl } from '../server/agent-control';

type Reply = { status: number; body: any };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function harness(t: any, timings = { leaseMs: 5_000, commandMs: 2_000, pollMs: 35 }, root?: string) {
  const directory = root ?? await fs.mkdtemp(path.join(os.tmpdir(), 'echo-agent-http-'));
  const app = express(); app.use(express.json({ limit: '5mb' }));
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const control = installAgentControl(app, { port: address.port, dataRoot: directory, timings });
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 400).json({ error: error.message, code: 'INVALID_JSON' });
  });
  await control.initialize();
  const file = path.join(directory, 'agent-endpoint.json');
  const endpoint = JSON.parse(await fs.readFile(file, 'utf8'));
  let sessionId = '';
  const auth = () => ({ Authorization: `Bearer ${endpoint.token}` });
  const editor = () => ({ ...auth(), 'X-Visiki-Editor-Session': sessionId });
  async function request(route: string, body?: unknown, headers: Record<string, string> = auth(), signal?: AbortSignal): Promise<Reply> {
    const response = await fetch(`${url}/api/agent${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal });
    return { status: response.status, body: await response.json() };
  }
  async function register(headers: Record<string, string> = { Origin: url, 'X-Visiki-Editor': '1' }) {
    const reply = await request('/editor/register', {}, headers);
    if (reply.status === 200) sessionId = reply.body.sessionId;
    return reply;
  }
  async function rawRequest(route: string, headers: Record<string, string>): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(`${url}/api/agent${route}`, { headers }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
        incoming.on('end', () => resolve({ status: incoming.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
        incoming.on('error', reject);
      });
      outgoing.on('error', reject); outgoing.end();
    });
  }
  async function queued(count: number) {
    for (let i = 0; i < 100; i++) {
      if ((await request('/status')).body.pendingCommands === count) return;
      await delay(5);
    }
    assert.fail(`Expected ${count} queued commands`);
  }
  t.after(async () => {
    control.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (!root) await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, file, endpoint, url, control, request, rawRequest, register, queued, auth, editor };
}

test('agent discovery rotates secrets and an old instance cannot delete another endpoint', async t => {
  const first = await harness(t);
  assert.equal(first.endpoint.version, 1); assert.equal(first.endpoint.pid, process.pid);
  assert.equal(first.endpoint.url, first.url); assert.match(first.endpoint.token, /^[\w-]{43}$/);
  const second = await harness(t, undefined, first.directory);
  assert.notEqual(first.endpoint.token, second.endpoint.token);
  first.control.close();
  assert.equal(JSON.parse(await fs.readFile(first.file, 'utf8')).token, second.endpoint.token);
  second.control.close();
  await assert.rejects(fs.access(first.file));
});

test('agent routes require exact loopback Host, same Origin and a bearer token', async t => {
  const h = await harness(t);
  assert.equal((await h.request('/status', undefined, {})).status, 401);
  assert.equal((await h.request(`/status?token=${h.endpoint.token}`, undefined, {})).status, 401);
  assert.equal((await h.request('/status', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await h.request('/status', undefined, { ...h.auth(), Origin: 'https://example.com' })).status, 403);
  assert.equal((await h.rawRequest('/status', { ...h.auth(), Host: 'example.com' })).status, 403);
  assert.equal((await h.rawRequest('/status', { ...h.auth(), Host: '127.0.0.1:9' })).status, 403);
  assert.equal((await h.request('/status')).status, 200);
});

test('only the same-origin editor bootstrap can claim the single editor lease', async t => {
  const h = await harness(t);
  const blockedHeaders: Record<string, string>[] = [{ Origin: h.url }, { 'X-Visiki-Editor': '1' },
    { Origin: 'http://127.0.0.1:5173', 'X-Visiki-Editor': '1' },
    { Origin: h.url, 'X-Visiki-Editor': '1', 'Sec-Fetch-Site': 'cross-site' }];
  for (const headers of blockedHeaders) {
    assert.equal((await h.request('/editor/register', {}, headers)).status, 403);
  }
  const initial = await h.register({ 'X-Visiki-Editor': '1', 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(initial.status, 200); assert.equal(initial.body.token, h.endpoint.token);
  assert.equal((await h.register()).status, 409);
  assert.equal((await h.request('/editor/next', undefined, { ...h.auth(), 'X-Visiki-Editor-Session': 'wrong' })).status, 409);
  assert.equal((await h.request('/editor/release', {}, h.editor())).status, 200);
  const next = await h.register(); assert.equal(next.status, 200); assert.notEqual(next.body.sessionId, initial.body.sessionId);
});

test('status is available without an editor and command APIs explain that the editor is not ready', async t => {
  const h = await harness(t);
  assert.deepEqual((await h.request('/status')).body, { version: 1, editorReady: false, editorBusy: false, pendingCommands: 0 });
  for (const response of [await h.request('/project'), await h.request('/commands', { type: 'preview' })]) {
    assert.equal(response.status, 503); assert.equal(response.body.code, 'EDITOR_NOT_READY');
  }
});

test('DAW commands use a separate authenticated editor lease and preserve the video channel', async t => {
  const h = await harness(t, { leaseMs: 5_000, commandMs: 2_000, pollMs: 500 });
  assert.equal((await h.request('/daw/status', undefined, {})).status, 401);
  assert.equal((await h.request('/daw/status')).body.editorReady, false);
  await h.register();
  const daw = await h.request('/daw/editor/register', {}, { Origin: h.url, 'X-Visiki-Editor': '1' });
  assert.equal(daw.status, 200);
  assert.notEqual(daw.body.sessionId, h.editor()['X-Visiki-Editor-Session']);
  const dawHeaders = { ...h.auth(), 'X-Visiki-Editor-Session': daw.body.sessionId };
  assert.equal((await h.request('/daw/editor/next', undefined, h.editor())).status, 409);
  assert.equal((await h.request('/commands', { type: 'get_session' })).status, 400);
  assert.equal((await h.request('/daw/commands', { type: 'get_project' })).status, 400);
  const poll = h.request('/daw/editor/next', undefined, dawHeaders);
  const request = h.request('/daw/commands', { type: 'edit', expectedRevision: 10, args: { operations: [{ op: 'add_track' }] } });
  const pending = (await poll).body.command;
  assert.equal(pending.expectedRevision, 10);
  assert.equal((await h.request('/status')).body.pendingCommands, 0);
  await h.request('/daw/editor/result', { id: pending.id, result: { revision: 11 } }, dawHeaders);
  assert.equal((await request).body.result.revision, 11);
  await h.request('/daw/editor/release', {}, dawHeaders);
  assert.equal((await h.request('/daw/status')).body.editorReady, false);
  assert.equal((await h.request('/status')).body.editorReady, true);
});

test('commands use one delivery, retain revision and args, and GET project shares the transport', async t => {
  const h = await harness(t); await h.register();
  const commandResponse = h.request('/commands', { type: 'edit', args: { operations: [{ op: 'test' }] }, expectedRevision: 7 });
  await h.queued(1);
  const poll = await h.request('/editor/next', undefined, h.editor());
  assert.equal(poll.status, 200);
  const command = poll.body.command;
  assert.equal(command.type, 'edit'); assert.deepEqual(command.args, { operations: [{ op: 'test' }] });
  assert.equal(command.expectedRevision, 7); assert(command.deadline > Date.now());
  assert.equal((await h.request('/editor/next', undefined, h.editor())).status, 409);
  assert.equal((await h.request('/editor/result', { id: command.id, result: { revision: 8 } }, h.editor())).status, 200);
  assert.deepEqual((await commandResponse).body, { id: command.id, result: { revision: 8 } });
  assert.equal((await h.request('/editor/result', { id: command.id, result: {} }, h.editor())).status, 410);
  assert.equal((await h.request('/editor/next', undefined, h.editor())).body.command, null);
  const get = h.request('/project'); await h.queued(1);
  const getCommand = (await h.request('/editor/next', undefined, h.editor())).body.command;
  assert.equal(getCommand.type, 'get_project');
  await h.request('/editor/result', { id: getCommand.id, result: { revision: 8, project: { title: '保留真实工程' } } }, h.editor());
  assert.equal((await get).body.result.project.title, '保留真实工程');
});

test('an outstanding long poll receives the next command and duplicate polls cannot replace it', async t => {
  const h = await harness(t, { leaseMs: 5_000, commandMs: 2_000, pollMs: 500 }); await h.register();
  const poll = h.request('/editor/next', undefined, h.editor());
  await delay(15);
  assert.equal((await h.request('/editor/next', undefined, h.editor())).status, 409);
  const response = h.request('/commands', { type: 'catalog' });
  const command = (await poll).body.command; assert.equal(command.type, 'catalog');
  await h.request('/editor/result', { id: command.id, result: { templates: [] } }, h.editor());
  assert.equal((await response).status, 200);
});

test('editor errors keep structured status and a malformed result cannot consume a pending command', async t => {
  const h = await harness(t); await h.register();
  for (const [code, expected] of [['REVISION_CONFLICT', 409], ['INVALID_OPERATION', 400], ['EXPORT_BUSY', 503], ['LAYER_NOT_FOUND', 404]]) {
    const response = h.request('/commands', { type: 'undo' }); await h.queued(1);
    const command = (await h.request('/editor/next', undefined, h.editor())).body.command;
    assert.equal((await h.request('/editor/result', { id: command.id, result: {}, error: { message: '不能同时有两种结果' } }, h.editor())).status, 400);
    assert.equal((await h.request('/status')).body.pendingCommands, 1);
    await h.request('/editor/result', { id: command.id, error: { code, message: '操作未执行' } }, h.editor());
    const reply = await response; assert.equal(reply.status, expected); assert.equal(reply.body.code, code);
  }
});

test('command arguments and revisions are validated before entering the bounded queue', async t => {
  const h = await harness(t); await h.register();
  for (const body of [null, [], {}, { type: 'run_shell' }, { type: 'edit', args: [] }, { type: 'edit', args: null },
    { type: 'edit', expectedRevision: -1 }, { type: 'edit', expectedRevision: 1.5 }, { type: 'edit', expectedRevision: '1' }, { type: 'edit', typo: true }]) {
    const reply = await h.request('/commands', body); assert.equal(reply.status, 400);
    assert.equal(reply.body.code, body === null ? 'INVALID_JSON' : 'INVALID_COMMAND');
  }
  assert.equal((await h.request('/status')).body.pendingCommands, 0);
  const replies = Array.from({ length: 32 }, () => h.request('/commands', { type: 'seek', args: { time: 1 } }));
  await h.queued(32);
  const full = await h.request('/commands', { type: 'catalog' });
  assert.equal(full.status, 503); assert.equal(full.body.code, 'COMMAND_QUEUE_FULL');
  await h.request('/editor/release', {}, h.editor());
  assert((await Promise.all(replies)).every(reply => reply.status === 503));
});

test('expired queued and delivered commands are never delivered again and late results are rejected', async t => {
  const h = await harness(t, { leaseMs: 2_000, commandMs: 85, pollMs: 20 }); await h.register();
  const deliveredResponse = h.request('/commands', { type: 'edit' }); await h.queued(1);
  const command = (await h.request('/editor/next', undefined, h.editor())).body.command;
  assert.equal((await deliveredResponse).status, 504);
  assert.equal((await h.request('/editor/result', { id: command.id, result: {} }, h.editor())).status, 410);
  const queuedResponse = h.request('/commands', { type: 'redo' });
  assert.equal((await queuedResponse).status, 504);
  assert.equal((await h.request('/editor/next', undefined, h.editor())).body.command, null);
  assert.equal((await h.request('/status')).body.pendingCommands, 0);
});

test('a disconnected caller does not cause a queued or delivered operation to replay', async t => {
  const h = await harness(t); await h.register();
  for (const deliver of [false, true]) {
    const controller = new AbortController();
    const response = h.request('/commands', { type: 'edit' }, h.auth(), controller.signal).catch(error => error);
    await h.queued(1);
    const command = deliver ? (await h.request('/editor/next', undefined, h.editor())).body.command : null;
    controller.abort(); await response; await h.queued(0);
    if (command) assert.equal((await h.request('/editor/result', { id: command.id, result: {} }, h.editor())).status, 410);
    assert.equal((await h.request('/editor/next', undefined, h.editor())).body.command, null);
  }
});

test('an expired editor lease fails pending work and permits a fresh session without replay', async t => {
  const h = await harness(t, { leaseMs: 75, commandMs: 1_000, pollMs: 20 });
  const first = await h.register();
  const response = h.request('/commands', { type: 'edit' });
  assert.equal((await response).status, 503);
  assert.equal((await h.request('/status')).body.editorReady, false);
  assert.equal((await h.request('/editor/next', undefined, h.editor())).status, 409);
  const next = await h.register(); assert.equal(next.status, 200); assert.notEqual(next.body.sessionId, first.body.sessionId);
  assert.equal((await h.request('/editor/next', undefined, h.editor())).body.command, null);
});

test('idle polls renew the editor lease and closing the broker terminates all outstanding requests', async t => {
  const h = await harness(t, { leaseMs: 90, commandMs: 1_000, pollMs: 35 }); await h.register();
  for (let i = 0; i < 4; i++) assert.equal((await h.request('/editor/next', undefined, h.editor())).body.command, null);
  assert.equal((await h.request('/status')).body.editorReady, true);
  const response = h.request('/commands', { type: 'edit' }); await h.queued(1);
  const command = (await h.request('/editor/next', undefined, h.editor())).body.command; assert(command);
  h.control.close();
  const reply = await response; assert.equal(reply.status, 503); assert.equal(reply.body.code, 'SERVER_CLOSED');
  assert.equal((await h.request('/status')).status, 503);
  const idle = await harness(t, { leaseMs: 5_000, commandMs: 2_000, pollMs: 1_000 }); await idle.register();
  const poll = idle.request('/editor/next', undefined, idle.editor());
  await delay(15); idle.control.close();
  assert.equal((await poll).body.command, null);
});
