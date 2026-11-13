const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('farm', {
  getSetup: () => ipcRenderer.invoke('get-setup'),
  layout: (rects) => ipcRenderer.send('layout', rects),
  dragging: (on) => ipcRenderer.send('dragging', on),
  setSplit: (split) => ipcRenderer.send('set-split', split),
  panel: (id, action) => ipcRenderer.send('panel-action', { id, action }),
  window: (action) => ipcRenderer.send('window', action),
  openLogin: () => ipcRenderer.send('open-login'),
  setupDone: (skipped) => ipcRenderer.send('setup-done', !!skipped),
  setupRelaunch: () => ipcRenderer.send('setup-relaunch'),
  setupPopout: (i) => ipcRenderer.send('setup-popout', i),
  setEconomy: (on) => ipcRenderer.send('set-economy', on),
  setSmartAudio: (on) => ipcRenderer.send('set-smart-audio', on),
  getReport: () => ipcRenderer.invoke('get-report'),
  toastAction: (action) => ipcRenderer.send('toast-action', action),
  screenshot: () => ipcRenderer.send('screenshot'),
  getProfiles: () => ipcRenderer.invoke('profiles-get'),
  saveProfile: (name, list) => ipcRenderer.invoke('profiles-save', name, list),
  deleteProfile: (name) => ipcRenderer.invoke('profiles-delete', name),
  applyProfile: (name) => ipcRenderer.invoke('profiles-apply', name),
  setNotifyLive: (on) => ipcRenderer.send('set-notify-live', on),
  setStreams: (list) => ipcRenderer.invoke('streams-set', list),
  resetStreams: () => ipcRenderer.invoke('streams-reset'),
  parseStream: (text, platform) => ipcRenderer.invoke('streams-parse', text, platform),
  verifyStream: (platform, channel) => ipcRenderer.invoke('streams-verify', platform, channel),
  setTwitchAutoClaim: (on) => ipcRenderer.send('set-twitch-autoclaim', on),
  restartApp: () => ipcRenderer.send('restart-app'),
  discordGet: () => ipcRenderer.invoke('discord-get'),
  discordSet: (url) => ipcRenderer.invoke('discord-set', url),
  discordTest: (url) => ipcRenderer.invoke('discord-test', url),
  discordPrefs: (o) => ipcRenderer.invoke('discord-prefs', o),
  discordItems: (on) => ipcRenderer.invoke('discord-items', on),
  toggleWatchdog: () => ipcRenderer.send('toggle-watchdog'),
  on: (channel, fn) => {
    const allowed = ['panel-status', 'extensions', 'window-state', 'global-status', 'streams-changed', 'toast', 'metrics', 'game-stats', 'toggle-focus', 'shortcut'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  }
});
