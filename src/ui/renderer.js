const STATUS_LABEL = {
  loading: 'carregando', checking: 'verificando', live: 'ao vivo', ok: 'rodando',
  stalled: 'travado', offline: 'offline', error: 'erro', paused: 'pausado (login)'
};
const PANEL_TITLES = {};
const hhmm = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const POKEBALL = document.querySelector('.pokeball').outerHTML.replace(/class="[^"]*"/, '');

const $ = (sel, el = document) => el.querySelector(sel);
// Tudo que vem de fora (nome de canal, nick, títulos) passa por aqui antes de virar HTML.
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const panels = {}; // painéis das lives (o jogo agora é a área de contas)

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignora */ } }
};

// ---------- Estado da interface ----------
const ACC_COLORS = ['#53fc18', '#8b7bff', '#38bdf8', '#f5a524'];
const ui = {
  section: 'game',         // 'game' | 'lives'
  accView: 'one',          // 'one' | 'grid'
  active: 'game',          // conta na tela (na grade: a selecionada)
  accounts: [],
  maxAccounts: 4,
  statsById: {},
  statusById: {},
  metrics: null,
  hits: [],
  startedAt: Date.now()
};
const accIndex = (id) => Math.max(0, ui.accounts.findIndex((a) => a.id === id));
const accColor = (id) => ACC_COLORS[accIndex(id) % ACC_COLORS.length];
const accName = (a) => (a && a.nick) || (a && a.main ? 'Conta principal' : 'Nova conta');
const initials = (a) => {
  const n = (a && a.nick) || '';
  if (!n) return a && a.main ? '1' : String(accIndex(a.id) + 1);
  const parts = n.replace(/[^A-Za-z0-9_]/g, '').split(/_+/).filter(Boolean);
  return ((parts.length > 1 ? parts[0][0] + parts[1][0] : n.slice(0, 2)) || '?').toUpperCase();
};
const running = () => ui.accounts.filter((a) => !a.paused);
function stDot(id) {
  const a = ui.accounts.find((x) => x.id === id);
  if (!a || a.paused) return 'off';
  const s = ui.statusById[id] || a.status;
  if (s === 'error') return 'err';
  if (s === 'loading' || s === 'checking' || s === 'stalled' || (a.loading && !a.nick)) return 'warn';
  return '';
}

// ---------- Lives (tela "Lives") ----------
// Minimizar lives offline: automático (liga/desliga no rodapé) + botão manual em cada painel.
let autoCollapse = store.get('autoCollapseOffline', true);
const manualCollapse = {};
const lastStatus = {};
function applyCollapse(id) {
  const el = panels[id];
  if (!el || !el.classList.contains('stream')) return;
  const auto = autoCollapse && lastStatus[id] === 'offline';
  const collapsed = id in manualCollapse ? manualCollapse[id] : auto;
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

const PLATFORM_UI = {
  kick: { letter: 'K', host: 'kick.com', name: 'Kick' },
  twitch: { letter: 'T', host: 'twitch.tv', name: 'Twitch' }
};
let currentStreams = [];
let resizeObs = null;

function buildPanel({ id, title, platform }) {
  const el = $('#panel-tpl').content.firstElementChild.cloneNode(true);
  el.classList.add('stream', platform || 'kick');
  el.dataset.id = id;
  const pf = PLATFORM_UI[platform] || PLATFORM_UI.kick;
  $('.icon', el).textContent = pf.letter;
  $('.title', el).innerHTML = `${esc(title)}<small>${esc(pf.host)}</small>`;
  $('.placeholder span', el).textContent = `Abrindo ${pf.host}/${title}…`;
  $('.viewport', el).dataset.id = id;
  $('[data-local="collapse"]', el).addEventListener('click', () => {
    manualCollapse[id] = !el.classList.contains('collapsed');
    applyCollapse(id);
  });
  $('[data-local="shot"]', el).remove();
  el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => window.farm.panel(id, b.dataset.act)));
  panels[id] = el;
  PANEL_TITLES[id] = title;
  return el;
}

