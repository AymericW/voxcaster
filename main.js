const { app, BrowserWindow, ipcMain, shell, screen, Menu, powerMonitor } = require('electron');
const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Keep settings in the same folder whether run from source or installed
// (the installed app's name would otherwise give it a different folder).
app.setPath('userData', path.join(app.getPath('appData'), 'voxcaster'));

// Carry settings (login, position) over from when the app was called Spotify Mini.
(function migrateLegacyConfig() {
  const legacy = path.join(app.getPath('appData'), 'spotify-mini', 'config.json');
  const current = path.join(app.getPath('userData'), 'config.json');
  if (fs.existsSync(current) || !fs.existsSync(legacy)) return;
  fs.mkdirSync(path.dirname(current), { recursive: true });
  fs.copyFileSync(legacy, current);
})();

const REDIRECT_PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');
const PLAYLIST_SCOPES = ['playlist-read-private', 'playlist-read-collaborative'];

// Window sizes include an 8px transparent margin on each side for the shadow.
const COMPACT = { width: 400, height: 150 };
const EXPANDED = { width: 400, height: 540 };

let win = null;
let grewUp = false;

// ---------- config ----------

let config = {};
const configPath = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try { config = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { config = {}; }
}

function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

function clearTokens() {
  delete config.accessToken;
  delete config.refreshToken;
  delete config.expiresAt;
  delete config.scope;
  saveConfig();
}

// ---------- start with Windows ----------

// Only the installed app registers itself: from source, the login item
// would point at the bare Electron binary instead of this app.
function applyAutoStart() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: config.autoStart !== false });
}

function showMenu() {
  Menu.buildFromTemplate([
    {
      label: app.isPackaged ? 'Start with Windows' : 'Start with Windows (installed app only)',
      type: 'checkbox',
      checked: app.isPackaged && config.autoStart !== false,
      enabled: app.isPackaged,
      click: (item) => {
        config.autoStart = item.checked;
        saveConfig();
        applyAutoStart();
      },
    },
    { type: 'separator' },
    {
      label: 'Disconnect Spotify',
      enabled: !!config.refreshToken,
      click: () => {
        clearTokens();
        win.webContents.send('auth:loggedOut');
      },
    },
    { label: 'Quit', click: () => app.quit() },
  ]).popup({ window: win });
}

// ---------- auth (Authorization Code + PKCE, no client secret needed) ----------

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function authError(message = 'Not connected to Spotify') {
  const e = new Error(message);
  e.needsAuth = true;
  return e;
}

let authServer = null;

function login() {
  return new Promise((resolve, reject) => {
    if (!config.clientId) return reject(new Error('Add your Client ID first'));

    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(12));

    if (authServer) authServer.close();
    authServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/callback') { res.writeHead(404); return res.end(); }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const ok = code && url.searchParams.get('state') === state;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackPage(ok ? 'Vox link established. You can close this tab.' : `Login failed: ${error || 'state mismatch'}`));
      authServer.close();
      authServer = null;
      win?.show();
      win?.focus();

      if (!ok) return reject(new Error(error || 'Login failed'));
      try {
        await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier });
        resolve();
      } catch (e) { reject(e); }
    });
    authServer.on('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`Port ${REDIRECT_PORT} is busy`) : e));
    authServer.listen(REDIRECT_PORT, '127.0.0.1', () => {
      const params = new URLSearchParams({
        client_id: config.clientId,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        scope: SCOPES,
        state,
      });
      shell.openExternal('https://accounts.spotify.com/authorize?' + params);
    });
  });
}

function callbackPage(msg) {
  return `<!doctype html><meta charset="utf-8"><title>Voxcaster</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#121214;color:#fff;font-family:Segoe UI,system-ui,sans-serif">
<div style="text-align:center"><div style="font-size:40px">🎧</div><p style="font-size:18px">${msg}</p></div></body>`;
}

