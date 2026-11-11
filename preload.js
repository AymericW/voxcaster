const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set([
  'config:get', 'config:setClientId',
  'auth:login', 'auth:logout',
  'media:get', 'player:state', 'player:cmd', 'player:queue', 'player:playContext',
  'discover', 'playlists',
  'ui:expand', 'ui:pin', 'ui:minimize', 'ui:close', 'ui:open', 'ui:menu',
]);

contextBridge.exposeInMainWorld('mini', {
  call(channel, ...args) {
    if (!CHANNELS.has(channel)) throw new Error('Unknown channel: ' + channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  onMedia(cb) {
    ipcRenderer.on('media:state', (_e, state) => cb(state));
  },
  onLoggedOut(cb) {
    ipcRenderer.on('auth:loggedOut', () => cb());
  },
  drag(phase) {
    if (['start', 'move', 'end'].includes(phase)) ipcRenderer.send('drag:' + phase);
  },
});
