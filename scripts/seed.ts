import { prisma } from "../src/db.js";

// Cria o usuário dono (a partir de TELEGRAM_CHAT_ID) e algumas contas de exemplo
// pertencentes a ele. Rode: npm run seed
const ownerTelegramId = process.env.TELEGRAM_CHAT_ID;
if (!ownerTelegramId) {
  console.error("Defina TELEGRAM_CHAT_ID no .env antes de rodar o seed.");
  process.exit(1);
}

const owner = await prisma.user.upsert({
  where: { telegramId: ownerTelegramId },
  update: { role: "owner", active: true },
  create: {
    telegramId: ownerTelegramId,
    name: "Dono",
    role: "owner",
    active: true,
  },
});
console.log("ok: usuário dono ->", owner.telegramId);

// Ajuste suas contas aqui.
const contas = [
  { name: "Nubank", type: "cartao", currency: "BRL", initialBalance: 0 },
  { name: "Itaú", type: "corrente", currency: "BRL", initialBalance: 0 },
  { name: "Dinheiro", type: "dinheiro", currency: "BRL", initialBalance: 0 },
];

for (const c of contas) {
  await prisma.account.upsert({
    where: { userId_name: { userId: owner.id, name: c.name } },
    update: {},
    create: { ...c, userId: owner.id },
  });
  console.log("ok: conta ->", c.name);
}

await prisma.$disconnect();
