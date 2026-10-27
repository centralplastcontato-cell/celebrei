// Questionário da IA: o buffet responde antes de a IA ser ligada para ele —
// é a única coisa que ele preenche (as abas do Configurar IA têm partes
// técnicas e ficam com a equipe Celebrei). As respostas ficam em
// ai_questionnaires (uma linha por empresa) e a equipe passa para as abas,
// revisando, ao ajustar a IA daquele buffet — nada aqui muda a IA sozinho.
// "Sobre o buffet", "Perguntas que todo cliente faz" e "Regras" usam as
// mesmas chaves e opções das abas (src/lib/aiBuffetFields.ts).

import { BUFFET_FIELDS, parseBuffetInfo } from "./aiBuffetFields";

export type QuestionType = "text" | "select" | "multi" | "textarea";

export interface Question {
  key: string;
  label: string;
  type: QuestionType;
  options?: string[];
  placeholder?: string;
  hint?: string;
  /** Pode ficar em branco sem travar o envio */
  optional?: boolean;
}

export interface QuestionSection {
  id: string;
  title: string;
  description: string;
  questions: Question[];
}

// Pergunta igual à da aba (mesma chave, rótulo e opções)
const fromField = (key: string, extra: Partial<Question> = {}): Question => {
  const f = BUFFET_FIELDS.find((x) => x.key === key);
  if (!f) throw new Error(`Campo do buffet desconhecido: ${key}`);
  return {
    key: f.key,
    label: f.label,
    type: f.type,
    options: f.options,
    placeholder: f.placeholder ? `Ex.: ${f.placeholder}` : undefined,
    hint: f.hint,
    ...extra,
  };
};

export const QUESTIONNAIRE: QuestionSection[] = [
  {
    id: "buffet",
    title: "Sobre o buffet",
    description: "O básico que a IA conta para os clientes.",
    questions: [
      { key: "assistente", label: "Nome da assistente virtual", type: "text", placeholder: "Ex.: Ana", hint: "É assim que ela se apresenta aos clientes." },
      fromField("endereco"),
      fromField("duracao"),
      fromField("faixa_etaria"),
      { key: "horarios_festa", label: "Horários das festas", type: "text", placeholder: "Ex.: almoço das 13h às 17h e noite das 19h às 23h" },
      fromField("estrutura"),
      fromField("diferenciais"),
      { key: "horarios_visita", label: "Dias e horários em que vocês recebem visitas", type: "textarea", placeholder: "Ex.: segunda a sexta, das 10h às 17h; sábado das 9h às 12h" },
      { key: "horario_equipe", label: "Horário de atendimento da equipe no WhatsApp", type: "text", placeholder: "Ex.: segunda a sábado, das 9h às 18h" },
    ],
  },
  {
    id: "rapidas",
    title: "Perguntas que todo cliente faz",
    description: "Escolha a resposta certa para o seu buffet.",
    questions: BUFFET_FIELDS.filter((f) => f.group === "perguntas" && f.key !== "pagamento").map((f) => fromField(f.key, f.key === "degustacao_como" ? { optional: true } : {})),
  },
  {
    id: "regras",
    title: "Regras do buffet",
    description: "Limites claros evitam que a IA prometa o que vocês não fazem.",
    questions: [fromField("regras"), fromField("outros", { optional: true })],
  },
  {
    id: "tom",
    title: "Tom e jeito de falar",
    description: "Como a IA conversa com os clientes do seu buffet.",
    questions: [
      { key: "tom", label: "Qual o tom da conversa?", type: "select", options: ["Bem descontraído e animado", "Simpático e equilibrado", "Mais formal e direto"] },
      { key: "emojis", label: "Uso de emojis", type: "select", options: ["Bastante (2 a 3 por mensagem)", "Poucos (no máximo 1)", "Nenhum"] },
      { key: "apresentacao", label: "Como a IA se apresenta?", type: "select", options: ["Pelo nome, como atendente do buffet (só diz que é virtual se perguntarem)", "Avisa logo que é uma assistente virtual"] },
      { key: "expressoes", label: "Expressões e palavras que o buffet costuma usar", type: "textarea", placeholder: "Ex.: \"festa mágica\", \"a criançada\", chamar o aniversariante de \"pequeno(a)\"...", optional: true },
      { key: "proibido", label: "O que a IA NUNCA deve dizer ou fazer", type: "textarea", placeholder: "Ex.: falar mal de concorrente, usar gírias, chamar de \"mãezinha\", insistir depois que o cliente disse não..." },
    ],
  },
  {
    id: "precos",
    title: "Preços e negociação",
    description: "Os valores vêm sempre da tabela cadastrada — aqui você diz quando e como falar deles.",
    questions: [
      { key: "quando_preco", label: "Quando a IA pode passar valores?", type: "select", options: ["Só quando o cliente pergunta o preço", "Sempre, junto com os materiais", "Nunca — só manda o PDF de pacotes", "Nunca — preço é sempre com a equipe"] },
      // Mesmo campo de "Sobre o buffet → Respostas rápidas" (a IA responde dele)
      fromField("pagamento", { label: "Formas de pagamento que a IA pode informar", hint: "Desconto, parcelas e negociação ficam sempre com a equipe." }),
      { key: "promessas", label: "O que a IA NUNCA pode prometer", type: "textarea", placeholder: "Ex.: data garantida sem contrato, brinde, desconto, item fora do pacote..." },
      { key: "promocoes", label: "Promoções vigentes (com validade)", type: "textarea", placeholder: "Ex.: fechando até 31/10, 10 convidados grátis para festas em 2026", optional: true },
    ],
  },
  {
    id: "visitas",
    title: "Visitas",
    description: "Como a IA cuida das visitas ao espaço.",
    questions: [
      { key: "agenda_visita", label: "A IA pode marcar visita sozinha?", type: "select", options: ["Sim, direto na agenda", "Só sugere horários e a equipe confirma", "Não — passa para a equipe"] },
      { key: "convite_visita", label: "Quando convidar para conhecer o espaço?", type: "select", options: ["Depois de passar os valores", "Assim que o cliente mostra interesse", "Só se o cliente pedir"] },
      { key: "visita_obs", label: "Algo importante sobre as visitas", type: "textarea", placeholder: "Ex.: quem recebe, quanto tempo dura, se pode levar as crianças...", optional: true },
    ],
  },
  {
    id: "equipe",
    title: "Quando passar para a equipe",
    description: "Nessas situações a IA avisa a equipe e para de responder sobre o assunto.",
    questions: [
      {
        key: "passar_equipe",
        label: "Quais situações vão para a equipe?",
        type: "multi",
        options: [
          "Cliente que já tem festa marcada",
          "Reclamação ou cliente irritado",
          "Pedido de desconto ou negociação",
          "Pedido de contrato ou para fechar",
          "Fornecedores e parcerias",
          "Quem quer trabalhar no buffet",
          "Quando pedirem para falar com uma pessoa",
        ],
      },
      { key: "fora_horario", label: "Fora do horário da equipe, a IA deve…", type: "select", options: ["Continuar tirando dúvidas e avisar quando a equipe volta", "Só avisar quando a equipe volta"] },
    ],
  },
  {
    id: "exemplos",
    title: "Exemplos reais",
    description: "É o que mais ajuda a IA a falar do jeito do seu buffet.",
    questions: [
      { key: "conversas", label: "Cole 2 ou 3 conversas de WhatsApp que deram certo (fecharam festa ou marcaram visita)", type: "textarea", placeholder: "Copie a conversa do WhatsApp e cole aqui (pode tirar o nome e o número do cliente)" },
      { key: "faq", label: "Perguntas que os clientes mais fazem e a resposta ideal", type: "textarea", placeholder: "Ex.: \"Pode decoração própria?\" → \"Pode sim! A decoração do tema é por conta de vocês...\"" },
      { key: "mais_alguma", label: "Mais alguma coisa que a IA precisa saber?", type: "textarea", optional: true },
    ],
  },
];

