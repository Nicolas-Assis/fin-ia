const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.LLM_MODEL || "meta-llama/llama-4-maverick";

export interface ParsedTx {
  tipo: "entrada" | "saida";
  valor: number;
  moeda: string;
  conta: string | null;
  categoria: string;
  descricao: string;
  confianca: number;
}

async function chat(
  messages: { role: string; content: string }[],
  opts: { json?: boolean; temperature?: number } = {},
): Promise<string> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_URL || "https://vercel.app",
      "X-Title": "Fin AI",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: opts.temperature ?? 0.1,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      messages,
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as any;
  return data?.choices?.[0]?.message?.content ?? "";
}

/**
 * Extrai um lançamento financeiro de texto livre.
 * `contas` é a lista de nomes de contas do usuário para o modelo escolher a melhor.
 */
export async function parseTransaction(
  texto: string,
  contas: string[],
): Promise<ParsedTx> {
  const system = `Você é um extrator de lançamentos financeiros pessoais.
Responda SOMENTE com JSON válido (sem markdown, sem comentários) neste formato exato:
{"tipo":"entrada|saida","valor":0,"moeda":"BRL","conta":null,"categoria":"","descricao":"","confianca":0}

Regras:
- tipo: "entrada" para dinheiro que entra (recebimento, salário, venda) e "saida" para gasto/pagamento.
- valor: número positivo com ponto decimal. Ex: 45.90
- moeda: código ISO. Padrão "BRL" se não especificado.
- conta: escolha EXATAMENTE um nome desta lista se houver correspondência, senão null. Lista: [${contas.join(", ") || "nenhuma"}]
- categoria: uma categoria curta em português (ex: Alimentação, Transporte, Moradia, Salário, Vendas, Lazer, Saúde, Assinaturas, Outros).
- descricao: resumo curto e limpo do lançamento.
- confianca: 0 a 1 indicando o quão certo você está da extração.`;

  const raw = await chat(
    [
      { role: "system", content: system },
      { role: "user", content: texto },
    ],
    { json: true, temperature: 0.1 },
  );

  const clean = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(clean) as ParsedTx;

  // saneamento
  parsed.tipo = parsed.tipo === "entrada" ? "entrada" : "saida";
  parsed.valor = Math.abs(Number(parsed.valor)) || 0;
  parsed.moeda = parsed.moeda || "BRL";
  parsed.categoria = parsed.categoria || "Outros";
  parsed.descricao = parsed.descricao || texto.slice(0, 120);
  parsed.confianca = Number(parsed.confianca) || 0;
  return parsed;
}

/** Resumo em linguagem natural para acompanhar o relatório. Nunca lança erro. */
export async function summarize(stats: unknown): Promise<string> {
  try {
    const raw = await chat(
      [
        {
          role: "system",
          content:
            "Você é um analista financeiro pessoal. Com base nos dados JSON, escreva um resumo em português do Brasil, curto (2 a 4 frases), direto, com no máximo 3 destaques relevantes (maior categoria de gasto, saldo, tendência). Não use markdown pesado nem tabelas.",
        },
        { role: "user", content: JSON.stringify(stats) },
      ],
      { json: false, temperature: 0.4 },
    );
    return raw.trim();
  } catch {
    return "";
  }
}
