import { InlineKeyboard } from "grammy";
import type { User as DbUser } from "@prisma/client";
import {
  balances,
  listAccounts,
  listRecentTransactions,
} from "./transactions.js";
import { listUsersWithAccountCounts } from "./users.js";
import { listBudgetsWithSpend } from "./budgets.js";
import { collectReportData, type ReportData } from "./report.js";
import { summarize } from "./llm.js";
import { fmtCents, fmtBRL, decToCents } from "./money.js";
import { categoryEmoji } from "./categories.js";
import { fmtDateTz } from "./dates.js";
import { b, esc, i, code, textBar, tipoSign, accountIcon } from "./fmt.js";

/** Uma tela do bot: texto (HTML) + teclado opcional. */
export interface View {
  text: string;
  kb?: InlineKeyboard;
}

export function isOwner(user: DbUser): boolean {
  return user.role === "owner";
}

/** Link do relatório HTML hospedado, autenticado pela chave pessoal. */
export function reportUrl(user: DbUser, period?: string): string | null {
  const base = process.env.APP_URL;
  if (!base) return null;
  const q = new URLSearchParams({ k: user.shortcutKey });
  const p = (period || "").trim();
  if (p) q.set("period", p);
  return `${base.replace(/\/$/, "")}/api/report?${q.toString()}`;
}

const backRow = (kb: InlineKeyboard) => kb.row().text("⬅️ Menu", "m:home");

// -------------------- Menu & ajuda --------------------

export function renderMenu(user: DbUser): View {
  const nome = user.name ? `, ${esc(user.name.split(" ")[0])}` : "";
  const text =
    `💰 ${b("Fin AI")}${nome}!\n\n` +
    `Manda um lançamento em linguagem natural:\n` +
    `${code("gastei 45 no posto no nubank")}\n` +
    `${code("recebi 3200 de salário no itau")}\n\n` +
    `Ou pergunta: ${code("quanto gastei esse mês?")} 🤔\n\n` +
    `Escolhe uma opção 👇`;
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
    .text("🎯 Metas", "m:metas")
    .text("🏦 Contas", "m:contas")
    .row()
    .text("📲 Meu atalho", "m:atalho")
    .text("❓ Ajuda", "m:help");
  if (isOwner(user)) kb.row().text("👥 Pessoas", "m:pessoas");
  return { text, kb };
}

export function renderHelp(): View {
  const text =
    `❓ ${b("Como usar o Fin AI")}\n\n` +
    `A forma mais rápida é ${b("escrever em linguagem natural")} — eu entendo valor, conta, categoria e até datas.\n\n` +
    `Toque num tema para ver detalhes:`;
  const kb = new InlineKeyboard()
    .text("✍️ Lançar gastos", "h:lancar")
    .text("💬 Perguntar", "h:perguntar")
    .row()
    .text("📊 Relatórios", "h:rel")
    .text("🏦 Contas", "h:contas")
    .row()
    .text("🎯 Metas", "h:metas")
    .text("📲 Atalho iOS", "h:atalho");
  backRow(kb);
  return { text, kb };
}

