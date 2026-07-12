/**
 * Dinheiro em CENTAVOS INTEIROS. O banco guarda Decimal(14,2); toda conta em
 * memória usa inteiros para não acumular erro de float. Converta na borda:
 * decToCents ao ler, centsToDecimalString ao gravar, fmtCents ao exibir.
 */

export type Cents = number;

/** Prisma.Decimal | string | number -> centavos exatos (parse da string, sem float). */
export function decToCents(
  v: { toString(): string } | string | number | null | undefined,
): Cents {
  if (v == null) return 0;
  const s = String(v).trim();
  const m = s.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }
  const sign = m[1] === "-" ? -1 : 1;
  const frac = (m[3] ?? "").padEnd(2, "0").slice(0, 2);
  return sign * (Number(m[2]) * 100 + Number(frac || "0"));
}

/** Centavos -> string decimal "1234.56" para gravar em colunas Decimal do Prisma. */
export function centsToDecimalString(c: Cents): string {
  const sign = c < 0 ? "-" : "";
  const abs = Math.round(Math.abs(c));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Formata um valor em REAIS (número) como moeda pt-BR. */
export function fmtBRL(v: number, currency = "BRL"): string {
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency,
    }).format(v);
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
}

/** Formata CENTAVOS como moeda pt-BR. */
export function fmtCents(c: Cents, currency = "BRL"): string {
  return fmtBRL(c / 100, currency);
}

// Decimal(14,2) => no máximo 12 dígitos inteiros; barra valores acima disso.
const MAX_CENTS = 10 ** 14;

/**
 * Parser de valor pt-BR robusto -> centavos, ou null se inválido.
 *   "1.234,56" -> 123456 · "45,90" -> 4590 · "1234.56" -> 123456 · "45" -> 4500
 *   "R$ 45,90" -> 4590 · "2k" -> 200000 · "1 mil" -> 100000 · "2,5 mil" -> 250000
 * Heurística de separadores: com ambos, o último é o decimal; só um separador é
 * decimal quando seguido de 1-2 dígitos no fim, senão é milhar.
 */
export function parseAmountBR(
  input: string | number | null | undefined,
): Cents | null {
  if (input == null) return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    const cents = Math.round(Math.abs(input) * 100);
    return cents > 0 && cents < MAX_CENTS ? cents : null;
  }

  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/r\$\s*/g, "").replace(/reais?\b/g, "").trim();

  let mult = 1;
  const milMatch = s.match(/^([\d.,]+)\s*(k|mil)$/);
  if (milMatch) {
    s = milMatch[1];
    mult = 1000;
  }
  if (!/^[\d.,]+$/.test(s)) return null;

  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  let normalized: string;
  if (hasDot && hasComma) {
    normalized =
      s.lastIndexOf(",") > s.lastIndexOf(".")
        ? s.replace(/\./g, "").replace(/,/g, ".")
        : s.replace(/,/g, "");
  } else if (hasComma) {
    normalized = /,\d{1,2}$/.test(s)
      ? s.replace(/,/g, ".")
      : s.replace(/,/g, "");
  } else if (hasDot) {
    normalized = /^\d+\.\d{1,2}$/.test(s) ? s : s.replace(/\./g, "");
  } else {
    normalized = s;
  }
  if ((normalized.match(/\./g) || []).length > 1) return null;

  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(Math.abs(n) * 100 * mult);
  return cents > 0 && cents < MAX_CENTS ? cents : null;
}
