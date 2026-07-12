import { Bot, Context, InlineKeyboard, InputFile, GrammyError } from "grammy";
import type { User as DbUser, Account } from "@prisma/client";
import { routeMessage, type ParsedTx } from "./intents.js";
import { answerQuestion } from "./qa.js";
import { LLM_USER_ERROR } from "./llm.js";
import {
  addAccount,
  balances,
  createTransaction,
  deleteTransactionById,
  findLastTransaction,
  getUserAccount,
  listAccounts,
  resolveAccountFrom,
} from "./transactions.js";
import {
  createPending,
  getPending,
  claimPending,
  discardPending,
  updatePendingPayload,
  type PendingItem,
  type PendingPayload,
} from "./pending.js";
import { setBudget, removeBudget, budgetAlert } from "./budgets.js";
import { collectReportData, buildReport } from "./report.js";
import { buildHtmlReport } from "./html-report.js";
import { summarize } from "./llm.js";
import { donutChartSvg, dailyBarsSvg, renderChartPng } from "./charts.js";
import { transcribeVoice, extractReceipt, fetchTelegramFileB64 } from "./media.js";
import {
  deactivateUser,
  inviteUser,
  resolveUser,
} from "./users.js";
import { fmtCents, fmtBRL, decToCents, parseAmountBR } from "./money.js";
import { CATEGORIES, categoryEmoji } from "./categories.js";
import { dayKeyTz, fromLocalDateString, shortDateBR } from "./dates.js";
import { b, esc, i, code, accountIcon } from "./fmt.js";
import {
  reportUrl,
  isOwner,
  renderMenu,
  renderHelp,
  renderHelpSection,
  renderSaldo,
  renderContas,
  renderResumo,
  renderHoje,
  renderCategorias,
  renderExtrato,
  renderMetas,
  renderPessoas,
  type View,
} from "./views.js";

type Ctx = Context & { user: DbUser };

export const bot = new Bot<Ctx>(process.env.TELEGRAM_BOT_TOKEN || "");

const HTML = { parse_mode: "HTML" as const };

// -------------------- Autenticação multiusuário --------------------

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
        `🔒 Você ainda não tem acesso ao ${b("Fin AI")}.\n\n` +
          `Mande este código para quem te convidou:\n${code(telegramId)}\n\n` +
          `A pessoa te libera com ${code(`/convidar ${telegramId} SeuNome`)}.`,
        HTML,
      );
    }
    return;
  }
  ctx.user = user as DbUser;
  await next();
});

// -------------------- Comandos --------------------

bot.command(["start", "menu"], (ctx) => startOrMenu(ctx));
bot.command(["ajuda", "help"], (ctx) => replyView(ctx, renderHelp()));

bot.command("saldo", async (ctx) => replyView(ctx, await renderSaldo(ctx.user)));
bot.command("contas", async (ctx) => replyView(ctx, await renderContas(ctx.user)));
bot.command("relatorio", (ctx) => sendRelatorio(ctx, ctx.match));
bot.command("planilha", (ctx) => sendPlanilha(ctx, ctx.match));
bot.command("resumo", async (ctx) => replyView(ctx, await renderResumo(ctx.user, ctx.match)));
bot.command("hoje", async (ctx) => replyView(ctx, await renderHoje(ctx.user)));
bot.command("categorias", async (ctx) => replyView(ctx, await renderCategorias(ctx.user, ctx.match)));
bot.command("extrato", async (ctx) => replyView(ctx, await renderExtrato(ctx.user, ctx.match)));
bot.command(["metas", "meta"], (ctx) => handleMeta(ctx, ctx.match));
bot.command(["atalho", "apikey"], (ctx) => sendAtalho(ctx, ctx.user));
bot.command(["minhachave", "chave"], (ctx) => sendChave(ctx, ctx.user));

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
      initialBalanceCents: parseAmountBR(args[3]) ?? 0,
    });
    await ctx.reply(
      `✅ Conta criada: ${b(acc.name)} (${esc(acc.type)}, ${esc(acc.currency)})`,
      HTML,
    );
  } catch (e: any) {
    await ctx.reply(`❌ Não consegui criar a conta (nome já existe?). ${e?.message ?? ""}`);
  }
});

