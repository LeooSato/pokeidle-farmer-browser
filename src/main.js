const {
  app, BrowserWindow, WebContentsView, session, ipcMain, powerSaveBlocker,
  Tray, Menu, nativeImage, shell, Notification, net
} = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { loadExtensions } = require('./extensions');
let kick = require('./kick-probe'); // recarregado a quente quando o arquivo muda
const streams = require('./streams');

// ---------------------------------------------------------------------------
// 1) Nada de dormir: flags do Chromium (precisam vir antes do app "ready")
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-media-suspend');
app.commandLine.appendSwitch('disable-features',
  'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,BackForwardCache,MediaSessionService');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Silencia o spam do Chromium no terminal (Bluetooth, WebRTC da Kick etc.). São avisos inofensivos.
app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('disable-logging');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ---------------------------------------------------------------------------
// Config e estado salvo
// ---------------------------------------------------------------------------
function loadConfig() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'config.json'), // ao lado do .exe (build portable)
    path.join(app.getAppPath(), 'config.json')
  ];
  for (const file of candidates) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* próximo */ }
  }
  throw new Error('config.json não encontrado');
}
const config = loadConfig();

const stateFile = () => path.join(app.getPath('userData'), 'state.json');
let state = {};
function loadState() { try { state = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { state = {}; } }
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2)); } catch { /* ignora */ }
  }, 300);
}

// Log no terminal e em %APPDATA%\pokeidle-farm\farm.log (pra descobrir o motivo de cada reload).
function log(...args) {
  const line = `${new Date().toLocaleString('pt-BR')} ${args.join(' ')}`;
  console.log(line);
  try {
    const file = path.join(app.getPath('userData'), 'farm.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.old');
    fs.appendFileSync(file, line + '\n');
  } catch { /* ignora */ }
}

// ---------------------------------------------------------------------------
// Painéis
// ---------------------------------------------------------------------------
let win = null;
let tray = null;
let ses = null;
let extensionsLoaded = [];
const startedAt = Date.now();
let totalReloads = 0;
let lastReload = null;          // { id, reason, at }
let loginWins = [];             // janelas de login (PokeIdle e Kick)
let updatePending = false;      // arquivo do processo principal mudou: precisa reiniciar
let watchdogPaused = !!(config.watchdog && config.watchdog.enabled === false); // botão na barra de título
const panels = new Map(); // id -> painel
const startInLoginMode = process.argv.includes('--login');

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Lista de lives: a padrão vem do config.json; depois de mexer no "Gerenciar lives" fica salva no state.
const defaultStreams = () => streams.normalizeList((config.streams || []).map((s) => ({ platform: s.platform || 'kick', channel: s.channel || s.id, title: s.title })));
const currentStreams = () => (state.streams ? streams.normalizeList(state.streams) : defaultStreams());
function streamUrl(s) {
  if (s.platform === 'kick' && config.kickPlayerOnly) return `https://player.kick.com/${s.channel}`; // modo leve
  return streams.PLATFORMS[s.platform].url(s.channel);
}

function pushStatus(p) {
  send('panel-status', {
    id: p.id, status: p.status, sleeping: !!p.sleeping, muted: p.view.webContents.isAudioMuted(),
    reloads: p.reloads, totalReloads, zoom: p.view.webContents.getZoomFactor(), lastReason: p.lastReason || null
  });
}

function pushGlobal() {
  send('global-status', { reportAvailable: !!stats.reportAvailable, activeProfile: state.activeProfile || null, smartAudio: !!state.smartAudio, economy: !!state.economy, notifyLive: state.notifyLive !== false, updatePending, userLoading, user: state.user || null, loginOpen: loginWins.length > 0, watchdogPaused, lastReload, totalReloads });
}

function setStatus(p, status) {
  // Lives: depois que já se sabe se está ao vivo ou offline, "carregando/verificando" não aparece mais.
  // A checagem continua em segundo plano e o status só muda quando a live realmente abre (ou cai).
  if (p.kind === 'stream' && p.stable && (status === 'loading' || status === 'checking')) return;
  // Offline: agenda a página pra dormir (sem reiniciar a contagem a cada checagem).
  if (p.kind === 'stream' && status === 'offline' && !p.sleeping && !p.sleepTimer) {
    p.sleepTimer = setTimeout(() => { p.sleepTimer = null; sleepPanel(p); }, SLEEP_AFTER_MS);
  }
  if (p.kind === 'stream' && status !== 'offline' && p.sleepTimer) { clearTimeout(p.sleepTimer); p.sleepTimer = null; }
  if (p.status === status) return;
  p.status = status;
  if (p.kind === 'stream' && (status === 'offline' || status === 'live')) {
    if (status === 'live' && p.stable === 'offline') notifyLive(p);
    p.stable = status;
  }
  pushStatus(p);
}

// ---------------------------------------------------------------------------
// Live offline "dorme": a página é descarregada (economiza RAM e CPU) e a API da
// Kick/Twitch é consultada a cada 2 min. Quando o streamer abre, a live carrega de novo.
// Se a API não responder 3 vezes seguidas, acorda a página e não dorme mais (plano B).
// ---------------------------------------------------------------------------
const SLEEP_AFTER_MS = Number(process.env.FARM_SLEEP_AFTER_MS) || 3 * 60000;
const SLEEP_POLL_MS = Number(process.env.FARM_SLEEP_POLL_MS) || 2 * 60000;
const SLEEP_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0e14;color:#8a93a6;font:13px system-ui,sans-serif;text-align:center"><div><div style="font-size:28px">💤</div><p style="margin:8px 0 0">Offline. A página está dormindo pra economizar.</p><p style="margin:4px 0 0;opacity:.7">Abre sozinha quando o streamer entrar ao vivo.</p></div></body></html>`);
function sleepEnabled() { return state.sleepOffline !== false; }
async function sleepPanel(p) {
  if (!panels.has(p.id) || p.sleeping || p.paused || p.status !== 'offline' || !sleepEnabled() || p.apiBroken) return;
  const r = await streams.verify(ses, p.platform, p.channel).catch(() => ({ exists: null }));
  if (r.exists === null) { log(`[${p.id}] API não respondeu, a página continua aberta`); return; }
  if (r.live || p.status !== 'offline') return;
  p.sleeping = true; p.apiFails = 0;
  clearTimeout(p.retryTimer);
  log(`[${p.id}] offline: página dormindo, checando pela API a cada 2 min`);
  clearInterval(p.quickTimer);
  p.view.webContents.loadURL(SLEEP_PAGE).catch(() => {});
  pushStatus(p);
}
function wakePanel(p, reason) {
  if (!p.sleeping) return;
  p.sleeping = false;
  log(`[${p.id}] acordando: ${reason}`);
  p.failed = true; // força loadURL da URL original
  reloadPanel(p, reason, { auto: false });
}
async function pollSleeping() {
  for (const p of panels.values()) {
    if (!p.sleeping) continue;
    const r = await streams.verify(ses, p.platform, p.channel).catch(() => ({ exists: null }));
    if (r.live) { wakePanel(p, 'entrou ao vivo (API)'); continue; }
    if (r.exists === null && ++p.apiFails >= 3) { p.apiBroken = true; wakePanel(p, 'API sem resposta, voltando a vigiar pela página'); continue; }
    if (r.exists !== null) p.apiFails = 0;
  }
}