export function renderHelpSection(sec: string): View {
  const map: Record<string, string> = {
    lancar:
      `✍️ ${b("Lançar gastos e receitas")}\n\n` +
      `Escreva do seu jeito:\n` +
      `• ${code("gastei 45 no posto no nubank")}\n` +
      `• ${code("almoço 32")}\n` +
      `• ${code("cinquenta de pizza ontem")}\n` +
      `• ${code("recebi 2k de freela")}\n` +
      `• ${code("50 no mercado e 30 na farmácia")} (dois de uma vez!)\n\n` +
      `Eu entendo ${i("valor por extenso")}, ${i("2k / mil")}, ${i("datas")} (${code("ontem")}, ${code("dia 5")}) e parcelado (${code("240 em 3x")}). Você confirma antes de salvar.`,
    perguntar:
      `💬 ${b("Perguntar sobre suas finanças")}\n\n` +
      `Pergunte naturalmente:\n` +
      `• ${code("quanto gastei em mercado esse mês?")}\n` +
      `• ${code("qual meu saldo?")}\n` +
      `• ${code("compara esse mês com o mês passado")}\n` +
      `• ${code("qual meu maior gasto?")}\n\n` +
      `Eu respondo com base nos ${i("seus dados reais")}.`,
    rel:
      `📊 ${b("Relatórios")}\n\n` +
      `/relatorio ${code("[hoje|semana|mes|AAAA-MM]")} — visual (HTML + link)\n` +
      `/planilha ${code("[período]")} — Excel (.xlsx)\n` +
      `/resumo ${code("[período]")} — KPIs rápidos\n` +
      `/categorias ${code("[período]")} — gastos por categoria\n` +
      `/hoje — lançamentos de hoje\n` +
      `/extrato ${code("[n]")} — últimos lançamentos`,
    contas:
      `🏦 ${b("Contas")}\n\n` +
      `/saldo — saldo de cada conta\n` +
      `/contas — lista suas contas\n` +
      `/addconta ${code("Nome | tipo | moeda | saldoInicial")}\n\n` +
      `Tipos: corrente, poupanca, cartao, dinheiro, cripto\n` +
      `Ex.: ${code("/addconta Itaú | corrente | BRL | 1500")}`,
    metas:
      `🎯 ${b("Metas de gasto")}\n\n` +
      `Defina um teto mensal por categoria e eu te aviso ao chegar perto:\n` +
      `/meta ${code("Alimentação 800")} — define/atualiza\n` +
      `/metas — vê o progresso do mês\n` +
      `/meta ${code("Alimentação 0")} — remove\n\n` +
      `Quando um gasto cruza 80% ou 100% da meta, o aviso aparece junto do “Salvo”.`,
    atalho:
      `📲 ${b("Atalho do iOS")}\n\n` +
      `Use /atalho para pegar sua chave pessoal e o passo a passo de configuração. ` +
      `Dá pra lançar gastos por voz direto da tela de bloqueio do iPhone.`,
  };
  const text = map[sec] || renderHelp().text;
  const kb = new InlineKeyboard().text("⬅️ Ajuda", "m:help").text("🏠 Menu", "m:home");
  return { text, kb };
}

// -------------------- Saldo / Contas --------------------

export async function renderSaldo(user: DbUser): Promise<View> {
  const rows = await balances(user.id);
  if (rows.length === 0) {
    return { text: "Você ainda não tem contas. Use /addconta.", kb: novaContaKb() };
  }
  const lines = rows.map(
    (r) =>
      `${accountIcon(r.type)} ${b(r.name)}: ${esc(fmtCents(r.balanceCents, r.currency))}`,
  );

  // Total por moeda (não soma BRL com USD).
  const byCur = new Map<string, number>();
  for (const r of rows) byCur.set(r.currency, (byCur.get(r.currency) ?? 0) + r.balanceCents);
  const totals = [...byCur.entries()].map(
    ([cur, cents]) => `💼 ${b("Total")}: ${esc(fmtCents(cents, cur))}`,
  );

  const kb = new InlineKeyboard().text("🏦 Contas", "m:contas").text("⚡ Resumo", "m:resumo");
  backRow(kb);
  return { text: `📊 ${b("Saldos")}\n${lines.join("\n")}\n\n${totals.join("\n")}`, kb };
}

export async function renderContas(user: DbUser): Promise<View> {
  const accs = await listAccounts(user.id);
  if (accs.length === 0) {
    return { text: "Você ainda não tem contas. Use /addconta.", kb: novaContaKb() };
  }
  const lines = accs.map(
    (a) =>
      `${accountIcon(a.type)} ${b(a.name)} — ${esc(a.type)}, ${esc(a.currency)} · inicial ${esc(fmtCents(decToCents(a.initialBalance), a.currency))}`,
  );
  const kb = novaContaKb();
  backRow(kb);
  return { text: `🏦 ${b("Contas")}\n${lines.join("\n")}`, kb };
}

