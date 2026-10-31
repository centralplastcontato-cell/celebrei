// Jornada de acompanhamento das conversas da Bia (IA) — Configurar IA →
// "Acompanhamento da Bia". Só roda para empresas com o módulo IA
// Conversacional ligado e só nas conversas que a Bia atende (bot_step
// ai_agent + bot_data.ai_agent = "on"), no número configurado na IA. Todas as
// outras conversas (bot fixo, outros números, outros buffets) seguem os
// follow-ups de sempre, sem mudança.

import { conversationPacedRecently, pacingHeldLeads } from "../_shared/auto-pacing.ts";
import { claimSystemSendSlot, peekSystemSend } from "../_shared/system-send-pacing.ts";
import { DEFAULT_AI_MODEL, estimateChatCostUsd, providerForModel } from "../_shared/ai-models.ts";
import { type ChatTurn, createLlmSession } from "../wapi-webhook/ai-llm.ts";
import { followupLabel, inSendWindowBR, type JourneyContext, type JourneyMessage, journeyOwns, nextJourneyAction, normalizeFollowUpConfig } from "../_shared/ai-followup.ts";
import { checkFollowUpText, followUpInstruction } from "../_shared/ai-followup-text.ts";
import type { MaterialKind } from "../_shared/material-claims.ts";
import { phoneVariantsBR } from "../_shared/ai-site-lead.ts";
import { findPromotion, partyYearOf, promoCountdown, promoFitsParty, promoOffNote } from "../_shared/promo.ts";
import { formatDateLong, formatDayHeader, formatSlotLabel, formatSlotRange } from "../_shared/whatsapp-format.ts";
import { addDaysYmd, type FreeSlot, freePartySlots, parsePartySlots, weekdayOf } from "../_shared/party-availability.ts";
import { isClosedDay, parseClosedPeriods } from "../_shared/closed-periods.ts";
import { isConversationPaused } from "../_shared/bot-loop-guard.ts";
import { type AiTarget, journeyCovers, type JourneyScope } from "../_shared/ai-journey-scope.ts";
export { type AiTarget, journeyCovers, type JourneyScope, journeyScopes, loadAiJourneyTargets } from "../_shared/ai-journey-scope.ts";
import { mergeConsecutiveTurns } from "../_shared/ai-turn.ts";
import { resolveUnitNotificationTargets } from "../_shared/notification-targets.ts";
import { loadBlockedContacts } from "../_shared/contact-block.ts";
import { freeVisitSlots, friendlyOffers, visitOptions } from "../_shared/visit-offers.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
type Json = Record<string, any>;

// Leads ainda em negociação (fechado, perdido, transferido etc. ficam de fora)
const OPEN_STATUSES = ["novo", "em_contato", "orcamento_enviado", "aguardando_resposta"];
// Cobre o maior prazo da tela (90 dias) + o perdido automático
const MAX_AGE_DAYS = 100;
const MAX_SENDS_PER_RUN = 5;
// Trava por conversa (coluna ai_journey_claimed_at): uma rodada por vez e nada
// de envio duplo quando duas execuções do cron se sobrepõem
const LOCK_MS = 30 * 60000;
const MATERIAL_WINDOW_MS = 30 * 86400000;
const OTHER_AUTOMATED_SOURCES = new Set(["auto_reminder", "reactivation_engine", "visit_confirmation", "campaign_auto_reply", "system_alert", "reaction", "vamu_offer"]);
const MEDIA_KIND: Record<string, MaterialKind> = { image: "fotos", video: "video", document: "pacotes" };
const MEDIA_TEXT: Record<string, string> = { image: "[foto do espaço enviada]", video: "[vídeo enviado]", document: "[PDF de pacotes enviado]", audio: "[áudio]" };

const ymdBR = (ms: number) => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);

