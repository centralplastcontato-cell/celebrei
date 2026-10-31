// Follow-up "Analisar com calma" (Mega Magic, Vanessa 19/10): a equipe mandou
// mensagem às 16:31 e o follow-up automático saiu às 16:33 do mesmo jeito. O
// follow-up só conferia se a ÚLTIMA mensagem era do cliente. Agora, se o
// cliente escreveu ou alguém da equipe mandou mensagem depois do momento de
// referência (agora − atraso do follow-up), a conversa está ativa e ele espera.

// Envios automáticos que não contam como "a equipe falou" (o próprio follow-up,
// campanhas, avisos, IA, reações)
const AUTOMATED_SOURCES = new Set(["auto_reminder", "campaign_auto_reply", "system_alert", "ai_agent", "reactivation_engine", "visit_confirmation", "reaction", "client_data", "post_visit", "scheduled_return", "vamu_offer"]);

export interface ActivityRow {
  conversation_id: string;
  from_me: boolean;
  metadata: Record<string, unknown> | null;
}

/** Conversas com cliente ou equipe ativos (as linhas já vêm filtradas a partir do momento de referência) */
export function activeConversations(rows: ActivityRow[]): Set<string> {
  const active = new Set<string>();
  for (const r of rows) {
    if (!r.from_me) { active.add(r.conversation_id); continue; }
    const source = typeof r.metadata?.source === "string" ? r.metadata.source as string : null;
    if (source && AUTOMATED_SOURCES.has(source)) continue;
    // Robô mandando material pela plataforma (fotos, vídeo, PDF) não é a equipe
    if (r.metadata?.automation === true) continue;
    active.add(r.conversation_id);
  }
  return active;
}
