const STATUS_LABEL = {
  loading: 'carregando', checking: 'verificando', live: 'ao vivo', ok: 'rodando',
  stalled: 'travado', offline: 'offline', error: 'erro', paused: 'pausado (login)'
};
const PANEL_TITLES = {};
const hhmm = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const POKEBALL = document.querySelector('.pokeball').outerHTML.replace('class="pokeball"', '');

const $ = (sel, el = document) => el.querySelector(sel);
// Tudo que vem de fora (nome de canal, nick, títulos) passa por aqui antes de virar HTML.
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const panels = {};

// Minimizar lives offline: automático (liga/desliga no rodapé) + botão manual em cada painel.
// O clique manual vale até a live mudar de offline pra ao vivo (ou vice-versa).
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignora */ } }
};
let autoCollapse = store.get('autoCollapseOffline', true);
const manualCollapse = {};
const lastStatus = {};
function applyCollapse(id) {
  const el = panels[id];
  if (!el || !el.classList.contains('stream')) return;
  const auto = autoCollapse && lastStatus[id] === 'offline';
  const collapsed = document.body.classList.contains('economy') ? true : (id in manualCollapse ? manualCollapse[id] : auto);
  if (el.classList.contains('collapsed') !== collapsed) {
    el.classList.toggle('collapsed', collapsed);
    sendLayout();
  }
}
function renderAutoCollapse() {
  const b = $('#btn-autocollapse');
  b.classList.toggle('on', autoCollapse);
  $('b', b).textContent = autoCollapse ? 'ligado' : 'desligado';
}
let split = 60;

const PLATFORM_UI = {
  kick: { letter: 'K', host: 'kick.com', name: 'Kick' },
  twitch: { letter: 'T', host: 'twitch.tv', name: 'Twitch' }
};
let currentStreams = [];
let resizeObs = null;

function buildPanel({ id, title, url, platform }, kind) {
  const el = $('#panel-tpl').content.firstElementChild.cloneNode(true);
  el.classList.add(kind);
  el.dataset.id = id;
  const pf = PLATFORM_UI[platform] || PLATFORM_UI.kick;
  const host = kind === 'game' ? url.replace(/^https?:\/\//, '').replace(/\/$/, '') : `${pf.host}/${title}`;
  if (kind === 'game') {
    $('.icon', el).innerHTML = POKEBALL;
    $('.title', el).innerHTML = `${esc(title)}<small>${esc(host)}</small>`;
    $('.mute', el).remove();
  } else {
    el.classList.add(platform || 'kick');
    $('.icon', el).textContent = pf.letter;
    $('.title', el).innerHTML = `${esc(title)}<small>${esc(pf.host)}</small>`;
  }
  $('.placeholder span', el).textContent = `Abrindo ${host}…`;
  $('.viewport', el).dataset.id = id;
  $('[data-local="collapse"]', el).addEventListener('click', () => {
    manualCollapse[id] = !el.classList.contains('collapsed');
    applyCollapse(id);
  });
  if (kind === 'game') $('[data-local="collapse"]', el).remove();
  if (kind === 'game') $('[data-local="shot"]', el).addEventListener('click', () => window.farm.screenshot());
  else $('[data-local="shot"]', el).remove();
  el.querySelectorAll('[data-act]').forEach((b) =>
    b.addEventListener('click', () => window.farm.panel(id, b.dataset.act)));
  panels[id] = el;
  PANEL_TITLES[id] = title;
  return el;
}

// (Re)monta a coluna da direita com a lista de lives atual.
function renderStreams(list) {
  currentStreams = list;
  const right = $('#right');
  right.querySelectorAll('.panel.stream, .empty-streams').forEach((el) => {
    if (el.dataset.id) delete panels[el.dataset.id];
    el.remove();
  });
  list.forEach((s) => {
    const el = buildPanel({ ...s, url: '' }, 'stream');
    right.append(el);
    if (resizeObs) resizeObs.observe($('.viewport', el));
    applyCollapse(s.id);
  });
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-streams';
    empty.innerHTML = '<div class="empty-icon">+</div><b>Nenhuma live</b><span>Adicione lives da Kick ou da Twitch pra farmar junto.</span><button class="action primary">Adicionar live</button>';
    $('button', empty).addEventListener('click', () => openManager());
    right.append(empty);
  }
  sendLayout();
}

