// Volta automática da IA: a equipe escreveu numa conversa da IA (a IA sai na
// hora), não devolveu e ficou 24 h sem mandar nada. A IA volta em silêncio —
// não escreve na hora — e os follow-ups dela recomeçam a contar da última
// mensagem da equipe. Pedido do Castelo (29/10): a equipe entra, responde e
// esquece de "Devolver para a IA", e o cliente fica sem os follow-ups da IA.
//
// Na dúvida, fica com a equipe: só volta quando nada indica negociação,
// fechamento, visita ou algo que a equipe ficou de fazer.

export const AUTO_RETURN_AFTER_MS = 24 * 3600000;
// Só conversas que a equipe assumiu depois de ligar esta regra (as ~50
// conversas antigas paradas não voltam todas de uma vez)
export const AUTO_RETURN_SINCE = "2026-10-29T15:00:00Z";
// Status do lead em que a IA ainda pode acompanhar: Novo e Orçamento enviado.
// Visita, Negociando, Fechado, Perdido, Transferência, Trabalhe Conosco,
// Fornecedor, Cliente Retorno e Outros ficam com a equipe.
export const AUTO_RETURN_STATUSES = new Set(["novo", "orcamento_enviado"]);

// Negociação, fechamento e dinheiro: a equipe conduz
const NEGOTIATION_RE = /contrato|desconto|parcel|\bpix\b|\bsinal\b|boleto|pagamento|fechament|fechar\s+(?:a|o|com|hoje|agora)|proposta|condi[çc](?:[ãa]o|[õo]es)|reserv|pr[ée]-?reserva|valor especial|cortesia|brinde/i;
// A equipe ficou de fazer algo: a IA não cobra o cliente por cima
const PENDING_PROMISE_RE = /\b(?:vou|vamos|irei|iremos)\s+(?:te\s+|lhe\s+)?(?:verificar|ver|confirmar|checar|consultar|conversar|falar|retornar|mandar|enviar|passar|ligar|chamar|agendar|marcar)|\bte\s+(?:retorno|ligo|chamo|mando|envio|passo|aviso)\b|\bj[áa]\s+te\s+(?:passo|mando|retorno|envio|aviso)|\bretorno\s+(?:em|amanh|logo|mais tarde|hoje)|\baguard[ea]\s+(?:um|s[óo]|que)/i;
// Motivo da passagem da IA que é assunto da equipe
const SENSITIVE_HANDOFF_RE = /reclama|cancel|degusta|permuta|parceri|reembols|financeir|estorno|problema|insatisf/i;

export interface AutoReturnFacts {
  nowMs: number;
  /** Última mensagem da conversa (de qualquer lado) */
  lastMessageAtMs: number;
  /** Mensagens da conversa em ordem, sem as automáticas que não são da IA nem da equipe */
  messages: Array<{ atMs: number; fromMe: boolean; byTeam: boolean; text: string }>;
  leadStatus: string | null;
  /** Cliente combinou uma data para retomar ("Retomar em …") */
  returnPending: boolean;
  /** Visita marcada, realizada ou remarcada (qualquer uma não cancelada) */
  hasVisit: boolean;
  handoffReason: string | null;
  /** Assunto da passagem da IA (trabalhar, fornecedor, cliente com festa) */
  handoffSubject: string | null;
  partyYmd: string | null;
  todayYmd: string;
  /** A IA já voltou sozinha uma vez nesta conversa */
  alreadyAutoReturned: boolean;
}

/** null = pode voltar; senão, o motivo de ficar com a equipe */
export function autoReturnBlocker(f: AutoReturnFacts): string | null {
  if (f.alreadyAutoReturned) return "já voltou sozinha uma vez";
  if (!f.leadStatus) return "sem lead";
  if (!AUTO_RETURN_STATUSES.has(f.leadStatus)) return `lead em ${f.leadStatus}`;
  if (f.returnPending) return "cliente combinou data para retomar";
  if (f.hasVisit) return "tem visita";
  if (f.handoffSubject) return `passagem por ${f.handoffSubject}`;
  if (f.handoffReason && (SENSITIVE_HANDOFF_RE.test(f.handoffReason) || NEGOTIATION_RE.test(f.handoffReason))) return "motivo da passagem é da equipe";
  if (f.partyYmd && f.partyYmd < f.todayYmd) return "data da festa já passou";

  const msgs = [...f.messages].sort((a, b) => a.atMs - b.atMs);
  const last = msgs[msgs.length - 1];
  if (!last) return "sem mensagens";
  // Cliente esperando resposta: é a equipe que responde (tem o alerta de "Responder")
  if (!last.fromMe) return "cliente falou por último";
  if (!last.byTeam) return "a última mensagem não é da equipe";
  if (last.atMs < Date.parse(AUTO_RETURN_SINCE)) return "assumida antes da regra";
  if (f.nowMs - Math.max(last.atMs, f.lastMessageAtMs) < AUTO_RETURN_AFTER_MS) return "menos de 24 h";

  // O que a equipe escreveu desde que assumiu (depois da última mensagem da IA)
  let lastAi = -1;
  msgs.forEach((m, i) => { if (m.fromMe && !m.byTeam) lastAi = i; });
  const teamTexts = msgs.slice(lastAi + 1).filter((m) => m.fromMe && m.byTeam).map((m) => m.text);
  const clientTexts = msgs.slice(lastAi + 1).filter((m) => !m.fromMe).map((m) => m.text);
  if ([...teamTexts, ...clientTexts].some((t) => NEGOTIATION_RE.test(t))) return "conversa sobre negociação";
  if (teamTexts.some((t) => PENDING_PROMISE_RE.test(t))) return "a equipe ficou de retornar";
  return null;
}
