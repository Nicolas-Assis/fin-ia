import { Hono } from "hono";

// Imports pesados (bot/DB/LLM/exceljs) são carregados sob demanda dentro de cada
// rota (import dinâmico). Assim, /api/health NUNCA depende deles: um TELEGRAM_BOT_TOKEN
// ausente (new Bot("") lança "Empty token!") ou um erro de DB não derruba a função inteira.
export const app = new Hono().basePath("/api");

const isProd = process.env.VERCEL_ENV === "production";

// Erros de rota viram JSON. Em produção não vaza a mensagem interna.
app.onError((err, c) => {
  console.error("[route_failed]", err);
  return c.json(
    { error: "route_failed", ...(isProd ? {} : { message: err.message }) },
    500,
  );
});

app.get("/health", (c) => c.json({ ok: true }));

// Relatório HTML hospedado — aberto pelo botão "Abrir relatório" no Telegram.
// A chave `k` é a chave pessoal (shortcutKey) do usuário, que identifica e autoriza.
app.get("/report", async (c) => {
  const { resolveUserByShortcutKey } = await import("./users.js");
  const user = await resolveUserByShortcutKey(c.req.query("k") || "");
  if (!user) return c.text("unauthorized", 401);

  const [{ collectReportData }, { buildHtmlReport }, { summarize }] =
    await Promise.all([
      import("./report.js"),
      import("./html-report.js"),
      import("./llm.js"),
    ]);
  const data = await collectReportData(
    user.id,
    user.name,
    c.req.query("period") || undefined,
  );
  const resumo = data.countTx > 0 ? await summarize(user.id, data) : "";
  return c.html(buildHtmlReport(data, resumo));
});

app.post("/shortcut", async (c) => {
  const { handleShortcut } = await import("./shortcut.js");
  return handleShortcut(c);
});

// Debug: GET /api/shortcut?debug=1 — SÓ para o dono (x-api-key), sem vazar env/contagens a estranhos.
app.get("/shortcut", async (c) => {
  if (c.req.query("debug") !== "1") {
    return c.json(
      { error: "use POST para enviar lançamentos. Para debug: GET /api/shortcut?debug=1 (requer x-api-key do dono)" },
      405,
    );
  }
  const { resolveUserForShortcut } = await import("./users.js");
  const key = c.req.header("x-api-key") || c.req.query("k") || "";
  const user = await resolveUserForShortcut(key);
  if (!user || user.role !== "owner") {
    return c.json({ error: "unauthorized" }, 401);
  }
  try {
    const { prisma } = await import("./db.js");
    const [usuarios, contas] = await Promise.all([
      prisma.user.count(),
      prisma.account.count(),
    ]);
    return c.json({
      env: {
        SHORTCUT_API_KEY: process.env.SHORTCUT_API_KEY ? "✅ definida" : "❌ AUSENTE",
        DATABASE_URL: process.env.DATABASE_URL ? "✅ definida" : "❌ AUSENTE",
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ? "✅ definida" : "❌ AUSENTE",
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ? "✅ definida" : "❌ AUSENTE",
      },
      totais: { usuarios, contas },
    });
  } catch (e: any) {
    return c.json({ error: isProd ? "debug_failed" : e?.message }, 500);
  }
});

// Cron diário (Vercel Cron → resumo proativo). Protegido pelo CRON_SECRET.
app.get("/cron/digest", async (c) => {
  const auth = c.req.header("authorization") || "";
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const { runDailyDigest } = await import("./digest.js");
  const result = await runDailyDigest();
  return c.json({ ok: true, ...result });
});

app.post("/telegram", async (c) => {
  if (c.req.query("secret") !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const [{ webhookCallback }, { bot }] = await Promise.all([
    import("grammy"),
    import("./telegram.js"),
  ]);
  // timeout alto: fluxos com 2 chamadas de LLM (rotear → responder) passam de 10s.
  return webhookCallback(bot, "hono", { timeoutMilliseconds: 25_000 })(c);
});