// Aviso quando um streamer que estava offline entra ao vivo (Windows + aviso dentro do app).
function notifyLive(p) {
  log(`[${p.id}] entrou ao vivo`);
  send('toast', { kind: 'live', id: p.id, platform: p.platform, title: `${p.title} entrou ao vivo`, body: `Abrindo a live na ${p.platform === 'twitch' ? 'Twitch' : 'Kick'}` });
  if (state.notifyLive === false || !Notification.isSupported()) return;
  const n = new Notification({
    title: `${p.title} entrou ao vivo`,
    body: `A live já está abrindo no PokeIdle Farm (${p.platform === 'twitch' ? 'Twitch' : 'Kick'}).`,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    silent: false
  });
  n.on('click', () => { win.show(); win.focus(); });
  n.show();
}

function reloadPanel(p, reason, { auto = true } = {}) {
  if (!p) return;
  if (p.sleeping) { p.sleeping = false; p.failed = true; }
  log(`[${p.id}] reload: ${reason}`);
  if (auto) {
    p.reloads++; totalReloads++;
    p.lastReason = reason;
    lastReload = { id: p.id, reason, at: Date.now() };
    pushGlobal();
  }
  p.stalled = 0; p.lastTime = null; p.noVideoSince = null;
  setStatus(p, 'loading');
  const wc = p.view.webContents;
  clearTimeout(p.retryTimer);
  // Depois de uma falha a URL atual é a página de erro; volta sempre para a URL original.
  if (wc.isCrashed() || p.failed || !wc.getURL()) wc.loadURL(p.url).catch(() => {});
  else wc.reload();
  pushStatus(p);
}

// Esconde o chat nas lives: a página continua a mesma (conta como espectador), mas não desenha as mensagens.
const HIDE_CHAT_CSS = {
  kick: '#channel-chatroom, #chatroom, [data-testid="chatroom"], [data-testid="chat"] { display: none !important; }',
  twitch: '.channel-root__right-column, .right-column, [data-a-target="right-column-chat-bar"] { display: none !important; }'
};
function createPanel({ id, kind, title, url, platform, channel }) {
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      backgroundThrottling: false, // continua rodando em segundo plano
      contextIsolation: true,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  view.setBackgroundColor('#0b0e14');
  if (typeof view.setBorderRadius === 'function') view.setBorderRadius(8);
  win.contentView.addChildView(view);

  const p = {
    id, kind, title, url, platform, channel, view, status: 'loading', reloads: 0,
    stalled: 0, lastTime: null, noVideoSince: null, qualityFixed: false, lastLoad: Date.now()
  };
  panels.set(id, p);

  const wc = view.webContents;
  const muted = state.muted && id in state.muted ? state.muted[id] : (kind === 'stream' && config.streamsMutedByDefault);
  wc.setAudioMuted(!!muted);
  if (kind === 'game' && config.game.zoom) wc.setZoomFactor(config.game.zoom);
  if (state.zoom && state.zoom[id]) wc.setZoomFactor(state.zoom[id]);

  wc.on('did-start-loading', () => { if (p.paused || p.sleeping) return; p.failed = false; setStatus(p, 'loading'); });
  if (kind === 'stream') wc.on('dom-ready', () => { if (!p.sleeping && state.hideChat !== false) wc.insertCSS(HIDE_CHAT_CSS[platform] || '').catch(() => {}); });
  wc.on('did-stop-loading', () => {
    if (p.failed || p.paused || p.sleeping) return;
    p.failCount = 0;
    p.lastLoad = Date.now();
    setStatus(p, kind === 'game' ? 'ok' : 'checking');
    if (kind === 'stream') { quickDetect(p); setTimeout(() => applyEconomyQuality(p), 4000); }
    if (kind === 'game') pollGameUser();
  });
  wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* abortado */) return;
    p.failed = true;
    p.failCount = (p.failCount || 0) + 1;
    const wait = Math.min(120, 10 * p.failCount); // 10s, 20s, 30s... até 2 min
    log(`[${id}] falha ao carregar: ${desc} (${code}), nova tentativa em ${wait}s`);
    setStatus(p, 'error');
    clearTimeout(p.retryTimer);
    p.retryTimer = setTimeout(() => reloadPanel(p, 'falha ao carregar'), wait * 1000);
  });
  wc.on('render-process-gone', (_e, details) => {
    log(`[${id}] processo caiu: ${details.reason}`);
    setStatus(p, 'error');
    setTimeout(() => reloadPanel(p, 'processo caiu'), 3000);
  });
  let unresponsiveTimer = null;
  wc.on('unresponsive', () => {
    setStatus(p, 'error');
    unresponsiveTimer = setTimeout(() => reloadPanel(p, 'página não respondeu por 90s'), 90000);
  });
  wc.on('responsive', () => { clearTimeout(unresponsiveTimer); setStatus(p, kind === 'game' ? 'ok' : 'checking'); });

  // Popups (login com Google/Discord etc.) abrem numa janela normal com a mesma sessão.
  wc.setWindowOpenHandler(({ url }) => (isWebUrl(url) ? {
    action: 'allow',
    overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 520, height: 720, backgroundColor: '#0b0e14' }
  } : { action: 'deny' }));

  // Atalhos dentro do painel: F5 recarrega, F12 abre DevTools.
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5') { event.preventDefault(); reloadPanel(p, 'F5', { auto: false }); }
    if (input.key === 'F12') { event.preventDefault(); wc.toggleDevTools(); }
    if (handleShortcut(input)) event.preventDefault();
  });
  // Áudio inteligente: clicou numa live, ela fica com som e as outras mutam.
  wc.on('focus', () => { if (kind === 'stream' && state.smartAudio) soloAudio(p.id); });
  wc.on('input-event', (_e, ev) => { if (ev.type === 'mouseDown' && kind === 'stream' && state.smartAudio) soloAudio(p.id); });

  return p;
}

// ---------------------------------------------------------------------------
// Modo economia: lives minimizadas (sem pintar na tela) e na menor qualidade.
// ---------------------------------------------------------------------------
async function applyEconomyQuality(p) {
  if (p.kind !== 'stream' || !state.economy || p.ecoQuality) return;
  const wc = p.view.webContents;
  if (wc.isLoading() || p.paused || p.sleeping) return;
  p.ecoQuality = true;
  const changed = await wc.executeJavaScript(kick.lowestQualityFor(p.platform), true).catch(() => false);
  if (changed) reloadPanel(p, 'modo economia: qualidade baixa', { auto: false });
}
function setEconomy(on) {
  state.economy = !!on; saveState();
  log(`[economia] ${on ? 'ligado' : 'desligado'}`);
  for (const p of panels.values()) { p.ecoQuality = false; if (on) applyEconomyQuality(p); }
  pushGlobal();
}