function renderStreams(list) {
  currentStreams = list;
  const right = $('#right');
  right.querySelectorAll('.panel.stream, .empty-streams').forEach((el) => {
    if (el.dataset.id) delete panels[el.dataset.id];
    el.remove();
  });
  list.forEach((s) => {
    const el = buildPanel(s);
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
  renderLivesMini();
  sendLayout();
}

function renderLivesMini() {
  const box = $('#lives-mini');
  if (!currentStreams.length) { box.innerHTML = '<p class="empty">Nenhuma live. <a class="link" id="lm-add">Adicionar</a></p>'; $('#lm-add').onclick = () => openManager(); return; }
  box.innerHTML = currentStreams.map((s) => {
    const st = lastStatus[s.id] || 'loading';
    const live = st === 'live';
    const label = live ? 'ao vivo' : st === 'offline' ? 'offline' : st === 'stalled' ? 'travada' : st === 'error' ? 'erro' : '...';
    return `<button class="lm ${s.platform === 'twitch' ? 'twitch' : 'kick'} ${live ? 'live' : ''} ${st === 'offline' ? 'off' : ''}" data-id="${esc(s.id)}"><em>${label}</em><b>${esc(s.title)}</b></button>`;
  }).join('');
  box.querySelectorAll('.lm').forEach((b) => b.addEventListener('click', () => setSection('lives')));
  const n = currentStreams.filter((s) => lastStatus[s.id] === 'live').length;
  const badge = $('#nav-live');
  badge.hidden = !n; badge.textContent = n;
}

function openManager(section) {
  window.openStreamManager({
    section,
    streams: currentStreams,
    twitchAutoClaim: window.__twitchAutoClaim,
    onOpen: () => window.farm.dragging(true),
    onClose: () => { window.farm.dragging(false); sendLayout(); refreshDiscord(); }
  });
}

// ---------- Posição das páginas ----------
// Envia ao processo principal a posição exata de cada "viewport" visível. O que não está na
// tela (outra aba, outra seção, live minimizada) não vai na lista e o processo principal esconde.
let rafPending = false;
function sendLayout() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const rects = {};
    document.querySelectorAll('.viewport').forEach((v) => {
      const r = v.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) rects[v.dataset.id] = { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    window.farm.layout(rects);
  });
}

// ---------- Seções (barra lateral) ----------
function setSection(sec) {
  ui.section = sec;
  $('#sec-game').hidden = sec !== 'game';
  $('#sec-lives').hidden = sec !== 'lives';
  document.querySelectorAll('.nav[data-section]').forEach((b) => b.classList.toggle('on', b.dataset.section === sec));
  window.farm.setUi({ section: sec });
  sendLayout();
}

// ---------- Contas ----------
function setActive(id) {
  if (!ui.accounts.some((a) => a.id === id && !a.paused)) return;
  ui.active = id;
  window.farm.setUi({ account: id });
  if (ui.section !== 'game') setSection('game');
  renderAccounts();
}
function setAccView(v) {
  ui.accView = v;
  window.farm.setUi({ accView: v });
  renderAccounts();
}

function placeholder(a) {
  const ph = document.createElement('div');
  ph.className = 'placeholder';
  ph.innerHTML = `<div class="spinner" style="--accent-solid:${accColor(a.id)}"></div><span>Abrindo PokeIdle${a.nick ? ` · ${esc(a.nick)}` : ''}…</span>`;
  return ph;
}
function viewport(a) {
  const v = document.createElement('div');
  v.className = 'viewport';
  v.dataset.id = a.id;
  v.append(placeholder(a));
  if (resizeObs) resizeObs.observe(v);
  return v;
}
const avatar = (a, extra = '') => `<span class="acc-av ${extra}" style="--c:${accColor(a.id)}">${esc(initials(a))}</span>`;

let gameAreaKey = '';
function renderAccounts() {
  const run = running();
  if (!run.some((a) => a.id === ui.active)) ui.active = (run[0] || { id: 'game' }).id;

  // barra lateral: um avatar por conta
  $('#side-accounts').innerHTML = ui.accounts.map((a) => `<button class="acc-av ${a.id === ui.active ? 'on' : ''} ${a.paused ? 'paused' : ''}" data-id="${a.id}" style="--c:${accColor(a.id)}" title="${esc(accName(a))}${a.paused ? ' (pausada)' : ''}">${esc(initials(a))}<i class="${stDot(a.id)}"></i></button>`).join('');
  document.querySelectorAll('#side-accounts .acc-av').forEach((b) => b.addEventListener('click', () => {
    const a = ui.accounts.find((x) => x.id === b.dataset.id);
    if (a && a.paused) openAccounts(); else setActive(b.dataset.id);
  }));

  // abas em cima do jogo
  $('#acc-tabs').innerHTML = ui.accounts.map((a) => `<button class="tab ${a.id === ui.active ? 'on' : ''} ${a.paused ? 'paused' : ''}" data-id="${a.id}">${avatar(a)}${esc(accName(a))}${a.level ? ` <small>Nv ${esc(a.level)}</small>` : ''}${a.paused ? ' <small>pausada</small>' : `<span class="sdot ${stDot(a.id)}"></span>`}</button>`).join('');
  document.querySelectorAll('#acc-tabs .tab').forEach((b) => b.addEventListener('click', () => {
    const a = ui.accounts.find((x) => x.id === b.dataset.id);
    if (a && a.paused) openAccounts(); else setActive(b.dataset.id);
  }));
  $('#tab-add-count').textContent = `${ui.accounts.length}/${ui.maxAccounts}`;
  $('#btn-grid').classList.toggle('on', ui.accView === 'grid');
  $('#btn-grid').hidden = run.length < 2;

  // área do jogo: recria só quando muda o conjunto de páginas (evita piscar)
  const area = $('#game-area');
  const grid = ui.accView === 'grid' && run.length > 1;
  const key = grid ? 'g:' + run.map((a) => a.id).join(',') : 'o:' + ui.active;
  if (key !== gameAreaKey) {
    gameAreaKey = key;
    area.innerHTML = '';
    area.className = `game-area ${grid ? `grid n${run.length}` : ''}`;
    if (!run.length) {
      area.innerHTML = '<div class="game-empty"><b>Todas as contas estão pausadas</b><button class="action primary">Gerenciar contas</button></div>';
      $('button', area).onclick = openAccounts;
    } else if (grid) {
      for (const a of run) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.id = a.id;
        cell.innerHTML = `<div class="cell-head">${avatar(a)}<b></b><small></small><span class="kv"></span></div>`;
        cell.querySelector('.cell-head').addEventListener('click', () => { ui.active = a.id; window.farm.setUi({ account: a.id }); renderAccounts(); });
        cell.append(viewport(a));
        area.append(cell);
      }
    } else {
      area.append(viewport(run.find((a) => a.id === ui.active)));
    }
  }
  area.querySelectorAll('.cell').forEach((cell) => {
    const a = ui.accounts.find((x) => x.id === cell.dataset.id) || {};
    const s = ui.statsById[a.id] || {};
    cell.classList.toggle('on', a.id === ui.active);
    cell.classList.toggle('warn', stDot(a.id) === 'warn' || stDot(a.id) === 'err');
    $('.cell-head b', cell).textContent = accName(a);
    $('.cell-head small', cell).textContent = a.level ? `Nv ${a.level}` : '';
    $('.cell-head .kv', cell).innerHTML = `XP/h <b>${fmtNum(s.xpRate)}</b> · ouro/h <b>${fmtNum(s.goldRate)}</b>`;
  });
  // placeholder some quando a página da conta já carregou (ela fica por cima mesmo)
  area.querySelectorAll('.viewport').forEach((v) => { const st = ui.statusById[v.dataset.id]; const ph = $('.placeholder', v); if (ph) ph.hidden = st === 'ok'; });

  const chipN = run.length;
  $('#farm-chip-text').textContent = `Farmando há ${fmtDur(Date.now() - ui.startedAt, true)}${chipN > 1 ? ` · ${chipN} contas` : ''}`;
  renderDash();
  renderUsage();
  if (!$('#accounts').hidden) renderAccountCards();
  sendLayout();
}

