import express from 'express';
import path from 'node:path';
import { promises as fs, readFileSync, unlinkSync } from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const AGENT_COMMAND_TYPES = new Set([
  'get_project', 'edit', 'apply_template', 'replace_project', 'undo', 'redo', 'seek',
  'preview', 'start_export', 'get_export', 'cancel_export', 'catalog',
]);
const DAW_COMMAND_TYPES = new Set([
  'activate', 'catalog', 'get_session', 'new_session', 'replace_session', 'attach_asset',
  'edit', 'undo', 'redo', 'transport', 'view', 'meters', 'monitor_effect', 'effect_presets',
  'job_start', 'job_status', 'job_cancel', 'job_apply', 'preview_source', 'send_to_editor',
]);

interface AgentControlOptions {
  port: number;
  dataRoot: string;
  /** Short intervals are useful for exercising the real HTTP lifecycle in tests. */
  timings?: { leaseMs?: number; commandMs?: number; pollMs?: number };
}
interface EditorCommand {
  id: string;
  type: string;
  args?: Record<string, unknown>;
  expectedRevision?: number;
  deadline: number;
}
interface PendingCommand {
  command: EditorCommand;
  delivered: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: AgentError) => void;
}
interface WaitingEditor {
  response: express.Response;
  timer: ReturnType<typeof setTimeout>;
  disconnect: () => void;
}
class AgentError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const problem = (status: number, code: string, message: string) => new AgentError(status, code, message);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function sendError(res: express.Response, error: unknown) {
  const detail = error instanceof AgentError ? error : problem(400, 'INVALID_REQUEST', '无效的 Agent 请求');
  if (!res.headersSent && !res.destroyed) res.status(detail.status).json({ error: detail.message, code: detail.code });
}

