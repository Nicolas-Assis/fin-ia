import { chatJson, type ChatMsg } from "./llm.js";
import {
  categoryListForPrompt,
  normalizeCategory,
} from "./categories.js";
import { dayKeyTz, fromLocalDateString, weekdayTz } from "./dates.js";
import { parseAmountBR } from "./money.js";

/**
 * Roteador unificado: UMA chamada de LLM classifica a mensagem
 * (registrar | pergunta | conversa) E extrai os dados. Registrar continua
 * custando 1 round-trip; perguntas custam 2 (rotear → responder com dados).
 */

export type Intent = "registrar" | "pergunta" | "conversa";

export interface ParsedTx {
  tipo: "entrada" | "saida";
  /** Valor em reais (como o LLM devolve). */
  valor: number;
  /** Valor em centavos — use este no código. */
  valorCents: number;
  moeda: string;
  conta: string | null;
  categoria: string;
  descricao: string;
  /** "YYYY-MM-DD" local quando retroativo ("ontem", "dia 5"); null = agora. */
  data: string | null;
  confianca: number;
}

export interface QueryPlan {
  periodos: string[]; // "hoje" | "ontem" | "semana" | "mes" | "mes-anterior" | "AAAA-MM"
  categorias: string[] | null;
  contas: string[] | null;
}

export interface RouteResult {
  intencao: Intent;
  lancamentos: ParsedTx[];
  pergunta: QueryPlan | null;
  resposta: string | null;
}

const PERIOD_RE = /^(hoje|ontem|semana|mes|mes-anterior|\d{4}-\d{2})$/;
const MAX_ITEMS = 5;

export function routerSystemPrompt(contas: string[]): string {
  const now = new Date();
  return `Você é o roteador do Fin AI, um assistente de finanças pessoais no Telegram (português do Brasil).
Hoje é ${dayKeyTz(now)} (${weekdayTz(now)}), fuso America/Sao_Paulo.
Contas do usuário: [${contas.join(", ") || "nenhuma"}]
Categorias válidas (use SEMPRE exatamente uma, com grafia idêntica):
[${categoryListForPrompt()}]

Classifique a mensagem e extraia os dados. Responda SOMENTE com JSON válido, sem markdown:
{"intencao":"registrar|pergunta|conversa",
 "lancamentos":[{"tipo":"entrada|saida","valor":0,"moeda":"BRL","conta":null,"categoria":"","descricao":"","data":null,"confianca":0}],
 "pergunta":{"periodos":["mes"],"categorias":null,"contas":null},
 "resposta":null}

Regras:
- "registrar": o usuário informa um gasto ou recebimento para anotar. Preencha "lancamentos" — pode ter MAIS DE UM item se a mensagem citar vários valores.
- "pergunta": o usuário quer consultar os próprios dados (quanto gastou, comparações, maior gasto, saldo...). Preencha "pergunta". Períodos válidos: "hoje", "ontem", "semana", "mes", "mes-anterior" ou "AAAA-MM". Sem período citado → ["mes"].
- "conversa": saudação, agradecimento, dúvida de uso ou assunto fora de finanças. Preencha "resposta" com uma resposta curta e simpática (máx. 2 frases); se for dúvida de uso, explique que é só escrever o gasto em texto livre, ou indicar /ajuda.
- valor: número positivo com ponto decimal. Interprete: "cinquenta"=50; "2k"/"2 mil"=2000; "1,5 mil"=1500; "1.234,56"=1234.56.
- Parcelado ("3x de 80", "240 em 3x"): registre o valor TOTAL e acrescente "(3x)" à descricao.
- data: null se for hoje. "ontem", "anteontem", dia da semana ("sexta" = a última sexta que já passou) ou data explícita ("dia 5", "05/07") → converta para AAAA-MM-DD usando a data de hoje. Nunca data futura.
- conta: apenas um nome EXATO da lista de contas; caso contrário null. "pix"/"cartão"/"crédito" sozinhos NÃO são contas.
- confianca: 0 a 1. Use valor menor que 0.6 quando houver dúvida sobre valor, tipo ou categoria.
- Se parecer um registro mas NÃO houver valor identificável, use "registrar" com "lancamentos": [].`;
}

