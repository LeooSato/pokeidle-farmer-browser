// PokeIdle Farm: servidor de alertas (Cloudflare Worker).
//
// Guarda os segredos (token do bot e client secret) fora do app distribuído e faz três coisas:
//   GET  /login     → manda pro login do Discord (scopes identify + guilds.join)
//   GET  /callback  → coloca a pessoa no servidor, cria/reusa a thread privada dela em #alertas
//                     e devolve ao app um "crachá" assinado (só vale pra thread dessa pessoa)
//   POST /alert     → o app manda o alerta com o crachá e o bot posta na thread marcando a pessoa
//   POST /captures  → o app manda as capturas (sem imagem) pra montar o /resumo; ficam só 48 h
//   POST /interactions → comandos do Discord (/resumo), assinados pelo Discord (Ed25519)
//
// Não guarda token do Discord nem histórico de alertas. O KV só tem "id do usuário → id da thread";
// o D1 só tem as capturas das últimas 48 h (nome, nível, nota, IV, Q, P, shiny) e o último contato do app.

const API = 'https://discord.com/api/v10';
const APP_REDIRECT = 'http://127.0.0.1:53682/discord'; // interceptado pelo Electron, nunca chega a um servidor
const MAX_IMAGE = 300 * 1024;
const RATE = { max: 20, windowMs: 10 * 60 * 1000 };
const hits = new Map(); // limite por usuário (por instância do Worker; o Discord também limita)
const KEEP_MS = 48 * 3600 * 1000;
const capHits = new Map();

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/login') return login(url, env);
      if (req.method === 'GET' && url.pathname === '/callback') return await callback(url, env);
      if (req.method === 'POST' && url.pathname === '/alert') return await alert(req, env);
      if (req.method === 'POST' && url.pathname === '/captures') return await captures(req, env);
      if (req.method === 'POST' && url.pathname === '/interactions') return await interactions(req, env);
      if (req.method === 'GET' && url.pathname === '/') return text('PokeIdle Farm alerts: ok');
      return text('not found', 404);
    } catch (err) {
      console.log('erro', err && err.message);
      return json({ ok: false, error: 'erro interno' }, 500);
    }
  }
};

// ---------- login ----------
async function login(url, env) {
  const s = (url.searchParams.get('s') || '').slice(0, 64);
  if (!/^[a-f0-9]{16,64}$/.test(s)) return text('pedido inválido', 400);
  const state = await sign(env, { s, exp: Date.now() + 10 * 60 * 1000 });
  const q = new URLSearchParams({
    client_id: env.CLIENT_ID, response_type: 'code', scope: 'identify guilds.join',
    redirect_uri: `${url.origin}/callback`, state, prompt: 'consent'
  });
  return Response.redirect(`https://discord.com/oauth2/authorize?${q}`, 302);
}

