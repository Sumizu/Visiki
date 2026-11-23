import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  })]).finally(() => clearTimeout(timer!));
}
async function unusedPort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address(); assert(address && typeof address !== 'string');
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return address.port;
}
async function portClosed(port: number) {
  return bounded(new Promise<boolean>(resolve => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
  }), 1_000, 'Shutdown port check timed out');
}
async function startBackend(t: any) {
  const serverFile = path.resolve(process.env.VISIKI_TEST_SERVER || path.join(process.cwd(), 'dist-server', 'server.cjs'));
  await fs.access(serverFile);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-agent-startup-'));
  const port = await unusedPort();
  const child = fork(serverFile, [], { cwd: process.cwd(), execArgv: [], windowsHide: true, silent: true,
    env: { ...process.env, PORT: String(port), VISIKI_DATA_DIR: directory,
      NODE_PATH: [path.join(process.cwd(), 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter) } });
  let logs = '';
  child.stdout!.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4_000); });
  child.stderr!.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4_000); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill(); await bounded(exited, 3_000, 'Test backend did not exit');
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  await bounded(new Promise<void>((resolve, reject) => {
    child.on('message', message => {
      if (message && typeof message === 'object' && 'ready' in message && message.ready && 'port' in message && message.port === port) resolve();
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Backend exited before ready (${code}): ${logs}`)));
  }), 10_000, 'Backend startup timed out');
  const file = path.join(directory, 'agent-endpoint.json');
  const endpoint = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(endpoint.url, `http://127.0.0.1:${port}`); assert.equal(endpoint.pid, child.pid); assert.equal(endpoint.version, 1);
  const url = endpoint.url as string;
  const auth = { Authorization: `Bearer ${endpoint.token}` };
  return { child, exited, file, port, url, auth };
}

test('the real backend removes its endpoint and closes its port on graceful desktop IPC shutdown', async t => {
  const h = await startBackend(t);
  h.child.send({ type: 'unrelated-message' });
  const status = await fetch(`${h.url}/api/agent/status`, { headers: h.auth });
  assert.equal(status.status, 200);
  const registration = await fetch(`${h.url}/api/agent/editor/register`, {
    method: 'POST', headers: { Origin: h.url, 'X-Visiki-Editor': '1' },
  });
  assert.equal(registration.status, 200);
  const pending = fetch(`${h.url}/api/agent/project`, { headers: h.auth });
  for (let i = 0; i < 100; i++) {
    const body = await (await fetch(`${h.url}/api/agent/status`, { headers: h.auth })).json();
    if (body.pendingCommands === 1) break;
    if (i === 99) assert.fail('The startup test command did not enter the broker');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  h.child.send({ type: 'visiki-shutdown' });
  const response = await bounded(pending, 3_000, 'Pending command did not terminate during shutdown');
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'SERVER_CLOSED');
  assert.deepEqual(await bounded(h.exited, 5_000, 'IPC shutdown did not exit'), { code: 0, signal: null });
  await assert.rejects(fs.access(h.file));
  assert.equal(await portClosed(h.port), true);
});

test('the real backend cleans up when its desktop parent IPC connection disappears', async t => {
  const h = await startBackend(t);
  h.child.disconnect();
  assert.deepEqual(await bounded(h.exited, 5_000, 'Parent disconnect did not stop the backend'), { code: 0, signal: null });
  await assert.rejects(fs.access(h.file));
  assert.equal(await portClosed(h.port), true);
});
