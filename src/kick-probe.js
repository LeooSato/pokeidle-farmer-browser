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

// Kick: offline quando aparece "Última vez ao vivo há ..." (ou "Last live ..." em inglês).
const kickProbe = `(() => {
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

module.exports = { lowestQualityFor, gameStats, probe: kickProbe, kickProbe, twitchProbe, twitchClaim, probeFor, lowestQuality, gameUser };
