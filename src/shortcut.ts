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

  // ── Auth ──────────────────────────────────────────────────────────────────
  if (!key) {
    console.warn("[shortcut] 401 – header x-api-key ausente");
    return c.json(
      { error: "unauthorized", detail: "header x-api-key não enviado" },
      401,
    );
  }
  if (key !== process.env.SHORTCUT_API_KEY) {
    console.warn("[shortcut] 401 – x-api-key incorreto:", key);
    return c.json(
      { error: "unauthorized", detail: "x-api-key incorreto" },
      401,
    );
  }

  // ── Body ──────────────────────────────────────────────────────────────────
  let body: any;
  try {
    body = await c.req.json();
  } catch (e: any) {
    console.warn("[shortcut] 400 – body inválido:", e?.message);
    return c.json({ error: "json inválido", detail: e?.message }, 400);
  }
  console.log("[shortcut] body recebido:", JSON.stringify(body));

  // ── Contas ────────────────────────────────────────────────────────────────
  const contas = await listAccountNames();
  console.log("[shortcut] contas no banco:", contas);
  if (contas.length === 0) {
    console.warn("[shortcut] 422 – nenhuma conta cadastrada");
    return c.json(
      {
        error: "nenhuma conta cadastrada",
        detail:
          "Crie uma conta com /addconta no Telegram antes de usar o Shortcut",
      },
      422,
    );
  }

  // ── Parse ─────────────────────────────────────────────────────────────────
  let tipo: "entrada" | "saida";
  let valor: number;
  let contaHint: string | null;
  let categoria: string;
  let descricao: string;

  if (body.texto) {
    console.log("[shortcut] modo texto:", body.texto);
    try {
      const p = await parseTransaction(String(body.texto), contas);
      console.log("[shortcut] LLM parseou:", JSON.stringify(p));
      tipo = p.tipo;
      valor = p.valor;
      contaHint = p.conta;
      categoria = p.categoria;
      descricao = p.descricao;
    } catch (e: any) {
      console.error("[shortcut] 500 – erro no LLM:", e?.message);
      return c.json(
        { error: "erro ao interpretar texto", detail: e?.message },
        500,
      );
    }
  } else {
    tipo = body.tipo === "entrada" ? "entrada" : "saida";
    valor = Math.abs(Number(String(body.valor ?? "").replace(",", "."))) || 0;
    contaHint = body.conta ?? null;
    descricao = body.descricao ?? "";
    console.log(
      "[shortcut] modo estruturado – tipo:",
      tipo,
      "valor:",
      valor,
      "conta:",
      contaHint,
      "descricao:",
      descricao,
    );
    if (descricao) {
      try {
        const p = await parseTransaction(
          `${tipo} ${valor} ${descricao}`,
          contas,
        );
        categoria = p.categoria;
      } catch {
        categoria = "Outros";
      }
    } else {
      categoria = body.categoria ?? "Outros";
    }
  }

  // ── Validações ────────────────────────────────────────────────────────────
  if (!valor || valor <= 0) {
    console.warn(
      "[shortcut] 422 – valor inválido:",
      valor,
      "body.valor =",
      body.valor,
    );
    return c.json(
      {
        error: "valor inválido",
        detail: `valor recebido: ${body.valor} → parseado: ${valor}`,
      },
      422,
    );
  }

  const acc = await resolveAccount(contaHint);
  console.log(
    "[shortcut] conta resolvida:",
    acc?.name ?? null,
    "hint =",
    contaHint,
  );
  if (!acc) {
    console.warn(
      "[shortcut] 422 – conta não encontrada. hint =",
      contaHint,
      "contas disponíveis:",
      contas,
    );
    return c.json(
      {
        error: "conta não encontrada",
        detail: `hint recebido: "${contaHint}"`,
        contas,
      },
      422,
    );
  }

  // ── Salva ─────────────────────────────────────────────────────────────────
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
  console.log("[shortcut] transação criada:", tx.id);

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
