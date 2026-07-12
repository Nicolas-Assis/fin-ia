import { prisma } from "./db.js";
import { normalizeCategory, type CategoryName } from "./categories.js";
import { resolvePeriod } from "./dates.js";
import { centsToDecimalString, decToCents, fmtCents, type Cents } from "./money.js";
import { categorySpendCents } from "./transactions.js";

/** Metas de gasto mensal por categoria. */

export interface BudgetRow {
  category: CategoryName;
  amountCents: Cents;
}

export async function setBudget(
  userId: string,
  categoryRaw: string,
  amountCents: Cents,
): Promise<BudgetRow> {
  const category = normalizeCategory(categoryRaw);
  await prisma.budget.upsert({
    where: { userId_category: { userId, category } },
    update: { amount: centsToDecimalString(amountCents) },
    create: { userId, category, amount: centsToDecimalString(amountCents) },
  });
  return { category, amountCents };
}

export async function removeBudget(
  userId: string,
  categoryRaw: string,
): Promise<boolean> {
  const category = normalizeCategory(categoryRaw);
  const r = await prisma.budget.deleteMany({ where: { userId, category } });
  return r.count > 0;
}

export async function listBudgetsWithSpend(userId: string): Promise<
  { category: string; amountCents: Cents; spentCents: Cents; pct: number }[]
> {
  const budgets = await prisma.budget.findMany({
    where: { userId },
    orderBy: { category: "asc" },
  });
  if (budgets.length === 0) return [];
  const { from, toExclusive } = resolvePeriod("mes");
  return Promise.all(
    budgets.map(async (bgt) => {
      const amountCents = decToCents(bgt.amount);
      const spentCents = await categorySpendCents(userId, bgt.category, from, toExclusive);
      return {
        category: bgt.category,
        amountCents,
        spentCents,
        pct: amountCents > 0 ? (spentCents / amountCents) * 100 : 0,
      };
    }),
  );
}

/**
 * Alerta pós-lançamento: cruzou 80%/100% da meta do mês na categoria?
 * Retorna a linha pronta (HTML-safe: só texto + números) ou null.
 */
export async function budgetAlert(
  userId: string,
  categoryRaw: string,
): Promise<string | null> {
  const category = normalizeCategory(categoryRaw);
  const bgt = await prisma.budget.findUnique({
    where: { userId_category: { userId, category } },
  });
  if (!bgt) return null;
  const amountCents = decToCents(bgt.amount);
  if (amountCents <= 0) return null;
  const { from, toExclusive } = resolvePeriod("mes");
  const spentCents = await categorySpendCents(userId, category, from, toExclusive);
  const pct = Math.round((spentCents / amountCents) * 100);
  if (pct >= 100) {
    return `🚨 Meta de ${category} estourada: ${fmtCents(spentCents)} de ${fmtCents(amountCents)} (${pct}%)`;
  }
  if (pct >= 80) {
    return `⚠️ Meta de ${category}: ${fmtCents(spentCents)} de ${fmtCents(amountCents)} (${pct}%)`;
  }
  return null;
}
