# Servidor de alertas (Cloudflare Worker)

Recebe os alertas do app e posta numa **thread privada** de cada usuário no canal `#alertas` do servidor do PokeIdle Farm. Também coloca a pessoa no servidor quando ela clica em **Conectar Discord**.

O token do bot e o client secret ficam só aqui, como secrets do Cloudflare. Eles nunca vão no `.exe` nem no repositório. O app recebe apenas um crachá assinado, que só consegue postar na thread da própria pessoa e tem limite de 20 alertas a cada 10 minutos.

## Deploy

```bash
cd server/alerts-worker
npx wrangler login
npx wrangler kv namespace create THREADS      # copie o id para wrangler.toml
# preencha GUILD_ID e CHANNEL_ID no wrangler.toml
npx wrangler deploy                           # mostra a URL: https://pokeidle-farm-alerts.<conta>.workers.dev
openssl rand -hex 32 | npx wrangler secret put SESSION_KEY
```

Os dois segredos do Discord podem ser colados pelo painel: Cloudflare › Workers › pokeidle-farm-alerts › Settings › Variables and Secrets › Add, do tipo **Secret**:

- `CLIENT_SECRET`: Developer Portal › OAuth2 › Client Secret
- `BOT_TOKEN`: Developer Portal › Bot › Token

No Developer Portal, em OAuth2 › Redirects, adicione `https://pokeidle-farm-alerts.<conta>.workers.dev/callback`.

Para terminar, coloque `"alertServer": "https://pokeidle-farm-alerts.<conta>.workers.dev"` no `config.json` do app.

## Permissões do bot

Convite: `https://discord.com/oauth2/authorize?client_id=1570904100856537108&scope=bot&permissions=360777305089`

Permissões: Criar convite (necessária para o `guilds.join`), Ver canal, Enviar mensagens, Enviar mensagens em threads, Criar threads privadas, Gerenciar threads, Inserir links e Anexar arquivos.