bot.command("desfazer", async (ctx) => {
  const last = await findLastTransaction(ctx.user.id);
  if (!last) return ctx.reply("Nada para desfazer.");
  const kb = new InlineKeyboard()
    .text("↩️ Desfazer", `undo:${last.id}`)
    .text("✅ Manter", "no:keep");
  await ctx.reply(
    `Quer desfazer o último lançamento?\n\n` +
      `${last.type === "saida" ? "🔴" : "🟢"} ${b(fmtCents(decToCents(last.amount), last.currency))} · ` +
      `${categoryEmoji(last.category)} ${esc(last.category)} · ${esc(last.account.name)}\n` +
      `${i(last.description || "—")}`,
    { ...HTML, reply_markup: kb },
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
  let aviso: string;
  try {
    await ctx.api.sendMessage(
      tgId,
      `🎉 Você foi liberado(a) no ${b("Fin AI")}!\n\nMande /start para começar. Suas finanças ficam ${b("separadas e privadas")} — só você vê.`,
      HTML,
    );
    aviso = "📨 Já avisei a pessoa aqui no Telegram.";
  } catch {
    aviso =
      "⚠️ Não consegui avisar automaticamente (a pessoa precisa ter aberto o bot ao menos uma vez). Peça pra ela mandar /start.";
  }
  await ctx.reply(`✅ ${b(u.name || tgId)} autorizado(a)!\n${aviso}`, HTML);
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
    `🚫 ${b(u.name || tgId)} desativado(a). Os dados dele(a) ficam guardados, só o acesso é bloqueado.`,
    HTML,
  );
});

bot.command("pessoas", async (ctx) => replyView(ctx, await renderPessoas(ctx.user)));

// -------------------- Texto livre / voz / foto --------------------

bot.on("message:text", async (ctx) => {
  const texto = ctx.message.text;
  if (texto.startsWith("/")) {
    return ctx.reply(
      `🤔 Não conheço esse comando. Veja ${code("/ajuda")} ou toque em /menu.`,
      HTML,
    );
  }
  await handleFreeText(ctx, texto);
});

bot.on(["message:voice", "message:audio"], async (ctx) => {
  const media = ctx.message.voice ?? ctx.message.audio;
  if (!media) return;
  if ((media.duration ?? 0) > 90 || (media.file_size ?? 0) > 5_000_000) {
    return ctx.reply("🎤 Áudio muito longo. Manda algo curtinho (até ~1 min) ou escreve o gasto.");
  }
  await ctx.replyWithChatAction("typing");
  try {
    const file = await ctx.api.getFile(media.file_id);
    const { b64 } = await fetchTelegramFileB64(file.file_path!);
    const texto = await transcribeVoice(b64);
    if (!texto) return ctx.reply("🎤 Não consegui entender o áudio. Tenta de novo?");
    await ctx.reply(`🎤 ${i(texto)}`, HTML);
    await handleFreeText(ctx, texto);
  } catch (e) {
    console.error("[voice] erro:", e);
    await ctx.reply(LLM_USER_ERROR);
  }
});

bot.on("message:photo", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  try {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.api.getFile(photo.file_id);
    const { b64, mime } = await fetchTelegramFileB64(file.file_path!);
    const accs = await listAccounts(ctx.user.id);
    if (accs.length === 0) return replyNoAccounts(ctx);
    const lancamentos = await extractReceipt(
      b64,
      mime || "image/jpeg",
      accs.map((a) => a.name),
      ctx.message.caption,
    );
    if (lancamentos.length === 0) {
      return ctx.reply("🧾 Não achei um comprovante nessa imagem. Manda a foto de uma nota ou escreve o gasto.");
    }
    await presentConfirm(ctx, lancamentos, `foto: ${ctx.message.caption ?? "comprovante"}`, accs);
  } catch (e) {
    console.error("[photo] erro:", e);
    await ctx.reply(LLM_USER_ERROR);
  }
});

