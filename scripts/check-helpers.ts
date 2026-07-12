// Testes dos módulos PUROS (money, dates, categories). Não importa src/db.ts,
// então NÃO toca no Neon/OpenRouter. Uso: npx tsx scripts/check-helpers.ts
import assert from "node:assert/strict";
import {
  parseAmountBR,
  decToCents,
  centsToDecimalString,
  fmtCents,
} from "../src/money.js";
import {
  dayKeyTz,
  resolvePeriod,
  fromLocalDateString,
} from "../src/dates.js";
import { normalizeCategory, guessCategory } from "../src/categories.js";

let n = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  assert.deepEqual(a, b, `${msg} — recebido: ${JSON.stringify(a)}`);
  n++;
};

// ---- money: parseAmountBR ----
eq(parseAmountBR("1.234,56"), 123456, "1.234,56");
eq(parseAmountBR("45,90"), 4590, "45,90");
eq(parseAmountBR("1234.56"), 123456, "1234.56");
eq(parseAmountBR("45"), 4500, "45");
eq(parseAmountBR("R$ 45,90"), 4590, "R$ 45,90");
eq(parseAmountBR("2k"), 200000, "2k");
eq(parseAmountBR("1 mil"), 100000, "1 mil");
eq(parseAmountBR("2,5 mil"), 250000, "2,5 mil");
eq(parseAmountBR("1.000"), 100000, "1.000 (milhar)");
eq(parseAmountBR("10,5"), 1050, "10,5");
eq(parseAmountBR(45.9), 4590, "número 45.9");
eq(parseAmountBR("abc"), null, "abc → null");
eq(parseAmountBR(""), null, "vazio → null");
eq(parseAmountBR("0"), null, "0 → null");

// ---- money: decToCents / centsToDecimalString / fmtCents ----
eq(decToCents("1234.56"), 123456, "decToCents 1234.56");
eq(decToCents("0.10"), 10, "decToCents 0.10");
eq(decToCents("100"), 10000, "decToCents 100");
eq(centsToDecimalString(4590), "45.90", "centsToDecimalString 4590");
eq(centsToDecimalString(10), "0.10", "centsToDecimalString 10");
eq(centsToDecimalString(100000), "1000.00", "centsToDecimalString 100000");
// round-trip
eq(decToCents(centsToDecimalString(123456)), 123456, "round-trip 123456");
assert.ok(fmtCents(123456).includes("1.234,56"), "fmtCents formata pt-BR");
n++;

// ---- dates ----
// 2026-07-11T02:30Z = 2026-07-10 23:30 em São Paulo (UTC-3)
eq(dayKeyTz(new Date("2026-07-11T02:30:00Z")), "2026-07-10", "23h30 BRT vira dia anterior");
eq(dayKeyTz(new Date("2026-07-11T12:00:00Z")), "2026-07-11", "meio-dia UTC = mesmo dia BRT");

const mes = resolvePeriod("2026-06");
eq(mes.from.toISOString(), "2026-06-01T03:00:00.000Z", "junho começa 03:00Z");
eq(mes.toExclusive.toISOString(), "2026-07-01T03:00:00.000Z", "junho termina 03:00Z (exclusivo)");

const hoje = resolvePeriod("hoje");
// from deve ser meia-noite local (03:00Z), e o intervalo cobrir 24h
eq(hoje.from.getUTCHours(), 3, "hoje começa 03:00Z");
eq(
  Math.round((hoje.toExclusive.getTime() - hoje.from.getTime()) / 3_600_000),
  24,
  "hoje dura 24h",
);

const fld = fromLocalDateString("2026-07-10");
assert.ok(fld && dayKeyTz(fld) === "2026-07-10", "fromLocalDateString mantém o dia local");
n++;
eq(fromLocalDateString("2026-02-31"), null, "data impossível → null");
eq(fromLocalDateString("xx"), null, "lixo → null");

// ---- categories ----
eq(normalizeCategory("comida"), "Alimentação", "comida → Alimentação");
eq(normalizeCategory("MERCADO"), "Mercado", "MERCADO → Mercado");
eq(normalizeCategory("Alimentação"), "Alimentação", "canônica idêntica");
eq(normalizeCategory("qualquer coisa"), "Outros", "desconhecida → Outros");
eq(normalizeCategory(null), "Outros", "null → Outros");
eq(guessCategory("posto de gasolina"), "Transporte", "guess: posto de gasolina");
eq(guessCategory("assinatura netflix"), "Assinaturas", "guess: netflix");
eq(guessCategory("nota do supermercado"), "Mercado", "guess: supermercado");

console.log(`✅ ${n} asserts passaram.`);