export const ALL_QUESTIONS: Question[] = QUESTIONNAIRE.flatMap((s) => s.questions);

export type QuestionnaireAnswers = Record<string, string | string[]>;

export function isAnswered(q: Question, value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "string" && value.trim().length > 0;
}

/** Quantas obrigatórias foram respondidas (por seção e no total) */
export function questionnaireProgress(answers: QuestionnaireAnswers): { done: number; total: number; missing: Question[] } {
  const required = ALL_QUESTIONS.filter((q) => !q.optional);
  const missing = required.filter((q) => !isAnswered(q, answers[q.key]));
  return { done: required.length - missing.length, total: required.length, missing };
}

export function sectionProgress(section: QuestionSection, answers: QuestionnaireAnswers): { done: number; total: number } {
  const required = section.questions.filter((q) => !q.optional);
  return { done: required.filter((q) => isAnswered(q, answers[q.key])).length, total: required.length };
}

/** Só as respostas de perguntas conhecidas, limpas (o que vai para o banco) */
export function cleanAnswers(answers: QuestionnaireAnswers): QuestionnaireAnswers {
  const out: QuestionnaireAnswers = {};
  for (const q of ALL_QUESTIONS) {
    const v = answers[q.key];
    if (q.type === "multi") {
      const list = Array.isArray(v) ? v.filter((o) => q.options?.includes(o)) : [];
      if (list.length) out[q.key] = list;
    } else if (typeof v === "string" && v.trim()) {
      out[q.key] = q.type === "select" && !q.options?.includes(v) ? "" : v.trim();
      if (!out[q.key]) delete out[q.key];
    }
  }
  return out;
}

// Por enquanto a aba aparece só para o Castelo (para revisar antes de liberar)
export const QUESTIONNAIRE_COMPANY_IDS = ["a0000000-0000-0000-0000-000000000001"];

/**
 * Respostas que já vêm do cadastro da IA (abas do Configurar IA): os fatos do
 * buffet aparecem preenchidos no questionário. Só entram opções válidas.
 */
export function prefillFromSettings(st: {
  extra_instructions?: string | null;
  assistant_name?: string | null;
  visit_hours?: string | null;
  team_hours?: string | null;
  party_slots?: string | null;
} | null | undefined): QuestionnaireAnswers {
  if (!st) return {};
  const raw: QuestionnaireAnswers = { ...parseBuffetInfo(st.extra_instructions || null) };
  if (st.assistant_name) raw.assistente = st.assistant_name;
  if (st.visit_hours) raw.horarios_visita = st.visit_hours;
  if (st.team_hours) raw.horario_equipe = st.team_hours;
  if (st.party_slots) raw.horarios_festa = st.party_slots;
  return cleanAnswers(raw);
}
