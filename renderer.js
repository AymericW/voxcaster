const $ = (id) => document.getElementById(id);
const call = (...args) => window.mini.call(...args);
const appEl = $('app');

const POLL_ACTIVE_MS = 4000; // mouse over the player
const POLL_IDLE_MS = 20000; // playing, not looking
const POLL_PAUSED_MS = 60000; // paused, nothing playing, minimized or rate-limited without a time
const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" class="stroke"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" class="stroke"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24" class="stroke"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>',
};

let mode = 'player';
let state = null;
let fetchedAt = 0;
let expanded = false;
let view = null; // open panel: 'discover' | 'playlists' | null
let discoverSeed = null;
let playlists = null;
let pollTimer = null;
let polling = false;
let notice = null; // shown in place of the artist line, e.g. "Spotify rate limit · back at 10:04"
let preview = null;
let lastArt = null;

// ---------- helpers ----------

function fmt(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Pick a vivid, readable accent colour from the album art.
function extractAccent(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 24;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 24, 24);
      const d = ctx.getImageData(0, 0, 24, 24).data;
      let r = 0, g = 0, b = 0, w = 0;
      for (let i = 0; i < d.length; i += 4) {
        const max = Math.max(d[i], d[i + 1], d[i + 2]);
        const min = Math.min(d[i], d[i + 1], d[i + 2]);
        const sat = max - min;
        if (max < 40 || sat < 30) continue;
        r += d[i] * sat; g += d[i + 1] * sat; b += d[i + 2] * sat; w += sat;
      }
      if (!w) return setAccent(null);
      setAccent(toReadable(r / w, g / w, b / w));
    } catch { setAccent(null); }
  };
  img.onerror = () => setAccent(null);
  img.src = url;
}

function toReadable(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const dlt = max - min;
  const s = dlt === 0 ? 0 : dlt / (1 - Math.abs(2 * l - 1));
  if (dlt) {
    if (max === r) h = ((g - b) / dlt) % 6;
    else if (max === g) h = (b - r) / dlt + 2;
    else h = (r - g) / dlt + 4;
  }
  h = Math.round(h * 60 + 360) % 360;
  return `hsl(${h} ${Math.round(Math.max(s, 0.55) * 100)}% ${Math.round(Math.min(Math.max(l, 0.58), 0.7) * 100)}%)`;
}

function setAccent(color) {
  document.documentElement.style.setProperty('--accent', color || '#1ed760');
}

// ---------- modes ----------

async function showSetup(cfg) {
  mode = 'setup';
  stopPolling();
  appEl.classList.remove('mode-player');
  appEl.classList.add('mode-setup');
  cfg = cfg || (await call('config:get')).data;
  $('redirect').textContent = cfg.redirectUri;
  $('client-id').value = cfg.clientId || '';
  await call('ui:expand', true);
}

async function showPlayer() {
  mode = 'player';
  appEl.classList.remove('mode-setup');
  appEl.classList.add('mode-player');
  await call('ui:expand', expanded);
  startPolling();
}

// ---------- player ----------

// Now-playing info normally arrives from Windows' media controls (pushed, free).
// The API polling below is only the fallback, e.g. when Spotify plays on another device.
let mediaLive = false;

function applyMedia(s) {
  if (s) {
    mediaLive = true;
    stopPolling();
    state = s;
    fetchedAt = performance.now();
    notice = null;
    render();
  } else if (mediaLive) {
    mediaLive = false;
    if (mode === 'player') schedulePoll(3000);
  }
}
window.mini.onMedia((s) => { if (mode === 'player') applyMedia(s); });

async function startPolling() {
  const r = await call('media:get');
  if (r.ok && r.data) return applyMedia(r.data);
  schedulePoll(3000); // give the Windows bridge a moment to report before using the API
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, ms);
}

// Spotify's API quota is small, so only ask as often as the UI needs:
// often while you're looking at the player, rarely otherwise, and right when the song should end.
function nextPollDelay() {
  if (document.hidden) return POLL_PAUSED_MS;
  if (!state?.title || !state.isPlaying) return POLL_PAUSED_MS;
  const base = appEl.matches(':hover') ? POLL_ACTIVE_MS : POLL_IDLE_MS;
  const remaining = state.duration - currentProgress();
  return Math.max(1500, Math.min(base, remaining + 1000));
}

async function poll() {
  if (mode !== 'player' || polling || mediaLive) return;
  polling = true;
  clearTimeout(pollTimer);
  const r = await call('player:state').finally(() => { polling = false; });
  if (mode !== 'player' || mediaLive) return;

  if (!r.ok) {
    if (r.needsAuth) return showSetup();
    notice = r.error;
    render();
    return schedulePoll(r.retryAt ? Math.max(5000, r.retryAt - Date.now()) : POLL_PAUSED_MS);
  }
  if (r.data.skipped) return schedulePoll(POLL_PAUSED_MS); // PC idle or locked
  state = r.data;
  fetchedAt = performance.now();
  notice = null;
  render();
  schedulePoll(nextPollDelay());
}