/** Few-shots como pares user/assistant — mais confiável que exemplos no system. */
function fewShots(contas: string[]): ChatMsg[] {
  const now = new Date();
  const hoje = dayKeyTz(now);
  const ontem = dayKeyTz(new Date(now.getTime() - 86_400_000));
  const temNubank = contas.some((c) => /nubank/i.test(c));
  const temItau = contas.some((c) => /ita/i.test(c));
  const nubank = temNubank ? contas.find((c) => /nubank/i.test(c))! : null;
  const itau = temItau ? contas.find((c) => /ita/i.test(c))! : null;

  const pair = (user: string, out: object): ChatMsg[] => [
    { role: "user", content: user },
    { role: "assistant", content: JSON.stringify(out) },
  ];
  const reg = (lancamentos: object[]) => ({
    intencao: "registrar",
    lancamentos,
    pergunta: null,
    resposta: null,
  });
  const tx = (o: object) => ({
    tipo: "saida",
    valor: 0,
    moeda: "BRL",
    conta: null,
    categoria: "Outros",
    descricao: "",
    data: null,
    confianca: 0.9,
    ...o,
  });

  return [
    ...pair(
      "gastei 45 no posto no nubank",
      reg([tx({ valor: 45, categoria: "Transporte", conta: nubank, descricao: "posto de gasolina", confianca: 0.95 })]),
    ),
    ...pair(
      "cinquenta de pizza ontem no crédito",
      reg([tx({ valor: 50, categoria: "Alimentação", descricao: "pizza", data: ontem, confianca: 0.85 })]),
    ),
    ...pair(
      "recebi 2k do freela no itau",
      reg([tx({ tipo: "entrada", valor: 2000, categoria: "Salário", conta: itau, descricao: "freela", confianca: 0.9 })]),
    ),
    ...pair(
      "mercado 1.234,56",
      reg([tx({ valor: 1234.56, categoria: "Mercado", descricao: "mercado", confianca: 0.85 })]),
    ),
    ...pair(
      "50 no mercado e 30 na farmácia",
      reg([
        tx({ valor: 50, categoria: "Mercado", descricao: "mercado", confianca: 0.9 }),
        tx({ valor: 30, categoria: "Saúde", descricao: "farmácia", confianca: 0.9 }),
      ]),
    ),
    ...pair(
      "comprei um fone de 240 em 3x",
      reg([tx({ valor: 240, categoria: "Compras", descricao: "fone de ouvido (3x)", confianca: 0.85 })]),
    ),
    ...pair("quanto gastei com mercado esse mês?", {
      intencao: "pergunta",
      lancamentos: [],
      pergunta: { periodos: ["mes"], categorias: ["Mercado"], contas: null },
      resposta: null,
    }),
    ...pair("compara esse mês com o mês passado", {
      intencao: "pergunta",
      lancamentos: [],
      pergunta: { periodos: ["mes", "mes-anterior"], categorias: null, contas: null },
      resposta: null,
    }),
    ...pair("oi, tudo bem?", {
      intencao: "conversa",
      lancamentos: [],
      pergunta: null,
      resposta: "Tudo ótimo! 😄 Me conta um gasto ou pergunta quanto você já gastou no mês.",
    }),
    ...pair("acho que gastei alguma coisa no uber semana passada", {
      intencao: "registrar",
      lancamentos: [],
      pergunta: null,
      resposta: null,
    }),
  ];
}

