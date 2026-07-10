import type { Context } from "hono";
import { parseTransaction } from "./llm.js";
import {
  createTransaction,
  listAccountNames,
  resolveAccount,
} from "./transactions.js";
import { resolveUserForShortcut } from "./users.js";

/**
 * POST /api/shortcut
 * Header: x-api-key: <SHORTCUT_API_KEY>
 * Body (uma das formas):
 *   { "texto": "gastei 45 no posto no nubank" }
 *   { "tipo": "saida", "valor": 45.9, "conta": "Nubank", "descricao": "posto" }
 */
export async function handleShortcut(c: Context) {
  const key = c.req.header("x-api-key");

  // ── Auth (chave pessoal identifica QUEM está lançando) ──────────────────────
  if (!key) {
    console.warn("[shortcut] 401 – header x-api-key ausente");
    return c.json(
      { error: "unauthorized", detail: "header x-api-key não enviado" },
      401,
    );
  }
  const user = await resolveUserForShortcut(key);
  if (!user) {
    console.warn("[shortcut] 401 – x-api-key não corresponde a nenhum usuário ativo");
    return c.json(
      {
        error: "unauthorized",
        detail: "x-api-key inválida. Pegue sua chave pessoal com /atalho no bot.",
      },
      401,
    );
  }
  console.log("[shortcut] usuário:", user.name || user.telegramId);

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
  const contas = await listAccountNames(user.id);
  console.log("[shortcut] contas do usuário:", contas);
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
    // Aceita: valor, value, amount, quantia
    const rawValor =
      body.valor ?? body.value ?? body.amount ?? body.quantia ?? "";
    valor = Math.abs(Number(String(rawValor).replace(",", "."))) || 0;
    // Aceita: conta, account, cartao
    contaHint = body.conta ?? body.account ?? body.cartao ?? null;
    descricao = body.descricao ?? body.description ?? body.desc ?? "";

    // Fallback: se valor não é número válido (ex: iOS mandou o texto da variável errado),
    // monta um texto e deixa o LLM parsear tudo.
    if (!valor || valor <= 0) {
      const textoFallback =
        [
          body.tipo && !/^(entrada|saida)$/i.test(body.tipo) ? body.tipo : null,
          descricao || null,
          contaHint ? `no ${contaHint}` : null,
        ]
          .filter(Boolean)
          .join(" ") || JSON.stringify(body);

      console.warn(
        "[shortcut] valor inválido no modo estruturado, tentando LLM com:",
        textoFallback,
      );
      try {
        const p = await parseTransaction(textoFallback, contas);
        tipo = p.tipo;
        valor = p.valor;
        contaHint = p.conta ?? contaHint;
        categoria = p.categoria;
        descricao = p.descricao;
        console.log("[shortcut] LLM fallback parseou:", JSON.stringify(p));
      } catch (e: any) {
        console.error("[shortcut] LLM fallback falhou:", e?.message);
        return c.json(
          {
            error:
              "valor inválido e não foi possível interpretar automaticamente",
            body_recebido: body,
            dica: 'Envie { "valor": 45.90 } com número, ou use { "texto": "gastei 45 no posto" }',
          },
          422,
        );
      }
    } else {
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
        detail: `valor recebido: ${body.valor ?? body.value ?? body.amount ?? "(campo não encontrado)"} → parseado: ${valor}`,
        body_recebido: body,
        dica: "Envie o campo 'valor' com número positivo. Ex: { \"valor\": 45.90 }",
      },
      422,
    );
  }

  const acc = await resolveAccount(user.id, contaHint);
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
