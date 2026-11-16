// Scripts executados dentro das páginas (via webContents.executeJavaScript).
// Este arquivo é recarregado a quente: mudanças aqui valem sem reiniciar o app.

// Parte comum: acha o maior <video> da página e dá play se estiver pausado.
const videoState = `
  const vids = [...document.querySelectorAll('video')];
  const v = vids.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
  if (!v) return { hasVideo: false };
  let triedPlay = false;
  if (v.paused && !v.ended) { v.play().catch(() => {}); triedPlay = true; }
  return { hasVideo: true, paused: v.paused, ended: v.ended, time: v.currentTime, readyState: v.readyState, triedPlay };
`;

// Kick: aviso de cookies ("Tune your KICK experience") às vezes fica inclicável; o app aceita sozinho.
const kickCookiesClick = `
  try {
    const re = /^(accept all cookies|aceitar todos( os cookies)?|aceitar tudo|accept all)$/i;
    const b = [...document.querySelectorAll('button')].find((x) => re.test((x.textContent || '').trim()) && x.offsetParent);
    if (b) b.click();
  } catch {}
`;
// Roda por até 30 s depois que a página carrega (o aviso aparece com atraso).
const kickCookies = `(() => {
  if (window.__farmCookies) return;
  window.__farmCookies = true;
  let n = 0;
  const t = setInterval(() => { ${kickCookiesClick} if (++n > 30) clearInterval(t); }, 1000);
})()`;

// Kick: offline quando aparece "Última vez ao vivo há ..." (ou "Last live ..." em inglês).
const kickProbe = `(() => {
  ${kickCookiesClick}
  const text = (document.body && document.body.innerText) || '';
  if (/[ÚU]ltima vez ao vivo|Last live/i.test(text)) return { offline: true };
  ${videoState}
})()`;

// Twitch: aceita sozinho o aviso de conteúdo/maturidade e detecta o canal offline.
const twitchProbe = `(() => {
  const gate = document.querySelector(
    '[data-a-target="content-classification-gate-overlay-start-watching-button"],' +
    '[data-a-target="player-overlay-mature-accept"]'
  );
  if (gate) gate.click();
  const offlineEl = document.querySelector(
    '.channel-root__player--offline, [data-a-target="player-overlay-offline"], .offline-recommendations-video-card'
  );
  const text = (document.body && document.body.innerText) || '';
  if (offlineEl || /(est[áa] offline|is offline)/i.test(text)) return { offline: true };
  ${videoState}
})()`;

// Twitch (opcional): resgata o baú de pontos do canal quando ele aparece.
const twitchClaim = `(() => {
  const icon = document.querySelector(
    '.claimable-bonus__icon, button[aria-label="Claim Bonus"], button[aria-label="Resgatar bônus"], button[aria-label*="Resgatar B"]'
  );
  const btn = icon && (icon.closest('button') || icon);
  if (btn) { btn.click(); return true; }
  return false;
})()`;

// Melhor esforço: o player da Kick guarda a qualidade escolhida no localStorage.
const lowestQuality = `(() => {
  try {
    const before = localStorage.getItem('stream_quality');
    localStorage.setItem('stream_quality', '160');
    return before !== '160';
  } catch { return false; }
})()`;

// Nick do PokeIdle: fica em <span id="tr-nick">. Antes de carregar o jogo deixa um placeholder
// ("—", "...", "carregando"), então só aceita nick com letra ou número.
const gameUser = `(() => {
  const span = document.getElementById('tr-nick');
  const nick = span && span.textContent.trim();
  return nick && /[A-Za-z0-9]/.test(nick) && !/^(carregando|loading)/i.test(nick) ? nick : null;
})()`;

