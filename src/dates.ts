/**
 * Datas no fuso do usuário (default America/Sao_Paulo). O servidor roda em UTC
 * na Vercel; sem isso, um lançamento às 22h BRT cai no dia seguinte.
 * Implementado só com Intl — sem lib de datas (o Brasil não tem horário de
 * verão desde 2019, então o offset por instante é exato).
 */

export const APP_TZ = process.env.APP_TZ || "America/Sao_Paulo";

const dayFmtCache = new Map<string, Intl.DateTimeFormat>();
function dayFmt(tz: string): Intl.DateTimeFormat {
  let f = dayFmtCache.get(tz);
  if (!f) {
    // en-CA formata como YYYY-MM-DD.
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFmtCache.set(tz, f);
  }
  return f;
}

/** "YYYY-MM-DD" da data no fuso. */
export function dayKeyTz(d: Date, tz = APP_TZ): string {
  return dayFmt(tz).format(d);
}

/** Offset (ms) do fuso em um instante: local = utc + offset (BRT => -3h). */
function tzOffsetAt(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const hour = get("hour") % 24; // alguns runtimes emitem "24" à meia-noite
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Instante UTC correspondente a (y, m, d, h:min) no fuso. m é 1-12; d pode "transbordar". */
export function zonedDateToUtc(
  y: number,
  m: number,
  d: number,
  h = 0,
  min = 0,
  tz = APP_TZ,
): Date {
  const wallUtc = Date.UTC(y, m - 1, d, h, min);
  const offset = tzOffsetAt(new Date(wallUtc), tz);
  return new Date(wallUtc - offset);
}

/** Partes de calendário de um instante no fuso. */
export function partsTz(d: Date, tz = APP_TZ): { y: number; m: number; d: number } {
  const [y, m, dd] = dayKeyTz(d, tz).split("-").map(Number);
  return { y, m, d: dd };
}

/** "YYYY-MM-DD" -> instante às 12:00 locais (meio-dia evita drift de borda), ou null. */
export function fromLocalDateString(s: string, tz = APP_TZ): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s || "").trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Rejeita datas impossíveis (ex: 31/02): Date.UTC normalizaria para março.
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return zonedDateToUtc(y, mo, d, 12, 0, tz);
}

/** Nome do mês pt-BR, ex: "julho de 2026". */
function monthLabel(y: number, m: number): string {
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("pt-BR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export interface Period {
  from: Date;
  toExclusive: Date;
  label: string;
}

/**
 * Resolve um período no fuso: "hoje" | "ontem" | "semana" | "mes" |
 * "mes-anterior" | "AAAA-MM" | vazio (mês corrente). Intervalo [from, toExclusive).
 */
export function resolvePeriod(arg?: string, tz = APP_TZ): Period {
  const a = (arg || "").trim().toLowerCase();
  const now = partsTz(new Date(), tz);

  const mAnoMes = /^(\d{4})-(\d{2})$/.exec(a);
  if (mAnoMes) {
    const y = Number(mAnoMes[1]);
    const mo = Number(mAnoMes[2]);
    return {
      from: zonedDateToUtc(y, mo, 1, 0, 0, tz),
      toExclusive: zonedDateToUtc(y, mo + 1, 1, 0, 0, tz),
      label: monthLabel(y, mo),
    };
  }
  if (a === "hoje") {
    return {
      from: zonedDateToUtc(now.y, now.m, now.d, 0, 0, tz),
      toExclusive: zonedDateToUtc(now.y, now.m, now.d + 1, 0, 0, tz),
      label: "hoje",
    };
  }
  if (a === "ontem") {
    return {
      from: zonedDateToUtc(now.y, now.m, now.d - 1, 0, 0, tz),
      toExclusive: zonedDateToUtc(now.y, now.m, now.d, 0, 0, tz),
      label: "ontem",
    };
  }
  if (a === "semana") {
    return {
      from: zonedDateToUtc(now.y, now.m, now.d - 6, 0, 0, tz),
      toExclusive: zonedDateToUtc(now.y, now.m, now.d + 1, 0, 0, tz),
      label: "últimos 7 dias",
    };
  }
  if (a === "mes-anterior" || a === "mês-anterior") {
    return {
      from: zonedDateToUtc(now.y, now.m - 1, 1, 0, 0, tz),
      toExclusive: zonedDateToUtc(now.y, now.m, 1, 0, 0, tz),
      label: monthLabel(now.m === 1 ? now.y - 1 : now.y, now.m === 1 ? 12 : now.m - 1),
    };
  }
  // padrão: mês corrente
  return {
    from: zonedDateToUtc(now.y, now.m, 1, 0, 0, tz),
    toExclusive: zonedDateToUtc(now.y, now.m + 1, 1, 0, 0, tz),
    label: monthLabel(now.y, now.m),
  };
}

/** "YYYY-MM-DD" -> "10/07" (exibição curta). */
export function shortDateBR(dayKey: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(dayKey);
  return m ? `${m[2]}/${m[1]}` : dayKey;
}

/** Data/hora de exibição no fuso do app. */
export function fmtDateTz(d: Date, tz = APP_TZ): string {
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: tz,
  });
}

export function fmtDateTimeTz(d: Date, tz = APP_TZ): string {
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
  });
}

/** Dia da semana por extenso no fuso, ex: "sexta-feira". */
export function weekdayTz(d: Date, tz = APP_TZ): string {
  return d.toLocaleDateString("pt-BR", { weekday: "long", timeZone: tz });
}
