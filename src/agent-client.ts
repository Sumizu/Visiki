export interface AgentCommand {
  id: string;
  type: string;
  args?: Record<string, unknown>;
  expectedRevision?: number;
  deadline: number;
}
export type AgentExecutor = (command: AgentCommand, signal: AbortSignal) => Promise<unknown>;

/** The editor owns state and history; the local server only brokers commands. */
export function connectAgentEditor(execute: AgentExecutor, base: '/api/agent' | '/api/agent/daw' = '/api/agent'): () => void {
  const controller = new AbortController();
  let credentials: { sessionId: string; token: string } | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const delay = () => new Promise<void>(resolve => { wake = resolve; retry = setTimeout(resolve, 1800); });
  const headers = () => ({ Authorization: `Bearer ${credentials!.token}`, 'X-Visiki-Editor-Session': credentials!.sessionId });
  const release = (value: { sessionId: string; token: string }) => fetch(`${base}/editor/release`, {
    method: 'POST', headers: { Authorization: `Bearer ${value.token}`, 'X-Visiki-Editor-Session': value.sessionId }, keepalive: true,
  }).catch(() => {});
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        if (!credentials) {
          // Do not abort registration: StrictMode/unmount still needs to release
          // a lease acquired just before cleanup, rather than orphan it.
          const response = await fetch(`${base}/editor/register`, { method: 'POST', headers: { 'X-Visiki-Editor': '1' }, signal: AbortSignal.timeout(6000) });
          if (!response.ok) throw new Error('Agent editor not available');
          const value = await response.json() as { sessionId: string; token: string };
          if (controller.signal.aborted) { await release(value); break; }
          credentials = value;
        }
        const response = await fetch(`${base}/editor/next`, { headers: headers(), signal: controller.signal });
        if (!response.ok) throw new Error('Agent editor disconnected');
        const { command } = await response.json() as { command: AgentCommand | null };
        if (!command || controller.signal.aborted) continue;
        let body: unknown;
        try {
          if (Date.now() >= command.deadline) throw new Error('命令已超时，未执行');
          body = { id: command.id, result: await execute(command, controller.signal) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'invalid';
          body = { id: command.id, error: { message: message.slice(0, 2_000), code: code.slice(0, 100) } };
        }
        if (controller.signal.aborted) break;
        const delivered = await fetch(`${base}/editor/result`, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
        if (!delivered.ok && delivered.status !== 410) throw new Error('Agent result disconnected');
      } catch {
        if (credentials) { await release(credentials); credentials = undefined; }
        if (!controller.signal.aborted) await delay();
      }
    }
  })();
  const cleanup = () => {
    window.removeEventListener('pagehide', cleanup);
    controller.abort(); clearTimeout(retry); wake?.();
    if (credentials) { void release(credentials); credentials = undefined; }
  };
  window.addEventListener('pagehide', cleanup, { once: true });
  return cleanup;
}
