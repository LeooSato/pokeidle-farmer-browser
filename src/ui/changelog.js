// Lista do que mudou em cada versão (mais nova primeiro). Aparece na tela "Novidades".
window.CHANGELOG = [
  {
    version: '1.0.10',
    date: '13/11/2026',
    items: [
      'Alertas no Discord com thread privada: em Alertas, clique em Conectar Discord. Você entra no servidor do PokeIdle Farm e ganha uma thread só sua em #pokeidle, onde chegam os avisos te marcando.',
      'Corrigido: alarme falso de "Shiny" e aviso de capturas antigas que reapareciam na lista ordenada por nota.',
      'O webhook próprio continua disponível em "Usar meu próprio webhook (avançado)".'
    ]
  },
  {
    version: '1.0.9',
    date: '13/11/2026',
    items: ['A versão do app agora aparece na barra superior, do lado do nome. Clique nela pra ver as novidades.', 'Botão Alertas na barra superior: abre direto a configuração do Discord (webhook, Conectar Discord e nota mínima).']
  },
  {
    version: '1.0.8',
    date: '13/11/2026',
    items: [
      'Botão "Conectar Discord" em Lives › Alertas no celular: faça login e autorize, e o app já pega seu ID pra te marcar nos alertas. Sem modo desenvolvedor e sem guardar senha ou token.'
    ]
  },
  {
    version: '1.0.7',
    date: '13/11/2026',
    items: [
      'Aviso de pokémon bom: quando você captura um com nota igual ou acima da mínima (padrão 3) ou shiny, chega no PC e no Discord com sprite, nota, IV, qualidade, potência e nível.',
      'Marcar você no Discord: use @everyone (num servidor só seu) ou seu ID do Discord em Lives › Alertas no celular.',
      'Nota mínima configurável na mesma tela.'
    ]
  },
  {
    version: '1.0.6',
    date: '13/11/2026',
    items: [
      'Alertas no celular pelo Discord: cole o link de um webhook em Lives › Alertas no celular e clique em Testar.',
      'Avisos de pokébolas e potions acabando também chegam no celular (dá pra desligar).'
    ]
  },
  {
    version: '1.0.5',
    date: '13/11/2026',
    items: [
      'Potions no rodapé: mostra a potion que você mais tem (passe o mouse pra ver todas).',
      'Aviso quando uma potion que você tinha fica abaixo de 100 ou zera, e quando todas do uso automático acabam.'
    ]
  },
  {
    version: '1.0.4',
    date: '13/11/2026',
    items: [
      'Pokébolas no rodapé: mostra quantas você tem da bola em uso (passe o mouse pra ver todas).',
      'Aviso quando um tipo de pokébola fica abaixo de 100, zera ou quando todas somem da tela de captura.'
    ]
  },
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