// Stats do PokeIdle (melhor esforço). Primeiro procura elementos com id "tr-..." (como o #tr-nick);
// se não achar, lê o texto "6.217.787 / 12.425.200 xp" do card do treinador e o ouro ao lado da moeda.
const gameStats = `(() => {
  const num = (t) => {
    if (!t) return null;
    const m = String(t).replace(/\\s/g, '').match(/([\\d.,]+)([kmb])?/i);
    if (!m) return null;
    let n = m[1];
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
    if (mult > 1) n = n.replace(',', '.'); else n = n.replace(/[.,]/g, '');
    const v = parseFloat(n) * mult;
    return isFinite(v) ? v : null;
  };
  const ids = {};
  document.querySelectorAll('[id^="tr-"]').forEach((e) => { ids[e.id] = (e.textContent || '').trim().slice(0, 40); });
  const byId = (re) => { const k = Object.keys(ids).find((k) => re.test(k)); return k ? ids[k] : null; };
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? r : null; };
  const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0);

  // XP do treinador: "atual / total xp"
  let xp = null, xpMax = null;
  const xpRe = /^([\\d.,]+)\\s*\\/\\s*([\\d.,]+)\\s*xp$/i;
  // #tr-xp-fill (a barra) vem antes de #tr-xp-txt: pega o id cujo texto é "atual / total xp".
  // Assim funciona também com a conta escondida (sem depender de elemento visível na tela).
  const xpKey = Object.keys(ids).find((k) => /xp|exp/i.test(k) && xpRe.test(ids[k]));
  const xpTxt = xpKey ? ids[xpKey] : null;
  const xpEl = xpTxt && xpRe.test(xpTxt) ? null : leaves
    .filter((e) => xpRe.test(e.textContent.trim()))
    .map((e) => ({ e, r: visible(e) })).filter((x) => x.r)
    .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)[0];
  const xm = (xpTxt && xpTxt.match(xpRe)) || (xpEl && xpEl.e.textContent.trim().match(xpRe));
  if (xm) { xp = num(xm[1]); xpMax = num(xm[2]); }

  // Nível: "Nv 500"
  let level = num(byId(/lvl|level|nivel|nv/i));
  if (level === null) {
    const nv = leaves.filter((e) => /^Nv\\.?\\s*\\d+$/i.test(e.textContent.trim()))
      .map((e) => ({ e, r: visible(e) })).filter((x) => x.r).sort((a, b) => a.r.top - b.r.top)[0];
    if (nv) level = num(nv.e.textContent);
  }

  // Ouro: id tr-gold/tr-ouro; senão o número logo depois de uma imagem/ícone de moeda.
  let gold = num(byId(/gold|ouro|coin|money/i));
  if (gold === null) {
    // usa o primeiro candidato cujo texto seja só um número (ex.: "73.510.221")
    const cands = [...document.querySelectorAll('img[src*="coin" i], img[src*="gold" i], img[alt*="ouro" i], img[alt*="gold" i], [class*="coin" i], [class*="gold" i]')];
    for (const e of cands) {
      if (!visible(e)) continue;
      const t = ((e.tagName === 'IMG' ? e.parentElement : e).textContent || '').trim();
      if (/^[\\d.,]+\\s*[kmb]?$/i.test(t)) { gold = num(t); break; }
    }
  }
  return { xp, xpMax, level, gold, ids };
})()`;

// Modo economia: força a menor qualidade no player (fica salva no localStorage de cada site).
const lowestQualityFor = (platform) => (platform === 'twitch' ? `(() => {
  try {
    const want = JSON.stringify({ default: '160p30' });
    const before = localStorage.getItem('video-quality');
    localStorage.setItem('video-quality', want);
    return before !== want;
  } catch { return false; }
})()` : lowestQuality);

const probeFor = (platform) => (platform === 'twitch' ? twitchProbe : kickProbe);

