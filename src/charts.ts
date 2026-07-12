import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import type { ReportData } from "./report.js";
import { fmtBRL } from "./money.js";

/**
 * Gráficos enviados no chat: gera SVG autocontido (adaptado do html-report) e
 * rasteriza para PNG com @resvg/resvg-wasm. Falha graciosa: qualquer erro na
 * rasterização devolve null e o chamador cai no fallback textual.
 */

const CAT_COLORS = [
  "#0f766e", "#c98a1a", "#b03a5b", "#3b6ea5", "#7c6cc4",
  "#2f9e7d", "#d1743c", "#9c5c8f", "#4b8bbd", "#8a9a2b",
  "#c0526b", "#557a8f",
];
const INK = "#161a1f";
const MUTED = "#5f6b76";
const IN = "#15803d";
const OUT = "#c92f42";
const BG = "#ffffff";

function xmlEsc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const FONT = "DejaVu Sans, sans-serif";

/** Donut de gastos por categoria (800×460), legenda desenhada em <text>. */
export function donutChartSvg(data: ReportData): string {
  const cats = data.porCategoria.slice(0, 8);
  const outros = data.porCategoria.slice(8).reduce((s, c) => s + c.total, 0);
  const segments = cats.map((c, idx) => ({
    label: c.categoria,
    value: c.total,
    color: CAT_COLORS[idx % CAT_COLORS.length],
  }));
  if (outros > 0) segments.push({ label: "Outros", value: outros, color: "#94a3b8" });

  const total = segments.reduce((s, x) => s + x.value, 0);
  const W = 800;
  const H = 460;
  if (total <= 0) return frameSvg(W, H, `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-family="${FONT}" font-size="20" fill="${MUTED}">Sem gastos no período</text>`);

  const cx = 175;
  const cy = 210;
  const r = 120;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segments
    .map((seg) => {
      const dash = (seg.value / total) * circ;
      const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="44" stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
      offset += dash;
      return el;
    })
    .join("");

  const legend = segments
    .map((seg, idx) => {
      const y = 96 + idx * 34;
      const pct = ((seg.value / total) * 100).toFixed(1);
      return (
        `<rect x="360" y="${y - 12}" width="16" height="16" rx="4" fill="${seg.color}"/>` +
        `<text x="386" y="${y + 1}" font-family="${FONT}" font-size="17" fill="${INK}">${xmlEsc(seg.label)}</text>` +
        `<text x="${W - 30}" y="${y + 1}" text-anchor="end" font-family="${FONT}" font-size="17" fill="${INK}" font-weight="bold">${xmlEsc(fmtBRL(seg.value))}</text>` +
        `<text x="${W - 30}" y="${y + 20}" text-anchor="end" font-family="${FONT}" font-size="13" fill="${MUTED}">${pct}%</text>`
      );
    })
    .join("");

  const inner =
    `<text x="30" y="46" font-family="${FONT}" font-size="22" font-weight="bold" fill="${INK}">Gastos por categoria</text>` +
    `<text x="30" y="70" font-family="${FONT}" font-size="14" fill="${MUTED}">${xmlEsc(data.periodo)}</text>` +
    arcs +
    `<text x="${cx}" y="${cy - 2}" text-anchor="middle" font-family="${FONT}" font-size="22" font-weight="bold" fill="${INK}">${xmlEsc(fmtBRL(total))}</text>` +
    `<text x="${cx}" y="${cy + 22}" text-anchor="middle" font-family="${FONT}" font-size="13" fill="${MUTED}">em saídas</text>` +
    legend;
  return frameSvg(W, H, inner);
}

