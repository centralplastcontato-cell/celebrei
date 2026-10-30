// Campos estruturados do cadastro do buffet para a IA (modal Configurar IA e
// questionário). São serializados em texto rotulado dentro de
// extra_instructions ("Endereço: ...\nDuração da festa: ...") — o mesmo texto
// que vai para o prompt da IA — e desserializados de volta ao abrir o modal.
// "select" é para perguntas objetivas (2-4 respostas fixas, sem valor/promessa);
// "text"/"textarea" continuam livres para o que só cada buffet sabe descrever.
export interface BuffetField {
  key: string;
  label: string;
  type: "text" | "textarea" | "select";
  placeholder?: string;
  options?: string[];
  group: string;
  hint?: string;
  /** Sugestões para tocar (Sobre o buffet): um toque acrescenta no campo, outro tira */
  suggestions?: string[];
  /** Como as sugestões se juntam: itens de lista (", ") ou frases (" ") */
  joiner?: ", " | " ";
}

export const BUFFET_FIELDS: BuffetField[] = [
  // Promoção: tela própria (Configurações → IA → Promoção), uma linha no formato de src/lib/aiPromotion.ts.
  // Fica em 1º lugar para a IA achar esta antes de alguma promoção antiga escrita em "Outras informações".
  { key: "promocao", label: "Promoção", type: "textarea", group: "promo" },
  { key: "endereco", label: "Endereço", type: "text", placeholder: "Rua X, 123 — Sorocaba/SP", group: "basico" },
  { key: "duracao", label: "Duração da festa", type: "text", placeholder: "3 horas", group: "basico" },
  { key: "faixa_etaria", label: "Faixa etária", type: "text", placeholder: "Crianças de 1 a 12 anos", group: "basico" },
  { key: "estrutura", label: "Estrutura e brinquedos", type: "textarea", placeholder: "Cama elástica, piscina de bolinhas, arena de games, fraldário, área para os pais...", group: "estrutura", hint: "O que o espaço tem — é daqui que a IA responde \"o que tem aí?\"", joiner: ", ", suggestions: ["Salão climatizado", "Brinquedão", "Cama elástica", "Piscina de bolinhas", "Tobogã", "Arena de games", "Área baby", "Fraldário", "Espaço para os pais", "Pista de dança", "Cozinha própria"] },
  { key: "diferenciais", label: "Diferenciais", type: "textarea", placeholder: "9 anos de tradição, +4.000 festas realizadas, nota 4,7 no Google, estacionamento próprio...", group: "estrutura", hint: "Argumentos que a IA usa para convencer e quebrar objeções", joiner: ", ", suggestions: ["Anos de tradição (diga quantos)", "Milhares de festas realizadas", "Ótima avaliação no Google", "Monitores acompanhando as crianças", "Cardápio feito na hora pela nossa cozinha", "Uma festa por vez no salão", "Atendimento personalizado do começo ao fim", "Estacionamento próprio", "Segurança e limpeza em todos os brinquedos"] },
  // Perguntas rápidas: as mesmas que todo cliente faz no WhatsApp, com poucas
  // respostas possíveis. Nunca incluem valor/desconto — a IA nunca fala preço.
  { key: "comida_externa", label: "Pode levar comida/bolo de fora?", type: "select", options: ["À vontade", "Só bolo e doces", "Não, é tudo do buffet"], group: "perguntas" },
  { key: "bebida_alcoolica", label: "Bebida alcoólica", type: "select", options: ["Servimos", "Não servimos", "Só os pais podem trazer, com taxa rolha (equipe informa o valor)", "Só os pais podem trazer, sem taxa"], group: "perguntas" },
  { key: "espaco_coberto", label: "O espaço é coberto (funciona com chuva)?", type: "select", options: ["Totalmente coberto", "Parcialmente coberto", "Ao ar livre"], group: "perguntas" },
  { key: "estacionamento", label: "Estacionamento", type: "select", options: ["Vaga própria grátis", "Vaga própria paga", "Só na rua", "Não tem"], group: "perguntas" },
  { key: "acessibilidade", label: "Acessibilidade (cadeirante)", type: "select", options: ["Sim, rampa e banheiro adaptado", "Parcial", "Não"], group: "perguntas" },
  { key: "hora_extra", label: "Hora extra", type: "select", options: ["Dá para estender, a equipe combina", "Não é possível"], group: "perguntas" },
  { key: "fraldario", label: "Área para bebês/fraldário", type: "select", options: ["Sim", "Não"], group: "perguntas" },
  { key: "fotografo", label: "Fotógrafo/filmagem", type: "select", options: ["O buffet oferece, incluso na festa", "O buffet indica um parceiro (pais contratam e pagam)", "É por conta da família, sem indicação", "Não oferecemos nem indicamos"], group: "perguntas" },
  { key: "animal", label: "Animal de estimação", type: "select", options: ["Pode levar", "Não pode"], group: "perguntas" },
  { key: "monitores", label: "Monitores acompanhando as crianças", type: "select", options: ["O tempo todo", "Só nos brinquedos", "Não temos"], group: "perguntas" },
  // Degustação: a IA só informa; quem agenda é sempre a equipe (caso Amanda,
  // 14/10 — cliente perguntou de degustação e pediu "hoje", a IA marcou visita)
  { key: "pagamento", label: "Formas de pagamento", type: "textarea", placeholder: "Pix, cartão ou boleto. A festa precisa estar quitada até 20 dias antes da data.", group: "perguntas", hint: "A IA responde \"aceita boleto?\" sozinha. Desconto, parcelas e negociação continuam com a equipe.", joiner: " ", suggestions: ["Pix.", "Cartão de crédito.", "Cartão de débito.", "Boleto.", "Transferência bancária.", "Sinal na assinatura do contrato e o restante até a data combinada.", "A festa precisa estar quitada antes da data da festa.", "Parcelamento combinado com a equipe."] },
  { key: "degustacao", label: "Degustação do cardápio", type: "select", options: ["Não oferecemos degustação", "Oferecemos, agendada com a equipe, para quem tem interesse em fechar", "Oferecemos para todos, agendada com a equipe", "Só depois de fechar o contrato"], group: "perguntas", hint: "A IA nunca marca degustação: só informa como funciona, e quem agenda é a equipe." },
  { key: "degustacao_como", label: "Como funciona a degustação", type: "textarea", placeholder: "Agendada com a equipe, às terças à tarde, para até 2 pessoas, depois da visita ao espaço...", group: "perguntas", hint: "Só se vocês oferecem. Deixe em branco se não oferecem.", joiner: " ", suggestions: ["A degustação é separada da visita ao espaço.", "Na visita, o cliente conhece o espaço e os pacotes, sem degustação.", "A degustação é planejada e combinada com a equipe, que marca o melhor dia e horário.", "A degustação acontece depois da visita ao espaço.", "A degustação é para até 2 pessoas.", "A IA não agenda degustação: quando o cliente pedir, ela passa o contato para a equipe."] },
  { key: "regras", label: "Regras e o que não fazemos", type: "textarea", placeholder: "Não fazemos festas externas. Visitas somente com agendamento...", group: "regras", hint: "Limites claros evitam que a IA prometa o que vocês não fazem", joiner: " ", suggestions: ["Não fazemos festas fora do nosso espaço.", "Visitas somente com agendamento.", "Não negociamos valores pela conversa: descontos e fechamento são sempre com a equipe.", "A data só fica garantida com contrato assinado e sinal pago.", "Decoração não está inclusa nos pacotes.", "O horário de término da festa precisa ser respeitado.", "Não é permitido levar brinquedos infláveis ou atrações de fora sem combinar com a equipe."] },
  { key: "outros", label: "Outras informações", type: "textarea", placeholder: "Qualquer outra informação que a IA pode afirmar com segurança", group: "regras" },
];


