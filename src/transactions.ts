import type { Account, Transaction } from "@prisma/client";
import { prisma } from "./db.js";
import { normalizeCategory } from "./categories.js";
import { centsToDecimalString, decToCents, type Cents } from "./money.js";

export async function listAccounts(userId: string): Promise<Account[]> {
  return prisma.account.findMany({ where: { userId }, orderBy: { name: "asc" } });
}

export async function addAccount(input: {
  userId: string;
  name: string;
  type?: string;
  currency?: string;
  initialBalanceCents?: Cents;
}): Promise<Account> {
  return prisma.account.create({
    data: {
      userId: input.userId,
      name: input.name,
      type: input.type || "corrente",
      currency: input.currency || "BRL",
      initialBalance: centsToDecimalString(input.initialBalanceCents ?? 0),
    },
  });
}

/**
 * Casa um "hint" de conta (ex: "nubank") com uma conta já carregada do usuário.
 * PURA — o chamador passa as contas que já buscou (evita findMany duplicado).
 */
export function resolveAccountFrom(
  accs: Account[],
  hint: string | null,
): Account | null {
  if (accs.length === 0) return null;
  if (!hint) return accs.length === 1 ? accs[0] : null;
  const h = hint.toLowerCase().trim();
  return (
    accs.find((a) => a.name.toLowerCase() === h) ||
    accs.find(
      (a) => a.name.toLowerCase().includes(h) || h.includes(a.name.toLowerCase()),
    ) ||
    (accs.length === 1 ? accs[0] : null)
  );
}

/** Conta por id, validando o dono — usada nos callbacks de confirmação. */
export async function getUserAccount(
  accountId: string,
  userId: string,
): Promise<Account | null> {
  const acc = await prisma.account.findUnique({ where: { id: accountId } });
  return acc && acc.userId === userId ? acc : null;
}

export async function createTransaction(input: {
  accountId: string;
  type: "entrada" | "saida";
  amountCents: Cents;
  currency: string;
  category: string;
  description: string;
  source: "telegram" | "shortcut";
  rawInput?: string;
  occurredAt?: Date;
}): Promise<Transaction> {
  return prisma.transaction.create({
    data: {
      accountId: input.accountId,
      type: input.type,
      amount: centsToDecimalString(input.amountCents),
      currency: input.currency,
      category: normalizeCategory(input.category),
      description: input.description,
      source: input.source,
      rawInput: input.rawInput ?? "",
      occurredAt: input.occurredAt ?? new Date(),
    },
  });
}

export interface BalanceRow {
  accountId: string;
  name: string;
  type: string;
  currency: string;
  balanceCents: Cents;
}

/** Saldos de todas as contas em 2 queries fixas (era 1+N). Soma no SQL. */
export async function balances(userId: string): Promise<BalanceRow[]> {
  const accs = await prisma.account.findMany({
    where: { userId },
    orderBy: { name: "asc" },
  });
  if (accs.length === 0) return [];

  const sums = await prisma.transaction.groupBy({
    by: ["accountId", "type"],
    where: { accountId: { in: accs.map((a) => a.id) } },
    _sum: { amount: true },
  });
  const byAcc = new Map<string, { entrada: Cents; saida: Cents }>();
  for (const s of sums) {
    const cur = byAcc.get(s.accountId) ?? { entrada: 0, saida: 0 };
    const cents = decToCents(s._sum.amount ?? 0);
    if (s.type === "entrada") cur.entrada += cents;
    else cur.saida += cents;
    byAcc.set(s.accountId, cur);
  }

  return accs.map((a) => {
    const s = byAcc.get(a.id) ?? { entrada: 0, saida: 0 };
    return {
      accountId: a.id,
      name: a.name,
      type: a.type,
      currency: a.currency,
      balanceCents: decToCents(a.initialBalance) + s.entrada - s.saida,
    };
  });
}

export interface DeletedTx {
  id: string;
  type: string;
  amountCents: Cents;
  currency: string;
  category: string;
  accountName: string;
  description: string;
}

/** Última transação do usuário (para o preview do /desfazer). */
export async function findLastTransaction(
  userId: string,
): Promise<(Transaction & { account: Account }) | null> {
  return prisma.transaction.findFirst({
    where: { account: { userId } },
    orderBy: { createdAt: "desc" },
    include: { account: true },
  });
}

/**
 * Apaga UMA transação específica validando o dono. deleteMany com guarda de
 * count: dois cliques simultâneos não removem duas linhas.
 */
export async function deleteTransactionById(
  txId: string,
  userId: string,
): Promise<DeletedTx | null> {
  const tx = await prisma.transaction.findUnique({
    where: { id: txId },
    include: { account: true },
  });
  if (!tx || tx.account.userId !== userId) return null;
  const del = await prisma.transaction.deleteMany({ where: { id: txId } });
  if (del.count !== 1) return null;
  return {
    id: tx.id,
    type: tx.type,
    amountCents: decToCents(tx.amount),
    currency: tx.currency,
    category: tx.category,
    accountName: tx.account.name,
    description: tx.description,
  };
}

export async function listRecentTransactions(
  userId: string,
  take: number,
): Promise<(Transaction & { account: Account })[]> {
  return prisma.transaction.findMany({
    where: { account: { userId } },
    orderBy: { occurredAt: "desc" },
    take,
    include: { account: true },
  });
}

/** Total de saídas de uma categoria num intervalo — usado pelos alertas de meta. */
export async function categorySpendCents(
  userId: string,
  category: string,
  from: Date,
  toExclusive: Date,
): Promise<Cents> {
  const agg = await prisma.transaction.aggregate({
    where: {
      account: { userId },
      type: "saida",
      category,
      occurredAt: { gte: from, lt: toExclusive },
    },
    _sum: { amount: true },
  });
  return decToCents(agg._sum.amount ?? 0);
}
