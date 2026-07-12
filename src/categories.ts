/**
 * Taxonomia canônica de categorias — fonte única da verdade.
 * O LLM é instruído a escolher da lista; normalizeCategory garante no código
 * que nada fora dela chega ao banco (senão os relatórios fragmentam).
 */

export const CATEGORIES = [
  { name: "Alimentação", emoji: "🍽️" },
  { name: "Mercado", emoji: "🛒" },
  { name: "Transporte", emoji: "🚗" },
  { name: "Moradia", emoji: "🏠" },
  { name: "Contas", emoji: "💡" },
  { name: "Saúde", emoji: "🩺" },
  { name: "Educação", emoji: "📚" },
  { name: "Lazer", emoji: "🎉" },
  { name: "Compras", emoji: "🛍️" },
  { name: "Assinaturas", emoji: "📺" },
  { name: "Viagem", emoji: "✈️" },
  { name: "Salário", emoji: "💼" },
  { name: "Vendas", emoji: "🤝" },
  { name: "Investimentos", emoji: "📈" },
  { name: "Outros", emoji: "📦" },
] as const;

export type CategoryName = (typeof CATEGORIES)[number]["name"];

export const CATEGORY_NAMES: CategoryName[] = CATEGORIES.map((c) => c.name);

function deaccent(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

// Chaves já sem acento/minúsculas. Cobre os rótulos que o LLM e usuários
// costumam inventar; o resto cai em "Outros".
const ALIASES: Record<string, CategoryName> = {
  // Alimentação
  comida: "Alimentação", restaurante: "Alimentação", lanche: "Alimentação",
  ifood: "Alimentação", padaria: "Alimentação", pizza: "Alimentação",
  almoco: "Alimentação", jantar: "Alimentação", cafe: "Alimentação",
  delivery: "Alimentação", refeicao: "Alimentação", alimentacao: "Alimentação",
  // Mercado
  supermercado: "Mercado", feira: "Mercado", acougue: "Mercado",
  hortifruti: "Mercado", sacolao: "Mercado", atacado: "Mercado",
  // Transporte
  uber: "Transporte", "99": "Transporte", taxi: "Transporte",
  gasolina: "Transporte", combustivel: "Transporte", posto: "Transporte",
  estacionamento: "Transporte", pedagio: "Transporte", onibus: "Transporte",
  metro: "Transporte", carro: "Transporte", moto: "Transporte",
  // Moradia
  aluguel: "Moradia", condominio: "Moradia", iptu: "Moradia",
  reforma: "Moradia", manutencao: "Moradia", casa: "Moradia",
  // Contas
  luz: "Contas", agua: "Contas", internet: "Contas", telefone: "Contas",
  energia: "Contas", celular: "Contas", gas: "Contas", boleto: "Contas",
  "contas & servicos": "Contas", "contas e servicos": "Contas", servicos: "Contas",
  // Saúde
  farmacia: "Saúde", medico: "Saúde", dentista: "Saúde", remedio: "Saúde",
  academia: "Saúde", consulta: "Saúde", exame: "Saúde", "plano de saude": "Saúde",
  // Educação
  curso: "Educação", cursos: "Educação", escola: "Educação",
  faculdade: "Educação", livro: "Educação", livros: "Educação",
  mensalidade: "Educação",
  // Lazer
  cinema: "Lazer", bar: "Lazer", festa: "Lazer", balada: "Lazer",
  show: "Lazer", jogo: "Lazer", jogos: "Lazer", passeio: "Lazer",
  entretenimento: "Lazer",
  // Compras
  roupa: "Compras", roupas: "Compras", vestuario: "Compras",
  calcado: "Compras", tenis: "Compras", eletronicos: "Compras",
  presente: "Compras", presentes: "Compras", shopping: "Compras",
  // Assinaturas
  netflix: "Assinaturas", spotify: "Assinaturas", streaming: "Assinaturas",
  assinatura: "Assinaturas", disney: "Assinaturas", prime: "Assinaturas",
  // Viagem
  hotel: "Viagem", passagem: "Viagem", passagens: "Viagem",
  airbnb: "Viagem", turismo: "Viagem", viagens: "Viagem",
  // Salário
  salario: "Salário", pagamento: "Salário", freela: "Salário",
  freelance: "Salário", renda: "Salário", "renda extra": "Salário",
  // Vendas
  venda: "Vendas",
  // Investimentos
  aporte: "Investimentos", acao: "Investimentos", acoes: "Investimentos",
  cripto: "Investimentos", bitcoin: "Investimentos",
  rendimento: "Investimentos", rendimentos: "Investimentos",
  dividendos: "Investimentos", poupanca: "Investimentos",
  // Outros
  outro: "Outros", geral: "Outros", diversos: "Outros",
};

const CANONICAL_BY_KEY = new Map<string, CategoryName>(
  CATEGORIES.map((c) => [deaccent(c.name), c.name]),
);

/** Mapeia qualquer rótulo para a categoria canônica; fallback "Outros". */
export function normalizeCategory(raw: string | null | undefined): CategoryName {
  const key = deaccent(String(raw ?? ""));
  if (!key) return "Outros";
  return CANONICAL_BY_KEY.get(key) ?? ALIASES[key] ?? "Outros";
}

export function categoryEmoji(name: string): string {
  const canonical = normalizeCategory(name);
  return CATEGORIES.find((c) => c.name === canonical)?.emoji ?? "📦";
}

/** Lista para injetar em prompts: "Alimentação, Mercado, …". */
export function categoryListForPrompt(): string {
  return CATEGORY_NAMES.join(", ");
}

/**
 * Chuta a categoria a partir de um texto livre ("posto de gasolina" →
 * Transporte) varrendo palavra a palavra na tabela de aliases. Barato — evita
 * uma chamada de LLM só para classificar (ex: modo estruturado do Atalho iOS).
 */
export function guessCategory(text: string | null | undefined): CategoryName {
  const whole = deaccent(String(text ?? ""));
  if (!whole) return "Outros";
  const direct = CANONICAL_BY_KEY.get(whole) ?? ALIASES[whole];
  if (direct) return direct;
  for (const word of whole.split(/[^a-z0-9]+/)) {
    if (!word) continue;
    const hit = CANONICAL_BY_KEY.get(word) ?? ALIASES[word];
    if (hit) return hit;
  }
  return "Outros";
}