// ---------- Modal "Contas do PokeIdle" ----------
function openAccounts() {
  renderAccountCards();
  const close = openSheet('accounts');
  $('#acc-close').onclick = close;
  $('#acc-done').onclick = close;
}
function renderAccountCards() {
  const fmtAge = (t) => (t ? `farmando há ${fmtDur(Date.now() - t, true)}` : '');
  const cards = ui.accounts.map((a) => {
    const s = ui.statsById[a.id] || {};
    const low = [...(s.balls || []), ...(s.potions || [])].find((x) => x.on && x.qty !== null && x.qty < 100);
    const mem = ui.metrics && ui.metrics.panels[a.id];
    const sub = a.paused ? `${a.level ? `Nv ${a.level} · ` : ''}pausada` : [a.level ? `Nv ${a.level}` : (a.nick ? '' : 'faça login no painel do jogo'), fmtAge(a.since)].filter(Boolean).join(' · ');
    return `<div class="acc-card ${a.id === ui.active && !a.paused ? 'on' : ''}" data-id="${a.id}">
      ${avatar(a, a.paused ? 'paused' : '')}
      <div><b>${esc(accName(a))}</b><small>${esc(sub)}</small></div>
      <button class="sw ${a.paused ? 'off' : ''}" data-pause="${a.id}" ${a.main ? 'disabled title="A conta principal não pausa"' : `title="${a.paused ? 'Voltar a farmar' : 'Pausar (fecha a página e libera a memória)'}"`}></button>
      <div class="meta">
        ${a.main ? '<span class="tag g">principal</span>' : ''}
        ${low ? `<span class="tag o">${esc(low.name)} acabando</span>` : ''}
        ${a.paused ? '<span class="tag">pausada não gasta RAM</span>' : mem ? `<span class="tag">~${fmtMem(mem.mem)}</span>` : ''}
        <span class="spacer"></span>
        ${!a.paused ? `<button class="lnk" data-login="${a.id}">${a.nick ? 'Trocar login' : 'Login em janela'}</button>` : ''}
        ${!a.main ? `<button class="lnk rm" data-remove="${a.id}">Remover</button>` : ''}
      </div>
    </div>`;
  });
  const full = ui.accounts.length >= ui.maxAccounts;
  cards.push(`<div class="acc-card new ${full ? 'full' : ''}" id="acc-new"><span class="plus">+</span>${full ? 'Limite de 4 contas' : 'Adicionar conta'} <small>(${ui.accounts.length}/${ui.maxAccounts})</small></div>`);
  $('#acc-cards').innerHTML = cards.join('');
  document.querySelectorAll('.acc-mode').forEach((b) => {
    b.classList.toggle('on', b.dataset.view === ui.accView);
    b.onclick = () => { setAccView(b.dataset.view); renderAccountCards(); };
  });
  document.querySelectorAll('[data-pause]').forEach((b) => b.addEventListener('click', async () => {
    if (b.disabled) return;
    const a = ui.accounts.find((x) => x.id === b.dataset.pause);
    applyAccounts(await window.farm.accountsPause(a.id, !a.paused));
  }));
  document.querySelectorAll('[data-login]').forEach((b) => b.addEventListener('click', () => window.farm.accountsLogin(b.dataset.login)));
  document.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
    const a = ui.accounts.find((x) => x.id === b.dataset.remove);
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Remover e apagar o login?'; return; }
    applyAccounts(await window.farm.accountsRemove(a.id));
  }));
  const add = $('#acc-new');
  if (!full) add.onclick = async () => {
    const r = await window.farm.accountsAdd();
    if (r && r.ok) {
      applyAccounts(await window.farm.accountsGet());
      ui.active = r.id; window.farm.setUi({ account: r.id });
      showToast({ title: 'Conta nova aberta', body: 'Faça login no painel do jogo (ou em "Login em janela").', platform: 'ok' });
      renderAccounts();
    } else if (r) showToast({ title: 'Não deu pra adicionar', body: r.error, platform: 'warn' });
  };
}
function applyAccounts(list) {
  if (!Array.isArray(list)) return;
  ui.accounts = list;
  for (const a of list) if (a.status) ui.statusById[a.id] = ui.statusById[a.id] || a.status;
  renderAccounts();
}