// Itens do PokeIdle (painel Automações): chips com nome no title ("Ultra Ball — eficiência ×4",
// "Golden Potion"), quantidade em .q, "on" = ligado no uso automático, "vazio" = acabou.
// Pokébolas: #auto-ball-opts (se não existir, usa #caidos-bolas, "Ultra Ball — você tem 21.623").
const gameItems = `(() => {
  const chips = (id) => {
    const box = document.getElementById(id);
    if (!box) return null;
    return [...box.querySelectorAll('.auto-chip')].map((b) => {
      const name = (b.getAttribute('title') || '').split(/\\s+[—–]\\s+/)[0].trim();
      const q = b.querySelector('.q');
      const n = q ? Number((q.textContent || '').replace(/[^\\d]/g, '')) : NaN;
      const img = b.querySelector('img');
      return { name, qty: Number.isFinite(n) ? n : null, on: b.classList.contains('on'), img: img ? img.getAttribute('src') : null };
    }).filter((x) => x.name);
  };
  let balls = chips('auto-ball-opts');
  if (!balls) {
    const box = document.getElementById('caidos-bolas');
    balls = box ? [...box.querySelectorAll('.caidos-bola')].map((b) => {
      const t = b.getAttribute('title') || '';
      const m = t.match(/^(.*?)\\s+[—–]\\s+.*?([\\d.,]+)\\s*$/);
      const img = b.querySelector('img');
      return { name: m ? m[1].trim() : t.trim(), qty: m ? Number(m[2].replace(/[.,]/g, '')) : null, on: b.classList.contains('on'), img: img ? img.getAttribute('src') : null };
    }).filter((x) => x.name) : null;
  }
  return { balls, potions: chips('auto-potion-opts'), revives: chips('auto-revive-opts') };
})()`;

// Capturas recentes do painel "Capturas" (#capturas-painel). Cada linha tem data-k único,
// nome, nível, selos de potência/IV/qualidade/nota e o sprite num <canvas>.
// Com sprite=true devolve o sprite ampliado (pixelado) como data URL pra mandar no Discord.
const gameCaptures = (sprite) => `(() => {
  const num = (t) => { const m = String(t || '').match(/\\d+(?:[.,]\\d+)?/); return m ? Number(m[0].replace(',', '.')) : null; };
  const txt = (el, sel) => { const e = el.querySelector(sel); return e ? e.textContent.trim() : ''; };
  const ttl = (el, sel) => { const e = el.querySelector(sel); return e ? (e.getAttribute('title') || '') : ''; };
  const rows = [...document.querySelectorAll('#capturas-painel li.capturas-linha[data-k]')];
  if (!document.getElementById('capturas-painel')) return null;
  return rows.slice(0, 60).map((li) => {
    const ivTitle = ttl(li, '.pk-selo-iv');
    const ivMax = (ivTitle.match(/de\\s+(\\d+)/) || [])[1];
    const ivPct = (ivTitle.match(/(\\d+)%/) || [])[1];
    const qTitle = ttl(li, '.pk-selo-q');
    const qPct = (qTitle.match(/(\\d+)%/) || [])[1];
    // Só classe: o title do selo de nota fala "(IV, qualidade, potência e shiny)" em toda linha.
    const shiny = /(^|[\\s-])shiny(\\s|$)/i.test(li.className) || !!li.querySelector('.cap-shiny, .pk-selo-shiny, .shiny, [class~="cm-shiny"]');
    const novo = li.classList.contains('nova') || !!li.querySelector('.cap-novo');
    let img = null;
    if (${sprite ? 'true' : 'false'}) {
      try {
        const c = li.querySelector('.cap-retrato canvas');
        if (c && c.width) {
          const k = Math.max(1, Math.floor(160 / c.width));
          const o = document.createElement('canvas'); o.width = c.width * k; o.height = c.height * k;
          const g = o.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(c, 0, 0, o.width, o.height);
          img = o.toDataURL('image/png');
        }
      } catch (e) { img = null; }
    }
    return {
      k: li.getAttribute('data-k'),
      name: txt(li, '.cap-nome'),
      level: num(txt(li, '.cap-nv')),
      time: ttl(li, '.cap-hora') || txt(li, '.cap-hora'),
      pot: txt(li, '.cm-pot'),
      potTitle: ttl(li, '.cm-pot').split(/\\s+[—–]\\s+/)[1] || '',
      iv: num(txt(li, '.pk-selo-iv')), ivMax: ivMax ? Number(ivMax) : null, ivPct: ivPct ? Number(ivPct) : null,
      q: num(txt(li, '.pk-selo-q')), qPct: qPct ? Number(qPct) : null,
      nota: num(txt(li, '.pk-selo-n')),
      shiny, novo, img
    };
  }).filter((x) => x.k && x.name);
})()`;

