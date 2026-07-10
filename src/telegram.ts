import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import type { User as DbUser } from "@prisma/client";
import { prisma } from "./db.js";
import { parseTransaction, summarize, type ParsedTx } from "./llm.js";
import {
  addAccount,
  balances,
  createTransaction,
  fmtBRL,
  listAccounts,
  resolveAccount,
} from "./transactions.js";
import { buildReport, collectReportData, type ReportData } from "./report.js";
import { buildHtmlReport } from "./html-report.js";
import {
  deactivateUser,
  inviteUser,
  listUsers,
  resolveUser,
} from "./users.js";

// Contexto com o usuário resolvido pelo middleware de autenticação.
type Ctx = Context & { user: DbUser };

export const bot = new Bot<Ctx>(process.env.TELEGRAM_BOT_TOKEN || "");

// Payload guardado em Pending.payload
interface PendingPayload {
  tipo: "entrada" | "saida";
  valor: number;
  moeda: string;
  categoria: string;
  descricao: string;
  accountId: string | null;
  raw: string;
}

const ACCOUNT_ICON: Record<string, string> = {
  cartao: "💳",
  corrente: "🏦",
  poupanca: "🐷",
  dinheiro: "💵",
  cripto: "₿",
};

// -------------------- Autenticação multiusuário --------------------

