// Volta automática da IA (regras em _shared/ai-auto-return.ts): conversa da
// IA que a equipe assumiu, sem "Devolver para a IA" e sem mensagem da equipe
// há 24 h, volta para a IA em silêncio. Os follow-ups dela seguem da última
// mensagem da equipe (a jornada roda logo depois, no mesmo ciclo).

import { AUTO_RETURN_AFTER_MS, AUTO_RETURN_SINCE, autoReturnBlocker } from "../_shared/ai-auto-return.ts";
import { type AiTarget } from "../_shared/ai-journey-scope.ts";
import { normalizeFollowUpConfig } from "../_shared/ai-followup.ts";
import { loadBlockedContacts } from "../_shared/contact-block.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

// Nossas mensagens que não são nem da IA nem de uma pessoa da equipe
const OTHER_AUTOMATED_SOURCES = new Set(["auto_reminder", "reactivation_engine", "visit_confirmation", "campaign_auto_reply", "system_alert", "reaction", "post_visit", "vamu_offer"]);
const MAX_AGE_DAYS = 14;

const ymdBR = (ms: number) => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);

export async function processAiAutoReturn(supabase: Db, targets: AiTarget[]): Promise<{ returned: number; errors: string[] }> {
  const errors: string[] = [];
  let returned = 0;
  const nowMs = Date.now();
  const todayYmd = ymdBR(nowMs);
  const isBlocked = await loadBlockedContacts(supabase);

  for (const { settings, instance } of targets) {
    // Modo de teste ou acompanhamento da IA desligado: nada volta sozinho
    if (settings.test_mode_enabled || !normalizeFollowUpConfig(settings.followup_config).enabled) continue;
    const { data: convs, error } = await supabase.from("wapi_conversations")
      .select("id, remote_jid, lead_id, bot_data, last_message_at")
      .eq("instance_id", instance.id)
      .eq("bot_step", "human_takeover")
      .eq("bot_data->>ai_agent", "on")
      .is("bot_data->>ai_auto_returned_at", null)
      .eq("last_message_from_me", true)
      .not("remote_jid", "like", "%@g.us%")
      .lte("last_message_at", new Date(nowMs - AUTO_RETURN_AFTER_MS).toISOString())
      .gte("last_message_at", new Date(Math.max(Date.parse(AUTO_RETURN_SINCE), nowMs - MAX_AGE_DAYS * 86400000)).toISOString())
      .limit(50);
    if (error) {
      errors.push(`volta da IA (${instance.unit}): ${error.message}`);
      continue;
    }

    for (const conv of (convs || []) as Json[]) {
      try {
        if (isBlocked(instance.company_id, conv.remote_jid)) continue;
        const bd = (conv.bot_data || {}) as Json;
        const [{ data: lead }, { data: visits }, { data: rows }] = await Promise.all([
          conv.lead_id
            ? supabase.from("campaign_leads").select("id, status, return_status").eq("id", conv.lead_id).maybeSingle()
            : Promise.resolve({ data: null }),
          conv.lead_id
            ? supabase.from("lead_visits").select("status_visita").eq("lead_id", conv.lead_id).limit(20)
            : Promise.resolve({ data: [] }),
          supabase.from("wapi_messages").select("from_me, content, timestamp, metadata")
            .eq("conversation_id", conv.id).order("timestamp", { ascending: false }).limit(30),
        ]);
        const messages = ((rows || []) as Json[])
          .filter((m) => !OTHER_AUTOMATED_SOURCES.has(String(m.metadata?.source || "")))
          .map((m) => ({
            atMs: Date.parse(m.timestamp),
            fromMe: m.from_me === true,
            byTeam: m.from_me === true && m.metadata?.source !== "ai_agent",
            text: String(m.content || ""),
          }));
        const handoff = (bd.ai_handoff || {}) as Json;
        const why = autoReturnBlocker({
          nowMs,
          lastMessageAtMs: Date.parse(conv.last_message_at),
          messages,
          leadStatus: lead?.status ?? null,
          returnPending: lead?.return_status === "pending",
          hasVisit: ((visits || []) as Json[]).some((v) => !/cancel/i.test(String(v.status_visita || ""))),
          handoffReason: typeof handoff.reason === "string" ? handoff.reason : null,
          handoffSubject: typeof handoff.assunto === "string" && handoff.assunto ? handoff.assunto : null,
          partyYmd: typeof bd.data_festa === "string" ? bd.data_festa : null,
          todayYmd,
          alreadyAutoReturned: Boolean(bd.ai_auto_returned_at),
        });
        if (why) continue;

        const nowIso = new Date().toISOString();
        const botData: Json = { ...bd, ai_agent: "on", ai_returned_at: nowIso, ai_auto_returned_at: nowIso };
        delete botData.ai_handoff;
        // Só se nada mudou desde a leitura (equipe ou cliente não escreveram agora)
        const { data: updated } = await supabase.from("wapi_conversations")
          .update({ bot_enabled: true, bot_step: "ai_agent", bot_data: botData })
          .eq("id", conv.id).eq("bot_step", "human_takeover").eq("last_message_at", conv.last_message_at)
          .select("id");
        if (!updated || updated.length === 0) continue;
        returned++;
        console.log(`[ai-auto-return] Conversa ${conv.id} voltou para a IA (equipe sem mensagem há 24 h)`);
        await supabase.from("lead_history").insert({
          lead_id: lead.id, company_id: instance.company_id, user_id: null, user_name: "Sistema",
          action: "Conversa voltou para a IA",
          new_value: "A equipe assumiu e ficou 24 h sem mandar mensagem. A IA volta a acompanhar com os follow-ups dela; se alguém da equipe escrever, ela sai de novo.",
        });
      } catch (err) {
        errors.push(`volta da IA (conv ${conv.id}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { returned, errors };
}