// Histórico que o próprio jogo guarda (localStorage "capturas-hist:<nick>", ~últimas 18). Não tem nota,
// mas pega captura que não aparece no painel. A chave bate com o data-k do painel: "<em>:<id>".
const gameCaptureHist = () => `(() => {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!/^capturas-hist:/.test(key)) continue;
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      if (!Array.isArray(list)) continue;
      for (const c of list.slice(0, 200)) {
        if (!c || !c.em || c.id == null || !c.nome) continue;
        const ivs = c.ivs && typeof c.ivs === 'object' ? Object.values(c.ivs).reduce((a, b) => a + (Number(b) || 0), 0) : null;
        out.push({ k: c.em + ':' + c.id, t: Number(c.em), name: String(c.nome), level: c.level, iv: ivs, q: c.quality, pot: c.potencia, shiny: c.shiny === true });
      }
    }
  } catch (e) {}
  return out;
})()`;

// Compra de pokébola pelo próprio Market do jogo: abre o modal, aba Comprar, categoria Pokebolas,
// acha o card pelo nome, põe a quantidade e clica em Comprar. Confere pelo "você tem ×N" do card.
// Devolve { ok, before, after, gold, price, error }. Só fecha o modal se foi ele que abriu.
const gameBuyItem = (kind, name, qty) => `(async () => {
  const want = ${JSON.stringify(String(name))}.toLowerCase();
  const catRe = ${kind === 'potion' ? '/po[çc][õo]es|potion/i' : '/pok[eé]bola|bola/i'};
  const qty = ${Math.max(1, Math.min(9999, Math.floor(Number(qty) || 0)))};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const n = (t) => { const v = Number(String(t || '').replace(/[^\\d]/g, '')); return Number.isFinite(v) ? v : null; };
  const nameOf = (c) => { const e = c.querySelector('.mk-nome'); return e ? (e.getAttribute('title') || e.textContent).trim().toLowerCase() : ''; };
  const card = () => {
    const all = [...document.querySelectorAll('.mk-card')];
    return all.find((c) => nameOf(c) === want) || all.find((c) => nameOf(c) && (nameOf(c).includes(want) || want.includes(nameOf(c))));
  };
  const until = async (fn, ms = 5000) => { for (let t = 0; t < ms; t += 150) { const v = fn(); if (v) return v; await sleep(150); } return null; };
  const modal = () => document.querySelector('.modal-caixa[data-modal="market"]');
  let opened = false;
  try {
    if (!modal() || !card()) {
      const btn = document.querySelector('button[data-modal="market"]');
      if (!btn) return { ok: false, error: 'botão Market não encontrado' };
      btn.click(); opened = true;
      if (!await until(() => document.querySelector('#mk-modos'))) return { ok: false, error: 'Market não abriu' };
    }
    const tab = document.querySelector('#mk-modos [data-aba="compra"]');
    if (tab && !tab.classList.contains('on')) { tab.click(); await sleep(400); }
    if (!card()) {
      const cat = [...document.querySelectorAll('.mk-cat')].find((b) => catRe.test(b.textContent));
      if (cat) { cat.click(); await sleep(400); }
    }
    const c = await until(card);
    if (!c) return { ok: false, error: 'card da ' + want + ' não encontrado' };
    const gold = n((document.querySelector('#mk-saldo') || {}).textContent);
    const price = n((c.querySelector('.mk-pal-preco .mk-moeda') || {}).textContent);
    const before = n((c.querySelector('.mk-tem') || {}).getAttribute && c.querySelector('.mk-tem').getAttribute('data-tem'));
    let buy = qty;
    // nunca gasta mais que metade do ouro numa compra
    if (gold != null && price) buy = Math.min(qty, Math.floor(gold * 0.5 / price));
    if (buy < 1) return { ok: false, error: 'sem ouro', gold, price, before };
    const input = c.querySelector('.mk-qtd input');
    if (!input) return { ok: false, error: 'campo de quantidade não encontrado' };
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, String(buy));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(250);
    const go = c.querySelector('.mk-pal-comprar, .mk-acao');
    if (!go) return { ok: false, error: 'botão Comprar não encontrado' };
    go.click();
    const after = await until(() => { const k = card(); const v = k && n(k.querySelector('.mk-tem') && k.querySelector('.mk-tem').getAttribute('data-tem')); return v != null && v !== before ? v : null; }, 6000);
    return { ok: after != null && after > (before || 0), before, after, bought: buy, gold, price, error: after == null ? 'a compra não confirmou (pode ter aparecido uma confirmação)' : null };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    if (opened) { await sleep(300); const x = document.querySelector('#modal-fechar'); if (x) x.click(); }
  }
})()`;

