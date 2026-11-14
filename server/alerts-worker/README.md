# Servidor de alertas (Cloudflare Worker)

Recebe os alertas do app e posta numa **thread privada** de cada usuário no canal `#pokeidle` do servidor do PokeIdle Farm. Também coloca a pessoa no servidor quando ela clica em **Conectar Discord**.

O token do bot e o client secret ficam só aqui, como secrets do Cloudflare. Eles nunca vão no `.exe` nem no repositório. O app recebe apenas um crachá assinado, que só consegue postar na thread da própria pessoa e tem limite de 20 alertas a cada 10 minutos.

## Deploy (pelo GitHub Actions, dá pra fazer do celular)

1. **Cloudflare:** abra Workers & Pages uma vez (para criar o subdomínio `workers.dev`). Copie o **Account ID**. Em My Profile › API Tokens › Create Token, use o modelo **Edit Cloudflare Workers** e copie o token.
2. **GitHub:** em Settings › Secrets and variables › Actions, crie 4 secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `DISCORD_CLIENT_SECRET` (Developer Portal › OAuth2) e `DISCORD_BOT_TOKEN` (Developer Portal › Bot).
3. Em Actions, rode **Deploy servidor de alertas**. O resumo da execução mostra a URL.
4. No Developer Portal, em OAuth2 › Redirects, adicione `<URL>/callback`.
5. No `config.json` do app, coloque `"alertServer": "<URL>"`.

O workflow cria o KV `THREADS` sozinho e grava os segredos no Cloudflare. Eles nunca aparecem no log nem no repositório.

## Comando /resumo

O app manda toda captura (sem imagem: nome, nível, nota, IV, Q, P e shiny) para `POST /captures`, que guarda as das últimas 48 h no D1 `pokeidle-farm-captures`. No Discord, `/resumo [horas]` responde só para quem pediu (mensagem efêmera) com as espécies, os 3 melhores, os shiny e se o app ou o farm parou.

O workflow registra o comando no servidor e configura a Interactions Endpoint URL (`<URL>/interactions`) sozinho. Se der erro, cole essa URL em Developer Portal › General Information › Interactions Endpoint URL.

## Permissões do bot

Convite: `https://discord.com/oauth2/authorize?client_id=1570904100856537108&scope=bot&permissions=360777305089`

Permissões: Criar convite (necessária para o `guilds.join`), Ver canal, Enviar mensagens, Enviar mensagens em threads, Criar threads privadas, Gerenciar threads, Inserir links e Anexar arquivos.
