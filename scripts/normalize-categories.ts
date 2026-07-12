// Backfill: normaliza as categorias existentes para a taxonomia canônica.
// ⚠️ Importa src/db.ts → conecta no Neon REAL. Rodar DEPOIS do deploy.
// Uso:
//   npx tsx scripts/normalize-categories.ts           (dry-run: só imprime)
//   npx tsx scripts/normalize-categories.ts --apply    (aplica as mudanças)
import { prisma } from "../src/db.js";
import { normalizeCategory } from "../src/categories.js";

const apply = process.argv.includes("--apply");

const groups = await prisma.transaction.groupBy({
  by: ["category"],
  _count: { _all: true },
});

const changes: { from: string; to: string; count: number }[] = [];
for (const g of groups) {
  const to = normalizeCategory(g.category);
  if (to !== g.category) {
    changes.push({ from: g.category, to, count: g._count._all });
  }
}

if (changes.length === 0) {
  console.log("✅ Nada a normalizar — todas as categorias já são canônicas.");
  process.exit(0);
}

console.log(`${apply ? "APLICANDO" : "DRY-RUN"} — ${changes.length} categoria(s) a mudar:\n`);
for (const c of changes) {
  console.log(`  "${c.from}" → "${c.to}"  (${c.count} lançamento(s))`);
}

if (!apply) {
  console.log(`\nRode com --apply para aplicar. O texto original continua em rawInput.`);
  process.exit(0);
}

let total = 0;
for (const c of changes) {
  const r = await prisma.transaction.updateMany({
    where: { category: c.from },
    data: { category: c.to },
  });
  total += r.count;
  console.log(`  ✔ ${c.from} → ${c.to}: ${r.count}`);
}
console.log(`\n✅ ${total} lançamento(s) atualizados.`);

const after = await prisma.transaction.groupBy({ by: ["category"], _count: { _all: true } });
console.log("\nCategorias agora:");
for (const g of after.sort((a, b) => b._count._all - a._count._all)) {
  console.log(`  ${g.category}: ${g._count._all}`);
}
