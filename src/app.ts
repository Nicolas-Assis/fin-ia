import { Hono } from "hono";

// Imports pesados (bot/DB/LLM/exceljs) são carregados sob demanda dentro de cada
// rota (import dinâmico). Assim, /api/health NUNCA depende deles: um TELEGRAM_BOT_TOKEN
// ausente (new Bot("") lança "Empty token!") ou um erro de DB não derruba a função inteira.
export const app = new Hono().basePath("/api");

// Erros de rota viram JSON com a mensagem real — ajuda a diagnosticar env faltando na Vercel.
app.onError((err, c) =>
  c.json({ error: "route_failed", message: err.message }, 500),
);

app.get("/health", (c) => c.json({ ok: true }));

// Relatório HTML hospedado — aberto pelo botão "Abrir relatório" no Telegram.
// A chave `k` é a chave pessoal (shortcutKey) do usuário, que identifica e autoriza.
// GET /api/report?k=<chave-pessoal>&period=<mes|semana|hoje|AAAA-MM>
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
  const resumo = data.countTx > 0 ? await summarize(data) : "";
  return c.html(buildHtmlReport(data, resumo));
});

app.post("/shortcut", async (c) => {
  const { handleShortcut } = await import("./shortcut.js");
  return handleShortcut(c);
});

// Debug: GET /api/shortcut?debug=1 — mostra estado das env vars e contas cadastradas
app.get("/shortcut", async (c) => {
  if (c.req.query("debug") !== "1") {
    return c.json(
      {
        error:
          "use POST para enviar lançamentos. Para debug: GET /api/shortcut?debug=1",
      },
      405,
    );
  }
  try {
    const { prisma } = await import("./db.js");
    const [usuarios, contas] = await Promise.all([
      prisma.user.count(),
      prisma.account.count(),
    ]);
    return c.json({
      env: {
        SHORTCUT_API_KEY: process.env.SHORTCUT_API_KEY
          ? `✅ definida (${process.env.SHORTCUT_API_KEY.length} chars)`
          : "❌ AUSENTE",
        DATABASE_URL: process.env.DATABASE_URL ? "✅ definida" : "❌ AUSENTE",
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN
          ? "✅ definida"
          : "❌ AUSENTE",
      },
      totais: { usuarios, contas },
      instrucoes: {
        header_obrigatorio: "x-api-key: <chave pessoal do usuário (veja /atalho no bot)>",
        body_texto: '{ "texto": "gastei 45 no posto no nubank" }',
        body_estruturado:
          '{ "tipo": "saida", "valor": 45, "conta": "Nubank", "descricao": "posto" }',
      },
    });
  } catch (e: any) {
    return c.json({ error: e?.message, stack: e?.stack }, 500);
  }
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
