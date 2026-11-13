// Lista do que mudou em cada versão (mais nova primeiro). Aparece na tela "Novidades".
window.CHANGELOG = [
  {
    version: '1.0.3',
    date: '13/11/2026',
    items: [
      'Mais leve: live offline "dorme" (a página é descarregada) e o app checa a cada 2 min se o streamer entrou; quando entra, a live abre sozinha.',
      'Chat das lives escondido: a página continua contando como espectador, mas não desenha as mensagens.',
      'Twitch também na menor qualidade, como a Kick.',
      'Com o app minimizado ou na bandeja, as lives param de ser desenhadas (vídeo e som continuam).',
      'Dá pra desligar o modo dormir e o chat escondido no menu da bandeja.'
    ]
  },
  {
    version: '1.0.2',
    date: '13/11/2026',
    items: [
      'Primeiro acesso: botão "abrir em janela" em cada coluna, pra quando o login (ex.: Kick) não funcionar dentro da tela dividida.',
      'Boas-vindas sem o botão de login, já que o login acontece no primeiro acesso.',
      'Aviso de cookies da Kick é aceito sozinho (às vezes ele ficava inclicável).'
    ]
  },
  {
    version: '1.0.1',
    date: '13/11/2026',
    items: [
      'Primeiro acesso: PokeIdle, Twitch e Kick lado a lado pra fazer login (ou pular), e depois uma tela de boas-vindas explicando o app.',
      'Aviso de "Novidades" depois de cada atualização, com a lista do que mudou.',
      'Clique no nome PokeIdle Farm, no canto superior esquerdo, pra rever as novidades e a ajuda quando quiser.',
      'Procura atualização a cada 30 minutos (antes era a cada 4 horas).',
      'Assinatura dev sato_ no rodapé.'
    ]
  },
  {
    version: '1.0.0',
    date: '13/11/2026',
    items: [
      'PokeIdle à esquerda e lives da Kick e da Twitch à direita, sem nada ser suspenso em segundo plano.',
      'Gerenciar lives: escolha a plataforma, os canais, a ordem e salve perfis.',
      'Live offline espera em silêncio e abre sozinha quando o streamer entra, com notificação.',
      'Stats de XP e ouro por hora, relatório diário e aviso quando o XP para.',
      'Modo foco, modo economia, áudio inteligente, atalhos e print do jogo (Ctrl+S).',
      'Atualização automática pelo GitHub.'
    ]
  }
];
