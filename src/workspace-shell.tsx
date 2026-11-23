import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { AudioLines, Clapperboard } from 'lucide-react';
import type { MediaAsset } from './types';
import { connectAgentEditor, type AgentExecutor } from './agent-client';
import { WorkspaceContext } from './workspace-context';
import { WorkspaceWelcome } from './workspace-welcome';
import './workspace-shell.css';

const EditWorkspace = lazy(() => import('./App'));
const DawWorkspace = lazy(() => import('./daw/workspace').then(module => ({ default: module.DawWorkspace })));
const WORKSPACE_BAR_HEIGHT = 48;
const WORKSPACES = [
  { id: 'edit', label: '剪辑', icon: Clapperboard },
  { id: 'daw', label: 'DAW', icon: AudioLines },
] as const;
type WorkspaceId = typeof WORKSPACES[number]['id'];
type AudioImport = { asset: MediaAsset; signal?: AbortSignal; complete?: () => void };
const agentError = (message: string, code: string) => Object.assign(new Error(message), { code });

export function WorkspaceShell() {
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceId | null>(null);
  const [opened, setOpened] = useState({ edit: false, daw: false });
  const [incomingAudio, setIncomingAudio] = useState<AudioImport | null>(null);
  const pendingAudio = useRef<AudioImport | null>(null);
  const dawAgent = useRef<{ execute: AgentExecutor; active: boolean } | null>(null);
  const dawReady = useRef<(() => void) | null>(null);
  const tabRefs = useRef<Partial<Record<WorkspaceId, HTMLButtonElement | null>>>({});
  const editorPanel = useRef<HTMLDivElement>(null);
  const editing = activeWorkspace === 'edit';
  const mixing = activeWorkspace === 'daw';
  const activate = useCallback((id: WorkspaceId) => {
    setOpened(previous => previous[id] ? previous : { ...previous, [id]: true });
    setActiveWorkspace(id);
  }, []);
  const queueEditorAudio = useCallback((item: AudioImport) => {
    if (pendingAudio.current) throw agentError('剪辑正在导入另一份混音，请稍后再试。', 'EDITOR_BUSY');
    pendingAudio.current = item;
    setIncomingAudio(item);
    activate('edit');
  }, [activate]);
  const importIntoEditor = useCallback((asset: MediaAsset) => queueEditorAudio({ asset }), [queueEditorAudio]);
  const finishAudioImport = useCallback((asset: MediaAsset) => {
    const pending = pendingAudio.current;
    if (pending?.asset !== asset) return;
    pendingAudio.current = null;
    setIncomingAudio(null);
    pending.complete?.();
    editorPanel.current?.focus({ preventScroll: true });
  }, []);
  const registerDawAgent = useCallback((execute: AgentExecutor, active: boolean) => {
    const connection = { execute, active };
    dawAgent.current = connection;
    dawReady.current?.();
    return () => { if (dawAgent.current === connection) dawAgent.current = null; };
  }, []);

  useEffect(() => connectAgentEditor(async (command, lease) => {
    const signal = AbortSignal.any([lease, AbortSignal.timeout(Math.max(1, command.deadline - Date.now()))]);
    if (command.type === 'activate') {
      if (Object.keys(command.args ?? {}).length) throw new Error('激活 DAW 不接受参数。');
      if (!dawAgent.current?.active) await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal.removeEventListener('abort', expire);
          dawReady.current = null;
        };
        const expire = () => {
          done();
          reject(agentError('等待 DAW 恢复会话超时，请查看当前工作区。', 'DAW_TIMEOUT'));
        };
        signal.addEventListener('abort', expire, { once: true });
        dawReady.current = () => { if (dawAgent.current?.active) { done(); resolve(); } };
        activate('daw');
      });
      signal.throwIfAborted();
      command = { ...command, type: 'get_session' };
    }
    const connection = dawAgent.current;
    if (!connection) throw agentError('请先进入 DAW，或调用 visiki_daw_activate 等待会话恢复。', 'DAW_NOT_READY');
    if (command.type !== 'send_to_editor') return connection.execute(command, signal);
    if (pendingAudio.current) throw agentError('剪辑正在导入另一份混音，请稍后再试。', 'EDITOR_BUSY');
    const asset = await connection.execute(command, signal) as MediaAsset;
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const expire = () => {
        if (pendingAudio.current === item) {
          pendingAudio.current = null;
          setIncomingAudio(null);
        }
        reject(agentError('未能确认主音轨已更新，请重新读取剪辑工程。', 'EDITOR_TIMEOUT'));
      };
      const item: AudioImport = { asset, signal, complete: () => { signal.removeEventListener('abort', expire); resolve(); } };
      queueEditorAudio(item);
      signal.addEventListener('abort', expire, { once: true });
    });
    return { asset, imported: true, workspace: 'edit' };
  }, '/api/agent/daw'), [activate, queueEditorAudio]);
  useLayoutEffect(() => {
    if (activeWorkspace) tabRefs.current[activeWorkspace]?.focus();
  }, [activeWorkspace]);

  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>, current: WorkspaceId) => {
    const index = WORKSPACES.findIndex(workspace => workspace.id === current);
    let next: number;
    switch (event.key) {
      case 'ArrowLeft': next = (index + WORKSPACES.length - 1) % WORKSPACES.length; break;
      case 'ArrowRight': next = (index + 1) % WORKSPACES.length; break;
      case 'Home': next = 0; break;
      case 'End': next = WORKSPACES.length - 1; break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    const id = WORKSPACES[next].id;
    activate(id);
  };

  const brand = <><img className="brand-icon" src="/branding/visiki-64.png" width={28} height={28} alt="" draggable={false} /><span>Visiki</span><span className="demo-badge">DEMO</span></>;
  return <div className="workspace-shell" style={{ gridTemplateRows: `${WORKSPACE_BAR_HEIGHT}px minmax(0, 1fr)` }}>
    <header className="workspace-bar" data-workspace-navigation>
      {activeWorkspace ? <button type="button" className="brand workspace-brand workspace-home" aria-label="返回欢迎页" title="返回欢迎页" onClick={() => setActiveWorkspace(null)}>{brand}</button>
        : <div className="brand workspace-brand">{brand}</div>}
      {activeWorkspace && <div className="workspace-tabs" role="tablist" aria-label="工作区">
        {WORKSPACES.map(({ id, label, icon: Icon }) => <button key={id} ref={node => { tabRefs.current[id] = node; }}
          type="button" role="tab" id={`workspace-tab-${id}`} aria-controls={`workspace-view-${id}`}
          aria-selected={activeWorkspace === id} tabIndex={activeWorkspace === id ? 0 : -1}
          className={`workspace-tab${activeWorkspace === id ? ' active' : ''}`}
          onClick={() => activate(id)} onKeyDown={event => navigateTabs(event, id)}>
          <Icon size={16} aria-hidden="true" /><span>{label}</span>
        </button>)}
      </div>}
      {activeWorkspace && <span className="workspace-status">{editing ? '剪辑工作区' : '音频工作区'}</span>}
    </header>
    <div className="workspace-views">
      {activeWorkspace === null && <WorkspaceWelcome onChoose={activate} />}
      {/* Once opened, each workspace keeps its own editor state across navigation. */}
      <div className="workspace-view" ref={editorPanel} id="workspace-view-edit" role="tabpanel" aria-labelledby="workspace-tab-edit" hidden={!editing} inert={!editing} tabIndex={-1}>
        {opened.edit && <WorkspaceContext.Provider value={{ active: editing, topInset: WORKSPACE_BAR_HEIGHT }}>
          <Suspense fallback={<div className="daw-placeholder" role="status">正在打开剪辑…</div>}>
            <EditWorkspace incomingAudio={incomingAudio?.asset} incomingAudioSignal={incomingAudio?.signal} onAudioImported={finishAudioImport} />
          </Suspense>
        </WorkspaceContext.Provider>}
      </div>
      <div className="workspace-view" id="workspace-view-daw" role="tabpanel" aria-labelledby="workspace-tab-daw" hidden={!mixing} inert={!mixing} tabIndex={0}>
        {opened.daw && <Suspense fallback={<div className="daw-placeholder" role="status">正在准备音轨编辑器…</div>}><DawWorkspace active={mixing} onImportToEditor={importIntoEditor} registerAgent={registerDawAgent} /></Suspense>}
      </div>
    </div>
  </div>;
}