async function tokenRequest(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, ...params }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(d.error_description || d.error || `Token request failed (${r.status})`);
    e.code = d.error;
    throw e;
  }
  config.accessToken = d.access_token;
  if (d.refresh_token) config.refreshToken = d.refresh_token;
  if (d.scope) config.scope = d.scope;
  config.expiresAt = Date.now() + (d.expires_in - 60) * 1000;
  saveConfig();
}

async function getToken() {
  if (!config.refreshToken) throw authError();
  if (!config.accessToken || Date.now() > config.expiresAt) {
    try {
      await tokenRequest({ grant_type: 'refresh_token', refresh_token: config.refreshToken });
    } catch (e) {
      if (e.code === 'invalid_grant' || e.code === 'invalid_client') { clearTokens(); throw authError(); }
      throw e;
    }
  }
  return config.accessToken;
}

// ---------- Spotify Web API ----------

// Spotify rate-limits per endpoint family and says how long to back off (Retry-After).
// Honour it locally: retrying early only extends the ban.
const backoffUntil = new Map();
const limitKey = (endpoint) => endpoint.split('?')[0].split('/').slice(0, 3).join('/');

function rateLimitError(until) {
  const at = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const e = new Error(`Spotify rate limit · back at ${at}`);
  e.retryAt = until;
  return e;
}

async function spotify(method, endpoint, body, retried = false) {
  const key = limitKey(endpoint);
  if (Date.now() < (backoffUntil.get(key) || 0)) throw rateLimitError(backoffUntil.get(key));

  const token = await getToken();
  const r = await fetch('https://api.spotify.com/v1' + endpoint, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && !retried) {
    config.expiresAt = 0;
    return spotify(method, endpoint, body, true);
  }
  if (r.status === 429) {
    const until = Date.now() + (Number(r.headers.get('retry-after')) || 30) * 1000;
    backoffUntil.set(key, until);
    throw rateLimitError(until);
  }
  if (r.status === 204) return null;
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!r.ok) {
    const reason = data?.error?.reason;
    const e = new Error(
      reason === 'NO_ACTIVE_DEVICE' ? 'Open Spotify on a device first'
        : reason === 'PREMIUM_REQUIRED' ? 'Spotify Premium is required for this'
          : data?.error?.message || `Spotify error ${r.status}`,
    );
    e.reason = reason;
    throw e;
  }
  return data;
}

async function playerState() {
  const d = await spotify('GET', '/me/player?additional_types=episode');
  if (!d || !d.item) return { active: !!d, device: d?.device?.name || null };
  const item = d.item;
  const isEpisode = item.type === 'episode';
  const images = isEpisode ? item.images || item.show?.images : item.album?.images;
  return {
    active: true,
    id: item.id,
    uri: item.uri,
    url: item.external_urls?.spotify,
    title: item.name,
    artist: isEpisode ? item.show?.name : item.artists.map((a) => a.name).join(', '),
    mainArtist: isEpisode ? null : item.artists[0]?.name,
    album: isEpisode ? item.show?.name : item.album?.name,
    art: images?.[0]?.url || null,
    duration: item.duration_ms,
    progress: d.progress_ms || 0,
    isPlaying: d.is_playing,
    device: d.device?.name || null,
    contextUri: d.context?.uri || null,
  };
}

// Playback fails with NO_ACTIVE_DEVICE when Spotify is open but idle;
// retry on the first available device so play still works.
async function withDevice(run) {
  try {
    return await run('');
  } catch (e) {
    if (e.reason !== 'NO_ACTIVE_DEVICE') throw e;
    const { devices = [] } = (await spotify('GET', '/me/player/devices')) || {};
    const device = devices.find((d) => !d.is_restricted);
    if (!device) throw e;
    return run(device.id);
  }
}

async function playerCmd(cmd, arg) {
  // Play/pause/skip go straight to the Spotify app through Windows when possible: no API quota.
  if (['play', 'pause', 'next', 'prev'].includes(cmd) && (await bridgeCmd(cmd))) return null;
  switch (cmd) {
    case 'play': return withDevice((dev) => spotify('PUT', '/me/player/play' + (dev ? `?device_id=${dev}` : '')));
    case 'pause': return spotify('PUT', '/me/player/pause');
    case 'next': return spotify('POST', '/me/player/next');
    case 'prev': return spotify('POST', '/me/player/previous');
    case 'seek': return spotify('PUT', `/me/player/seek?position_ms=${Math.max(0, Math.round(arg))}`);
    default: throw new Error('Unknown command');
  }
}

