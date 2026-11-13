'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  setMode: (m) => ipcRenderer.invoke('setMode', m),
  detect: () => ipcRenderer.invoke('detect'),
  pick: () => ipcRenderer.invoke('pick'),
  update: () => ipcRenderer.invoke('update'),
  play: () => ipcRenderer.invoke('play'),
  ext: (key) => ipcRenderer.invoke('ext', key),
  win: (action) => ipcRenderer.send('win', action),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
});