/** Toque numa sugestão: acrescenta no fim do campo ou, se já estiver lá, tira */
export function toggleSuggestion(value: string, suggestion: string, joiner: ", " | " " = " "): string {
  const v = value.trim();
  if (v.includes(suggestion)) {
    if (joiner === ", ") return v.split(/\s*,\s*/).filter((x) => x && x !== suggestion).join(", ");
    return v.replace(suggestion, "").replace(/\s{2,}/g, " ").trim();
  }
  if (!v) return suggestion;
  const base = joiner === ", " ? v.replace(/[.!]\s*$/, "") : /[.!?]$/.test(v) ? v : `${v}.`;
  return `${base}${joiner}${suggestion}`;
}

export function serializeBuffetInfo(values: Record<string, string>): string | null {
  const parts = BUFFET_FIELDS
    .filter((f) => (values[f.key] || "").trim())
    .map((f) => `${f.label}: ${values[f.key].trim()}`);
  return parts.length > 0 ? parts.join("\n") : null;
}

export function parseBuffetInfo(text: string | null): Record<string, string> {
  const values: Record<string, string> = {};
  if (!text) return values;
  let currentKey: string | null = null;
  const unmatched: string[] = [];
  for (const line of text.split("\n")) {
    const field = BUFFET_FIELDS.find((f) => line.startsWith(`${f.label}:`));
    if (field) {
      currentKey = field.key;
      values[field.key] = line.slice(field.label.length + 1).trim();
    } else if (currentKey) {
      values[currentKey] = `${values[currentKey]}\n${line}`;
    } else {
      unmatched.push(line);
    }
  }
  // Texto antigo sem rótulos (ou linhas soltas) cai em "Outras informações"
  const leftover = unmatched.join("\n").trim();
  if (leftover) {
    values["outros"] = [leftover, values["outros"] || ""].filter(Boolean).join("\n");
  }
  Object.keys(values).forEach((k) => { values[k] = values[k].trim(); });
  return values;
}

// Campos que podem ficar em branco sem contar como "falta"
export const OPTIONAL_BUFFET_FIELDS = new Set(["degustacao_como", "outros", "pagamento", "promocao"]);

/** Quantos campos importantes já estão preenchidos (Visão geral da IA) */
export function buffetInfoProgress(extraInstructions: string | null): { filled: number; total: number; missing: string[] } {
  const values = parseBuffetInfo(extraInstructions);
  const required = BUFFET_FIELDS.filter((f) => !OPTIONAL_BUFFET_FIELDS.has(f.key));
  const missing = required.filter((f) => !(values[f.key] || "").trim()).map((f) => f.label);
  return { filled: required.length - missing.length, total: required.length, missing };
}
