import { chat } from "./llm.js";
import { collectReportData, type ReportData } from "./report.js";
import { normalizeCategory } from "./categories.js";
import { dayKeyTz } from "./dates.js";
import type { QueryPlan } from "./intents.js";

/**
 * Q&A em linguagem natural com dados REAIS do usuário. O contexto é uma
 * projeção compacta (agregados + até 30 transações filtradas) — nunca o
 * array inteiro — para manter custo/latência sob controle.
 */

const MAX_TXS = 30;

function compactContext(d: ReportData, plan: QueryPlan) {
  const catFilter = plan.categorias?.map((c) => normalizeCategory(c)) ?? null;
  const contaFilter = plan.contas?.map((c) => c.toLowerCase()) ?? null;

  let txs = d.txs;
  if (catFilter) txs = txs.filter((t) => catFilter.includes(normalizeCategory(t.categoria)));
  if (contaFilter)
    txs = txs.filter((t) => contaFilter.some((c) => t.conta.toLowerCase().includes(c)));
  // Mais recentes primeiro; limite duro.
  const compactTxs = [...txs]
    .reverse()
    .slice(0, MAX_TXS)
    .map((t) => [
      dayKeyTz(t.data),
      t.tipo,
      t.valor,
      t.categoria,
      t.conta,
      (t.descricao || "").slice(0, 40),
    ]);

  return {
    periodo: d.periodo,
    de: dayKeyTz(d.from),
    ate: dayKeyTz(d.to),
    totalEntradas: d.totalEntradas,
    totalSaidas: d.totalSaidas,
    resultado: d.resultado,
    taxaPoupancaPct: Math.round(d.taxaPoupanca),
    ticketMedioSaida: d.ticketMedioSaida,
    maiorGasto: d.maiorGasto,
    lancamentos: d.countTx,
    porCategoria: d.porCategoria.slice(0, 12).map((c) => ({
      categoria: c.categoria,
      total: c.total,
      pct: Math.round(c.pct),
      count: c.count,
    })),
    porConta: d.porConta,
    topGastos: d.topGastos.slice(0, 5).map((t) => ({
      descricao: t.descricao.slice(0, 40),
      categoria: t.categoria,
      valor: t.valor,
    })),
    saldos: d.saldos,
    saldoTotal: d.saldoTotal,
    ...(catFilter || contaFilter
      ? { transacoesFiltradas: compactTxs, filtro: { categorias: catFilter, contas: plan.contas } }
      : { transacoesRecentes: compactTxs }),
  };
}

const QA_SYSTEM = `Você é o Fin AI, assistente de finanças pessoais (português do Brasil).
Responda a pergunta do usuário usando SOMENTE os dados JSON fornecidos (dados do próprio usuário).
Regras:
- Direto e curto: 1 a 4 frases. Formate valores como R$ 1.234,56.
- Ao comparar períodos, informe a diferença em valor e em %.
- Se os dados não permitirem responder, diga isso e sugira /extrato ou /relatorio.
- Nunca invente números. Não mencione JSON, campos ou termos técnicos.
- No máximo 1 emoji.`;

export async function answerQuestion(
  userId: string,
  userName: string,
  pergunta: string,
  plan: QueryPlan,
): Promise<string> {
  const periodos = plan.periodos.slice(0, 2);
  const contexts = await Promise.all(
    periodos.map(async (p) => compactContext(await collectReportData(userId, userName, p), plan)),
  );

  const dados = contexts.length === 1 ? contexts[0] : { periodos: contexts };
  const raw = await chat(
    [
      { role: "system", content: QA_SYSTEM },
      {
        role: "user",
        content: `Pergunta: ${pergunta}\n\nDados:\n${JSON.stringify(dados)}`,
      },
    ],
    { temperature: 0.3, maxTokens: 300, timeoutMs: 10_000 },
  );
  return raw.trim();
}
