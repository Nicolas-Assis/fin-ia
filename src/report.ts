import ExcelJS from "exceljs";
import { prisma } from "./db.js";
import { balances } from "./transactions.js";
import { dayKeyTz, resolvePeriod } from "./dates.js";
import { decToCents } from "./money.js";

const MONEY_FMT = '"R$" #,##0.00;[Red]-"R$" #,##0.00';

/**
 * Dados agregados de um período — base para o .xlsx, o relatório HTML, o
 * /resumo e o Q&A. Valores expostos em REAIS (number), mas toda a acumulação
 * interna é feita em centavos inteiros para não somar floats.
 * KPIs de fluxo (totais, categorias, daily, topGastos) consideram apenas a
 * `moedaPrincipal`; moedas extras aparecem em `porMoeda`/`saldoPorMoeda`.
 */
export interface ReportData {
  owner: string;
  from: Date;
  to: Date; // último instante DENTRO do período (exibição)
  periodo: string;
  totalEntradas: number;
  totalSaidas: number;
  resultado: number;
  countEntradas: number;
  countSaidas: number;
  countTx: number;
  ticketMedioSaida: number;
  maiorGasto: number;
  taxaPoupanca: number;
  moedaPrincipal: string;
  porMoeda: { currency: string; entradas: number; saidas: number; resultado: number }[];
  saldoPorMoeda: { currency: string; total: number }[];
  porCategoria: { categoria: string; total: number; pct: number; count: number }[];
  porConta: { name: string; entrada: number; saida: number }[];
  saldos: { name: string; currency: string; balance: number; type: string }[];
  saldoTotal: number;
  daily: { date: string; entrada: number; saida: number }[];
  topGastos: {
    descricao: string;
    categoria: string;
    valor: number;
    conta: string;
    data: Date;
  }[];
  txs: {
    data: Date;
    tipo: string;
    valor: number;
    moeda: string;
    conta: string;
    categoria: string;
    descricao: string;
    origem: string;
  }[];
}

export interface ReportResult {
  buffer: Buffer;
  filename: string;
  stats: ReportData;
}

