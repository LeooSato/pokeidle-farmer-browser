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

// ---------------------------------------------------------------------------
// Contas do PokeIdle: até 4 (limite por pessoa nos termos do jogo), cada uma com sessão própria
// (login, cookies, localStorage e extensões separados). A principal é sempre "game", na mesma
// sessão persist:farm de antes, então quem atualiza não perde o login.
// ---------------------------------------------------------------------------
const MAX_ACCOUNTS = 4;
const ACCOUNT_ID_RE = /^game(-[2-4])?$/;
function accounts() {
  const list = (Array.isArray(state.accounts) ? state.accounts : []).filter((a) => a && ACCOUNT_ID_RE.test(a.id));
  if (!list.some((a) => a.id === 'game')) list.unshift({ id: 'game' });
  return list.slice(0, MAX_ACCOUNTS);
}
const accountOf = (id) => accounts().find((a) => a.id === id);
function setAccount(id, patch) {
  state.accounts = accounts().map((a) => (a.id === id ? { ...a, ...patch } : a));
  saveState();
}
const partitionOf = (id) => (id === 'game' ? 'persist:farm' : `persist:farm-${id.slice(5)}`);
const gamePanels = () => [...panels.values()].filter((p) => p.kind === 'game');
const nickOf = (p) => (p && (p.id === 'game' ? state.user : (accountOf(p.id) || {}).nick)) || null;
// Título dos avisos com o nick da conta na frente: "[alt_leo] Capturou Lairon Nv 40!"
const tagged = (p, title) => { const n = nickOf(p); return n ? `[${n}] ${title}` : title; };
// Estado de cada conta em execução (fica no próprio painel e some quando a conta pausa).
const newGameCtx = () => ({
  stats: { prev: null, xpGained: 0, goldGained: 0, samples: [], idsLogged: false, last: null },
  capSeen: new Set(), capReady: false, capSince: 0, capBusy: false,
  capQueue: new Map(), capSent: new Set(),
  notaLogged: false, notaLastRun: 0, notaCache: [],
  buyBusy: false, autoBuyLast: 0, autoBuyFails: 0,
  userLoading: true, userPoll: null
});
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
  send('global-status', { accounts: accountsInfo(), reportAvailable: !!stats.reportAvailable, activeProfile: state.activeProfile || null, smartAudio: !!state.smartAudio, economy: !!state.economy, notifyLive: state.notifyLive !== false, updatePending, userLoading, user: state.user || null, loginOpen: loginWins.length > 0, watchdogPaused, lastReload, totalReloads });
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
function createPanel({ id, kind, title, url, platform, channel, session: pses }) {
  const view = new WebContentsView({
    webPreferences: {
      session: pses || ses,
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
    stalled: 0, lastTime: null, noVideoSince: null, qualityFixed: false, lastLoad: Date.now(), createdAt: Date.now()
  };
  if (kind === 'game') p.g = newGameCtx();
  panels.set(id, p);

  const wc = view.webContents;
  // Contas extras começam mudas (4 jogos tocando junto ninguém merece).
  const muted = state.muted && id in state.muted ? state.muted[id] : ((kind === 'stream' && config.streamsMutedByDefault) || (kind === 'game' && id !== 'game'));
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
    if (kind === 'game') pollGameUser(p);
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
    if (kind === 'game' && details.reason !== 'killed' && !p.blankTries) notifyFarm('O jogo fechou sozinho', `O processo do jogo caiu (${details.reason}). Recarregando.`, 0xe5484d, p);
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
const stats = { reportAvailable: false, lastShot: null }; // geral (o resto fica em p.g.stats de cada conta)
const alive = (p) => !!p && panels.get(p.id) === p && !p.view.webContents.isDestroyed();
function sampleAllGames() { for (const p of gamePanels()) sampleGameStats(p); }
async function sampleGameStats(p) {
  if (!alive(p) || p.view.webContents.isLoading() || !kick.gameStats) return;
  const st = p.g.stats;
  let r;
  // timeout: com o renderer travado o executeJavaScript nunca volta
  try { r = await Promise.race([p.view.webContents.executeJavaScript(kick.gameStats, true), new Promise((ok) => setTimeout(() => ok('timeout'), 20000))]); } catch { r = null; }
  if (!alive(p)) return;
  checkBlank(p, r && r !== 'timeout' && (r.xp !== null || r.gold !== null));
  if (!r || r === 'timeout') return;
  if (!st.idsLogged && r.ids) { st.idsLogged = true; log(`[stats] ${p.id} ids encontrados: ${JSON.stringify(r.ids)}`); }
  const prev = st.prev;
  const before = { xp: st.xpGained, gold: st.goldGained };
  if (prev && r.xp !== null && prev.xp !== null) {
    if (r.xp >= prev.xp && (r.level === prev.level || r.level === null)) st.xpGained += r.xp - prev.xp;
    else if (prev.xpMax) st.xpGained += Math.max(0, prev.xpMax - prev.xp) + r.xp; // subiu de nível
  }
  if (prev && r.gold !== null && prev.gold !== null && r.gold > prev.gold) st.goldGained += r.gold - prev.gold;
  if (r.xp !== null || r.gold !== null) st.prev = r;
  const now = Date.now();
  st.samples.push({ t: now, xp: st.xpGained, gold: st.goldGained });
  st.samples = st.samples.filter((x) => now - x.t <= 61 * 60000);
  const first = st.samples[0];
  const hours = (now - first.t) / 3600000;
  const rate = (k) => (hours >= 2 / 60 ? (st.samples.at(-1)[k] - first[k]) / hours : null);
  // mini gráfico: XP ganho em cada minuto da última hora
  const spark = [];
  for (let i = 59; i >= 0; i--) {
    const a = st.samples.filter((x) => x.t <= now - (i + 1) * 60000).at(-1);
    const b = st.samples.filter((x) => x.t <= now - i * 60000).at(-1);
    spark.push(a && b ? b.xp - a.xp : null);
  }
  st.last = {
    found: r.xp !== null || r.gold !== null,
    level: r.level, xp: r.xp, xpMax: r.xpMax, gold: r.gold,
    xpGained: st.xpGained, goldGained: st.goldGained,
    xpRate: rate('xp'), goldRate: rate('gold'), spark
  };
  if (r.level != null && p.id !== 'game' && (accountOf(p.id) || {}).level !== r.level) setAccount(p.id, { level: r.level });
  if (r.level != null && p.id === 'game' && state.userLevel !== r.level) { state.userLevel = r.level; saveState(); }
  const items = await readItems(p);
  st.last.balls = items && items.balls;
  st.last.potions = items && items.potions;
  send('game-stats', { id: p.id, nick: nickOf(p), ...st.last });
  trackDaily(p, st.xpGained - before.xp, st.goldGained - before.gold, now);
  checkIdle(p, r, st.xpGained - before.xp, now);
}

// ---------------------------------------------------------------------------
// Pokébolas e potions: avisa só quando muda (um item que você tinha fica abaixo de 100 ou zera,
// ou todos os ligados no uso automático zeram). O que já estava zerado ao abrir não gera aviso.
// ---------------------------------------------------------------------------
async function readItems(p) {
  if (!kick.gameItems || !alive(p)) return null;
  let r;
  try { r = await p.view.webContents.executeJavaScript(kick.gameItems, true); } catch { return null; }
  if (!r) return null;
  if (Array.isArray(r.balls)) autoBuyBalls(p, r.balls);
  if (Array.isArray(r.balls)) checkItems(p, 'ball', r.balls, { all: 'Pokébolas acabaram', allBody: 'Todas as pokébolas ligadas no automático estão zeradas. Compre mais na loja.', body: 'Compre mais na loja pra continuar capturando.', limit: state.ballsLow ?? 100 });
  if (Array.isArray(r.potions)) checkItems(p, 'potion', r.potions, { all: 'Potions acabaram', allBody: 'Todas as potions do uso automático estão zeradas.', body: 'Compre mais potions pra equipe não desmaiar.', limit: state.potionsLow ?? 100 });
  return r;
}
// ---------- Compra automática de pokébola (desligada por padrão) ----------
// Quando a bola escolhida fica abaixo do mínimo, compra pelo próprio Market do jogo, no máximo
// uma vez a cada 30 min e só com ouro suficiente. Clique normal no botão do jogo: não explora
// falha, não burla limite e não sobrecarrega o servidor (termos do PokeIdle, seção 6, item 6).
// Vale pra todas as contas abertas, cada uma com o próprio ouro e o próprio intervalo.
const BALL_NAMES = ['Poke Ball', 'Great Ball', 'Super Ball', 'Ultra Ball'];
const autoBuyDefaults = () => ({ on: false, ball: 'Ultra Ball', min: 500, qty: 1000 });
const autoBuyCfg = () => ({ ...autoBuyDefaults(), ...(state.autoBuy || {}) });
async function autoBuyBalls(p, balls) {
  const cfg = autoBuyCfg();
  const g = p.g;
  if (!cfg.on || g.buyBusy || !kick.gameBuyBall) return;
  const ball = balls.find((b) => String(b.name).toLowerCase() === cfg.ball.toLowerCase());
  if (!ball || ball.qty == null || ball.qty >= cfg.min) return;
  const gap = g.autoBuyFails ? Math.min(4, g.autoBuyFails) * 30 * 60000 : 30 * 60000;
  if (Date.now() - g.autoBuyLast < gap) return;
  g.buyBusy = true; g.autoBuyLast = Date.now();
  try {
    let r;
    try { r = await p.view.webContents.executeJavaScript(kick.gameBuyBall(cfg.ball, cfg.qty), true); } catch (err) { r = { ok: false, error: err.message }; }
    r = r || { ok: false, error: 'sem resposta' };
    const fmt = (v) => (v == null ? '?' : Number(v).toLocaleString('pt-BR'));
    if (r.ok) {
      g.autoBuyFails = 0;
      const body = `Comprei ${fmt(r.bought)} ${cfg.ball} por ${fmt(r.bought * (r.price || 0))} de ouro. Agora você tem ${fmt(r.after)}.`;
      log(`[compra] ${p.id}: ${body}`);
      send('toast', { title: tagged(p, 'Pokébolas compradas'), body, platform: 'ok' });
      if (state.discordItems !== false) notifyPhone({ title: tagged(p, `Comprei ${fmt(r.bought)} ${cfg.ball}`), description: body, color: 0x53fc18 });
    } else {
      g.autoBuyFails++;
      const why = r.error === 'sem ouro' ? `ouro insuficiente (${fmt(r.gold)}, a ${cfg.ball} custa ${fmt(r.price)})` : r.error;
      log(`[compra] ${p.id} falhou: ${why}`);
      if (g.autoBuyFails === 1) notifyFarm('Compra automática falhou', `Não consegui comprar ${cfg.ball}: ${why}. Tento de novo mais tarde.`, 0xe5484d, p);
    }
  } finally { g.buyBusy = false; }
}
// ---------- Compras pedidas pelo Discord (/comprar) ----------
// O servidor não alcança o PC: o app pergunta a cada 45 s se tem pedido na fila (vale 30 min).
// "conta:" no comando escolhe a conta pelo nick; sem ela, compra na conta principal.
let cmdBusy = false;
function commandTarget(c) {
  const want = String(c.acc || '').trim().toLowerCase();
  if (!want) return panels.get('game') || null;
  return gamePanels().find((p) => String(nickOf(p) || '').toLowerCase() === want) || null;
}
async function pollCommands() {
  if (cmdBusy || !ALERT_SERVER || !state.alertSession) return;
  cmdBusy = true;
  try {
    const res = await net.fetch(`${ALERT_SERVER}/commands`, { headers: { authorization: `Bearer ${state.alertSession}` } });
    if (!res.ok) return;
    const { commands = [] } = await res.json().catch(() => ({}));
    for (const c of commands.slice(0, 3)) {
      if (c.type !== 'buy' || !['ball', 'potion'].includes(c.kind)) continue;
      const p = commandTarget(c);
      if (!p) {
        const open = gamePanels().map(nickOf).filter(Boolean).join(', ') || 'nenhuma';
        notifyPhone({ title: 'Não consegui comprar', description: `A conta "${String(c.acc).slice(0, 30)}" não está aberta no app. Contas abertas: ${open}.`, color: 0xe5484d });
        continue;
      }
      if (!kick.gameBuyItem) continue;
      if (c.name === 'auto') { // a bola/potion que está ligada no automático do jogo
        const items = await readItems(p);
        const list = items && (c.kind === 'ball' ? items.balls : items.potions);
        const on = Array.isArray(list) && (list.find((x) => x.on) || null);
        if (!on) { notifyPhone({ title: tagged(p, 'Não consegui comprar'), description: `Nenhuma ${c.kind === 'ball' ? 'pokébola' : 'potion'} ligada no automático do jogo. Use /comprar com o nome da bola.`, color: 0xe5484d }); continue; }
        c.name = on.name;
      }
      while (p.g.buyBusy) await new Promise((r) => setTimeout(r, 1000));
      if (!alive(p)) continue;
      p.g.buyBusy = true;
      let r;
      try { r = await p.view.webContents.executeJavaScript(kick.gameBuyItem(c.kind, c.name, c.qty), true); } catch (err) { r = { ok: false, error: err.message }; } finally { p.g.buyBusy = false; }
      r = r || { ok: false, error: 'sem resposta' };
      const fmt = (v) => (v == null ? '?' : Number(v).toLocaleString('pt-BR'));
      if (r.ok) {
        const body = `Comprei ${fmt(r.bought)} ${c.name} por ${fmt(r.bought * (r.price || 0))} de ouro. Agora você tem ${fmt(r.after)}.`;
        log(`[compra] pedido do Discord (${p.id}): ${body}`);
        send('toast', { title: tagged(p, `${c.name}: compra feita`), body, platform: 'ok' });
        notifyPhone({ title: tagged(p, `Comprei ${fmt(r.bought)} ${c.name}`), description: body + (r.bought < c.qty ? `\n(Pedido era ${fmt(c.qty)}; parei na metade do seu ouro.)` : ''), color: 0x53fc18 });
        const ia = p.g.stats.itemAlerts;
        if (ia) Object.keys(ia).forEach((k) => k.endsWith(':' + c.name) && delete ia[k]);
      } else {
        const why = r.error === 'sem ouro' ? `ouro insuficiente (${fmt(r.gold)}, custa ${fmt(r.price)} cada)` : r.error;
        log(`[compra] pedido do Discord falhou (${p.id}): ${why}`);
        notifyPhone({ title: tagged(p, `Não consegui comprar ${c.name}`), description: why, color: 0xe5484d });
      }
    }
  } catch (err) {
    log(`[compra] falha ao buscar pedidos: ${err.message}`);
  } finally { cmdBusy = false; }
}
// ---------- Alertas no celular (webhook do Discord) ----------
// O link do webhook fica só no state.json local; nunca vai pro log nem pro repositório.
const DISCORD_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,100}$/;
let discordLastSend = 0;
const DISCORD_ID_RE = /^\d{17,20}$/;
// Servidor de alertas (Cloudflare Worker): login entra no servidor do Discord e os alertas
// vão pra thread privada da pessoa. Sem ele, cai no webhook próprio (modo avançado).
const ALERT_SERVER = /^https:\/\/[\w.-]+(:\d+)?$/.test(String(config.alertServer || '')) ? String(config.alertServer).replace(/\/$/, '') : '';
async function notifyServer({ title, description, color, image, fields, mention, buy }) {
  try {
    const res = await net.fetch(`${ALERT_SERVER}/alert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${state.alertSession}` },
      body: JSON.stringify({ embed: { title, description, color, fields }, image: typeof image === 'string' ? image : undefined, mention: mention !== false, buy })
    });
    const r = await res.json().catch(() => ({}));
    if (res.ok && r.ok) return { ok: true };
    if (res.status === 401 || res.status === 410) {
      state.alertSession = undefined; saveState();
      send('toast', { title: 'Reconecte o Discord', body: 'Abra Alertas e clique em Conectar Discord de novo.', platform: 'warn' });
    }
    log(`[celular] servidor de alertas respondeu ${res.status}`);
    return { ok: false, error: r.error || `servidor respondeu ${res.status}` };
  } catch (err) {
    log(`[celular] falha ao enviar: ${err.message}`);
    return { ok: false, error: 'sem conexão com o servidor de alertas' };
  }
}
async function notifyPhone({ title, description, color = 0xf5a524, thumbnail, image, fields, mention = false, url, buy }) {
  const wait0 = discordLastSend + 1500 - Date.now();
  if (!url && ALERT_SERVER && state.alertSession) {
    if (wait0 > 0) await new Promise((r) => setTimeout(r, wait0));
    discordLastSend = Date.now();
    return notifyServer({ title: String(title).slice(0, 256), description: String(description || '').slice(0, 2000), color, image, fields, mention, buy });
  }
  url = url || state.discordWebhook;
  if (!url || !DISCORD_RE.test(url)) return { ok: false, error: ALERT_SERVER ? 'Clique em Conectar Discord primeiro.' : 'sem webhook' };
  const embed = { title: String(title).slice(0, 256), description: String(description || '').slice(0, 2000), color, timestamp: new Date().toISOString(), footer: { text: 'PokeIdle Farm' } };
  if (thumbnail && /^https:\/\//.test(thumbnail)) embed.thumbnail = { url: thumbnail };
  if (Array.isArray(fields)) embed.fields = fields.slice(0, 25).map((f) => ({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024), inline: f.inline !== false }));
  const who = mention ? (state.discordUserId || '') : '';
  const uid = DISCORD_ID_RE.test(who) ? who : null;
  const all = who === 'everyone' || who === 'here' ? who : null;
  const wait = discordLastSend + 1500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  discordLastSend = Date.now();
  try {
    const payload = { content: uid ? `<@${uid}>` : all ? `@${all}` : undefined, embeds: [embed], allowed_mentions: { parse: all ? ['everyone'] : [], users: uid ? [uid] : [] } };
    const png = typeof image === 'string' && image.startsWith('data:image/png;base64,') ? Buffer.from(image.slice(22), 'base64') : null;
    let res;
    if (png && png.length < 2e6) {
      embed.thumbnail = { url: 'attachment://pokemon.png' };
      const b = `----pokeidlefarm${Date.now().toString(16)}`;
      const body = Buffer.concat([
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n`),
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="files[0]"; filename="pokemon.png"\r\nContent-Type: image/png\r\n\r\n`),
        png,
        Buffer.from(`\r\n--${b}--\r\n`)
      ]);
      res = await net.fetch(url, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${b}` }, body });
    } else {
      res = await net.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    }
    if (res.ok) return { ok: true };
    log(`[celular] Discord respondeu ${res.status}`);
    return { ok: false, error: res.status === 404 || res.status === 401 ? 'webhook inválido ou apagado' : `Discord respondeu ${res.status}` };
  } catch (err) {
    log(`[celular] falha ao enviar: ${err.message}`);
    return { ok: false, error: 'sem conexão com o Discord' };
  }
}
// "Conectar Discord": OAuth2 implicit grant (só scope identify, sem client secret no app).
// Abre o login numa janela com sessão temporária, lê o token do redirect, pega só o ID e descarta o token.
const DISCORD_CLIENT_ID = '1570904100856537108';
const DISCORD_REDIRECT = 'http://127.0.0.1:53682/discord';
let discordAuthWin = null;
function discordConnect() {
  if (discordAuthWin && !discordAuthWin.isDestroyed()) { discordAuthWin.focus(); return Promise.resolve({ ok: false, error: 'A janela de login já está aberta.' }); }
  const nonce = require('crypto').randomBytes(16).toString('hex');
  const authUrl = ALERT_SERVER
    ? `${ALERT_SERVER}/login?s=${nonce}`
    : 'https://discord.com/oauth2/authorize?' + new URLSearchParams({ client_id: DISCORD_CLIENT_ID, response_type: 'token', scope: 'identify', redirect_uri: DISCORD_REDIRECT, state: nonce, prompt: 'consent' });
  return new Promise((resolve) => {
    let done = false;
    const w = discordAuthWin = new BrowserWindow({
      width: 520, height: 760, parent: win, modal: false, autoHideMenuBar: true, title: 'Conectar Discord',
      backgroundColor: '#313338', icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      webPreferences: { partition: 'discord-auth', contextIsolation: true, sandbox: true, nodeIntegration: false }
    });
    const finish = (r) => { if (done) return; done = true; resolve(r); if (!w.isDestroyed()) w.close(); };
    const onNav = async (e, url) => {
      if (!url.startsWith(DISCORD_REDIRECT)) return;
      e.preventDefault();
      const u = new URL(url);
      const q = new URLSearchParams(u.hash.slice(1) || u.search.slice(1));
      if (ALERT_SERVER) {
        if (q.get('s') !== nonce) return finish({ ok: false, error: 'Resposta inválida do servidor.' });
        const errs = { cancelado: 'Você cancelou a autorização.', servidor: 'Não consegui te colocar no servidor do Discord.', thread: 'Não consegui criar sua thread de alertas.' };
        if (q.get('error')) return finish({ ok: false, error: errs[q.get('error')] || 'O login no Discord falhou.' });
        const ses = q.get('session') || '';
        let uid = '';
        try { uid = String(JSON.parse(Buffer.from(ses.split('.')[0], 'base64url').toString('utf8')).u || ''); } catch { /* ignora */ }
        if (!DISCORD_ID_RE.test(uid)) return finish({ ok: false, error: 'Resposta inválida do servidor.' });
        state.alertSession = ses; setTimeout(syncCaptures, 3000);
        state.discordUserId = uid;
        state.discordUserName = String(q.get('name') || '').slice(0, 40);
        state.alertThread = /^\d{17,20}$/.test(q.get('thread') || '') && /^\d{17,20}$/.test(q.get('guild') || '') ? `https://discord.com/channels/${q.get('guild')}/${q.get('thread')}` : undefined;
        saveState();
        log('[celular] Discord conectado (servidor de alertas)');
        return finish({ ok: true, userId: uid, name: state.discordUserName, thread: state.alertThread });
      }
      if (q.get('error')) return finish({ ok: false, error: q.get('error') === 'access_denied' ? 'Você cancelou a autorização.' : 'O Discord recusou o login.' });
      if (q.get('state') !== nonce || !q.get('access_token')) return finish({ ok: false, error: 'Resposta inválida do Discord.' });
      try {
        const res = await net.fetch('https://discord.com/api/v10/users/@me', { headers: { authorization: `Bearer ${q.get('access_token')}` } });
        const me = res.ok ? await res.json() : null;
        if (!me || !DISCORD_ID_RE.test(String(me.id))) return finish({ ok: false, error: 'Não consegui ler sua conta do Discord.' });
        state.discordUserId = String(me.id);
        state.discordUserName = String(me.global_name || me.username || '').slice(0, 40);
        saveState();
        log('[celular] Discord conectado');
        finish({ ok: true, userId: state.discordUserId, name: state.discordUserName });
      } catch {
        finish({ ok: false, error: 'Sem conexão com o Discord.' });
      }
    };
    w.webContents.on('will-redirect', onNav);
    w.webContents.on('will-navigate', onNav);
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.on('closed', () => {
      discordAuthWin = null;
      session.fromPartition('discord-auth').clearStorageData().catch(() => {});
      finish({ ok: false, error: 'Janela fechada antes de terminar.' });
    });
    w.loadURL(authUrl);
  });
}
function maskWebhook(url) {
  const m = url && url.match(/webhooks\/(\d+)\//);
  return m ? `webhook …${m[1].slice(-4)}` : null;
}
// ---------- Capturas boas ----------
// Lê o painel "Capturas" de cada conta a cada 10s. Na primeira leitura só memoriza o que já estava lá,
// depois avisa (PC + Discord) quando aparece captura nova com nota >= mínimo ou shiny.
const fmtN = (n, d = 2) => (n == null ? '?' : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: d }));
async function checkAllCaptures() { for (const p of gamePanels()) await checkCaptures(p); }
async function checkCaptures(p) {
  const g = p && p.g;
  if (!g || g.capBusy || !alive(p) || p.view.webContents.isLoading() || !kick.gameCaptures) return;
  g.capBusy = true;
  try {
    let list;
    try { list = await p.view.webContents.executeJavaScript(kick.gameCaptures(false), true); } catch { list = null; }
    // Painel "Capturas" fora da tela: usa o histórico do jogo com a nota calculada pelo módulo do jogo.
    const hist = await histWithNota(p, Array.isArray(list) ? list : []);
    if (!Array.isArray(list)) list = hist;
    else { const have = new Set(list.map((c) => c.k)); list = list.concat(hist.filter((c) => !have.has(c.k))); }
    if (!list.length) return;
    queueCaptures(p, list);
    const capTs = (c) => Number(String(c.k).split(':')[0]);
    // O selo de nota (.pk-selo-n) é posto pela extensão /rate e pode chegar depois da linha.
    // Só marca a linha como vista quando a nota apareceu (ou depois de 30 min sem nota).
    const settled = (c) => c.nota != null || c.shiny || !(capTs(c) > 1e12) || Date.now() - capTs(c) > 30 * 60 * 1000;
    const fresh = list.filter((c) => !g.capSeen.has(c.k) && settled(c));
    fresh.forEach((c) => g.capSeen.add(c.k));
    if (!g.capReady) { g.capReady = true; g.capSince = Date.now(); list.forEach((c) => g.capSeen.add(c.k)); return; }
    const min = Number(state.captureMinScore ?? 3);
    // Só captura nova de verdade: o data-k começa com o horário da captura (ms). A lista é ordenada
    // por nota, então capturas antigas podem "aparecer" nela depois; essas não avisam.
    const isNew = (c) => {
      const ts = capTs(c);
      if (ts > 1e12) return ts >= g.capSince - 15000 && Date.now() - ts < 6 * 3600 * 1000;
      return !!c.novo;
    };
    const hits = fresh.filter(isNew).filter((c) => c.shiny || (c.nota != null && c.nota >= min));
    if (!hits.length) return;
    let withImg = [];
    if (state.discordWebhook) {
      try { withImg = await p.view.webContents.executeJavaScript(kick.gameCaptures(true), true) || []; } catch { withImg = []; }
    }
    for (const c of hits.slice(0, 5)) await captureAlert(p, c, (withImg.find((x) => x.k === c.k) || {}).img);
  } finally { g.capBusy = false; }
}
// ---------- Capturas pro /resumo do Discord ----------
// Toda captura (sem imagem) vai pro servidor de alertas, que guarda 48 h pra montar o /resumo.
// Só com o Discord conectado no modo servidor. A cada 5 min manda o que tiver (vale como "app ligado").
// Cada captura leva o nick da conta, pro /resumo separar por conta.
function queueCaptures(p, list) {
  const g = p.g;
  const acc = nickOf(p) || undefined;
  for (const c of list || []) {
    if (!c || !c.k || g.capSent.has(c.k)) continue;
    const t = Number(c.t) || Number(String(c.k).split(':')[0]);
    if (!(t > 1e12) || Date.now() - t > 48 * 3600 * 1000) continue;
    const prev = g.capQueue.get(c.k) || {};
    g.capQueue.set(c.k, { k: c.k, t, acc, name: c.name || prev.name, level: c.level ?? prev.level, nota: c.nota ?? prev.nota, iv: c.iv ?? prev.iv, q: c.q ?? prev.q, pot: c.pot ?? prev.pot, shiny: !!(c.shiny || prev.shiny) });
  }
}
let capSyncBusy = false;
async function syncCaptures() {
  if (capSyncBusy || !ALERT_SERVER || !state.alertSession) return;
  capSyncBusy = true;
  try {
    const games = gamePanels();
    for (const p of games) {
      if (!alive(p) || p.view.webContents.isLoading() || !kick.gameCaptureHist) continue;
      try {
        const hist = await p.view.webContents.executeJavaScript(kick.gameCaptureHist(), true);
        // linha do histórico sem nota: espera o painel completar se ela ainda estiver lá
        queueCaptures(p, (hist || []).filter((h) => !p.g.capQueue.has(h.k)));
      } catch {}
    }
    const batch = games.flatMap((p) => [...p.g.capQueue.values()].slice(0, 100).map((c) => ({ p, c }))).slice(0, 100);
    const res = await net.fetch(`${ALERT_SERVER}/captures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${state.alertSession}` },
      body: JSON.stringify({ ver: app.getVersion(), caps: batch.map((x) => x.c) })
    });
    if (res.ok) {
      for (const { p, c } of batch) {
        // sem nota ainda: deixa na fila mais um pouco pra mandar de novo com a nota do painel
        if (c.nota == null && Date.now() - c.t < 30 * 60 * 1000) continue;
        p.g.capQueue.delete(c.k); p.g.capSent.add(c.k);
      }
    } else if (res.status === 401 || res.status === 410) {
      log(`[resumo] servidor recusou o crachá (${res.status})`);
    }
  } catch (err) {
    log(`[resumo] falha ao sincronizar capturas: ${err.message}`);
  } finally { capSyncBusy = false; }
}
// Calibra qual função do /shared/nota-pokemon.mjs dá a mesma nota do painel. Só depois de bater
// em 3 capturas (e nenhuma diferente) passa a usar a nota calculada quando o painel não está na tela.
// A função escolhida vale pra todas as contas (é o mesmo jogo).
async function histWithNota(p, panel) {
  const g = p.g;
  if (!kick.gameHistNota) return [];
  const now = Date.now();
  const calibrated = !!state.notaFn;
  if (now - g.notaLastRun < (calibrated ? 10000 : 120000)) return calibrated ? g.notaCache : [];
  g.notaLastRun = now;
  const first = !g.notaLogged && p.id === 'game';
  let r;
  try { r = await p.view.webContents.executeJavaScript(kick.gameHistNota(state.notaFn || '', first), true); } catch (err) { r = { error: err.message }; }
  if (!r || r.error) { if (!g.notaLogged) { g.notaLogged = true; log(`[nota] ${p.id}: módulo do jogo indisponível: ${r && r.error}`); } return []; }
  if (!g.notaLogged) {
    g.notaLogged = true;
    if (first) {
      log(`[nota] exports de nota-pokemon.mjs: ${JSON.stringify((r.exports || []).map((e) => ({ k: e.k, t: e.t })))}`);
      const sample = (r.rows || []).slice(0, 3).map((x) => ({ k: x.k, by: x.by }));
      log(`[nota] amostra: ${JSON.stringify(sample)}`);
    }
  }
  const rows = r.rows || [];
  const panelNota = new Map(panel.filter((c) => c.nota != null).map((c) => [c.k, c.nota]));
  const cands = state.notaFn ? [state.notaFn] : [...new Set(rows.flatMap((x) => Object.keys(x.by)))];
  for (const fn of cands) {
    let ok = 0, bad = 0;
    for (const x of rows) { const pn = panelNota.get(x.k); if (pn == null || x.by[fn] == null) continue; if (Math.abs(x.by[fn] - pn) <= 0.002) ok++; else bad++; }
    if (!state.notaFn && ok >= 3 && bad === 0) { state.notaFn = fn; saveState(); log(`[nota] usando ${fn}() do jogo pra nota (bateu em ${ok} capturas)`); break; }
    if (state.notaFn === fn && bad >= 2 && bad > ok) { log(`[nota] ${fn}() parou de bater com o painel (${bad} diferentes), desligando`); state.notaFn = undefined; saveState(); }
  }
  if (!state.notaFn) return [];
  g.notaCache = rows.filter((x) => x.by[state.notaFn] != null).map((x) => ({
    k: x.k, t: x.t, name: x.name, level: x.level, nota: x.by[state.notaFn], iv: x.iv, ivMax: 192, q: x.q,
    pot: x.pot != null ? `P${x.pot}` : '', shiny: x.shiny, time: new Date(x.t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), src: 'hist'
  }));
  return g.notaCache;
}
// Últimas capturas boas (todas as contas) pro card "Melhores de hoje".
const recentHits = [];
async function captureAlert(p, c, img) {
  const head = `${c.shiny ? '✨ Shiny ' : ''}${c.name}${c.level ? ` Nv ${c.level}` : ''}`;
  const line = `Nota ${fmtN(c.nota, 3)}/10 · IV ${c.iv ?? '?'}${c.ivMax ? '/' + c.ivMax : ''} · Q ${fmtN(c.q, 3)} · ${c.pot || 'P?'}`;
  const nick = nickOf(p);
  log(`[captura] ${nick ? `[${nick}] ` : ''}${head} — ${line}`);
  const hit = { k: c.k, t: Number(String(c.k).split(':')[0]) || Date.now(), acc: nick, id: p.id, name: c.name, level: c.level, nota: c.nota, iv: c.iv, ivMax: c.ivMax, q: c.q, pot: c.pot, shiny: !!c.shiny };
  recentHits.unshift(hit); recentHits.splice(30);
  send('capture', hit);
  send('toast', { title: tagged(p, `Pokémon bom: ${head}`), body: line, platform: 'ok' });
  if (Notification.isSupported()) {
    const n = new Notification({ title: tagged(p, `PokeIdle: ${head}`), body: line, icon: path.join(__dirname, '..', 'assets', 'icon.png') });
    n.on('click', () => { win.show(); win.focus(); });
    n.show();
  }
  const fields = [
    { name: 'Nota', value: `**${fmtN(c.nota, 3)}** / 10` },
    { name: 'IV', value: `${c.iv ?? '?'}${c.ivMax ? ' / ' + c.ivMax : ''}${c.ivPct != null ? ` (${c.ivPct}%)` : ''}` },
    { name: 'Qualidade', value: `${fmtN(c.q, 3)}${c.qPct != null ? ` (top ${c.qPct}%)` : ''}` },
    { name: 'Potência', value: `${c.pot || '?'}${c.potTitle ? ` · ${c.potTitle}` : ''}` },
    { name: 'Nível', value: String(c.level ?? '?') }
  ];
  if (c.shiny) fields.push({ name: 'Shiny', value: '✨ Sim' });
  if (nick) fields.push({ name: 'Conta', value: nick });
  await notifyPhone({ title: tagged(p, `Capturou ${head}!`), description: c.time ? `Capturado às ${c.time}` : '', color: c.shiny ? 0xffd166 : 0x53fc18, fields, image: img, mention: true });
}
function itemAlert(p, key, title, body, buy) {
  const st = p.g.stats;
  st.itemAlerts = st.itemAlerts || {};
  if (st.itemAlerts[key]) return;
  st.itemAlerts[key] = true;
  log(`[itens] ${p.id}: ${title}`);
  send('toast', { title: tagged(p, title), body, platform: 'warn' });
  if (Notification.isSupported()) {
    const n = new Notification({ title: tagged(p, `PokeIdle: ${title}`), body, icon: path.join(__dirname, '..', 'assets', 'icon.png') });
    n.on('click', () => { win.show(); win.focus(); });
    n.show();
  }
  const conta = p.id !== 'game' && nickOf(p) ? ` conta:${nickOf(p)}` : '';
  const hint = buy && ALERT_SERVER && state.alertSession ? `\nPra comprar daqui: \`/comprar item:${buy.kind === 'ball' ? 'Pokébola' : 'Potion'} quantidade:1000${conta}\`` : '';
  if (state.discordItems !== false) notifyPhone({ title: tagged(p, title), description: body + hint, color: 0xe5484d, mention: !!buy });
}
function checkItems(p, kind, list, o) {
  const st = p.g.stats;
  st.itemAlerts = st.itemAlerts || {};
  st.itemPrev = st.itemPrev || {};
  const prev = st.itemPrev[kind] || {};
  for (const x of list) {
    if (x.qty === null) continue;
    const before = prev[x.name];
    const k0 = `${kind}:zero:${x.name}`, kl = `${kind}:low:${x.name}`;
    const buy = x.on ? { kind, name: x.name } : undefined; // dica do /comprar só pro item ligado no automático
    if (x.qty === 0) { if (before > 0) itemAlert(p, k0, `${x.name} acabou`, o.body, buy); }
    else if (x.qty < o.limit) { delete st.itemAlerts[k0]; if (before === undefined || before > x.qty) itemAlert(p, kl, `${x.name} acabando (${x.qty})`, `Restam ${x.qty}. ${o.body}`, buy); }
    else { delete st.itemAlerts[k0]; delete st.itemAlerts[kl]; }
  }
  const enabled = list.filter((x) => x.on);
  const hadAny = enabled.some((x) => prev[x.name] > 0);
  const allZero = enabled.length && enabled.every((x) => x.qty === 0);
  if (allZero && hadAny) itemAlert(p, `${kind}:all`, o.all, o.allBody);
  else if (!allZero) delete st.itemAlerts[`${kind}:all`];
  st.itemPrev[kind] = Object.fromEntries(list.map((x) => [x.name, x.qty]));
}

