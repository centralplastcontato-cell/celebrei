// Quem entra no público de uma campanha.
// Esconde sozinho: telefone inválido, quem pediu para sair, telefone repetido,
// quem já tem festa marcada na agenda e, a não ser que a pessoa peça, quem
// já fechou/perdeu/não é cliente, quem está conversando agora e quem recebeu
// campanha há pouco.

/** Situações em que não faz sentido mandar promoção sem a pessoa escolher */
export const CLOSED_LEAD_STATUSES = [
  "fechado",
  "perdido",
  "transferido",
  "fornecedor",
  "trabalhe_conosco",
  "outros",
] as const;

/** Limite de envios por dia por empresa (protege o número contra bloqueio). Igual ao do servidor. */
export const CAMPAIGN_DAILY_LIMIT = 30;

/** Quem recebeu campanha há menos que isso fica de fora */
export const RECENT_CAMPAIGN_DAYS = 15;

/** Quem trocou mensagem há menos que isso está "conversando agora" (no meio da negociação) */
export const ACTIVE_CHAT_DAYS = 3;

/** Últimos 8 dígitos do telefone (igual ao banco). Vazio se não tiver 8 dígitos. */
export function phoneTail(phone: string | null | undefined): string {
  const digits = (phone || "").replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(-8) : "";
}

export interface AudienceCandidate {
  id: string;
  whatsapp: string;
  status: string;
  source: "crm" | "base";
}

export interface AudienceHidden {
  invalid: number;
  optout: number;
  duplicate: number;
  closed: number;
  recent: number;
  /** conversou nos últimos dias (está negociando com a equipe ou a IA) */
  chatting: number;
  /** já tem festa marcada na agenda */
  party: number;
}

export interface AudienceOptions {
  optoutTails: Set<string>;
  recentTails: Set<string>;
  includeClosed: boolean;
  includeRecent: boolean;
  /** telefones com conversa nos últimos ACTIVE_CHAT_DAYS dias */
  chatTails?: Set<string>;
  includeChatting?: boolean;
  /** leads com festa marcada (hoje em diante) — nunca recebem promoção */
  partyLeadIds?: Set<string>;
  /** situações que a pessoa escolheu no filtro: entram mesmo sendo "fechadas" */
  chosenStatuses?: string[];
}

export function prepareAudience<T extends AudienceCandidate>(
  leads: T[],
  opts: AudienceOptions,
): { available: T[]; hidden: AudienceHidden } {
  const hidden: AudienceHidden = { invalid: 0, optout: 0, duplicate: 0, closed: 0, recent: 0, chatting: 0, party: 0 };
  const closed = new Set<string>(CLOSED_LEAD_STATUSES);
  // Escolher "Perdido" no filtro traz só os perdidos, não todos os fechados
  for (const st of opts.chosenStatuses || []) closed.delete(st);

  // Festa marcada vale pelo TELEFONE: se a festa está num cadastro da cliente,
  // os outros cadastros dela (repetido no CRM ou na Base) também ficam de fora
  const partyTails = new Set<string>();
  if (opts.partyLeadIds?.size) {
    for (const l of leads) {
      if (!opts.partyLeadIds.has(l.id)) continue;
      const t = phoneTail(l.whatsapp);
      if (t) partyTails.add(t);
    }
  }

  // Um por telefone: o do CRM vale mais que o da Base (tem situação de verdade)
  const ordered = [...leads].sort((a, b) => (a.source === b.source ? 0 : a.source === "crm" ? -1 : 1));
  const seen = new Set<string>();
  const keep = new Set<string>();
  for (const lead of ordered) {
    const tail = phoneTail(lead.whatsapp);
    if (!tail) { hidden.invalid++; continue; }
    if (opts.optoutTails.has(tail)) { hidden.optout++; continue; }
    if (seen.has(tail)) { hidden.duplicate++; continue; }
    seen.add(tail);
    if (opts.partyLeadIds?.has(lead.id) || partyTails.has(tail)) { hidden.party++; continue; }
    if (!opts.includeClosed && closed.has(lead.status)) { hidden.closed++; continue; }
    if (!opts.includeChatting && opts.chatTails?.has(tail)) { hidden.chatting++; continue; }
    if (!opts.includeRecent && opts.recentTails.has(tail)) { hidden.recent++; continue; }
    keep.add(lead.id);
  }

  // Mantém a ordem original da lista
  return { available: leads.filter((l) => keep.has(l.id)), hidden };
}

/** Na hora de gravar: um destinatário por telefone, sem telefones inválidos */
export function uniqueByPhone<T extends { whatsapp: string }>(leads: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const lead of leads) {
    const tail = phoneTail(lead.whatsapp);
    if (!tail || seen.has(tail)) continue;
    seen.add(tail);
    out.push(lead);
  }
  return out;
}

/** Quantos dias o envio leva, com o limite de mensagens por dia */
export function sendDays(pending: number, perDay: number): number {
  if (pending <= 0 || perDay <= 0) return 0;
  return Math.ceil(pending / perDay);
}
