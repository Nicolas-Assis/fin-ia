import { prisma } from "./db.js";

/**
 * Estado de confirmação em serverless (tabela Pending). Payload versionado
 * (v2): suporta múltiplos itens por mensagem e valores em CENTAVOS.
 * A confirmação usa "claim" atômico via deleteMany — o adapter Neon HTTP não
 * suporta $transaction, e é isso que impede o duplo-clique de duplicar.
 */

export interface PendingItem {
  tipo: "entrada" | "saida";
  valorCents: number;
  moeda: string;
  categoria: string;
  descricao: string;
  accountId: string | null;
  /** "YYYY-MM-DD" local quando o lançamento é retroativo. */
  occurredAt?: string;
}

export interface PendingPayload {
  v: 2;
  items: PendingItem[];
  raw: string;
  /** Confiança mínima entre os itens (0-1) — abaixo do limiar o card pede conferência. */
  confianca?: number;
}

/** Depois disso o card expira ("manda de novo"). */
export const PENDING_TTL_MS = 30 * 60_000;
/** Rows mais velhas que isso são varridas oportunisticamente. */
const SWEEP_AFTER_MS = 24 * 3600_000;

export async function createPending(
  chatId: string,
  payload: PendingPayload,
): Promise<{ id: string }> {
  // Sweep oportunista: barato (índice em createdAt) e evita acúmulo eterno.
  await prisma.pending
    .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - SWEEP_AFTER_MS) } } })
    .catch(() => {});
  return prisma.pending.create({
    data: { chatId, payload: payload as any },
    select: { id: true },
  });
}

function isV2(p: any): p is PendingPayload {
  return !!p && p.v === 2 && Array.isArray(p.items);
}

/**
 * Busca validando dono (chatId), TTL e formato. Payloads legados (pré-v2,
 * valor em reais) são tratados como expirados — mais seguro que adivinhar.
 */
export async function getPending(
  id: string,
  chatId: string,
): Promise<{ id: string; payload: PendingPayload; createdAt: Date } | null> {
  const row = await prisma.pending.findUnique({ where: { id } });
  if (!row || row.chatId !== chatId) return null;
  if (row.createdAt.getTime() < Date.now() - PENDING_TTL_MS) {
    await prisma.pending.deleteMany({ where: { id } }).catch(() => {});
    return null;
  }
  const payload = row.payload as unknown;
  if (!isV2(payload)) return null;
  return { id: row.id, payload, createdAt: row.createdAt };
}

export async function updatePendingPayload(
  id: string,
  payload: PendingPayload,
): Promise<void> {
  await prisma.pending.update({ where: { id }, data: { payload: payload as any } });
}

/**
 * Claim atômico: um único DELETE decide quem confirma. Retorna true só para
 * quem efetivamente removeu a row — o segundo clique perde a corrida.
 */
export async function claimPending(id: string, chatId: string): Promise<boolean> {
  const r = await prisma.pending.deleteMany({ where: { id, chatId } });
  return r.count === 1;
}

/** Cancelamento (idempotente). */
export async function discardPending(id: string, chatId: string): Promise<void> {
  await prisma.pending.deleteMany({ where: { id, chatId } });
}
