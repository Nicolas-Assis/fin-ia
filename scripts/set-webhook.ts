// Uso: APP_URL=https://seu-app.vercel.app npm run set-webhook
// (lê TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, APP_URL do ambiente)
export {};

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const appUrl = process.env.APP_URL;

if (!token || !secret || !appUrl) {
  console.error("Faltam variáveis: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, APP_URL");
  process.exit(1);
}

const url = `${appUrl.replace(/\/$/, "")}/api/telegram?secret=${secret}`;

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  }),
});

console.log("setWebhook ->", await res.json());
console.log("Webhook apontado para:", url);

// Registra o menu de comandos (aquele "/" que aparece no app do Telegram).
// Comandos de todos os usuários (escopo padrão).
const memberCommands = [
  { command: "menu", description: "🏠 Menu principal (com botões)" },
  { command: "relatorio", description: "📊 Relatório visual (HTML + link)" },
  { command: "resumo", description: "⚡ Resumo rápido do período" },
  { command: "categorias", description: "🍩 Gastos por categoria" },
  { command: "hoje", description: "📅 Lançamentos de hoje" },
  { command: "extrato", description: "🧾 Últimos lançamentos" },
  { command: "metas", description: "🎯 Metas de gasto por categoria" },
  { command: "planilha", description: "📑 Exportar Excel (.xlsx)" },
  { command: "saldo", description: "💼 Saldo das contas" },
  { command: "contas", description: "🏦 Listar contas" },
  { command: "addconta", description: "➕ Nova conta" },
  { command: "atalho", description: "📲 Instalar/configurar Atalho do iOS" },
  { command: "minhachave", description: "🔑 Copiar minha chave pessoal" },
  { command: "desfazer", description: "↩️ Apagar último lançamento" },
  { command: "ajuda", description: "❓ Guia de uso" },
];

// Comandos extras só do dono (aparecem apenas no chat dele).
const ownerCommands = [
  ...memberCommands,
  { command: "convidar", description: "👥 (dono) Autorizar uma pessoa" },
  { command: "remover", description: "🚫 (dono) Bloquear uma pessoa" },
  { command: "pessoas", description: "👑 (dono) Quem tem acesso" },
];

async function setCommands(commands: unknown, scope?: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands, ...(scope ? { scope } : {}) }),
  });
  return res.json();
}

// Escopo padrão: membros (sem comandos de dono).
console.log("setMyCommands (default) ->", await setCommands(memberCommands));

// Escopo do chat do dono: lista completa. Só se TELEGRAM_CHAT_ID estiver definido.
const ownerChatId = process.env.TELEGRAM_CHAT_ID;
if (ownerChatId) {
  console.log(
    "setMyCommands (owner) ->",
    await setCommands(ownerCommands, { type: "chat", chat_id: Number(ownerChatId) }),
  );
} else {
  console.warn("TELEGRAM_CHAT_ID ausente — comandos de dono não registrados por escopo.");
}
