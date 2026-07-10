import type { Context } from "hono";
import { parseTransaction } from "./llm.js";
import {
  createTransaction,
  listAccountNames,
  resolveAccount,
} from "./transactions.js";

/**
 * POST /api/shortcut
 * Header: x-api-key: <SHORTCUT_API_KEY>
 * Body (uma das formas):
 *   { "texto": "gastei 45 no posto no nubank" }
 *   { "tipo": "saida", "valor": 45.9, "conta": "Nubank", "descricao": "posto" }
 */
export async function handleShortcut(c: Context) {
  const key = c.req.header("x-api-key");
  if (!key || key !== process.env.SHORTCUT_API_KEY) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "json inválido" }, 400);
  }

  const contas = await listAccountNames();
  if (contas.length === 0) {
    return c.json({ error: "nenhuma conta cadastrada" }, 422);
  }

  let tipo: "entrada" | "saida";
  let valor: number;
  let contaHint: string | null;
  let categoria: string;
  let descricao: string;

  if (body.texto) {
    const p = await parseTransaction(String(body.texto), contas);
    tipo = p.tipo;
    valor = p.valor;
    contaHint = p.conta;
    categoria = p.categoria;
    descricao = p.descricao;
  } else {
    tipo = body.tipo === "entrada" ? "entrada" : "saida";
    valor = Math.abs(Number(String(body.valor).replace(",", "."))) || 0;
    contaHint = body.conta ?? null;
    descricao = body.descricao ?? "";
    // categoriza a partir da descrição (barato)
    if (descricao) {
      try {
        const p = await parseTransaction(`${tipo} ${valor} ${descricao}`, contas);
        categoria = p.categoria;
      } catch {
        categoria = "Outros";
      }
    } else {
      categoria = "Outros";
    }
  }

  if (!valor || valor <= 0) {
    return c.json({ error: "valor inválido" }, 422);
  }

  const acc = await resolveAccount(contaHint);
  if (!acc) {
    return c.json({ error: "conta não encontrada", contas }, 422);
  }

  const tx = await createTransaction({
    accountId: acc.id,
    type: tipo,
    amount: valor,
    currency: acc.currency,
    category: categoria,
    description: descricao,
    source: "shortcut",
    rawInput: JSON.stringify(body),
  });

  return c.json({
    ok: true,
    id: tx.id,
    tipo,
    valor,
    conta: acc.name,
    categoria,
    descricao,
  });
}