/** Núcleo: roteia uma mensagem livre para registrar / perguntar / conversar. */
async function handleFreeText(ctx: Ctx, texto: string) {
  const accs = await listAccounts(ctx.user.id);
  await ctx.replyWithChatAction("typing");

  let route;
  try {
    route = await routeMessage(texto, { contas: accs.map((a) => a.name) });
  } catch (e) {
    console.error("[route] erro:", e);
    return ctx.reply(LLM_USER_ERROR);
  }

  if (route.intencao === "conversa") {
    return ctx.reply(esc(route.resposta || "🙂"), HTML);
  }

  if (route.intencao === "pergunta" && route.pergunta) {
    try {
      const resposta = await answerQuestion(ctx.user.id, ctx.user.name, texto, route.pergunta);
      const kb = new InlineKeyboard().text("📊 Ver resumo", "m:resumo");
      return ctx.reply(esc(resposta), { ...HTML, reply_markup: kb });
    } catch (e) {
      console.error("[qa] erro:", e);
      return ctx.reply(LLM_USER_ERROR);
    }
  }

  // registrar
  if (accs.length === 0) return replyNoAccounts(ctx);
  if (route.lancamentos.length === 0) {
    return ctx.reply(
      `🤔 Entendi que é um lançamento, mas não achei o valor.\nEx.: ${code("uber 23 ontem")}`,
      HTML,
    );
  }
  await presentConfirm(ctx, route.lancamentos, texto, accs);
}

function replyNoAccounts(ctx: Ctx) {
  return ctx.reply(
    `Você ainda não tem contas. Crie uma com:\n${code("/addconta Nubank | cartao | BRL | 0")}\n\nOu toque em /start.`,
    HTML,
  );
}

// -------------------- Card de confirmação --------------------

async function presentConfirm(
  ctx: Ctx,
  lancamentos: ParsedTx[],
  raw: string,
  accs: Account[],
) {
  const items: PendingItem[] = lancamentos.map((l) => {
    const acc = resolveAccountFrom(accs, l.conta);
    return {
      tipo: l.tipo,
      valorCents: l.valorCents,
      moeda: acc?.currency || l.moeda,
      categoria: l.categoria,
      descricao: l.descricao,
      accountId: acc?.id ?? null,
      occurredAt: l.data ?? undefined,
    };
  });
  const confianca = Math.min(...lancamentos.map((l) => l.confianca));
  const payload: PendingPayload = { v: 2, items, raw, confianca };
  const { id } = await createPending(String(ctx.chat!.id), payload);
  const view = confirmCard(id, payload, accs);
  await ctx.reply(view.text, { ...HTML, reply_markup: view.kb });
}

function occurredLabel(dateStr: string): string {
  const now = Date.now();
  const ontem = dayKeyTz(new Date(now - 86_400_000));
  const anteontem = dayKeyTz(new Date(now - 2 * 86_400_000));
  const rel = dateStr === ontem ? "ontem " : dateStr === anteontem ? "anteontem " : "";
  return `${rel}(${shortDateBR(dateStr)})`;
}

function itemLine(it: PendingItem, accName: string | null): string {
  const emoji = it.tipo === "saida" ? "🔴" : "🟢";
  const conta = accName ? ` · ${esc(accName)}` : "";
  return `${emoji} ${b(fmtCents(it.valorCents, it.moeda))} · ${categoryEmoji(it.categoria)} ${esc(it.categoria)}${conta}`;
}