/** Mensagens da conversa para a jornada (sem o aviso do #reiniciar e sem o follow-up fixo antigo) */
async function loadJourneyMessages(supabase: Db, conv: Json): Promise<{ history: Json[]; msgs: JourneyMessage[]; historySince: string | null }> {
  const bd = (conv.bot_data || {}) as Json;
  // Depois de #reiniciar (número de teste) só vale a conversa nova
  const historySince = typeof bd.ai_history_since === "string" ? bd.ai_history_since : null;
  let q = supabase.from("wapi_messages")
    .select("from_me, content, message_type, timestamp, metadata")
    .eq("conversation_id", conv.id);
  if (historySince) q = q.gte("timestamp", historySince);
  const { data: rows, error } = await q.order("timestamp", { ascending: false }).limit(40);
  if (error) throw new Error(`mensagens da conversa ${conv.id}: ${error.message}`);
  const history = ((rows || []) as Json[]).reverse().filter((m) => {
    const content = String(m.content || "");
    if (content.startsWith("🧪")) return false; // aviso do modo de teste
    if (!m.from_me && content.trim().toLowerCase() === "#reiniciar") return false;
    // Mensagens automáticas que não são da Bia (follow-up fixo, reativação, confirmação de visita, avisos): nem âncora nem bloqueio
    return !OTHER_AUTOMATED_SOURCES.has(String((m.metadata as Json | null)?.source || ""));
  });
  // Devolvida para a IA (botão ou volta automática): o que a equipe escreveu
  // antes disso faz parte da conversa da IA e não trava os follow-ups dela
  const returnedAtMs = typeof bd.ai_returned_at === "string" ? Date.parse(bd.ai_returned_at) : NaN;
  const msgs: JourneyMessage[] = history.map((m) => ({
    atMs: Date.parse(m.timestamp),
    fromMe: m.from_me === true,
    byAi: m.from_me === true
      ? (m.metadata as Json | null)?.source === "ai_agent" || Date.parse(m.timestamp) <= returnedAtMs
      : undefined,
    isMedia: !!m.message_type && m.message_type !== "text",
    text: String(m.content || ""),
    followup: (m.metadata as Json | null)?.ai_followup || null,
  }));
  return { history, msgs, historySince };
}

/**
 * Para os follow-ups fixos: a jornada é dona desta conversa? Só então o fixo
 * pula. Robô desligado na conversa, equipe respondendo ou conversa parada
 * antes de ligar o acompanhamento continuam nos fixos, como antes.
 */
export async function journeyOwnsConversation(supabase: Db, scope: JourneyScope, conv: Json): Promise<boolean> {
  if (conv.bot_enabled !== true || !journeyCovers(scope, conv.remote_jid)) return false;
  const { msgs } = await loadJourneyMessages(supabase, conv);
  return journeyOwns(scope.cfg, msgs);
}