function novaContaKb() {
  return new InlineKeyboard().text("➕ Nova conta", "m:novaconta");
}

// -------------------- Resumo / Hoje / Categorias / Extrato --------------------

export async function renderResumo(user: DbUser, arg?: string): Promise<View> {
  const data = await collectReportData(user.id, user.name, arg);
  if (data.countTx === 0) {
    return { text: `📭 Sem lançamentos em ${b(data.periodo)}.`, kb: menuOnly() };
  }
  const resumo = await summarize(user.id, data);
  const top = data.porCategoria
    .slice(0, 3)
    .map(
      (c) =>
        `   ${categoryEmoji(c.categoria)} ${esc(c.categoria)}: ${esc(fmtBRL(c.total))} (${c.pct.toFixed(0)}%)`,
    )
    .join("\n");
  const text =
    resumoHeader(data) +
    (top ? `\n\n🍩 ${b("Maiores categorias")}\n${top}` : "") +
    multiMoedaLinha(data) +
    (resumo ? `\n\n🧠 ${i(resumo)}` : "");

  const kb = new InlineKeyboard()
    .text("🍩 Categorias", "m:categorias")
    .text("📈 Gráfico", `g:dia:${periodToken(arg)}`);
  const url = reportUrl(user, arg);
  if (url) kb.row().url("🌐 Relatório completo", url);
  backRow(kb);
  return { text, kb };
}

export async function renderHoje(user: DbUser): Promise<View> {
  const data = await collectReportData(user.id, user.name, "hoje");
  if (data.countTx === 0) {
    return { text: "📭 Nada lançado hoje ainda. Bora registrar? 😉", kb: menuOnly() };
  }
  const linhas = [...data.txs]
    .reverse()
    .slice(0, 15)
    .map(
      (t) =>
        `${tipoSign(t.tipo)}${esc(fmtBRL(t.valor, t.moeda))} · ${categoryEmoji(t.categoria)} ${esc(t.categoria)} — ${i(t.descricao || "—")}`,
    )
    .join("\n");
  const kb = new InlineKeyboard().text("⚡ Resumo", "m:resumo").text("🧾 Extrato", "m:extrato");
  backRow(kb);
  return { text: `📅 ${b("Hoje")}\n${linhas}\n\n${resumoHeader(data)}`, kb };
}

export async function renderCategorias(user: DbUser, arg?: string): Promise<View> {
  const data = await collectReportData(user.id, user.name, arg);
  if (data.porCategoria.length === 0) {
    return { text: `📭 Sem gastos em ${b(data.periodo)}.`, kb: menuOnly() };
  }
  const linhas = data.porCategoria
    .slice(0, 10)
    .map(
      (c) =>
        `${textBar(c.pct)} ${categoryEmoji(c.categoria)} ${b(c.categoria)}\n   ${esc(fmtBRL(c.total))} · ${c.pct.toFixed(1)}%`,
    )
    .join("\n");
  const kb = new InlineKeyboard()
    .text("📈 Gráfico", `g:cat:${periodToken(arg)}`)
    .text("⚡ Resumo", "m:resumo");
  backRow(kb);
  return {
    text: `🍩 ${b(`Gastos por categoria — ${data.periodo}`)}\n\n${linhas}\n\n🔴 Total: ${esc(fmtBRL(data.totalSaidas))}`,
    kb,
  };
}

export async function renderExtrato(user: DbUser, arg?: string): Promise<View> {
  const n = Math.min(30, Math.max(1, Math.floor(Number((arg || "").trim())) || 10));
  const txs = await listRecentTransactions(user.id, n);
  if (txs.length === 0) return { text: "Sem lançamentos ainda.", kb: menuOnly() };
  const linhas = txs.map((t) => {
    const val = decToCents(t.amount);
    return (
      `${tipoSign(t.type)}${esc(fmtCents(val, t.currency))} · ${categoryEmoji(t.category)} ${esc(t.category)} · ${esc(t.account.name)}\n` +
      `   ${i(t.description || "—")} · ${esc(fmtDateTz(t.occurredAt))}`
    );
  });
  const kb = new InlineKeyboard().text("📅 Hoje", "m:hoje").text("⚡ Resumo", "m:resumo");
  backRow(kb);
  return { text: `🧾 ${b(`Últimos ${txs.length} lançamentos`)}\n\n${linhas.join("\n")}`, kb };
}