/** Resolve quem está falando. Autoriza o dono automaticamente; barra desconhecidos. */
bot.use(async (ctx, next) => {
  const telegramId = String(ctx.from?.id ?? ctx.chat?.id ?? "");
  if (!telegramId) return;
  const displayName =
    [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") ||
    ctx.from?.username ||
    "";

  const user = await resolveUser(telegramId, displayName);
  if (!user) {
    if (ctx.chat?.type === "private") {
      await ctx.reply(
        `🔒 Você ainda não tem acesso ao *Fin AI*.\n\n` +
          `Mande este código para quem te convidou:\n\`${telegramId}\`\n\n` +
          `A pessoa te libera com \`/convidar ${telegramId} SeuNome\`.`,
        { parse_mode: "Markdown" },
      );
    }
    return;
  }
  ctx.user = user;
  await next();
});

// -------------------- Comandos --------------------

bot.command(["start", "menu"], async (ctx) => sendMenu(ctx, ctx.user));
bot.command(["ajuda", "help"], async (ctx) => sendHelp(ctx, ctx.user));

bot.command("saldo", (ctx) => viewSaldo(ctx, ctx.user));
bot.command("contas", (ctx) => viewContas(ctx, ctx.user));
bot.command("relatorio", (ctx) => viewRelatorio(ctx, ctx.user, ctx.match));
bot.command("planilha", (ctx) => viewPlanilha(ctx, ctx.user, ctx.match));
bot.command("resumo", (ctx) => viewResumo(ctx, ctx.user, ctx.match));
bot.command("hoje", (ctx) => viewHoje(ctx, ctx.user));
bot.command("categorias", (ctx) => viewCategorias(ctx, ctx.user, ctx.match));
bot.command("extrato", (ctx) => viewExtrato(ctx, ctx.user, ctx.match));
bot.command(["atalho", "chave", "apikey"], (ctx) => viewAtalho(ctx, ctx.user));

bot.command("addconta", async (ctx) => {
  const args = (ctx.match || "").split("|").map((s) => s.trim());
  if (!args[0]) {
    return ctx.reply(
      "Formato: /addconta Nome | tipo | moeda | saldoInicial\nEx: /addconta Nubank | cartao | BRL | 0",
    );
  }
  try {
    const acc = await addAccount({
      userId: ctx.user.id,
      name: args[0],
      type: args[1] || "corrente",
      currency: (args[2] || "BRL").toUpperCase(),
      initialBalance: args[3] ? Number(args[3].replace(",", ".")) : 0,
    });
    await ctx.reply(
      `✅ Conta criada: *${mdEsc(acc.name)}* (${acc.type}, ${acc.currency})`,
      { parse_mode: "Markdown" },
    );
  } catch (e: any) {
    await ctx.reply(
      `❌ Não consegui criar a conta (nome já existe?). ${e?.message ?? ""}`,
    );
  }
});

bot.command("desfazer", async (ctx) => {
  const last = await prisma.transaction.findFirst({
    where: { account: { userId: ctx.user.id } },
    orderBy: { createdAt: "desc" },
    include: { account: true },
  });
  if (!last) return ctx.reply("Nada para desfazer.");
  await prisma.transaction.delete({ where: { id: last.id } });
  await ctx.reply(
    `↩️ Removido: ${last.type} ${fmtBRL(Number(last.amount), last.currency)} em ${last.account.name} (${last.category}).`,
  );
});

// -------- Administração (só o dono) --------

bot.command("convidar", async (ctx) => {
  if (!isOwner(ctx.user)) return ctx.reply("🔒 Só o dono pode convidar pessoas.");
  const parts = (ctx.match || "").trim().split(/\s+/);
  const tgId = parts[0];
  const nome = parts.slice(1).join(" ");
  if (!/^\d{3,}$/.test(tgId || "")) {
    return ctx.reply(
      "Formato: /convidar <id> <nome>\n\nO <id> é o código que aparece pra pessoa quando ela manda uma mensagem pro bot.\nEx: /convidar 123456789 Mãe",
    );
  }
  const u = await inviteUser(tgId, nome);

  // Tenta avisar a pessoa aqui mesmo no Telegram (só funciona se ela já abriu o bot).
  let aviso: string;
  try {
    await ctx.api.sendMessage(
      tgId,
      `🎉 Você foi liberado(a) no *Fin AI*!\n\nMande /start para começar. Suas finanças ficam *separadas e privadas* — só você vê.`,
      { parse_mode: "Markdown" },
    );
    aviso = "📨 Já avisei a pessoa aqui no Telegram.";
  } catch {
    aviso =
      "⚠️ Não consegui avisar automaticamente (a pessoa precisa ter aberto o bot ao menos uma vez). Peça pra ela mandar /start.";
  }

  await ctx.reply(
    `✅ *${mdEsc(u.name || tgId)}* autorizado(a)!\n${aviso}`,
    { parse_mode: "Markdown" },
  );
});

bot.command("remover", async (ctx) => {
  if (!isOwner(ctx.user)) return ctx.reply("🔒 Só o dono pode remover pessoas.");
  const tgId = (ctx.match || "").trim();
  if (!/^\d{3,}$/.test(tgId)) {
    return ctx.reply("Formato: /remover <id>. Veja os ids em /pessoas.");
  }
  if (tgId === ctx.user.telegramId) {
    return ctx.reply("Você não pode remover a si mesmo. 🙂");
  }
  const u = await deactivateUser(tgId);
  if (!u) return ctx.reply("Não achei ninguém com esse id.");
  await ctx.reply(
    `🚫 *${mdEsc(u.name || tgId)}* desativado(a). Os dados dele(a) ficam guardados, só o acesso é bloqueado.`,
    { parse_mode: "Markdown" },
  );
});

bot.command("pessoas", (ctx) => viewPessoas(ctx, ctx.user));

// -------------------- Texto livre → confirmação --------------------

const KNOWN_COMMANDS =
  /^\/(convidar|remover|addconta|relatorio|planilha|resumo|categorias|extrato|saldo|contas|hoje|atalho|chave|apikey|menu|ajuda|help|desfazer|pessoas|start)\b/i;

bot.on("message:text", async (ctx) => {
  const texto = ctx.message.text;
  if (texto.startsWith("/")) return; // comando não reconhecido

  // Erro comum: mandar "Convidar /convidar ..." (texto ANTES do comando).
  // Nesse caso o Telegram não executa o comando; então damos a dica certinha.
  const slashIdx = texto.indexOf("/");
  if (slashIdx > 0) {
    const rest = texto.slice(slashIdx).trim();
    if (KNOWN_COMMANDS.test(rest)) {
      return ctx.reply(
        `👉 Para usar um comando, a mensagem precisa *começar* com "/", sem nada antes. Tente:\n\`${rest}\``,
        { parse_mode: "Markdown" },
      );
    }
  }

  const accs = await listAccounts(ctx.user.id);
  if (accs.length === 0) {
    return ctx.reply(
      "Você ainda não tem contas. Crie uma com:\n`/addconta Nubank | cartao | BRL | 0`",
      { parse_mode: "Markdown" },
    );
  }

  let parsed: ParsedTx;
  try {
    parsed = await parseTransaction(texto, accs.map((a) => a.name));
  } catch (e: any) {
    return ctx.reply(`❌ Não entendi o lançamento. (${e?.message ?? e})`);
  }

  // Não registra lançamento sem valor — evita "Saída R$ 0,00" de frases que não são gastos.
  if (!parsed.valor || parsed.valor <= 0) {
    return ctx.reply(
      "🤔 Não identifiquei um valor válido nesse lançamento.\nEx: `gastei 45 no posto no nubank`",
      { parse_mode: "Markdown" },
    );
  }

  const acc = await resolveAccount(ctx.user.id, parsed.conta);

  const payload: PendingPayload = {
    tipo: parsed.tipo,
    valor: parsed.valor,
    moeda: acc?.currency || parsed.moeda,
    categoria: parsed.categoria,
    descricao: parsed.descricao,
    accountId: acc?.id ?? null,
    raw: texto,
  };
  const pending = await prisma.pending.create({
    data: { chatId: String(ctx.chat.id), payload: payload as any },
  });

  if (!acc) {
    const kb = new InlineKeyboard();
    accs.forEach((a, i) => {
      kb.text(a.name, `acc:${pending.id}:${a.id}`);
      if (i % 2 === 1) kb.row();
    });
    kb.row().text("❌ Cancelar", `no:${pending.id}`);
    return ctx.reply(
      `${emoji(parsed.tipo)} ${fmtBRL(parsed.valor, payload.moeda)} — ${parsed.categoria}\n` +
        `_${mdEsc(parsed.descricao)}_\n\nEm qual conta?`,
      { parse_mode: "Markdown", reply_markup: kb },
    );
  }

  await ctx.reply(confirmText(payload, acc.name), {
    parse_mode: "Markdown",
    reply_markup: confirmKb(pending.id),
  });
});

// -------------------- Callbacks: confirmação de lançamento --------------------

bot.callbackQuery(/^acc:(.+):(.+)$/, async (ctx) => {
  const [, pendingId, accountId] = ctx.match;
  const pending = await prisma.pending.findUnique({ where: { id: pendingId } });
  if (!pending || pending.chatId !== String(ctx.chat?.id)) {
    return ctx.answerCallbackQuery("Expirado.");
  }
  const acc = await prisma.account.findUnique({ where: { id: accountId } });
  if (!acc || acc.userId !== ctx.user.id) {
    return ctx.answerCallbackQuery("Conta inválida.");
  }
  const payload = pending.payload as unknown as PendingPayload;
  payload.accountId = acc.id;
  payload.moeda = acc.currency;
  await prisma.pending.update({
    where: { id: pendingId },
    data: { payload: payload as any },
  });
  await ctx.editMessageText(confirmText(payload, acc.name), {
    parse_mode: "Markdown",
    reply_markup: confirmKb(pendingId),
  });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^ok:(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pending = await prisma.pending.findUnique({ where: { id: pendingId } });
  if (!pending || pending.chatId !== String(ctx.chat?.id)) {
    return ctx.answerCallbackQuery("Expirado.");
  }
  const p = pending.payload as unknown as PendingPayload;
  if (!p.accountId) return ctx.answerCallbackQuery("Escolha a conta primeiro.");

  const acc = await prisma.account.findUnique({ where: { id: p.accountId } });
  if (!acc || acc.userId !== ctx.user.id) {
    return ctx.answerCallbackQuery("Conta inválida.");
  }

  await createTransaction({
    accountId: p.accountId,
    type: p.tipo,
    amount: p.valor,
    currency: p.moeda,
    category: p.categoria,
    description: p.descricao,
    source: "telegram",
    rawInput: p.raw,
  });
  await prisma.pending.delete({ where: { id: pendingId } });

  const rows = await balances(ctx.user.id);
  const saldo = rows.find((r) => r.name === acc.name);
  await ctx.editMessageText(
    `✅ Salvo!\n${emoji(p.tipo)} ${fmtBRL(p.valor, p.moeda)} — ${p.categoria} em *${mdEsc(acc.name)}*` +
      (saldo ? `\nSaldo da conta: ${fmtBRL(saldo.balance, saldo.currency)}` : ""),
    { parse_mode: "Markdown" },
  );
  await ctx.answerCallbackQuery("Salvo ✅");
});

bot.callbackQuery(/^no:(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  await prisma.pending.deleteMany({
    where: { id: pendingId, chatId: String(ctx.chat?.id) },
  });
  await ctx.editMessageText("❌ Cancelado.");
  await ctx.answerCallbackQuery();
});

// -------------------- Callbacks: menu interativo --------------------

bot.callbackQuery("m:home", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(menuText(ctx.user), {
    parse_mode: "Markdown",
    reply_markup: mainMenuKb(ctx.user),
  });
});
bot.callbackQuery("m:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendHelp(ctx, ctx.user);
});
bot.callbackQuery("m:saldo", async (ctx) => {
  await ctx.answerCallbackQuery();
  await viewSaldo(ctx, ctx.user);
});
bot.callbackQuery("m:contas", async (ctx) => {
  await ctx.answerCallbackQuery();
  await viewContas(ctx, ctx.user);
});
bot.callbackQuery("m:resumo", async (ctx) => {
  await ctx.answerCallbackQuery();
  await viewResumo(ctx, ctx.user, "mes");
});
bot.callbackQuery("m:relatorio", async (ctx) => {
  await ctx.answerCallbackQuery("Gerando relatório…");
  await viewRelatorio(ctx, ctx.user, "mes");
});
bot.callbackQuery("m:categorias", async (ctx) => {
  await ctx.answerCallbackQuery();
  await viewCategorias(ctx, ctx.user, "mes");
});
bot.callbackQuery("m:hoje", async (ctx) => {
  await ctx.answerCallbackQuery();
  await viewHoje(ctx, ctx.user);
});
bot.callbackQuery("m:extrato", async (ctx) => {
  await ctx.answerCallbackQuery();
  await viewExtrato(ctx, ctx.user, "10");
});
bot.callbackQuery("m:atalho", async (ctx) => {
  await ctx.answerCallbackQuery();
  await viewAtalho(ctx, ctx.user);
});
bot.callbackQuery("m:novaconta", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "➕ *Nova conta*\nMande:\n`/addconta Nome | tipo | moeda | saldoInicial`\n\n" +
      "Tipos: corrente, poupanca, cartao, dinheiro, cripto\nEx: `/addconta Itaú | corrente | BRL | 1500`",
    { parse_mode: "Markdown" },
  );
});
bot.callbackQuery("m:pessoas", async (ctx) => {
  await ctx.answerCallbackQuery();
  await viewPessoas(ctx, ctx.user);
});

