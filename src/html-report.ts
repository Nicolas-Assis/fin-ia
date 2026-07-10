import type { ReportData } from "./report.js";
import { fmtBRL } from "./transactions.js";

/**
 * Gera um relatório HTML autocontido (CSS e gráficos SVG inline, zero dependências
 * externas) — bonito no navegador, no celular e na impressão. Serve tanto para enviar
 * como documento no Telegram quanto para hospedar em GET /api/report.
 */

// Paleta categórica curada (donut + legendas): harmoniza com o acento dourado
// e mantém matizes bem distintos entre si, sem liderar pelo indigo/roxo genérico.
const CAT_COLORS = [
  "#0f766e", "#c98a1a", "#b03a5b", "#3b6ea5", "#7c6cc4",
  "#2f9e7d", "#d1743c", "#9c5c8f", "#4b8bbd", "#8a9a2b",
  "#c0526b", "#557a8f",
];

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(d: Date): string {
  return new Date(d).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function fmtDateTime(d: Date): string {
  return new Date(d).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const ACCOUNT_ICON: Record<string, string> = {
  cartao: "💳",
  corrente: "🏦",
  poupanca: "🐷",
  dinheiro: "💵",
  cripto: "₿",
};

// ---------------------------------------------------------------- Gráfico donut
function donutSvg(data: ReportData): string {
  const cats = data.porCategoria.slice(0, 8);
  const outros = data.porCategoria.slice(8).reduce((s, c) => s + c.total, 0);
  const segments = cats.map((c, i) => ({
    label: c.categoria,
    value: c.total,
    color: CAT_COLORS[i % CAT_COLORS.length],
  }));
  if (outros > 0) {
    segments.push({ label: "Outros", value: outros, color: "#94a3b8" });
  }

  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return "";

  const r = 70;
  const cx = 90;
  const cy = 90;
  const circ = 2 * Math.PI * r;
  let offset = 0;

  const arcs = segments
    .map((seg) => {
      const frac = seg.value / total;
      const dash = frac * circ;
      const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="26" stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"><title>${esc(seg.label)}: ${esc(fmtBRL(seg.value))}</title></circle>`;
      offset += dash;
      return el;
    })
    .join("");

  const legend = segments
    .map(
      (seg) =>
        `<li><span class="dot" style="background:${seg.color}"></span>` +
        `<span class="lg-name">${esc(seg.label)}</span>` +
        `<span class="lg-val">${esc(fmtBRL(seg.value))}</span>` +
        `<span class="lg-pct">${((seg.value / total) * 100).toFixed(1)}%</span></li>`,
    )
    .join("");

  return `
  <div class="donut-wrap">
    <svg viewBox="0 0 180 180" width="180" height="180" role="img" aria-label="Gastos por categoria">
      ${arcs}
      <text x="90" y="84" text-anchor="middle" class="donut-total">${esc(fmtBRL(total))}</text>
      <text x="90" y="104" text-anchor="middle" class="donut-cap">em saídas</text>
    </svg>
    <ul class="legend">${legend}</ul>
  </div>`;
}

// ---------------------------------------------------------------- Gráfico barras
function barsSvg(data: ReportData): string {
  const days = data.daily;
  if (days.length === 0) return "";
  const max = Math.max(1, ...days.map((d) => Math.max(d.entrada, d.saida)));

  const groupW = days.length > 45 ? 12 : days.length > 20 ? 20 : 34;
  const barW = Math.max(3, (groupW - 6) / 2);
  const chartH = 170;
  const padTop = 12;
  const padBottom = 26;
  const width = Math.max(320, days.length * groupW + 20);
  const height = chartH + padTop + padBottom;
  const baseY = padTop + chartH;

  // linhas de grade (3 níveis)
  const grid = [0.25, 0.5, 0.75, 1]
    .map((f) => {
      const y = baseY - f * chartH;
      return `<line x1="0" y1="${y.toFixed(1)}" x2="${width}" y2="${y.toFixed(1)}" class="grid"/>`;
    })
    .join("");

  const bars = days
    .map((d, i) => {
      const x = 12 + i * groupW;
      const he = (d.entrada / max) * chartH;
      const hs = (d.saida / max) * chartH;
      const dayNum = Number(d.date.slice(8, 10));
      const showLabel =
        days.length <= 16 || i % Math.ceil(days.length / 16) === 0;
      const label = showLabel
        ? `<text x="${(x + barW).toFixed(1)}" y="${height - 8}" text-anchor="middle" class="axis">${dayNum}</text>`
        : "";
      const eBar =
        d.entrada > 0
          ? `<rect x="${x.toFixed(1)}" y="${(baseY - he).toFixed(1)}" width="${barW.toFixed(1)}" height="${he.toFixed(1)}" rx="2" class="bar-in"><title>${esc(fmtDate(new Date(d.date + "T12:00:00")))} · Entrou ${esc(fmtBRL(d.entrada))}</title></rect>`
          : "";
      const sBar =
        d.saida > 0
          ? `<rect x="${(x + barW + 2).toFixed(1)}" y="${(baseY - hs).toFixed(1)}" width="${barW.toFixed(1)}" height="${hs.toFixed(1)}" rx="2" class="bar-out"><title>${esc(fmtDate(new Date(d.date + "T12:00:00")))} · Saiu ${esc(fmtBRL(d.saida))}</title></rect>`
          : "";
      return eBar + sBar + label;
    })
    .join("");

  return `
  <div class="chart-legend">
    <span><i class="sw sw-in"></i> Entradas</span>
    <span><i class="sw sw-out"></i> Saídas</span>
  </div>
  <div class="bars-scroll">
    <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Fluxo diário">
      ${grid}
      <line x1="0" y1="${baseY}" x2="${width}" y2="${baseY}" class="axis-line"/>
      ${bars}
    </svg>
  </div>`;
}

// ---------------------------------------------------------------- KPI cards
function kpiCards(data: ReportData): string {
  const resClass = data.resultado >= 0 ? "pos" : "neg";
  const resSign = data.resultado >= 0 ? "Sobrou" : "Faltou";
  const cards = [
    {
      icon: "🟢",
      label: "Entradas",
      value: fmtBRL(data.totalEntradas),
      sub: `${data.countEntradas} lançamento(s)`,
      cls: "in",
    },
    {
      icon: "🔴",
      label: "Saídas",
      value: fmtBRL(data.totalSaidas),
      sub: `${data.countSaidas} lançamento(s)`,
      cls: "out",
    },
    {
      icon: data.resultado >= 0 ? "📈" : "📉",
      label: "Resultado",
      value: fmtBRL(data.resultado),
      sub: `${resSign} • poupança ${data.taxaPoupanca.toFixed(0)}%`,
      cls: resClass,
    },
    {
      icon: "💼",
      label: "Saldo total",
      value: fmtBRL(data.saldoTotal),
      sub: `${data.saldos.length} conta(s)`,
      cls: "neutral",
    },
  ];
  return cards
    .map(
      (c) => `
    <div class="kpi kpi-${c.cls}">
      <div class="kpi-icon">${c.icon}</div>
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value">${esc(c.value)}</div>
      <div class="kpi-sub">${esc(c.sub)}</div>
    </div>`,
    )
    .join("");
}

// ---------------------------------------------------------------- Saldos por conta
function accountCards(data: ReportData): string {
  if (data.saldos.length === 0) return "";
  const cards = data.saldos
    .map((s) => {
      const icon = ACCOUNT_ICON[s.type] || "🏦";
      const cls = s.balance >= 0 ? "pos" : "neg";
      return `
      <div class="acc-card">
        <div class="acc-top"><span class="acc-icon">${icon}</span><span class="acc-name">${esc(s.name)}</span></div>
        <div class="acc-bal ${cls}">${esc(fmtBRL(s.balance, s.currency))}</div>
        <div class="acc-type">${esc(s.type)}</div>
      </div>`;
    })
    .join("");
  return `<div class="acc-grid">${cards}</div>`;
}

// ---------------------------------------------------------------- Maiores gastos
function topGastos(data: ReportData): string {
  if (data.topGastos.length === 0) return "";
  const rows = data.topGastos
    .map(
      (t, i) => `
      <li>
        <span class="rank">${i + 1}</span>
        <span class="tg-info">
          <span class="tg-desc">${esc(t.descricao || t.categoria)}</span>
          <span class="tg-meta">${esc(t.categoria)} · ${esc(t.conta)} · ${esc(fmtDate(t.data))}</span>
        </span>
        <span class="tg-val">${esc(fmtBRL(t.valor))}</span>
      </li>`,
    )
    .join("");
  return `<ol class="top-list">${rows}</ol>`;
}

// ---------------------------------------------------------------- Categorias (barras)
function categoryBars(data: ReportData): string {
  if (data.porCategoria.length === 0) return "";
  const rows = data.porCategoria
    .slice(0, 12)
    .map((c, i) => {
      const color = CAT_COLORS[i % CAT_COLORS.length];
      return `
      <div class="catbar-row">
        <div class="catbar-head">
          <span class="catbar-name"><span class="dot" style="background:${color}"></span>${esc(c.categoria)}</span>
          <span class="catbar-val">${esc(fmtBRL(c.total))} <em>${c.pct.toFixed(1)}%</em></span>
        </div>
        <div class="catbar-track"><div class="catbar-fill" style="width:${Math.max(2, c.pct).toFixed(1)}%;background:${color}"></div></div>
      </div>`;
    })
    .join("");
  return `<div class="catbars">${rows}</div>`;
}

// ---------------------------------------------------------------- Extrato
function txTable(data: ReportData): string {
  if (data.txs.length === 0) return "";
  const rows = [...data.txs]
    .reverse()
    .slice(0, 200)
    .map((t) => {
      const isOut = t.tipo === "saida";
      const cls = isOut ? "neg" : "pos";
      const sign = isOut ? "-" : "+";
      return `
      <tr>
        <td class="c-date">${esc(fmtDateTime(t.data))}</td>
        <td><span class="pill ${cls}">${isOut ? "Saída" : "Entrada"}</span></td>
        <td>${esc(t.descricao || "—")}</td>
        <td class="c-cat">${esc(t.categoria)}</td>
        <td class="c-acc">${esc(t.conta)}</td>
        <td class="c-val ${cls}">${sign} ${esc(fmtBRL(t.valor))}</td>
      </tr>`;
    })
    .join("");
  const more =
    data.txs.length > 200
      ? `<p class="muted small">Mostrando os 200 lançamentos mais recentes de ${data.txs.length}.</p>`
      : "";
  return `
  <div class="table-scroll">
    <table class="tx">
      <thead>
        <tr><th>Data</th><th>Tipo</th><th>Descrição</th><th>Categoria</th><th>Conta</th><th class="c-val">Valor</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>${more}`;
}

function section(title: string, body: string): string {
  if (!body) return "";
  return `
  <section class="card">
    <div class="sec-head"><span class="sec-tick"></span><h2>${esc(title)}</h2></div>
    ${body}
  </section>`;
}

// ---------------------------------------------------------------- Documento
export function buildHtmlReport(data: ReportData, summary?: string): string {
  const geradoEm = fmtDateTime(new Date());
  const empty = data.countTx === 0;

  const summaryBlock =
    summary && summary.trim()
      ? `<div class="ai-card"><div class="ai-icon">🧠</div><div><div class="ai-title">Análise da IA</div><p>${esc(summary.trim())}</p></div></div>`
      : "";

  const emptyState = empty
    ? `<section class="card empty"><div class="empty-emoji">🗂️</div><h2>Sem lançamentos no período</h2><p class="muted">Registre gastos e recebimentos no Telegram e gere o relatório novamente.</p></section>`
    : "";

  const body = empty
    ? emptyState
    : `
    ${summaryBlock}
    <div class="kpi-grid">${kpiCards(data)}</div>
    ${section("Fluxo diário", barsSvg(data))}
    ${section("Gastos por categoria", donutSvg(data))}
    ${section("Detalhe por categoria", categoryBars(data))}
    ${section("Saldos por conta", accountCards(data))}
    ${section("Maiores gastos", topGastos(data))}
    ${section("Extrato", txTable(data))}
  `;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fin AI — Relatório ${esc(data.owner ? data.owner + " · " : "")}${esc(data.periodo)}</title>
<style>
  /* Identidade "tinta & ouro": neutros com leve viés quente, acento dourado
     (distinto do verde/vermelho semântico de entradas/saídas). */
  :root{
    color-scheme:light dark;
    --bg:#faf8f3; --bg2:#f2ede3; --card:#ffffff; --card2:#faf7f1;
    --text:#161a1f; --muted:#5f6b76; --line:#e9e2d4;
    --in:#15803d; --out:#c92f42; --accent:#a9791b; --accent-ink:#7a560f;
    --accent-soft:rgba(169,121,27,.10);
    --pos:#15803d; --neg:#c92f42;
    --shadow:0 6px 22px rgba(22,26,31,.07);
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#0a0e13; --bg2:#0d131a; --card:#141b23; --card2:#10161d;
      --text:#eef2f6; --muted:#94a2b1; --line:#232d38;
      --in:#34d17f; --out:#f8757f; --accent:#e2b23c; --accent-ink:#e2b23c;
      --accent-soft:rgba(226,178,60,.13);
      --pos:#34d17f; --neg:#f8757f;
      --shadow:0 10px 30px rgba(0,0,0,.4);
    }
  }
  :root[data-theme="light"]{
    color-scheme:light;
    --bg:#faf8f3; --bg2:#f2ede3; --card:#ffffff; --card2:#faf7f1;
    --text:#161a1f; --muted:#5f6b76; --line:#e9e2d4;
    --in:#15803d; --out:#c92f42; --accent:#a9791b; --accent-ink:#7a560f;
    --accent-soft:rgba(169,121,27,.10);
    --pos:#15803d; --neg:#c92f42;
    --shadow:0 6px 22px rgba(22,26,31,.07);
  }
  :root[data-theme="dark"]{
    color-scheme:dark;
    --bg:#0a0e13; --bg2:#0d131a; --card:#141b23; --card2:#10161d;
    --text:#eef2f6; --muted:#94a2b1; --line:#232d38;
    --in:#34d17f; --out:#f8757f; --accent:#e2b23c; --accent-ink:#e2b23c;
    --accent-soft:rgba(226,178,60,.13);
    --pos:#34d17f; --neg:#f8757f;
    --shadow:0 10px 30px rgba(0,0,0,.4);
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
    font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif;
    -webkit-font-smoothing:antialiased;line-height:1.55;padding-bottom:48px}
  .wrap{max-width:940px;margin:0 auto;padding:0 18px}
  h1,h2,.kpi-value,.brand,.donut-total,.acc-bal{
    font-family:"Helvetica Neue",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}

  /* Hero: painel de tinta profunda com filete dourado — sempre escuro (assinatura). */
  .hero{background:radial-gradient(130% 150% at 88% -30%,#20303f 0%,#0b1218 58%);
    color:#f4f1e8;padding:40px 18px 34px;margin-bottom:24px;
    border-bottom:2px solid var(--accent);position:relative;overflow:hidden}
  .hero-inner{max-width:940px;margin:0 auto;position:relative;z-index:1}
  .brand{font-size:13px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#e2b23c}
  .hero h1{margin:10px 0 6px;font-size:32px;font-weight:800;line-height:1.1;
    text-transform:capitalize;text-wrap:balance;color:#fff}
  .hero .sub{font-size:13.5px;color:#aeb9c4;letter-spacing:.01em}

  .kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:24px}
  @media(max-width:720px){.kpi-grid{grid-template-columns:repeat(2,1fr)}}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 16px 18px;
    box-shadow:var(--shadow)}
  .kpi-icon{font-size:15px;width:32px;height:32px;border-radius:9px;display:flex;
    align-items:center;justify-content:center;background:var(--card2);border:1px solid var(--line)}
  .kpi-label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.09em;margin-top:12px}
  .kpi-value{font-size:23px;font-weight:800;margin-top:3px;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
  .kpi-sub{color:var(--muted);font-size:12px;margin-top:4px}
  .kpi-in .kpi-value{color:var(--in)} .kpi-out .kpi-value{color:var(--out)}
  .kpi-pos .kpi-value{color:var(--pos)} .kpi-neg .kpi-value{color:var(--neg)}
  .kpi-neutral .kpi-value{color:var(--accent-ink)}

  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px;
    margin-bottom:18px;box-shadow:var(--shadow)}
  .sec-head{display:flex;align-items:center;gap:10px;margin-bottom:18px}
  .sec-tick{width:3px;height:15px;border-radius:2px;background:var(--accent);flex:none}
  .card h2{margin:0;font-size:12.5px;font-weight:700;text-transform:uppercase;
    letter-spacing:.11em;color:var(--text)}
  .muted{color:var(--muted)} .small{font-size:12px}

  .ai-card{display:flex;gap:14px;background:var(--accent-soft);
    border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:14px;
    padding:18px;margin-bottom:24px}
  .ai-icon{font-size:24px;line-height:1}
  .ai-title{font-weight:700;margin-bottom:4px;font-size:12.5px;text-transform:uppercase;
    letter-spacing:.09em;color:var(--accent-ink)}
  .ai-card p{margin:0;color:var(--text)}

  /* donut */
  .donut-wrap{display:flex;gap:22px;align-items:center;flex-wrap:wrap}
  .donut-total{font-size:16px;font-weight:800;fill:var(--text)}
  .donut-cap{font-size:9px;fill:var(--muted);text-transform:uppercase;letter-spacing:.5px}
  .legend{list-style:none;margin:0;padding:0;flex:1;min-width:220px}
  .legend li{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px dashed var(--line);font-size:13px}
  .legend li:last-child{border-bottom:none}
  .dot{width:10px;height:10px;border-radius:3px;flex:none}
  .lg-name{flex:1} .lg-val{font-variant-numeric:tabular-nums;font-weight:600}
  .lg-pct{color:var(--muted);width:52px;text-align:right;font-variant-numeric:tabular-nums}

  /* bars */
  .chart-legend{display:flex;gap:16px;font-size:12px;color:var(--muted);margin-bottom:8px}
  .chart-legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px}
  .sw-in{background:var(--in)} .sw-out{background:var(--out)}
  .bars-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
  .bar-in{fill:var(--in)} .bar-out{fill:var(--out)}
  .grid{stroke:var(--line);stroke-width:1;stroke-dasharray:2 4}
  .axis-line{stroke:var(--line);stroke-width:1.5}
  .axis{fill:var(--muted);font-size:10px}

  /* categorias */
  .catbar-row{margin-bottom:12px}
  .catbar-head{display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px}
  .catbar-name{display:flex;align-items:center;gap:8px}
  .catbar-val{font-variant-numeric:tabular-nums;font-weight:600}
  .catbar-val em{color:var(--muted);font-style:normal;font-weight:400;margin-left:4px}
  .catbar-track{height:9px;background:var(--card2);border:1px solid var(--line);border-radius:6px;overflow:hidden}
  .catbar-fill{height:100%;border-radius:6px}

  /* contas */
  .acc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
  .acc-card{background:var(--card2);border:1px solid var(--line);border-radius:14px;padding:14px}
  .acc-top{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}
  .acc-bal{font-size:18px;font-weight:800;margin:8px 0 2px}
  .acc-bal.pos{color:var(--pos)} .acc-bal.neg{color:var(--neg)}
  .acc-type{color:var(--muted);font-size:11px;text-transform:capitalize}

  /* top gastos */
  .top-list{list-style:none;margin:0;padding:0}
  .top-list li{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
  .top-list li:last-child{border-bottom:none}
  .rank{width:24px;height:24px;flex:none;border-radius:8px;background:var(--accent);color:#1c1305;
    display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;
    font-family:"Helvetica Neue",Arial,sans-serif}
  .tg-info{flex:1;display:flex;flex-direction:column}
  .tg-desc{font-weight:600;font-size:14px}
  .tg-meta{color:var(--muted);font-size:12px}
  .tg-val{font-weight:700;font-variant-numeric:tabular-nums;color:var(--neg)}

  /* tabela */
  .table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:12px}
  table.tx{width:100%;border-collapse:collapse;font-size:13px;min-width:620px}
  table.tx th{text-align:left;color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;
    letter-spacing:.5px;padding:8px 10px;border-bottom:2px solid var(--line)}
  table.tx td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  table.tx tbody tr:nth-child(even){background:var(--card2)}
  .c-val{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600}
  .c-val.pos{color:var(--pos)} .c-val.neg{color:var(--neg)}
  .c-date{white-space:nowrap;color:var(--muted)}
  .c-cat,.c-acc{color:var(--muted)}
  .pill{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600}
  .pill.pos{background:rgba(34,197,94,.16);color:var(--pos)}
  .pill.neg{background:rgba(244,63,94,.16);color:var(--neg)}

  .empty{text-align:center;padding:48px 20px}
  .empty-emoji{font-size:44px;margin-bottom:8px}

  footer{max-width:940px;margin:30px auto 0;padding:18px 18px 0;color:var(--muted);
    font-size:12px;text-align:center;border-top:1px solid var(--line)}
  @media print{body{padding:0}.hero{margin-bottom:16px}.card{box-shadow:none;break-inside:avoid}}
</style>
</head>
<body>
  <header class="hero">
    <div class="hero-inner">
      <div class="brand">💰 Fin AI${data.owner ? " · " + esc(data.owner) : ""}</div>
      <h1>Relatório · ${esc(data.periodo)}</h1>
      <div class="sub">${esc(fmtDate(data.from))} — ${esc(fmtDate(data.to))} · ${data.countTx} lançamento(s) · gerado em ${esc(geradoEm)}</div>
    </div>
  </header>
  <main class="wrap">
    ${body}
  </main>
  <footer>Gerado automaticamente por <strong>Fin AI</strong> · ${esc(geradoEm)}</footer>
</body>
</html>`;
}