function createChannel(commands: ReadonlySet<string>, token: string, authorize: express.RequestHandler, timings?: AgentControlOptions['timings']) {
  const leaseMs = timings?.leaseMs ?? 45_000;
  const commandMs = timings?.commandMs ?? 30_000;
  const pollMs = timings?.pollMs ?? 15_000;
  const pending = new Map<string, PendingCommand>();
  const queue: string[] = [];
  let session: { id: string; expires: number } | undefined;
  let deliveredId: string | undefined;
  let waiting: WaitingEditor | undefined;
  function finishWait(command: EditorCommand | null) {
    const poll = waiting;
    if (!poll) return;
    waiting = undefined;
    clearTimeout(poll.timer);
    poll.response.off('close', poll.disconnect);
    if (!poll.response.destroyed) poll.response.json({ command });
  }
  function settle(id: string, value: unknown, error?: AgentError) {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    clearTimeout(job.timer);
    const index = queue.indexOf(id);
    if (index >= 0) queue.splice(index, 1);
    if (deliveredId === id) deliveredId = undefined;
    if (error) job.reject(error); else job.resolve(value);
  }
  function release(error: AgentError) {
    session = undefined;
    finishWait(null);
    for (const id of [...pending.keys()]) settle(id, undefined, error);
    queue.length = 0;
    deliveredId = undefined;
  }
  function expire() {
    if (session && session.expires <= Date.now()) release(problem(503, 'EDITOR_DISCONNECTED', '编辑器连接已过期，请重新连接'));
  }
  function touch() { if (session) session.expires = Date.now() + leaseMs; }
  function pump() {
    expire();
    if (!session || !waiting || deliveredId) return;
    while (queue.length) {
      const id = queue.shift()!;
      const job = pending.get(id);
      if (!job) continue;
      if (job.command.deadline <= Date.now()) {
        settle(id, undefined, problem(504, 'COMMAND_TIMEOUT', '命令已超时，不会重新执行；请读取工程确认当前状态'));
        continue;
      }
      job.delivered = true;
      deliveredId = id;
      touch();
      finishWait(job.command);
      return;
    }
  }
  const leaseTimer = setInterval(expire, Math.min(1_000, leaseMs));
  leaseTimer.unref();

  const router = express.Router();
  router.use((_req, _res, next) => { expire(); next(); });
  const editorOnly: express.RequestHandler = (req, res, next) => {
    if (!session || (req.headers['x-visiki-editor-session'] ?? req.headers['x-echo-editor-session']) !== session.id) {
      sendError(res, problem(409, 'EDITOR_SESSION_INVALID', '编辑器会话已失效，请重新连接')); return;
    }
    touch(); next();
  };
  router.post('/editor/register', (req, res) => {
    const site = req.headers['sec-fetch-site'];
    // The custom header forces a browser preflight across origins. A missing Origin
    // is accepted only with the browser's explicit same-origin navigation context.
    if ((req.headers['x-visiki-editor'] ?? req.headers['x-echo-editor']) !== '1' ||
      (req.headers.origin === undefined && site !== 'same-origin' && site !== 'none') ||
      (site !== undefined && site !== 'same-origin' && site !== 'none')) {
      sendError(res, problem(403, 'EDITOR_BOOTSTRAP_ONLY', '请从本机编辑器页面建立连接')); return;
    }
    if (session) { sendError(res, problem(409, 'EDITOR_ALREADY_CONNECTED', '已有一个编辑器连接，请先关闭或断开原编辑器')); return; }
    session = { id: randomUUID(), expires: Date.now() + leaseMs };
    res.json({ sessionId: session.id, token });
  });
  router.get('/status', authorize, (_req, res) => {
    res.json({ version: 1, editorReady: !!session, editorBusy: !!deliveredId, pendingCommands: pending.size });
  });
  router.get('/editor/next', authorize, editorOnly, (req, res) => {
    if (waiting || deliveredId) { sendError(res, problem(409, 'EDITOR_BUSY', '编辑器已有轮询或尚未返回的命令')); return; }
    const disconnect = () => {
      if (waiting?.response === res) { clearTimeout(waiting.timer); waiting = undefined; }
    };
    const timer = setTimeout(() => { touch(); finishWait(null); }, pollMs);
    timer.unref();
    waiting = { response: res, timer, disconnect };
    res.once('close', disconnect);
    pump();
  });
  router.post('/editor/result', authorize, editorOnly, (req, res) => {
    const body: unknown = req.body;
    if (!object(body) || typeof body.id !== 'string' ||
      Object.keys(body).some(key => !['id', 'result', 'error'].includes(key)) ||
      (Object.hasOwn(body, 'result') === Object.hasOwn(body, 'error')) ||
      (Object.hasOwn(body, 'error') && (!object(body.error) || typeof body.error.message !== 'string' || body.error.message.length > 2_000 ||
        (body.error.code !== undefined && (typeof body.error.code !== 'string' || body.error.code.length > 100))))) {
      sendError(res, problem(400, 'INVALID_RESULT', '命令结果格式无效')); return;
    }
    const job = pending.get(body.id);
    if (!job || !job.delivered || deliveredId !== body.id || job.command.deadline <= Date.now()) {
      if (job && job.command.deadline <= Date.now()) settle(body.id, undefined, problem(504, 'COMMAND_TIMEOUT', '命令已超时，不会重新执行'));
      sendError(res, problem(410, 'COMMAND_EXPIRED', '命令不存在、已结束或已超时，不会重新执行')); return;
    }
    if (object(body.error)) {
      const code = typeof body.error.code === 'string' ? body.error.code : 'EDITOR_ERROR';
      const status = /CONFLICT|REVISION|STALE/i.test(code) ? 409 : /TIMEOUT/i.test(code) ? 504 :
        /BUSY|NOT_READY|UNAVAILABLE/i.test(code) ? 503 : /NOT_FOUND/i.test(code) ? 404 : 400;
      settle(body.id, undefined, problem(status, code, String(body.error.message)));
    } else settle(body.id, body.result);
    res.json({ ok: true });
    pump();
  });
  router.post('/editor/release', authorize, editorOnly, (_req, res) => {
    release(problem(503, 'EDITOR_DISCONNECTED', '编辑器已断开，未完成的命令不会重新执行'));
    res.json({ ok: true });
  });

  async function dispatch(req: express.Request, res: express.Response, input: unknown) {
    if (!object(input) || typeof input.type !== 'string' || !commands.has(input.type) ||
      Object.keys(input).some(key => !['type', 'args', 'expectedRevision'].includes(key)) ||
      (input.args !== undefined && !object(input.args)) ||
      (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0))) {
      sendError(res, problem(400, 'INVALID_COMMAND', '命令类型、参数或工程版本无效')); return;
    }
    if (!session) { sendError(res, problem(503, 'EDITOR_NOT_READY', '请先打开编辑器并等待 Agent 连接就绪')); return; }
    if (pending.size >= 32) { sendError(res, problem(503, 'COMMAND_QUEUE_FULL', 'Agent 命令队列已满，请等待后重试')); return; }
    const command: EditorCommand = { id: randomUUID(), type: input.type,
      ...(input.args !== undefined ? { args: input.args } : {}),
      ...(input.expectedRevision !== undefined ? { expectedRevision: Number(input.expectedRevision) } : {}),
      deadline: Date.now() + commandMs };
    const completion = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(command.id, undefined, problem(504, 'COMMAND_TIMEOUT', '命令已超时，不会重新执行；请读取工程确认当前状态'));
        pump();
      }, commandMs);
      timer.unref();
      pending.set(command.id, { command, delivered: false, timer, resolve, reject });
    });
    const disconnect = () => {
      if (!res.writableFinished) {
        settle(command.id, undefined, problem(499, 'CLIENT_DISCONNECTED', '调用方已断开，命令不会重新执行'));
        pump();
      }
    };
    req.once('aborted', disconnect); res.once('close', disconnect);
    queue.push(command.id); pump();
    try {
      const result = await completion;
      if (!res.destroyed) res.json({ id: command.id, result });
    } catch (error) { sendError(res, error); }
    finally { req.off('aborted', disconnect); res.off('close', disconnect); }
  }
  if (commands.has('get_project')) router.get('/project', authorize, (req, res) => dispatch(req, res, { type: 'get_project' }));
  router.post('/commands', authorize, (req, res) => dispatch(req, res, req.body));
  return { router, close() {
    clearInterval(leaseTimer);
    release(problem(503, 'SERVER_CLOSED', 'Agent 服务已关闭，未完成的命令不会重新执行'));
  } };
}

