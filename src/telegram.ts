import { Bot, InlineKeyboard, InputFile } from "grammy";
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
import { buildReport } from "./report.js";

export const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN || "");

const OWNER = process.env.TELEGRAM_CHAT_ID || "";

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

/** Só responde ao dono configurado. */
bot.use(async (ctx, next) => {
  const id = String(ctx.chat?.id ?? ctx.from?.id ?? "");
  if (OWNER && id !== OWNER) {
    if (ctx.chat?.type === "private") {
      await ctx.reply(`🔒 Bot privado. Seu chat id é: ${id}`);
    }
    return;
  }
  await next();
});

// -------------------- Comandos --------------------

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "💰 *Fin AI* — seu gerenciador financeiro.",
      "",
      "Só me mandar em linguagem natural, ex:",
      "`gastei 45 no posto no cartão nubank`",
      "`recebi 3200 de salário na conta itau`",
      "",
      "Comandos:",
      "/saldo — saldo de todas as contas",
      "/contas — listar contas",
      "/addconta Nome | tipo | moeda | saldoInicial",
      "/relatorio [mes|semana|AAAA-MM] — gera a planilha",
      "/desfazer — apaga o último lançamento",
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
});

bot.command("saldo", async (ctx) => {
  const rows = await balances();
  if (rows.length === 0) return ctx.reply("Nenhuma conta cadastrada. Use /addconta.");
  const total = rows.reduce((s, r) => s + r.balance, 0);
  const lines = rows.map((r) => `• ${r.name}: ${fmtBRL(r.balance, r.currency)}`);
  await ctx.reply(
    `📊 *Saldos*\n${lines.join("\n")}\n\n*Total:* ${fmtBRL(total)}`,
    { parse_mode: "Markdown" },
  );
});

bot.command("contas", async (ctx) => {
  const accs = await listAccounts();
  if (accs.length === 0) return ctx.reply("Nenhuma conta. Use /addconta.");
  const lines = accs.map(
    (a) => `• ${a.name} (${a.type}, ${a.currency}) — inicial ${fmtBRL(Number(a.initialBalance), a.currency)}`,
  );
  await ctx.reply(`🏦 *Contas*\n${lines.join("\n")}`, { parse_mode: "Markdown" });
});

bot.command("addconta", async (ctx) => {
  // /addconta Nubank | cartao | BRL | 0
  const args = (ctx.match || "").split("|").map((s) => s.trim());
  if (!args[0]) {
    return ctx.reply("Formato: /addconta Nome | tipo | moeda | saldoInicial\nEx: /addconta Nubank | cartao | BRL | 0");
  }
  try {
    const acc = await addAccount({
      name: args[0],
      type: args[1] || "corrente",
      currency: (args[2] || "BRL").toUpperCase(),
      initialBalance: args[3] ? Number(args[3].replace(",", ".")) : 0,
    });
    await ctx.reply(`✅ Conta criada: *${acc.name}* (${acc.type}, ${acc.currency})`, {
      parse_mode: "Markdown",
    });
  } catch (e: any) {
    await ctx.reply(`❌ Não consegui criar a conta (nome já existe?). ${e?.message ?? ""}`);
  }
});

bot.command("relatorio", async (ctx) => {
  await ctx.replyWithChatAction("upload_document");
  try {
    const { buffer, filename, stats } = await buildReport(ctx.match);
    const resumo = await summarize(stats);
    await ctx.replyWithDocument(new InputFile(buffer, filename), {
      caption:
        `📈 Relatório — ${stats.periodo}\n` +
        `Entradas: ${fmtBRL(stats.totalEntradas)}\n` +
        `Saídas: ${fmtBRL(stats.totalSaidas)}\n` +
        `Resultado: ${fmtBRL(stats.resultado)}` +
        (resumo ? `\n\n🧠 ${resumo}` : ""),
    });
  } catch (e: any) {
    await ctx.reply(`❌ Erro ao gerar relatório: ${e?.message ?? e}`);
  }
});

