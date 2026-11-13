// Primeiro acesso: login nas 3 contas e depois reinicia o app.
(() => {
  const $ = (s) => document.querySelector(s);
  const finish = (skipped) => {
    window.farm.setupDone(skipped);
    $('#finish-title').textContent = skipped ? 'Beleza, sem login por enquanto' : 'Tudo pronto!';
    $('#finish-text').textContent = skipped
      ? 'Reinicie o app pra começar. Quando quiser entrar nas contas, use o botão Login no topo.'
      : 'Agora reinicie o app pra ele abrir com as suas contas e as lives padrão.';
    $('#finish').hidden = false;
    $('#relaunch').focus();
  };
  $('#skip').addEventListener('click', () => finish(true));
  $('#done').addEventListener('click', () => finish(false));
  $('#relaunch').addEventListener('click', () => { $('#relaunch').disabled = true; $('#relaunch').textContent = 'Reiniciando…'; window.farm.setupRelaunch(); });
})();