// -------------------- Views (reutilizadas por comandos e botões) --------------------

async function viewSaldo(ctx: Ctx, user: DbUser) {
  const [rows, accs] = await Promise.all([
    balances(user.id),
    listAccounts(user.id),
  ]);
  if (rows.length === 0) {
    return ctx.reply("Você ainda não tem contas. Use /addconta.");
  }
  const typeByName = new Map(accs.map((a) => [a.name, a.type]));
  const total = rows.reduce((s, r) => s + r.balance, 0);
  const lines = rows.map((r) => {
    const icon = ACCOUNT_ICON[typeByName.get(r.name) || "corrente"] || "🏦";
    return `${icon} *${mdEsc(r.name)}*: ${fmtBRL(r.balance, r.currency)}`;
  });
  await ctx.reply(
    `📊 *Saldos*\n${lines.join("\n")}\n\n💼 *Total:* ${fmtBRL(total)}`,
    { parse_mode: "Markdown" },
  );
}

async function viewContas(ctx: Ctx, user: DbUser) {
  const accs = await listAccounts(user.id);
  if (accs.length === 0) {
    return ctx.reply("Você ainda não tem contas. Use /addconta.");
  }
  const lines = accs.map((a) => {
    const icon = ACCOUNT_ICON[a.type] || "🏦";
    return `${icon} *${mdEsc(a.name)}* — ${a.type}, ${a.currency} · inicial ${fmtBRL(Number(a.initialBalance), a.currency)}`;
  });
  await ctx.reply(`🏦 *Contas*\n${lines.join("\n")}`, { parse_mode: "Markdown" });
}