// ---------------------------------------------------------------------------
// Medidor de CPU/RAM do app e de cada painel
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Atalhos: Ctrl+Shift+F foco · Ctrl+1..9 expandir/minimizar live · Ctrl+M mutar lives · Ctrl+R recarregar tudo
// Funcionam com o foco em qualquer painel ou na interface.
// ---------------------------------------------------------------------------
function handleShortcut(input) {
  if (input.type !== 'keyDown' || !input.control || input.alt) return false;
  const k = input.key.toLowerCase();
  if (input.shift && k === 'f') { send('toggle-focus'); return true; }
  if (input.shift) return false;
  if (/^[1-9]$/.test(k)) { send('shortcut', { expand: Number(k) }); return true; }
  if (k === 'm') { muteAllStreams(); return true; }
  if (k === 'r') { reloadAll(); return true; }
  if (k === 's') { screenshotGame(); return true; }
  return false;
}
function streamPanels() { return [...panels.values()].filter((p) => p.kind === 'stream'); }
function muteAllStreams() {
  const list = streamPanels();
  const mute = list.some((p) => !p.view.webContents.isAudioMuted()); // alguma com som → muta todas; senão desmuta todas
  state.muted = state.muted || {};
  for (const p of list) { p.view.webContents.setAudioMuted(mute); state.muted[p.id] = mute; pushStatus(p); }
  saveState();
  send('toast', { title: mute ? 'Lives mutadas' : 'Som das lives ligado', body: 'Ctrl+M', platform: '' });
}
function soloAudio(id) {
  state.muted = state.muted || {};
  for (const p of streamPanels()) {
    const mute = p.id !== id;
    if (p.view.webContents.isAudioMuted() !== mute) { p.view.webContents.setAudioMuted(mute); state.muted[p.id] = mute; pushStatus(p); }
  }
  saveState();
}
function reloadAll() {
  for (const p of panels.values()) if (!p.paused) reloadPanel(p, 'Ctrl+R', { auto: false });
  send('toast', { title: 'Recarregando tudo', body: 'Ctrl+R', platform: '' });
}

// ---------------------------------------------------------------------------
// Queda de internet: quando a conexão volta, recarrega na hora só o que caiu.
// ---------------------------------------------------------------------------
function startNetworkWatch() {
  let online = net.isOnline();
  setInterval(() => {
    const now = net.isOnline();
    if (now === online) return;
    online = now;
    if (!now) {
      log('[rede] sem internet');
      send('toast', { kind: 'net', title: 'Sem internet', body: 'Recarrego o que cair assim que a conexão voltar', platform: 'warn' });
      return;
    }
    const broken = [...panels.values()].filter((p) => !p.paused && (p.failed || p.status === 'error'));
    log(`[rede] internet voltou, recarregando ${broken.map((p) => p.id).join(', ') || 'nada'}`);
    send('toast', { kind: 'net', title: 'Internet voltou', body: broken.length ? `Recarregando ${broken.length} painel(is)` : 'Tudo certo', platform: 'ok' });
    for (const p of broken) { p.failCount = 0; reloadPanel(p, 'internet voltou'); }
  }, 3000);
}

function startMetrics() {
  const cores = Math.max(1, os.cpus().length);
  setInterval(() => {
    const byPid = new Map(app.getAppMetrics().map((m) => [m.pid, m]));
    let cpu = 0, mem = 0;
    for (const m of byPid.values()) { cpu += m.cpu.percentCPUUsage; mem += m.memory.workingSetSize; }
    const per = {};
    for (const p of panels.values()) {
      const m = byPid.get(p.view.webContents.getOSProcessId());
      if (m) per[p.id] = { cpu: m.cpu.percentCPUUsage / cores, mem: m.memory.workingSetSize * 1024 };
    }
    send('metrics', { cpu: cpu / cores, mem: mem * 1024, panels: per });
  }, 3000);
}

// ---------------------------------------------------------------------------
// Stats do PokeIdle: XP/h e ouro/h da sessão
// ---------------------------------------------------------------------------
const stats = { prev: null, xpGained: 0, goldGained: 0, samples: [], idsLogged: false, last: null };
async function sampleGameStats() {
  const p = panels.get('game');
  if (!p || p.view.webContents.isLoading() || !kick.gameStats) return;
  let r;
  try { r = await p.view.webContents.executeJavaScript(kick.gameStats, true); } catch { return; }
  if (!r) return;
  if (!stats.idsLogged && r.ids) { stats.idsLogged = true; log(`[stats] ids encontrados: ${JSON.stringify(r.ids)}`); }
  const prev = stats.prev;
  const before = { xp: stats.xpGained, gold: stats.goldGained };
  if (prev && r.xp !== null && prev.xp !== null) {
    if (r.xp >= prev.xp && (r.level === prev.level || r.level === null)) stats.xpGained += r.xp - prev.xp;
    else if (prev.xpMax) stats.xpGained += Math.max(0, prev.xpMax - prev.xp) + r.xp; // subiu de nível
  }
  if (prev && r.gold !== null && prev.gold !== null && r.gold > prev.gold) stats.goldGained += r.gold - prev.gold;
  if (r.xp !== null || r.gold !== null) stats.prev = r;
  const now = Date.now();
  stats.samples.push({ t: now, xp: stats.xpGained, gold: stats.goldGained });
  stats.samples = stats.samples.filter((x) => now - x.t <= 61 * 60000);
  const first = stats.samples[0];
  const hours = (now - first.t) / 3600000;
  const rate = (k) => (hours >= 2 / 60 ? (stats.samples.at(-1)[k] - first[k]) / hours : null);
  // mini gráfico: XP ganho em cada minuto da última hora
  const spark = [];
  for (let i = 59; i >= 0; i--) {
    const a = stats.samples.filter((x) => x.t <= now - (i + 1) * 60000).at(-1);
    const b = stats.samples.filter((x) => x.t <= now - i * 60000).at(-1);
    spark.push(a && b ? b.xp - a.xp : null);
  }
  stats.last = {
    found: r.xp !== null || r.gold !== null,
    level: r.level, xp: r.xp, xpMax: r.xpMax, gold: r.gold,
    xpGained: stats.xpGained, goldGained: stats.goldGained,
    xpRate: rate('xp'), goldRate: rate('gold'), spark
  };
  const items = await readItems(p);
  stats.last.balls = items && items.balls;
  stats.last.potions = items && items.potions;
  send('game-stats', stats.last);
  trackDaily(stats.xpGained - before.xp, stats.goldGained - before.gold, now);
  checkIdle(r, stats.xpGained - before.xp, now);
}