// ---------------------------------------------------------------------------
// Aviso de inatividade: XP parado por X minutos (padrão 10) → notificação.
// ---------------------------------------------------------------------------
// Tela do jogo cinza/vazia: a página "carregou" mas o jogo não aparece (sem XP nem ouro na barra).
// Aconteceu depois do processo do jogo cair: o reload voltou cinza e ficou assim por horas.
// Depois de 2 min assim recarrega; se 2 recargas não resolverem, derruba o processo da página
// (o handler de render-process-gone abre um novo do zero). O intervalo cresce até 10 min.
function checkBlank(p, ok) {
  const now = Date.now();
  if (ok) {
    if (p.blankTries) { log(`[game] ${p.id}: jogo voltou depois de ${p.blankTries} tentativa(s)`); notifyFarm('O jogo voltou', 'A tela do jogo voltou ao normal e o farm continuou.', 0x53fc18, p); }
    p.blankSince = null; p.blankTries = 0; p.gameSeen = true;
    return;
  }
  // só depois de o jogo ter aparecido uma vez (não atrapalha quem ainda está fazendo login)
  if (!p.gameSeen || p.paused || p.sleeping || p.view.webContents.isLoading() || now - (p.lastLoad || 0) < 90000) return;
  if (!p.blankSince) { p.blankSince = now; return; }
  const wait = Math.min(10, 2 * ((p.blankTries || 0) + 1)) * 60000;
  if (now - p.blankSince < wait) return;
  p.blankTries = (p.blankTries || 0) + 1;
  p.blankSince = now;
  if (p.blankTries === 1) notifyFarm('Tela do jogo travou', 'O jogo ficou cinza/sem resposta. Recarregando sozinho, te aviso quando voltar.', 0xe5484d, p);
  if (p.blankTries >= 3) {
    log(`[game] ${p.id}: tela vazia de novo (tentativa ${p.blankTries}): reiniciando o processo da página`);
    try { p.view.webContents.forcefullyCrashRenderer(); return; } catch { /* cai no reload normal */ }
  }
  reloadPanel(p, `tela do jogo vazia (tentativa ${p.blankTries})`);
}
// Aviso de problema no farm: PC + Discord (usa a mesma opção dos avisos de itens).
function notifyFarm(title, body, color, p) {
  if (p) title = tagged(p, title);
  log(`[farm] ${title}: ${body}`);
  send('toast', { title, body, platform: color === 0x53fc18 ? 'ok' : 'warn' });
  if (state.discordItems !== false) notifyPhone({ title, description: body, color });
}
function checkIdle(p, r, dxp, now) {
  if (r.xp === null) return;
  const st = p.g.stats;
  const limit = (state.idleMinutes || 10) * 60000;
  if (!st.lastXpUp || dxp > 0) {
    if (st.idleAlerted && dxp > 0) send('toast', { title: tagged(p, 'XP voltou a subir'), body: 'O farm voltou ao normal', platform: 'ok' });
    st.lastXpUp = now; st.idleAlerted = false;
    return;
  }
  if (st.idleAlerted || now - st.lastXpUp < limit) return;
  st.idleAlerted = true;
  const min = Math.round((now - st.lastXpUp) / 60000);
  log(`[stats] ${p.id}: XP parado há ${min} min`);
  if (state.discordItems !== false) notifyPhone({ title: tagged(p, `XP parado há ${min} min`), description: 'O Pokémon pode ter desmaiado, a poção acabado ou o jogo travado.', color: 0xe5484d });
  send('toast', { title: tagged(p, `XP parado há ${min} min`), body: 'Pokémon desmaiou, acabou poção ou o jogo travou?', platform: 'warn' });
  if (Notification.isSupported()) {
    const n = new Notification({
      title: tagged(p, `PokeIdle: XP parado há ${min} min`),
      body: 'Dá uma olhada: o Pokémon pode ter desmaiado, a poção acabado ou o jogo travado.',
      icon: path.join(__dirname, '..', 'assets', 'icon.png')
    });
    n.on('click', () => { win.show(); win.focus(); });
    n.show();
  }
}