// Catch up right away when you come back to the player.
appEl.addEventListener('pointerenter', () => {
  if (mode !== 'player' || notice || mediaLive) return;
  if (performance.now() - fetchedAt > 3000) poll();
  else schedulePoll(POLL_ACTIVE_MS); // replace a slower poll already scheduled
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll();
});

function render() {
  const s = state;
  const playing = !!(s && s.title);
  appEl.classList.toggle('playing', !!(playing && s.isPlaying));

  $('title').textContent = playing ? s.title : 'Nothing playing';
  $('artist').textContent = notice || (playing ? s.artist : s?.device ? `Connected to ${s.device}` : 'Start something in Spotify');
  $('artist').classList.toggle('notice', !!notice);
  $('duration').textContent = fmt(playing ? s.duration : 0);

  const art = playing ? s.art : null;
  if (art !== lastArt) {
    lastArt = art;
    const img = $('art');
    if (art) {
      img.src = art;
      $('bg').style.backgroundImage = `url("${art}")`;
      $('bg').classList.add('on');
      extractAccent(art);
    } else {
      img.removeAttribute('src');
      $('bg').classList.remove('on');
      setAccent(null);
    }
    $('art-wrap').classList.toggle('has-art', !!art);
  }

  if (view === 'discover' && playing && s.mainArtist && s.mainArtist !== discoverSeed) {
    $('d-sub').textContent = `Tap ↻ for songs like ${s.mainArtist}`;
  }
  markCurrentPlaylist();
  tick();
}

function currentProgress() {
  if (!state?.title) return 0;
  const p = state.progress + (state.isPlaying ? performance.now() - fetchedAt : 0);
  return Math.min(p, state.duration);
}

function tick() {
  const p = currentProgress();
  $('elapsed').textContent = fmt(p);
  $('fill').style.width = state?.duration ? `${(p / state.duration) * 100}%` : '0%';
}
setInterval(tick, 250);

async function cmd(name, arg) {
  // Optimistic UI so buttons feel instant.
  if (state && (name === 'play' || name === 'pause')) {
    state.progress = currentProgress();
    fetchedAt = performance.now();
    state.isPlaying = name === 'play';
    render();
  }
  const r = await call('player:cmd', name, arg);
  if (!r.ok) {
    if (r.needsAuth) return showSetup();
    toast(r.error);
  }
  setTimeout(poll, name === 'next' || name === 'prev' ? 350 : 200);
}

