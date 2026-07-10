// Uso: APP_URL=https://seu-app.vercel.app npm run set-webhook
// (lê TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, APP_URL do ambiente)

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