async function callback(url, env) {
  const st = await verify(env, url.searchParams.get('state') || '');
  if (!st || st.exp < Date.now()) return text('Login expirado. Feche esta janela e tente de novo no app.', 400);
  const back = (params) => Response.redirect(`${APP_REDIRECT}#${new URLSearchParams({ ...params, s: st.s })}`, 302);
  if (url.searchParams.get('error')) return back({ error: url.searchParams.get('error') === 'access_denied' ? 'cancelado' : 'recusado' });
  const code = url.searchParams.get('code');
  if (!code) return back({ error: 'sem_codigo' });

  // troca o code pelo token do usuário (fica só na memória desta requisição)
  const tok = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: `${url.origin}/callback` })
  }).then((r) => (r.ok ? r.json() : null));
  if (!tok || !tok.access_token) return back({ error: 'token' });

  try {
    const me = await fetch(`${API}/users/@me`, { headers: { authorization: `Bearer ${tok.access_token}` } }).then((r) => (r.ok ? r.json() : null));
    if (!me || !/^\d{17,20}$/.test(String(me.id))) return back({ error: 'usuario' });
    const name = String(me.global_name || me.username || 'treinador').slice(0, 40);

    // coloca no servidor (201 = entrou agora, 204 = já era membro)
    const join = await bot(env, `/guilds/${env.GUILD_ID}/members/${me.id}`, { method: 'PUT', body: { access_token: tok.access_token } });
    if (![201, 204].includes(join.status)) { console.log('join', join.status, await join.text()); return back({ error: 'servidor' }); }

    const thread = await ensureThread(env, me.id, me.username || name);
    if (!thread) return back({ error: 'thread' });

    const session = await sign(env, { u: String(me.id), t: thread, n: name, iat: Date.now() });
    return back({ session, name, thread, guild: env.GUILD_ID });
  } finally {
    // o app não precisa do token do usuário: revoga na hora
    await fetch(`${API}/oauth2/token/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, token: tok.access_token, token_type_hint: 'access_token' })
    }).catch(() => {});
  }
}

// Reusa a thread da pessoa se ainda existir; senão cria uma privada nova e adiciona ela.
async function ensureThread(env, userId, username) {
  const saved = await env.THREADS.get(userId);
  if (saved) {
    const r = await bot(env, `/channels/${saved}`);
    if (r.ok) {
      const ch = await r.json();
      if (ch.thread_metadata && ch.thread_metadata.archived) await bot(env, `/channels/${saved}`, { method: 'PATCH', body: { archived: false } });
      await bot(env, `/channels/${saved}/thread-members/${userId}`, { method: 'PUT' });
      return saved;
    }
  }
  const safe = String(username).toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 60) || 'treinador';
  const channel = await alertChannel(env);
  if (!channel) { console.log('canal de alertas não encontrado'); return null; }
  const r = await bot(env, `/channels/${channel}/threads`, {
    method: 'POST',
    body: { name: `alertas-${safe}`, type: 12, invitable: false, auto_archive_duration: 10080 }
  });
  if (!r.ok) { console.log('thread', r.status, await r.text()); return null; }
  const th = await r.json();
  await bot(env, `/channels/${th.id}/thread-members/${userId}`, { method: 'PUT' });
  await env.THREADS.put(userId, th.id);
  await bot(env, `/channels/${th.id}/messages`, {
    method: 'POST',
    body: {
      content: `<@${userId}> esta é a sua thread de alertas do PokeIdle Farm. Só você (e a moderação) vê o que chega aqui. Digite \`/resumo\` em qualquer canal do servidor pra ver um resumo das suas capturas.`,
      allowed_mentions: { users: [userId] }
    }
  });
  return th.id;
}

// Canal onde ficam as threads: CHANNEL_ID, ou procura pelo nome (CHANNEL_NAME) e guarda no KV.
async function alertChannel(env) {
  if (/^\d{17,20}$/.test(env.CHANNEL_ID || '')) return env.CHANNEL_ID;
  const cached = await env.THREADS.get('__channel');
  if (cached) return cached;
  const r = await bot(env, `/guilds/${env.GUILD_ID}/channels`);
  if (!r.ok) return null;
  const want = String(env.CHANNEL_NAME || 'alertas').replace(/^#/, '').toLowerCase();
  const ch = (await r.json()).find((c) => c.type === 0 && String(c.name).toLowerCase() === want);
  if (!ch) return null;
  await env.THREADS.put('__channel', ch.id);
  return ch.id;
}

// ---------- alerta ----------
async function alert(req, env) {
  const auth = req.headers.get('authorization') || '';
  const ses = await verify(env, auth.replace(/^Bearer\s+/i, ''));
  if (!ses || !ses.u || !ses.t) return json({ ok: false, error: 'reconecte o Discord no app' }, 401);

  const now = Date.now();
  const list = (hits.get(ses.u) || []).filter((t) => now - t < RATE.windowMs);
  if (list.length >= RATE.max) return json({ ok: false, error: 'muitos alertas, espere uns minutos' }, 429);
  list.push(now); hits.set(ses.u, list);

  if (Number(req.headers.get('content-length') || 0) > MAX_IMAGE * 1.5 + 20000) return json({ ok: false, error: 'alerta grande demais' }, 413);
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'json inválido' }, 400); }

  const embed = cleanEmbed(body.embed || {});
  const payload = { content: body.mention === false ? undefined : `<@${ses.u}>`, embeds: [embed], allowed_mentions: { parse: [], users: body.mention === false ? [] : [ses.u] } };
  let png = null;
  if (typeof body.image === 'string' && body.image.startsWith('data:image/png;base64,')) {
    const bin = Uint8Array.from(atob(body.image.slice(22)), (c) => c.charCodeAt(0));
    if (bin.length <= MAX_IMAGE) { png = bin; embed.thumbnail = { url: 'attachment://pokemon.png' }; }
  }

  let r = await postMessage(env, ses.t, payload, png);
  if (r.status === 400) {
    const err = await r.clone().json().catch(() => ({}));
    if (err.code === 50083) { // thread arquivada: desarquiva e tenta de novo
      await bot(env, `/channels/${ses.t}`, { method: 'PATCH', body: { archived: false } });
      r = await postMessage(env, ses.t, payload, png);
    }
  }
  if (r.status === 404) return json({ ok: false, error: 'sua thread sumiu, clique em Conectar Discord de novo' }, 410);
  if (!r.ok) { console.log('alert', r.status, await r.text()); return json({ ok: false, error: `Discord respondeu ${r.status}` }, 502); }
  return json({ ok: true });
}

