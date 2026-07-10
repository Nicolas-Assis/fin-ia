import ExcelJS from "exceljs";
import { prisma } from "./db.js";
import { balances, listAccounts } from "./transactions.js";

const MONEY_FMT = '"R$" #,##0.00;[Red]-"R$" #,##0.00';

/** Dados agregados de um período — base para o .xlsx e para o relatório HTML. */
export interface ReportData {
  owner: string; // nome da pessoa dona do relatório
  from: Date;
  to: Date;
  periodo: string;
  totalEntradas: number;
  totalSaidas: number;
  resultado: number;
  countEntradas: number;
  countSaidas: number;
  countTx: number;
  ticketMedioSaida: number;
  maiorGasto: number;
  taxaPoupanca: number; // % do que entrou que sobrou
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

/** Resolve o intervalo a partir de um argumento: "mes" | "semana" | "hoje" | "YYYY-MM" | vazio */
export function resolvePeriod(arg?: string): { from: Date; to: Date; label: string } {
  const now = new Date();
  const a = (arg || "").trim().toLowerCase();

  if (/^\d{4}-\d{2}$/.test(a)) {
    const [y, m] = a.split("-").map(Number);
    const from = new Date(y, m - 1, 1);
    const to = new Date(y, m, 0, 23, 59, 59);
    return { from, to, label: a };
  }
  if (a === "hoje") {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    return { from, to, label: "hoje" };
  }
  if (a === "semana") {
    const from = new Date(now);
    from.setDate(now.getDate() - 7);
    return { from, to: now, label: "últimos 7 dias" };
  }
  // padrão: mês corrente
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  const label = now.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  return { from, to, label };
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Coleta e agrega tudo que os relatórios precisam (escopo: um usuário). */
export async function collectReportData(
  userId: string,
  userName: string,
  arg?: string,
): Promise<ReportData> {
  const { from, to, label } = resolvePeriod(arg);

  const [txs, accs, saldosRaw] = await Promise.all([
    prisma.transaction.findMany({
      where: { occurredAt: { gte: from, lte: to }, account: { userId } },
      include: { account: true },
      orderBy: { occurredAt: "asc" },
    }),
    listAccounts(userId),
    balances(userId),
  ]);

  const typeByName = new Map(accs.map((a) => [a.name, a.type]));

  let totalEntradas = 0;
  let totalSaidas = 0;
  let countEntradas = 0;
  let countSaidas = 0;
  let maiorGasto = 0;
  const porCatMap = new Map<string, { total: number; count: number }>();
  const porContaMap = new Map<string, { entrada: number; saida: number }>();
  const dailyMap = new Map<string, { entrada: number; saida: number }>();

  const txsMapped = txs.map((t) => {
    const val = Number(t.amount);
    const key = dayKey(t.occurredAt);
    const dd = dailyMap.get(key) ?? { entrada: 0, saida: 0 };
    const pc = porContaMap.get(t.account.name) ?? { entrada: 0, saida: 0 };

    if (t.type === "entrada") {
      totalEntradas += val;
      countEntradas++;
      dd.entrada += val;
      pc.entrada += val;
    } else {
      totalSaidas += val;
      countSaidas++;
      maiorGasto = Math.max(maiorGasto, val);
      dd.saida += val;
      pc.saida += val;
      const cat = porCatMap.get(t.category) ?? { total: 0, count: 0 };
      cat.total += val;
      cat.count++;
      porCatMap.set(t.category, cat);
    }
    dailyMap.set(key, dd);
    porContaMap.set(t.account.name, pc);

    return {
      data: t.occurredAt,
      tipo: t.type,
      valor: val,
      conta: t.account.name,
      categoria: t.category,
      descricao: t.description,
      origem: t.source,
    };
  });

  const porCategoria = [...porCatMap.entries()]
    .map(([categoria, v]) => ({
      categoria,
      total: v.total,
      count: v.count,
      pct: totalSaidas > 0 ? (v.total / totalSaidas) * 100 : 0,
    }))
    .sort((x, y) => y.total - x.total);

  const porConta = [...porContaMap.entries()]
    .map(([name, v]) => ({ name, entrada: v.entrada, saida: v.saida }))
    .sort((x, y) => y.saida - x.saida);

  // Série diária contínua (preenche dias sem lançamento) — limitada para não explodir o SVG.
  const daily: { date: string; entrada: number; saida: number }[] = [];
  const dayMs = 86400000;
  let cur = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (cur <= end && daily.length < 120) {
    const key = dayKey(cur);
    const v = dailyMap.get(key) ?? { entrada: 0, saida: 0 };
    daily.push({ date: key, entrada: v.entrada, saida: v.saida });
    cur = new Date(cur.getTime() + dayMs);
  }

  const topGastos = txsMapped
    .filter((t) => t.tipo === "saida")
    .sort((a, b) => b.valor - a.valor)
    .slice(0, 8)
    .map((t) => ({
      descricao: t.descricao,
      categoria: t.categoria,
      valor: t.valor,
      conta: t.conta,
      data: t.data,
    }));

  const saldos = saldosRaw.map((s) => ({
    name: s.name,
    currency: s.currency,
    balance: s.balance,
    type: typeByName.get(s.name) || "corrente",
  }));

  const resultado = totalEntradas - totalSaidas;

  return {
    owner: userName,
    from,
    to,
    periodo: label,
    totalEntradas,
    totalSaidas,
    resultado,
    countEntradas,
    countSaidas,
    countTx: txsMapped.length,
    ticketMedioSaida: countSaidas > 0 ? totalSaidas / countSaidas : 0,
    maiorGasto,
    taxaPoupanca: totalEntradas > 0 ? (resultado / totalEntradas) * 100 : 0,
    porCategoria,
    porConta,
    saldos,
    saldoTotal: saldos.reduce((s, r) => s + r.balance, 0),
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
  const filename = `relatorio-${data.from.toISOString().slice(0, 10)}_a_${data.to
    .toISOString()
    .slice(0, 10)}.xlsx`;

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