function confirmCard(
  pendingId: string,
  payload: PendingPayload,
  accs: Account[],
): View {
  const nameById = new Map(accs.map((a) => [a.id, a.name]));
  const items = payload.items;
  const needsAccount = items.some((it) => !it.accountId);
  const lowConf = (payload.confianca ?? 1) < 0.6;

  let text: string;
  if (items.length === 1) {
    const it = items[0];
    const accName = it.accountId ? nameById.get(it.accountId) ?? null : null;
    const lines = [
      `${it.tipo === "saida" ? "🔴 Saída" : "🟢 Entrada"} de ${b(fmtCents(it.valorCents, it.moeda))}`,
      `${categoryEmoji(it.categoria)} ${esc(it.categoria)}${accName ? ` · ${esc(accName)}` : ""}`,
    ];
    if (it.descricao) lines.push(`📝 ${i(it.descricao)}`);
    if (it.occurredAt) lines.push(`📅 ${esc(occurredLabel(it.occurredAt))}`);
    text = lines.join("\n");
  } else {
    const totalByCur = new Map<string, number>();
    const lines = items.map((it, idx) => {
      const accName = it.accountId ? nameById.get(it.accountId) ?? null : null;
      if (it.tipo === "saida")
        totalByCur.set(it.moeda, (totalByCur.get(it.moeda) ?? 0) + it.valorCents);
      const date = it.occurredAt ? ` 📅 ${esc(occurredLabel(it.occurredAt))}` : "";
      return `${idx + 1}. ${itemLine(it, accName)}${date}`;
    });
    const totais = [...totalByCur.entries()]
      .map(([cur, c]) => fmtCents(c, cur))
      .join(" · ");
    text = `${b(`${items.length} lançamentos`)}\n${lines.join("\n")}` + (totais ? `\n\n🔴 Total: ${esc(totais)}` : "");
  }

  const header = lowConf
    ? `🤔 ${b("Não tenho certeza — confere pra mim?")}\n\n`
    : "";
  text = header + text + `\n\n${needsAccount ? "Em qual conta?" : "Confirmar?"}`;

  const kb = new InlineKeyboard();
  if (needsAccount) {
    accs.forEach((a, idx) => {
      kb.text(`${accountIcon(a.type)} ${a.name}`, `acc:${pendingId}:${a.id}`);
      if (idx % 2 === 1) kb.row();
    });
    kb.row().text("❌ Cancelar", `no:${pendingId}`);
  } else {
    kb.text("✅ Confirmar", `ok:${pendingId}`).text("❌ Cancelar", `no:${pendingId}`);
    if (items.length === 1) kb.row().text("✏️ Categoria", `cat:${pendingId}`);
  }
  return { text, kb };
}

// -------------------- Callbacks: confirmação --------------------