function postMessage(env, channel, payload, png) {
  if (!png) return bot(env, `/channels/${channel}/messages`, { method: 'POST', body: payload });
  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  form.append('files[0]', new Blob([png], { type: 'image/png' }), 'pokemon.png');
  return fetch(`${API}/channels/${channel}/messages`, { method: 'POST', headers: { authorization: `Bot ${env.BOT_TOKEN}` }, body: form });
}

function cleanEmbed(e) {
  const s = (v, n) => String(v == null ? '' : v).slice(0, n);
  const out = { title: s(e.title, 256), description: s(e.description, 2000), color: Number.isInteger(e.color) ? e.color : 0x53fc18, timestamp: new Date().toISOString(), footer: { text: 'PokeIdle Farm' } };
  if (Array.isArray(e.fields)) out.fields = e.fields.slice(0, 10).map((f) => ({ name: s(f.name, 256) || '-', value: s(f.value, 1024) || '-', inline: f.inline !== false }));
  return out;
}

// ---------- capturas (pro /resumo) ----------
let schemaReady = false;
async function schema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS captures (user TEXT NOT NULL, k TEXT NOT NULL, t INTEGER NOT NULL, name TEXT, level INTEGER, nota REAL, iv INTEGER, q REAL, pot INTEGER, shiny INTEGER DEFAULT 0, PRIMARY KEY (user, k))'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS captures_user_t ON captures(user, t)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS seen (user TEXT PRIMARY KEY, at INTEGER NOT NULL, ver TEXT)')
  ]);
  schemaReady = true;
}