/** Coleta e agrega tudo que os relatórios precisam (escopo: um usuário). */
export async function collectReportData(
  userId: string,
  userName: string,
  arg?: string,
): Promise<ReportData> {
  const { from, toExclusive, label } = resolvePeriod(arg);

  const [txs, saldosRows] = await Promise.all([
    prisma.transaction.findMany({
      where: { occurredAt: { gte: from, lt: toExclusive }, account: { userId } },
      include: { account: true },
      orderBy: { occurredAt: "asc" },
    }),
    balances(userId),
  ]);

  // Moeda principal = a com mais lançamentos no período; sem lançamentos, a da
  // primeira conta; sem contas, BRL.
  const txCountByCurrency = new Map<string, number>();
  for (const t of txs) {
    const cur = t.currency || t.account.currency || "BRL";
    txCountByCurrency.set(cur, (txCountByCurrency.get(cur) ?? 0) + 1);
  }
  const moedaPrincipal =
    [...txCountByCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ||
    saldosRows[0]?.currency ||
    "BRL";

  let totalEntradasC = 0;
  let totalSaidasC = 0;
  let countEntradas = 0;
  let countSaidas = 0;
  let maiorGastoC = 0;
  const porCatMap = new Map<string, { totalC: number; count: number }>();
  const porContaMap = new Map<string, { entradaC: number; saidaC: number }>();
  const dailyMap = new Map<string, { entradaC: number; saidaC: number }>();
  const porMoedaMap = new Map<string, { entradasC: number; saidasC: number }>();

  const txsMapped = txs.map((t) => {
    const cents = decToCents(t.amount);
    const moeda = t.currency || t.account.currency || "BRL";

    const pm = porMoedaMap.get(moeda) ?? { entradasC: 0, saidasC: 0 };
    if (t.type === "entrada") pm.entradasC += cents;
    else pm.saidasC += cents;
    porMoedaMap.set(moeda, pm);

    // KPIs/séries: só a moeda principal (somar USD com BRL não faz sentido).
    if (moeda === moedaPrincipal) {
      const key = dayKeyTz(t.occurredAt);
      const dd = dailyMap.get(key) ?? { entradaC: 0, saidaC: 0 };
      const pc = porContaMap.get(t.account.name) ?? { entradaC: 0, saidaC: 0 };
      if (t.type === "entrada") {
        totalEntradasC += cents;
        countEntradas++;
        dd.entradaC += cents;
        pc.entradaC += cents;
      } else {
        totalSaidasC += cents;
        countSaidas++;
        maiorGastoC = Math.max(maiorGastoC, cents);
        dd.saidaC += cents;
        pc.saidaC += cents;
        const cat = porCatMap.get(t.category) ?? { totalC: 0, count: 0 };
        cat.totalC += cents;
        cat.count++;
        porCatMap.set(t.category, cat);
      }
      dailyMap.set(key, dd);
      porContaMap.set(t.account.name, pc);
    }

    return {
      data: t.occurredAt,
      tipo: t.type,
      valor: cents / 100,
      moeda,
      conta: t.account.name,
      categoria: t.category,
      descricao: t.description,
      origem: t.source,
    };
  });

  const porCategoria = [...porCatMap.entries()]
    .map(([categoria, v]) => ({
      categoria,
      total: v.totalC / 100,
      count: v.count,
      pct: totalSaidasC > 0 ? (v.totalC / totalSaidasC) * 100 : 0,
    }))
    .sort((x, y) => y.total - x.total);

  const porConta = [...porContaMap.entries()]
    .map(([name, v]) => ({ name, entrada: v.entradaC / 100, saida: v.saidaC / 100 }))
    .sort((x, y) => y.saida - x.saida);

  // Série diária contínua no fuso local. `from` é meia-noite local; somar 24h
  // mantém o mesmo horário local (America/Sao_Paulo não tem DST desde 2019).
  const daily: { date: string; entrada: number; saida: number }[] = [];
  for (
    let t = from.getTime();
    t < toExclusive.getTime() && daily.length < 120;
    t += 86_400_000
  ) {
    const key = dayKeyTz(new Date(t));
    const v = dailyMap.get(key) ?? { entradaC: 0, saidaC: 0 };
    daily.push({ date: key, entrada: v.entradaC / 100, saida: v.saidaC / 100 });
  }

  const topGastos = txsMapped
    .filter((t) => t.tipo === "saida" && t.moeda === moedaPrincipal)
    .sort((a, b) => b.valor - a.valor)
    .slice(0, 8)
    .map((t) => ({
      descricao: t.descricao,
      categoria: t.categoria,
      valor: t.valor,
      conta: t.conta,
      data: t.data,
    }));

  const saldos = saldosRows.map((s) => ({
    name: s.name,
    currency: s.currency,
    balance: s.balanceCents / 100,
    type: s.type,
  }));

  const saldoPorMoedaMap = new Map<string, number>();
  for (const s of saldosRows) {
    saldoPorMoedaMap.set(
      s.currency,
      (saldoPorMoedaMap.get(s.currency) ?? 0) + s.balanceCents,
    );
  }
  const saldoPorMoeda = [...saldoPorMoedaMap.entries()].map(
    ([currency, cents]) => ({ currency, total: cents / 100 }),
  );

  const porMoeda = [...porMoedaMap.entries()].map(([currency, v]) => ({
    currency,
    entradas: v.entradasC / 100,
    saidas: v.saidasC / 100,
    resultado: (v.entradasC - v.saidasC) / 100,
  }));

  const resultadoC = totalEntradasC - totalSaidasC;

  return {
    owner: userName,
    from,
    to: new Date(toExclusive.getTime() - 1000),
    periodo: label,
    totalEntradas: totalEntradasC / 100,
    totalSaidas: totalSaidasC / 100,
    resultado: resultadoC / 100,
    countEntradas,
    countSaidas,
    countTx: txsMapped.length,
    ticketMedioSaida: countSaidas > 0 ? totalSaidasC / countSaidas / 100 : 0,
    maiorGasto: maiorGastoC / 100,
    taxaPoupanca: totalEntradasC > 0 ? (resultadoC / totalEntradasC) * 100 : 0,
    moedaPrincipal,
    porMoeda,
    saldoPorMoeda,
    porCategoria,
    porConta,
    saldos,
    saldoTotal:
      (saldoPorMoedaMap.get(moedaPrincipal) ?? 0) / 100,
    daily,
    topGastos,
    txs: txsMapped,
  };
}

/** Relatório em planilha .xlsx (gerado em memória). */
export async function buildReport(
  userId: string,
  userName: string,
  arg?: string,
): Promise<ReportResult> {
  const data = await collectReportData(userId, userName, arg);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Fin AI";
  wb.created = new Date();

  // ---------- Aba: Transações ----------
  const ws = wb.addWorksheet("Transações", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  ws.columns = [
    { header: "Data", key: "data", width: 18 },
    { header: "Tipo", key: "tipo", width: 10 },
    { header: "Valor", key: "valor", width: 14 },
    { header: "Moeda", key: "moeda", width: 8 },
    { header: "Conta", key: "conta", width: 18 },
    { header: "Categoria", key: "categoria", width: 18 },
    { header: "Descrição", key: "descricao", width: 34 },
    { header: "Origem", key: "origem", width: 10 },
  ];
  styleHeader(ws.getRow(1));

  for (const t of data.txs) {
    ws.addRow({
      data: t.data,
      tipo: t.tipo,
      valor: t.tipo === "saida" ? -t.valor : t.valor,
      moeda: t.moeda,
      conta: t.conta,
      categoria: t.categoria,
      descricao: t.descricao,
      origem: t.origem,
    });
  }
  ws.getColumn("data").numFmt = "dd/mm/yyyy hh:mm";
  ws.getColumn("valor").numFmt = MONEY_FMT;

  // ---------- Aba: Resumo ----------
  const rs = wb.addWorksheet("Resumo");
  rs.columns = [
    { header: "Indicador", key: "k", width: 26 },
    { header: "Valor", key: "v", width: 18 },
  ];
  styleHeader(rs.getRow(1));
  rs.addRow({ k: "Período", v: data.periodo });
  rs.addRow({ k: "Total de entradas", v: data.totalEntradas });
  rs.addRow({ k: "Total de saídas", v: data.totalSaidas });
  rs.addRow({ k: "Resultado do período", v: data.resultado });
  rs.getCell("B3").numFmt = MONEY_FMT;
  rs.getCell("B4").numFmt = MONEY_FMT;
  rs.getCell("B5").numFmt = MONEY_FMT;

  if (data.porMoeda.length > 1) {
    rs.addRow({});
    const moedaHeader = rs.addRow({ k: "Por moeda (entradas − saídas)", v: "" });
    moedaHeader.font = { bold: true };
    for (const m of data.porMoeda) {
      rs.addRow({
        k: m.currency,
        v: `${m.entradas.toFixed(2)} − ${m.saidas.toFixed(2)} = ${m.resultado.toFixed(2)}`,
      });
    }
  }

  rs.addRow({});
  const catHeader = rs.addRow({ k: "Gastos por categoria", v: "" });
  catHeader.font = { bold: true };
  for (const c of data.porCategoria) {
    const r = rs.addRow({ k: c.categoria, v: c.total });
    r.getCell("v").numFmt = MONEY_FMT;
  }

  rs.addRow({});
  const balHeader = rs.addRow({ k: "Saldo por conta (geral)", v: "" });
  balHeader.font = { bold: true };
  for (const b of data.saldos) {
    const r = rs.addRow({ k: b.name, v: b.balance });
    r.getCell("v").numFmt = MONEY_FMT;
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const filename = `relatorio-${dayKeyTz(data.from)}_a_${dayKeyTz(data.to)}.xlsx`;

  return { buffer, filename, stats: data };
}

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F2937" },
  };
  row.alignment = { vertical: "middle" };
}
