const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('visikiDesktop', Object.freeze({
  openEffect(request) {
    if(request && typeof request.url==='string' && typeof request.key==='string') ipcRenderer.send('visiki-open-effect', { url:request.url, key:request.key });
  },
}));