bot.callbackQuery(/^acc:([^:]+):(.+)$/, async (ctx) => {
  const [, pendingId, accountId] = ctx.match;
  const chatId = String(ctx.chat?.id);
  const pending = await getPending(pendingId, chatId);
  if (!pending) return expired(ctx);
  const acc = await getUserAccount(accountId, ctx.user.id);
  if (!acc) return ctx.answerCallbackQuery("Conta inválida.");

  for (const it of pending.payload.items) {
    if (!it.accountId) {
      it.accountId = acc.id;
      it.moeda = acc.currency;
    }
  }
  await updatePendingPayload(pendingId, pending.payload);
  const accs = await listAccounts(ctx.user.id);
  const view = confirmCard(pendingId, pending.payload, accs);
  await editText(ctx, view);
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^cat:(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pending = await getPending(pendingId, String(ctx.chat?.id));
  if (!pending) return expired(ctx);
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard();
  CATEGORIES.forEach((c, idx) => {
    kb.text(`${c.emoji} ${c.name}`, `catq:${pendingId}:${idx}`);
    if (idx % 2 === 1) kb.row();
  });
  kb.row().text("⬅️ Voltar", `bk:${pendingId}`);
  await editText(ctx, { text: `✏️ ${b("Escolha a categoria:")}`, kb });
});

bot.callbackQuery(/^catq:([^:]+):(\d+)$/, async (ctx) => {
  const [, pendingId, idxStr] = ctx.match;
  const pending = await getPending(pendingId, String(ctx.chat?.id));
  if (!pending) return expired(ctx);
  const cat = CATEGORIES[Number(idxStr)];
  if (cat && pending.payload.items[0]) {
    pending.payload.items[0].categoria = cat.name;
    await updatePendingPayload(pendingId, pending.payload);
  }
  const accs = await listAccounts(ctx.user.id);
  await editText(ctx, confirmCard(pendingId, pending.payload, accs));
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^bk:(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pending = await getPending(pendingId, String(ctx.chat?.id));
  if (!pending) return expired(ctx);
  const accs = await listAccounts(ctx.user.id);
  await editText(ctx, confirmCard(pendingId, pending.payload, accs));
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^ok:(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const chatId = String(ctx.chat?.id);
  const pending = await getPending(pendingId, chatId);
  if (!pending) return expired(ctx);

  const items = pending.payload.items;
  if (items.some((it) => !it.accountId)) {
    return ctx.answerCallbackQuery("Escolha a conta primeiro.");
  }
  // Valida posse de todas as contas ANTES do claim.
  for (const it of items) {
    const acc = await getUserAccount(it.accountId!, ctx.user.id);
    if (!acc) return ctx.answerCallbackQuery("Conta inválida.");
  }
  // Claim atômico: o segundo clique perde a corrida aqui.
  if (!(await claimPending(pendingId, chatId))) {
    return ctx.answerCallbackQuery("Já processado ✅");
  }

  let created;
  try {
    created = [];
    for (const it of items) {
      const tx = await createTransaction({
        accountId: it.accountId!,
        type: it.tipo,
        amountCents: it.valorCents,
        currency: it.moeda,
        category: it.categoria,
        description: it.descricao,
        source: "telegram",
        rawInput: pending.payload.raw,
        occurredAt: it.occurredAt ? fromLocalDateString(it.occurredAt) ?? undefined : undefined,
      });
      created.push(tx);
    }
  } catch (e) {
    console.error("[ok] falha ao salvar:", e);
    await ctx.answerCallbackQuery("Erro ao salvar");
    return editText(ctx, {
      text: "😵 Não consegui salvar agora. Manda o lançamento de novo, por favor.",
    });
  }

  const rows = await balances(ctx.user.id);
  const balById = new Map(rows.map((r) => [r.accountId, r]));

  // Alertas de meta (categorias de saída, sem repetir).
  const catsSaida = [...new Set(items.filter((it) => it.tipo === "saida").map((it) => it.categoria))];
  const alerts = (await Promise.all(catsSaida.map((c) => budgetAlert(ctx.user.id, c)))).filter(
    (a): a is string => !!a,
  );

  let text: string;
  const kb = new InlineKeyboard();
  if (items.length === 1) {
    const it = items[0];
    const bal = balById.get(it.accountId!);
    text =
      `✅ ${b("Salvo!")}\n${itemLine(it, bal?.name ?? null)}` +
      (bal ? `\n💼 Saldo da conta: ${esc(fmtCents(bal.balanceCents, bal.currency))}` : "");
    kb.text("↩️ Desfazer", `undo:${created[0].id}`).text("📅 Hoje", "m:hoje");
  } else {
    const lines = items.map((it) => itemLine(it, balById.get(it.accountId!)?.name ?? null));
    text = `✅ ${b(`${items.length} lançamentos salvos!`)}\n${lines.join("\n")}`;
    kb.text("📅 Hoje", "m:hoje").text("⚡ Resumo", "m:resumo");
  }
  if (alerts.length) text += `\n\n${alerts.map(esc).join("\n")}`;

  await editText(ctx, { text, kb });
  await ctx.answerCallbackQuery("Salvo ✅");
});

bot.callbackQuery("no:keep", async (ctx) => {
  await ctx.answerCallbackQuery("Mantido 👍");
  await editText(ctx, { text: "👍 Ok, mantido." });
});

bot.callbackQuery(/^no:(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  await discardPending(pendingId, String(ctx.chat?.id));
  await editText(ctx, { text: "❌ Cancelado." });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^undo:(.+)$/, async (ctx) => {
  const txId = ctx.match[1];
  const deleted = await deleteTransactionById(txId, ctx.user.id);
  if (!deleted) {
    await ctx.answerCallbackQuery("Esse lançamento já não existe.");
    return;
  }
  await editText(ctx, {
    text:
      `↩️ ${b("Desfeito")}: ${deleted.type === "saida" ? "🔴" : "🟢"} ` +
      `${esc(fmtCents(deleted.amountCents, deleted.currency))} · ${categoryEmoji(deleted.category)} ${esc(deleted.category)} em ${esc(deleted.accountName)}.`,
  });
  await ctx.answerCallbackQuery("Desfeito ↩️");
});

// -------------------- Callbacks: menu (edit-in-place) --------------------

bot.callbackQuery("m:home", (ctx) => editView(ctx, renderMenu(ctx.user)));
bot.callbackQuery("m:help", (ctx) => editView(ctx, renderHelp()));
bot.callbackQuery("m:saldo", async (ctx) => editView(ctx, await renderSaldo(ctx.user)));
bot.callbackQuery("m:contas", async (ctx) => editView(ctx, await renderContas(ctx.user)));
bot.callbackQuery("m:resumo", async (ctx) => editView(ctx, await renderResumo(ctx.user, "mes")));
bot.callbackQuery("m:categorias", async (ctx) => editView(ctx, await renderCategorias(ctx.user, "mes")));
bot.callbackQuery("m:hoje", async (ctx) => editView(ctx, await renderHoje(ctx.user)));
bot.callbackQuery("m:extrato", async (ctx) => editView(ctx, await renderExtrato(ctx.user, "10")));
bot.callbackQuery("m:metas", async (ctx) => editView(ctx, await renderMetas(ctx.user)));
bot.callbackQuery("m:pessoas", async (ctx) => editView(ctx, await renderPessoas(ctx.user)));
bot.callbackQuery(/^h:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await editText(ctx, renderHelpSection(ctx.match[1]));
});

bot.callbackQuery("m:relatorio", async (ctx) => {
  await ctx.answerCallbackQuery("Gerando relatório…");
  await sendRelatorio(ctx, "mes");
});
bot.callbackQuery("m:atalho", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendAtalho(ctx, ctx.user);
});
bot.callbackQuery("m:chave", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendChave(ctx, ctx.user);
});
bot.callbackQuery("m:novaconta", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `➕ ${b("Nova conta")}\nMande:\n${code("/addconta Nome | tipo | moeda | saldoInicial")}\n\n` +
      `Tipos: corrente, poupanca, cartao, dinheiro, cripto\nEx: ${code("/addconta Itaú | corrente | BRL | 1500")}`,
    HTML,
  );
});

