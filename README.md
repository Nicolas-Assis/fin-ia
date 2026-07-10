# 💰 Fin AI — Gerenciador financeiro pessoal (Telegram + iOS Shortcuts + IA)

Registre entradas e saídas por **texto livre no Telegram** ou por um **Atalho do iOS**.
A IA (Llama 4 Maverick via OpenRouter) interpreta, categoriza e confirma; tudo é gravado
no **Postgres** e você gera **relatórios .xlsx sob demanda** direto no chat.

```
Atalho iOS ──POST /api/shortcut──┐
                                 ├─> Hono (Vercel) ─> Llama 4 (parse) ─> Postgres ─> relatório .xlsx
Telegram ──webhook /api/telegram─┘                                         │
                                              Telegram <────────────────────┘ (confirmação, /saldo, /relatorio)
```

## Stack
- **Hono** em função serverless na **Vercel** (runtime Node)
- **grammY** para o bot do Telegram (modo webhook)
- **Prisma + Postgres (Neon)** como fonte de verdade
- **ExcelJS** para o relatório .xlsx (gerado em memória, enviado no chat)
- **OpenRouter** → `meta-llama/llama-4-maverick`

---

## 1. Pré-requisitos
1. Conta na **Vercel** e no **Neon** (postgres serverless grátis).
2. Bot no Telegram: fale com **@BotFather** → `/newbot` → guarde o **token**.
3. Descubra seu **chat id**: mande qualquer mensagem pro seu bot depois do deploy;
   se não estiver autorizado ele responde com `Seu chat id é: 123...`. Use esse número
   em `TELEGRAM_CHAT_ID` (assim só você usa o bot).
4. Chave da **OpenRouter**.

## 2. Instalar e configurar
```bash
npm install
cp .env.example .env   # preencha as variáveis
```

No **Neon**, use a connection string **com `-pooler`** em `DATABASE_URL`
(para as functions) e a **direta** em `DIRECT_URL` (para migrations).

## 3. Criar as tabelas
```bash
npm run db:push        # cria o schema no Neon
npm run seed           # (opcional) cria contas de exemplo — edite scripts/seed.ts
```

## 4. Deploy na Vercel
```bash
npm i -g vercel
vercel                 # primeiro deploy
```
Depois, no painel da Vercel, adicione **todas** as variáveis do `.env`
(Project → Settings → Environment Variables) e faça `vercel --prod`.

## 5. Registrar o webhook do Telegram
Com o app no ar:
```bash
APP_URL=https://seu-app.vercel.app npm run set-webhook
```
Teste: mande `/start` pro bot. Depois `/addconta Nubank | cartao | BRL | 0`.

Agora é só mandar: `gastei 45 no posto no nubank` → confirma no botão ✅.

Relatório: `/relatorio mes` (ou `semana`, ou `2026-07`).

---

## 6. Atalho do iOS (Shortcuts)

Crie um atalho novo com estas ações (versão estruturada — mais confiável):

1. **Escolher do Menu** → itens: `Saída`, `Entrada`.
   - Em cada ramo, defina uma variável de texto **Tipo** = `saida` / `entrada`.
2. **Pedir Entrada** (número) → "Valor?" → guarda em **Valor**.
3. **Pedir Entrada** (texto) → "O que foi?" → guarda em **Descrição**.
4. **Escolher do Menu** com o nome exato das suas contas (`Nubank`, `Itaú`, `Dinheiro`)
   → guarda em **Conta**. (Precisa bater com o nome cadastrado.)
5. **Obter conteúdo de URL**:
   - URL: `https://seu-app.vercel.app/api/shortcut`
   - Método: **POST**
   - Cabeçalhos: `x-api-key` = *(sua **chave pessoal** — mande `/atalho` no bot para pegá-la)*
   - Corpo da solicitação: **JSON**
     ```json
     {
       "tipo": "Tipo",
       "valor": "Valor",
       "conta": "Conta",
       "descricao": "Descrição"
     }
     ```
     (substitua os valores pelas *variáveis mágicas* correspondentes)
6. **Mostrar Notificação** com o resultado.

> Alternativa "1 clique": em vez dos passos 1–4, use só um **Pedir Entrada (texto)**
> e mande `{ "texto": "<variável>" }`. A IA extrai tipo/valor/conta/categoria sozinha.

Para aparecer a janela "toda vez que faz uma ação", adicione o atalho à
**Tela de Início** ou a um **widget/Automação** no app Atalhos.

---

---

## 7. Compartilhar com a família 👨‍👩‍👧 (multiusuário)

Cada pessoa tem as **próprias contas e lançamentos, totalmente isolados** (ninguém vê os dados do outro). Você (`TELEGRAM_CHAT_ID`) é o **dono/admin**.

1. A pessoa manda qualquer mensagem pro bot → recebe um **código** (o chat id dela).
2. Você libera: `/convidar <código> <nome>` — ex: `/convidar 123456789 Mãe`.
3. Pronto: ela manda `/start`, cria as contas dela (`/addconta`) e usa tudo.
4. Cada um pega a **própria chave** do Atalho do iOS com `/atalho`.

Admin: `/pessoas` (lista quem tem acesso) · `/remover <código>` (bloqueia o acesso, sem apagar os dados).

> **Migração:** ao rodar `npm run db:push` num projeto que já tinha dados, as contas antigas viram automaticamente do dono na primeira vez que ele mandar `/start` (ou ao rodar `npm run seed`).

---

## Endpoints
- `POST /api/shortcut` — header `x-api-key` (**chave pessoal**, via `/atalho`); body estruturado **ou** `{ "texto": "..." }`.
- `POST /api/telegram?secret=...` — webhook do Telegram.
- `GET /api/report?k=<chave-pessoal>&period=<mes|semana|hoje|AAAA-MM>` — relatório **HTML** online do dono da chave (aberto pelo botão no chat).
- `GET /api/health` — status.

## Comandos do bot
- texto livre → registrar lançamento (com confirmação)
- `/menu` — menu principal com **botões** (tudo a um toque)

**Relatórios**
- `/relatorio [hoje|semana|mes|AAAA-MM]` — relatório **visual em HTML** (gráficos de barras/donut, KPIs, extrato) enviado como arquivo **+ botão para abrir online**.
- `/planilha [período]` — exporta em Excel (`.xlsx`).
- `/resumo [período]` — resumo rápido no chat (KPIs + maiores categorias + análise da IA).
- `/categorias [período]` — gastos por categoria com barras.
- `/hoje` — lançamentos do dia · `/extrato [n]` — últimos lançamentos.

**Contas & integração**
- `/saldo` · `/contas` · `/addconta Nome | tipo | moeda | saldoInicial`
- `/atalho` — sua chave pessoal + link do relatório · `/desfazer` · `/menu` · `/ajuda`

**Dono (admin)**
- `/pessoas` · `/convidar <id> <nome>` · `/remover <id>`

> O relatório HTML é **autocontido** (CSS e gráficos SVG inline, sem dependências externas),
> tem tema claro/escuro automático e fica ótimo no navegador, no celular e na impressão.

## Notas
- Como a Vercel é serverless, a confirmação usa uma tabela `Pending` (não memória).
- Dinheiro é `Decimal(14,2)`; saldo = inicial + entradas − saídas.
- **Multiusuário isolado**: dados por pessoa; o `TELEGRAM_CHAT_ID` é o dono e autoriza os demais.
