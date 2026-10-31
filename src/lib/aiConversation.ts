// Situação da IA numa conversa da Central (ícone roxo na lista e filtros "IA")
export type AiConversationState = "atendendo" | "equipe" | "participou";

interface AiConvLike {
  bot_step?: string | null;
  bot_enabled?: boolean | null;
  bot_data?: unknown;
}

/**
 * null: a IA nunca atendeu esta conversa.
 * atendendo: a IA está respondendo agora.
 * equipe: a IA passou a conversa para a equipe.
 * participou: a IA atendeu antes e a equipe assumiu (botão Assumir).
 */
export function aiConversationState(conv: AiConvLike): AiConversationState | null {
  const bd = (conv.bot_data && typeof conv.bot_data === "object" ? conv.bot_data : {}) as Record<string, unknown>;
  if (bd.ai_agent !== "on") return null;
  if (conv.bot_step === "ai_agent" && conv.bot_enabled !== false) return "atendendo";
  if (conv.bot_step === "human_takeover" && bd.ai_handoff) return "equipe";
  return "participou";
}

export const AI_STATE_LABEL: Record<AiConversationState, string> = {
  atendendo: "IA atendendo",
  equipe: "A IA passou para a equipe",
  participou: "A IA atendeu antes; agora está com a equipe",
};

// ── "Responder": a IA passou a conversa e ninguém da equipe escreveu ainda ──

// Mensagens nossas que não são de uma pessoa da equipe (mesma regra do servidor)
const AUTOMATED_SOURCES = new Set(["auto_reminder", "campaign_auto_reply", "system_alert", "ai_agent", "reactivation_engine", "visit_confirmation", "reaction", "vamu_offer"]);
// Até aqui as mensagens da IA saíam gravadas como "platform" (iguais às da equipe)
const AI_SOURCE_MARKED_SINCE = Date.parse("2026-10-05T23:10:00Z");

export interface OutgoingMessage {
  from_me: boolean;
  timestamp: string;
  metadata?: unknown;
}

/** Alguém da equipe escreveu depois da passagem? (Central ou celular; IA, avisos e reações não contam) */
export function teamRepliedSince(rows: OutgoingMessage[], sinceIso: string): boolean {
  const since = Date.parse(sinceIso);
  return rows.some((r) => {
    const at = Date.parse(r.timestamp);
    if (!r.from_me || !(at > since)) return false;
    const meta = (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>;
    const source = typeof meta.source === "string" ? meta.source : null;
    if (source === "platform" && at < AI_SOURCE_MARKED_SINCE) return false;
    return !source || !AUTOMATED_SOURCES.has(source);
  });
}

// A etiqueta "Responder" some sozinha depois disso: passagem velha sem resposta
// costuma ser assunto que não era festa (freelancer, fornecedor) e só acumulava
export const AI_HANDOFF_EXPIRE_DAYS = 3;

/** Passagem da IA ainda em aberto: quando foi e se o alerta de "sem resposta" já disparou */
export function openAiHandoff(conv: AiConvLike, nowMs = Date.now()): { at: string; late: boolean } | null {
  if (aiConversationState(conv) !== "equipe") return null;
  const bd = (conv.bot_data && typeof conv.bot_data === "object" ? conv.bot_data : {}) as Record<string, unknown>;
  const h = (bd.ai_handoff && typeof bd.ai_handoff === "object" ? bd.ai_handoff : {}) as Record<string, unknown>;
  if (typeof h.at !== "string") return null;
  if (h.alerted_at === "respondido") return null; // a equipe respondeu antes do alerta
  if (h.dismissed_at) return null; // "Não precisa responder"
  if (nowMs - Date.parse(h.at) > AI_HANDOFF_EXPIRE_DAYS * 24 * 3600 * 1000) return null;
  return { at: h.at, late: typeof h.alerted_at === "string" && !Number.isNaN(Date.parse(h.alerted_at)) };
}

/**
 * bot_data com a passagem marcada como "não precisa responder": some a etiqueta
 * e o servidor não manda o alerta de "cliente sem resposta" (alerted_at preenchido)
 */
export function dismissAiHandoff(botData: unknown, nowIso = new Date().toISOString()): Record<string, unknown> {
  const bd = (botData && typeof botData === "object" ? botData : {}) as Record<string, unknown>;
  const h = (bd.ai_handoff && typeof bd.ai_handoff === "object" ? bd.ai_handoff : {}) as Record<string, unknown>;
  return { ...bd, ai_handoff: { ...h, dismissed_at: nowIso, alerted_at: h.alerted_at || "respondido" } };
}

/** Prévia da última mensagem na lista: "[Reação] ❤️" vira "Você reagiu ❤️" / "Reagiu ❤️" */
export function friendlyLastMessage(content: string | null | undefined, fromMe: boolean | null | undefined): string | null | undefined {
  const m = /^\[Reação\]\s*(.*)$/s.exec(content || "");
  if (!m) return content;
  return `${fromMe ? "Você reagiu" : "Reagiu"} ${m[1].trim()}`.trim();
}
