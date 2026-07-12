import { prisma } from "./db.js";

/**
 * Cache chave-valor simples no Postgres (tabela Kv) — serverless não tem
 * memória entre invocações. Expiração checada na leitura; sem sweep dedicado.
 */

export async function cacheGet(key: string): Promise<string | null> {
  try {
    const row = await prisma.kv.findUnique({ where: { key } });
    if (!row) return null;
    if (row.expiresAt.getTime() < Date.now()) {
      await prisma.kv.deleteMany({ where: { key } });
      return null;
    }
    return row.value;
  } catch {
    return null; // cache nunca derruba o fluxo principal
  }
}

export async function cacheSet(
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  try {
    await prisma.kv.upsert({
      where: { key },
      update: { value, expiresAt },
      create: { key, value, expiresAt },
    });
  } catch {
    // best-effort
  }
}