async function viewRelatorio(ctx: Ctx, user: DbUser, arg?: string) {
  await ctx.replyWithChatAction("upload_document");
  try {
    const data = await collectReportData(user.id, user.name, arg);
    const resumo = data.countTx > 0 ? await summarize(data) : "";
    const html = buildHtmlReport(data, resumo);
    const filename = `fin-ai-${data.from.toISOString().slice(0, 10)}_a_${data.to
      .toISOString()
      .slice(0, 10)}.html`;
    const url = reportUrl(user, arg);
    const kb = url
      ? new InlineKeyboard().url("🌐 Abrir relatório online", url)
      : undefined;
    await ctx.replyWithDocument(
      new InputFile(Buffer.from(html, "utf8"), filename),
      { caption: reportCaption(data, resumo), reply_markup: kb },
    );
  } catch (e: any) {
    await ctx.reply(`❌ Erro ao gerar relatório: ${e?.message ?? e}`);
  }
}

async function viewPlanilha(ctx: Ctx, user: DbUser, arg?: string) {
  await ctx.replyWithChatAction("upload_document");
  try {
    const { buffer, filename, stats } = await buildReport(user.id, user.name, arg);
    await ctx.replyWithDocument(new InputFile(buffer, filename), {
      caption: reportCaption(stats),
    });
  } catch (e: any) {
    await ctx.reply(`❌ Erro ao gerar planilha: ${e?.message ?? e}`);
  }
}

