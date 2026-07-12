import type { ReportData } from "./report.js";
import { cacheGet, cacheSet } from "./cache.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const MODEL = process.env.LLM_MODEL || "meta-llama/llama-4-maverick";

export class LlmError extends Error {}

/** Mensagem amigável pt-BR para qualquer falha de LLM. */
export const LLM_USER_ERROR =
  "😵 Tive um problema para pensar agora. Tenta de novo em alguns segundos?";

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
}

export interface ChatOpts {
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  model?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Chamada ao OpenRouter com timeout (AbortController), 1 retry em rede/429/5xx
 * e max_tokens sempre definido — nada de chamadas sem teto em serverless.
 */
export async function chat(
  messages: ChatMsg[],
  opts: ChatOpts = {},
): Promise<string> {
  const {
    json = false,
    temperature = 0.1,
    maxTokens = 600,
    timeoutMs = 12_000,
    retries = 1,
    model = MODEL,
  } = opts;

  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        signal: ac.signal,
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_URL || "https://vercel.app",
          "X-Title": "Fin AI",
        },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxTokens,
          ...(json ? { response_format: { type: "json_object" } } : {}),
          messages,
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        throw new LlmError(`OpenRouter ${res.status}: ${bodyText.slice(0, 300)}`);
      }
      const data = (await res.json()) as any;
      return data?.choices?.[0]?.message?.content ?? "";
    } catch (e: any) {
      if (e instanceof LlmError) throw e;
      if (attempt < retries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw new LlmError(
        e?.name === "AbortError"
          ? `LLM timeout após ${timeoutMs}ms`
          : `LLM falhou: ${e?.message ?? e}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Extrai o objeto JSON de uma resposta que pode vir com cercas/texto em volta. */
export function extractJsonObject(raw: string): string {
  const clean = raw.replace(/```json/gi, "```").replace(/```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  return start >= 0 && end > start ? clean.slice(start, end + 1) : clean;
}

/**
 * chat() em modo JSON + validação. Se o JSON vier inválido/fora do formato,
 * faz UMA rodada de reparo pedindo a correção; depois desiste com LlmError.
 * `validate` deve devolver o valor tipado ou null quando o formato não serve.
 */
export async function chatJson<T>(
  messages: ChatMsg[],
  validate: (v: any) => T | null,
  opts: ChatOpts = {},
): Promise<T> {
  const raw = await chat(messages, { ...opts, json: true });
  try {
    const ok = validate(JSON.parse(extractJsonObject(raw)));
    if (ok !== null) return ok;
  } catch {
    // cai no reparo
  }
  const repaired = await chat(
    [
      ...messages,
      { role: "assistant", content: raw },
      {
        role: "user",
        content:
          "A resposta anterior não está no formato JSON pedido. Corrija e responda SOMENTE com o JSON válido, sem nenhum outro texto.",
      },
    ],
    { ...opts, json: true },
  );
  let parsed: any;
  try {
    parsed = JSON.parse(extractJsonObject(repaired));
  } catch {
    throw new LlmError("Resposta da IA não é JSON válido (mesmo após reparo).");
  }
  const ok = validate(parsed);
  if (ok === null) throw new LlmError("Resposta da IA fora do formato esperado.");
  return ok;
}

// ---------------------------------------------------------------- Resumo

/** Hash curto (djb2) para chavear o cache pelo conteúdo dos dados. */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Projeção enxuta do relatório — o resumo não precisa de cada transação. */
function summaryProjection(d: ReportData) {
  return {
    periodo: d.periodo,
    totalEntradas: d.totalEntradas,
    totalSaidas: d.totalSaidas,
    resultado: d.resultado,
    taxaPoupanca: Math.round(d.taxaPoupanca),
    ticketMedioSaida: d.ticketMedioSaida,
    maiorGasto: d.maiorGasto,
    lancamentos: d.countTx,
    porCategoria: d.porCategoria.slice(0, 8).map((c) => ({
      categoria: c.categoria,
      total: c.total,
      pct: Math.round(c.pct),
    })),
    porConta: d.porConta,
    topGastos: d.topGastos.slice(0, 5).map((t) => ({
      descricao: t.descricao.slice(0, 40),
      categoria: t.categoria,
      valor: t.valor,
    })),
    saldoTotal: d.saldoTotal,
  };
}

/**
 * Resumo em linguagem natural do relatório. Cacheado por (usuário, período,
 * hash dos dados) por 6h — o hash muda quando entra lançamento novo. Nunca lança.
 */
export async function summarize(
  userId: string,
  stats: ReportData,
): Promise<string> {
  const cacheKey = `resumo:${userId}:${stats.periodo}:${shortHash(
    `${stats.countTx}:${stats.totalEntradas}:${stats.totalSaidas}`,
  )}`;
  try {
    const cached = await cacheGet(cacheKey);
    if (cached !== null) return cached;

    const raw = await chat(
      [
        {
          role: "system",
          content:
            "Você é um analista financeiro pessoal. Com base nos dados JSON, escreva um resumo em português do Brasil, curto (2 a 4 frases), direto, com no máximo 3 destaques relevantes (maior categoria de gasto, saldo, tendência). Não use markdown pesado nem tabelas.",
        },
        { role: "user", content: JSON.stringify(summaryProjection(stats)) },
      ],
      { json: false, temperature: 0.4, maxTokens: 220, timeoutMs: 10_000 },
    );
    const text = raw.trim();
    if (text) await cacheSet(cacheKey, text, 6 * 3600);
    return text;
  } catch {
    return "";
  }
}
