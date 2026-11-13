# PokeIdle Farm

Navegador dividido feito pra farmar: o **PokeIdle** à esquerda e lives da **Kick** e da **Twitch** empilhadas à direita.
Nada é suspenso em segundo plano, então dá pra minimizar e continuar farmando.

## Instalação

1. Abra a página de [**Releases**](https://github.com/LeooSato/pokeidle-farmer-browser/releases/latest) e baixe um dos arquivos:
   - **`PokeIdle-Farm-Setup-x.y.z.exe`** (recomendado): instala, cria atalho na Área de Trabalho e no Menu Iniciar e **se atualiza sozinho**.
   - **`PokeIdle-Farm-Portatil-x.y.z.exe`**: roda sem instalar (dá pra levar num pendrive), mas **não se atualiza**; pra uma versão nova, baixe de novo.
2. O navegador ou o Windows pode avisar que o arquivo "não é seguro" ou "não é comumente baixado". Isso acontece porque o
   executável ainda não tem assinatura digital paga, não porque tem vírus (o código está todo aqui no repositório):
   - **Edge:** passe o mouse no download → **⋯** → **Manter** → **Mostrar mais** → **Manter mesmo assim**.
   - **Chrome:** na lista de downloads, **Manter** / **Baixar arquivo suspeito**.
   - **"O Windows protegeu o computador"** (SmartScreen): **Mais informações** → **Executar assim mesmo**.
3. Rode o instalador, escolha a pasta (ou deixe a padrão) e conclua.

### Primeira abertura

1. Abre a tela de **primeiro acesso** com o PokeIdle, a Twitch e a Kick lado a lado. Entre nas contas que quiser.
   Se alguma coluna não deixar logar, clique em **abrir em janela** no topo dela. Também dá pra pular com **Prefiro não logar**.
2. Clique em **Reiniciar o PokeIdle Farm**. O app abre com as lives padrão e uma tela de boas-vindas explicando o básico.
3. Pra trocar as lives, use o botão **Lives**. Pra logar depois ou trocar de conta, use o botão **Login**.

O login, os cookies, as configurações e as estatísticas ficam só no seu computador, em `%APPDATA%\PokeIdle Farm`.

### Atualizações

A versão instalada procura atualização ao abrir e a cada 30 minutos. Quando acha, baixa em segundo plano (só o que mudou)
e acende o botão **Reiniciar** no topo; ao clicar, o app volta já na versão nova e mostra o que mudou. Dá pra rever as
novidades a qualquer hora clicando no nome **PokeIdle Farm** no canto superior esquerdo.

### Desinstalar

**Configurações do Windows → Aplicativos → PokeIdle Farm → Desinstalar.** Pra apagar também o login e as
estatísticas, apague a pasta `%APPDATA%\PokeIdle Farm`.

## Rodar pelo código (desenvolvedores)

1. Instale o **Node.js LTS**: https://nodejs.org
2. Clone o repositório e rode:
   ```
   npm install
   npm start
   ```
   Mudanças em `src/ui/*` e `src/kick-probe.js` aplicam sem reiniciar; o resto acende o botão **Reiniciar**.
3. `npm run dist` gera o instalador e o portátil em `dist/`.

### Publicar uma versão nova

1. Suba o `version` no `package.json` e adicione o que mudou em `src/ui/changelog.js`.
2. Faça push na `main` e rode **Actions → Release → Run workflow** (ou crie a tag `vX.Y.Z`).
   O workflow gera os executáveis e publica no Releases; quem tem a versão instalada recebe sozinho.

## O que mantém tudo acordado

| Camada | O que faz |
| --- | --- |
| `backgroundThrottling: false` | Cada painel continua rodando timers e animações mesmo sem foco. |
| Flags do Chromium | `disable-renderer-backgrounding`, `disable-background-timer-throttling`, `disable-backgrounding-occluded-windows`, sem `CalculateNativeWinOcclusion` e `IntensiveWakeUpThrottling`. Funciona minimizado, escondido na bandeja ou atrás de outra janela. |
| `powerSaveBlocker` | O Windows não suspende o app. |
| Autoplay liberado | As lives começam sozinhas, sem clique. |
| Watchdog | A cada 60s verifica cada live e dá play se estiver pausada. Live offline não é recarregada: a página da Kick abre a live sozinha quando o streamer entra. Só recarrega se a página crashar, ficar 90s sem responder ou der erro de rede. |

## Gerenciar lives (Kick e Twitch)

O botão **Lives** na barra de cima abre a tela de gerenciar: escolha **Kick** ou **Twitch**, digite o canal
(ou cole o link, que a plataforma é detectada sozinha) e clique em **Adicionar**. O app confere se o canal existe
e se está ao vivo. Dá pra arrastar pra mudar a ordem e remover no X. Nada muda até clicar em **Salvar**, e aí os
painéis se ajustam na hora, sem reiniciar.

As lives do `config.json` são a lista padrão; depois de salvar pela tela, a lista fica guardada no app.
**Restaurar padrão** volta pra lista do `config.json`.

Na Twitch o app aceita sozinho o aviso de conteúdo adulto, e a tela de login ganha uma janela da Twitch.
Tem também a opção (desligada) de resgatar o baú de pontos sozinho.

## Extras

- **Aviso de live:** quando um streamer que estava offline entra ao vivo, aparece uma notificação do Windows e um aviso no topo do app, e o painel abre sozinho. Dá pra desligar no menu da bandeja.
- **Stats do PokeIdle:** o rodapé mostra XP/h e ouro/h (média da última hora) e um mini gráfico do XP por minuto. Passe o mouse pra ver nível, XP e ouro ganhos na sessão. Os números são lidos da tela do jogo; os ids `tr-*` encontrados ficam registrados no `farm.log`.
- **Modo foco** (botão Foco ou **Ctrl+Shift+F**): só o jogo na tela; as lives continuam rodando escondidas.
- **Modo economia:** as lives viram barrinhas (não desenham na tela), a coluna da direita encolhe e o player vai pra menor qualidade. Continuam contando.
- **Aviso de inatividade:** se o XP ficar parado por 10 min, aparece notificação (Pokémon desmaiou, poção acabou, jogo travou).
- **Relatório diário:** depois de 5 min farmando no dia aparece o botão amarelo "Relatório diário disponível" no rodapé, com XP, ouro, tempo farmando, tempo ao vivo de cada live e os últimos 7 dias.
- **Print do jogo:** **Ctrl+S** (ou o ícone de câmera no painel do jogo) salva só o PokeIdle em `Imagens\PokeIdle Farm`.
- **Perfis de lives:** no Gerenciar lives, salve a lista com um nome e troque com um clique (também pelo menu da bandeja).
- **Medidor:** CPU e RAM do app no rodapé e de cada página no cabeçalho do painel.

## Se ficar lento

- O botão **Auto-reload** na barra de título liga/desliga o recarregamento automático das lives.
- O rodapé mostra o último reload automático e o motivo. Tudo fica registrado em `%APPDATA%\PokeIdle Farm\farm.log`.
- `"kickPlayerOnly": true` no `config.json` carrega só o player da Kick (sem chat e sem o resto do site), bem mais leve.
  Não sei se a Kick conta o tempo assistido nesse modo, então teste antes de confiar.

## Interface

- Divisória arrastável entre esquerda e direita (duplo clique volta para 60/40). A proporção fica salva.
- Cada painel: status (ao vivo, travado, offline…), zoom, som, recarregar e abrir no navegador.
- Dentro de um painel: **F5** recarrega e **F12** abre o DevTools.
- Fechar a janela só esconde na bandeja (ícone da pokébola). Para sair: botão direito no ícone → Sair.
- O som das lives começa mutado; o estado de cada botão fica salvo.

## Extensão /hunt

Na abertura o app baixa a extensão **/hunt for PokeIdle** da Chrome Web Store e carrega no painel do jogo.
Se o download falhar, usa a última cópia baixada. Também dá pra colocar a extensão descompactada em
`extensions/mhnplloljgchpfpcpbhmcokmnefodjnh/` que ela tem prioridade. O rodapé mostra se carregou.

Outras extensões: adicione o id em `extensions` no `config.json`.

## Configuração (`config.json`)

- `streams`: canais da direita (adicione ou remova à vontade).
- `streamsMutedByDefault`, `lowestQuality` (tenta forçar 160p na Kick, melhor esforço).
- `watchdog`: intervalo, `stalledChecksBeforeReload` (recarrega se o vídeo ficar parado N checagens; `0` desliga) e reload preventivo em horas (`0` desliga).
- `closeToTray`: `false` faz o X fechar o app de verdade.

Os dados (login, estado da janela, estatísticas) ficam em `%APPDATA%\PokeIdle Farm`.

## Licença

[MIT](LICENSE).

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

- Os executáveis do [Releases](https://github.com/LeooSato/pokeidle-farmer-browser/releases) são gerados só pelo GitHub Actions a partir deste repositório (workflow `.github/workflows/release.yml`).
- Committers e aprovadores: [LeooSato](https://github.com/LeooSato) (dono do repositório). Toda assinatura de release é aprovada manualmente por ele.
- Privacidade: este programa não envia nenhum dado para o autor nem para terceiros. Login, cookies, configurações e estatísticas ficam só no computador de quem usa (`%APPDATA%\PokeIdle Farm`). A rede é usada para abrir os sites que você escolhe (PokeIdle, Kick, Twitch), baixar as extensões da Chrome Web Store e checar atualizações no GitHub Releases.
