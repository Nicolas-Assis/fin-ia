import { chatJson, type ChatMsg } from "./llm.js";
import { categoryListForPrompt } from "./categories.js";
import { dayKeyTz, weekdayTz } from "./dates.js";
import { sanitizeLancamentos, type ParsedTx } from "./intents.js";

/**
 * Mídia: transcrição de voz e leitura de comprovantes por foto.
 * Voz usa um modelo de áudio (LLM_AUDIO_MODEL, ex: google/gemini-2.5-flash);
 * foto usa o próprio modelo multimodal do roteador. Ambos reaproveitam o
 * pipeline de sanitização de lançamentos.
 */

const AUDIO_MODEL = process.env.LLM_AUDIO_MODEL || "google/gemini-2.5-flash";

/** Baixa um arquivo do Telegram como base64 (o token nunca sai do servidor). */
export async function fetchTelegramFileB64(
  filePath: string,
): Promise<{ b64: string; mime: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download Telegram ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get("content-type") || "application/octet-stream";
  return { b64: buf.toString("base64"), mime };
}

/** Transcreve um áudio (ogg/opus do Telegram) para texto pt-BR. */
export async function transcribeVoice(b64: string, format = "ogg"): Promise<string> {
  const messages: ChatMsg[] = [
    {
      role: "system",
      content:
        "Transcreva o áudio em português do Brasil. Responda somente com a transcrição, sem comentários.",
    },
    {
      role: "user",
      content: [{ type: "input_audio", input_audio: { data: b64, format } }],
    },
  ];
  const { chat } = await import("./llm.js");
  const raw = await chat(messages, {
    model: AUDIO_MODEL,
    temperature: 0,
    maxTokens: 200,
    timeoutMs: 15_000,
  });
  return raw.trim();
}

/**
 * Extrai lançamentos de uma foto de comprovante/nota. Retorna [] quando a
 * imagem não é um comprovante reconhecível.
 */
export async function extractReceipt(
  b64: string,
  mime: string,
  contas: string[],
  caption?: string,
): Promise<ParsedTx[]> {
  const now = new Date();
  const system = `Você extrai lançamentos financeiros de uma FOTO de comprovante ou nota fiscal (Brasil).
Hoje é ${dayKeyTz(now)} (${weekdayTz(now)}), fuso America/Sao_Paulo.
Contas do usuário: [${contas.join(", ") || "nenhuma"}]
Categorias válidas (escolha SEMPRE uma, grafia idêntica): [${categoryListForPrompt()}]

Responda SOMENTE com JSON válido:
{"comprovante":true,"lancamentos":[{"tipo":"saida","valor":0,"moeda":"BRL","conta":null,"categoria":"","descricao":"","data":null,"confianca":0}]}

Regras:
- Se a imagem NÃO for um comprovante/nota/recibo, responda {"comprovante":false,"lancamentos":[]}.
- valor: use o TOTAL pago, número com ponto decimal.
- descricao: nome do estabelecimento (curto).
- data: a data do comprovante em AAAA-MM-DD se visível e não for hoje; senão null.
- conta: um nome EXATO da lista, ou null.`;

  const userParts: any[] = [
    { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
  ];
  if (caption?.trim()) {
    userParts.push({ type: "text", text: `Contexto do usuário: ${caption.trim()}` });
  }

  const result = await chatJson(
    [
      { role: "system", content: system },
      { role: "user", content: userParts },
    ],
    (v) => (v && typeof v === "object" && "comprovante" in v ? v : null),
    { temperature: 0.1, maxTokens: 600, timeoutMs: 18_000 },
  );

  if (!result.comprovante) return [];
  return sanitizeLancamentos(result.lancamentos, caption || "comprovante");
}