/** Two local command channels share discovery and authentication while each workspace owns its history. */
export function installAgentControl(app: express.Express, options: AgentControlOptions) {
  const token = randomBytes(32).toString('base64url');
  const tokenBytes = Buffer.from(token);
  const endpointFile = path.join(options.dataRoot, 'agent-endpoint.json');
  let closed = false;
  function removeOwnedEndpoint() {
    try {
      const endpoint: unknown = JSON.parse(readFileSync(endpointFile, 'utf8'));
      if (object(endpoint) && endpoint.token === token && endpoint.pid === process.pid) unlinkSync(endpointFile);
    } catch { /* Another instance may already own the discovery file. */ }
  }
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const address = req.socket.remoteAddress;
    const host = req.headers.host?.toLowerCase();
    const validHost = host === `127.0.0.1:${options.port}` || host === `localhost:${options.port}`;
    const local = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    if (!local || !validHost) { sendError(res, problem(403, 'LOCAL_ONLY', 'Agent 接口仅允许本机编辑器访问')); return; }
    if (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) {
      sendError(res, problem(403, 'INVALID_ORIGIN', 'Agent 接口不允许跨站访问')); return;
    }
    if (closed) { sendError(res, problem(503, 'SERVER_CLOSED', 'Agent 服务已关闭')); return; }
    next();
  });
  const authorize: express.RequestHandler = (req, res, next) => {
    const auth = req.headers.authorization;
    const supplied = typeof auth === 'string' && auth.startsWith('Bearer ') ? Buffer.from(auth.slice(7)) : Buffer.alloc(0);
    if (supplied.length !== tokenBytes.length || !timingSafeEqual(supplied, tokenBytes)) {
      sendError(res, problem(401, 'UNAUTHORIZED', '需要有效的本机 Agent 令牌')); return;
    }
    next();
  };
  const edit = createChannel(AGENT_COMMAND_TYPES, token, authorize, options.timings);
  const daw = createChannel(DAW_COMMAND_TYPES, token, authorize, options.timings);
  router.use('/daw', daw.router);
  router.use(edit.router);
  app.use('/api/agent', router);

  return {
    async initialize() {
      if (closed) throw new Error('Agent 服务已关闭');
      await fs.mkdir(options.dataRoot, { recursive: true });
      const temporary = `${endpointFile}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ url: `http://127.0.0.1:${options.port}`, token, pid: process.pid, version: 1 }, null, 2), { mode: 0o600 });
        if (closed) return;
        await fs.rename(temporary, endpointFile);
        if (closed) removeOwnedEndpoint();
      } finally { await fs.unlink(temporary).catch(() => {}); }
    },
    close() {
      if (closed) return;
      closed = true;
      edit.close();
      daw.close();
      removeOwnedEndpoint();
    },
  };
}
