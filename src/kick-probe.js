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
  const xpTxt = byId(/xp|exp/i);
  const xpRe = /^([\\d.,]+)\\s*\\/\\s*([\\d.,]+)\\s*xp$/i;
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

module.exports = { gameCaptures, gameCaptureHist, gameItems, kickCookies, lowestQualityFor, gameStats, probe: kickProbe, kickProbe, twitchProbe, twitchClaim, probeFor, lowestQuality, gameUser };