// Nota da captura sem depender do painel "Capturas" estar na tela: usa o módulo do próprio jogo
// (/shared/nota-pokemon.mjs) com as capturas do histórico (localStorage). A assinatura da função
// não é pública, então testa as exportadas e só aceita a que bate com a nota do painel.
// info=true devolve a lista de exports (com o começo do código) pro log.
const gameHistNota = (fnName, info) => `(async () => {
  let m;
  try { m = await import('/shared/nota-pokemon.mjs'); } catch (e) { return { error: 'import: ' + (e && e.message) }; }
  const out = { exports: [] };
  if (${info ? 'true' : 'false'}) {
    out.exports = Object.keys(m).map((k) => ({ k, t: typeof m[k], src: typeof m[k] === 'function' ? String(m[k]).slice(0, 1200) : (() => { try { return JSON.stringify(m[k]).slice(0, 200); } catch (e) { return String(m[k]).slice(0, 200); } })() }));
  }
  const hist = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!/^capturas-hist:/.test(key)) continue;
    try { const l = JSON.parse(localStorage.getItem(key) || '[]'); if (Array.isArray(l)) hist.push(...l.slice(0, 60)); } catch (e) {}
  }
  const num = (r) => typeof r === 'number' ? r : r && typeof r === 'object' ? [r.nota, r.valor, r.total, r.score].find((x) => typeof x === 'number') : undefined;
  const fns = Object.keys(m).filter((k) => typeof m[k] === 'function');
  const pick = ${JSON.stringify(fnName || '')};
  const tryFn = (k, c) => {
    const f = m[k];
    const alt = { ...c, especie: c.speciesId, especieId: c.speciesId, iv: c.ivs, qualidade: c.quality, nivel: c.level };
    for (const arg of [c, alt]) { try { const v = num(f(arg)); if (Number.isFinite(v)) return v; } catch (e) {} }
    return undefined;
  };
  out.rows = hist.filter((c) => c && c.em && c.id != null).map((c) => {
    const row = { k: c.em + ':' + c.id, t: Number(c.em), name: String(c.nome || ''), level: c.level, shiny: c.shiny === true,
      iv: c.ivs && typeof c.ivs === 'object' ? Object.values(c.ivs).reduce((a, b) => a + (Number(b) || 0), 0) : null, q: c.quality, pot: c.potencia, by: {} };
    for (const k of (pick ? [pick] : fns)) { if (!m[k]) continue; const v = tryFn(k, c); if (v !== undefined) row.by[k] = Math.round(v * 1000) / 1000; }
    return row;
  });
  return out;
})()`;

const gameBuyBall = (name, qty) => gameBuyItem('ball', name, qty);

module.exports = { gameCaptures, gameCaptureHist, gameHistNota, gameBuyBall, gameBuyItem, gameItems, kickCookies, lowestQualityFor, gameStats, probe: kickProbe, kickProbe, twitchProbe, twitchClaim, probeFor, lowestQuality, gameUser };