// ---------- Números ----------
const fmtNum = (n) => {
  if (n === null || n === undefined || !isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' bi';
  if (a >= 1e6) return (n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' mi';
  if (a >= 1e4) return (n / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mil';
  return Math.round(n).toLocaleString('pt-BR');
};
const fmtMem = (b) => (b >= 1073741824 ? (b / 1073741824).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' GB' : Math.round(b / 1048576) + ' MB');
const fmtDur = (ms, short) => {
  const m = Math.round((ms || 0) / 60000);
  if (short) return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m} min`;
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}min` : `${m} min`;
};

// ---------- Painel da direita ----------
function bars(el, vals) {
  const v = (vals || []).slice(-20);
  const max = Math.max(1, ...v.map((x) => x || 0));
  el.innerHTML = v.map((x) => (x === null ? '<i class="none"></i>' : `<i style="height:${Math.max(8, (x / max) * 100).toFixed(0)}%"></i>`)).join('');
}
// XP por minuto → blocos de 3 min (20 barras = última hora)
const groupSpark = (spark) => { const out = []; for (let i = 0; i < 60; i += 3) { const g = (spark || []).slice(i, i + 3).filter((x) => x !== null); out.push(g.length ? g.reduce((a, b) => a + b, 0) : null); } return out; };

function renderDash() {
  const s = ui.statsById[ui.active] || {};
  const a = ui.accounts.find((x) => x.id === ui.active) || {};
  const many = running().length > 1;
  $('#xp-rate').textContent = s.found ? (s.xpRate === null ? 'medindo…' : fmtNum(s.xpRate)) : '–';
  $('#gold-rate').textContent = s.found ? (s.goldRate === null ? 'medindo…' : fmtNum(s.goldRate)) : '–';
  $('#xp-sub').textContent = s.found ? `+${fmtNum(s.xpGained)} nesta sessão` : 'esperando o jogo';
  $('#gold-sub').textContent = s.gold != null ? `${fmtNum(s.gold)} no total` : '';
  bars($('#spark-xp'), groupSpark(s.spark));
  bars($('#spark-gold'), s.spark ? groupSpark(s.spark).map((x) => (x === null ? null : x)) : []);
  // itens da conta na tela
  $('#items-acc').textContent = many ? accName(a) : '';
  const list = [...(s.balls || []).filter((x) => x.on || x.qty), ...(s.potions || []).filter((x) => x.on || x.qty)];
  const items = $('#items');
  if (!list.length) items.innerHTML = `<p class="empty">${s.found ? 'Nenhum item no automático.' : 'Esperando o jogo carregar…'}</p>`;
  else {
    const shown = list.sort((x, y) => (y.on - x.on) || ((y.qty || 0) - (x.qty || 0))).slice(0, 5);
    const max = Math.max(1000, ...shown.map((x) => x.qty || 0));
    items.innerHTML = shown.map((x) => {
      const cls = x.qty === 0 ? 'zero' : x.qty !== null && x.qty < 100 ? 'low' : '';
      const img = x.img ? `<img alt="" src="${esc(new URL(x.img, 'https://pokeidle.io').href)}">` : '<span></span>';
      return `<div class="item ${cls}">${img}<div><div class="n">${esc(x.name)}${x.on ? '<em>auto</em>' : ''}</div><div class="bar"><i style="width:${Math.max(2, ((x.qty || 0) / max) * 100).toFixed(1)}%"></i></div></div><span class="q">${x.qty === null ? '?' : (x.qty || 0).toLocaleString('pt-BR')}</span></div>`;
    }).join('');
  }
  // capturas boas (todas as contas)
  const today = new Date().toDateString();
  const hits = ui.hits.filter((h) => new Date(h.t).toDateString() === today);
  const shiny = hits.filter((h) => h.shiny);
  $('#hits-n').textContent = hits.length;
  $('#hits-sub').textContent = hits.length ? (many ? 'todas as contas' : 'acima do filtro') : 'nenhuma hoje ainda';
  $('#shiny-n').textContent = shiny.length ? `${shiny.length} ✨` : '0';
  $('#shiny-sub').textContent = shiny.length ? `${shiny[0].name} às ${hhmm(shiny[0].t)}` : 'nenhum ainda';
  const best = [...hits].sort((x, y) => (y.shiny - x.shiny) || ((y.nota ?? -1) - (x.nota ?? -1))).slice(0, 4);
  $('#best').innerHTML = best.length ? best.map((h) => `<div class="hit">
      <span class="nm">${h.shiny ? '✨ ' : ''}${esc(h.name)}<small>Nv ${esc(h.level ?? '?')}${many && h.acc ? ` · ${esc(h.acc)}` : ''}</small></span><time>${hhmm(h.t)}</time>
      <span class="tags"><span class="tg n">${h.nota == null ? '?' : Number(h.nota).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}</span><span class="tg">IV ${esc(h.iv ?? '?')}</span><span class="tg">Q ${h.q == null ? '?' : Number(h.q).toLocaleString('pt-BR', { maximumFractionDigits: 3 })}</span>${h.pot ? `<span class="tg">${esc(h.pot)}</span>` : ''}${h.shiny ? '<span class="tg s">shiny</span>' : ''}</span>
    </div>`).join('') : '<p class="empty">Os pokémons acima do filtro aparecem aqui.</p>';
}

function renderUsage() {
  const m = ui.metrics;
  const pm = m && m.panels[ui.active];
  $('#game-usage').textContent = pm ? `${Math.round(pm.cpu)}% · ${fmtMem(pm.mem)}` : '';
}

function renderMetrics(m) {
  ui.metrics = m;
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
  renderUsage();
  if (!$('#accounts').hidden) renderAccountCards();
}

// ---------- Relatório diário ----------
const fmtDay = (k, today) => (k === today ? 'Hoje' : new Date(k + 'T12:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }));
async function openReport() {
  const rep = await window.farm.getReport();
  const d = rep.days.find((x) => x.day === rep.today) || { xp: 0, gold: 0, farmMs: 0, live: {} };
  const hours = d.farmMs / 3600000;
  $('#rep-sub').textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })
    + (d.acc && Object.keys(d.acc).length > 1 ? ' · ' + Object.entries(d.acc).map(([n, x]) => `${n}: ${fmtNum(x.xp)} XP`).join(' · ') : '');
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
  const close = openSheet('report');
  $('#rep-close').onclick = close;
}

// ---------- Modais ----------
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
  const base = String(version || '').split('-')[0]; // 1.0.14-beta.3 → 1.0.14
  $('#news-sub').textContent = from ? `Atualizado da v${from} pra v${version}` : `Você está na v${version}`;
  $('#news-list').innerHTML = list.map((v) => `
    <section class="news-ver ${v.version === base ? 'current' : ''}">
      <h3>v${esc(v.version)}${v.version === base ? '<em>atual</em>' : ''}<small>${esc(v.date || '')}</small></h3>
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
  el.title = `${t.title}${t.body ? ' · ' + t.body : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 10000);
}

function setFocus(on) {
  document.body.classList.toggle('focus', on);
  $('#btn-focus').classList.toggle('on', on);
  $('#btn-focus span').textContent = on ? 'Sair do foco' : 'Foco';
  store.set('focus', on);
  sendLayout();
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
  setInterval(() => { $('#farm-chip-text').textContent = `Farmando há ${fmtDur(Date.now() - startedAt, true)}${running().length > 1 ? ` · ${running().length} contas` : ''}`; }, 30000);
}

async function refreshDiscord() {
  const d = await window.farm.discordGet().catch(() => null);
  const b = $('#btn-discord');
  const on = !!(d && (d.connected || d.set));
  b.classList.toggle('on', on);
  $('span', b).textContent = on ? 'Discord conectado' : 'Conectar Discord';
  $('#nav-alert-dot').hidden = on;
}

async function init() {
  const setup = await window.farm.getSetup();
  ui.startedAt = setup.startedAt;
  ui.maxAccounts = setup.maxAccounts || 4;
  ui.accView = (setup.ui && setup.ui.accView) || 'one';
  ui.active = (setup.ui && setup.ui.account) || 'game';
  ui.hits = (setup.hits || []).slice();
  $('.brand-name').title = `PokeIdle Farm v${setup.version || ''} · clique pra ver as novidades`;
  {
    const m = String(setup.version || '').match(/^([\d.]+)(?:-beta\.?(\d+))?/);
    $('#app-ver').textContent = m ? `v${m[1]}${m[2] ? ` beta ${m[2]}` : ''}` : '';
    $('#app-ver').classList.toggle('beta', !!(m && m[2]));
  }
  resizeObs = new ResizeObserver(sendLayout);
  if (setup.gameStats) ui.statsById.game = setup.gameStats;
  applyAccounts(setup.accounts || [{ id: 'game', main: true, nick: setup.user }]);
  window.__twitchAutoClaim = !!setup.twitchAutoClaim;
  window.__defaultStreams = setup.defaults || [];
  renderStreams(setup.streams);
  if (setup.ui && setup.ui.section === 'lives') setSection('lives');

  window.farm.on('streams-changed', renderStreams);
  window.farm.on('toast', showToast);
  window.farm.on('metrics', renderMetrics);
  window.farm.on('accounts-changed', applyAccounts);
  window.farm.on('game-stats', (s) => {
    const id = s.id || 'game';
    ui.statsById[id] = s;
    const a = ui.accounts.find((x) => x.id === id);
    if (a && ((s.nick && a.nick !== s.nick) || (s.level && a.level !== s.level))) { a.nick = s.nick || a.nick; a.level = s.level || a.level; renderAccounts(); return; }
    if (id === ui.active) renderDash();
    if (ui.accView === 'grid') renderAccounts();
  });
  window.farm.on('capture', (h) => { ui.hits.unshift(h); ui.hits.splice(60); renderDash(); });
  window.farm.on('toggle-focus', () => setFocus(!document.body.classList.contains('focus')));

  document.querySelectorAll('.nav[data-section]').forEach((b) => b.addEventListener('click', () => setSection(b.dataset.section)));
  $('#btn-focus').addEventListener('click', () => setFocus(!document.body.classList.contains('focus')));
  $('#btn-eco').addEventListener('click', () => window.farm.setEconomy(!document.body.classList.contains('economy')));
  $('#btn-accounts').addEventListener('click', openAccounts);
  $('#tab-add').addEventListener('click', openAccounts);
  $('#btn-grid').addEventListener('click', () => setAccView(ui.accView === 'grid' ? 'one' : 'grid'));
  $('#btn-shot').addEventListener('click', () => window.farm.screenshot());
  document.querySelectorAll('[data-gact]').forEach((b) => b.addEventListener('click', () => window.farm.panel(ui.active, b.dataset.gact)));
  $('#lives-open').addEventListener('click', () => setSection('lives'));
  $('#lives-manage').addEventListener('click', () => openManager());
  $('#best-alerts').addEventListener('click', () => openManager('phone'));
  $('#items-hint').addEventListener('click', () => showToast({ title: 'Comprar pelo Discord', body: `/comprar item quantidade${running().length > 1 ? ' conta:nick' : ''} na sua thread de alertas`, platform: 'ok' }));

  // Ctrl+1..9: expande/minimiza a live daquela posição (o atalho vem do processo principal).
  window.farm.on('shortcut', (sc) => {
    if (sc.expand) {
      const s = currentStreams[sc.expand - 1];
      const el = s && panels[s.id];
      if (!el) return;
      manualCollapse[s.id] = !el.classList.contains('collapsed');
      applyCollapse(s.id);
    }
  });
  $('#btn-report').addEventListener('click', () => openReport());
  $('#btn-report-nav').addEventListener('click', () => openReport());
  $('#btn-news').addEventListener('click', () => openNews(setup.version));
  if (setup.intro && setup.intro.kind === 'welcome') setTimeout(openWelcome, 600);
  else if (setup.intro && setup.intro.kind === 'update') {
    setTimeout(() => showToast({ title: `Atualizado pra v${setup.version}`, body: 'clique pra ver o que mudou', platform: 'ok', action: () => openNews(setup.version, setup.intro.from) }), 1500);
  }
  $('#btn-smartaudio').addEventListener('click', () => window.farm.setSmartAudio(!$('#btn-smartaudio').classList.contains('on')));
  if (store.get('focus', false)) setFocus(true);
  $('#btn-streams').addEventListener('click', () => openManager());
  $('#btn-alerts').addEventListener('click', () => openManager('phone'));
  $('#btn-discord').addEventListener('click', () => openManager('phone'));

  document.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => window.farm.window(b.dataset.win)));

  window.farm.on('panel-status', (s) => {
    if (s.id === 'game' || /^game-\d$/.test(s.id)) {
      const before = ui.statusById[s.id];
      ui.statusById[s.id] = s.status;
      if (before !== s.status) renderAccounts();
      $('#reloads').textContent = s.totalReloads;
      return;
    }
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
      renderLivesMini();
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
    if (g.accounts) applyAccounts(g.accounts);
    if (g.reportAvailable !== undefined) $('#btn-report').hidden = !g.reportAvailable;
    if (g.smartAudio !== undefined) {
      const sa = $('#btn-smartaudio');
      sa.classList.toggle('on', !!g.smartAudio);
      $('b', sa).textContent = g.smartAudio ? 'ligado' : 'desligado';
    }
    if (g.economy !== undefined && document.body.classList.contains('economy') !== !!g.economy) {
      document.body.classList.toggle('economy', !!g.economy);
      $('#btn-eco').classList.toggle('on', !!g.economy);
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
    $('span', btn).textContent = g.loginOpen ? 'Logando… feche as janelas' : loading ? 'carregando…' : 'Login';
    $('.avatar', btn).textContent = logged ? g.user[0] : '';
    btn.title = logged
      ? `Conta principal: ${g.user}. Clique para abrir as janelas de login (PokeIdle, Kick e Twitch).`
      : 'Abre o PokeIdle e a Kick em janelas normais pra logar. As lives pausam até você fechar as duas.';
    const wd = $('#btn-watchdog');
    wd.classList.toggle('off', !!g.watchdogPaused);
    $('b', wd).textContent = g.watchdogPaused ? 'desligado' : 'ligado';
    if (g.totalReloads !== undefined) $('#reloads').textContent = g.totalReloads;
    if (g.lastReload) {
      const box = $('#last-reload');
      box.hidden = false;
      const acc = ui.accounts.find((a) => a.id === g.lastReload.id);
      $('b', box).textContent = `${acc ? accName(acc) : PANEL_TITLES[g.lastReload.id] || g.lastReload.id} · ${g.lastReload.reason} · ${hhmm(g.lastReload.at)}`;
    }
  };
  applyGlobal(setup);
  window.farm.on('global-status', applyGlobal);

  window.farm.on('extensions', (list) => {
    const box = $('#ext-status');
    if (list && list.length) {
      box.className = 'stat ok';
      $('span', box).textContent = list.map((e) => `${e.name} v${e.version}`).join(' · ');
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
  startUptime(setup.startedAt);
  refreshDiscord();
  renderAccounts();
}

init();