// -------------------- Callbacks: gráficos --------------------

bot.callbackQuery(/^g:(cat|dia):(.+)$/, async (ctx) => {
  const [, kind, per] = ctx.match;
  await ctx.answerCallbackQuery("Gerando gráfico…");
  await ctx.replyWithChatAction("upload_photo");
  try {
    const data = await collectReportData(ctx.user.id, ctx.user.name, per);
    const svg = kind === "cat" ? donutChartSvg(data) : dailyBarsSvg(data);
    const png = await renderChartPng(svg);
    if (png) {
      const caption =
        kind === "cat"
          ? `🍩 Gastos por categoria — ${data.periodo}`
          : `📊 Fluxo diário — ${data.periodo}`;
      await ctx.replyWithPhoto(new InputFile(png, "grafico.png"), { caption });
    } else {
      // Fallback textual quando a rasterização falha.
      const view = kind === "cat" ? await renderCategorias(ctx.user, per) : await renderResumo(ctx.user, per);
      await replyView(ctx, view);
    }
  } catch (e) {
    console.error("[chart] erro:", e);
    await ctx.reply("😵 Não consegui gerar o gráfico agora.");
  }
});

// -------------------- Onboarding --------------------

const SUGGESTED_ACCOUNTS = ["Nubank", "Itaú", "Bradesco", "Caixa", "Carteira", "PicPay"];

async function startOrMenu(ctx: Ctx) {
  const accs = await listAccounts(ctx.user.id);
  if (accs.length > 0) return replyView(ctx, renderMenu(ctx.user));

  const kb = new InlineKeyboard();
  SUGGESTED_ACCOUNTS.forEach((name, idx) => {
    kb.text(name, `ob:acc:${idx}`);
    if (idx % 2 === 1) kb.row();
  });
  kb.row().text("✍️ Outra conta", "ob:skip");
  await ctx.reply(
    `👋 ${b("Bem-vindo(a) ao Fin AI!")}\n\n` +
      `Eu anoto seus gastos quando você escreve (ou fala) em linguagem natural.\n\n` +
      `Pra começar, ${b("crie sua primeira conta")} 👇`,
    { ...HTML, reply_markup: kb },
  );
}