function openManager() {
  window.openStreamManager({
    streams: currentStreams,
    twitchAutoClaim: window.__twitchAutoClaim,
    onOpen: () => window.farm.dragging(true),
    onClose: () => { window.farm.dragging(false); sendLayout(); }
  });
}

// Envia ao processo principal a posição exata de cada "viewport" para encaixar as páginas.
let rafPending = false;
function sendLayout() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const rects = {};
    document.querySelectorAll('.viewport').forEach((v) => {
      const r = v.getBoundingClientRect();
      rects[v.dataset.id] = { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    window.farm.layout(rects);
  });
}

function applySplit() {
  // No modo economia as lives viram barrinhas: a coluna da direita encolhe e o jogo ganha espaço.
  $('#workspace').style.gridTemplateColumns = document.body.classList.contains('economy')
    ? '1fr 10px 300px'
    : `${split}fr 10px ${100 - split}fr`;
  sendLayout();
}

const fmtNum = (n) => {
  if (n === null || n === undefined || !isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' bi';
  if (a >= 1e6) return (n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' mi';
  if (a >= 1e4) return (n / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mil';
  return Math.round(n).toLocaleString('pt-BR');
};
const fmtMem = (b) => (b >= 1073741824 ? (b / 1073741824).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' GB' : Math.round(b / 1048576) + ' MB');

function renderStats(st) {
  const box = $('#game-stats');
  if (!st || !st.found) {
    box.classList.add('na');
    box.title = 'Ainda não consegui ler XP/ouro do PokeIdle. Espere o jogo carregar.';
    return;
  }
  box.classList.remove('na');
  $('#xp-rate').textContent = st.xpRate === null ? 'medindo…' : fmtNum(st.xpRate);
  $('#gold-rate').textContent = st.goldRate === null ? 'medindo…' : (st.gold === null ? '?' : fmtNum(st.goldRate));
  box.title = [
    `Nível ${st.level ?? '?'} · XP ${fmtNum(st.xp)} / ${fmtNum(st.xpMax)}`,
    `Ouro ${st.gold === null ? 'não encontrado' : fmtNum(st.gold)}`,
    `Nesta sessão: +${fmtNum(st.xpGained)} XP · +${fmtNum(st.goldGained)} ouro`,
    'Média da última hora. O gráfico mostra o XP ganho em cada minuto.'
  ].join('\n');
  renderItems('#balls', st.balls, 'Pokébolas');
  renderItems('#potions', st.potions, 'Potions');
  const vals = (st.spark || []).map((v) => (v === null ? 0 : v));
  const max = Math.max(1, ...vals);
  $('#spark polyline').setAttribute('points', vals.map((v, i) => `${i},${(15 - (v / max) * 14).toFixed(1)}`).join(' '));
}

// Pokébolas e potions no rodapé: mostra o item ligado no automático com mais quantidade.
function renderItems(sel, list, label) {
  const el = $(sel);
  if (!Array.isArray(list) || !list.length) { el.hidden = true; return; }
  el.hidden = false;
  const fmt = (x) => (x.qty === null ? '?' : fmtNum(x.qty));
  const on = list.filter((x) => x.on);
  const main = [...(on.length ? on : list)].sort((a, b) => (b.qty || 0) - (a.qty || 0))[0];
  const img = $('img', el);
  if (main.img) { img.src = new URL(main.img, 'https://pokeidle.io').href; img.hidden = false; } else img.hidden = true;
  $('b', el).textContent = fmt(main);
  el.classList.toggle('warn', main.qty !== null && main.qty < 100);
  el.title = `${label} (● = ligado no automático)\n` + list.map((x) => `${x.on ? '● ' : '○ '}${x.name}: ${fmt(x)}`).join('\n');
}

function renderMetrics(m) {
  $('#cpu').textContent = `${Math.round(m.cpu)}%`;
  $('#ram').textContent = fmtMem(m.mem);
  $('#metrics').classList.toggle('hot', m.cpu > 60);
  for (const [id, el] of Object.entries(panels)) {
    const u = $('.usage', el);
    const pm = m.panels[id];
    if (!u) continue;
    u.textContent = pm ? `${Math.round(pm.cpu)}% · ${fmtMem(pm.mem)}` : '';
    u.classList.toggle('hot', !!pm && pm.cpu > 25);
  }
}

// ---------- Relatório diário ----------
const fmtDur = (ms) => {
  const m = Math.round((ms || 0) / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}min` : `${m} min`;
};
const fmtDay = (k, today) => (k === today ? 'Hoje' : new Date(k + 'T12:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }));
async function openReport() {
  const rep = await window.farm.getReport();
  const d = rep.days.find((x) => x.day === rep.today) || { xp: 0, gold: 0, farmMs: 0, live: {} };
  const hours = d.farmMs / 3600000;
  $('#rep-sub').textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  $('#rep-xp').textContent = fmtNum(d.xp);
  $('#rep-xph').textContent = hours > 0.05 ? `${fmtNum(d.xp / hours)} por hora` : '';
  $('#rep-gold').textContent = fmtNum(d.gold);
  $('#rep-goldh').textContent = hours > 0.05 ? `${fmtNum(d.gold / hours)} por hora` : '';
  $('#rep-time').textContent = fmtDur(d.farmMs);
  $('#rep-level').textContent = d.level ? `nível ${d.level}` : '';
  const lives = Object.entries(d.live || {}).sort((a, b) => b[1] - a[1]);
  const plat = Object.fromEntries(currentStreams.map((s) => [s.title, s.platform]));
  const max = Math.max(d.farmMs, ...lives.map((x) => x[1]), 1);
  $('#rep-lives').innerHTML = lives.length
    ? lives.map(([name, ms]) => `<li class="${plat[name] === 'twitch' ? 'twitch' : 'kick'}"><span>${esc(name)}</span><span class="track"><span class="fill" style="width:${Math.max(2, (ms / max) * 100)}%"></span></span><span class="v">${fmtDur(ms)}</span></li>`).join('')
    : '<li class="none">Nenhuma live ficou ao vivo hoje enquanto o app estava aberto.</li>';
  $('#rep-days').innerHTML = rep.days.map((x) => `<tr class="${x.day === rep.today ? 'today' : ''}"><td>${fmtDay(x.day, rep.today)}</td><td>${fmtNum(x.xp)}</td><td>${fmtNum(x.gold)}</td><td>${fmtDur(x.farmMs)}</td></tr>`).join('');
  const modal = $('#report');
  modal.hidden = false;
  window.farm.dragging(true);
  const close = () => { modal.hidden = true; window.farm.dragging(false); sendLayout(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('#rep-close').onclick = close;
  modal.onmousedown = (e) => { if (e.target === modal) close(); };
}

// ---------- Boas-vindas (1ª abertura) e Novidades (depois de cada atualização) ----------
function openSheet(id, onClose) {
  const modal = $('#' + id);
  modal.hidden = false;
  window.farm.dragging(true);
  const close = () => {
    modal.hidden = true;
    if (!document.querySelector('.modal:not([hidden])')) { window.farm.dragging(false); sendLayout(); }
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  modal.onmousedown = (e) => { if (e.target === modal) close(); };
  return close;
}
function openWelcome() {
  const close = openSheet('welcome');
  $('#wel-later').onclick = close;
}
function openNews(version, from) {
  const list = window.CHANGELOG || [];
  $('#news-sub').textContent = from ? `Atualizado da v${from} pra v${version}` : `Você está na v${version}`;
  $('#news-list').innerHTML = list.map((v, i) => `
    <section class="news-ver ${v.version === version ? 'current' : ''}">
      <h3>v${esc(v.version)}${v.version === version ? '<em>atual</em>' : ''}<small>${esc(v.date || '')}</small></h3>
      <ul>${v.items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>
    </section>`).join('');
  const close = openSheet('news');
  $('#news-close').onclick = close;
  $('#news-ok').onclick = close;
  $('#news-welcome').onclick = () => { close(); openWelcome(); };
}

let toastTimer = null;
function showToast(t) {
  const el = $('#toast');
  el.className = `toast ${t.platform || ''} ${t.kind === 'live' ? 'is-live' : ''} ${t.action ? 'clickable' : ''}`;
  el.onclick = typeof t.action === 'function' ? () => { el.hidden = true; t.action(); } : t.action ? () => window.farm.toastAction(t.action) : null;
  $('b', el).textContent = t.title;
  $('span', el).textContent = t.body || '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 10000);
}

function setFocus(on) {
  document.body.classList.toggle('focus', on);
  $('#btn-focus').classList.toggle('on', on);
  $('#btn-focus span').textContent = on ? 'Sair do foco' : 'Foco';
  store.set('focus', on);
  applySplit();
}

function setupDivider() {
  const divider = $('#divider');
  const ws = $('#workspace');
  let dragging = false;
  divider.addEventListener('pointerdown', (e) => {
    dragging = true;
    divider.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging');
    window.farm.dragging(true);
  });
  divider.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = ws.getBoundingClientRect();
    split = Math.round(Math.min(80, Math.max(30, ((e.clientX - r.left) / r.width) * 100)));
    applySplit();
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('dragging');
    window.farm.dragging(false);
    window.farm.setSplit(split);
    sendLayout();
  };
  divider.addEventListener('pointerup', stop);
  divider.addEventListener('pointercancel', stop);
  divider.addEventListener('dblclick', () => { split = 60; applySplit(); window.farm.setSplit(split); });
}

function startUptime(startedAt) {
  const pad = (n) => String(n).padStart(2, '0');
  const tick = () => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    const d = Math.floor(s / 86400);
    const hms = `${pad(Math.floor(s / 3600) % 24)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
    $('#uptime').textContent = d ? `${d}d ${hms}` : hms;
  };
  tick();
  setInterval(tick, 1000);
}

async function init() {
  const setup = await window.farm.getSetup();
  split = setup.split;
  $('.brand-name').title = `PokeIdle Farm v${setup.version || ''} · clique pra ver as novidades`;
  $('#app-ver').textContent = setup.version ? `v${setup.version}` : '';

  $('#left').append(buildPanel(setup.game, 'game'));
  resizeObs = new ResizeObserver(sendLayout);
  window.__twitchAutoClaim = !!setup.twitchAutoClaim;
  window.__defaultStreams = setup.defaults || [];
  renderStreams(setup.streams);
  window.farm.on('streams-changed', renderStreams);
  window.farm.on('toast', showToast);
  window.farm.on('metrics', renderMetrics);
  window.farm.on('game-stats', renderStats);
  window.farm.on('toggle-focus', () => setFocus(!document.body.classList.contains('focus')));
  renderStats(setup.gameStats);
  $('#btn-focus').addEventListener('click', () => setFocus(!document.body.classList.contains('focus')));
  $('#btn-eco').addEventListener('click', () => window.farm.setEconomy(!document.body.classList.contains('economy')));
  // Ctrl+1..9: expande/minimiza a live daquela posição (o atalho vem do processo principal).
  window.farm.on('shortcut', (sc) => {
    if (sc.expand) {
      const s = currentStreams[sc.expand - 1];
      const el = s && panels[s.id];
      if (!el || document.body.classList.contains('economy')) return;
      manualCollapse[s.id] = !el.classList.contains('collapsed');
      applyCollapse(s.id);
    }
  });
  $('#btn-report').addEventListener('click', () => openReport());
  $('#btn-news').addEventListener('click', () => openNews(setup.version));
  if (setup.intro && setup.intro.kind === 'welcome') setTimeout(openWelcome, 600);
  else if (setup.intro && setup.intro.kind === 'update') {
    setTimeout(() => showToast({ title: `Atualizado pra v${setup.version}`, body: 'clique pra ver o que mudou', platform: 'ok', action: () => openNews(setup.version, setup.intro.from) }), 1500);
  }
  $('#btn-smartaudio').addEventListener('click', () => window.farm.setSmartAudio(!$('#btn-smartaudio').classList.contains('on')));
  if (store.get('focus', false)) setFocus(true);
  $('#btn-streams').addEventListener('click', () => openManager());

  document.querySelectorAll('[data-win]').forEach((b) =>
    b.addEventListener('click', () => window.farm.window(b.dataset.win)));

  window.farm.on('panel-status', (s) => {
    const el = panels[s.id];
    if (!el) return;
    const chip = $('.chip', el);
    chip.dataset.status = s.status;
    const wasOffline = lastStatus[s.id] === 'offline';
    const isOffline = s.status === 'offline';
    // loading/checking são transitórios: não mudam o estado de offline.
    if (!['loading', 'checking'].includes(s.status)) {
      if (s.id in lastStatus && wasOffline !== isOffline) delete manualCollapse[s.id];
      lastStatus[s.id] = s.status;
    }
    applyCollapse(s.id);
    $('em', chip).textContent = s.sleeping ? 'offline · dormindo' : (STATUS_LABEL[s.status] || s.status);
    el.classList.toggle('muted', !!s.muted);
    $('.title', el).title = s.reloads
      ? `${s.reloads} reload(s) automático(s) · último motivo: ${s.lastReason} · zoom ${Math.round(s.zoom * 100)}%`
      : `zoom ${Math.round(s.zoom * 100)}%`;
    chip.title = s.lastReason ? `Último reload: ${s.lastReason}` : '';
    $('#reloads').textContent = s.totalReloads;
  });

  $('#btn-login').addEventListener('click', () => window.farm.openLogin());
  $('#btn-restart').addEventListener('click', () => window.farm.restartApp());
  $('#btn-watchdog').addEventListener('click', () => window.farm.toggleWatchdog());
  const applyGlobal = (g) => {
    if (g.reportAvailable !== undefined) $('#btn-report').hidden = !g.reportAvailable;
    if (g.activeProfile !== undefined) {
      $('#btn-streams span').textContent = g.activeProfile ? `Lives · ${g.activeProfile}` : 'Lives';
    }
    if (g.smartAudio !== undefined) {
      const sa = $('#btn-smartaudio');
      sa.classList.toggle('on', !!g.smartAudio);
      $('b', sa).textContent = g.smartAudio ? 'ligado' : 'desligado';
    }
    if (g.economy !== undefined && document.body.classList.contains('economy') !== !!g.economy) {
      document.body.classList.toggle('economy', !!g.economy);
      $('#btn-eco').classList.toggle('on', !!g.economy);
      Object.keys(panels).forEach(applyCollapse);
      applySplit();
    }
    $('#btn-login').classList.toggle('active', !!g.loginOpen);
    const rs = $('#btn-restart');
    rs.classList.toggle('update', !!g.updatePending);
    $('span', rs).textContent = g.updatePending ? 'Atualização pronta · Reiniciar' : 'Reiniciar';
    const btn = $('#btn-login');
    const loading = !!g.userLoading && !g.loginOpen;
    const logged = !!g.user && !g.loginOpen && !loading;
    btn.classList.toggle('logged', logged);
    btn.classList.toggle('loading', loading);
    $('span', btn).textContent = g.loginOpen ? 'Logando… feche as janelas' : loading ? 'carregando…' : (g.user || 'Login');
    $('.avatar', btn).textContent = logged ? g.user[0] : '';
    btn.title = logged
      ? `Logado como ${g.user}. Clique para abrir as janelas de login de novo.`
      : 'Abre o PokeIdle e a Kick em janelas normais pra logar. As lives pausam até você fechar as duas.';
    const wd = $('#btn-watchdog');
    wd.classList.toggle('off', !!g.watchdogPaused);
    $('b', wd).textContent = g.watchdogPaused ? 'desligado' : 'ligado';
    if (g.totalReloads !== undefined) $('#reloads').textContent = g.totalReloads;
    if (g.lastReload) {
      const box = $('#last-reload');
      box.hidden = false;
      $('b', box).textContent = `${PANEL_TITLES[g.lastReload.id] || g.lastReload.id} · ${g.lastReload.reason} · ${hhmm(g.lastReload.at)}`;
    }
  };
  applyGlobal(setup);
  window.farm.on('global-status', applyGlobal);

  window.farm.on('extensions', (list) => {
    const box = $('#ext-status');
    const game = panels.game;
    $('.badge', game)?.remove();
    if (list && list.length) {
      box.className = 'stat ok';
      $('span', box).textContent = list.map((e) => `${e.name} v${e.version}`).join(' · ');
      const hunt = list.find((e) => /hunt/i.test(e.name));
      if (hunt) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = '/hunt ativo';
        $('.chip', game).after(badge);
      }
    } else {
      box.className = 'stat fail';
      $('span', box).textContent = 'nenhuma extensão carregada';
    }
  });

  new ResizeObserver(sendLayout).observe($('#workspace'));
  document.querySelectorAll('.viewport').forEach((v) => resizeObs.observe(v));
  window.addEventListener('resize', sendLayout);

  renderAutoCollapse();
  $('#btn-autocollapse').addEventListener('click', () => {
    autoCollapse = !autoCollapse;
    store.set('autoCollapseOffline', autoCollapse);
    Object.keys(manualCollapse).forEach((k) => delete manualCollapse[k]);
    renderAutoCollapse();
    Object.keys(panels).forEach(applyCollapse);
  });
  setupDivider();
  applySplit();
  startUptime(setup.startedAt);
}

init();