function sanitizeLancamento(raw: any, texto: string, hoje: string): ParsedTx | null {
  if (!raw || typeof raw !== "object") return null;

  let valorCents: number | null = null;
  if (typeof raw.valor === "number" && Number.isFinite(raw.valor)) {
    valorCents = Math.round(Math.abs(raw.valor) * 100);
  } else if (raw.valor != null) {
    valorCents = parseAmountBR(String(raw.valor));
  }
  if (!valorCents || valorCents <= 0) return null;

  let data: string | null = null;
  if (typeof raw.data === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.data)) {
    const parsed = fromLocalDateString(raw.data);
    const min = dayKeyTz(new Date(Date.now() - 365 * 86_400_000));
    // Defesa extra sobre o prompt: nada no futuro nem mais velho que 1 ano.
    if (parsed && raw.data <= hoje && raw.data >= min && raw.data !== hoje) {
      data = raw.data;
    }
  }

  const confianca = Number(raw.confianca);
  return {
    tipo: raw.tipo === "entrada" ? "entrada" : "saida",
    valor: valorCents / 100,
    valorCents,
    moeda: (typeof raw.moeda === "string" && raw.moeda.trim().toUpperCase()) || "BRL",
    conta: typeof raw.conta === "string" && raw.conta.trim() ? raw.conta.trim() : null,
    categoria: normalizeCategory(raw.categoria),
    descricao:
      (typeof raw.descricao === "string" && raw.descricao.trim()) ||
      texto.slice(0, 120),
    data,
    confianca: Number.isFinite(confianca) ? Math.max(0, Math.min(1, confianca)) : 0.5,
  };
}

function sanitizeQueryPlan(raw: any): QueryPlan {
  const periodos = (Array.isArray(raw?.periodos) ? raw.periodos : [])
    .filter((p: any) => typeof p === "string" && PERIOD_RE.test(p))
    .slice(0, 2);
  const strArr = (v: any): string[] | null => {
    if (!Array.isArray(v)) return null;
    const out = v.filter((x: any) => typeof x === "string" && x.trim()).map((x: string) => x.trim());
    return out.length ? out : null;
  };
  return {
    periodos: periodos.length ? periodos : ["mes"],
    categorias: strArr(raw?.categorias),
    contas: strArr(raw?.contas),
  };
}

/** Sanitiza uma lista crua de lançamentos vinda do LLM (roteador, recibos…). */
export function sanitizeLancamentos(rawList: any, texto: string): ParsedTx[] {
  const hoje = dayKeyTz(new Date());
  return (Array.isArray(rawList) ? rawList : [])
    .slice(0, MAX_ITEMS)
    .map((l: any) => sanitizeLancamento(l, texto, hoje))
    .filter((l: ParsedTx | null): l is ParsedTx => l !== null);
}

/** Classifica e extrai. Lança LlmError em falha de comunicação/formato. */
export async function routeMessage(
  texto: string,
  opts: { contas: string[] },
): Promise<RouteResult> {
  const messages: ChatMsg[] = [
    { role: "system", content: routerSystemPrompt(opts.contas) },
    ...fewShots(opts.contas),
    { role: "user", content: texto },
  ];

  const raw = await chatJson(
    messages,
    (v) =>
      v && ["registrar", "pergunta", "conversa"].includes(v.intencao) ? v : null,
    { temperature: 0.1, maxTokens: 800, timeoutMs: 12_000 },
  );

  const lancamentos =
    raw.intencao === "registrar"
      ? sanitizeLancamentos(raw.lancamentos, texto)
      : [];

  return {
    intencao: raw.intencao,
    lancamentos,
    pergunta: raw.intencao === "pergunta" ? sanitizeQueryPlan(raw.pergunta) : null,
    resposta:
      raw.intencao === "conversa" && typeof raw.resposta === "string"
        ? raw.resposta.slice(0, 500)
        : null,
  };
}

/**
 * Compat com o Atalho iOS: extrai UM lançamento de texto livre.
 * Sem valor identificável devolve valor 0 (o chamador trata como inválido),
 * espelhando o comportamento antigo.
 */
export async function parseTransaction(
  texto: string,
  contas: string[],
): Promise<ParsedTx> {
  const r = await routeMessage(texto, { contas });
  if (r.lancamentos.length > 0) return r.lancamentos[0];
  return {
    tipo: "saida",
    valor: 0,
    valorCents: 0,
    moeda: "BRL",
    conta: null,
    categoria: "Outros",
    descricao: texto.slice(0, 120),
    data: null,
    confianca: 0,
  };
}