bot.callbackQuery(/^ob:acc:(\d+)$/, async (ctx) => {
  const name = SUGGESTED_ACCOUNTS[Number(ctx.match[1])];
  if (!name) return ctx.answerCallbackQuery("Opção inválida.");
  try {
    await addAccount({
      userId: ctx.user.id,
      name,
      type: name === "Carteira" ? "dinheiro" : "corrente",
    });
    await ctx.answerCallbackQuery(`Conta ${name} criada!`);
    await editText(ctx, {
      text:
        `✅ Conta ${b(name)} criada!\n\n` +
        `Agora me conta um gasto — por exemplo:\n${code("gastei 25 no almoço")}`,
    });
  } catch {
    await ctx.answerCallbackQuery("Você já tem essa conta.");
  }
});

bot.callbackQuery("ob:skip", async (ctx) => {
  await ctx.answerCallbackQuery();
  await editText(ctx, {
    text:
      `➕ ${b("Criar conta")}\nMande:\n${code("/addconta Nome | tipo | moeda | saldoInicial")}\n\n` +
      `Ex: ${code("/addconta Inter | corrente | BRL | 0")}`,
  });
});

// -------------------- Metas --------------------

async function handleMeta(ctx: Ctx, arg?: string) {
  const raw = (arg || "").trim();
  if (!raw) return replyView(ctx, await renderMetas(ctx.user));

  const parts = raw.split(/\s+/);
  const valorStr = parts[parts.length - 1];
  const categoria = parts.slice(0, -1).join(" ");
  if (!categoria) {
    return ctx.reply(
      `Formato: ${code("/meta Categoria valor")}\nEx.: ${code("/meta Alimentação 800")} · remover com valor ${code("0")}.`,
      HTML,
    );
  }
  const cents = parseAmountBR(valorStr);
  if (valorStr === "0" || cents === 0) {
    const removed = await removeBudget(ctx.user.id, categoria);
    return ctx.reply(removed ? `🗑️ Meta de ${b(categoria)} removida.` : "Não havia meta nessa categoria.", HTML);
  }
  if (!cents) {
    return ctx.reply(`Valor inválido. Ex.: ${code("/meta Alimentação 800")}`, HTML);
  }
  const meta = await setBudget(ctx.user.id, categoria, cents);
  await ctx.reply(
    `🎯 Meta de ${categoryEmoji(meta.category)} ${b(meta.category)} definida: ${esc(fmtCents(meta.amountCents))}/mês.`,
    HTML,
  );
}

// -------------------- Documentos e chave --------------------

async function sendRelatorio(ctx: Ctx, arg?: string) {
  await ctx.replyWithChatAction("upload_document");
  try {
    const data = await collectReportData(ctx.user.id, ctx.user.name, arg);
    const resumo = data.countTx > 0 ? await summarize(ctx.user.id, data) : "";
    const html = buildHtmlReport(data, resumo);
    const filename = `fin-ai-${dayKeyTz(data.from)}_a_${dayKeyTz(data.to)}.html`;
    const url = reportUrl(ctx.user, arg);
    const kb = url ? new InlineKeyboard().url("🌐 Abrir relatório online", url) : undefined;
    await ctx.replyWithDocument(new InputFile(Buffer.from(html, "utf8"), filename), {
      caption: reportCaption(data, resumo),
      reply_markup: kb,
    });
  } catch (e: any) {
    await ctx.reply(`❌ Erro ao gerar relatório: ${e?.message ?? e}`);
  }
}

