import ExcelJS from "exceljs";
import { prisma } from "./db.js";
import { balances } from "./transactions.js";

const MONEY_FMT = '"R$" #,##0.00;[Red]-"R$" #,##0.00';

export interface ReportResult {
  buffer: Buffer;
  filename: string;
  stats: {
    periodo: string;
    totalEntradas: number;
    totalSaidas: number;
    resultado: number;
    porCategoria: { categoria: string; total: number }[];
    saldos: { name: string; balance: number }[];
  };
}

/** Resolve o intervalo a partir de um argumento: "mes" | "semana" | "YYYY-MM" | vazio */
export function resolvePeriod(arg?: string): { from: Date; to: Date; label: string } {
  const now = new Date();
  const a = (arg || "").trim().toLowerCase();

  if (/^\d{4}-\d{2}$/.test(a)) {
    const [y, m] = a.split("-").map(Number);
    const from = new Date(y, m - 1, 1);
    const to = new Date(y, m, 0, 23, 59, 59);
    return { from, to, label: a };
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

export async function buildReport(arg?: string): Promise<ReportResult> {
  const { from, to, label } = resolvePeriod(arg);

  const txs = await prisma.transaction.findMany({
    where: { occurredAt: { gte: from, lte: to } },
    include: { account: true },
    orderBy: { occurredAt: "asc" },
  });

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

  let totalEntradas = 0;
  let totalSaidas = 0;
  const porCatMap = new Map<string, number>();

  for (const t of txs) {
    const val = Number(t.amount);
    if (t.type === "entrada") totalEntradas += val;
    else {
      totalSaidas += val;
      porCatMap.set(t.category, (porCatMap.get(t.category) || 0) + val);
    }
    ws.addRow({
      data: t.occurredAt,
      tipo: t.type,
      valor: t.type === "saida" ? -val : val,
      conta: t.account.name,
      categoria: t.category,
      descricao: t.description,
      origem: t.source,
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
  rs.addRow({ k: "Período", v: label });
  rs.addRow({ k: "Total de entradas", v: totalEntradas });
  rs.addRow({ k: "Total de saídas", v: totalSaidas });
  rs.addRow({ k: "Resultado do período", v: totalEntradas - totalSaidas });
  rs.getCell("B3").numFmt = MONEY_FMT;
  rs.getCell("B4").numFmt = MONEY_FMT;
  rs.getCell("B5").numFmt = MONEY_FMT;

  rs.addRow({});
  const catHeader = rs.addRow({ k: "Gastos por categoria", v: "" });
  catHeader.font = { bold: true };
  const porCategoria = [...porCatMap.entries()]
    .map(([categoria, total]) => ({ categoria, total }))
    .sort((x, y) => y.total - x.total);
  for (const c of porCategoria) {
    const r = rs.addRow({ k: c.categoria, v: c.total });
    r.getCell("v").numFmt = MONEY_FMT;
  }

  rs.addRow({});
  const balHeader = rs.addRow({ k: "Saldo por conta (geral)", v: "" });
  balHeader.font = { bold: true };
  const saldos = await balances();
  for (const b of saldos) {
    const r = rs.addRow({ k: b.name, v: b.balance });
    r.getCell("v").numFmt = MONEY_FMT;
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const filename = `relatorio-${from.toISOString().slice(0, 10)}_a_${to
    .toISOString()
    .slice(0, 10)}.xlsx`;

  return {
    buffer,
    filename,
    stats: {
      periodo: label,
      totalEntradas,
      totalSaidas,
      resultado: totalEntradas - totalSaidas,
      porCategoria,
      saldos: saldos.map((s) => ({ name: s.name, balance: s.balance })),
    },
  };
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
