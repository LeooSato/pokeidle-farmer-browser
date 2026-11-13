# PokeIdle Farm

Navegador dividido: **pokeidle.io/app** à esquerda e três lives da Kick empilhadas à direita
(axt, yetz, denissnider). Nada é suspenso em segundo plano, então dá pra minimizar e continuar farmando.

## Como rodar

1. Instale o **Node.js LTS**: https://nodejs.org (só uma vez).
2. Abra um terminal nesta pasta e rode:
   ```
   npm install
   npm start
   ```
   Ou dê dois cliques em `iniciar.bat` (ele roda o `npm install` na primeira vez).
   Depois disso, dê dois cliques em **`criar-atalho.vbs`**: ele cria o atalho **PokeIdle Farm** (com a pokébola)
   na Área de Trabalho e no Menu Iniciar. Abrindo pelo atalho não aparece terminal nenhum.
3. Pra logar, use o botão **Login** na barra de título (ou abra pelo `login.bat`). Abrem duas janelas
   normais, uma do PokeIdle e outra da Kick. Loga nelas e fecha as duas: o login fica salvo no cache do
   app e os painéis recarregam já logados. As lives ficam pausadas enquanto essas janelas estiverem abertas.

### Gerar um .exe (opcional)

```
npm run dist
```
O executável portable sai em `dist/`. Coloque um `config.json` ao lado do `.exe` se quiser mudar canais sem recompilar.

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
- O rodapé mostra o último reload automático e o motivo. Tudo fica registrado em `%APPDATA%\pokeidle-farm\farm.log`.
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

Os dados (login, estado da janela) ficam em `%APPDATA%\pokeidle-farm`.
