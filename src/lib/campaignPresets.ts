// Campanhas prontas: objetivo, público e o pedido para a IA escrever as
// mensagens. O público é calculado aqui (puro, testável); as datas livres e
// as festas de um ano atrás vêm do banco (CampaignPresetPicker / passo Público).

export type CampaignPresetId = "datas_livres" | "sumiu" | "perdidos" | "ano_que_vem";

export const MONTHS_PT = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

/** Situações de quem pediu orçamento e não fechou nem perdeu */
export const OPEN_LEAD_STATUSES = ["em_contato", "aguardando_resposta", "orcamento_enviado"];

/** "Sumiu": sem conversar há pelo menos isso e pediu orçamento há no máximo SUMIU_MAX_DAYS */
export const SUMIU_MIN_DAYS = 7;
export const SUMIU_MAX_DAYS = 120;
/** "Perdidos": perdidos de até 1 ano */
export const PERDIDOS_MAX_DAYS = 365;
/** "Festa do ano que vem": festa feita entre 13 e 9 meses atrás */
export const ANO_QUE_VEM_FROM_DAYS = 395;
export const ANO_QUE_VEM_TO_DAYS = 270;

export interface PresetLead {
  id: string;
  status: string;
  month: string | null;
  source: "crm" | "base";
  /** quando o lead chegou (ISO) */
  createdAt?: string | null;
  /** últimos 8 dígitos do telefone */
  tail?: string;
}

export interface PresetContext {
  /** mês escolhido em "Datas livres" (ex.: "Novembro") */
  month?: string;
  /** fins de semana ainda livres no mês escolhido (AAAA-MM-DD) */
  freeDates?: string[];
  /** data com só parte do dia livre → o horário livre ("noite") */
  partialDates?: Record<string, string>;
  /** leads com festa feita há ~1 ano (só "Festa do ano que vem") */
  pastPartyLeadIds?: Set<string>;
  /** telefones (finais) que conversaram nos últimos SUMIU_MIN_DAYS dias */
  recentChatTails?: Set<string>;
  nowMs?: number;
}

export interface CampaignPreset {
  id: CampaignPresetId;
  emoji: string;
  title: string;
  subtitle: string;
  /** situações "fechadas" que esta campanha precisa mostrar (ex.: perdido) */
  allowStatuses: string[];
}

export const CAMPAIGN_PRESETS: CampaignPreset[] = [
  {
    id: "datas_livres",
    emoji: "📅",
    title: "Datas livres",
    subtitle: "Para quem quer festa no mês escolhido: mostra os fins de semana que ainda estão livres na agenda.",
    allowStatuses: [],
  },
  {
    id: "sumiu",
    emoji: "👋",
    title: "Pediu orçamento e sumiu",
    subtitle: `Quem conversou nos últimos ${SUMIU_MAX_DAYS / 30} meses, não fechou nem perdeu, e está quieto há mais de ${SUMIU_MIN_DAYS} dias.`,
    allowStatuses: [],
  },
  {
    id: "perdidos",
    emoji: "🔁",
    title: "Perdidos: nova chance",
    subtitle: "Quem foi marcado como perdido no último ano. Um convite leve para conhecer o espaço.",
    allowStatuses: ["perdido"],
  },
  {
    id: "ano_que_vem",
    emoji: "🎂",
    title: "Festa do ano que vem",
    subtitle: "Clientes que fizeram festa há cerca de 1 ano: o próximo aniversário está chegando.",
    allowStatuses: ["fechado"],
  },
];

export function getPreset(id: string | null | undefined): CampaignPreset | null {
  return CAMPAIGN_PRESETS.find((p) => p.id === id) || null;
}

const DAY = 86400000;
const ageDays = (iso: string | null | undefined, nowMs: number) => {
  const t = Date.parse(String(iso || ""));
  return Number.isFinite(t) ? (nowMs - t) / DAY : null;
};

/** O lead faz parte do público desta campanha pronta? */
export function presetMatches(id: CampaignPresetId, lead: PresetLead, ctx: PresetContext = {}): boolean {
  const nowMs = ctx.nowMs ?? Date.now();
  switch (id) {
    case "datas_livres":
      return !!ctx.month && lead.month === ctx.month;
    case "sumiu": {
      const age = ageDays(lead.createdAt, nowMs);
      if (lead.tail && ctx.recentChatTails?.has(lead.tail)) return false;
      return lead.source === "crm" && OPEN_LEAD_STATUSES.includes(lead.status) && age !== null && age >= SUMIU_MIN_DAYS && age <= SUMIU_MAX_DAYS;
    }
    case "perdidos": {
      const age = ageDays(lead.createdAt, nowMs);
      return lead.source === "crm" && lead.status === "perdido" && age !== null && age <= PERDIDOS_MAX_DAYS;
    }
    case "ano_que_vem":
      return !!ctx.pastPartyLeadIds?.has(lead.id);
  }
}

/** "2026-11-08" → "08/11 (sáb)" */
export function shortDateBR(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")} (${wd === 6 ? "sáb" : wd === 0 ? "dom" : ["", "seg", "ter", "qua", "qui", "sex"][wd]})`;
}

