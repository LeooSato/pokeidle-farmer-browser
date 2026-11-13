// Lives configuráveis (Kick e Twitch): normalização, URLs e verificação de canal.

const PLATFORMS = {
  kick: { name: 'Kick', host: 'kick.com', url: (ch) => `https://kick.com/${ch}` },
  twitch: { name: 'Twitch', host: 'twitch.tv', url: (ch) => `https://www.twitch.tv/${ch}` }
};

const cleanChannel = (s) => String(s || '').trim().replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_]/g, '');

// id estável do painel. Kick usa só o canal pra manter som/zoom já salvos das lives antigas.
const streamId = (s) => (s.platform === 'kick' ? s.channel : `${s.platform}-${s.channel}`);

function normalize(s) {
  const platform = PLATFORMS[s.platform] ? s.platform : 'kick';
  const channel = cleanChannel(s.channel || s.id);
  if (!channel) return null;
  return { platform, channel, title: s.title || channel, id: streamId({ platform, channel }) };
}

function normalizeList(list) {
  const seen = new Set();
  return (list || []).map(normalize).filter((s) => s && !seen.has(s.id) && seen.add(s.id));
}

// Aceita "axt", "@axt", "kick.com/axt", "https://www.twitch.tv/gaules"...
function parseInput(text, fallbackPlatform = 'kick') {
  const t = String(text || '').trim();
  const m = t.match(/(?:https?:\/\/)?(?:www\.|m\.)?(kick\.com|twitch\.tv)\/(?:popout\/)?@?([A-Za-z0-9_]+)/i);
  if (m) return { platform: m[1].toLowerCase().startsWith('kick') ? 'kick' : 'twitch', channel: cleanChannel(m[2]) };
  return { platform: fallbackPlatform, channel: cleanChannel(t) };
}

// Verifica se o canal existe e se está ao vivo. Melhor esforço: se a API não responder,
// devolve { exists: null } e a tela deixa adicionar mesmo assim.
async function verify(ses, platform, channel) {
  try {
    if (platform === 'kick') {
      const res = await ses.fetch(`https://kick.com/api/v2/channels/${channel}`, { headers: { Accept: 'application/json' } });
      if (res.status === 404) return { exists: false };
      if (!res.ok) return { exists: null };
      const j = await res.json();
      return {
        exists: true,
        live: !!j.livestream,
        name: (j.user && j.user.username) || channel,
        title: j.livestream ? j.livestream.session_title : null
      };
    }
    if (platform === 'twitch') {
      const res = await ses.fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        // Client-Id público do próprio site da Twitch (o mesmo que qualquer navegador usa). Não é segredo.
        headers: { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: `query { user(login: "${channel}") { displayName stream { id title } } }` })
      });
      if (!res.ok) return { exists: null };
      const j = await res.json();
      const u = j && j.data && j.data.user;
      if (!u) return { exists: false };
      return { exists: true, live: !!u.stream, name: u.displayName || channel, title: u.stream ? u.stream.title : null };
    }
  } catch { /* sem rede / bloqueado */ }
  return { exists: null };
}

module.exports = { PLATFORMS, normalize, normalizeList, parseInput, verify, streamId };
