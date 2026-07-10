import { prisma } from "./db.js";

export async function listAccounts(userId: string) {
  return prisma.account.findMany({ where: { userId }, orderBy: { name: "asc" } });
}

export async function listAccountNames(userId: string): Promise<string[]> {
  const accs = await prisma.account.findMany({
    where: { userId },
    select: { name: true },
  });
  return accs.map((a) => a.name);
}

export async function addAccount(input: {
  userId: string;
  name: string;
  type?: string;
  currency?: string;
  initialBalance?: number;
}) {
  return prisma.account.create({
    data: {
      userId: input.userId,
      name: input.name,
      type: input.type || "corrente",
      currency: input.currency || "BRL",
      initialBalance: input.initialBalance ?? 0,
    },
  });
}

/** Tenta casar um "hint" de conta (ex: "nubank") com uma conta DO usuário. */
export async function resolveAccount(userId: string, hint: string | null) {
  const accs = await prisma.account.findMany({ where: { userId } });
  if (accs.length === 0) return null;
  if (!hint) return accs.length === 1 ? accs[0] : null;
  const h = hint.toLowerCase().trim();
  return (
    accs.find((a) => a.name.toLowerCase() === h) ||
    accs.find(
      (a) =>
        a.name.toLowerCase().includes(h) || h.includes(a.name.toLowerCase()),
    ) ||
    (accs.length === 1 ? accs[0] : null)
  );
}

export async function createTransaction(input: {
  accountId: string;
  type: "entrada" | "saida";
  amount: number;
  currency: string;
  category: string;
  description: string;
  source: "telegram" | "shortcut";
  rawInput?: string;
  occurredAt?: Date;
}) {
  return prisma.transaction.create({
    data: {
      accountId: input.accountId,
      type: input.type,
      amount: input.amount,
      currency: input.currency,
      category: input.category,
      description: input.description,
      source: input.source,
      rawInput: input.rawInput ?? "",
      occurredAt: input.occurredAt ?? new Date(),
    },
  });
}

export interface BalanceRow {
  name: string;
  currency: string;
  balance: number;
}

export async function balances(userId: string): Promise<BalanceRow[]> {
  const accs = await prisma.account.findMany({
    where: { userId },
    orderBy: { name: "asc" },
  });
  const rows: BalanceRow[] = [];
  for (const a of accs) {
    const agg = await prisma.transaction.groupBy({
      by: ["type"],
      where: { accountId: a.id },
      _sum: { amount: true },
    });
    const entrada = Number(agg.find((x) => x.type === "entrada")?._sum.amount ?? 0);
    const saida = Number(agg.find((x) => x.type === "saida")?._sum.amount ?? 0);
    rows.push({
      name: a.name,
      currency: a.currency,
      balance: Number(a.initialBalance) + entrada - saida,
    });
  }
  return rows;
}

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