$('btn-play').onclick = () => cmd(state?.isPlaying ? 'pause' : 'play');
$('btn-next').onclick = () => cmd('next');
$('btn-prev').onclick = () => cmd('prev');
$('bar').onclick = (e) => {
  if (!state?.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const ms = ((e.clientX - rect.left) / rect.width) * state.duration;
  state.progress = ms;
  fetchedAt = performance.now();
  tick();
  cmd('seek', ms);
};
$('art-wrap').onclick = () => { if (state?.url) call('ui:open', state.url); };

// ---------- panels ----------

// Opening the panel that's already open closes it.
async function togglePanel(next) {
  view = view === next ? null : next;
  expanded = !!view;
  appEl.dataset.view = view || '';
  appEl.classList.toggle('expanded', expanded);
  $('btn-discover').classList.toggle('on', view === 'discover');
  $('btn-playlists').classList.toggle('on', view === 'playlists');
  await call('ui:expand', expanded);
  if (view !== 'discover') stopPreview();

  if (view === 'discover') {
    if (state?.mainArtist && state.mainArtist !== discoverSeed) loadDiscover();
    else if (!state?.mainArtist && !discoverSeed) {
      $('d-list').innerHTML = '<li class="d-empty">Play a song and I\'ll intercept similar signals.</li>';
    }
  } else if (view === 'playlists' && !playlists) {
    loadPlaylists();
  }
}

// ---------- playlists ----------

async function loadPlaylists() {
  $('btn-p-refresh').classList.add('spin');
  if (!playlists) {
    $('p-list').innerHTML = Array.from({ length: 6 }, () =>
      '<li class="track skeleton"><div class="thumb"><div class="ph"></div></div><div class="t"><div class="n">.</div><div class="b">.</div></div></li>').join('');
  }
  const r = await call('playlists');
  $('btn-p-refresh').classList.remove('spin');

  if (!r.ok) {
    if (r.needsAuth) return showSetup();
    playlists = null;
    $('p-list').innerHTML = r.needsScope
      ? `<li class="d-empty">The app needs permission to read your playlists.<br><br>
           <button class="chip" id="btn-allow">Allow access in Spotify</button></li>`
      : `<li class="d-empty">${esc(r.error)}</li>`;
    const allow = $('btn-allow');
    if (allow) allow.onclick = allowPlaylists;
    return;
  }
  playlists = r.data;
  $('p-sub').textContent = `${playlists.length} playlist${playlists.length === 1 ? '' : 's'} · click to play`;
  renderPlaylists();
}

async function allowPlaylists() {
  $('p-list').innerHTML = '<li class="d-empty">Finish in your browser…</li>';
  const r = await call('auth:login');
  if (!r.ok) {
    $('p-list').innerHTML = `<li class="d-empty">${esc(r.error)}</li>`;
    return;
  }
  loadPlaylists();
}

function renderPlaylists() {
  if (!playlists) return;
  const q = $('p-filter').value.trim().toLowerCase();
  const shown = q ? playlists.filter((p) => p.name.toLowerCase().includes(q)) : playlists;
  const list = $('p-list');
  list.innerHTML = '';
  if (!shown.length) {
    list.innerHTML = `<li class="d-empty">${q ? 'No playlists match' : 'No playlists yet'}</li>`;
    return;
  }
  for (const p of shown) list.appendChild(playlistRow(p));
  markCurrentPlaylist();
}

function playlistRow(p) {
  const li = document.createElement('li');
  li.className = 'track clickable';
  li.dataset.uri = p.uri;
  li.title = `Play ${p.name}`;
  const meta = [p.count != null && `${p.count} song${p.count === 1 ? '' : 's'}`, p.owner].filter(Boolean).join(' · ');
  li.innerHTML = `
    <div class="thumb">
      ${p.image ? `<img alt="" src="${esc(p.image)}">` : `<div class="ph">${ICONS.note}</div>`}
      <span class="eq"><i></i><i></i><i></i></span>
    </div>
    <div class="t"><div class="n">${esc(p.name)}</div><div class="b">${esc(meta)}</div></div>
    <button class="ic sh" title="Shuffle play">${ICONS.shuffle}</button>
    <button class="ic pl" title="Play">${ICONS.play}</button>`;

  li.onclick = (e) => playPlaylist(p, !!e.target.closest('.sh'));
  return li;
}

async function playPlaylist(p, shuffle) {
  const r = await call('player:playContext', { uri: p.uri, shuffle });
  if (!r.ok) {
    if (r.needsAuth) return showSetup();
    return toast(r.error);
  }
  if (state) state.contextUri = p.uri;
  markCurrentPlaylist();
  toast(`${shuffle ? 'Shuffling' : 'Playing'} “${p.name}”`);
  setTimeout(poll, 500);
}

function markCurrentPlaylist() {
  const uri = state?.contextUri;
  for (const li of document.querySelectorAll('#p-list .track[data-uri]')) {
    li.classList.toggle('current', li.dataset.uri === uri);
  }
}

$('btn-playlists').onclick = () => togglePanel('playlists');
$('btn-p-refresh').onclick = () => loadPlaylists();
$('p-filter').addEventListener('input', renderPlaylists);
$('p-filter').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; renderPlaylists(); e.target.blur(); }
});

// ---------- discover ----------

async function loadDiscover() {
  const artist = state?.mainArtist;
  if (!artist) return toast('Play a song first');
  discoverSeed = artist;
  stopPreview();
  $('d-sub').textContent = `Similar to ${artist}`;
  $('btn-refresh').classList.add('spin');
  $('d-list').innerHTML = Array.from({ length: 6 }, () =>
    '<li class="track skeleton"><img alt=""><div class="t"><div class="n">.</div><div class="b">.</div></div></li>').join('');

  const r = await call('discover', { artist });
  $('btn-refresh').classList.remove('spin');
  if (discoverSeed !== artist) return;
  if (!r.ok) {
    $('d-list').innerHTML = `<li class="d-empty">${esc(r.error)}</li>`;
    return;
  }
  if (!r.data.length) {
    $('d-list').innerHTML = '<li class="d-empty">No suggestions this time. Try ↻</li>';
    return;
  }
  $('d-list').innerHTML = '';
  for (const t of r.data) $('d-list').appendChild(trackRow(t));
}