async function sendPlanilha(ctx: Ctx, arg?: string) {
  await ctx.replyWithChatAction("upload_document");
  try {
    const { buffer, filename, stats } = await buildReport(ctx.user.id, ctx.user.name, arg);
    await ctx.replyWithDocument(new InputFile(buffer, filename), {
      caption: reportCaption(stats),
    });
  } catch (e: any) {
    await ctx.reply(`❌ Erro ao gerar planilha: ${e?.message ?? e}`);
  }
}

async function sendChave(ctx: Ctx, user: DbUser) {
  await ctx.reply(
    `🔑 ${b("Sua chave pessoal do Fin AI")}\n\n` +
      `${code(user.shortcutKey)}\n\n` +
      `👆 Toque na chave para copiar.\n` +
      `Cole no campo ${b("x-api-key")} do seu atalho do iOS. 🔒 Não compartilhe — é só sua.`,
    HTML,
  );
}

async function sendAtalho(ctx: Ctx, user: DbUser) {
  const base = process.env.APP_URL?.replace(/\/$/, "") || "https://seu-app.vercel.app";
  const link = reportUrl(user, "mes");
  const template = process.env.SHORTCUT_TEMPLATE_URL;

  const kb = new InlineKeyboard();
  if (template) kb.url("📲 Instalar o atalho no iPhone", template).row();
  if (link) kb.url("🌐 Abrir meu relatório", link).row();
  kb.text("🔑 Copiar minha chave", "m:chave");

  const linhas = [
    `📲 ${b("Integração / Atalho do iOS")}`,
    "",
    `${b("Sua chave pessoal")} (não compartilhe):`,
    code(user.shortcutKey),
    "",
  ];
  if (template) {
    linhas.push(
      `${b("Como colocar no iPhone:")}`,
      "1️⃣ Toque em Instalar o atalho aqui embaixo.",
      `2️⃣ Dentro do atalho, na ação ${i("Obter conteúdo de URL")} → cabeçalho ${code("x-api-key")}, cole a sua chave acima.`,
      "3️⃣ Pronto! Rode o atalho e fale/escreva o gasto.",
    );
  } else {
    linhas.push(
      `${b("Monte um atalho")} com a ação ${i("Obter conteúdo de URL")}:`,
      `• URL: ${code(base + "/api/shortcut")}`,
      "• Método: POST",
      `• Cabeçalho ${code("x-api-key")}: sua chave acima`,
      `• Corpo (JSON): ${code('{ "texto": "gastei 45 no posto" }')}`,
    );
  }
  await ctx.reply(linhas.join("\n"), { ...HTML, reply_markup: kb });
}

function reportCaption(d: import("./report.js").ReportData, resumo?: string): string {
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
  return cap; // caption vai SEM parse_mode (texto puro)
}

// -------------------- Dispatch helpers --------------------

async function replyView(ctx: Ctx, view: View) {
  await ctx.reply(view.text, { ...HTML, reply_markup: view.kb });
}

/** Edita a mensagem atual para a nova view; usado nos callbacks de menu. */
async function editView(ctx: Ctx, view: View) {
  await ctx.answerCallbackQuery();
  await editText(ctx, view);
}

async function editText(ctx: Ctx, view: View) {
  try {
    await ctx.editMessageText(view.text, { ...HTML, reply_markup: view.kb });
  } catch (e) {
    // "message is not modified" e afins: não são erro real pro usuário.
    if (e instanceof GrammyError && e.error_code === 400) return;
    throw e;
  }
}

function expired(ctx: Ctx) {
  return ctx
    .answerCallbackQuery("⌛ Expirou — manda o lançamento de novo.")
    .then(() => editText(ctx, { text: "⌛ Este lançamento expirou. Manda de novo? 🙂" }))
    .catch(() => {});
}

// -------------------- Erros --------------------

bot.catch(async (err) => {
  console.error("Bot error:", err);
  try {
    const ctx = err.ctx;
    if (ctx?.callbackQuery) {
      await ctx.answerCallbackQuery("😵 Algo deu errado. Tenta de novo?");
    } else if (ctx?.chat) {
      await ctx.reply("😵 Algo deu errado do meu lado. Tenta de novo?");
    }
  } catch {
    // evita loop de erro
  }
});
