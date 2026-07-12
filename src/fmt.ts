/**
 * Formatação de texto para o Telegram em parse_mode HTML.
 * HTML só exige escapar & < > — bem mais robusto que Markdown/MarkdownV2
 * para texto vindo do usuário ou do LLM.
 */

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export const b = (s: unknown) => `<b>${esc(s)}</b>`;
export const i = (s: unknown) => `<i>${esc(s)}</i>`;
export const code = (s: unknown) => `<code>${esc(s)}</code>`;

/** Mini barra de progresso em blocos unicode (0–100%). */
export function textBar(pct: number): string {
  const n = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return "▓".repeat(n) + "░".repeat(10 - n);
}

export function tipoLabel(tipo: string): string {
  return tipo === "entrada" ? "🟢 Entrada" : "🔴 Saída";
}

/** Prefixo de sinal usado em listas de lançamentos. */
export function tipoSign(tipo: string): string {
  return tipo === "saida" ? "🔴 -" : "🟢 +";
}

export const ACCOUNT_ICON: Record<string, string> = {
  cartao: "💳",
  corrente: "🏦",
  poupanca: "🐷",
  dinheiro: "💵",
  cripto: "₿",
};

export function accountIcon(type: string): string {
  return ACCOUNT_ICON[type] || "🏦";
}