function trackRow(t) {
  const li = document.createElement('li');
  li.className = 'track';
  li.innerHTML = `
    <img alt="" ${t.art ? `src="${esc(t.art)}"` : ''}>
    <div class="t"><div class="n">${esc(t.title)}</div><div class="b">${esc(t.artist)}</div></div>
    ${t.preview ? `<button class="ic pv" title="Preview 30s">${ICONS.play}</button>` : ''}
    <button class="ic add" title="Add to Spotify queue">${ICONS.plus}</button>`;

  const pv = li.querySelector('.pv');
  if (pv) pv.onclick = () => togglePreview(t.preview, pv);

  const add = li.querySelector('.add');
  add.onclick = async () => {
    if (add.classList.contains('done')) return;
    add.disabled = true;
    const r = await call('player:queue', { title: t.title, artist: t.artist });
    add.disabled = false;
    if (!r.ok) {
      if (r.needsAuth) return showSetup();
      return toast(r.error);
    }
    add.classList.add('done');
    add.innerHTML = ICONS.check;
    add.title = 'Added to queue';
    toast(`Queued “${r.data.name}”`);
  };
  return li;
}

function togglePreview(url, btn) {
  if (preview?.btn === btn) return stopPreview();
  stopPreview();
  const audio = new Audio(url);
  audio.volume = 0.8;
  audio.onended = stopPreview;
  audio.play().catch(() => { toast('Preview unavailable'); stopPreview(); });
  preview = { audio, btn };
  btn.classList.add('on');
  btn.innerHTML = ICONS.stop;
}

function stopPreview() {
  if (!preview) return;
  preview.audio.pause();
  preview.btn.classList.remove('on');
  preview.btn.innerHTML = ICONS.play;
  preview = null;
}

$('btn-discover').onclick = () => togglePanel('discover');
$('btn-refresh').onclick = () => loadDiscover();

// ---------- window controls ----------

// Drag the window from any empty spot; controls and text fields keep their clicks.
let dragging = false;
let dragFrame = 0;
appEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button, input, a, code, .bar, .list, #setup ol')) return;
  dragging = true;
  appEl.setPointerCapture(e.pointerId);
  window.mini.drag('start');
});
appEl.addEventListener('pointermove', () => {
  if (!dragging || dragFrame) return;
  dragFrame = requestAnimationFrame(() => {
    dragFrame = 0;
    window.mini.drag('move');
  });
});
const endDrag = (e) => {
  if (!dragging) return;
  dragging = false;
  appEl.releasePointerCapture(e.pointerId);
  window.mini.drag('end');
};
appEl.addEventListener('pointerup', endDrag);
appEl.addEventListener('pointercancel', endDrag);

$('btn-close').onclick = () => call('ui:close');
$('btn-min').onclick = () => call('ui:minimize');
$('btn-menu').onclick = () => call('ui:menu');
window.mini.onLoggedOut(() => {
  playlists = null;
  showSetup();
});
function setPinUI(on) {
  $('btn-pin').classList.toggle('on', on);
  $('btn-pin').title = on ? 'Pinned on top (click to unpin)' : 'Not pinned (click to keep on top)';
}
$('btn-pin').onclick = async () => {
  const r = await call('ui:pin', !$('btn-pin').classList.contains('on'));
  if (!r.ok) return toast(r.error);
  setPinUI(r.data);
  toast(r.data ? 'Pinned on top' : 'Unpinned');
};

document.addEventListener('keydown', (e) => {
  if (mode !== 'player' || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); $('btn-play').click(); }
  else if (e.key === 'ArrowRight') cmd('next');
  else if (e.key === 'ArrowLeft') cmd('prev');
  else if (e.key.toLowerCase() === 'd') togglePanel('discover');
  else if (e.key.toLowerCase() === 'p') togglePanel('playlists');
});

// ---------- setup ----------

$('link-dash').onclick = (e) => { e.preventDefault(); call('ui:open', 'https://developer.spotify.com/dashboard'); };
$('btn-copy').onclick = async () => {
  await navigator.clipboard.writeText($('redirect').textContent);
  $('btn-copy').textContent = 'Copied';
  setTimeout(() => ($('btn-copy').textContent = 'Copy'), 1500);
};

function setStatus(msg, err = false) {
  $('setup-status').textContent = msg;
  $('setup-status').classList.toggle('err', err);
}

$('btn-connect').onclick = async () => {
  const btn = $('btn-connect');
  const saved = await call('config:setClientId', $('client-id').value);
  if (!saved.ok) return setStatus(saved.error, true);

  btn.disabled = true;
  setStatus('Finish logging in in your browser…');
  const r = await call('auth:login');
  btn.disabled = false;
  if (!r.ok) return setStatus(r.error, true);
  setStatus('');
  showPlayer();
};
$('client-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-connect').click(); });

// ---------- boot ----------

(async () => {
  const cfg = (await call('config:get')).data;
  setPinUI(cfg.pinned);
  if (!cfg.loggedIn) showSetup(cfg);
  else showPlayer();
})();