// -------------------- Metas --------------------

export async function renderMetas(user: DbUser): Promise<View> {
  const metas = await listBudgetsWithSpend(user.id);
  if (metas.length === 0) {
    const text =
      `🎯 ${b("Metas de gasto")}\n\n` +
      `Você ainda não definiu metas.\n\n` +
      `Defina um teto mensal por categoria:\n` +
      `${code("/meta Alimentação 800")}\n\n` +
      `Eu te aviso quando um gasto chegar perto do limite. 😉`;
    return { text, kb: menuOnly() };
  }
  const linhas = metas
    .map((m) => {
      const alerta = m.pct >= 100 ? " 🚨" : m.pct >= 80 ? " ⚠️" : "";
      return (
        `${textBar(m.pct)} ${categoryEmoji(m.category)} ${b(m.category)}${alerta}\n` +
        `   ${esc(fmtCents(m.spentCents))} de ${esc(fmtCents(m.amountCents))} · ${m.pct.toFixed(0)}%`
      );
    })
    .join("\n");
  const text =
    `🎯 ${b("Metas do mês")}\n\n${linhas}\n\n` +
    `Ajustar: ${code("/meta Categoria valor")} · remover com valor ${code("0")}.`;
  return { text, kb: menuOnly() };
}

// -------------------- Pessoas (owner) --------------------

export async function renderPessoas(user: DbUser): Promise<View> {
  if (!isOwner(user)) return { text: "🔒 Só o dono vê as pessoas." };
  const users = await listUsersWithAccountCounts();
  const lines = users.map((u) => {
    const badge = u.role === "owner" ? "👑" : u.active ? "👤" : "🚫";
    const status = u.active ? "" : ` ${i("(inativo)")}`;
    return `${badge} ${b(u.name || "sem nome")}${status}\n   id ${code(u.telegramId)} · ${u.accountCount} conta(s)`;
  });
  const text =
    `👥 ${b(`Pessoas no Fin AI (${users.length})`)}\n\n${lines.join("\n")}\n\n` +
    `Convidar: ${code("/convidar <id> <nome>")}\nRemover: ${code("/remover <id>")}`;
  return { text, kb: menuOnly() };
}

// -------------------- Helpers de view --------------------

function menuOnly() {
  return new InlineKeyboard().text("⬅️ Menu", "m:home");
}

/** Token curto e seguro de período para callback_data (respeita 64 bytes). */
export function periodToken(arg?: string): string {
  const a = (arg || "mes").trim().toLowerCase();
  return /^(hoje|ontem|semana|mes|mes-anterior|\d{4}-\d{2})$/.test(a) ? a : "mes";
}

/** Cabeçalho de KPIs (HTML), reutilizado por /resumo e /hoje. */
export function resumoHeader(d: ReportData): string {
  const icon = d.resultado >= 0 ? "📈" : "📉";
  return (
    `📊 ${b(d.periodo)}\n` +
    `🟢 Entradas: ${esc(fmtBRL(d.totalEntradas))}\n` +
    `🔴 Saídas: ${esc(fmtBRL(d.totalSaidas))}\n` +
    `${icon} Resultado: ${b(fmtBRL(d.resultado))}`
  );
}

/** Linha extra quando há mais de uma moeda no período. */
function multiMoedaLinha(d: ReportData): string {
  if (d.porMoeda.length <= 1) return "";
  const extras = d.porMoeda
    .filter((m) => m.currency !== d.moedaPrincipal)
    .map((m) => `${esc(m.currency)}: ${esc(fmtBRL(m.resultado, m.currency))}`)
    .join(" · ");
  return extras ? `\n\n💱 Outras moedas: ${extras}` : "";
}
