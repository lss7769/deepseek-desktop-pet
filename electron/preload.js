const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:set-ignore-mouse', ignore),
  moveWindow: (dx, dy) => ipcRenderer.send('pet:move-window', dx, dy),
  openContextMenu: () => ipcRenderer.send('pet:context-menu'),
  chat: (message) => ipcRenderer.invoke('pet:chat', message),
  tts: (text) => ipcRenderer.invoke('pet:tts', text),
  getConfig: () => ipcRenderer.invoke('pet:config-get'),
  setConfig: (patch) => ipcRenderer.invoke('pet:config-set', patch),
  onSayRandom: (cb) => ipcRenderer.on('pet:say-random', () => cb()),
  onOpenChat: (cb) => ipcRenderer.on('pet:open-chat', () => cb()),
  onSetKey: (cb) => ipcRenderer.on('pet:set-key', () => cb()),
  onSetMuted: (cb) => ipcRenderer.on('pet:set-muted', (_e, m) => cb(m)),
  onVoiceChanged: (cb) => ipcRenderer.on('pet:voice-changed', () => cb())
});