/** Barras de fluxo diário (entradas x saídas), largura fixa. */
export function dailyBarsSvg(data: ReportData): string {
  const days = data.daily;
  const W = 860;
  const H = 420;
  if (days.length === 0)
    return frameSvg(W, H, `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-family="${FONT}" font-size="20" fill="${MUTED}">Sem lançamentos no período</text>`);

  const max = Math.max(1, ...days.map((d) => Math.max(d.entrada, d.saida)));
  const padL = 30;
  const padTop = 80;
  const chartH = 260;
  const baseY = padTop + chartH;
  const usableW = W - padL - 30;
  const groupW = usableW / days.length;
  const barW = Math.max(2, Math.min(16, (groupW - 4) / 2));

  const grid = [0.25, 0.5, 0.75, 1]
    .map((f) => {
      const y = baseY - f * chartH;
      const val = Math.round(max * f);
      return (
        `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - 30}" y2="${y.toFixed(1)}" stroke="#e9e2d4" stroke-width="1" stroke-dasharray="2 4"/>` +
        `<text x="${padL - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="${FONT}" font-size="11" fill="${MUTED}">${xmlEsc(val >= 1000 ? (val / 1000).toFixed(1) + "k" : String(val))}</text>`
      );
    })
    .join("");

  const bars = days
    .map((d, idx) => {
      const x = padL + idx * groupW + (groupW - barW * 2 - 2) / 2;
      const he = (d.entrada / max) * chartH;
      const hs = (d.saida / max) * chartH;
      const dayNum = Number(d.date.slice(8, 10));
      const showLabel = days.length <= 16 || idx % Math.ceil(days.length / 16) === 0;
      const label = showLabel
        ? `<text x="${(x + barW).toFixed(1)}" y="${H - 14}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${MUTED}">${dayNum}</text>`
        : "";
      const eBar =
        d.entrada > 0
          ? `<rect x="${x.toFixed(1)}" y="${(baseY - he).toFixed(1)}" width="${barW.toFixed(1)}" height="${he.toFixed(1)}" rx="2" fill="${IN}"/>`
          : "";
      const sBar =
        d.saida > 0
          ? `<rect x="${(x + barW + 2).toFixed(1)}" y="${(baseY - hs).toFixed(1)}" width="${barW.toFixed(1)}" height="${hs.toFixed(1)}" rx="2" fill="${OUT}"/>`
          : "";
      return eBar + sBar + label;
    })
    .join("");

  const inner =
    `<text x="30" y="46" font-family="${FONT}" font-size="22" font-weight="bold" fill="${INK}">Fluxo diário</text>` +
    `<text x="30" y="70" font-family="${FONT}" font-size="14" fill="${MUTED}">${xmlEsc(data.periodo)}</text>` +
    `<rect x="${W - 260}" y="34" width="14" height="14" rx="3" fill="${IN}"/><text x="${W - 242}" y="46" font-family="${FONT}" font-size="14" fill="${INK}">Entradas</text>` +
    `<rect x="${W - 150}" y="34" width="14" height="14" rx="3" fill="${OUT}"/><text x="${W - 132}" y="46" font-family="${FONT}" font-size="14" fill="${INK}">Saídas</text>` +
    grid +
    `<line x1="${padL}" y1="${baseY}" x2="${W - 30}" y2="${baseY}" stroke="#c9c0ad" stroke-width="1.5"/>` +
    bars;
  return frameSvg(W, H, inner);
}

function frameSvg(w: number, h: number, inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${BG}"/>${inner}</svg>`;
}

// ---------------------------------------------------------------- Rasterização

let wasmReady: Promise<typeof import("@resvg/resvg-wasm")> | null = null;
let fontCache: Buffer | null = null;

async function ensureWasm() {
  if (!wasmReady) {
    wasmReady = (async () => {
      const mod = await import("@resvg/resvg-wasm");
      const require = createRequire(import.meta.url);
      const wasmPath = require.resolve("@resvg/resvg-wasm/index_bg.wasm");
      const bytes = await readFile(wasmPath);
      await mod.initWasm(bytes);
      return mod;
    })();
  }
  return wasmReady;
}

async function loadFont(): Promise<Buffer> {
  if (!fontCache) {
    const url = new URL("../assets/DejaVuSans.ttf", import.meta.url);
    fontCache = await readFile(url);
  }
  return fontCache;
}

/** SVG → PNG. Retorna null em qualquer falha (o chamador usa o fallback textual). */
export async function renderChartPng(svg: string): Promise<Buffer | null> {
  try {
    const mod = await ensureWasm();
    const font = await loadFont();
    const resvg = new mod.Resvg(svg, {
      background: BG,
      font: { fontBuffers: [font], defaultFontFamily: "DejaVu Sans", loadSystemFonts: false },
      fitTo: { mode: "width", value: 1000 },
    });
    return Buffer.from(resvg.render().asPng());
  } catch (e) {
    console.error("[charts] falha ao rasterizar:", e);
    return null;
  }
}
