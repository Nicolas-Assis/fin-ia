import { prisma } from "./db.js";
import { collectReportData } from "./report.js";
import { fmtBRL } from "./money.js";
import { b, esc } from "./fmt.js";
import { categoryEmoji } from "./categories.js";

/**
 * Digest diário proativo (Vercel Cron → GET /api/cron/digest).
 * Para cada usuário ativo COM lançamentos no dia, envia um resumo curto.
 * Quem não lançou nada não recebe nada (sem spam).
 */
export async function runDailyDigest(): Promise<{ sent: number; skipped: number }> {
  const { bot } = await import("./telegram.js");
  const users = await prisma.user.findMany({ where: { active: true } });

  let sent = 0;
  let skipped = 0;
  for (const user of users) {
    try {
      const hoje = await collectReportData(user.id, user.name, "hoje");
      if (hoje.countTx === 0) {
        skipped++;
        continue;
      }
      const mes = await collectReportData(user.id, user.name, "mes");
      const topCat = mes.porCategoria[0];

      const linhas = [
        `🌙 ${b("Fechamento do dia")}`,
        "",
        `Hoje: 🔴 ${esc(fmtBRL(hoje.totalSaidas))} em ${hoje.countSaidas} gasto(s)` +
          (hoje.totalEntradas > 0 ? ` · 🟢 ${esc(fmtBRL(hoje.totalEntradas))}` : ""),
        `No mês (${esc(mes.periodo)}): 🔴 ${esc(fmtBRL(mes.totalSaidas))} · resultado ${esc(fmtBRL(mes.resultado))}`,
      ];
      if (topCat) {
        linhas.push(
          `Maior categoria: ${categoryEmoji(topCat.categoria)} ${esc(topCat.categoria)} — ${esc(fmtBRL(topCat.total))} (${topCat.pct.toFixed(0)}%)`,
        );
      }
      linhas.push("", "Ver mais: /resumo · /categorias · /relatorio");

      await bot.api.sendMessage(user.telegramId, linhas.join("\n"), {
        parse_mode: "HTML",
      });
      sent++;
    } catch (e) {
      console.error(`[digest] falhou para ${user.telegramId}:`, e);
      skipped++;
    }
  }
  return { sent, skipped };
}
