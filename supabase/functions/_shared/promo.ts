// Promoção vigente do cadastro (Configurar IA → informações do buffet), para a
// IA oferecer ativamente com escassez verdadeira: o prazo (com os dias que
// faltam, calculados aqui — não pela IA) e os limites escritos na promoção.
// Depois do prazo, some sozinha do prompt.

import { formatDateLong } from "./whatsapp-format.ts";

export interface Promotion {
  title: string; // "PROMOÇÃO MÊS DAS CRIANÇAS"
  endYmd: string; // último dia (AAAA-MM-DD)
  daysLeft: number; // 0 = termina hoje
  partyYear: number | null; // "para festas realizadas em 2026"
}

const DATE_RE = /at[ée]\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i;

/** Primeira linha do cadastro que fala de promoção e tem prazo ("até 17/10/2026") ainda em vigor */
export function findPromotion(extra: string | null | undefined, todayYmd: string): Promotion | null {
  if (!extra) return null;
  const [ty] = todayYmd.split("-").map(Number);
  for (const line of extra.split("\n")) {
    if (!/promo[çc][ãa]o/i.test(line)) continue;
    // Linha de regra que só cita a promoção ("a promoção vigente descrita em...") não conta
    if (/promo[çc][ãa]o vigente descrita/i.test(line)) continue;
    const m = line.match(DATE_RE);
    if (!m) continue;
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = m[3] ? (m[3].length <= 2 ? 2000 + Number(m[3]) : Number(m[3])) : ty;
    const end = new Date(Date.UTC(year, month - 1, day));
    if (end.getUTCMonth() !== month - 1) continue;
    const endYmd = end.toISOString().slice(0, 10);
    if (endYmd < todayYmd) continue;
    const today = new Date(`${todayYmd}T00:00:00Z`);
    const daysLeft = Math.round((end.getTime() - today.getTime()) / 86400000);
    const title = (line.match(/^\s*(promo[çc][ãa]o[^(:—–-]*)/i)?.[1] || "promoção").trim();
    const partyYear = Number(line.match(/festas?\s+(?:realizadas?\s+)?em\s+(20\d{2})/i)?.[1]) || null;
    return { title, endYmd, daysLeft, partyYear };
  }
  return null;
}

const MONTHS = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/**
 * Ano da festa pelo que a conversa já sabe: a data exata ou o mês ("Fevereiro",
 * "fevereiro/27"). Mês sem ano que já passou neste ano = ano que vem.
 */
export function partyYearOf(dataFesta: unknown, mes: unknown, todayYmd: string): number | null {
  if (typeof dataFesta === "string" && /^20\d{2}-\d{2}-\d{2}/.test(dataFesta)) return Number(dataFesta.slice(0, 4));
  const text = String(mes || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const y = text.match(/\b(20\d{2})\b/) || text.match(/[/\s-](\d{2})\b/);
  if (y) return y[1].length === 4 ? Number(y[1]) : 2000 + Number(y[1]);
  const idx = MONTHS.findIndex((m) => text.includes(m));
  if (idx < 0) return null;
  const [ty, tm] = todayYmd.split("-").map(Number);
  return idx + 1 < tm ? ty + 1 : ty;
}

/** A promoção vale para a festa? Sem ano na promoção ou sem ano da festa conhecido: vale */
export function promoFitsParty(p: Promotion, partyYear: number | null): boolean {
  return !p.partyYear || !partyYear || p.partyYear === partyYear;
}

/** Festa fora do ano da promoção: a IA não pode oferecer (a regra está nas informações do buffet) */
export function promoOffNote(p: Promotion, partyYear: number): string {
  return `PROMOÇÃO NÃO VALE PARA ESTE CLIENTE: ${p.title} é só para festas em ${p.partyYear} e a festa dele é em ${partyYear}. NÃO fale dessa promoção nem dos benefícios dela; se o cliente perguntar, explique com gentileza que ela é só para festas em ${p.partyYear}.`;
}

/** "faltam 10 dias" / "termina amanhã" / "termina HOJE" */
export function promoCountdown(p: Promotion): string {
  if (p.daysLeft === 0) return "termina HOJE";
  if (p.daysLeft === 1) return "termina amanhã";
  return `faltam ${p.daysLeft} dias`;
}

/** Quantas respostas da IA já falaram da promoção (pelo prazo ou pela palavra) */
export function promoMentions(assistantTexts: string[], p: Promotion): number {
  const [, m, d] = p.endYmd.split("-").map(Number);
  const longDate = formatDateLong(p.endYmd).replace(/^[^,]+, /, ""); // "17 de outubro"
  const re = new RegExp(`promo[çc][ãa]o|${longDate}|\\b${d}/${String(m).padStart(2, "0")}\\b|\\b${d}/${m}\\b`, "i");
  return assistantTexts.filter((t) => re.test(t)).length;
}

/** Aviso para o prompt: oferecer a promoção no momento certo, com escassez verdadeira */
export function promoNote(p: Promotion, mentions: number): string {
  const end = formatDateLong(p.endYmd);
  const who = p.partyYear ? ` Só para festas em ${p.partyYear}: se a festa for em outro ano, não ofereça.` : "";
  const base = `PROMOÇÃO EM VIGOR: ${p.title} — vai até ${end} (${promoCountdown(p)}). As regras completas estão nas INFORMAÇÕES DO BUFFET.${who}`;
  if (mentions >= 2) {
    return `${base} Você já falou dessa promoção ${mentions} vezes nesta conversa: não fale mais dela, a menos que o cliente pergunte.`;
  }
  const how = mentions === 0
    ? `Na PRIMEIRA vez que passar valores (ou logo depois, se o cliente se interessar pela data), acrescente 1 ou 2 linhas destacando o principal benefício e o prazo, com o dia exato e a contagem — ex.: "🎁 E tem mais: fechando até ${end}, você ganha [benefício] (${promoCountdown(p)}!)".`
    : `Você já ofereceu uma vez: lembre só MAIS UMA vez, e só se o cliente hesitar ("vou pensar", "tá caro", "vou ver") ou quando convidar para a visita — curto, com o prazo e a contagem.`;
  return `${base} ${how} Escassez só verdadeira: o prazo, a contagem acima e os limites escritos na promoção (ex.: só os primeiros contratos) e a agenda real. NUNCA invente quantas vagas ou contratos restam, nem que outros clientes querem a mesma data.`;
}