async function viewResumo(ctx: Ctx, user: DbUser, arg?: string) {
  await ctx.replyWithChatAction("typing");
  const data = await collectReportData(user.id, user.name, arg);
  if (data.countTx === 0) {
    return ctx.reply(`📭 Sem lançamentos em *${mdEsc(data.periodo)}*.`, {
      parse_mode: "Markdown",
    });
  }
  const resumo = await summarize(data);
  const top = data.porCategoria
    .slice(0, 3)
    .map((c) => `   • ${mdEsc(c.categoria)}: ${fmtBRL(c.total)} (${c.pct.toFixed(0)}%)`)
    .join("\n");
  const url = reportUrl(user, arg);
  const kb = url
    ? new InlineKeyboard().url("🌐 Ver relatório completo", url)
    : undefined;
  await ctx.reply(
    `${resumoHeader(data)}` +
      (top ? `\n\n🍩 *Maiores categorias*\n${top}` : "") +
      (resumo ? `\n\n🧠 _${mdEsc(resumo)}_` : ""),
    { parse_mode: "Markdown", reply_markup: kb },
  );
}

async function viewHoje(ctx: Ctx, user: DbUser) {
  const data = await collectReportData(user.id, user.name, "hoje");
  if (data.countTx === 0) {
    return ctx.reply("📭 Nada lançado hoje ainda. Bora registrar? 😉");
  }
  const linhas = [...data.txs]
    .reverse()
    .slice(0, 15)
    .map((t) => {
      const sign = t.tipo === "saida" ? "🔴 -" : "🟢 +";
      return `${sign}${fmtBRL(t.valor)} · ${mdEsc(t.categoria)} — _${mdEsc(t.descricao || "—")}_`;
    })
    .join("\n");
  await ctx.reply(`📅 *Hoje*\n${linhas}\n\n${resumoHeader(data)}`, {
    parse_mode: "Markdown",
  });
}

async function viewCategorias(ctx: Ctx, user: DbUser, arg?: string) {
  const data = await collectReportData(user.id, user.name, arg);
  if (data.porCategoria.length === 0) {
    return ctx.reply(`📭 Sem gastos em *${mdEsc(data.periodo)}*.`, {
      parse_mode: "Markdown",
    });
  }
  const linhas = data.porCategoria
    .slice(0, 10)
    .map(
      (c) =>
        `${textBar(c.pct)} *${mdEsc(c.categoria)}*\n   ${fmtBRL(c.total)} · ${c.pct.toFixed(1)}%`,
    )
    .join("\n");
  await ctx.reply(
    `🍩 *Gastos por categoria — ${mdEsc(data.periodo)}*\n\n${linhas}\n\n🔴 Total: ${fmtBRL(data.totalSaidas)}`,
    { parse_mode: "Markdown" },
  );
}