// ---------------------------------------------------------------------------
// Pokébolas e potions: avisa só quando muda (um item que você tinha fica abaixo de 100 ou zera,
// ou todos os ligados no uso automático zeram). O que já estava zerado ao abrir não gera aviso.
// ---------------------------------------------------------------------------
async function readItems(p) {
  if (!kick.gameItems) return null;
  let r;
  try { r = await p.view.webContents.executeJavaScript(kick.gameItems, true); } catch { return null; }
  if (!r) return null;
  if (Array.isArray(r.balls)) checkItems('ball', r.balls, { all: 'Pokébolas acabaram', allBody: 'Todas as pokébolas ligadas no automático estão zeradas. Compre mais na loja.', body: 'Compre mais na loja pra continuar capturando.', limit: state.ballsLow ?? 100 });
  if (Array.isArray(r.potions)) checkItems('potion', r.potions, { all: 'Potions acabaram', allBody: 'Todas as potions do uso automático estão zeradas.', body: 'Compre mais potions pra equipe não desmaiar.', limit: state.potionsLow ?? 100 });
  return r;
}
// ---------- Alertas no celular (webhook do Discord) ----------
// O link do webhook fica só no state.json local; nunca vai pro log nem pro repositório.
const DISCORD_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,100}$/;
let discordLastSend = 0;
async function notifyPhone({ title, description, color = 0xf5a524, thumbnail, url = state.discordWebhook }) {
  if (!url || !DISCORD_RE.test(url)) return { ok: false, error: 'sem webhook' };
  const embed = { title: String(title).slice(0, 256), description: String(description || '').slice(0, 2000), color, timestamp: new Date().toISOString(), footer: { text: 'PokeIdle Farm' } };
  if (thumbnail && /^https:\/\//.test(thumbnail)) embed.thumbnail = { url: thumbnail };
  const wait = discordLastSend + 1500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  discordLastSend = Date.now();
  try {
    const res = await net.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }) });
    if (res.ok) return { ok: true };
    log(`[celular] Discord respondeu ${res.status}`);
    return { ok: false, error: res.status === 404 || res.status === 401 ? 'webhook inválido ou apagado' : `Discord respondeu ${res.status}` };
  } catch (err) {
    log(`[celular] falha ao enviar: ${err.message}`);
    return { ok: false, error: 'sem conexão com o Discord' };
  }
}
function maskWebhook(url) {
  const m = url && url.match(/webhooks\/(\d+)\//);
  return m ? `webhook …${m[1].slice(-4)}` : null;
}
function itemAlert(key, title, body) {
  stats.itemAlerts = stats.itemAlerts || {};
  if (stats.itemAlerts[key]) return;
  stats.itemAlerts[key] = true;
  log(`[itens] ${title}`);
  send('toast', { title, body, platform: 'warn' });
  if (Notification.isSupported()) {
    const n = new Notification({ title: `PokeIdle: ${title}`, body, icon: path.join(__dirname, '..', 'assets', 'icon.png') });
    n.on('click', () => { win.show(); win.focus(); });
    n.show();
  }
  if (state.discordItems !== false) notifyPhone({ title, description: body, color: 0xe5484d });
}
function checkItems(kind, list, o) {
  stats.itemAlerts = stats.itemAlerts || {};
  stats.itemPrev = stats.itemPrev || {};
  const prev = stats.itemPrev[kind] || {};
  for (const x of list) {
    if (x.qty === null) continue;
    const before = prev[x.name];
    const k0 = `${kind}:zero:${x.name}`, kl = `${kind}:low:${x.name}`;
    if (x.qty === 0) { if (before > 0) itemAlert(k0, `${x.name} acabou`, o.body); }
    else if (x.qty < o.limit) { delete stats.itemAlerts[k0]; if (before === undefined || before > x.qty) itemAlert(kl, `${x.name} acabando (${x.qty})`, `Restam ${x.qty}. ${o.body}`); }
    else { delete stats.itemAlerts[k0]; delete stats.itemAlerts[kl]; }
  }
  const enabled = list.filter((x) => x.on);
  const hadAny = enabled.some((x) => prev[x.name] > 0);
  const allZero = enabled.length && enabled.every((x) => x.qty === 0);
  if (allZero && hadAny) itemAlert(`${kind}:all`, o.all, o.allBody);
  else if (!allZero) delete stats.itemAlerts[`${kind}:all`];
  stats.itemPrev[kind] = Object.fromEntries(list.map((x) => [x.name, x.qty]));
}

// ---------------------------------------------------------------------------
// Aviso de inatividade: XP parado por X minutos (padrão 10) → notificação.
// ---------------------------------------------------------------------------
function checkIdle(r, dxp, now) {
  if (r.xp === null) return;
  const limit = (state.idleMinutes || 10) * 60000;
  if (!stats.lastXpUp || dxp > 0) {
    if (stats.idleAlerted && dxp > 0) send('toast', { title: 'XP voltou a subir', body: 'O farm voltou ao normal', platform: 'ok' });
    stats.lastXpUp = now; stats.idleAlerted = false;
    return;
  }
  if (stats.idleAlerted || now - stats.lastXpUp < limit) return;
  stats.idleAlerted = true;
  const min = Math.round((now - stats.lastXpUp) / 60000);
  log(`[stats] XP parado há ${min} min`);
  send('toast', { title: `XP parado há ${min} min`, body: 'Pokémon desmaiou, acabou poção ou o jogo travou?', platform: 'warn' });
  if (Notification.isSupported()) {
    const n = new Notification({
      title: `PokeIdle: XP parado há ${min} min`,
      body: 'Dá uma olhada: o Pokémon pode ter desmaiado, a poção acabado ou o jogo travado.',
      icon: path.join(__dirname, '..', 'assets', 'icon.png')
    });
    n.on('click', () => { win.show(); win.focus(); });
    n.show();
  }
}

// ---------------------------------------------------------------------------
// Relatório diário: XP, ouro, tempo farmando e tempo ao vivo de cada live, por dia.
// ---------------------------------------------------------------------------
const dayKey = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE'); // AAAA-MM-DD no fuso local
function trackDaily(dxp, dgold, now) {
  const dt = stats.lastDailyAt ? Math.min(now - stats.lastDailyAt, 90000) : 0;
  stats.lastDailyAt = now;
  state.daily = state.daily || {};
  const d = state.daily[dayKey(now)] = state.daily[dayKey(now)] || { xp: 0, gold: 0, farmMs: 0, live: {} };
  d.xp += Math.max(0, dxp); d.gold += Math.max(0, dgold); d.farmMs += dt;
  if (stats.last && stats.last.level) d.level = stats.last.level;
  for (const p of panels.values()) {
    if (p.kind === 'stream' && p.status === 'live') d.live[p.title] = (d.live[p.title] || 0) + dt;
  }
  const keys = Object.keys(state.daily).sort();
  while (keys.length > 30) delete state.daily[keys.shift()];
  saveState();
  const avail = d.farmMs >= 5 * 60000;
  if (avail !== stats.reportAvailable) { stats.reportAvailable = avail; pushGlobal(); }
}
function getReport() {
  const days = Object.entries(state.daily || {}).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7)
    .map(([day, d]) => ({ day, ...d }));
  return { today: dayKey(), days, sessionStart: startedAt };
}

// ---------------------------------------------------------------------------
// Print do jogo (Ctrl+S): salva só o painel do PokeIdle em Imagens\PokeIdle Farm.
// ---------------------------------------------------------------------------
async function screenshotGame() {
  const p = panels.get('game');
  if (!p) return;
  try {
    const img = await p.view.webContents.capturePage();
    const dir = path.join(app.getPath('pictures'), 'PokeIdle Farm');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, (c) => (c === ' ' ? '_' : '-'));
    const file = path.join(dir, `pokeidle_${stamp}.png`);
    fs.writeFileSync(file, img.toPNG());
    stats.lastShot = file;
    log(`[print] ${file}`);
    send('toast', { title: 'Print salvo', body: 'clique pra abrir a pasta', platform: 'ok', action: 'open-shot' });
  } catch (e) {
    send('toast', { title: 'Não consegui salvar o print', body: e.message, platform: 'warn' });
  }
}

// ---------------------------------------------------------------------------
// Perfis de lives: conjuntos salvos com nome, trocados com um clique.
// ---------------------------------------------------------------------------
const getProfiles = () => state.profiles || [];
function applyProfile(name) {
  const pr = getProfiles().find((x) => x.name === name);
  if (!pr) return null;
  const next = applyStreams(pr.streams);
  state.streams = next.map(({ platform, channel, title }) => ({ platform, channel, title }));
  state.activeProfile = name;
  saveState();
  log(`[perfil] ${name}`);
  send('toast', { title: `Perfil "${name}"`, body: `${next.length} live(s)`, platform: 'ok' });
  buildTrayMenu();
  pushGlobal();
  return next;
}

function destroyPanel(p) {
  clearTimeout(p.retryTimer);
  clearInterval(p.quickTimer);
  panels.delete(p.id);
  try { win.contentView.removeChildView(p.view); } catch { /* já removida */ }
  try { p.view.webContents.close(); } catch { /* ignora */ }
}

