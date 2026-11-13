// PokeIdle Farm: servidor de alertas (Cloudflare Worker).
//
// Guarda os segredos (token do bot e client secret) fora do app distribuído e faz três coisas:
//   GET  /login     → manda pro login do Discord (scopes identify + guilds.join)
//   GET  /callback  → coloca a pessoa no servidor, cria/reusa a thread privada dela em #alertas
//                     e devolve ao app um "crachá" assinado (só vale pra thread dessa pessoa)
//   POST /alert     → o app manda o alerta com o crachá e o bot posta na thread marcando a pessoa
//
// Não guarda token do Discord nem histórico de alertas. O KV só tem "id do usuário → id da thread".

const API = 'https://discord.com/api/v10';
const APP_REDIRECT = 'http://127.0.0.1:53682/discord'; // interceptado pelo Electron, nunca chega a um servidor
const MAX_IMAGE = 300 * 1024;
const RATE = { max: 20, windowMs: 10 * 60 * 1000 };
const hits = new Map(); // limite por usuário (por instância do Worker; o Discord também limita)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/login') return login(url, env);
      if (req.method === 'GET' && url.pathname === '/callback') return await callback(url, env);
      if (req.method === 'POST' && url.pathname === '/alert') return await alert(req, env);
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
      content: `<@${userId}> esta é a sua thread de alertas do PokeIdle Farm. Só você (e a moderação) vê o que chega aqui.`,
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