// ---------------------------------------------------------------------------
// Relatório diário: XP, ouro, tempo farmando e tempo ao vivo de cada live, por dia.
// XP e ouro somam todas as contas (e ficam separados em d.acc); tempo e lives contam pela principal.
// ---------------------------------------------------------------------------
const dayKey = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE'); // AAAA-MM-DD no fuso local
function trackDaily(p, dxp, dgold, now) {
  const st = p.g.stats;
  const dt = st.lastDailyAt ? Math.min(now - st.lastDailyAt, 90000) : 0;
  st.lastDailyAt = now;
  state.daily = state.daily || {};
  const d = state.daily[dayKey(now)] = state.daily[dayKey(now)] || { xp: 0, gold: 0, farmMs: 0, live: {} };
  d.xp += Math.max(0, dxp); d.gold += Math.max(0, dgold);
  const nick = nickOf(p) || p.id;
  d.acc = d.acc || {};
  const a = d.acc[nick] = d.acc[nick] || { xp: 0, gold: 0, farmMs: 0 };
  a.xp += Math.max(0, dxp); a.gold += Math.max(0, dgold); a.farmMs += dt;
  if (st.last && st.last.level) a.level = st.last.level;
  if (p.id === 'game') {
    d.farmMs += dt;
    if (st.last && st.last.level) d.level = st.last.level;
    for (const s of panels.values()) {
      if (s.kind === 'stream' && s.status === 'live') d.live[s.title] = (d.live[s.title] || 0) + dt;
    }
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
  // a conta que está na tela (na grade, a primeira visível)
  const p = gamePanels().find((x) => x.shown) || panels.get('game');
  if (!p) return;
  try {
    const img = await p.view.webContents.capturePage();
    const dir = path.join(app.getPath('pictures'), 'PokeIdle Farm');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, (c) => (c === ' ' ? '_' : '-'));
    const nick = String(nickOf(p) || '').replace(/[^\w-]/g, '');
    const file = path.join(dir, `pokeidle_${nick ? nick + '_' : ''}${stamp}.png`);
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
  if (p.g) clearInterval(p.g.userPoll);
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
const IS_BETA = /-beta/.test(app.getVersion());
function setBetaUpdates(on) {
  state.betaUpdates = !!on; saveState();
  log(`[update] versões de teste ${on ? 'ligadas' : 'desligadas'}`);
  if (updater) { updater.allowPrerelease = IS_BETA || !!on; updater.checkForUpdates().catch(() => {}); }
  send('toast', { title: on ? 'Versões de teste ligadas' : 'Versões de teste desligadas', body: on ? 'Você vai receber as betas antes de todo mundo. Se algo quebrar, me avise.' : (IS_BETA ? 'Você volta pra versão normal quando sair a próxima.' : 'Só versões normais daqui pra frente.'), platform: 'ok' });
}
function startAutoUpdate() {
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return; // versão portátil não se atualiza sozinha
  try { updater = require('electron-updater').autoUpdater; } catch (e) { log(`[update] indisponível: ${e.message}`); return; }
  updater.autoDownload = true;
  // Beta: versão de teste (pré-release no GitHub). Quem já está numa beta continua recebendo.
  updater.allowPrerelease = IS_BETA || state.betaUpdates === true;
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
let userLoading = true; // da conta principal (botão de login da barra de título)
async function readGameUser(p) {
  if (!alive(p) || p.view.webContents.isLoading()) return null;
  try {
    const user = await p.view.webContents.executeJavaScript(kick.gameUser, true);
    if (user && user !== nickOf(p)) {
      const other = gamePanels().find((x) => x !== p && nickOf(x) === user);
      if (other) send('toast', { title: `${user} já está aberta em outra aba`, body: 'Duas abas na mesma conta brigam pelo farm. Saia dessa e entre com outra conta.', platform: 'warn' });
      if (p.id === 'game') state.user = user; else setAccount(p.id, { nick: user });
      saveState();
      log(`[game] ${p.id} logado como ${user}`);
      pushGlobal();
    }
    return user || null;
  } catch { return null; } // página ainda carregando
}
function pollGameUser(p) {
  if (!p || !p.g) return;
  clearInterval(p.g.userPoll);
  p.g.userLoading = true;
  if (p.id === 'game') { userLoading = true; pushGlobal(); }
  p.g.userPoll = setInterval(async () => {
    if (!alive(p)) { clearInterval(p.g.userPoll); return; }
    const user = await readGameUser(p);
    if (user) {
      clearInterval(p.g.userPoll);
      p.g.userLoading = false;
      if (p.id === 'game') userLoading = false;
      pushGlobal();
    }
  }, 2000);
}

// ---------------------------------------------------------------------------
// Gerenciar contas: adicionar (sessão nova), pausar (fecha o processo, 0 de RAM), remover.
// ---------------------------------------------------------------------------
let chromeUA = '';
const extSessions = new Set();
async function accountSession(id) {
  if (id === 'game') return ses;
  const s = session.fromPartition(partitionOf(id));
  if (!extSessions.has(id)) {
    extSessions.add(id);
    hardenSession(s);
    if (chromeUA) s.setUserAgent(chromeUA);
    // usa a cópia que a conta principal já baixou (não baixa de novo)
    await loadExtensions(s, config.extensions, log, { download: false });
  }
  return s;
}
async function openAccount(a) {
  if (!a || panels.has(a.id)) return panels.get(a.id);
  const s = await accountSession(a.id);
  const p = createPanel({ id: a.id, kind: 'game', title: config.game.title, url: config.game.url, session: s });
  p.shown = false; p.view.setVisible(false);
  p.view.webContents.loadURL(p.url).catch(() => {});
  log(`[contas] ${a.id}${a.nick ? ` (${a.nick})` : ''} aberta`);
  return p;
}
function accountsInfo() {
  return accounts().map((a) => {
    const p = panels.get(a.id);
    const last = p && p.g.stats.last;
    return {
      id: a.id, main: a.id === 'game', paused: !!a.paused,
      nick: a.id === 'game' ? state.user || null : a.nick || null,
      level: (last && last.level) ?? (a.id === 'game' ? state.userLevel : a.level) ?? null,
      status: p ? p.status : 'paused', since: p ? p.createdAt : null,
      loading: p ? !!p.g.userLoading : false
    };
  });
}
async function addAccount() {
  const list = accounts();
  if (list.length >= MAX_ACCOUNTS) return { ok: false, error: `O PokeIdle permite no máximo ${MAX_ACCOUNTS} contas por pessoa.` };
  const n = [2, 3, 4].find((i) => !list.some((a) => a.id === `game-${i}`));
  const a = { id: `game-${n}`, added: Date.now() };
  state.accounts = [...list, a]; saveState();
  log(`[contas] nova conta ${a.id}`);
  await openAccount(a);
  send('accounts-changed', accountsInfo());
  pushGlobal();
  return { ok: true, id: a.id };
}
async function pauseAccount(id, on) {
  if (id === 'game' || !accountOf(id)) return accountsInfo();
  setAccount(id, { paused: !!on });
  const p = panels.get(id);
  if (on && p) { destroyPanel(p); log(`[contas] ${id} pausada`); }
  if (!on && !p) await openAccount(accountOf(id));
  send('accounts-changed', accountsInfo());
  pushGlobal();
  return accountsInfo();
}
async function removeAccount(id) {
  if (id === 'game' || !accountOf(id)) return accountsInfo();
  const p = panels.get(id);
  if (p) destroyPanel(p);
  state.accounts = accounts().filter((a) => a.id !== id); saveState();
  // apaga login/cookies dessa conta do PC
  await session.fromPartition(partitionOf(id)).clearStorageData().catch(() => {});
  log(`[contas] ${id} removida (login apagado)`);
  send('accounts-changed', accountsInfo());
  pushGlobal();
  return accountsInfo();
}
// Login de uma conta extra numa janela normal (o painel recarrega quando ela fecha).
async function openAccountLogin(id) {
  const p = panels.get(id);
  if (!p || id === 'game') return openLoginWindow();
  const w = new BrowserWindow({
    width: 900, height: 820, title: `Login · PokeIdle (${nickOf(p) || 'nova conta'})`,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'), autoHideMenuBar: true,
    webPreferences: { session: await accountSession(id), contextIsolation: true, sandbox: true }
  });
  w.on('page-title-updated', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(({ url }) => (isWebUrl(url) ? { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 520, height: 720 } } : { action: 'deny' }));
  w.loadURL(config.game.url).catch(() => {});
  w.on('closed', () => { const q = panels.get(id); if (q) { q.failed = true; reloadPanel(q, 'após login', { auto: false }); } });
}
// Contas extras escondidas recarregam a cada 6 h, uma de cada vez (20 min de diferença entre elas),
// pra não acumular memória. Só quando não estão na tela.
function rotateHiddenAccounts() {
  const now = Date.now();
  gamePanels().filter((p) => p.id !== 'game').forEach((p, i) => {
    if (p.shown || p.view.webContents.isLoading()) return;
    if (now - (p.lastLoad || now) > 6 * 3600000 + i * 20 * 60000) reloadPanel(p, 'reload preventivo (conta escondida, 6 h)', { auto: false });
  });
}

function startWatchdog() {
  setInterval(() => { for (const p of gamePanels()) if (!p.g.userLoading) readGameUser(p); }, 60000);
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
    { label: 'Receber versões de teste (beta)', type: 'checkbox', checked: state.betaUpdates === true, click: (i) => setBetaUpdates(i.checked) },
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
  // shown: a interface mandou posição pra ele (aba/visão atual). Conta escondida continua rodando
  // (backgroundThrottling desligado), só não é desenhada: o mesmo que acontece com o app na bandeja.
  panels.forEach((p) => p.view.setVisible(!modalOpen && p.shown !== false && !(hidden && p.kind === 'stream')));
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
    gameStats: (panels.get('game') && panels.get('game').g.stats.last) || null,
    accounts: accountsInfo(),
    maxAccounts: MAX_ACCOUNTS,
    hits: recentHits,
    discordConnected: !!(ALERT_SERVER && state.alertSession),
    ui: state.ui || {},
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

  handle('discord-get', () => ({ server: !!ALERT_SERVER, connected: !!(ALERT_SERVER && state.alertSession), thread: state.alertThread || null, set: !!state.discordWebhook, label: maskWebhook(state.discordWebhook), items: state.discordItems !== false, userId: /^(everyone|here)$/.test(state.discordUserId || '') ? '@' + state.discordUserId : state.discordUserId || '', userName: state.discordUserName || '', minScore: state.captureMinScore ?? 3 }));
  handle('discord-prefs', (_e, o = {}) => {
    const raw = String(o.userId || '').trim().toLowerCase();
    const id = /^@?(everyone|here)$/.test(raw) ? raw.replace('@', '') : raw.replace(/[^\d]/g, '');
    if (raw && !id) return { ok: false, error: 'Use seu ID do Discord (só números) ou @everyone. O nome de usuário não dá pra marcar por webhook.' };
    if (id && !/^(everyone|here)$/.test(id) && !DISCORD_ID_RE.test(id)) return { ok: false, error: 'O ID do Discord tem de 17 a 20 números.' };
    const min = Number(o.minScore);
    if (id !== state.discordUserId) state.discordUserName = undefined;
    state.discordUserId = id || undefined;
    if (Number.isFinite(min)) state.captureMinScore = Math.max(0, Math.min(10, min));
    saveState();
    return { ok: true };
  });
  handle('discord-set', (_e, url) => {
    url = String(url || '').trim();
    if (url && !DISCORD_RE.test(url)) return { ok: false, error: 'Isso não parece um link de webhook do Discord.' };
    state.discordWebhook = url || undefined; saveState();
    log(`[celular] webhook ${url ? 'configurado' : 'removido'}`);
    return { ok: true, label: maskWebhook(url) };
  });
  handle('discord-connect', () => discordConnect());
  handle('discord-disconnect', () => { state.alertSession = undefined; state.alertThread = undefined; state.discordUserName = undefined; saveState(); return true; });
  handle('discord-open-thread', () => { if (state.alertThread) shell.openExternal(state.alertThread); return true; });
  handle('discord-items', (_e, on) => { state.discordItems = !!on; saveState(); return true; });
  handle('autobuy-get', () => ({ ...autoBuyCfg(), balls: BALL_NAMES }));
  handle('autobuy-set', (_e, o) => {
    const cur = autoBuyCfg();
    const int = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
    state.autoBuy = {
      on: o && typeof o.on === 'boolean' ? o.on : cur.on,
      ball: o && BALL_NAMES.includes(o.ball) ? o.ball : cur.ball,
      min: int(o && o.min, 0, 100000, cur.min),
      qty: int(o && o.qty, 1, 9999, cur.qty)
    };
    gamePanels().forEach((p) => { p.g.autoBuyFails = 0; p.g.autoBuyLast = 0; });
    saveState();
    log(`[compra] ${state.autoBuy.on ? `ligada: ${state.autoBuy.ball} abaixo de ${state.autoBuy.min}, compra ${state.autoBuy.qty}` : 'desligada'}`);
    return state.autoBuy;
  });
  handle('discord-test', (_e, url) => {
    url = String(url || '').trim();
    if (!url && ALERT_SERVER && state.alertSession) return notifyPhone({ mention: true, title: 'Teste do PokeIdle Farm', description: 'Tudo certo! Os alertas de pokémon bom vão chegar aqui, só pra você.', color: 0x53fc18 });
    url = url || state.discordWebhook;
    if (!url || !DISCORD_RE.test(url)) return { ok: false, error: ALERT_SERVER ? 'Clique em Conectar Discord primeiro.' : 'Cole o link do webhook primeiro.' };
    return notifyPhone({ url, mention: true, title: 'Teste do PokeIdle Farm', description: 'Tudo certo! Os alertas de pokémon bom vão chegar aqui.', color: 0x53fc18 });
  });
  on('open-login', () => openLoginWindow());
  handle('accounts-get', () => accountsInfo());
  handle('accounts-add', () => addAccount());
  handle('accounts-pause', (_e, id, on) => pauseAccount(String(id), !!on));
  handle('accounts-remove', (_e, id) => removeAccount(String(id)));
  on('accounts-login', (_e, id) => openAccountLogin(String(id)));
  // preferências só de interface (visão, conta na tela, seção da barra lateral)
  on('set-ui', (_e, o) => {
    if (!o || typeof o !== 'object') return;
    const ui = { ...(state.ui || {}) };
    if (['one', 'grid'].includes(o.accView)) ui.accView = o.accView;
    if (typeof o.account === 'string' && ACCOUNT_ID_RE.test(o.account)) ui.account = o.account;
    if (['game', 'lives'].includes(o.section)) ui.section = o.section;
    state.ui = ui; saveState();
  });
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


  // A interface manda a posição de cada página visível; o que ficou de fora (outra aba, outra tela) esconde.
  on('layout', (_e, rects) => {
    if (!rects || typeof rects !== 'object') return;
    for (const p of panels.values()) {
      const r = rects[p.id];
      p.shown = !!r && r.width > 1 && r.height > 1;
      if (!p.shown) continue;
      p.view.setBounds({
        x: Math.round(r.x), y: Math.round(r.y),
        width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height))
      });
    }
    applyViewVisibility();
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
  chromeUA = ua;
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
    send('accounts-changed', accountsInfo());
    panels.forEach(pushStatus);
    pushGlobal();
  });

  gamePanel.view.webContents.loadURL(gamePanel.url).catch(() => {});
  for (const a of accounts()) if (a.id !== 'game' && !a.paused) await openAccount(a);
  send('accounts-changed', accountsInfo());
  if (startInLoginMode) openLoginWindow(); // lives só abrem depois do login
  else streamPanels.forEach((p) => p.view.webContents.loadURL(p.url).catch(() => {}));
  startWatchdog();
  startLiveReload();
  startMetrics();
  startNetworkWatch();
  startAutoUpdate();
  setInterval(pollSleeping, SLEEP_POLL_MS);
  setInterval(sampleAllGames, 30000);
  setInterval(checkAllCaptures, 10000);
  setInterval(rotateHiddenAccounts, 5 * 60000);
  setTimeout(syncCaptures, 60 * 1000);
  setInterval(syncCaptures, 5 * 60 * 1000);
  setInterval(pollCommands, 45 * 1000);
  setTimeout(sampleAllGames, 15000);
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('window-all-closed', () => app.quit());