// Aplica a lista de lives sem reiniciar: remove as que saíram, cria as novas, mantém as que ficaram.
function applyStreams(list) {
  const next = streams.normalizeList(list);
  const keep = new Set(next.map((s) => s.id));
  for (const p of [...panels.values()]) if (p.kind === 'stream' && !keep.has(p.id)) destroyPanel(p);
  for (const s of next) {
    if (panels.has(s.id)) { panels.get(s.id).title = s.title; continue; }
    const p = createPanel({ ...s, kind: 'stream', url: streamUrl(s) });
    if (loginWins.length) { p.paused = true; p.status = 'paused'; }
    else p.view.webContents.loadURL(p.url).catch(() => {});
  }
  log(`[lives] ${next.map((s) => `${s.platform}:${s.channel}`).join(', ') || 'nenhuma'}`);
  send('streams-changed', next);
  panels.forEach(pushStatus);
  return next;
}

// Logo depois de carregar, checa a cada 3s (por até 2 min) só pra descobrir rápido se está ao vivo ou offline.
function quickDetect(p) {
  clearInterval(p.quickTimer);
  const started = Date.now();
  p.quickTimer = setInterval(async () => {
    const wc = p.view.webContents;
    if (!panels.has(p.id) || Date.now() - started > 120000) { clearInterval(p.quickTimer); return; }
    if (p.paused || p.sleeping || wc.isLoading() || wc.isCrashed()) return;
    try {
      const r = await wc.executeJavaScript(kick.probeFor(p.platform), true);
      if (r && r.offline) { setStatus(p, 'offline'); clearInterval(p.quickTimer); }
      else if (r && r.hasVideo && !r.paused && r.readyState >= 2) { setStatus(p, 'live'); clearInterval(p.quickTimer); }
    } catch { /* página ainda montando */ }
  }, 3000);
}

// ---------------------------------------------------------------------------
// 2) Watchdog das lives
// ---------------------------------------------------------------------------
async function checkStream(p) {
  const wc = p.view.webContents;
  if (watchdogPaused || loginWins.length || p.paused || p.sleeping) return;
  if (wc.isLoading() || wc.isCrashed() || p.failed) return;
  // Dá 2 minutos pra página da live estabilizar antes de julgar.
  if (Date.now() - p.lastLoad < 120000) {
    try {
      const r = await wc.executeJavaScript(kick.probeFor(p.platform), true); // só tenta dar play
      if (r && r.offline) setStatus(p, 'offline');
      else if (r && r.hasVideo && !r.paused && r.readyState >= 2) setStatus(p, 'live');
    } catch { /* ignora */ }
    return;
  }
  const wd = config.watchdog || {};

  if (config.lowestQuality && !p.qualityFixed) {
    p.qualityFixed = true;
    const changed = await wc.executeJavaScript(kick.lowestQualityFor(p.platform), true).catch(() => false);
    if (changed) { reloadPanel(p, 'aplicar qualidade baixa', { auto: false }); return; }
  }

  let r;
  try { r = await wc.executeJavaScript(kick.probeFor(p.platform), true); } catch { return; }

  // Twitch: resgata o baú de pontos (opcional, desligado por padrão).
  if (p.platform === 'twitch' && state.twitchAutoClaim && kick.twitchClaim) {
    const claimed = await wc.executeJavaScript(kick.twitchClaim, true).catch(() => false);
    if (claimed) log(`[${p.id}] baú de pontos resgatado`);
  }

  // Live offline: não recarrega. A página começa a live sozinha quando o streamer abre.
  if (!r || r.offline || !r.hasVideo || r.ended) { setStatus(p, 'offline'); p.stalled = 0; p.lastTime = null; return; }

  const advanced = p.lastTime === null || r.time > p.lastTime + 0.5;
  p.lastTime = r.time;
  if (advanced && !r.paused) {
    p.stalled = 0;
    setStatus(p, 'live');
  } else {
    p.stalled++;
    setStatus(p, 'stalled');
    // Por padrão (0) só mostra "travado" e tenta dar play; não recarrega.
    const limit = wd.stalledChecksBeforeReload || 0;
    if (limit > 0 && p.stalled >= limit) reloadPanel(p, 'vídeo parado há vários minutos');
  }

  const hours = wd.preventiveReloadHours || 0;
  if (hours > 0 && Date.now() - p.lastLoad > hours * 3600000) reloadPanel(p, 'reload preventivo');
}

// ---------------------------------------------------------------------------
// Live reload: interface recarrega sozinha; mudanças no processo principal
// acendem o botão "Reiniciar" (o jogo fica rodando até você clicar).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Atualização automática (só no app instalado): baixa a versão nova do GitHub Releases
// em segundo plano e acende o botão "Atualização pronta · Reiniciar".
// ---------------------------------------------------------------------------
let updater = null;
let updateReady = null; // versão baixada
function startAutoUpdate() {
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return; // versão portátil não se atualiza sozinha
  try { updater = require('electron-updater').autoUpdater; } catch (e) { log(`[update] indisponível: ${e.message}`); return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.logger = { info: (m) => log(`[update] ${m}`), warn: (m) => log(`[update] ${m}`), error: (m) => log(`[update] erro: ${m}`), debug: () => {} };
  updater.on('update-available', (i) => send('toast', { title: `Nova versão ${i.version}`, body: 'baixando em segundo plano…', platform: 'ok' }));
  updater.on('update-downloaded', (i) => {
    updateReady = i.version;
    updatePending = true;
    pushGlobal();
    send('toast', { title: `Versão ${i.version} pronta`, body: 'clique em Reiniciar quando quiser', platform: 'ok' });
  });
  updater.on('error', (e) => log(`[update] erro: ${e && e.message}`));
  const check = () => updater.checkForUpdates().catch(() => {});
  setTimeout(check, 15000);
  setInterval(check, 30 * 60000); // checa a cada 30 min
}

function restartApp() {
  log('[app] reiniciando');
  if (updater && updateReady) { app.isQuitting = true; updater.quitAndInstall(true, true); return; }
  app.relaunch();
  app.isQuitting = true;
  app.exit(0);
}

function startLiveReload() {
  if (app.isPackaged) return;
  const root = path.join(__dirname, '..');
  const timers = {};
  const onChange = (file) => {
    if (!file) return;
    const f = file.replace(/\\/g, '/');
    if (!/\.(js|html|css|json)$/.test(f) || f.includes('node_modules')) return;
    clearTimeout(timers[f]);
    timers[f] = setTimeout(() => {
      if (f.startsWith('src/ui/')) {
        log(`[live-reload] ${f} mudou, recarregando interface`);
        win.webContents.reloadIgnoringCache();
      } else if (f === 'src/kick-probe.js') {
        try {
          delete require.cache[require.resolve('./kick-probe')];
          kick = require('./kick-probe');
          log('[live-reload] kick-probe.js recarregado');
        } catch (e) { log(`[live-reload] erro em kick-probe.js: ${e.message}`); }
      } else if (f.startsWith('src/') || f === 'config.json' || f === 'package.json') {
        log(`[live-reload] ${f} mudou, precisa reiniciar`);
        updatePending = true;
        pushGlobal();
      }
    }, 400);
  };
  try {
    fs.watch(root, { recursive: true }, (_ev, file) => onChange(file));
    log('[live-reload] observando alterações');
  } catch (e) { log(`[live-reload] indisponível: ${e.message}`); }
}

// Lê o nick logado no PokeIdle e mostra na barra de título no lugar do botão Login.
// O jogo demora pra montar a tela, então fica tentando a cada 2s até o #tr-nick aparecer,
// sem limite de tempo. O botão mostra "carregando" enquanto isso.
let userLoading = true;
let userPoll = null;
async function readGameUser() {
  const p = panels.get('game');
  if (!p || p.view.webContents.isLoading()) return null;
  try {
    const user = await p.view.webContents.executeJavaScript(kick.gameUser, true);
    if (user && user !== state.user) {
      state.user = user; saveState();
      log(`[game] logado como ${user}`);
    }
    return user || null;
  } catch { return null; } // página ainda carregando
}
function pollGameUser() {
  clearInterval(userPoll);
  userLoading = true; pushGlobal();
  userPoll = setInterval(async () => {
    const user = await readGameUser();
    if (user) {
      clearInterval(userPoll);
      userLoading = false; pushGlobal();
    }
  }, 2000);
}

function startWatchdog() {
  setInterval(async () => { if (!userLoading && await readGameUser()) pushGlobal(); }, 60000);
  const ms = ((config.watchdog && config.watchdog.intervalSeconds) || 60) * 1000;
  setInterval(() => {
    for (const p of panels.values()) if (p.kind === 'stream') checkStream(p);
  }, ms);
}

// ---------------------------------------------------------------------------
// Janela, bandeja e IPC
// ---------------------------------------------------------------------------
function createWindow() {
  const b = state.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1600, height: b.height || 900, x: b.x, y: b.y,
    minWidth: 960, minHeight: 600,
    frame: false,
    backgroundColor: '#0b0e14',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    title: 'PokeIdle Farm',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  if (state.maximized) win.maximize();
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.webContents.on('before-input-event', (e, input) => { if (handleShortcut(input)) e.preventDefault(); });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('https://github.com/LeooSato/pokeidle-farmer-browser')) shell.openExternal(url); return { action: 'deny' }; });
  win.once('ready-to-show', () => win.show());

  const remember = () => {
    if (win.isMaximized() || win.isMinimized()) return;
    state.bounds = win.getBounds(); saveState();
  };
  win.on('resize', remember);
  win.on('move', remember);
  const maxChanged = () => { state.maximized = win.isMaximized(); saveState(); send('window-state', { maximized: win.isMaximized() }); };
  for (const ev of ['minimize', 'restore', 'hide', 'show']) win.on(ev, () => applyViewVisibility());
  win.on('maximize', maxChanged);
  win.on('unmaximize', maxChanged);

  win.on('close', (e) => {
    if (config.closeToTray && !app.isQuitting) { e.preventDefault(); win.hide(); }
  });
}