async function playlists() {
  const granted = (config.scope || '').split(' ');
  if (!PLAYLIST_SCOPES.every((s) => granted.includes(s))) {
    const e = new Error('Spotify needs your OK to show playlists');
    e.needsScope = true;
    throw e;
  }
  const out = [];
  let next = '/me/playlists?limit=50';
  while (next && out.length < 500) {
    const page = await spotify('GET', next);
    for (const p of page?.items || []) {
      if (!p) continue;
      const images = p.images || [];
      out.push({
        uri: p.uri,
        name: p.name,
        image: (images[images.length - 1] || images[0])?.url || null,
        count: p.tracks?.total ?? p.items?.total ?? null,
        owner: p.owner?.display_name || null,
      });
    }
    next = page?.next ? page.next.replace('https://api.spotify.com/v1', '') : null;
  }
  return out;
}

async function playContext({ uri, shuffle }) {
  await withDevice(async (dev) => {
    const q = dev ? `device_id=${dev}` : '';
    if (shuffle) await spotify('PUT', `/me/player/shuffle?state=true${q ? '&' + q : ''}`);
    await spotify('PUT', `/me/player/play${q ? '?' + q : ''}`, { context_uri: uri });
  });
  extras = { ...extras, contextUri: uri };
  scheduleExtras(2500);
}

// ---------- Windows media bridge ----------
// media-bridge.ps1 reads now-playing info from Windows' media controls and pushes it here,
// so showing the current song costs no Spotify API calls. The API is only asked, once per
// track, for what Windows doesn't know: the Spotify link and the playlist playing.

let bridge = null;
let bridgeStartedAt = 0;
let quitting = false;
let media = { available: false };
let mediaArt = null;
let extras = {};
let extrasTimer = null;
let extrasRetries = 0;
const cmdWaiters = [];
const trackKey = (t) => `${t.title}|${t.artist}`;

function startBridge() {
  // PowerShell can't read files inside the app's asar archive, so run a copy.
  const script = path.join(app.getPath('userData'), 'media-bridge.ps1');
  fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, 'media-bridge.ps1')));
  bridgeStartedAt = Date.now();
  bridge = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });

  let buf = '';
  bridge.stdout.setEncoding('utf8');
  bridge.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onBridgeMessage(line);
    }
  });
  bridge.stderr.on('data', (d) => console.error('[media-bridge]', String(d).trim()));
  bridge.on('error', (e) => console.error('[media-bridge]', e.message));
  bridge.on('exit', () => {
    bridge = null;
    cmdWaiters.splice(0).forEach((done) => done(false));
    setMedia({ available: false });
    // Restart it, slowly if it keeps dying right away (e.g. PowerShell blocked).
    if (!quitting) setTimeout(startBridge, Date.now() - bridgeStartedAt < 10000 ? 60000 : 5000);
  });
}

function onBridgeMessage(line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'cmd') return cmdWaiters.shift()?.(m.ok);
  if (m.type === 'state') setMedia(m);
}

function setMedia(m) {
  const changed = m.available && trackKey(m) !== trackKey(media);
  if (changed) mediaArt = m.art || null;
  else if (m.art) mediaArt = m.art;
  const wasAvailable = media.available;
  media = m;
  if (changed) {
    extrasRetries = 0;
    scheduleExtras(1500);
  }
  if (m.available || wasAvailable) pushMedia();
}

function pushMedia() {
  if (win && !win.isDestroyed()) win.webContents.send('media:state', mediaState());
}