/** "21/11 (sáb)" ou, com só um horário livre, "21/11 (sáb, só noite)" */
export function freeDateLabel(ymd: string, partial?: Record<string, string>): string {
  const base = shortDateBR(ymd);
  const only = partial?.[ymd];
  return only ? base.replace(/\)$/, `, só ${only})`) : base;
}

/**
 * Sábados e domingos do mês (a partir de amanhã) com ALGUM horário de festa
 * livre — mesma conta da IA (almoço e noite separados). Antes, qualquer festa
 * no dia tirava o dia inteiro: sábado com almoço reservado e noite livre sumia.
 * `freeSlots`: data → horários livres ("almoço", "noite"); `slotCount`: quantos
 * horários de festa o buffet tem por dia.
 */
export function freeWeekendSlots(
  year: number,
  monthIndex: number,
  freeSlots: Map<string, string[]>,
  slotCount: number,
  todayYmd: string,
): { dates: string[]; partial: Record<string, string> } {
  const dates: string[] = [];
  const partial: Record<string, string> = {};
  const days = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  for (let d = 1; d <= days; d++) {
    const date = new Date(Date.UTC(year, monthIndex, d));
    const wd = date.getUTCDay();
    if (wd !== 0 && wd !== 6) continue;
    const ymd = date.toISOString().slice(0, 10);
    const free = [...new Set(freeSlots.get(ymd) || [])];
    if (ymd <= todayYmd || free.length === 0) continue;
    dates.push(ymd);
    if (free.length < slotCount) partial[ymd] = free.join(" e ");
  }
  return { dates, partial };
}

/** Sábados e domingos do mês (a partir de amanhã) sem nenhuma festa marcada */
export function freeWeekendDates(year: number, monthIndex: number, bookedDates: Set<string>, todayYmd: string): string[] {
  const out: string[] = [];
  const days = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  for (let d = 1; d <= days; d++) {
    const date = new Date(Date.UTC(year, monthIndex, d));
    const wd = date.getUTCDay();
    if (wd !== 0 && wd !== 6) continue;
    const ymd = date.toISOString().slice(0, 10);
    if (ymd <= todayYmd || bookedDates.has(ymd)) continue;
    out.push(ymd);
  }
  return out;
}

/** Os próximos meses a partir de hoje (o atual, se ainda falta mais de 10 dias, e os seguintes) */
export function upcomingMonths(todayYmd: string, count = 3): { year: number; monthIndex: number; name: string }[] {
  const [y, m, d] = todayYmd.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let start = daysInMonth - d > 10 ? m - 1 : m;
  const out = [];
  for (let i = 0; i < count; i++, start++) {
    const year = y + Math.floor(start / 12);
    const monthIndex = start % 12;
    out.push({ year, monthIndex, name: MONTHS_PT[monthIndex] });
  }
  return out;
}

const COMMON_RULES =
  "Não ofereça desconto, brinde, preço nem condição que não esteja escrita aqui. Termine com uma pergunta simples, que a pessoa responda com uma palavra (ex.: \"Quer que eu te mostre?\"), para ela responder a mensagem.";

/** Nome sugerido para a campanha */
export function presetName(id: CampaignPresetId, ctx: PresetContext = {}): string {
  switch (id) {
    case "datas_livres": return `Datas livres em ${ctx.month || "breve"}`;
    case "sumiu": return "Retomar orçamentos parados";
    case "perdidos": return "Nova chance para os perdidos";
    case "ano_que_vem": return "Festa do ano que vem";
  }
}

/** Objetivo escrito para a IA gerar as mensagens */
export function presetGoal(id: CampaignPresetId, ctx: PresetContext = {}): string {
  switch (id) {
    case "datas_livres": {
      const dates = (ctx.freeDates || []).slice(0, 8).map((d) => freeDateLabel(d, ctx.partialDates)).join(", ");
      return `Avisar quem tem interesse em festa em ${ctx.month} que ainda temos fins de semana livres na agenda${dates ? `: ${dates}` : ""}. As datas são poucas e quem garantir primeiro fica com elas (é verdade: são as que sobraram). Convidar para conhecer o espaço ou garantir a data. ${COMMON_RULES}`;
    }
    case "sumiu":
      return `Retomar a conversa com quem pediu orçamento de festa e parou de responder. Tom leve e sem cobrança, como quem lembra da pessoa: perguntar se ainda está pensando na festa e se ficou alguma dúvida, e oferecer ajuda (tirar dúvidas, mandar fotos do espaço ou marcar uma visita). ${COMMON_RULES}`;
    case "perdidos":
      return `Mensagem para quem pediu orçamento de festa há alguns meses e acabou não fechando com a gente. Sem insistência e sem perguntar por que não fechou: dizer que lembramos dela, que temos novidades e datas disponíveis, e convidar para conhecer o espaço sem compromisso. ${COMMON_RULES}`;
    case "ano_que_vem":
      return `Mensagem carinhosa para famílias que fizeram a festa de aniversário com a gente há cerca de um ano: lembrar com alegria da festa, dizer que o próximo aniversário está chegando e perguntar se já querem garantir a data, porque os melhores fins de semana saem rápido. ${COMMON_RULES}`;
  }
}
