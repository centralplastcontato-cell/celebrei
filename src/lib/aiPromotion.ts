// Promoção do buffet (Configurações → IA → Promoção). Fica em UMA linha do campo
// "Promoção" das informações do buffet, no formato que a IA já entende
// (supabase/functions/_shared/promo.ts): título com "PROMOÇÃO", prazo
// "até DD/MM/AAAA" e, se for o caso, "para festas realizadas em AAAA".

export interface PromotionForm {
  nome: string; // "Black Friday"
  beneficio: string; // "10 convidados a mais"
  ate: string; // AAAA-MM-DD
  anoFesta: string; // "" = qualquer data; "2026" = só festas em 2026
  regras: string;
}

export const EMPTY_PROMOTION: PromotionForm = { nome: "", beneficio: "", ate: "", anoFesta: "", regras: "" };

const oneLine = (t: string) => t.replace(/\s*\n+\s*/g, " ").trim();

export function serializePromotion(p: PromotionForm): string {
  if (!p.nome.trim() || !p.beneficio.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(p.ate)) return "";
  const [y, m, d] = p.ate.split("-");
  const nome = oneLine(p.nome).replace(/^promo[çc][ãa]o\s+/i, "").toUpperCase();
  const year = /^20\d{2}$/.test(p.anoFesta) ? `, para festas realizadas em ${p.anoFesta}` : "";
  const rules = oneLine(p.regras);
  return `PROMOÇÃO ${nome} (válida para contratos fechados até ${d}/${m}/${y}${year}): ${oneLine(p.beneficio)}${rules ? ` Regras: ${rules}` : ""}`;
}

const LINE_RE = /^PROMOÇÃO (.+?) \(válida para contratos fechados até (\d{2})\/(\d{2})\/(\d{4})(?:, para festas realizadas em (\d{4}))?\): (.*?)(?: Regras: (.*))?$/s;

/** Texto salvo → formulário. Texto escrito de outro jeito vai inteiro para "o que o cliente ganha". */
export function parsePromotion(text: string | null | undefined): PromotionForm {
  const t = (text || "").trim();
  if (!t) return { ...EMPTY_PROMOTION };
  const m = t.match(LINE_RE);
  if (!m) return { ...EMPTY_PROMOTION, beneficio: t };
  const nome = m[1].toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  return { nome, beneficio: m[6].trim(), ate: `${m[4]}-${m[3]}-${m[2]}`, anoFesta: m[5] || "", regras: (m[7] || "").trim() };
}

/** Dias até o fim (0 = termina hoje; negativo = já acabou), no fuso do Brasil */
export function promotionDaysLeft(ate: string, now = new Date()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ate)) return null;
  const today = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  return Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}

/** Ideias prontas (Configurações → IA → Promoção): um toque preenche, o buffet ajusta e escolhe a data */
export interface PromotionIdea {
  emoji: string;
  nome: string;
  beneficio: string;
  regras: string;
  /** só festas do ano que vem (ex.: garantir a festa do próximo ano) */
  nextYear?: boolean;
}

export const PROMOTION_IDEAS: PromotionIdea[] = [
  { emoji: "🖤", nome: "Black Friday", beneficio: "10 convidados a mais no pacote e parcelamento em 10x sem juros.", regras: "Não vale com outras promoções." },
  { emoji: "📅", nome: "Datas especiais", beneficio: "Condição especial para festas de sexta-feira e domingo: 10 convidados a mais no pacote.", regras: "Só para festas de sexta-feira e domingo." },
  { emoji: "🏰", nome: "Fechou na visita", beneficio: "Quem fechar o contrato no dia da visita ao espaço ganha 30 minutos a mais de festa.", regras: "Só para contratos fechados no mesmo dia da visita." },
  { emoji: "🎂", nome: "Festa do ano que vem", beneficio: "Garanta a festa do ano que vem com o valor de hoje.", regras: "Sinal na assinatura do contrato.", nextYear: true },
  { emoji: "🤝", nome: "Indique um amigo", beneficio: "Indicou um amigo e ele fechou a festa? Você ganha 10 convidados a mais na sua festa.", regras: "O amigo precisa fechar o contrato; o benefício vale para uma festa." },
  { emoji: "💳", nome: "Parcela fácil", beneficio: "Parcelamento da festa em até 12x sem juros.", regras: "Festa quitada até 20 dias antes da data." },
  { emoji: "🎄", nome: "Natal Mágico", beneficio: "Quem fechar a festa ganha a decoração de Natal no salão e uma visita especial do Papai Noel.", regras: "Só para festas em dezembro." },
];

export function ideaToForm(idea: PromotionIdea, current: PromotionForm, now = new Date()): PromotionForm {
  const year = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }).slice(0, 4);
  return {
    ...current,
    nome: idea.nome,
    beneficio: idea.beneficio,
    regras: idea.regras,
    anoFesta: idea.nextYear ? String(Number(year) + 1) : current.anoFesta,
  };
}