/** Horários livres na agenda (festas + pré-reservas, sem o recesso) entre duas datas. Só leitura. */
export async function freeSlotsBetween(supabase: Db, settings: Json, companyId: string, from: string, to: string): Promise<FreeSlot[]> {
  const [{ data: units }, { data: events }, { data: pre }] = await Promise.all([
    supabase.from("company_units").select("name").eq("company_id", companyId).eq("is_active", true).eq("is_physical", true),
    supabase.from("company_events").select("event_date, start_time, end_time, status, unit").eq("company_id", companyId).gte("event_date", from).lte("event_date", to),
    supabase.from("pre_reservations").select("event_date, unit").eq("company_id", companyId).eq("status", "ativa")
      .gt("reservation_expires_at", new Date().toISOString()).gte("event_date", from).lte("event_date", to),
  ]);
  const closed = parseClosedPeriods(settings.closed_periods);
  const slots = parsePartySlots(settings.party_slots);
  const unitNames = ((units || []) as Array<{ name: string }>).map((u) => u.name).filter(Boolean);
  const units_ = unitNames.length > 1 ? unitNames : [unitNames[0] || null];
  const seen = new Set<string>();
  const out: FreeSlot[] = [];
  for (const unit of units_) {
    for (const f of freePartySlots({ from, to, slots, events: (events || []) as any[], preReservations: (pre || []) as any[], unit, physicalUnits: unitNames })) {
      const key = `${f.date} ${f.slot.start}`;
      if (seen.has(key) || isClosedDay(f.date, closed)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  return out.sort((a, b) => (a.date + a.slot.start).localeCompare(b.date + b.slot.start));
}

async function partyDateFreeSlots(supabase: Db, settings: Json, companyId: string, ymd: string): Promise<string[]> {
  return (await freeSlotsBetween(supabase, settings, companyId, ymd, ymd)).map((f) => formatSlotLabel(f.slot.start));
}

/**
 * Até 3 datas livres para oferecer no lembrete antes da festa, em linhas
 * prontas. Data ocupada: as mais perto dela (mesmo dia da semana primeiro).
 * Só o mês: datas do mês, fim de semana primeiro.
 */
async function alternativeDates(supabase: Db, settings: Json, companyId: string, ref: { ymd: string; exact: boolean }, todayYmd: string): Promise<string | null> {
  const tomorrow = addDaysYmd(todayYmd, 1);
  let from: string;
  let to: string;
  if (ref.exact) {
    from = addDaysYmd(ref.ymd, -10);
    to = addDaysYmd(ref.ymd, 10);
  } else {
    from = `${ref.ymd.slice(0, 7)}-01`;
    const [y, m] = ref.ymd.split("-").map(Number);
    to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  if (from < tomorrow) from = tomorrow;
  if (to < from) return null;
  const free = (await freeSlotsBetween(supabase, settings, companyId, from, to)).filter((f) => f.date !== ref.ymd || !ref.exact);
  const byDate = new Map<string, FreeSlot[]>();
  for (const f of free) byDate.set(f.date, [...(byDate.get(f.date) || []), f]);
  const dist = (d: string) => Math.abs(Date.parse(`${d}T12:00:00Z`) - Date.parse(`${ref.ymd}T12:00:00Z`));
  const refDow = weekdayOf(ref.ymd);
  const dates = [...byDate.keys()].sort((a, b) => {
    if (ref.exact) {
      const sa = weekdayOf(a) === refDow ? 0 : 1;
      const sb = weekdayOf(b) === refDow ? 0 : 1;
      return sa - sb || dist(a) - dist(b);
    }
    const wa = [0, 6].includes(weekdayOf(a)) ? 0 : 1;
    const wb = [0, 6].includes(weekdayOf(b)) ? 0 : 1;
    return wa - wb || a.localeCompare(b);
  }).slice(0, 3).sort();
  if (dates.length === 0) return null;
  return dates.map((d) => [formatDayHeader(d), ...(byDate.get(d) || []).map((f) => formatSlotRange(f.slot.start, f.slot.end))].join("\n")).join("\n");
}

/** Mensagem da jornada: com arte (a mensagem vai como legenda) ou só texto; arte que falha vira texto */
async function sendJourneyMessage(instance: Json, conv: Json, message: string, imageUrl: string | null): Promise<string | null> {
  if (imageUrl) {
    const id = await sendText(instance, conv, message, imageUrl);
    if (id !== null) return id;
    console.warn(`[ai-journey] Arte não saiu (conv ${conv.id}) — enviando só o texto`);
  }
  return await sendText(instance, conv, message);
}

async function sendText(instance: Json, conv: Json, message: string, imageUrl: string | null = null): Promise<string | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return null;
  const phone = String(conv.remote_jid).replace("@s.whatsapp.net", "").replace("@c.us", "").replace(/\D/g, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/wapi-send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        action: imageUrl ? "send-image" : "send-text",
        phone,
        instanceId: instance.instance_id,
        instanceToken: instance.instance_token,
        conversationId: conv.id,
        companyId: instance.company_id,
        source: "bot",
        automation: true,
        messageSource: "ai_agent",
        ...(imageUrl ? { mediaUrl: imageUrl, caption: message } : { message, delayTyping: 2 }),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(`[ai-journey] send-text falhou (${response.status}): ${(await response.text()).slice(0, 300)}`);
      return null;
    }
    const parsed = await response.json().catch(() => null) as Json | null;
    if (parsed?.success === false || parsed?.error) {
      console.error("[ai-journey] send-text devolveu erro:", parsed);
      return null;
    }
    return typeof parsed?.messageId === "string" ? parsed.messageId : "";
  } catch (err) {
    console.error("[ai-journey] send-text erro/timeout:", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Marca a mensagem enviada como da jornada (é assim que a próxima rodada sabe o que já saiu) */
async function tagFollowUp(supabase: Db, convId: string, messageId: string, text: string, sinceIso: string, label: string): Promise<boolean> {
  let row: Json | null = null;
  if (messageId) {
    const { data } = await supabase.from("wapi_messages").select("id, metadata").eq("conversation_id", convId).eq("message_id", messageId).maybeSingle();
    row = data;
  }
  if (!row) {
    const { data } = await supabase.from("wapi_messages").select("id, metadata").eq("conversation_id", convId).eq("from_me", true)
      .gte("timestamp", sinceIso).eq("content", text).order("timestamp", { ascending: false }).limit(1);
    row = (data || [])[0] || null;
  }
  if (!row) return false;
  const { error } = await supabase.from("wapi_messages")
    .update({ metadata: { ...((row.metadata as Json) || {}), source: "ai_agent", ai_followup: label } }).eq("id", row.id);
  return !error;
}

/** Grava/limpa o vencimento do próximo lembrete antes da festa (coluna própria) */
async function setJourneyNext(supabase: Db, convId: string, nextIso: string | null): Promise<void> {
  const { error } = await supabase.from("wapi_conversations").update({ ai_journey_next_at: nextIso }).eq("id", convId);
  if (error) console.error(`[ai-journey] Erro ao gravar o próximo lembrete (conv ${convId}): ${error.message}`);
}

/** Pega a conversa para esta rodada (atômico); false = outra execução está nela ou ela está bloqueada */
async function claim(supabase: Db, convId: string, nowMs: number): Promise<boolean> {
  const cutoff = new Date(nowMs - LOCK_MS).toISOString();
  const { data, error } = await supabase.from("wapi_conversations")
    .update({ ai_journey_claimed_at: new Date(nowMs).toISOString() })
    .eq("id", convId)
    .or(`ai_journey_claimed_at.is.null,ai_journey_claimed_at.lt.${cutoff}`)
    .select("id");
  if (error) {
    console.error(`[ai-journey] Trava indisponível (falta rodar o SQL?): ${error.message}`);
    return false;
  }
  return (data || []).length > 0;
}

/** Bloqueia a jornada nesta conversa por um tempo (falha repetida, mensagem sem marca) */
async function blockFor(supabase: Db, convId: string, ms: number): Promise<void> {
  await supabase.from("wapi_conversations")
    .update({ ai_journey_claimed_at: new Date(Date.now() + ms - LOCK_MS).toISOString() }).eq("id", convId);
}

async function markLost(supabase: Db, lead: Json, conv: Json, companyId: string, unit: string | null, why: string): Promise<void> {
  const { data: moved, error } = await supabase.from("campaign_leads").update({ status: "perdido" })
    .eq("id", lead.id).in("status", OPEN_STATUSES).select("id");
  if (error) {
    console.error(`[ai-journey] Erro ao mover lead ${lead.id} para perdido:`, error.message);
    return;
  }
  if ((moved || []).length === 0) return; // status mudou no meio do caminho
  await supabase.from("lead_history").insert({
    lead_id: lead.id,
    company_id: companyId,
    user_id: null,
    user_name: "IA",
    action: "Lead movido para perdido automaticamente",
    old_value: lead.status,
    new_value: "perdido",
  });
  // Responsável pelo lead; sem responsável, a equipe do número
  const recipients: string[] = lead.responsavel_id ? [lead.responsavel_id] : await resolveUnitNotificationTargets(supabase, companyId, unit);
  if (recipients.length > 0) {
    const { error: notifError } = await supabase.from("notifications").insert(recipients.map((uid) => ({
      user_id: uid,
      company_id: companyId,
      type: "lead_lost",
      title: "Lead movido para Perdido",
      message: `A IA moveu ${lead.name} para Perdido: ${why}.`,
      data: { lead_id: lead.id, lead_name: lead.name, conversation_id: conv.id, contact_phone: String(conv.remote_jid || "").replace(/@.*/, "") },
    })));
    if (notifError) console.error("[ai-journey] Erro ao avisar sobre o perdido:", notifError.message);
  }
  console.log(`[ai-journey] Lead ${lead.name} (${lead.id}) → perdido (${why})`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Uma rodada da jornada da Bia. Roda DEPOIS dos follow-ups fixos e para de
 * pegar conversas novas quando passa de `budgetMs`, para nunca atrasar o resto.
 */
export async function runAiJourney(
  supabase: Db,
  targets: AiTarget[],
  budgetMs = 90000,
): Promise<{ sent: number; lost: number; errors: string[] }> {
  const errors: string[] = [];
  let sent = 0;
  let lost = 0;
  const startedMs = Date.now();
  const openaiKey = Deno.env.get("OPENAI_API_KEY") || null;
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY") || null;
  // "Não enviar mais nada": a jornada nem escreve o follow-up para esse número
  const isBlocked = await loadBlockedContacts(supabase);

  for (const { settings, instance, companyName } of targets) {
    const cfg = normalizeFollowUpConfig(settings.followup_config);
    if (!cfg.enabled) continue;
    const scope: JourneyScope = { cfg, testVariants: settings.test_mode_enabled ? phoneVariantsBR(String(settings.test_mode_number || "")) : null };
    // Só conversas com atividade depois de ligar o acompanhamento (as anteriores nunca entram)
    const sinceMs = Math.max(Date.parse(cfg.since as string), Date.now() - MAX_AGE_DAYS * 86400000);
    const baseQuery = () => supabase.from("wapi_conversations")
      .select("id, remote_jid, lead_id, bot_data, bot_step, contact_name, last_message_at, ai_journey_next_at")
      .eq("instance_id", instance.id)
      .eq("bot_step", "ai_agent")
      .eq("bot_enabled", true)
      .eq("bot_data->>ai_agent", "on")
      .eq("last_message_from_me", true)
      // Recebeu campanha e ainda não respondeu: a última mensagem é a campanha, não a IA
      .is("bot_data->>campaign_pending_reply", null)
      .not("remote_jid", "like", "%@g.us%")
      .gte("last_message_at", cfg.since as string);
    // Conversas recentes + as paradas há mais tempo com lembrete antes da festa vencendo
    const [recent, parked] = await Promise.all([
      baseQuery().gte("last_message_at", new Date(sinceMs).toISOString()).order("last_message_at", { ascending: false }).limit(300),
      baseQuery().lte("ai_journey_next_at", new Date(Date.now() + 3600000).toISOString()).order("ai_journey_next_at", { ascending: true }).limit(100),
    ]);
    if (recent.error || parked.error) {
      errors.push(`conversas da IA (${instance.unit}): ${(recent.error || parked.error).message}`);
      continue;
    }
    const seenConv = new Set<string>();
    const convs = [...(parked.data || []), ...(recent.data || [])].filter((c: Json) => !seenConv.has(c.id) && !!seenConv.add(c.id));

    // Ritmo do sistema nos números da Evolution (60–180 s, teto do dia, 9h–20h):
    // sem a vez, nem escreve a mensagem; depois de um envio, o próximo fica para outra rodada
    const paced = { id: String(instance.id), provider: instance.provider as string | null, unit: instance.unit as string | null };
    const pace = await peekSystemSend(supabase, paced);
    let paceOk = pace.ok;
    if (!pace.ok) console.log(`[ai-journey] ${instance.unit}: ritmo do sistema (${pace.reason}) — follow-ups ficam para depois`);

    for (const conv of (convs || []) as Json[]) {
      if (sent >= MAX_SENDS_PER_RUN || Date.now() - startedMs > budgetMs) break;
      try {
        if (isBlocked(instance.company_id, conv.remote_jid)) {
          if (conv.ai_journey_next_at) await setJourneyNext(supabase, conv.id, null);
          continue;
        }
        if (!journeyCovers(scope, conv.remote_jid)) {
          // Fora da jornada (ex.: modo de teste): marcador velho não fica entupindo a busca
          if (conv.ai_journey_next_at) await setJourneyNext(supabase, conv.id, null);
          continue;
        }
        const isTest = !!scope.testVariants;
        const nowMs = Date.now();
        const todayYmd = ymdBR(nowMs);
        const bd = (conv.bot_data || {}) as Json;
        // Materiais saindo agora: espera terminar
        if (bd.ai_materials_busy_until && Date.parse(bd.ai_materials_busy_until) > nowMs) continue;

        const { history, msgs, historySince } = await loadJourneyMessages(supabase, conv);
        // Data da festa (exata ou pelo mês) e se o cliente disse que vai decidir depois
        const clientTexts = history.filter((m) => !m.from_me && m.message_type === "text").slice(-3).map((m) => String(m.content || ""));
        const ctx: JourneyContext = { dataFesta: bd.data_festa, mes: bd.mes, clientTexts };
        const planned = nextJourneyAction(cfg, msgs, nowMs, ctx);
        // Ainda sem lead (ex.: a Bia perguntou o nome e a pessoa sumiu): só o
        // lembrete de inatividade — etapas, lembretes antes da festa e perdido
        // dependem do lead
        const plan = !conv.lead_id && planned.action && planned.action.kind !== "inactivity"
          ? { ...planned, action: null, why: "sem lead: só lembrete de inatividade", nextDueMs: null }
          : planned;
        const party = plan.party || null;
        // Guarda quando vence o próximo lembrete antes da festa: a conversa parada
        // há meses volta a ser encontrada nesse dia (e a reativação fixa sabe que
        // é da Bia). Com algo a mandar agora, o marcador só muda depois do envio.
        const nextIso = plan.nextDueMs ? new Date(plan.nextDueMs).toISOString() : null;
        const currentNext = conv.ai_journey_next_at ? new Date(conv.ai_journey_next_at).toISOString() : null;
        if (!plan.action) {
          if (currentNext !== nextIso) await setJourneyNext(supabase, conv.id, nextIso);
          continue;
        }
        if (plan.action.kind !== "lost" && !inSendWindowBR(nowMs)) continue;
        if (plan.action.kind !== "lost" && !paceOk) continue;

        // Só leads ainda em negociação (sem lead: só chega aqui o lembrete de inatividade)
        let lead: Json | null = null;
        if (conv.lead_id) {
          const { data } = await supabase.from("campaign_leads").select("id, name, status, responsavel_id").eq("id", conv.lead_id).maybeSingle();
          if (!data || !OPEN_STATUSES.includes(data.status)) continue;
          lead = data;
          // Visita marcada: quem acompanha é a confirmação de visita
          const { data: visits } = await supabase.from("lead_visits").select("id").eq("lead_id", data.id).gte("data_visita", todayYmd)
            .in("status_visita", ["agendada", "confirmada", "remarcada"]).limit(1);
          if ((visits || []).length > 0) continue;
        }
        if (await isConversationPaused(supabase, conv.id)) continue;
        // Ritmo: etapas e lembretes antes da festa esperam se o cliente já recebeu
        // outra mensagem automática nas últimas 24 h; na janela do pós-visita, nada
        // (nem o perdido automático). O lembrete curto de inatividade segue.
        if (plan.action.kind !== "inactivity") {
          const held = conv.lead_id
            ? (await pacingHeldLeads(supabase, instance.company_id, [conv.lead_id])).has(conv.lead_id)
            : await conversationPacedRecently(supabase, instance.company_id, conv.id);
          if (held) continue;
        }
        if (!(await claim(supabase, conv.id, nowMs))) continue;

        if (plan.action.kind === "lost") {
          if (!lead) continue;
          await markLost(supabase, lead, conv, instance.company_id, instance.unit || null, `${plan.why} sem resposta do cliente`);
          if (conv.ai_journey_next_at) await setJourneyNext(supabase, conv.id, null);
          lost++;
          continue;
        }

        const model = (isTest && settings.test_model) ? settings.test_model : (settings.model || DEFAULT_AI_MODEL);
        const turns: ChatTurn[] = history
          .map((m) => ({
            role: m.from_me ? "assistant" as const : "user" as const,
            content: m.message_type && m.message_type !== "text"
              ? `${MEDIA_TEXT[m.message_type] || "[arquivo]"}${m.content && !/^\[|^📄/.test(m.content) ? ` ${m.content}` : ""}`
              : String(m.content || ""),
          }))
          .filter((t) => t.content.trim());
        const previousAssistant = history.filter((m) => m.from_me).map((m) => String(m.content || ""));
        // Materiais: só os que o WhatsApp confirmou (mesma regra das respostas da Bia)
        const sentMaterials = new Set<MaterialKind>(
          Object.entries((bd.ai_materials_sent || {}) as Record<string, unknown>)
            .filter(([k, v]) => ["fotos", "video", "pacotes"].includes(k) && typeof v === "string" &&
              Date.parse(v) >= nowMs - MATERIAL_WINDOW_MS && (!historySince || v >= historySince))
            .map(([k]) => k as MaterialKind),
        );
        // Arte da etapa / dos lembretes antes da festa (opcional): a mensagem vai como legenda
        const imageUrl = plan.action.kind === "step"
          ? cfg.steps[plan.action.index]?.image_url || null
          : plan.action.kind === "reactivation"
          ? cfg.reactivation.image_url || null
          : null;
        const partyYmd = typeof bd.data_festa === "string" && bd.data_festa >= todayYmd ? bd.data_festa : null;
        const promoFound = findPromotion(settings.extra_instructions, todayYmd);
        // Festa fora do ano da promoção: o lembrete não oferece (Claudia, festa em 2027)
        const partyYear = partyYearOf(bd.data_festa, bd.mes, todayYmd);
        const promo = promoFound && promoFitsParty(promoFound, partyYear) ? promoFound : null;
        const dateFree = partyYmd ? await partyDateFreeSlots(supabase, settings, instance.company_id, partyYmd) : null;
        // Datas alternativas reais: data pedida já reservada (qualquer mensagem
        // da jornada) ou, no lembrete antes da festa, só o mês
        const alternatives = party && ((party.exact && dateFree !== null && dateFree.length === 0) || (plan.action.kind === "reactivation" && !party.exact))
          ? await alternativeDates(supabase, settings, instance.company_id, party, todayYmd)
          : null;
        // Conversa parou na apresentação: o cliente não disse o nome nem nada da festa
        const atStart = plan.action.kind === "inactivity" && !bd.nome && !partyYmd && !bd.mes && !bd.convidados &&
          !bd.aniversariante && sentMaterials.size === 0;
        // Visita: só os horários livres de verdade (o texto não pode inventar outro)
        const visitSlots = atStart ? [] : visitOptions(await freeVisitSlots(supabase, instance.company_id, settings, nowMs, todayYmd));
        const instruction = followUpInstruction({
          kind: plan.action.kind,
          stepNumber: plan.action.kind === "step" ? plan.action.index + 1 : undefined,
          reminderNumber: plan.action.kind === "inactivity" ? plan.action.nth : undefined,
          daysBefore: plan.action.kind === "reactivation" ? plan.action.daysBefore : undefined,
          partyExact: party?.exact,
          alternatives,
          stepsTotal: cfg.steps.length,
          goal: plan.action.kind === "step" ? cfg.steps[plan.action.index].goal : undefined,
          silenceMs: nowMs - (plan.anchorMs as number),
          todayYmd,
          // Nome do perfil do WhatsApp não vale enquanto a pergunta do nome está sem resposta
          clientName: atStart ? null : bd.nome || conv.contact_name || lead?.name || null,
          birthdayName: bd.aniversariante || null,
          corporate: bd.tipo_evento === "empresa" ? String(bd.empresa || "") : null,
          partyYmd,
          partyMonth: bd.mes || null,
          guests: bd.convidados || null,
          partyDateFree: dateFree,
          promoLine: promoFound && !promo && partyYear
            ? promoOffNote(promoFound, partyYear)
            : promo && !atStart
            ? `PROMOÇÃO EM VIGOR (pode citar uma vez, se combinar com o objetivo): ${promo.title} — vai até ${formatDateLong(promo.endYmd)} (${promoCountdown(promo)}); regras nas informações do buffet.${promo.partyYear ? ` Só para festas em ${promo.partyYear}.` : ""}`
            : null,
          valuesAlreadyGiven: previousAssistant.some((t) => /R\$/.test(t)),
          materialsSent: [...sentMaterials],
          withImage: !!imageUrl,
          atStart,
          visitOffers: friendlyOffers(visitSlots, todayYmd),
          visitHours: settings.visit_hours || null,
        });
        const system = `Você é a assistente virtual do ${companyName} no WhatsApp, escrevendo uma mensagem de acompanhamento para um cliente que parou de responder. Português do Brasil, tom caloroso e natural, mensagens curtas como no WhatsApp, 1 a 3 emojis. Hoje é ${formatDateLong(todayYmd)} (${todayYmd}). Datas sempre por extenso ("sábado, 26 de dezembro").${settings.extra_instructions ? `\n\nINFORMAÇÕES DO BUFFET (fonte única de fatos; siga o jeito/personalidade descrito aqui):\n${settings.extra_instructions}` : ""}`;
        const session = createLlmSession({ model, system, history: mergeConsecutiveTurns(turns).merged, tools: [], openaiKey, anthropicKey });
        if (!session) {
          errors.push(`sem chave para ${model}`);
          continue;
        }
        session.addUserNote(instruction);
        let check: ReturnType<typeof checkFollowUpText> | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          const step = await session.step();
          await supabase.from("ai_agent_usage").insert({
            company_id: instance.company_id,
            conversation_id: conv.id,
            lead_id: lead?.id ?? null,
            provider: providerForModel(step.servedModel || model),
            model: step.servedModel || model,
            kind: "chat",
            input_tokens: step.usage.inputTokens,
            cached_input_tokens: step.usage.cachedInputTokens,
            cache_write_tokens: step.usage.cacheWriteTokens,
            output_tokens: step.usage.outputTokens,
            cost_usd: estimateChatCostUsd(step.servedModel || model, step.usage),
            is_test: isTest,
          });
          if (step.refused) break;
          check = checkFollowUpText(step.text, { previousAssistantTexts: previousAssistant, sentMaterials, todayYmd, allowRepeatQuestion: atStart, visitTimes: visitSlots.map((v) => v.time), partyText: [...(dateFree || []), alternatives || ""].join(" ") });
          if (check.ok) break;
          console.warn(`[ai-journey] Texto recusado (conv ${conv.id}): ${check.problem}`);
          session.addUserNote(`Sua mensagem NÃO foi enviada: ${check.problem}. Escreva de novo, corrigida, só o texto para o cliente.`);
        }
        if (!check?.ok) {
          errors.push(`conv ${conv.id}: mensagem da jornada não aprovada (${check?.problem || "recusa do modelo"})`);
          await blockFor(supabase, conv.id, 12 * 3600000); // tenta de novo só daqui a 12h
          continue;
        }

        if (sent > 0) await sleep(8000 + Math.floor(Math.random() * 7000)); // ritmo entre envios, como os follow-ups fixos

        // Último instante: o cliente (ou a equipe) falou enquanto a mensagem era escrita? Não manda.
        const { data: fresh } = await supabase.from("wapi_conversations")
          .select("last_message_at, last_message_from_me, bot_step, bot_enabled, bot_data").eq("id", conv.id).maybeSingle();
        if (!fresh || fresh.last_message_from_me !== true || fresh.bot_step !== "ai_agent" || fresh.bot_enabled !== true ||
          (fresh.bot_data as Json | null)?.ai_agent !== "on" || fresh.last_message_at !== conv.last_message_at) {
          console.log(`[ai-journey] Conversa ${conv.id} mudou enquanto a mensagem era escrita — não enviada`);
          continue;
        }
        const slot = await claimSystemSendSlot(supabase, paced);
        if (!slot.ok) {
          console.log(`[ai-journey] ${instance.unit}: ritmo do sistema (${slot.reason}) — conversa ${conv.id} fica para a próxima rodada`);
          paceOk = false;
          continue;
        }
        if (slot.paced) paceOk = false;
        const label = followupLabel(plan.action) as string;
        const sinceIso = new Date().toISOString();
        const messageId = await sendJourneyMessage(instance, conv, check.text, imageUrl);
        if (messageId === null) {
          errors.push(`conv ${conv.id}: envio falhou`);
          continue;
        }
        sent++;
        // Enviado: a conversa volta a ser recente; a próxima rodada recalcula o próximo lembrete
        if (conv.ai_journey_next_at) await setJourneyNext(supabase, conv.id, null);
        if (!(await tagFollowUp(supabase, conv.id, messageId, check.text, sinceIso, label))) {
          // Sem a marca, a próxima rodada não saberia que esta saiu: bloqueia a conversa
          console.error(`[ai-journey] Mensagem enviada mas não marcada como ${label} (conv ${conv.id}) — jornada pausada 7 dias nesta conversa`);
          await blockFor(supabase, conv.id, 7 * 86400000);
        }
        if (lead) await supabase.from("lead_history").insert({
          lead_id: lead.id,
          company_id: instance.company_id,
          user_id: null,
          user_name: "IA",
          action: label === "inatividade"
            ? "Lembrete da IA (cliente parou de responder)"
            : label === "inatividade_2"
            ? "2º lembrete da IA (cliente parou de responder)"
            : label.startsWith("reativacao_")
            ? `Lembrete da IA antes da festa (${label.replace("reativacao_", "")} dias)`
            : `Follow-up da IA #${label.replace("etapa_", "")}`,
          new_value: check.text.slice(0, 500),
        });
        console.log(`[ai-journey] ${plan.why} — enviado (conv ${conv.id}, ${instance.unit})`);
      } catch (err) {
        console.error(`[ai-journey] Erro na conversa ${conv.id}:`, err);
        errors.push(`conv ${conv.id}: ${String(err)}`);
      }
    }
  }
  return { sent, lost, errors };
}