function mediaState() {
  if (!media.available) return null;
  const extra = extras.key === trackKey(media) ? extras : {};
  const elapsed = media.isPlaying ? Date.now() - media.updatedAt : 0;
  return {
    source: 'windows',
    active: true,
    title: media.title,
    artist: media.artist,
    album: media.album,
    mainArtist: extra.mainArtist || media.artist?.split(/, | & | feat\.? /i)[0],
    art: mediaArt || extra.art || null,
    url: extra.url || null,
    contextUri: extras.contextUri || null, // the playlist rarely changes between tracks
    duration: media.duration,
    progress: Math.min(Math.max(0, media.position + elapsed), media.duration || Infinity),
    isPlaying: media.isPlaying,
  };
}

// The Spotify link, playlist and main artist come from the API, once per track
// (debounced so skipping through several songs costs one call).
function scheduleExtras(delay) {
  clearTimeout(extrasTimer);
  extrasTimer = setTimeout(async () => {
    if (!media.available || !config.refreshToken) return;
    try {
      const s = await playerState();
      if (!s.title) return;
      if (s.title !== media.title && extrasRetries++ < 2) return scheduleExtras(3000); // API not caught up yet
      extras = { key: trackKey(media), url: s.url, contextUri: s.contextUri, mainArtist: s.mainArtist, art: s.art };
      pushMedia();
    } catch {
      // Rate-limited or offline: the player still works from the Windows data alone.
    }
  }, delay);
}

function bridgeCmd(cmd) {
  if (!bridge || !media.available) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (ok) => { clearTimeout(timer); resolve(ok); };
    const timer = setTimeout(() => {
      const i = cmdWaiters.indexOf(done);
      if (i >= 0) cmdWaiters.splice(i, 1);
      resolve(false);
    }, 3000);
    cmdWaiters.push(done);
    bridge.stdin.write(cmd + '\n');
  });
}

const cleanTitle = (t) => t.replace(/\s*[([].*?[)\]]/g, '').replace(/\s+-\s+.*$/, '').trim();

async function findTrack({ title, artist }) {
  const queries = [`track:${cleanTitle(title)} artist:${artist}`, `${cleanTitle(title)} ${artist}`];
  for (const q of queries) {
    const res = await spotify('GET', `/search?type=track&limit=1&q=${encodeURIComponent(q)}`);
    const t = res?.tracks?.items?.[0];
    if (t) return t;
  }
  throw new Error('Not found on Spotify');
}

async function queueTrack(track) {
  const t = await findTrack(track);
  await spotify('POST', `/me/player/queue?uri=${encodeURIComponent(t.uri)}`);
  return { name: t.name, url: t.external_urls?.spotify };
}

// ---------- discovery (Deezer's public API, no key needed) ----------

async function deezer(p) {
  const r = await fetch('https://api.deezer.com' + p);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || 'Deezer error');
  return d;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function discover({ artist, count = 8 }) {
  const s = await deezer('/search/artist?limit=1&q=' + encodeURIComponent(artist));
  const seed = s.data?.[0];
  if (!seed) throw new Error(`Couldn't find "${artist}" for suggestions`);

  const related = await deezer(`/artist/${seed.id}/related?limit=30`);
  const artists = shuffle(related.data || []).slice(0, count);
  if (!artists.length) throw new Error(`No similar artists found for ${artist}`);

  const picks = await Promise.all(artists.map(async (a) => {
    const top = await deezer(`/artist/${a.id}/top?limit=6`).catch(() => ({ data: [] }));
    const t = shuffle(top.data || [])[0];
    return t && { title: t.title, artist: a.name, art: t.album?.cover_medium, preview: t.preview || null };
  }));
  return picks.filter(Boolean);
}

