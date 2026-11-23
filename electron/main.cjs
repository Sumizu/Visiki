const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const portable = path.basename(root).toLowerCase() === 'app';
const releaseRoot = path.dirname(root);
const dataRoot = path.join(root, '.demo-data');
let logPath = path.join(os.tmpdir(), 'Visiki-startup-' + process.pid + '.log');
let backend;
let window;
const effectWindows = new Map();
let quitting = false;
let quitComplete = false;
let shutdownTimer;
let failureShown = false;
app.name = 'Visiki';
if (process.platform === 'win32') app.setAppUserModelId('Visiki.MusicVideoEditor');

function log(message) {
  try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8'); } catch {}
}

function fail(error) {
  if (failureShown || quitting) return;
  failureShown = true;
  const message = error && error.stack ? error.stack : String(error);
  log(message);
  dialog.showErrorBox('Visiki启动失败', `${error.message || error}\n\n日志：${logPath}\n请将日志发送给提供发布包的人。`);
  app.quit();
}

function initialize() {
  if (portable) {
    const required = [
      path.join(releaseRoot, 'runtime', 'electron', 'electron.exe'),
      path.join(releaseRoot, 'runtime', 'ffmpeg', 'ffmpeg.exe'),
      path.join(root, 'dist', 'index.html'),
      path.join(root, 'dist-server', 'server.cjs'),
    ];
    const missing = required.filter(file => !fs.existsSync(file));
    if (missing.length) throw new Error('发布包文件不完整，请完整解压 ZIP 后再启动，不要在压缩包内直接运行。\n缺少：\n' + missing.join('\n'));
  }
  try {
    fs.mkdirSync(path.join(dataRoot, 'logs'), { recursive: true });
    const probe = path.join(dataRoot, '.write-check-' + process.pid);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    logPath = path.join(dataRoot, 'logs', 'desktop.log');
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 2 * 1024 * 1024) {
      fs.copyFileSync(logPath, path.join(dataRoot, 'logs', 'desktop.previous.log'));
      fs.writeFileSync(logPath, '');
    }
    const profileRoot = path.join(dataRoot, 'desktop-profile');
    fs.mkdirSync(profileRoot, { recursive: true });
    app.setPath('userData', profileRoot);
  } catch (error) {
    throw new Error('无法在应用目录保存工程和设置。请把整个文件夹移动到可写的位置（如桌面或个人磁盘目录），避免 Program Files、只读目录和压缩包内部。\n' + error.message);
  }
  log(`Starting Visiki; portable=${portable}; root=${root}; electron=${process.versions.electron}; arch=${process.arch}`);
}