// ---------------------------------------------------------------------------
// Login: duas janelas normais (PokeIdle e Kick) na mesma sessão do app.
// O login fica salvo no cache do app. Lives pausadas enquanto estiverem abertas.
// ---------------------------------------------------------------------------
function pauseStreams(on) {
  for (const p of panels.values()) {
    if (p.kind !== 'stream') continue;
    p.paused = on;
    if (on) { p.view.webContents.loadURL('about:blank').catch(() => {}); setStatus(p, 'paused'); }
  }
}

function openLoginWindow() {
  if (loginWins.length) { loginWins.forEach((w) => { w.show(); w.focus(); }); return; }
  pauseStreams(true);
  const sites = [
    { title: 'Login · PokeIdle', url: config.game.url },
    { title: 'Login · Kick', url: 'https://kick.com' }
  ];
  if (currentStreams().some((s) => s.platform === 'twitch')) sites.push({ title: 'Login · Twitch', url: 'https://www.twitch.tv/login' });
  const width = sites.length > 2 ? 640 : 900;
  sites.forEach((site, i) => {
    const w = new BrowserWindow({
      width, height: 820, x: 40 + i * (width + 12), y: 60,
      title: site.title,
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      autoHideMenuBar: true,
      webPreferences: { session: ses, contextIsolation: true, sandbox: true }
    });
    w.on('page-title-updated', (e) => e.preventDefault()); // mantém o título "Login · ..."
    w.webContents.setWindowOpenHandler(({ url }) => (isWebUrl(url) ? { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 520, height: 720 } } : { action: 'deny' }));
    w.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F5') { e.preventDefault(); w.webContents.reload(); }
    });
    autoKickCookies(w.webContents);
    w.loadURL(site.url).catch(() => {});
    w.on('closed', () => {
      loginWins = loginWins.filter((x) => x !== w);
      if (loginWins.length) return;
      log('[login] janelas fechadas, recarregando painéis com a sessão nova');
      for (const p of panels.values()) {
        p.paused = false;
        p.stable = null;
        p.failed = true; // força loadURL da URL original
        reloadPanel(p, 'após login', { auto: false });
      }
      pushGlobal();
      if (win) { win.show(); win.focus(); }
    });
    loginWins.push(w);
  });
  pushGlobal();
}

// ---------------------------------------------------------------------------
// Primeiro acesso: uma janela com PokeIdle, Twitch e Kick lado a lado pra fazer login.
// ---------------------------------------------------------------------------
let setupWin = null;
let setupViews = [];
let setupPopouts = [];
const SETUP_SITES = () => [config.game.url, 'https://www.twitch.tv/login', 'https://kick.com'];
// Plano B: abre o site da coluna numa janela normal (igual ao botão Login); ao fechar, recarrega a coluna.
function setupPopout(i) {
  const view = setupViews[i];
  if (!view) return;
  const w = new BrowserWindow({
    width: 900, height: 820, title: ['Login · PokeIdle', 'Login · Twitch', 'Login · Kick'][i],
    icon: path.join(__dirname, '..', 'assets', 'icon.png'), autoHideMenuBar: true,
    webPreferences: { session: ses, contextIsolation: true, sandbox: true }
  });
  w.on('page-title-updated', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(({ url }) => (isWebUrl(url) ? { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 520, height: 720 } } : { action: 'deny' }));
  autoKickCookies(w.webContents);
  w.loadURL(SETUP_SITES()[i]).catch(() => {});
  w.on('closed', () => { setupPopouts = setupPopouts.filter((x) => x !== w); if (!view.webContents.isDestroyed()) view.webContents.reload(); });
  setupPopouts.push(w);
}
function openOnboarding() {
  setupWin = new BrowserWindow({
    width: 1500, height: 900, minWidth: 1100, minHeight: 640,
    backgroundColor: '#0b0e14',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    title: 'PokeIdle Farm · Primeiro acesso',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  setupWin.on('page-title-updated', (e) => e.preventDefault());
  setupWin.loadFile(path.join(__dirname, 'ui', 'setup.html'));
  setupWin.webContents.on('will-navigate', (e) => e.preventDefault());
  setupWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  setupWin.once('ready-to-show', () => { setupWin.maximize(); setupWin.show(); });

  setupViews = SETUP_SITES().map((url) => {
    const v = new WebContentsView({ webPreferences: { session: ses, contextIsolation: true, sandbox: true } });
    v.setBackgroundColor('#0b0e14');
    v.webContents.setWindowOpenHandler(({ url: u }) => (isWebUrl(u) ? { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 520, height: 720 } } : { action: 'deny' }));
    v.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F5') { e.preventDefault(); v.webContents.reload(); }
    });
    autoKickCookies(v.webContents);
    setupWin.contentView.addChildView(v);
    v.webContents.loadURL(url).catch(() => {});
    return v;
  });
  const TOP = 112, BOTTOM = 72, GAP = 10, SIDE = 16; // tem que bater com o setup.html
  const layout = () => {
    const [w, h] = setupWin.getContentSize();
    const colW = Math.floor((w - SIDE * 2 - GAP * 2) / 3);
    setupViews.forEach((v, i) => v.setBounds({ x: SIDE + i * (colW + GAP), y: TOP, width: colW, height: Math.max(100, h - TOP - BOTTOM) }));
  };
  setupWin.on('resize', layout);
  setupWin.on('closed', () => setupPopouts.forEach((w) => !w.isDestroyed() && w.close()));
  layout();
  setupWin.on('closed', () => { setupWin = null; });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png')));
  tray.setToolTip('PokeIdle Farm (farmando)');
  tray.on('click', () => { win.show(); win.focus(); });
  buildTrayMenu();
}