async function captures(req, env) {
  const auth = req.headers.get('authorization') || '';
  const ses = await verify(env, auth.replace(/^Bearer\s+/i, ''));
  if (!ses || !ses.u) return json({ ok: false, error: 'reconecte o Discord no app' }, 401);
  const now = Date.now();
  const list = (capHits.get(ses.u) || []).filter((t) => now - t < RATE.windowMs);
  if (list.length >= 30) return json({ ok: false, error: 'devagar' }, 429);
  list.push(now); capHits.set(ses.u, list);
  if (Number(req.headers.get('content-length') || 0) > 64 * 1024) return json({ ok: false, error: 'grande demais' }, 413);
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'json inválido' }, 400); }

  const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
  const caps = (Array.isArray(body.caps) ? body.caps : []).slice(0, 100).map((c) => ({
    k: String(c.k || '').slice(0, 60),
    t: num(c.t, now - KEEP_MS, now + 5 * 60 * 1000),
    name: String(c.name || '').replace(/[\u0000-\u001f<>@`*_~|]/g, '').trim().slice(0, 30),
    level: num(c.level, 1, 1000), nota: num(c.nota, 0, 10), iv: num(c.iv, 0, 999), q: num(c.q, 0, 100),
    pot: num(String(c.pot ?? '').replace(/\D/g, ''), 0, 99), shiny: c.shiny === true ? 1 : 0
  })).filter((c) => /^[\w:.-]+$/.test(c.k) && c.t && c.name);

  await schema(env);
  const stmts = caps.map((c) => env.DB.prepare(
    `INSERT INTO captures (user, k, t, name, level, nota, iv, q, pot, shiny) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(user, k) DO UPDATE SET nota = COALESCE(excluded.nota, captures.nota), iv = COALESCE(excluded.iv, captures.iv),
       q = COALESCE(excluded.q, captures.q), pot = COALESCE(excluded.pot, captures.pot), shiny = MAX(excluded.shiny, captures.shiny)`
  ).bind(ses.u, c.k, Math.round(c.t), c.name, c.level, c.nota, c.iv, c.q, c.pot, c.shiny));
  stmts.push(env.DB.prepare('DELETE FROM captures WHERE user = ?1 AND t < ?2').bind(ses.u, now - KEEP_MS));
  stmts.push(env.DB.prepare('INSERT INTO seen (user, at, ver) VALUES (?1, ?2, ?3) ON CONFLICT(user) DO UPDATE SET at = excluded.at, ver = excluded.ver')
    .bind(ses.u, now, String(body.ver || '').slice(0, 20)));
  await env.DB.batch(stmts);
  return json({ ok: true, saved: caps.length });
}

// ---------- comandos do Discord ----------
let pubKey = null;
async function discordKey(env) {
  if (pubKey) return pubKey;
  let hex = /^[0-9a-f]{64}$/i.test(env.PUBLIC_KEY || '') ? env.PUBLIC_KEY : await env.THREADS.get('__pubkey');
  if (!hex) {
    const r = await bot(env, '/applications/@me');
    if (!r.ok) return null;
    hex = (await r.json()).verify_key;
    if (!/^[0-9a-f]{64}$/i.test(hex || '')) return null;
    await env.THREADS.put('__pubkey', hex);
  }
  const raw = Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
  pubKey = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  return pubKey;
}

async function interactions(req, env) {
  const sig = req.headers.get('x-signature-ed25519') || '';
  const ts = req.headers.get('x-signature-timestamp') || '';
  const raw = await req.text();
  const key = await discordKey(env);
  let ok = false;
  if (key && /^[0-9a-f]{128}$/i.test(sig) && ts) {
    const sigBytes = Uint8Array.from(sig.match(/../g), (h) => parseInt(h, 16));
    ok = await crypto.subtle.verify('Ed25519', key, sigBytes, new TextEncoder().encode(ts + raw)).catch(() => false);
  }
  if (!ok) return text('assinatura inválida', 401);
  const it = JSON.parse(raw);
  if (it.type === 1) return json({ type: 1 });
  if (it.type === 2 && it.data && it.data.name === 'resumo') {
    const user = String((it.member && it.member.user && it.member.user.id) || (it.user && it.user.id) || '');
    const opt = (it.data.options || []).find((o) => o.name === 'horas');
    const hours = Math.min(48, Math.max(1, Math.round(Number(opt && opt.value) || 6)));
    const embed = await summary(env, user, hours);
    return json({ type: 4, data: { flags: 64, embeds: [embed], allowed_mentions: { parse: [] } } });
  }
  return json({ type: 4, data: { flags: 64, content: 'Comando desconhecido.' } });
}

async function summary(env, user, hours) {
  await schema(env);
  const now = Date.now();
  const since = now - hours * 3600 * 1000;
  const { results: rows } = await env.DB.prepare('SELECT name, level, nota, iv, q, pot, shiny, t FROM captures WHERE user = ?1 AND t >= ?2 ORDER BY t').bind(user, since).all();
  const last = await env.DB.prepare('SELECT MAX(t) AS t FROM captures WHERE user = ?1').bind(user).first();
  const seen = await env.DB.prepare('SELECT at, ver FROM seen WHERE user = ?1').bind(user).first();
  const sec = (ms) => Math.floor(ms / 1000);
  const n = (v, d = 2) => (v == null ? '?' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: d }));
  const embed = { title: `Resumo das últimas ${hours} h`, color: 0x53fc18, footer: { text: 'PokeIdle Farm' }, timestamp: new Date().toISOString() };

  if (!seen) {
    embed.color = 0xf5a524;
    embed.description = 'Ainda não recebi nenhuma captura sua. Atualize o PokeIdle Farm (v1.0.11 ou mais nova) e clique em **Conectar Discord** na tela Alertas.';
    return embed;
  }
  const lines = [];
  const online = now - seen.at < 15 * 60 * 1000;
  lines.push(online ? `🟢 App ligado (último contato <t:${sec(seen.at)}:R>)` : `🔴 App sem contato desde <t:${sec(seen.at)}:f> (<t:${sec(seen.at)}:R>)`);
  if (last && last.t) {
    const idle = now - last.t;
    lines.push(`Última captura <t:${sec(last.t)}:R>`);
    if (online && idle > 45 * 60 * 1000) lines.push(`⚠️ Nada capturado há ${Math.round(idle / 60000)} min com o app ligado. O farm pode ter travado (Ctrl+R no jogo costuma resolver).`);
  }
  if (!rows.length) {
    lines.push('', `Nenhuma captura nas últimas ${hours} h.`);
    embed.description = lines.join('\n');
    embed.color = 0xf5a524;
    return embed;
  }
  embed.description = [`**${rows.length}** captura${rows.length > 1 ? 's' : ''} desde <t:${sec(since)}:t>`, ...lines].join('\n');

  const bySpecies = new Map();
  for (const r of rows) bySpecies.set(r.name, (bySpecies.get(r.name) || 0) + 1);
  const species = [...bySpecies].sort((a, b) => b[1] - a[1]);
  const fields = [{ name: 'Espécies', value: species.slice(0, 15).map(([s, c]) => `${s} ×${c}`).join('\n') + (species.length > 15 ? `\n…e mais ${species.length - 15}` : ''), inline: true }];

  const best = [...rows].sort((a, b) => (b.nota ?? -1) - (a.nota ?? -1) || (b.iv ?? 0) - (a.iv ?? 0)).slice(0, 3);
  fields.push({
    name: 'Melhores',
    value: best.map((r, i) => `${['🥇', '🥈', '🥉'][i]} ${r.shiny ? '✨ ' : ''}${r.name} Nv ${r.level ?? '?'}: nota **${n(r.nota, 2)}** · IV ${r.iv ?? '?'} · Q ${n(r.q, 3)} · P${r.pot ?? '?'} (<t:${sec(r.t)}:t>)`).join('\n'),
    inline: false
  });
  const shinies = rows.filter((r) => r.shiny);
  fields.push({ name: 'Shiny', value: shinies.length ? shinies.slice(0, 10).map((r) => `✨ ${r.name} Nv ${r.level ?? '?'} às <t:${sec(r.t)}:t>`).join('\n') : 'Nenhum', inline: true });
  const notas = rows.filter((r) => r.nota != null).map((r) => r.nota);
  if (notas.length) fields.push({ name: 'Nota média', value: n(notas.reduce((a, b) => a + b, 0) / notas.length, 2), inline: true });
  embed.fields = fields;
  if (shinies.length) embed.color = 0xffd166;
  return embed;
}

// ---------- utilidades ----------
function bot(env, path, { method = 'GET', body } = {}) {
  return fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bot ${env.BOT_TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
}
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function hmacKey(env) {
  // SESSION_KEY é opcional: sem ele, a chave é derivada dos dois segredos do Discord
  // (trocar o token do bot invalida os crachás e todo mundo só precisa reconectar).
  const raw = env.SESSION_KEY || `pokeidle-farm-session|${env.BOT_TOKEN}|${env.CLIENT_SECRET}`;
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function sign(env, obj) {
  const data = b64u(new TextEncoder().encode(JSON.stringify(obj)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(data));
  return `${data}.${b64u(sig)}`;
}
async function verify(env, token) {
  const [data, sig] = String(token).split('.');
  if (!data || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), unb64u(sig), new TextEncoder().encode(data));
    return ok ? JSON.parse(new TextDecoder().decode(unb64u(data))) : null;
  } catch { return null; }
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const text = (t, status = 200) => new Response(t, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