function showMainWindow() {
  if(!window || window.isDestroyed()) return;
  if(window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function isPortFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function selectPort() {
  const requestedPort = process.env.VISIKI_PORT ?? process.env.ECHO_PORT;
  if (requestedPort !== undefined) {
    const requested = Number(requestedPort);
    if (!Number.isInteger(requested) || requested < 1 || requested > 65535) throw new Error('VISIKI_PORT 必须是 1–65535 的端口号。');
    if (!(await isPortFree(requested))) throw new Error(`端口 ${requested} 已被使用，请关闭占用该端口的程序或清除 VISIKI_PORT 后重试。`);
    return requested;
  }
  if (!portable) return 4317;
  const portFile = path.join(dataRoot, 'desktop-port.json');
  let preferred;
  try {
    const stored = JSON.parse(fs.readFileSync(portFile, 'utf8'));
    if (Number.isInteger(stored.port) && stored.port >= 20000 && stored.port < 40000) preferred = stored.port;
  } catch {}
  if (!preferred) preferred = 20000 + crypto.createHash('sha256').update(root.toLowerCase()).digest().readUInt32LE(0) % 20000;
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = 20000 + ((preferred - 20000 + attempt) % 20000);
    if (await isPortFree(candidate)) {
      fs.writeFileSync(portFile, JSON.stringify({ port: candidate }, null, 2) + '\n');
      return candidate;
    }
  }
  throw new Error('未找到可用的本机端口，请关闭其他Visiki窗口后重试。');
}

async function start() {
  // The editor already provides its own commands and workspace tabs. Hiding the
  // default menu alone lets Alt reveal it and changes the timeline's viewport.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  const port = await selectPort();
  if (quitting) return;
  const backendEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port) };
  if (portable) {
    // A received ZIP must never reuse a developer's external data or FFmpeg path.
    backendEnv.VISIKI_DATA_DIR = dataRoot;
    backendEnv.ECHO_DATA_DIR = dataRoot;
    backendEnv.FFMPEG_PATH = path.join(releaseRoot, 'runtime', 'ffmpeg', 'ffmpeg.exe');
    delete backendEnv.NODE_PATH;
    delete backendEnv.NODE_OPTIONS;
  }
  log(`Backend port=${port}; ffmpeg=${backendEnv.FFMPEG_PATH || 'PATH'}; data=${backendEnv.VISIKI_DATA_DIR || dataRoot}`);
  // The worker is launched with Electron's Node runtime, keeping the install self-contained.
  backend = fork(path.join(root, 'dist-server', 'server.cjs'), [], { cwd: root, windowsHide: true,
    execPath: process.execPath, env: backendEnv, silent: true });
  let logs = '';
  let ready = false;
  const capture = label => chunk => {
    const text = chunk.toString();
    logs = (logs + text).slice(-8000);
    log(`${label}: ${text.trimEnd()}`);
  };
  backend.stdout.on('data', capture('server'));
  backend.stderr.on('data', capture('server error'));
  backend.once('exit', (code, signal) => {
    log(`Backend exited: code=${code}, signal=${signal}`);
    if (ready && !quitting) fail(new Error(`本地服务意外退出 (${code})。\n${logs}`));
  });
    await new Promise((resolve, reject) => {
      const timer=setTimeout(()=>reject(new Error('本地服务启动超时\n'+logs)),20000);
      backend.on('message',message=>{if(message && message.ready && Number(message.port) === port){ready=true;clearTimeout(timer);resolve();}});
      backend.once('error',error=>{clearTimeout(timer);reject(error);});
      backend.once('exit',code=>{clearTimeout(timer);reject(new Error(`本地服务退出 (${code})\n${logs}`));});
    });
    if (quitting) return;
    window=new BrowserWindow({width:1600,height:1040,minWidth:1080,minHeight:760,show:false,backgroundColor:'#11131b',title:'Visiki · 音乐视频编辑器',autoHideMenuBar:true,icon:path.join(root,'dist','branding',process.platform === 'win32' ? 'visiki.ico' : 'visiki.png'),
      webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,preload:path.join(__dirname,'preload.cjs')}});
    ipcMain.on('visiki-open-effect', (event, request) => {
      if(!window || window.isDestroyed() || event.sender !== window.webContents || !request || typeof request.url!=='string' || typeof request.key!=='string' || request.key.length>360) return;
      let address;
      try { address=new URL(request.url); if(address.origin!==`http://127.0.0.1:${port}` || address.pathname!=='/' || address.searchParams.get('visikiEffect')!=='1') return; } catch { return; }
      const existing=effectWindows.get(request.key);
      if(existing && !existing.isDestroyed()){if(existing.isMinimized())existing.restore();existing.show();existing.focus();return;}
      const editor=new BrowserWindow({width:960,height:720,minWidth:430,minHeight:520,show:false,parent:window,backgroundColor:'#14151e',title:'Visiki · 音频效果',autoHideMenuBar:true,
        webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
      if(process.platform!=='darwin')editor.removeMenu();
      effectWindows.set(request.key,editor);
      editor.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      editor.webContents.on('will-navigate',(navigation,url)=>{if(url!==address.href)navigation.preventDefault();});
      editor.once('ready-to-show',()=>editor.show());
      editor.once('closed',()=>effectWindows.delete(request.key));
      editor.loadURL(address.href).catch(error=>log('Effect window failed: '+error.message));
    });
    window.once('closed',()=>{for(const editor of effectWindows.values())if(!editor.isDestroyed())editor.close();effectWindows.clear();});
    if (process.platform !== 'darwin') window.removeMenu();
    if((process.env.VISIKI_SMOKE ?? process.env.ECHO_SMOKE)!=='1') window.once('ready-to-show',showMainWindow);
    window.webContents.setWindowOpenHandler(({url})=>{
      if(url.startsWith(`http://127.0.0.1:${port}/api/export/`)) { window.webContents.downloadURL(url); }
      return {action:'deny'};
    });
    window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(`http://127.0.0.1:${port}/`))event.preventDefault();});
    window.webContents.session.on('will-download',(_event,item)=>{
      item.setSaveDialogOptions({defaultPath:path.join(root,'.demo-data','exports',item.getFilename()),title:'保存导出视频或工程'});
    });
    await window.loadURL(`http://127.0.0.1:${port}`);
    if((process.env.VISIKI_SMOKE ?? process.env.ECHO_SMOKE)!=='1') showMainWindow();
}
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{
  quitting=true;
  if(quitComplete || !backend || backend.exitCode!==null || backend.signalCode!==null) return;
  event.preventDefault();
  if(shutdownTimer) return;
  const worker=backend;
  const finish=()=>{
    if(quitComplete) return;
    quitComplete=true; clearTimeout(shutdownTimer); shutdownTimer=undefined;
    app.quit();
  };
  worker.once('exit',finish);
  shutdownTimer=setTimeout(()=>{try{worker.kill();}catch{}finish();},2500);
  // Only this application's own fork receives the shutdown message. The server
  // also cleans up on IPC disconnect if the desktop process exits unexpectedly.
  if(worker.connected) {try{worker.send({type:'visiki-shutdown'},()=>{});}catch{}}
});
try {
  initialize();
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    app.on('second-instance',showMainWindow);
    app.on('activate',showMainWindow);
    app.whenReady().then(start).catch(fail);
  }
} catch(error) { fail(error); }
