import { prisma } from "../src/db.js";

// Ajuste suas contas aqui e rode: npm run seed
const contas = [
  { name: "Nubank", type: "cartao", currency: "BRL", initialBalance: 0 },
  { name: "Itaú", type: "corrente", currency: "BRL", initialBalance: 0 },
  { name: "Dinheiro", type: "dinheiro", currency: "BRL", initialBalance: 0 },
];

for (const c of contas) {
  await prisma.account.upsert({
    where: { name: c.name },
    update: {},
    create: c,
  });
  console.log("ok:", c.name);
}

await prisma.$disconnect();
