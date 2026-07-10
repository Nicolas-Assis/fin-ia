import { Hono } from "hono";

// Imports pesados (bot/DB/LLM/exceljs) são carregados sob demanda dentro de cada
// rota (import dinâmico). Assim, /api/health NUNCA depende deles: um TELEGRAM_BOT_TOKEN
// ausente (new Bot("") lança "Empty token!") ou um erro de DB não derruba a função inteira.
export const app = new Hono().basePath("/api");

// Erros de rota viram JSON com a mensagem real — ajuda a diagnosticar env faltando na Vercel.
app.onError((err, c) => c.json({ error: "route_failed", message: err.message }, 500));

app.get("/health", (c) => c.json({ ok: true }));

app.post("/shortcut", async (c) => {
  const { handleShortcut } = await import("./shortcut.js");
  return handleShortcut(c);
});

app.post("/telegram", async (c) => {
  if (c.req.query("secret") !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const [{ webhookCallback }, { bot }] = await Promise.all([
    import("grammy"),
    import("./telegram.js"),
  ]);
  return webhookCallback(bot, "hono")(c);
});