async function viewExtrato(ctx: Ctx, user: DbUser, arg?: string) {
  const n = Math.min(30, Math.max(1, Math.floor(Number((arg || "").trim())) || 10));
  const txs = await prisma.transaction.findMany({
    where: { account: { userId: user.id } },
    orderBy: { occurredAt: "desc" },
    take: n,
    include: { account: true },
  });
  if (txs.length === 0) return ctx.reply("Sem lançamentos ainda.");
  const linhas = txs.map((t) => {
    const val = Number(t.amount);
    const sign = t.type === "saida" ? "🔴 -" : "🟢 +";
    const d = t.occurredAt.toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
    });
    return `${sign}${fmtBRL(val, t.currency)} · ${mdEsc(t.category)} · ${mdEsc(t.account.name)}\n   _${mdEsc(t.description || "—")}_ · ${d}`;
  });
  await ctx.reply(
    `🧾 *Últimos ${txs.length} lançamentos*\n\n${linhas.join("\n")}`,
    { parse_mode: "Markdown" },
  );
}

async function viewAtalho(ctx: Ctx, user: DbUser) {
  const base = process.env.APP_URL?.replace(/\/$/, "") || "https://seu-app.vercel.app";
  const link = reportUrl(user, "mes");
  await ctx.reply(
    `📲 *Seu Atalho do iOS / integração*\n\n` +
      `Sua chave pessoal (não compartilhe):\n\`${user.shortcutKey}\`\n\n` +
      `*Como usar no app Atalhos:*\n` +
      `• URL: \`${base}/api/shortcut\`\n` +
      `• Método: POST\n` +
      `• Cabeçalho: \`x-api-key\` = _sua chave acima_\n` +
      `• Corpo (JSON): \`{ "texto": "gastei 45 no posto" }\`\n\n` +
      (link ? `🌐 Link do seu relatório:\n${link}` : ""),
    { parse_mode: "Markdown" },
  );
}

async function viewPessoas(ctx: Ctx, user: DbUser) {
  if (!isOwner(user)) return ctx.reply("🔒 Só o dono vê as pessoas.");
  const users = await listUsers();
  const withCounts = await Promise.all(
    users.map(async (u) => ({
      u,
      contas: await prisma.account.count({ where: { userId: u.id } }),
    })),
  );
  const lines = withCounts.map(({ u, contas }) => {
    const badge = u.role === "owner" ? "👑" : u.active ? "👤" : "🚫";
    const status = u.active ? "" : " _(inativo)_";
    return `${badge} *${mdEsc(u.name || "sem nome")}*${status}\n   id \`${u.telegramId}\` · ${contas} conta(s)`;
  });
  await ctx.reply(
    `👥 *Pessoas no Fin AI* (${users.length})\n\n${lines.join("\n")}\n\n` +
      `Convidar: \`/convidar <id> <nome>\`\nRemover: \`/remover <id>\``,
    { parse_mode: "Markdown" },
  );
}

// -------------------- Menu & ajuda --------------------

function menuText(user: DbUser): string {
  const nome = user.name ? `, ${mdEsc(user.name.split(" ")[0])}` : "";
  return (
    `💰 *Fin AI*${nome}!\n\n` +
    `Manda um lançamento em linguagem natural, tipo:\n` +
    `\`gastei 45 no posto no nubank\`\n` +
    `\`recebi 3200 de salário no itau\`\n\n` +
    `Ou escolhe uma opção abaixo 👇`
  );
}

function mainMenuKb(user: DbUser): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("💼 Saldo", "m:saldo")
    .text("⚡ Resumo", "m:resumo")
    .row()
    .text("📊 Relatório", "m:relatorio")
    .text("🍩 Categorias", "m:categorias")
    .row()
    .text("📅 Hoje", "m:hoje")
    .text("🧾 Extrato", "m:extrato")
    .row()
    .text("🏦 Contas", "m:contas")
    .text("➕ Nova conta", "m:novaconta")
    .row()
    .text("📲 Meu atalho", "m:atalho")
    .text("❓ Comandos", "m:help");
  if (isOwner(user)) kb.row().text("👥 Pessoas", "m:pessoas");
  return kb;
}

async function sendMenu(ctx: Ctx, user: DbUser) {
  await ctx.reply(menuText(user), {
    parse_mode: "Markdown",
    reply_markup: mainMenuKb(user),
  });
}