function buildTrayMenu() {
  if (!tray) return;
  const show = () => { win.show(); win.focus(); };
  const profiles = getProfiles();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mostrar', click: show },
    { label: 'Fazer login nas contas…', click: openLoginWindow },
    ...(profiles.length ? [{
      label: 'Perfil de lives',
      submenu: profiles.map((pr) => ({ label: pr.name, type: 'radio', checked: state.activeProfile === pr.name, click: () => applyProfile(pr.name) }))
    }] : []),
    { label: 'Avisar quando entrar ao vivo', type: 'checkbox', checked: state.notifyLive !== false, click: (i) => { state.notifyLive = i.checked; saveState(); pushGlobal(); } },
    { label: 'Live offline dorme (economiza RAM)', type: 'checkbox', checked: state.sleepOffline !== false, click: (i) => {
      state.sleepOffline = i.checked; saveState();
      if (!i.checked) panels.forEach((p) => wakePanel(p, 'modo dormir desligado'));
      else panels.forEach((p) => p.status === 'offline' && sleepPanel(p));
    } },
    { label: 'Esconder chat das lives', type: 'checkbox', checked: state.hideChat !== false, click: (i) => {
      state.hideChat = i.checked; saveState();
      panels.forEach((p) => p.kind === 'stream' && !p.sleeping && reloadPanel(p, 'chat ' + (i.checked ? 'escondido' : 'visível'), { auto: false }));
    } },
    { label: 'Recarregar lives', click: () => panels.forEach((p) => p.kind === 'stream' && reloadPanel(p, 'bandeja', { auto: false })) },
    { label: 'Salvar print do jogo (Ctrl+S)', click: () => screenshotGame() },
    { type: 'separator' },
    { label: 'Sair', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
}

// Com o app minimizado ou na bandeja, as lives param de ser desenhadas (o vídeo e o som continuam).
let modalOpen = false;
function applyViewVisibility() {
  const hidden = !win || win.isDestroyed() || win.isMinimized() || !win.isVisible();
  panels.forEach((p) => p.view.setVisible(!modalOpen && !(hidden && p.kind === 'stream')));
}
function registerIpc() {
  // Só a interface do próprio app (file://.../ui/index.html) pode falar com o processo principal.
  const trusted = (e) => (!!win && !win.isDestroyed() && e.sender === win.webContents)
    || (!!setupWin && !setupWin.isDestroyed() && e.sender === setupWin.webContents);
  const on = (ch, fn) => ipcMain.on(ch, (e, ...a) => { if (trusted(e)) fn(e, ...a); });
  const handle = (ch, fn) => ipcMain.handle(ch, (e, ...a) => (trusted(e) ? fn(e, ...a) : null));
  handle('get-setup', () => ({
    game: { id: 'game', title: config.game.title, url: config.game.url },
    streams: currentStreams(),
    defaults: defaultStreams(),
    twitchAutoClaim: !!state.twitchAutoClaim,
    economy: !!state.economy,
    smartAudio: !!state.smartAudio,
    activeProfile: state.activeProfile || null,
    reportAvailable: !!stats.reportAvailable,
    notifyLive: state.notifyLive !== false,
    gameStats: stats.last,
    split: state.split || (config.layout && config.layout.split) || 60,
    startedAt,
    version: app.getVersion(),
    intro,
    maximized: win.isMaximized(),
    platform: process.platform,
    user: state.user || null,
    userLoading,
    loginOpen: loginWins.length > 0,
    watchdogPaused
  }));

  handle('discord-get', () => ({ set: !!state.discordWebhook, label: maskWebhook(state.discordWebhook), items: state.discordItems !== false }));
  handle('discord-set', (_e, url) => {
    url = String(url || '').trim();
    if (url && !DISCORD_RE.test(url)) return { ok: false, error: 'Isso não parece um link de webhook do Discord.' };
    state.discordWebhook = url || undefined; saveState();
    log(`[celular] webhook ${url ? 'configurado' : 'removido'}`);
    return { ok: true, label: maskWebhook(url) };
  });
  handle('discord-items', (_e, on) => { state.discordItems = !!on; saveState(); return true; });
  handle('discord-test', (_e, url) => {
    url = String(url || '').trim() || state.discordWebhook;
    if (!url || !DISCORD_RE.test(url)) return { ok: false, error: 'Cole o link do webhook primeiro.' };
    return notifyPhone({ url, title: 'Teste do PokeIdle Farm', description: 'Tudo certo! Os alertas de pokémon bom vão chegar aqui.', color: 0x53fc18 });
  });
  on('open-login', () => openLoginWindow());
  // Primeiro acesso: "já loguei" ou "prefiro não logar" → mostra o aviso final; depois reinicia.
  on('setup-done', (_e, skipped) => {
    log(`[setup] primeiro acesso concluído${skipped ? ' (sem login)' : ''}`);
    state.onboarding = 'done';
    state.pendingWelcome = true;
    try { fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2)); } catch { /* ignora */ }
    setupViews.forEach((v) => v.setVisible(false));
    setupPopouts.forEach((w) => !w.isDestroyed() && w.close());
  });
  on('setup-popout', (_e, i) => setupPopout(Number(i)));
  on('setup-relaunch', async () => {
    try { await ses.cookies.flushStore(); } catch { /* ignora */ }
    app.relaunch();
    app.isQuitting = true;
    app.exit(0);
  });
  on('set-economy', (_e, on) => setEconomy(on));
  on('set-notify-live', (_e, on) => { state.notifyLive = !!on; saveState(); pushGlobal(); });
  on('set-smart-audio', (_e, on) => { state.smartAudio = !!on; saveState(); pushGlobal(); });
  handle('get-report', () => getReport());
  on('toast-action', (_e, action) => {
    if (action === 'open-shot' && stats.lastShot) shell.showItemInFolder(stats.lastShot);
  });
  on('screenshot', () => screenshotGame());
  handle('profiles-get', () => ({ profiles: getProfiles(), active: state.activeProfile || null }));
  handle('profiles-save', (_e, name, list) => {
    name = String(name || '').trim().slice(0, 40);
    if (!name) return getProfiles();
    const streamsList = streams.normalizeList(list).map(({ platform, channel, title }) => ({ platform, channel, title }));
    state.profiles = [...getProfiles().filter((x) => x.name !== name), { name, streams: streamsList }];
    state.activeProfile = name;
    saveState(); buildTrayMenu();
    return getProfiles();
  });
  handle('profiles-delete', (_e, name) => {
    state.profiles = getProfiles().filter((x) => x.name !== name);
    if (state.activeProfile === name) delete state.activeProfile;
    saveState(); buildTrayMenu();
    return getProfiles();
  });
  handle('profiles-apply', (_e, name) => applyProfile(name));
  handle('streams-set', (_e, list) => {
    const next = applyStreams(list);
    state.streams = next.map(({ platform, channel, title }) => ({ platform, channel, title }));
    const ap = getProfiles().find((x) => x.name === state.activeProfile);
    if (ap && JSON.stringify(ap.streams.map((x) => x.platform + x.channel)) !== JSON.stringify(state.streams.map((x) => x.platform + x.channel))) delete state.activeProfile;
    saveState(); buildTrayMenu(); pushGlobal();
    return next;
  });
  handle('streams-reset', () => { delete state.streams; saveState(); return applyStreams(defaultStreams()); });
  handle('streams-parse', (_e, text, platform) => streams.parseInput(text, platform));
  handle('streams-verify', (_e, platform, channel) => streams.verify(ses, platform, channel));
  on('set-twitch-autoclaim', (_e, on) => { state.twitchAutoClaim = !!on; saveState(); log(`[twitch] resgate automático ${on ? 'ligado' : 'desligado'}`); });
  on('restart-app', () => restartApp());
  on('toggle-watchdog', () => {
    watchdogPaused = !watchdogPaused;
    log(`[watchdog] ${watchdogPaused ? 'pausado' : 'ativo'}`);
    pushGlobal();
  });


  on('layout', (_e, rects) => {
    for (const [id, r] of Object.entries(rects)) {
      const p = panels.get(id);
      if (!p || !r) continue;
      p.view.setBounds({
        x: Math.round(r.x), y: Math.round(r.y),
        width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height))
      });
    }
  });

  // Enquanto arrasta a divisória, esconde as páginas para o mouse não "cair" dentro delas.
  // Também usado quando a tela "Gerenciar lives" abre por cima (as páginas continuam rodando).
  on('dragging', (_e, on) => { modalOpen = !!on; applyViewVisibility(); });

  on('set-split', (_e, split) => { state.split = split; saveState(); });

  on('panel-action', (_e, { id, action }) => {
    const p = panels.get(id);
    if (!p) return;
    const wc = p.view.webContents;
    if (action === 'reload') reloadPanel(p, 'manual', { auto: false });
    if (action === 'mute') {
      wc.setAudioMuted(!wc.isAudioMuted());
      state.muted = { ...(state.muted || {}), [id]: wc.isAudioMuted() }; saveState();
    }
    if (action === 'zoom-in' || action === 'zoom-out') {
      const z = Math.min(2, Math.max(0.5, +(wc.getZoomFactor() + (action === 'zoom-in' ? 0.1 : -0.1)).toFixed(2)));
      wc.setZoomFactor(z);
      state.zoom = { ...(state.zoom || {}), [id]: z }; saveState();
    }
    if (action === 'external') { const u = wc.getURL() || p.url; if (isWebUrl(u)) shell.openExternal(u); }
    if (action === 'devtools') wc.toggleDevTools();
    pushStatus(p);
  });

  on('window', (_e, action) => {
    if (action === 'minimize') win.minimize();
    if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    if (action === 'close') win.close();
  });
}

