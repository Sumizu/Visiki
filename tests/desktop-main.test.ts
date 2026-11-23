import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const entry = fileURLToPath(new URL('../electron/main.cjs', import.meta.url));
const source = readFileSync(entry, 'utf8');
const realRequire = createRequire(import.meta.url);

async function launch(platform: 'win32' | 'linux' | 'darwin') {
  const actions: string[] = [], menus: unknown[] = [], errors: string[] = [];
  const ipcMain = new EventEmitter();
  const timers = new Map<number, () => void>();
  let timerId = 0, ready!: () => void;
  const readyPromise = new Promise<void>(resolve => { ready = resolve; });
  const app = Object.assign(new EventEmitter(), {
    name: '', quitCalls: 0,
    setAppUserModelId() {}, setPath() {}, requestSingleInstanceLock: () => true,
    whenReady: () => readyPromise,
    quit() { this.quitCalls++; },
  });
  const worker = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    exitCode: null, signalCode: null, connected: true, sent: [] as unknown[],
    send(message: unknown, callback?: () => void) { this.sent.push(message); callback?.(); },
    kill() { actions.push('worker-kill'); },
  });
  const windows: MockWindow[] = [];
  class MockWindow extends EventEmitter {
    menuRemoved = false; url = ''; downloads: string[] = [];
    openHandler!: (details: { url: string }) => { action: string };
    webContents = Object.assign(new EventEmitter(), {
      session: new EventEmitter(),
      setWindowOpenHandler: (handler: MockWindow['openHandler']) => { this.openHandler = handler; },
      downloadURL: (url: string) => { this.downloads.push(url); },
    });
    constructor(public options: Record<string, unknown>) {
      super(); actions.push('window'); windows.push(this);
    }
    removeMenu() { this.menuRemoved = true; actions.push('window-menu'); }
    async loadURL(url: string) { this.url = url; actions.push('loadURL'); }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    restore() {} show() {} focus() {}
    close() { this.emit('closed'); }
  }
  const fakeFs = {
    appendFileSync() {}, mkdirSync() {}, writeFileSync() {}, unlinkSync() {},
    existsSync: () => false,
  };
  const context = {
    __dirname: dirname(entry),
    URL,
    process: { platform, env: { VISIKI_SMOKE: '1' }, pid: 123, versions: { electron: 'test' }, arch: 'x64', execPath: 'visiki.exe' },
    require(name: string) {
      if (name === 'electron') return {
        app, BrowserWindow: MockWindow, ipcMain,
        Menu: { setApplicationMenu(menu: unknown) { menus.push(menu); actions.push('application-menu'); } },
        dialog: { showErrorBox(_title: string, message: string) { errors.push(message); } },
      };
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:child_process') return { fork() {
        queueMicrotask(() => worker.emit('message', { ready: true, port: 4317 }));
        return worker;
      } };
      return realRequire(name);
    },
    setTimeout(callback: () => void) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  };
  vm.runInNewContext(source, context, { filename: entry });
  assert.equal(actions.length, 0, 'menu and window setup wait for Electron readiness');
  ready(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(errors, []);
  assert.equal(windows.length, 1);
  assert.equal(timers.size, 0, 'server readiness timeout is cleared');
  return { app, actions, menus, worker, window: windows[0], windows, ipcMain, timers };
}

for (const platform of ['win32', 'linux'] as const) {
  test(`desktop ${platform} removes the Alt-activated default menu before showing the editor`, async () => {
    const desktop = await launch(platform);
    assert.deepEqual(desktop.menus, [null]);
    assert.equal(desktop.window.menuRemoved, true);
    assert.deepEqual(desktop.actions, ['application-menu', 'window', 'window-menu', 'loadURL']);
    assert.equal(desktop.window.webContents.listenerCount('before-input-event'), 0,
      'Alt combinations remain available to the editor and operating system');
  });
}

test('desktop macOS retains its native application menu', async () => {
  const desktop = await launch('darwin');
  assert.deepEqual(desktop.menus, []);
  assert.equal(desktop.window.menuRemoved, false);
  assert.deepEqual(desktop.actions, ['window', 'loadURL']);
});

test('menu removal preserves renderer isolation and local navigation/export guards', async () => {
  const desktop = await launch('win32'), window = desktop.window;
  assert.equal(window.url, 'http://127.0.0.1:4317');
  const preferences = window.options.webPreferences as Record<string, unknown>;
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  const exportUrl = 'http://127.0.0.1:4317/api/export/test.mp4';
  assert.equal(window.openHandler({ url: exportUrl }).action, 'deny');
  assert.deepEqual(window.downloads, [exportUrl]);
  assert.equal(window.openHandler({ url: 'https://example.com' }).action, 'deny');
  assert.deepEqual(window.downloads, [exportUrl]);
  let prevented = 0;
  window.webContents.emit('will-navigate', { preventDefault() { prevented++; } }, 'https://example.com');
  window.webContents.emit('will-navigate', { preventDefault() { prevented++; } }, window.url + '/');
  assert.equal(prevented, 1);
});

test('menu changes preserve graceful shutdown of only the owned backend', async () => {
  const desktop = await launch('win32');
  let prevented = 0;
  desktop.app.emit('before-quit', { preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  assert.equal(JSON.stringify(desktop.worker.sent), '[{"type":"visiki-shutdown"}]');
  assert.equal(desktop.timers.size, 1);
  desktop.worker.emit('exit', 0, null);
  assert.equal(desktop.timers.size, 0);
  assert.equal(desktop.app.quitCalls, 1);
  assert.equal(desktop.actions.includes('worker-kill'), false);
});

test('effect windows accept only the main renderer and local effect route, reuse instances and stay isolated', async () => {
  const desktop = await launch('win32');
  const open = (url: string, sender: unknown = desktop.window.webContents, key = 'instance-1') => desktop.ipcMain.emit('visiki-open-effect', { sender }, { url, key });
  open('https://example.com/?visikiEffect=1');
  open('http://127.0.0.1:4317/?visikiEffect=1', {});
  open('http://127.0.0.1:4317/?visikiEffect=0');
  open('http://127.0.0.1:4317/api/daw/?visikiEffect=1');
  assert.equal(desktop.windows.length, 1);
  const url = 'http://127.0.0.1:4317/?visikiEffect=1&owner=test&target=master&effect=eq';
  open(url); await Promise.resolve();
  assert.equal(desktop.windows.length, 2);
  const effect = desktop.windows[1], preferences = effect.options.webPreferences as Record<string, unknown>;
  assert.equal(effect.options.parent, desktop.window);
  assert.equal(effect.url, url);
  assert.equal(effect.menuRemoved, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(effect.openHandler({ url: 'https://example.com' }).action, 'deny');
  open(url); assert.equal(desktop.windows.length, 2, 'same effect opens one native window');
  let prevented = 0;
  effect.webContents.emit('will-navigate', { preventDefault() { prevented++; } }, 'https://example.com');
  assert.equal(prevented, 1);
  effect.close(); open(url); assert.equal(desktop.windows.length, 3, 'closed editor may be reopened');
  let closed = 0; desktop.windows[2].on('closed', () => closed++);
  desktop.window.emit('closed'); assert.equal(closed, 1);
});