async function sendHelp(ctx: Ctx, user: DbUser) {
  const linhas = [
    "💰 *Fin AI* — guia de comandos",
    "",
    "✍️ *Lançar* (texto livre):",
    "`gastei 45 no posto no nubank`",
    "`recebi 3200 de salário no itau`",
    "",
    "📊 *Relatórios*",
    "/relatorio `[hoje|semana|mes|AAAA-MM]` — relatório visual (HTML + link)",
    "/planilha `[período]` — exporta Excel (.xlsx)",
    "/resumo `[período]` — resumo rápido",
    "/categorias `[período]` — gastos por categoria",
    "/hoje — lançamentos de hoje",
    "/extrato `[n]` — últimos lançamentos",
    "",
    "🏦 *Contas*",
    "/saldo · /contas · /addconta `Nome | tipo | moeda | saldoInicial`",
    "",
    "📲 *Integração*",
    "/atalho — sua chave e link pro Atalho do iOS",
    "",
    "🛠 *Outros*",
    "/menu — menu com botões",
    "/desfazer — apaga o último lançamento",
  ];
  if (isOwner(user)) {
    linhas.push(
      "",
      "👑 *Dono*",
      "/pessoas — quem tem acesso",
      "/convidar `<id> <nome>` — libera alguém",
      "/remover `<id>` — bloqueia alguém",
    );
  }
  await ctx.reply(linhas.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text("⬅️ Voltar ao menu", "m:home"),
  });
}

// -------------------- Helpers --------------------

function isOwner(user: DbUser): boolean {
  return user.role === "owner";
}

/** Escapa caracteres especiais do Markdown legado do Telegram em texto dinâmico. */
function mdEsc(s: string): string {
  return String(s ?? "").replace(/([_*`\[])/g, "\\$1");
}

/** Link do relatório HTML hospedado, autenticado pela chave pessoal do usuário. */
function reportUrl(user: DbUser, period?: string): string | null {
  const base = process.env.APP_URL;
  if (!base) return null;
  const q = new URLSearchParams({ k: user.shortcutKey });
  const p = (period || "").trim();
  if (p) q.set("period", p);
  return `${base.replace(/\/$/, "")}/api/report?${q.toString()}`;
}

/** Cabeçalho de KPIs em Markdown, reutilizado por /resumo e /hoje. */
function resumoHeader(d: ReportData): string {
  const icon = d.resultado >= 0 ? "📈" : "📉";
  return (
    `📊 *${mdEsc(d.periodo)}*\n` +
    `🟢 Entradas: ${fmtBRL(d.totalEntradas)}\n` +
    `🔴 Saídas: ${fmtBRL(d.totalSaidas)}\n` +
    `${icon} Resultado: *${fmtBRL(d.resultado)}*`
  );
}

/** Legenda (caption) enviada junto aos documentos de relatório — texto puro. */
function reportCaption(d: ReportData, resumo?: string): string {
  const icon = d.resultado >= 0 ? "📈" : "📉";
  let cap =
    `📊 Relatório — ${d.periodo}\n` +
    `━━━━━━━━━━━━━━━\n` +
    `🟢 Entradas: ${fmtBRL(d.totalEntradas)}\n` +
    `🔴 Saídas: ${fmtBRL(d.totalSaidas)}\n` +
    `${icon} Resultado: ${fmtBRL(d.resultado)}\n` +
    `💼 Saldo total: ${fmtBRL(d.saldoTotal)}\n` +
    `🧾 ${d.countTx} lançamento(s)`;
  if (resumo && resumo.trim()) {
    const r = resumo.trim();
    cap += `\n\n🧠 ${r.length > 320 ? r.slice(0, 317) + "…" : r}`;
  }
  return cap;
}

/** Mini barra de progresso em blocos unicode (0–100%). */
function textBar(pct: number): string {
  const n = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return "▓".repeat(n) + "░".repeat(10 - n);
}

function emoji(tipo: string) {
  return tipo === "entrada" ? "🟢 Entrada" : "🔴 Saída";
}

function confirmText(p: PendingPayload, contaNome: string) {
  return (
    `${emoji(p.tipo)} *${fmtBRL(p.valor, p.moeda)}*\n` +
    `Conta: ${mdEsc(contaNome)}\n` +
    `Categoria: ${mdEsc(p.categoria)}\n` +
    `_${mdEsc(p.descricao)}_\n\nConfirmar?`
  );
}

function confirmKb(pendingId: string) {
  return new InlineKeyboard()
    .text("✅ Confirmar", `ok:${pendingId}`)
    .text("❌ Cancelar", `no:${pendingId}`);
}

bot.catch((err) => {
  console.error("Bot error:", err);
});
