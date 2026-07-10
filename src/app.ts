import { Hono } from "hono";
import { webhookCallback } from "grammy";
import { bot } from "./telegram.js";
import { handleShortcut } from "./shortcut.js";

// Vercel roteia /api/* para o catch-all; req.url chega como "/api/...".
export const app = new Hono().basePath("/api");

app.get("/health", (c) => c.json({ ok: true }));

app.post("/shortcut", handleShortcut);

// grammY em modo webhook. webhookCallback faz bot.init() de forma lazy.
const telegramWebhook = webhookCallback(bot, "hono");
app.post("/telegram", (c) => {
  if (c.req.query("secret") !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return telegramWebhook(c);
});
