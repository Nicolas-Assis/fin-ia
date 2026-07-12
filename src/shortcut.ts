import type { Context } from "hono";
import { parseTransaction } from "./intents.js";
import {
  createTransaction,
  listAccounts,
  resolveAccountFrom,
} from "./transactions.js";
import { resolveUserForShortcut } from "./users.js";
import { parseAmountBR, type Cents } from "./money.js";
import { guessCategory, normalizeCategory } from "./categories.js";
import { fromLocalDateString } from "./dates.js";

/**
 * POST /api/shortcut
 * Header: x-api-key: <chave pessoal>
 * Body (uma das formas):
 *   { "texto": "gastei 45 no posto no nubank" }
 *   { "tipo": "saida", "valor": 45.9, "conta": "Nubank", "descricao": "posto", "data": "2026-07-10" }
 */
export async function handleShortcut(c: Context) {
  const key = c.req.header("x-api-key");
  if (!key) {
    return c.json({ error: "unauthorized", detail: "header x-api-key não enviado" }, 401);
  }
  const user = await resolveUserForShortcut(key);
  if (!user) {
    return c.json(
      { error: "unauthorized", detail: "x-api-key inválida. Pegue sua chave com /atalho no bot." },
      401,
    );
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch (e: any) {
    return c.json({ error: "json inválido", detail: e?.message }, 400);
  }

  const accs = await listAccounts(user.id);
  if (accs.length === 0) {
    return c.json(
      {
        error: "nenhuma conta cadastrada",
        detail: "Crie uma conta com /addconta no Telegram antes de usar o Atalho",
      },
      422,
    );
  }

  let tipo: "entrada" | "saida";
  let valorCents: Cents;
  let contaHint: string | null;
  let categoria: string;
  let descricao: string;
  let occurredAt: Date | undefined;

  if (body.texto) {
    try {
      const p = await parseTransaction(String(body.texto), accs.map((a) => a.name));
      tipo = p.tipo;
      valorCents = p.valorCents;
      contaHint = p.conta;
      categoria = p.categoria;
      descricao = p.descricao;
      occurredAt = p.data ? fromLocalDateString(p.data) ?? undefined : undefined;
    } catch (e: any) {
      return c.json({ error: "erro ao interpretar texto", detail: e?.message }, 500);
    }
  } else {
    tipo = body.tipo === "entrada" ? "entrada" : "saida";
    const rawValor = body.valor ?? body.value ?? body.amount ?? body.quantia ?? "";
    valorCents = parseAmountBR(rawValor) ?? 0;
    contaHint = body.conta ?? body.account ?? body.cartao ?? null;
    descricao = body.descricao ?? body.description ?? body.desc ?? "";
    const rawData = body.data ?? body.occurredAt ?? null;
    occurredAt = rawData ? fromLocalDateString(String(rawData)) ?? undefined : undefined;

    if (!valorCents || valorCents <= 0) {
      // Fallback: valor ininteligível → monta um texto e deixa o LLM parsear tudo.
      const textoFallback =
        [
          body.tipo && !/^(entrada|saida)$/i.test(body.tipo) ? body.tipo : null,
          descricao || null,
          contaHint ? `no ${contaHint}` : null,
        ]
          .filter(Boolean)
          .join(" ") || JSON.stringify(body);
      try {
        const p = await parseTransaction(textoFallback, accs.map((a) => a.name));
        tipo = p.tipo;
        valorCents = p.valorCents;
        contaHint = p.conta ?? contaHint;
        categoria = p.categoria;
        descricao = p.descricao;
        occurredAt = p.data ? fromLocalDateString(p.data) ?? undefined : occurredAt;
      } catch {
        return c.json(
          {
            error: "valor inválido e não foi possível interpretar automaticamente",
            body_recebido: body,
            dica: 'Envie { "valor": 45.90 } com número, ou { "texto": "gastei 45 no posto" }',
          },
          422,
        );
      }
    } else {
      // Categoria por heurística local — sem gastar uma chamada de LLM só p/ isso.
      categoria = body.categoria
        ? normalizeCategory(body.categoria)
        : guessCategory(descricao);
    }
  }

  if (!valorCents || valorCents <= 0) {
    return c.json(
      { error: "valor inválido", detail: `parseado: ${valorCents}`, body_recebido: body },
      422,
    );
  }

  const acc = resolveAccountFrom(accs, contaHint);
  if (!acc) {
    return c.json(
      { error: "conta não encontrada", detail: `hint: "${contaHint}"`, contas: accs.map((a) => a.name) },
      422,
    );
  }

  const tx = await createTransaction({
    accountId: acc.id,
    type: tipo,
    amountCents: valorCents,
    currency: acc.currency,
    category: categoria!,
    description: descricao,
    source: "shortcut",
    rawInput: JSON.stringify(body),
    occurredAt,
  });

  return c.json({
    ok: true,
    id: tx.id,
    tipo,
    valor: valorCents / 100,
    conta: acc.name,
    categoria: categoria!,
    descricao,
  });
}
