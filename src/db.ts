import { PrismaClient } from "@prisma/client";
import { PrismaNeonHTTP } from "@prisma/adapter-neon";

function createPrisma() {
  // options (2º arg) é obrigatório na assinatura do adapter; repassado a neon(url, options).
  // As opções de query relevantes (arrayMode/fullResults/types) são fixadas internamente pelo adapter.
  const adapter = new PrismaNeonHTTP(process.env.DATABASE_URL!, {});
  return new PrismaClient({ adapter });
}

const g = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = g.prisma ?? createPrisma();

if (process.env.NODE_ENV !== "production") g.prisma = prisma;