bot.command("desfazer", async (ctx) => {
  const last = await prisma.transaction.findFirst({
    orderBy: { createdAt: "desc" },
    include: { account: true },
  });
  if (!last) return ctx.reply("Nada para desfazer.");
  await prisma.transaction.delete({ where: { id: last.id } });
  await ctx.reply(
    `↩️ Removido: ${last.type} ${fmtBRL(Number(last.amount), last.currency)} em ${last.account.name} (${last.category}).`,
  );
});

// -------------------- Texto livre → confirmação --------------------

bot.on("message:text", async (ctx) => {
  const texto = ctx.message.text;
  if (texto.startsWith("/")) return; // comando não reconhecido

  const accs = await listAccounts();
  if (accs.length === 0) {
    return ctx.reply("Antes cadastre uma conta com /addconta.");
  }

  let parsed: ParsedTx;
  try {
    parsed = await parseTransaction(texto, accs.map((a) => a.name));
  } catch (e: any) {
    return ctx.reply(`❌ Não entendi o lançamento. (${e?.message ?? e})`);
  }

  const acc = await resolveAccount(parsed.conta);

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
    // pedir conta
    const kb = new InlineKeyboard();
    accs.forEach((a, i) => {
      kb.text(a.name, `acc:${pending.id}:${a.id}`);
      if (i % 2 === 1) kb.row();
    });
    kb.row().text("❌ Cancelar", `no:${pending.id}`);
    return ctx.reply(
      `${emoji(parsed.tipo)} ${fmtBRL(parsed.valor, payload.moeda)} — ${parsed.categoria}\n` +
        `_${parsed.descricao}_\n\nEm qual conta?`,
      { parse_mode: "Markdown", reply_markup: kb },
    );
  }

  await ctx.reply(confirmText(payload, acc.name), {
    parse_mode: "Markdown",
    reply_markup: confirmKb(pending.id),
  });
});

// -------------------- Callbacks --------------------

bot.callbackQuery(/^acc:(.+):(.+)$/, async (ctx) => {
  const [, pendingId, accountId] = ctx.match;
  const pending = await prisma.pending.findUnique({ where: { id: pendingId } });
  if (!pending) return ctx.answerCallbackQuery("Expirado.");
  const acc = await prisma.account.findUnique({ where: { id: accountId } });
  if (!acc) return ctx.answerCallbackQuery("Conta inválida.");
  const payload = pending.payload as unknown as PendingPayload;
  payload.accountId = acc.id;
  payload.moeda = acc.currency;
  await prisma.pending.update({ where: { id: pendingId }, data: { payload: payload as any } });
  await ctx.editMessageText(confirmText(payload, acc.name), {
    parse_mode: "Markdown",
    reply_markup: confirmKb(pendingId),
  });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^ok:(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pending = await prisma.pending.findUnique({ where: { id: pendingId } });
  if (!pending) return ctx.answerCallbackQuery("Expirado.");
  const p = pending.payload as unknown as PendingPayload;
  if (!p.accountId) return ctx.answerCallbackQuery("Escolha a conta primeiro.");

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

  const acc = await prisma.account.findUnique({ where: { id: p.accountId } });
  const rows = await balances();
  const saldo = rows.find((r) => r.name === acc?.name);
  await ctx.editMessageText(
    `✅ Salvo!\n${emoji(p.tipo)} ${fmtBRL(p.valor, p.moeda)} — ${p.categoria} em *${acc?.name}*` +
      (saldo ? `\nSaldo da conta: ${fmtBRL(saldo.balance, saldo.currency)}` : ""),
    { parse_mode: "Markdown" },
  );
  await ctx.answerCallbackQuery("Salvo ✅");
});

bot.callbackQuery(/^no:(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  await prisma.pending.deleteMany({ where: { id: pendingId } });
  await ctx.editMessageText("❌ Cancelado.");
  await ctx.answerCallbackQuery();
});

// -------------------- Helpers --------------------

function emoji(tipo: string) {
  return tipo === "entrada" ? "🟢 Entrada" : "🔴 Saída";
}

function confirmText(p: PendingPayload, contaNome: string) {
  return (
    `${emoji(p.tipo)} *${fmtBRL(p.valor, p.moeda)}*\n` +
    `Conta: ${contaNome}\n` +
    `Categoria: ${p.categoria}\n` +
    `_${p.descricao}_\n\nConfirmar?`
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