// ---------- window ----------

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const pos = config.position || { x: wa.x + wa.width - COMPACT.width - 16, y: wa.y + wa.height - COMPACT.height - 16 };

  win = new BrowserWindow({
    ...COMPACT,
    ...pos,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: config.pinned !== false,
    skipTaskbar: false,
    show: false,
    title: 'Voxcaster',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile('index.html');
  win.once('ready-to-show', () => { applyPin(); win.show(); });
  // Windows sometimes drops a window's topmost state when focus moves; re-assert it.
  win.on('blur', () => { if (config.pinned !== false) applyPin(); });

}

function savePosition() {
  const [x, y] = win.getPosition();
  config.position = { x, y: grewUp ? y + (EXPANDED.height - COMPACT.height) : y };
  saveConfig();
}

// Window dragging is done by hand instead of with CSS drag regions:
// on Windows, drag regions swallow clicks and hover on anything near them.
let drag = null;

ipcMain.on('drag:start', () => {
  drag = { cursor: screen.getCursorScreenPoint(), bounds: win.getBounds() };
});
ipcMain.on('drag:move', () => {
  if (!drag) return;
  const p = screen.getCursorScreenPoint();
  // setBounds with a fixed size avoids the window slowly growing on scaled displays.
  win.setBounds({
    x: drag.bounds.x + p.x - drag.cursor.x,
    y: drag.bounds.y + p.y - drag.cursor.y,
    width: drag.bounds.width,
    height: drag.bounds.height,
  });
});
ipcMain.on('drag:end', () => {
  if (!drag) return;
  drag = null;
  savePosition();
});

function applyPin() {
  const pinned = config.pinned !== false;
  // 'screen-saver' sits above the taskbar and most other topmost windows.
  win.setAlwaysOnTop(pinned, 'screen-saver');
  if (pinned) win.moveTop();
}

function setExpanded(expand) {
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const diff = EXPANDED.height - COMPACT.height;
  const target = expand ? EXPANDED : COMPACT;
  if (b.height === target.height) return;
  let y = b.y;
  if (expand) {
    grewUp = b.y + EXPANDED.height > wa.y + wa.height;
    if (grewUp) y = Math.max(wa.y, b.y - diff);
  } else if (grewUp) {
    y = b.y + diff;
    grewUp = false;
  }
  win.setBounds({ x: b.x, y, ...target });
}

// ---------- IPC ----------

function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (e) { return { ok: false, error: e.message, needsAuth: !!e.needsAuth, needsScope: !!e.needsScope, retryAt: e.retryAt || null }; }
  });
}

handle('config:get', () => ({
  clientId: config.clientId || '',
  loggedIn: !!config.refreshToken,
  redirectUri: REDIRECT_URI,
  pinned: config.pinned !== false,
}));
handle('config:setClientId', (id) => {
  const clean = String(id || '').trim();
  if (!/^[a-f0-9]{32}$/i.test(clean)) throw new Error('That doesn\'t look like a Client ID (32 letters/numbers)');
  if (clean !== config.clientId) clearTokens();
  config.clientId = clean;
  saveConfig();
});
handle('auth:login', () => login());
handle('auth:logout', () => clearTokens());
handle('player:state', () => {
  // Don't spend API quota while nobody is at the PC (idle 5+ minutes or locked).
  if (powerMonitor.getSystemIdleState(300) !== 'active') return { skipped: true };
  return playerState();
});
handle('media:get', () => mediaState());
handle('player:cmd', (cmd, arg) => playerCmd(cmd, arg));
handle('player:queue', (track) => queueTrack(track));
handle('player:playContext', (opts) => playContext(opts));
handle('playlists', () => playlists());
handle('discover', (opts) => discover(opts));
handle('ui:expand', (v) => setExpanded(!!v));
handle('ui:pin', (v) => {
  config.pinned = !!v;
  saveConfig();
  applyPin();
  return config.pinned;
});
handle('ui:minimize', () => win.minimize());
handle('ui:menu', () => showMenu());
handle('ui:close', () => win.close());
handle('ui:open', (url) => {
  const u = new URL(url);
  const allowed = ['open.spotify.com', 'developer.spotify.com'];
  if (u.protocol !== 'https:' || !allowed.includes(u.hostname)) throw new Error('Blocked link');
  return shell.openExternal(u.toString());
});

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  app.whenReady().then(() => {
    loadConfig();
    applyAutoStart();
    createWindow();
    startBridge();
  });
  app.on('before-quit', () => {
    quitting = true;
    bridge?.stdin.end(); // the bridge exits when its input closes
  });
  app.on('window-all-closed', () => app.quit());
}
