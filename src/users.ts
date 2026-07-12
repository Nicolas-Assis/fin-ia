import { prisma } from "./db.js";
import type { User } from "@prisma/client";

/** telegramId (chat id) do dono/administrador, vindo do ambiente. */
export function ownerTelegramId(): string {
  return process.env.TELEGRAM_CHAT_ID || "";
}

export function isOwnerId(telegramId: string): boolean {
  const owner = ownerTelegramId();
  return !!owner && telegramId === owner;
}

export async function findUserByTelegramId(
  telegramId: string,
): Promise<User | null> {
  return prisma.user.findUnique({ where: { telegramId } });
}

/**
 * Garante que o registro do dono existe (provisão preguiçosa em ambiente serverless)
 * e, na PRIMEIRA criação, reivindica as contas antigas (sem dono) para ele — assim a
 * migração para multiusuário não perde os dados que já existiam.
 */
export async function ensureOwner(
  telegramId: string,
  name: string,
): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { telegramId } });
  if (existing) {
    if (existing.role !== "owner" || !existing.active) {
      return prisma.user.update({
        where: { telegramId },
        data: { role: "owner", active: true },
      });
    }
    return existing;
  }
  const owner = await prisma.user.create({
    data: { telegramId, name: name || "Dono", role: "owner", active: true },
  });
  // Reivindica contas órfãs (dados anteriores à migração multiusuário).
  await prisma.account.updateMany({
    where: { userId: null },
    data: { userId: owner.id },
  });
  return owner;
}

/**
 * Resolve quem está mandando a requisição. Retorna o usuário ativo, ou null se não
 * autorizado. Provisiona o dono automaticamente no primeiro acesso.
 */
export async function resolveUser(
  telegramId: string,
  displayName: string,
): Promise<User | null> {
  if (isOwnerId(telegramId)) return ensureOwner(telegramId, displayName);
  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user || !user.active) return null;
  // Mantém o nome atualizado com o que o Telegram informa (útil na primeira interação).
  if (!user.name && displayName) {
    return prisma.user.update({
      where: { telegramId },
      data: { name: displayName },
    });
  }
  return user;
}

/** Autoriza (ou reativa) uma pessoa. Ação do dono. */
export async function inviteUser(
  telegramId: string,
  name: string,
): Promise<User> {
  return prisma.user.upsert({
    where: { telegramId },
    update: { active: true, ...(name ? { name } : {}) },
    create: { telegramId, name: name || "", role: "member", active: true },
  });
}

/** Desativa uma pessoa (não apaga os dados dela). Ação do dono. */
export async function deactivateUser(telegramId: string): Promise<User | null> {
  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) return null;
  return prisma.user.update({
    where: { telegramId },
    data: { active: false },
  });
}

export async function listUsers(): Promise<User[]> {
  return prisma.user.findMany({ orderBy: { createdAt: "asc" } });
}

/** Usuários + contagem de contas em 2 queries fixas (era 1+N no /pessoas). */
export async function listUsersWithAccountCounts(): Promise<
  (User & { accountCount: number })[]
> {
  const [users, counts] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.account.groupBy({ by: ["userId"], _count: { _all: true } }),
  ]);
  const byUser = new Map(counts.map((c) => [c.userId, c._count._all]));
  return users.map((u) => ({ ...u, accountCount: byUser.get(u.id) ?? 0 }));
}

/** Usuário dono da requisição do Atalho: chave global (compat) = dono; senão por chave pessoal. */
export async function resolveUserForShortcut(
  apiKey: string,
): Promise<User | null> {
  const globalKey = process.env.SHORTCUT_API_KEY;
  if (globalKey && apiKey === globalKey) {
    const owner = ownerTelegramId();
    if (!owner) return null;
    return ensureOwner(owner, "Dono");
  }
  const user = await prisma.user.findUnique({ where: { shortcutKey: apiKey } });
  return user && user.active ? user : null;
}

/** Usuário dono de um link de relatório (identificado pela chave pessoal). */
export async function resolveUserByShortcutKey(
  key: string,
): Promise<User | null> {
  const user = await prisma.user.findUnique({ where: { shortcutKey: key } });
  return user && user.active ? user : null;
}
