// Tela "Gerenciar lives": escolher plataforma, adicionar canal, reordenar e remover.
// As mudanças só valem ao clicar em "Salvar"; até lá nada muda nos painéis.
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const PF = {
    kick: { name: 'Kick', letter: 'K', host: 'kick.com' },
    twitch: { name: 'Twitch', letter: 'T', host: 'twitch.tv' }
  };
  const idOf = (s) => (s.platform === 'kick' ? s.channel : `${s.platform}-${s.channel}`);
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let draft = [];
  let platform = 'kick';
  let opts = {};
  let dragIndex = null;
  const info = {}; // id -> resultado da verificação (live/offline)

  const modal = $('#manager');
  const input = $('#mgr-input');
  const addBtn = $('#mgr-add');
  const msg = $('#mgr-msg');

  function setPlatform(pf) {
    platform = pf;
    modal.querySelectorAll('.pf-card').forEach((b) => b.classList.toggle('on', b.dataset.pf === pf));
    modal.dataset.pf = pf;
    input.placeholder = pf === 'kick' ? 'nome do canal ou link (ex.: axt, kick.com/axt)' : 'nome do canal ou link (ex.: gaules, twitch.tv/gaules)';
  }

  function say(text, kind = '') {
    msg.className = 'mgr-msg ' + kind;
    msg.innerHTML = text;
  }

  function renderList() {
    const ul = $('#mgr-list');
    ul.innerHTML = '';
    $('#mgr-count').textContent = draft.length;
    $('#mgr-heavy').hidden = draft.length < 5;
    if (!draft.length) {
      ul.innerHTML = '<li class="mgr-empty">Nenhuma live. Adicione uma acima.</li>';
      return;
    }
    draft.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = `mgr-item ${s.platform}`;
      li.draggable = true;
      const st = info[idOf(s)];
      const badge = st && st.exists ? (st.live ? '<em class="st live">ao vivo</em>' : '<em class="st">offline</em>') : '';
      li.innerHTML = `
        <span class="grip" title="Arraste pra mudar a ordem"><svg viewBox="0 0 16 16"><path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01"/></svg></span>
        <span class="pf-badge">${PF[s.platform].letter}</span>
        <span class="name"><b>${esc(s.title || s.channel)}</b><small>${PF[s.platform].host}/${esc(s.channel)}</small></span>
        ${badge}
        <span class="spacer"></span>
        <button data-move="-1" title="Subir" ${i === 0 ? 'disabled' : ''}><svg viewBox="0 0 16 16"><path d="M4 10l4-4 4 4"/></svg></button>
        <button data-move="1" title="Descer" ${i === draft.length - 1 ? 'disabled' : ''}><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg></button>
        <button data-remove title="Remover" class="rm"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>`;
      li.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => move(i, i + Number(b.dataset.move))));
      $('[data-remove]', li).addEventListener('click', () => { draft.splice(i, 1); renderList(); });
      li.addEventListener('dragstart', (e) => { dragIndex = i; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      li.addEventListener('dragend', () => { dragIndex = null; li.classList.remove('dragging'); });
      li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('over'); });
      li.addEventListener('dragleave', () => li.classList.remove('over'));
      li.addEventListener('drop', (e) => { e.preventDefault(); li.classList.remove('over'); if (dragIndex !== null) move(dragIndex, i); });
      ul.append(li);
    });
  }

  function move(from, to) {
    if (to < 0 || to >= draft.length || from === to) return;
    const [it] = draft.splice(from, 1);
    draft.splice(to, 0, it);
    renderList();
  }

  // Se colar um link, troca a plataforma sozinho.
  let parseTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(parseTimer);
    say('');
    parseTimer = setTimeout(async () => {
      const r = await window.farm.parseStream(input.value, platform);
      if (r.platform !== platform) setPlatform(r.platform);
    }, 150);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

  async function add() {
    const { platform: pf, channel } = await window.farm.parseStream(input.value, platform);
    if (!channel) { say('Digite o nome do canal.', 'warn'); return; }
    const s = { platform: pf, channel, title: channel };
    const id = idOf(s);
    if (draft.some((x) => idOf(x) === id)) { say(`<b>${esc(channel)}</b> já está na lista.`, 'warn'); return; }
    addBtn.disabled = true;
    say(`<i class="spin"></i>Verificando ${PF[pf].name}/${esc(channel)}…`);
    const r = await window.farm.verifyStream(pf, channel);
    addBtn.disabled = false;
    if (r.exists === false) { say(`Não achei o canal <b>${esc(channel)}</b> na ${PF[pf].name}.`, 'err'); return; }
    if (r.name) s.title = r.name;
    info[id] = r;
    draft.push(s);
    input.value = '';
    renderList();
    if (r.exists) say(`<b>${esc(s.title)}</b> adicionado · ${r.live ? '<em class="st live">ao vivo agora</em>' : 'offline agora'}${r.title ? ` · <span class="dim">${esc(r.title)}</span>` : ''}`, 'ok');
    else say(`<b>${esc(channel)}</b> adicionado. Não consegui confirmar se o canal existe, mas vai abrir mesmo assim.`, 'warn');
    input.focus();
  }

  async function save() {
    $('#mgr-save').disabled = true;
    await window.farm.setStreams(draft);
    $('#mgr-save').disabled = false;
    close();
  }

  function close() {
    modal.hidden = true;
    document.removeEventListener('keydown', onKey);
    if (opts.onClose) opts.onClose();
  }
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  modal.querySelectorAll('.pf-card').forEach((b) => b.addEventListener('click', () => { setPlatform(b.dataset.pf); input.focus(); }));
  addBtn.addEventListener('click', add);
  $('#mgr-save').addEventListener('click', save);
  $('#mgr-cancel').addEventListener('click', close);
  $('#mgr-close').addEventListener('click', close);
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
  $('#mgr-reset').addEventListener('click', () => {
    draft = (window.__defaultStreams || []).map((s) => ({ ...s }));
    say('Lista padrão restaurada. Clique em Salvar pra aplicar.', 'ok');
    renderList();
  });
  $('#mgr-claim').addEventListener('change', (e) => {
    window.__twitchAutoClaim = e.target.checked;
    window.farm.setTwitchAutoClaim(e.target.checked);
  });

  // ---------- Alertas no celular (Discord) ----------
  const phSay = (html, kind) => { const m = $('#ph-msg'); m.className = 'mgr-msg' + (kind ? ' ' + kind : ''); m.innerHTML = html; };
  async function phRefresh() {
    const d = await window.farm.discordGet();
    $('#ph-url').value = '';
    $('#ph-url').placeholder = d.set ? `Configurado (${d.label}). Cole outro link pra trocar.` : 'https://discord.com/api/webhooks/…';
    $('#ph-items').checked = d.items;
    $('#ph-uid').value = d.userId;
    $('#ph-who').textContent = d.userName ? `conectado como ${d.userName}` : 'conecte o Discord ou cole o ID';
    $('#ph-min').value = d.minScore;
    $('#ph-save').textContent = d.set ? 'Trocar' : 'Salvar';
    window.__phSet = d.set;
    const sv = $('#ph-server'), adv = $('#ph-adv');
    sv.hidden = !d.server;
    adv.classList.toggle('solo', !d.server);
    if (!d.server) adv.open = true;
    $('#ph-connect').hidden = d.server;
    if (d.server) {
      sv.classList.toggle('on', d.connected);
      $('#ph-sv-text').innerHTML = d.connected ? `Conectado como <b>${esc(d.userName || 'você')}</b>. Os alertas chegam na sua thread privada.` : 'Não conectado. Clique em Conectar Discord pra receber os alertas.';
      $('#ph-sv-connect').textContent = d.connected ? 'Reconectar' : 'Conectar Discord';
      ['#ph-sv-open', '#ph-sv-test', '#ph-sv-out'].forEach((id) => { $(id).hidden = !d.connected; });
      $('#ph-sv-open').hidden = !d.connected || !d.thread;
      phSay('');
    } else {
      phSay(d.set ? '<span class="dim">Ativo. Deixe o campo vazio e clique em Remover pra desligar.</span>' : '');
    }
  }
  async function phConnect() {
    phSay('Faça login na janela do Discord e clique em Autorizar…');
    const r = await window.farm.discordConnect();
    if (!r || !r.ok) return phSay(esc((r && r.error) || 'Falhou.'), 'err');
    await phRefresh();
    phSay(r.thread ? `Pronto, <b>${esc(r.name)}</b>! Sua thread privada de alertas foi criada.` : `Pronto! Vou marcar <b>${esc(r.name)}</b> nos alertas.`, 'ok');
  }
  $('#ph-sv-connect').addEventListener('click', phConnect);
  $('#ph-sv-open').addEventListener('click', () => window.farm.discordOpenThread());
  $('#ph-sv-out').addEventListener('click', async () => { await window.farm.discordDisconnect(); await phRefresh(); phSay('Desconectado. Os alertas não vão mais pro Discord.', 'ok'); });
  $('#ph-sv-test').addEventListener('click', async () => {
    phSay('Enviando teste…');
    const r = await window.farm.discordTest('');
    phSay(r && r.ok ? 'Teste enviado. Olhe a sua thread no Discord.' : esc((r && r.error) || 'Falhou.'), r && r.ok ? 'ok' : 'err');
    if (r && !r.ok) phRefresh();
  });
  $('#ph-save').addEventListener('click', async () => {
    const url = $('#ph-url').value.trim();
    if (!url && !window.__phSet) { $('#ph-url').focus(); return; }
    const r = await window.farm.discordSet(url);
    if (!r.ok) return phSay(esc(r.error), 'err');
    await phRefresh();
    phSay(url ? 'Webhook salvo. Clique em Testar pra ver chegar no celular.' : 'Alertas no celular desligados.', 'ok');
  });
  $('#ph-test').addEventListener('click', async () => {
    phSay('Enviando teste…');
    const r = await window.farm.discordTest($('#ph-url').value.trim());
    phSay(r && r.ok ? 'Teste enviado. Olhe o Discord no celular.' : esc((r && r.error) || 'Falhou.'), r && r.ok ? 'ok' : 'err');
  });
  $('#ph-url').addEventListener('input', () => { if (window.__phSet) $('#ph-save').textContent = $('#ph-url').value.trim() ? 'Trocar' : 'Remover'; });
  async function phPrefs() {
    const r = await window.farm.discordPrefs({ userId: $('#ph-uid').value.trim(), minScore: $('#ph-min').value });
    if (!r.ok) phSay(esc(r.error), 'err'); else phSay('Preferências salvas.', 'ok');
  }
  $('#ph-uid').addEventListener('change', phPrefs);
  $('#ph-connect').addEventListener('click', phConnect);
  $('#ph-min').addEventListener('change', phPrefs);
  $('#ph-items').addEventListener('change', (e) => window.farm.discordItems(e.target.checked));

  // ---------- Perfis ----------
  async function renderProfiles() {
    const { profiles, active } = await window.farm.getProfiles();
    const box = $('#mgr-profiles');
    box.innerHTML = profiles.length ? '' : '<span class="none">Nenhum perfil ainda. Monte a lista abaixo e salve com um nome.</span>';
    profiles.forEach((pr) => {
      const chip = document.createElement('span');
      chip.className = 'chip-p' + (pr.name === active ? ' on' : '');
      chip.innerHTML = `<button class="go" title="Trocar pra este perfil">${esc(pr.name)}<small>${pr.streams.length} live(s)</small></button><button class="del" title="Apagar perfil"><svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg></button>`;
      $('.go', chip).addEventListener('click', async () => { await window.farm.applyProfile(pr.name); close(); });
      $('.del', chip).addEventListener('click', async () => { await window.farm.deleteProfile(pr.name); renderProfiles(); });
      box.append(chip);
    });
  }
  async function saveProfile() {
    const name = $('#mgr-profile-name').value.trim();
    if (!name) { $('#mgr-profile-name').focus(); return; }
    if (!draft.length) { say('Adicione pelo menos uma live antes de salvar o perfil.', 'warn'); return; }
    await window.farm.saveProfile(name, draft);
    await window.farm.setStreams(draft);
    $('#mgr-profile-name').value = '';
    say(`Perfil <b>${esc(name)}</b> salvo e aplicado.`, 'ok');
    renderProfiles();
  }
  $('#mgr-profile-save').addEventListener('click', saveProfile);
  $('#mgr-profile-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveProfile(); });

  window.openStreamManager = (o) => {
    opts = o;
    draft = (o.streams || []).map((s) => ({ platform: s.platform, channel: s.channel, title: s.title }));
    $('#mgr-claim').checked = !!o.twitchAutoClaim;
    setPlatform('kick');
    input.value = '';
    say('');
    renderList();
    renderProfiles();
    phRefresh();
    modal.hidden = false;
    document.addEventListener('keydown', onKey);
    if (o.onOpen) o.onOpen();
    if (o.section === 'phone') setTimeout(() => { const sec = $('.mgr-phone'); sec.scrollIntoView({ block: 'start', behavior: 'smooth' }); sec.classList.add('flash'); setTimeout(() => sec.classList.remove('flash'), 1400); }, 80);
    else setTimeout(() => input.focus(), 50);
  };
})();