// ---------------------------------------------------------------------------
// Segurança
// ---------------------------------------------------------------------------
// Aceita sozinho o aviso de cookies da Kick nas janelas/colunas de login (ele às vezes fica inclicável).
function autoKickCookies(wc) {
  wc.on('did-finish-load', () => {
    try { if (!/(^|\.)kick\.com$/.test(new URL(wc.getURL()).hostname)) return; } catch { return; }
    wc.executeJavaScript(kick.kickCookies, true).catch(() => {});
  });
}
function isWebUrl(u) {
  try { return ['https:', 'http:'].includes(new URL(u).protocol); } catch { return false; }
}

// Permissões que os sites podem pedir: só tela cheia e copiar pra área de transferência.
// Câmera, microfone, localização, notificações, USB/serial/HID etc. são sempre negados.
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);
function hardenSession(s) {
  s.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
  s.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  if (s.setDevicePermissionHandler) s.setDevicePermissionHandler(() => false);
  // Nenhum site baixa arquivos sozinho pro PC.
  s.on('will-download', (_e, item) => { log(`[seguranca] download bloqueado: ${item.getFilename()}`); item.cancel(); });
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
  // Interface do app: nunca navega pra fora nem abre janelas.
  if (contents.getType() === 'window' && win && contents === win.webContents) {
    contents.on('will-navigate', (e) => e.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    return;
  }
  // Páginas da web: só navegam pra http(s) (nada de file://, javascript: etc.).
  contents.on('will-navigate', (e, url) => { if (!isWebUrl(url) && url !== 'about:blank') e.preventDefault(); });
  contents.on('will-redirect', (e, url) => { if (!isWebUrl(url)) e.preventDefault(); });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
app.on('second-instance', () => { const w = win || setupWin; if (w) { w.show(); w.focus(); } });

let intro = null; // { kind: 'welcome' } na 1ª abertura, { kind: 'update', from } depois de atualizar
app.whenReady().then(async () => {
  const firstRun = !fs.existsSync(stateFile());
  loadState();
  const prevVersion = state.lastVersion || (firstRun ? null : '1.0.0');
  // Primeira vez (ou primeiro acesso não terminado): abre só a tela de login das 3 contas.
  const onboarding = firstRun || state.onboarding === 'pending';
  if (onboarding) state.onboarding = 'pending';
  else if (state.pendingWelcome) { intro = { kind: 'welcome' }; delete state.pendingWelcome; }
  else if (prevVersion !== app.getVersion()) intro = { kind: 'update', from: prevVersion };
  state.lastVersion = app.getVersion();
  saveState();

  // 3) Impede o Windows de suspender o app
  const blockerId = powerSaveBlocker.start('prevent-app-suspension');
  log('powerSaveBlocker ativo:', powerSaveBlocker.isStarted(blockerId));

  // 4) Sessão persistente (login fica salvo) com user agent de Chrome normal
  ses = session.fromPartition('persist:farm');
  hardenSession(ses);
  hardenSession(session.defaultSession);
  const ua = ses.getUserAgent().replace(/\s(Electron|pokeidle-farm)\/\S+/g, '');
  ses.setUserAgent(ua);
  app.userAgentFallback = ua;

  if (onboarding) { registerIpc(); openOnboarding(); return; }

  createWindow();
  registerIpc();
  createTray();

  const gamePanel = createPanel({ id: 'game', kind: 'game', title: config.game.title, url: config.game.url });
  const streamPanels = currentStreams().map((s) => createPanel({ ...s, kind: 'stream', url: streamUrl(s) }));

  // Extensões precisam estar carregadas antes das páginas abrirem.
  extensionsLoaded = await loadExtensions(ses, config.extensions, log);
  send('extensions', extensionsLoaded);
  win.webContents.on('did-finish-load', () => {
    send('extensions', extensionsLoaded);
    panels.forEach(pushStatus);
    pushGlobal();
  });

  gamePanel.view.webContents.loadURL(gamePanel.url).catch(() => {});
  if (startInLoginMode) openLoginWindow(); // lives só abrem depois do login
  else streamPanels.forEach((p) => p.view.webContents.loadURL(p.url).catch(() => {}));
  startWatchdog();
  startLiveReload();
  startMetrics();
  startNetworkWatch();
  startAutoUpdate();
  setInterval(pollSleeping, SLEEP_POLL_MS);
  setInterval(sampleGameStats, 30000);
  setTimeout(sampleGameStats, 15000);
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('window-all-closed', () => app.quit());
