import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isConversationPaused } from "../_shared/bot-loop-guard.ts";
import { findLeadByPhone } from "../_shared/lead-phone.ts";
import { fetchLastReturns, leadsWithActionSinceReturn } from "../_shared/lead-return.ts";
import { decideStuckAlert, formatContactList } from "../_shared/stuck-alert.ts";
import { decideDegradedAlert } from "../_shared/degraded-alert.ts";
import { businessMinutesBetween, isOpenAt, parseVisitHours, pickTwoOffers, teamHoursText } from "../_shared/business-hours.ts";
import { teamRepliedAfter } from "../_shared/ai-turn.ts";
import { keycapsToDigits } from "../_shared/menu-reply.ts";
import { activeConversations } from "../_shared/followup-activity.ts";
import { decideUnconfirmedMedia, MEDIA_ACK_TIMEOUT_MS, type MediaAckMeta } from "../_shared/media-ack.ts";
import { BOT_STEPS_WAITING_ANSWER, botShouldHaveAnswered, UNANSWERED_MAX_AGE_HOURS, UNANSWERED_MINUTES } from "../_shared/unanswered-bot.ts";
import { resolveUnitNotificationTargets } from "../_shared/notification-targets.ts";
import { decideDeliveryStall, type OutgoingRow, STALL_LOOKBACK_MS } from "../_shared/delivery-stall.ts";
import { LOST_RESEND_AFTER_MS, LOST_RESEND_MAX_AGE_MS, LOST_RESEND_SOURCES, shouldResendLost } from "../_shared/lost-first-message.ts";
import { isAiConversationalEnabled } from "../_shared/ai-module.ts";
import { evolutionSendMedia, evolutionSendText, extractEvolutionMessageId } from "../_shared/evolution.ts";
import { zapiLinkBody } from "../_shared/link-preview.ts";
import { processAiAutoReturn } from "./ai-auto-return.ts";
import { type AiTarget, freeSlotsBetween, journeyOwnsConversation, type JourneyScope, journeyScopes, loadAiJourneyTargets, runAiJourney } from "./ai-journey.ts";
import { firstNameOf, partyYmdFromLead, postVisitDue, postVisitMessage } from "../_shared/post-visit.ts";
import { mentionsLaterTime, parseReturnJson, RETURN_HOUR, RETURN_STALE_REPLY_MS, returnDue, returnMessage, returnPrompt } from "../_shared/scheduled-return.ts";
import { createLlmSession } from "../wapi-webhook/ai-llm.ts";
import { DEFAULT_AI_MODEL, estimateChatCostUsd, providerForModel } from "../_shared/ai-models.ts";
import { visitStartMs } from "../_shared/visit-confirm.ts";
import { findPromotion, promoFitsParty } from "../_shared/promo.ts";
import { friendlyVisitSlot } from "../_shared/ai-turn.ts";
import { freeVisitSlots } from "../_shared/visit-offers.ts";
import { loadBlockedContacts } from "../_shared/contact-block.ts";
import { installEvolutionCallGuard } from "../_shared/evolution-guard.ts";
import { claimSystemSendSlot } from "../_shared/system-send-pacing.ts";
import { PARTY_SOON_ACTION, partySoon, partySoonLabel } from "../_shared/party-soon.ts";
import { pacingHeldLeads } from "../_shared/auto-pacing.ts";
import { cleanFirstName, isBirthdayParty, partyAge, VAMU_OFFER_ACTION, VAMU_OFFER_DAILY_CAP, VAMU_OFFER_MAX_DAYS, VAMU_OFFER_MIN_DAYS, vamuOfferEventId, vamuOfferMessage, vamuOfferTag, vamuPartyLink } from "../_shared/vamu.ts";
import { type AutoFormType, FORM_AUTO_DEFAULT_DELAY_MIN, FORM_AUTO_DEFAULT_MESSAGES, FORM_AUTO_MAX_LATE_MS, FORM_SENT_ACTION, formAutoDue, formAutoLink, formAutoPath, formSentRecord, type FormTemplateRow, partyEndMs, partyStartMs, pickCardapioTemplate, prefestaDue } from "../_shared/form-auto.ts";
import { clientDataLink, clientDataThanks, DEFAULT_CLIENT_DATA_MESSAGE, DEFAULT_CLIENT_DATA_REMINDERS, dueReminder, fillClientDataTemplate, hasCpfInText, isOverdue, normalizeReminderHours, shortClientToken } from "../_shared/client-data.ts";

type SupabaseAdmin = any;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Chunked .in() query helper — Postgres/PostgREST has URL length limits, so
// large IN lists (hundreds of UUIDs) cause "Bad Request" errors. This helper
// runs the same query in batches of CHUNK_SIZE and concatenates the results.
const IN_CHUNK_SIZE = 100;
async function chunkedInQuery<T = any>(
  buildQuery: (chunk: string[]) => Promise<{ data: T[] | null; error: any }>,
  ids: string[],
): Promise<{ data: T[]; error: any }> {
  if (!ids || ids.length === 0) return { data: [], error: null };
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK_SIZE) {
    const slice = ids.slice(i, i + IN_CHUNK_SIZE);
    const { data, error } = await buildQuery(slice);
    if (error) return { data: out, error };
    if (data && data.length) out.push(...data);
  }
  return { data: out, error: null };
}

function resolveFirstName(
  botData: Record<string, unknown>,
  contactName: string | null,
  leadName?: string | null
): string {
  // Priority: bot_data.nome > lead.name > contact_name
  const raw = String(botData?.nome || leadName || contactName || "")
    .trim()
    .split(" ")[0];
  // If empty, only digits (7+), or starts with +, it's not a valid name
  if (!raw || /^\+?\d{7,}$/.test(raw)) {
    return "cliente";
  }
  return raw;
}

interface FollowUpSettings {
  follow_up_enabled: boolean;
  follow_up_delay_hours: number;
  follow_up_message: string | null;
  follow_up_image_url: string | null;
  follow_up_2_enabled: boolean;
  follow_up_2_delay_hours: number;
  follow_up_2_message: string | null;
  follow_up_2_image_url: string | null;
  follow_up_3_enabled: boolean;
  follow_up_3_delay_hours: number;
  follow_up_3_message: string | null;
  follow_up_3_image_url: string | null;
  follow_up_4_enabled: boolean;
  follow_up_4_delay_hours: number;
  follow_up_4_message: string | null;
  follow_up_4_image_url: string | null;
  follow_up_min_hour: number;
  follow_up_max_hour: number;
  follow_up_send_min_delay: number;
  follow_up_send_max_delay: number;
  auto_lost_enabled: boolean;
  auto_lost_delay_hours: number;
  next_step_reminder_enabled: boolean;
  next_step_reminder_delay_minutes: number;
  next_step_reminder_message: string | null;
  bot_inactive_followup_enabled: boolean;
  bot_inactive_followup_delay_minutes: number;
  bot_inactive_followup_message: string | null;
  instance_id: string;
  test_mode_enabled?: boolean;
  test_mode_number?: string | null;
}

/** Returns a promise that resolves after a random delay between minSec and maxSec seconds */
function randomSafeDelay(minSec: number, maxSec: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxSec - minSec + 1) + minSec) * 1000;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============= POST-RECONNECTION RAMP-UP (anti-burst safety) =============
//
// After an instance reconnects (especially after a WhatsApp/W-API block),
// we MUST avoid bursting many automated messages at once — that's exactly
// what gets numbers re-blocked. Even when a batch of leads is eligible at
// the same time, we cap how many are sent per execution and increase the
// inter-send delay during the first hours after `connected_at`.
//
// Tiers (since connected_at):
//   0–60 min   → 2 sends max, 30–60s between
//   60–180 min → 5 sends max, 20–40s between
//   180–360 min→ 10 sends max, 15–28s between
//   > 6h       → no override (use settings delays)
interface ReconnectRampUp {
  maxSendsPerRun: number;
  minDelay: number;
  maxDelay: number;
  tier: string;
}

const rampUpCache = new Map<string, ReconnectRampUp | null>();

async function getReconnectRampUp(
  supabase: SupabaseAdmin,
  instanceDbId: string,
): Promise<ReconnectRampUp | null> {
  if (rampUpCache.has(instanceDbId)) return rampUpCache.get(instanceDbId)!;

  const { data: inst } = await supabase
    .from("wapi_instances")
    .select("connected_at")
    .eq("id", instanceDbId)
    .single();

  let result: ReconnectRampUp | null = null;
  if (inst?.connected_at) {
    const minutesSince = (Date.now() - new Date(inst.connected_at).getTime()) / (60 * 1000);
    if (minutesSince < 60) {
      result = { maxSendsPerRun: 2, minDelay: 30, maxDelay: 60, tier: "0-60min" };
    } else if (minutesSince < 180) {
      result = { maxSendsPerRun: 5, minDelay: 20, maxDelay: 40, tier: "60-180min" };
    } else if (minutesSince < 360) {
      result = { maxSendsPerRun: 10, minDelay: 15, maxDelay: 28, tier: "180-360min" };
    }
  }
  rampUpCache.set(instanceDbId, result);
  if (result) {
    console.log(`[follow-up-check] 🐢 Ramp-up active for instance ${instanceDbId} (${result.tier}): max ${result.maxSendsPerRun} sends/run, ${result.minDelay}-${result.maxDelay}s delay`);
  }
  return result;
}

/** Returns true if current time in America/Sao_Paulo is outside the allowed send window */
function isOutsideSendWindow(settings: FollowUpSettings): boolean {
  const minHour = settings.follow_up_min_hour ?? 8;
  const maxHour = settings.follow_up_max_hour ?? 22;
  const nowSP = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const currentHour = nowSP.getHours();
  return currentHour < minHour || currentHour >= maxHour;
}

// Helper: checks if a conversation phone should be skipped due to test mode
function shouldSkipTestMode(
  testModeEnabled: boolean | undefined,
  testModeNumber: string | null | undefined,
  remoteJid: string
): boolean {
  if (!testModeEnabled || !testModeNumber) return false;
  const testNum = testModeNumber.replace(/\D/g, '');
  const convPhone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '').replace(/\D/g, '');

  const normalizedTest = testNum.replace(/^55/, '').replace(/^0+/, '');
  const normalizedConv = convPhone.replace(/^55/, '').replace(/^0+/, '');

  const withOrWithoutNinth = (num: string): string[] => {
    const variants = new Set<string>([num]);
    if (num.length === 11 && num[2] === '9') variants.add(`${num.slice(0, 2)}${num.slice(3)}`);
    if (num.length === 10) variants.add(`${num.slice(0, 2)}9${num.slice(2)}`);
    return Array.from(variants);
  };

  const convVariants = withOrWithoutNinth(normalizedConv);
  const testVariants = withOrWithoutNinth(normalizedTest);

  const isTestNumber = convVariants.some((a) =>
    testVariants.some((b) =>
      a === b ||
      a.endsWith(b) ||
      b.endsWith(a) ||
      a.slice(-11) === b.slice(-11) ||
      a.slice(-10) === b.slice(-10)
    )
  );

  if (isTestNumber) return false; // this IS the test number, don't skip
  return true; // skip — not the test number
}

interface LeadForFollowUp {
  lead_id: string;
  lead_name: string;
  lead_whatsapp: string;
  lead_unit: string | null;
  lead_month: string | null;
  lead_guests: string | null;
  choice_time: string;
  conversation_id: string | null;
  instance_id: string | null;
}

// ============= INSTANCE HEALTH GATE (pre-flight + quarantine) =============

const QUARANTINE_MINUTES = 60; // Minutes after connected_at before automations are allowed

/** Cache of instance health per execution cycle to avoid redundant live checks */
const instanceHealthCache = new Map<string, { healthy: boolean; reason?: string }>();

async function checkInstanceHealth(
  supabase: SupabaseAdmin,
  instanceDbId: string,
  options?: { allowRecentActivityBypass?: boolean; recentActivityMinutes?: number },
): Promise<{ healthy: boolean; reason?: string }> {
  const cacheKey = `${instanceDbId}:${options?.allowRecentActivityBypass ? 'recent-bypass' : 'default'}`;
  const cached = instanceHealthCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const { data: inst } = await supabase
    .from("wapi_instances")
    .select("instance_id, instance_token, status, connected_at, is_active")
    .eq("id", instanceDbId)
    .single();

  if (!inst) {
    const result = { healthy: false, reason: "instance_not_found" };
    instanceHealthCache.set(instanceDbId, result);
    return result;
  }

  // Número desativado na plataforma: nenhuma automação roda para ele (follow-up,
  // perdido automático, lembrete, recuperação de bot travado), mas o histórico
  // continua intacto no banco.
  if (inst.is_active === false) {
    const result = { healthy: false, reason: "instance_inactive" };
    instanceHealthCache.set(cacheKey, result);
    return result;
  }

  // QUARANTINE: skip if connected less than QUARANTINE_MINUTES ago
  if (inst.connected_at) {
    const minutesSinceConnect = (Date.now() - new Date(inst.connected_at).getTime()) / (60 * 1000);
    if (minutesSinceConnect < QUARANTINE_MINUTES) {
      let quarantineBypassed = false;

      if (options?.allowRecentActivityBypass) {
        try {
          const activityWindowMinutes = options.recentActivityMinutes ?? 30;
          const recentActivityCutoff = new Date(Date.now() - activityWindowMinutes * 60 * 1000).toISOString();
          const { data: recentActivity } = await supabase
            .from("wapi_conversations")
            .select("id")
            .eq("instance_id", instanceDbId)
            .gte("last_message_at", recentActivityCutoff)
            .limit(1);

          if (recentActivity && recentActivity.length > 0) {
            const result = { healthy: true, reason: `recent_activity_bypass (${activityWindowMinutes}min)` };
            instanceHealthCache.set(cacheKey, result);
            console.log(`[follow-up-check] 🛡️ Instance ${instanceDbId} in quarantine but bypassed by recent activity (${activityWindowMinutes}min window)`);
            return result;
          }

          quarantineBypassed = true;
        } catch (activityErr) {
          console.warn(`[follow-up-check] Recent activity bypass check failed for ${instanceDbId}:`, activityErr);
        }
      }

      if (quarantineBypassed) {
        console.log(`[follow-up-check] 🛡️ Instance ${instanceDbId} still in quarantine, but continuing with live status check for recovery path`);
      } else {
        const result = { healthy: false, reason: `quarantine (connected ${Math.floor(minutesSinceConnect)}min ago, need ${QUARANTINE_MINUTES}min)` };
        instanceHealthCache.set(cacheKey, result);
        console.log(`[follow-up-check] 🛡️ Instance ${instanceDbId} in quarantine — ${Math.floor(minutesSinceConnect)}/${QUARANTINE_MINUTES} min`);
        return result;
      }
    }
  }

  // LIVE STATUS CHECK via wapi-send (uses same pre-flight as manual sends)
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  try {
    const statusResponse = await fetch(
      `${SUPABASE_URL}/functions/v1/wapi-send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "get-status",
          instanceId: inst.instance_id,
          instanceToken: inst.instance_token,
        }),
      }
    );

    if (statusResponse.ok) {
      const statusData = await statusResponse.json();
      const status = statusData?.status || "disconnected";
      if (status === "connected") {
        const result = { healthy: true };
        instanceHealthCache.set(cacheKey, result);
        return result;
      }

      // ACTIVITY-BASED FALLBACK: if wapi-send says disconnected/degraded,
      // check for recent conversation activity before blocking automations.
      // Prevents false blocking when W-API LITE QR endpoint is inconsistent.
      if (status === "disconnected" || status === "degraded") {
        try {
          const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
          const { data: recentActivity } = await supabase
            .from("wapi_conversations")
            .select("id")
            .eq("instance_id", instanceDbId)
            .gte("last_message_at", thirtyMinAgo)
            .limit(1);

          if (recentActivity && recentActivity.length > 0) {
            console.log(`[follow-up-check] 🛡️ Instance ${instanceDbId} reported ${status} but has recent activity — treating as healthy (evidence-based)`);
            const result = { healthy: true };
            instanceHealthCache.set(cacheKey, result);
            return result;
          }
        } catch (activityErr) {
          console.warn(`[follow-up-check] Activity fallback check failed for ${instanceDbId}:`, activityErr);
        }
      }

      const result = { healthy: false, reason: `live_status=${status}` };
      instanceHealthCache.set(cacheKey, result);
      console.log(`[follow-up-check] 🛡️ Instance ${instanceDbId} not healthy: ${status}`);
      return result;
    }
  } catch (e) {
    console.warn(`[follow-up-check] 🛡️ Health check fetch error for ${instanceDbId}:`, e);
  }

  // ACTIVITY FALLBACK for health check failures too
  try {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: recentActivity } = await supabase
      .from("wapi_conversations")
      .select("id")
      .eq("instance_id", instanceDbId)
      .gte("last_message_at", thirtyMinAgo)
      .limit(1);

    if (recentActivity && recentActivity.length > 0) {
      console.log(`[follow-up-check] 🛡️ Instance ${instanceDbId} health check failed but has recent activity — treating as healthy`);
      const result = { healthy: true };
      instanceHealthCache.set(cacheKey, result);
      return result;
    }
  } catch (_) { /* ignore */ }

  const result = { healthy: false, reason: "health_check_failed" };
  instanceHealthCache.set(cacheKey, result);
  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Reset health & ramp-up caches for each invocation
    instanceHealthCache.clear();
    rampUpCache.clear();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    isBlockedContact = await loadBlockedContacts(supabase);
    installEvolutionCallGuard(supabase);

    console.log("[follow-up-check] Starting follow-up check...");

    // === INSTANCE HEALTH CHECK (auto-recovery) ===
    await processInstanceHealthCheck(supabase);

    // Mensagem enviada mas nunca confirmada como entregue: avisa a equipe. Roda
    // sempre, mesmo para empresas sem nenhum follow-up ligado (por isso fica antes
    // do "return" logo abaixo, que só cobre as automações de follow-up).
    const stuckResult = await processStuckSentMessages({ supabase });
    if (stuckResult.errors.length > 0) {
      console.error("[follow-up-check] Erros ao verificar mensagens travadas:", stuckResult.errors);
    }

    // Foto/vídeo/PDF que o WhatsApp nunca confirmou: reenvia uma vez e, se
    // continuar sem confirmar, marca erro no Celebrei e avisa a equipe
    const mediaResult = await processUnconfirmedMedia({ supabase });
    if (mediaResult.errors.length > 0) {
      console.error("[follow-up-check] Erros ao conferir mídias sem confirmação:", mediaResult.errors);
    }

    // Mensagem automática que a Evolution perdeu em silêncio (1 tique para
    // sempre): reenvia uma vez
    try {
      const lost = await processLostAutoMessages({ supabase });
      if (lost.errors.length > 0) console.error("[follow-up-check] Erros ao reenviar mensagens perdidas:", lost.errors);
    } catch (err) {
      console.error("[follow-up-check] Erro ao reenviar mensagens perdidas:", err);
    }

    // Cliente respondeu e o robô não continuou: pausa e avisa a equipe
    const unansweredResult = await processUnansweredBotConversations({ supabase });
    if (unansweredResult.errors.length > 0) {
      console.error("[follow-up-check] Erros ao verificar clientes sem resposta do robô:", unansweredResult.errors);
    }

    // IA passou para a equipe e ninguém respondeu em X min de expediente: alerta forte
    const handoffResult = await processAiHandoffAlerts({ supabase });
    if (handoffResult.errors.length > 0) {
      console.error("[follow-up-check] Erros no alerta de passagem da IA:", handoffResult.errors);
    }

    // Cliente com festa nos próximos 60 dias: aviso para a equipe (se ligado)
    const partySoonResult = await processPartySoonAlerts({ supabase });
    if (partySoonResult.errors.length > 0) {
      console.error("[follow-up-check] Erros no alerta de festa próxima:", partySoonResult.errors);
    }

    // Dados do contratante: link ao fechar, cobranças e avisos (se ligado)
    const clientDataResult = await processClientDataRequests({ supabase });
    // "Vou agendar depois": data combinada pelo cliente
    try {
      const returns = await processScheduledReturns({ supabase });
      if (returns.found > 0 || returns.sent > 0) console.log(`[follow-up-check] Retornos combinados: ${returns.found} novo(s), ${returns.sent} enviado(s)`);
      if (returns.errors.length > 0) console.error("[follow-up-check] Erros nos retornos combinados:", returns.errors);
    } catch (err) {
      console.error("[follow-up-check] Erro nos retornos combinados:", err);
    }
    // Pós-visita (Automações → Visitas): dia seguinte à visita
    try {
      const postVisit = await processPostVisit({ supabase });
      if (postVisit.sent > 0) console.log(`[follow-up-check] Pós-visita: ${postVisit.sent} mensagem(ns)`);
      if (postVisit.errors.length > 0) console.error("[follow-up-check] Erros no pós-visita:", postVisit.errors);
    } catch (err) {
      console.error("[follow-up-check] Erro no pós-visita:", err);
    }
    // Oferta da Vamu 3D: uma mensagem por festa, com o link já preenchido
    try {
      const vamu = await processVamuOffers({ supabase });
      if (vamu.sent > 0) console.log(`[follow-up-check] Oferta Vamu: ${vamu.sent} mensagem(ns)`);
      if (vamu.errors.length > 0) console.error("[follow-up-check] Erros na oferta Vamu:", vamu.errors);
    } catch (err) {
      console.error("[follow-up-check] Erro na oferta Vamu:", err);
    }
    if (clientDataResult.errors.length > 0) {
      console.error("[follow-up-check] Erros nos dados do contratante:", clientDataResult.errors);
    }
    // Formulários automáticos: cardápio depois do contrato, avaliação depois da festa
    try {
      const forms = await processFormAutoSends({ supabase });
      if (forms.sent > 0) console.log(`[follow-up-check] Formulários automáticos: ${forms.sent} enviado(s)`);
      if (forms.errors.length > 0) console.error("[follow-up-check] Erros nos formulários automáticos:", forms.errors);
    } catch (err) {
      console.error("[follow-up-check] Erro nos formulários automáticos:", err);
    }

    // Acompanhamento da Bia (Configurar IA → Follow-up): só nos números com a
    // IA e o acompanhamento ligados, e só nas conversas que ela atende. Nesses
    // casos os follow-ups fixos abaixo pulam a conversa; o resto (bot fixo,
    // outros números e outros buffets) segue exatamente como antes. A jornada
    // em si roda no fim, depois dos follow-ups fixos, com tempo limitado.
    let aiTargets: AiTarget[] = [];
    let aiScopes = new Map<string, JourneyScope>();
    try {
      aiTargets = await loadAiJourneyTargets(supabase);
      aiScopes = journeyScopes(aiTargets);
    } catch (err) {
      console.error("[follow-up-check] Erro ao carregar a jornada da Bia:", err);
    }
    // Números em que só a IA conversa (IA ligada e sem o modo "só o número de
    // teste"): o bot fixo não manda os lembretes nem retoma a qualificação dele
    const aiOnlyInstanceIds = new Set(
      aiTargets.filter((t) => !t.settings.test_mode_enabled).map((t) => String(t.instance.id)),
    );
    const runBiaJourney = async () => {
      try {
        const healthy: AiTarget[] = [];
        for (const t of aiTargets) {
          if (!aiScopes.has(String(t.instance.id))) continue;
          const health = await checkInstanceHealth(supabase, t.instance.id);
          if (health.healthy) healthy.push(t);
          else console.log(`[follow-up-check] 🛡️ Jornada da Bia pulada no número ${t.instance.unit}: ${health.reason}`);
        }
        if (healthy.length === 0) return;
        // Equipe assumiu e ficou 24 h sem escrever: a conversa volta para a IA
        // antes da jornada, que já pode mandar o follow-up neste ciclo
        try {
          const back = await processAiAutoReturn(supabase, healthy);
          if (back.returned > 0) console.log(`[follow-up-check] ${back.returned} conversa(s) voltaram para a IA`);
          if (back.errors.length > 0) console.error("[follow-up-check] Erros na volta da IA:", back.errors);
        } catch (err) {
          console.error("[follow-up-check] Erro na volta da IA:", err);
        }
        const journey = await runAiJourney(supabase, healthy);
        console.log(`[follow-up-check] Jornada da Bia: ${journey.sent} mensagem(ns), ${journey.lost} perdido(s)`);
        if (journey.errors.length > 0) console.error("[follow-up-check] Erros na jornada da Bia:", journey.errors);
      } catch (err) {
        console.error("[follow-up-check] Erro na jornada da Bia:", err);
      }
    };

    // Fetch all bot settings with any follow-up enabled
    const { data: allSettings, error: settingsError } = await supabase
      .from("wapi_bot_settings")
      .select("instance_id, test_mode_enabled, test_mode_number, follow_up_enabled, follow_up_delay_hours, follow_up_message, follow_up_image_url, follow_up_2_enabled, follow_up_2_delay_hours, follow_up_2_message, follow_up_2_image_url, follow_up_3_enabled, follow_up_3_delay_hours, follow_up_3_message, follow_up_3_image_url, follow_up_4_enabled, follow_up_4_delay_hours, follow_up_4_message, follow_up_4_image_url, follow_up_min_hour, follow_up_max_hour, follow_up_send_min_delay, follow_up_send_max_delay, auto_lost_enabled, auto_lost_delay_hours, next_step_reminder_enabled, next_step_reminder_delay_minutes, next_step_reminder_message, bot_inactive_followup_enabled, bot_inactive_followup_delay_minutes, bot_inactive_followup_message")
      .or("follow_up_enabled.eq.true,follow_up_2_enabled.eq.true,follow_up_3_enabled.eq.true,follow_up_4_enabled.eq.true,next_step_reminder_enabled.eq.true,bot_inactive_followup_enabled.eq.true,auto_lost_enabled.eq.true");

    if (settingsError) {
      console.error("[follow-up-check] Error fetching settings:", settingsError);
      throw settingsError;
    }

    if (!allSettings || allSettings.length === 0) {
      await runBiaJourney();
      console.log("[follow-up-check] Follow-up is disabled for all instances");
      return new Response(
        JSON.stringify({ success: true, message: "Follow-up disabled", count: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let totalSuccessCount = 0;
    const allErrors: string[] = [];

    // Process flow builder timer timeouts (global, not per-instance)
    const timerResult = await processFlowTimerTimeouts({ supabase });
    totalSuccessCount += timerResult.successCount;
    allErrors.push(...timerResult.errors);

    // Process stale proximo_passo_reminded alerts (global, runs once)
    await processStaleRemindedAlerts({ supabase });

    // Process stuck bot recovery (global, before per-instance follow-ups)
    const stuckBotResult = await processStuckBotRecovery({ supabase, skipInstanceIds: aiOnlyInstanceIds });
    totalSuccessCount += stuckBotResult.successCount;
    allErrors.push(...stuckBotResult.errors);

    // Process stuck sending_materials recovery (materials sent but proximo_passo question never arrived)
    const stuckMaterialsResult = await processStuckSendingMaterials({ supabase, skipInstanceIds: aiOnlyInstanceIds });
    totalSuccessCount += stuckMaterialsResult.successCount;
    allErrors.push(...stuckMaterialsResult.errors);

    // Número que parou de entregar (fica "enviado" e nada chega ao cliente)
    try {
      await processDeliveryStallAlerts(supabase);
    } catch (err) {
      console.error("[follow-up-check] Erro no alerta de número sem entregar:", err);
    }

    // Process each instance with follow-up enabled
    for (const settings of allSettings) {
      // === PRE-FLIGHT HEALTH GATE: check instance is truly connected + not in quarantine ===
      const health = await checkInstanceHealth(supabase, settings.instance_id);
      if (!health.healthy) {
        console.log(`[follow-up-check] 🛡️ Instance ${settings.instance_id} BLOCKED: ${health.reason} — skipping ALL automations for this instance`);
        continue;
      }

      // Check time window before processing follow-ups for this instance
      if (isOutsideSendWindow(settings)) {
        console.log(`[follow-up-check] ⏰ Outside send window (${settings.follow_up_min_hour ?? 8}h-${settings.follow_up_max_hour ?? 22}h) for instance ${settings.instance_id} — skipping`);
        continue;
      }

      // Número da IA: os lembretes do bot fixo (inatividade e próximo passo) não saem
      const fixedBotOff = aiOnlyInstanceIds.has(String(settings.instance_id));

      // Process bot inactive follow-up (leads who stopped responding during bot flow)
      if (settings.bot_inactive_followup_enabled && !fixedBotOff) {
        const result = await processBotInactiveFollowUp({
          supabase,
          settings,
        });
        totalSuccessCount += result.successCount;
        allErrors.push(...result.errors);
      }

      // Process next-step reminder (10 min default)
      if (settings.next_step_reminder_enabled && !fixedBotOff) {
        const result = await processNextStepReminder({
          supabase,
          settings,
        });
        totalSuccessCount += result.successCount;
        allErrors.push(...result.errors);
      }

      // Build follow-up chain dynamically based on enabled follow-ups
      const followUpConfigs: Array<{
        enabled: boolean;
        followUpNumber: number;
        delayHours: number;
        message: string;
        imageUrl: string | null;
        historyAction: string;
      }> = [
        {
          enabled: !!settings.follow_up_enabled,
          followUpNumber: 1,
          delayHours: settings.follow_up_delay_hours || 24,
          message: settings.follow_up_message || getDefaultFollowUpMessage(1),
          imageUrl: settings.follow_up_image_url || null,
          historyAction: "Follow-up automático enviado",
        },
        {
          enabled: !!settings.follow_up_2_enabled,
          followUpNumber: 2,
          delayHours: settings.follow_up_2_delay_hours || 48,
          message: settings.follow_up_2_message || getDefaultFollowUpMessage(2),
          imageUrl: settings.follow_up_2_image_url || null,
          historyAction: "Follow-up #2 automático enviado",
        },
        {
          enabled: !!settings.follow_up_3_enabled,
          followUpNumber: 3,
          delayHours: settings.follow_up_3_delay_hours || 72,
          message: settings.follow_up_3_message || getDefaultFollowUpMessage(3),
          imageUrl: settings.follow_up_3_image_url || null,
          historyAction: "Follow-up #3 automático enviado",
        },
        {
          enabled: !!settings.follow_up_4_enabled,
          followUpNumber: 4,
          delayHours: settings.follow_up_4_delay_hours || 96,
          message: settings.follow_up_4_message || getDefaultFollowUpMessage(4),
          imageUrl: settings.follow_up_4_image_url || null,
          historyAction: "Follow-up #4 automático enviado",
        },
      ];

      const enabledFollowUps = followUpConfigs.filter(f => f.enabled);

      let previousAction: string | null = null;
      for (const fu of enabledFollowUps) {
        const result = await processFollowUp({
          supabase,
          settings,
          followUpNumber: fu.followUpNumber,
          delayHours: fu.delayHours,
          message: fu.message,
          imageUrl: fu.imageUrl,
          historyAction: fu.historyAction,
          checkPreviousAction: previousAction,
          aiScope: aiScopes.get(settings.instance_id),
        });
        totalSuccessCount += result.successCount;
        allErrors.push(...result.errors);
        previousAction = fu.historyAction;
      }

      // Process auto-lost after 4th follow-up
      if (settings.auto_lost_enabled) {
        const result = await processAutoLost({
          supabase,
          settings,
        });
        totalSuccessCount += result.successCount;
        allErrors.push(...result.errors);
      }
    }

    await runBiaJourney();

    console.log(`[follow-up-check] Completed. Sent ${totalSuccessCount} follow-ups, ${allErrors.length} errors`);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Sent ${totalSuccessCount} follow-up messages`,
        count: totalSuccessCount,
        errors: allErrors.length > 0 ? allErrors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[follow-up-check] Error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});

// ============= NEXT STEP REMINDER (sends reminder when lead doesn't respond to proximo_passo question) =============

interface NextStepReminderParams {
  supabase: SupabaseAdmin;
  settings: FollowUpSettings;
}

async function processNextStepReminder({
  supabase,
  settings,
}: NextStepReminderParams): Promise<{ successCount: number; errors: string[] }> {
  const errors: string[] = [];
  let successCount = 0;
  const delayMinutes = settings.next_step_reminder_delay_minutes || 10;

  console.log(`[follow-up-check] Processing next-step reminder for instance ${settings.instance_id} with ${delayMinutes}min delay`);

  const now = new Date();
  const cutoffTime = new Date(now.getTime() - delayMinutes * 60 * 1000);
  const maxWindow = new Date(now.getTime() - 24 * 60 * 60 * 1000); // max 24h window

  // Find conversations stuck at proximo_passo step where last message is older than delay
  const { data: stuckConversations, error: convError } = await supabase
    .from("wapi_conversations")
    .select("id, remote_jid, instance_id, lead_id, bot_data, contact_name")
    .eq("instance_id", settings.instance_id)
    .eq("bot_step", "proximo_passo")
    .eq("last_message_from_me", true)
    .is("bot_data->>campaign_pending_reply", null) // a última mensagem foi a campanha
    .not("remote_jid", "like", "%@g.us%")
    .lte("last_message_at", cutoffTime.toISOString())
    .gte("last_message_at", maxWindow.toISOString());

  if (convError) {
    console.error(`[follow-up-check] Error fetching stuck conversations:`, convError);
    return { successCount: 0, errors: [String(convError)] };
  }

  if (!stuckConversations || stuckConversations.length === 0) {
    console.log(`[follow-up-check] No conversations need next-step reminder for instance ${settings.instance_id}`);
    return { successCount: 0, errors: [] };
  }

  console.log(`[follow-up-check] Found ${stuckConversations.length} conversations needing next-step reminder`);

  // Get instance credentials
  const { data: instance } = await supabase
    .from("wapi_instances")
    .select("instance_id, instance_token, company_id, provider, client_token")
    .eq("id", settings.instance_id)
    .single();

  if (!instance) {
    console.error(`[follow-up-check] No instance found for ${settings.instance_id}`);
    return { successCount: 0, errors: [`Instance not found: ${settings.instance_id}`] };
  }

  const defaultReminderMsg = `Oi {nome} estou por aqui escolha uma das opções.\n\n1️⃣ - Agendar visita\n2️⃣ - Tirar dúvidas\n3️⃣ - Analisar com calma`;
  const reminderTemplate = settings.next_step_reminder_message || defaultReminderMsg;

  const rampUp = await getReconnectRampUp(supabase, settings.instance_id);

  for (const conv of stuckConversations) {
    if (rampUp && successCount >= rampUp.maxSendsPerRun) {
      console.log(`[follow-up-check] 🐢 Ramp-up cap reached (${rampUp.maxSendsPerRun}) for next-step reminder on instance ${settings.instance_id} — deferring remaining ${stuckConversations.length - successCount} sends`);
      break;
    }
    try {
      // Test mode guard: skip if not the test number
      if (shouldSkipTestMode(settings.test_mode_enabled, settings.test_mode_number, conv.remote_jid)) {
        console.log(`[follow-up-check] 🧪 Test mode active — skipping next-step reminder for ${conv.remote_jid}`);
        continue;
      }

      const botData = (conv.bot_data || {}) as Record<string, string>;
      const firstName = resolveFirstName(botData as Record<string, unknown>, conv.contact_name);
      
      const personalizedMessage = reminderTemplate
        .replace(/\{nome\}/g, firstName);

      const phone = conv.remote_jid.replace("@s.whatsapp.net", "").replace("@c.us", "");

      if (await isConversationPaused(supabase, conv.id)) {
        console.warn(`[follow-up-check] ⏸ Skipping reminder — conversation ${conv.id} is paused (loop guard)`);
        continue;
      }

      const slot = await claimSystemSendSlot(supabase, { id: settings.instance_id, provider: instance.provider });
      if (!slot.ok) {
        console.log(`[follow-up-check] ⏱️ Ritmo do sistema (${slot.reason}) — lembretes restantes ficam para a próxima rodada`);
        break;
      }

      const sendResult = await providerSendText(instance, phone, personalizedMessage);

      if (!sendResult.ok) {
        console.error(`[follow-up-check] Failed to send reminder to ${phone}:`, sendResult.error);
        errors.push(`Failed reminder to ${phone}: ${sendResult.error}`);
        continue;
      }

      console.log(`[follow-up-check] Next-step reminder sent to ${phone}`);

      const sentMsgId = sendResult.messageId;

      // Save message
      await supabase.from("wapi_messages").insert({
        conversation_id: conv.id,
        content: personalizedMessage,
        from_me: true,
        message_type: "text",
        message_id: sentMsgId,
        status: "sent",
        timestamp: new Date().toISOString(),
        metadata: { source: "auto_reminder", type: "next_step_reminder" },
        company_id: instance.company_id,
      });

      // Update conversation: change step to proximo_passo_reminded so we don't resend
      await supabase
        .from("wapi_conversations")
        .update({
          bot_step: "proximo_passo_reminded",
          bot_enabled: true,
          last_message_at: new Date().toISOString(),
          last_message_content: personalizedMessage.substring(0, 100),
          last_message_from_me: true,
        })
        .eq("id", conv.id);

      successCount++;
      // Número com ritmo do sistema: o próximo só sai depois de 60–180 s (próxima rodada)
      if (slot.paced) break;

      // Safe delay between sends to avoid WhatsApp rate limiting (ramp-up overrides)
      const minDelay = rampUp ? rampUp.minDelay : (settings.follow_up_send_min_delay ?? 8);
      const maxDelay = rampUp ? rampUp.maxDelay : (settings.follow_up_send_max_delay ?? 15);
      if (successCount < stuckConversations.length) {
        console.log(`[follow-up-check] ⏳ Waiting ${minDelay}-${maxDelay}s before next send...`);
        await randomSafeDelay(minDelay, maxDelay);
      }
    } catch (err) {
      console.error(`[follow-up-check] Error processing reminder for conv ${conv.id}:`, err);
      errors.push(`Error with conv ${conv.id}: ${String(err)}`);
    }
  }

  return { successCount, errors };
}

// ============= FOLLOW-UP AFTER "ANALISAR COM CALMA" =============

interface ProcessFollowUpParams {
  supabase: SupabaseAdmin;
  settings: FollowUpSettings;
  followUpNumber: number;
  delayHours: number;
  message: string;
  imageUrl?: string | null;
  historyAction: string;
  checkPreviousAction: string | null;
  // Número com a jornada da Bia ligada: as conversas que ela cobre saem daqui (ai-journey.ts)
  aiScope?: JourneyScope;
}

async function processFollowUp({
  supabase,
  settings,
  followUpNumber,
  delayHours,
  message,
  imageUrl,
  historyAction,
  checkPreviousAction,
  aiScope,
}: ProcessFollowUpParams): Promise<{ successCount: number; errors: string[] }> {
  const errors: string[] = [];
  let successCount = 0;

  const now = new Date();
  const lookbackHours = Math.max(delayHours * 2, 168); // 2x delay or 7 days minimum
  const minTime = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  const maxTime = new Date(now.getTime() - delayHours * 60 * 60 * 1000); // configured delay

  console.log(`[follow-up-check] Processing follow-up #${followUpNumber} for instance ${settings.instance_id} with ${delayHours}h delay`);

  // === VIA 1: leads that chose "Analisar" within the time window ===
  const { data: analysisChoices, error: choicesError } = await supabase
    .from("lead_history")
    .select("lead_id, created_at")
    .eq("action", "Próximo passo escolhido")
    .or("new_value.ilike.%Analisar%,new_value.eq.3")
    .gte("created_at", minTime.toISOString())
    .lte("created_at", maxTime.toISOString())
    .limit(5000);

  if (choicesError) {
    console.error(`[follow-up-check] Error fetching analysis choices:`, choicesError);
    return { successCount: 0, errors: [String(choicesError)] };
  }

  const via1LeadIds = (analysisChoices || []).map((c: any) => c.lead_id);

  // === VIA 2: inactive leads (bot/agent sent last, no reply) in this instance ===
  const { data: inactiveConvs, error: inactiveError } = await supabase
    .from("wapi_conversations")
    .select("lead_id")
    .eq("instance_id", settings.instance_id)
    .eq("last_message_from_me", true)
    .not("lead_id", "is", null)
    .is("bot_data->>campaign_pending_reply", null) // a última mensagem foi a campanha
    .not("remote_jid", "like", "%@g.us%")
    .gte("last_message_at", minTime.toISOString())
    .lte("last_message_at", maxTime.toISOString());

  if (inactiveError) {
    console.error(`[follow-up-check] Error fetching inactive conversations:`, inactiveError);
  }

  const via2LeadIds = (inactiveConvs || []).map((c: { lead_id: string }) => c.lead_id);

  // Merge both sources (deduplicate)
  const allLeadIdsSet = new Set([...via1LeadIds, ...via2LeadIds]);

  if (allLeadIdsSet.size === 0) {
    console.log(`[follow-up-check] No leads need follow-up #${followUpNumber} for instance ${settings.instance_id}`);
    return { successCount: 0, errors: [] };
  }

  console.log(`[follow-up-check] Found ${allLeadIdsSet.size} potential leads for follow-up #${followUpNumber} (via1_analisar: ${via1LeadIds.length}, via2_inativos: ${via2LeadIds.length})`);

  const allLeadIds = Array.from(allLeadIdsSet);

  // Filter only leads that have a conversation in THIS instance
  const { data: instanceConversations } = await chunkedInQuery(
    (chunk) =>
      supabase
        .from("wapi_conversations")
        .select("lead_id")
        .in("lead_id", chunk)
        .eq("instance_id", settings.instance_id)
        .not("remote_jid", "like", "%@g.us%"),
    allLeadIds,
  );

  const leadsInThisInstance = new Set(
    (instanceConversations || []).map((c: { lead_id: string }) => c.lead_id)
  );
  const leadIds = allLeadIds.filter((id: string) => leadsInThisInstance.has(id));

  console.log(`[follow-up-check] ${leadIds.length} of ${allLeadIds.length} leads belong to instance ${settings.instance_id}`);

  // Lead que voltou a pedir orçamento recomeça a sequência: só contam os
  // follow-ups enviados depois do último retorno.
  const lastReturns = await fetchLastReturns(supabase, leadIds);

  // Check which leads already received this specific follow-up
  const { data: existingFollowUps, error: followUpError } = await chunkedInQuery(
    (chunk) =>
      supabase
        .from("lead_history")
        .select("lead_id, created_at")
        .in("lead_id", chunk)
        .eq("action", historyAction)
        .limit(5000),
    leadIds,
  );

  if (followUpError) {
    console.error("[follow-up-check] Error checking existing follow-ups:", followUpError);
    return { successCount: 0, errors: [String(followUpError)] };
  }

  const alreadyFollowedUp = leadsWithActionSinceReturn(existingFollowUps || [], lastReturns);
  let leadsNeedingFollowUp = leadIds.filter(id => !alreadyFollowedUp.has(id));

  // For second follow-up: only process leads that received the first follow-up
  if (checkPreviousAction) {
    const { data: previousFollowUps, error: prevError } = await chunkedInQuery(
      (chunk) =>
        supabase
          .from("lead_history")
          .select("lead_id, created_at")
          .in("lead_id", chunk)
          .eq("action", checkPreviousAction)
          .limit(5000),
      leadsNeedingFollowUp,
    );

    if (prevError) {
      console.error("[follow-up-check] Error checking previous follow-ups:", prevError);
      return { successCount: 0, errors: [String(prevError)] };
    }

    const receivedPrevious = leadsWithActionSinceReturn(previousFollowUps || [], lastReturns);
    leadsNeedingFollowUp = leadsNeedingFollowUp.filter(id => receivedPrevious.has(id));
  }

  // Check if lead replied (last message is from contact) - skip follow-up if they did
  {
    const { data: conversations } = await chunkedInQuery(
      (chunk) =>
        supabase
          .from("wapi_conversations")
          .select("lead_id, last_message_from_me")
          .in("lead_id", chunk)
          .eq("last_message_from_me", false),
      leadsNeedingFollowUp,
    );

    // If the last message is from the contact, they replied - skip follow-up
    const repliedLeads = new Set((conversations || []).map((c: any) => c.lead_id));
    leadsNeedingFollowUp = leadsNeedingFollowUp.filter(id => !repliedLeads.has(id));
    
    console.log(`[follow-up-check] After filtering replied leads: ${leadsNeedingFollowUp.length} leads need follow-up #${followUpNumber}`);
  }

  // Cliente ou equipe falaram depois do momento de referência (agora − atraso):
  // a conversa está ativa, o follow-up automático espera (Vanessa, 19/10)
  if (leadsNeedingFollowUp.length > 0) {
    const { data: convRows } = await chunkedInQuery(
      (chunk) =>
        supabase
          .from("wapi_conversations")
          .select("id, lead_id")
          .in("lead_id", chunk)
          .eq("instance_id", settings.instance_id),
      leadsNeedingFollowUp,
    );
    const convToLead = new Map((convRows || []).map((c: { id: string; lead_id: string }) => [c.id, c.lead_id]));
    const { data: recentRows, error: recentError } = await chunkedInQuery(
      (chunk) =>
        supabase
          .from("wapi_messages")
          .select("conversation_id, from_me, metadata")
          .in("conversation_id", chunk)
          .gt("timestamp", maxTime.toISOString())
          .limit(5000),
      [...convToLead.keys()],
    );
    if (recentError) {
      // Sem saber se a equipe está conversando, não manda (melhor atrasar que atropelar)
      console.error(`[follow-up-check] Erro ao conferir conversas ativas — follow-up #${followUpNumber} adiado:`, recentError);
      return { successCount: 0, errors: [String(recentError)] };
    }
    const activeLeads = new Set([...activeConversations(recentRows || [])].map((id) => convToLead.get(id)).filter(Boolean));
    if (activeLeads.size > 0) {
      leadsNeedingFollowUp = leadsNeedingFollowUp.filter((id) => !activeLeads.has(id));
      console.log(`[follow-up-check] ${activeLeads.size} lead(s) com conversa ativa (cliente ou equipe falaram nas últimas ${delayHours}h) — follow-up #${followUpNumber} espera`);
    }
  }

  // Número com a jornada da Bia ligada: conversa que ela cobre segue a jornada da Bia
  if (aiScope && leadsNeedingFollowUp.length > 0) {
    const { data: aiConvs, error: aiConvError } = await chunkedInQuery(
      (chunk) =>
        supabase
          .from("wapi_conversations")
          .select("id, lead_id, remote_jid, bot_enabled, bot_data")
          .in("lead_id", chunk)
          .eq("instance_id", settings.instance_id)
          .eq("bot_step", "ai_agent")
          .eq("bot_data->>ai_agent", "on"),
      leadsNeedingFollowUp,
    );
    if (aiConvError) {
      // Sem saber quais são da Bia, não manda o fixo (evita o cliente receber os dois)
      console.error(`[follow-up-check] Erro ao separar conversas da Bia — follow-up #${followUpNumber} adiado:`, aiConvError);
      return { successCount: 0, errors: [String(aiConvError)] };
    }
    // Só sai do fixo a conversa que a jornada vai mesmo atender
    const aiLeads = new Set<string>();
    try {
      for (const c of (aiConvs || []) as Array<Record<string, any>>) {
        if (await journeyOwnsConversation(supabase, aiScope, c)) aiLeads.add(c.lead_id);
      }
    } catch (err) {
      console.error(`[follow-up-check] Erro ao separar conversas da Bia — follow-up #${followUpNumber} adiado:`, err);
      return { successCount: 0, errors: [String(err)] };
    }
    if (aiLeads.size > 0) {
      leadsNeedingFollowUp = leadsNeedingFollowUp.filter((id) => !aiLeads.has(id));
      console.log(`[follow-up-check] ${aiLeads.size} lead(s) da Bia ficam com a jornada da Bia (follow-up #${followUpNumber} fixo pulado)`);
    }
  }

  // Conversa que ainda está com a IA: sem follow-up fixo do robô (o
  // acompanhamento é dela). Passada para a equipe (human_takeover): segue os
  // prazos do robô normalmente, para ninguém ficar esquecido (Castelo, 20/10)
  if (leadsNeedingFollowUp.length > 0) {
    const { data: aiTouched, error: aiTouchedError } = await chunkedInQuery(
      (chunk) =>
        supabase
          .from("wapi_conversations")
          .select("lead_id")
          .in("lead_id", chunk)
          .eq("instance_id", settings.instance_id)
          .eq("bot_step", "ai_agent")
          .eq("bot_data->>ai_agent", "on"),
      leadsNeedingFollowUp,
    );
    if (aiTouchedError) {
      console.error(`[follow-up-check] Erro ao separar conversas da IA — follow-up #${followUpNumber} adiado:`, aiTouchedError);
      return { successCount: 0, errors: [String(aiTouchedError)] };
    }
    const aiTouchedLeads = new Set((aiTouched || []).map((c: { lead_id: string }) => c.lead_id));
    if (aiTouchedLeads.size > 0) {
      leadsNeedingFollowUp = leadsNeedingFollowUp.filter((id) => !aiTouchedLeads.has(id));
      console.log(`[follow-up-check] ${aiTouchedLeads.size} lead(s) ainda com a IA — follow-up #${followUpNumber} fixo pulado`);
    }
  }

  // Ritmo: outra mensagem automática nas últimas 24 h ou janela do pós-visita → espera
  if (leadsNeedingFollowUp.length > 0) {
    const { data: inst } = await supabase.from("wapi_instances").select("company_id").eq("id", settings.instance_id).maybeSingle();
    if (inst?.company_id) {
      const held = await pacingHeldLeads(supabase, inst.company_id, leadsNeedingFollowUp);
      if (held.size > 0) {
        leadsNeedingFollowUp = leadsNeedingFollowUp.filter((id) => !held.has(id));
        console.log(`[follow-up-check] ${held.size} lead(s) esperam (1 mensagem automática por dia / pós-visita) — follow-up #${followUpNumber}`);
      }
    }
  }

  if (leadsNeedingFollowUp.length === 0) {
    console.log(`[follow-up-check] All potential leads already received follow-up #${followUpNumber} or replied`);
    return { successCount: 0, errors: [] };
  }

  console.log(`[follow-up-check] ${leadsNeedingFollowUp.length} leads need follow-up #${followUpNumber}`);

  // Get lead details and conversation info
  const { data: leads, error: leadsError } = await chunkedInQuery(
    (chunk) =>
      supabase
        .from("campaign_leads")
        .select("id, name, whatsapp, unit, month, guests")
        .in("id", chunk)
        .in("status", ["aguardando_resposta", "orcamento_enviado"]),
    leadsNeedingFollowUp,
  );

  if (leadsError) {
    console.error("[follow-up-check] Error fetching leads:", leadsError);
    return { successCount: 0, errors: [String(leadsError)] };
  }

  if (!leads || leads.length === 0) {
    console.log("[follow-up-check] No leads in aguardando_resposta/orcamento_enviado status need follow-up");
    return { successCount: 0, errors: [] };
  }

  const rampUp = await getReconnectRampUp(supabase, settings.instance_id);

  for (const lead of leads) {
    if (rampUp && successCount >= rampUp.maxSendsPerRun) {
      console.log(`[follow-up-check] 🐢 Ramp-up cap reached (${rampUp.maxSendsPerRun}) for follow-up #${followUpNumber} on instance ${settings.instance_id} — deferring remaining ${leads.length - successCount} sends`);
      break;
    }
    try {
      // Test mode guard: find conversation phone and check
      if (settings.test_mode_enabled && settings.test_mode_number) {
        const { data: testConv } = await supabase
          .from("wapi_conversations")
          .select("remote_jid")
          .eq("lead_id", lead.id)
          .eq("instance_id", settings.instance_id)
          .single();
        if (testConv && shouldSkipTestMode(settings.test_mode_enabled, settings.test_mode_number, testConv.remote_jid)) {
          console.log(`[follow-up-check] 🧪 Test mode active — skipping follow-up #${followUpNumber} for ${lead.name}`);
          continue;
        }
      }

      console.log(`[follow-up-check] Processing lead: ${lead.name} (${lead.id}) for follow-up #${followUpNumber}`);

      // Find the conversation for this lead that belongs to this instance
      const { data: conversation } = await supabase
        .from("wapi_conversations")
        .select("id, instance_id, remote_jid")
        .eq("lead_id", lead.id)
        .eq("instance_id", settings.instance_id)
        .single();

      if (!conversation) {
        console.log(`[follow-up-check] No conversation found for lead ${lead.id} in instance ${settings.instance_id}`);
        continue;
      }

      // Get instance credentials
      const { data: instance } = await supabase
        .from("wapi_instances")
        .select("instance_id, instance_token, company_id, provider, client_token")
        .eq("id", conversation.instance_id)
        .single();

      if (!instance) {
        console.log(`[follow-up-check] No instance found for conversation ${conversation.id}`);
        continue;
      }

      // Fetch company name for {empresa} variable
      let companyName = "nosso buffet";
      if (instance.company_id) {
        const { data: companyData } = await supabase
          .from("companies")
          .select("name")
          .eq("id", instance.company_id)
          .single();
        if (companyData?.name) companyName = companyData.name;
      }

      // Compose follow-up message with variable replacements
      const firstName = resolveFirstName({} as Record<string, unknown>, null, lead.name);
      let personalizedMessage = message
        .replace(/\{nome\}/g, firstName)
        .replace(/\{empresa\}/g, companyName)
        .replace(/\{unidade\}/g, lead.unit || "nossa unidade")
        .replace(/\{mes\}/g, lead.month || "")
        .replace(/\{convidados\}/g, lead.guests || "");

      // Append numbered options if not already present in the message
      const hasOptions = /1️⃣/.test(personalizedMessage) || /\*1\*/.test(personalizedMessage);
      if (!hasOptions) {
        personalizedMessage += `\n\n1️⃣ - Agendar visita\n2️⃣ - Tirar dúvidas\n3️⃣ - Analisar com calma`;
      }

      // Send the message via provider-aware helper
      const fuPhone = conversation.remote_jid.replace("@s.whatsapp.net", "").replace("@c.us", "");
      if (await isConversationPaused(supabase, conversation.id)) {
        console.warn(`[follow-up-check] ⏸ Skipping follow-up to ${lead.name} — conversation paused (loop guard)`);
        continue;
      }
      const slot = await claimSystemSendSlot(supabase, { id: settings.instance_id, provider: instance.provider });
      if (!slot.ok) {
        console.log(`[follow-up-check] ⏱️ Ritmo do sistema (${slot.reason}) — follow-ups #${followUpNumber} restantes ficam para a próxima rodada`);
        break;
      }
      const hasImage = !!(imageUrl && imageUrl.trim().length > 0);
      const sendResult = hasImage
        ? await providerSendImage(instance, fuPhone, imageUrl!, personalizedMessage).then(r => ({ ok: r.ok, messageId: r.messageId, error: r.ok ? undefined : 'send-image failed' }))
        : await providerSendText(instance, fuPhone, personalizedMessage);

      if (!sendResult.ok) {
        console.error(`[follow-up-check] Failed to send message to ${lead.name}:`, sendResult.error);
        errors.push(`Failed to send to ${lead.name}: ${sendResult.error}`);
        continue;
      }

      console.log(`[follow-up-check] Follow-up #${followUpNumber} sent successfully to ${lead.name}${hasImage ? ' (with image)' : ''}`);

      const sentMsgId = sendResult.messageId;

      // Save the message to the database
      await supabase.from("wapi_messages").insert({
        conversation_id: conversation.id,
        content: personalizedMessage,
        from_me: true,
        message_type: hasImage ? "image" : "text",
        media_url: hasImage ? imageUrl : null,
        message_id: sentMsgId,
        status: "sent",
        timestamp: new Date().toISOString(),
        metadata: { source: "auto_reminder", type: `follow_up_${followUpNumber}`, has_image: hasImage },
        company_id: instance.company_id,
      });

      // Update conversation: reactivate bot but keep step as complete_final
      // The webhook already handles complete_final responses by treating them as proximo_passo
      // We do NOT set bot_step to 'proximo_passo' to avoid processNextStepReminder sending a duplicate
      await supabase
        .from("wapi_conversations")
        .update({
          last_message_at: new Date().toISOString(),
          last_message_content: personalizedMessage.substring(0, 100),
          last_message_from_me: true,
          bot_enabled: true,
        })
        .eq("id", conversation.id);

      // Record follow-up in history
      await supabase.from("lead_history").insert({
        lead_id: lead.id,
        company_id: instance.company_id,
        action: historyAction,
        new_value: `Mensagem de acompanhamento #${followUpNumber} após ${delayHours}h`,
      });

      // Create notification for the team (scoped to company)
      const unitLower = (lead.unit || "all").toLowerCase();
      const unitPermission = `leads.unit.${unitLower}`;
      
      // Get users that belong to this company
      const { data: companyUsers } = await supabase
        .from("user_companies")
        .select("user_id")
        .eq("company_id", instance.company_id);
      
      const companyUserIds = companyUsers?.map((u: any) => u.user_id) || [];
      
      let usersToNotify: { user_id: string }[] = [];
      if (companyUserIds.length > 0) {
        const { data: perms } = await supabase
          .from("user_permissions")
          .select("user_id")
          .or(`permission.eq.leads.unit.all,permission.eq.${unitPermission}`)
          .eq("granted", true)
          .in("user_id", companyUserIds);
        
        const { data: adminRoles } = await supabase
          .from("user_roles")
          .select("user_id")
          .eq("role", "admin")
          .in("user_id", companyUserIds);
        
        const ids = new Set<string>();
        perms?.forEach((p: any) => ids.add(p.user_id));
        adminRoles?.forEach((r: any) => ids.add(r.user_id));
        usersToNotify = Array.from(ids).map(id => ({ user_id: id }));
      }

      if (usersToNotify.length > 0) {
        const notifications = usersToNotify.map((u) => ({
          user_id: u.user_id,
          company_id: instance.company_id,
          type: "follow_up_sent",
          title: `📬 Follow-up #${followUpNumber} enviado: ${lead.name}`,
          message: `Mensagem de acompanhamento automático #${followUpNumber} enviada para ${firstName}`,
          data: { lead_id: lead.id, lead_name: lead.name, follow_up_number: followUpNumber },
        }));

        await supabase.from("notifications").insert(notifications);
      }

      successCount++;
      // Número com ritmo do sistema: o próximo só sai depois de 60–180 s (próxima rodada)
      if (slot.paced) break;

      // Safe delay between sends to avoid WhatsApp rate limiting (ramp-up overrides)
      const minDelay = rampUp ? rampUp.minDelay : (settings.follow_up_send_min_delay ?? 8);
      const maxDelay = rampUp ? rampUp.maxDelay : (settings.follow_up_send_max_delay ?? 15);
      if (successCount < leads.length) {
        console.log(`[follow-up-check] ⏳ Waiting ${minDelay}-${maxDelay}s before next follow-up send...`);
        await randomSafeDelay(minDelay, maxDelay);
      }
    } catch (leadError) {
      console.error(`[follow-up-check] Error processing lead ${lead.id}:`, leadError);
      errors.push(`Error with ${lead.name}: ${String(leadError)}`);
    }
  }

  return { successCount, errors };
}

function getDefaultFollowUpMessage(number: number): string {
  if (number === 1) {
    return `Olá, {nome}! 👋

Passando para saber se teve a chance de analisar as informações que enviamos sobre a {empresa}!

Estamos à disposição para esclarecer qualquer dúvida ou agendar uma visita. Podemos te ajudar? 😊`;
  } else if (number === 2) {
    return `Olá, {nome}! 👋

Ainda não tivemos retorno sobre a festa na {empresa}!

Temos pacotes especiais e datas disponíveis para {mes}. Que tal agendar uma visita?

Estamos aqui para te ajudar! 😊`;
  } else if (number === 3) {
    return `Oi, {nome}! 😊

Sei que a decisão leva tempo, mas quero garantir que você não perca as melhores datas para {mes}! 📅

Posso te ajudar com alguma dúvida ou enviar mais informações sobre nossos pacotes?`;
  } else {
    return `{nome}, última chamada! 🎉

As datas para {mes} estão quase esgotadas! Se ainda estiver pensando na festa, esse é o momento ideal para garantir.

Posso reservar um horário para você conhecer nosso espaço?`;
  }
}

// ============= BOT INACTIVE FOLLOW-UP (leads who stopped responding during bot flow) =============

interface BotInactiveFollowUpParams {
  supabase: SupabaseAdmin;
  settings: FollowUpSettings;
}

async function processBotInactiveFollowUp({
  supabase,
  settings,
}: BotInactiveFollowUpParams): Promise<{ successCount: number; errors: string[] }> {
  const errors: string[] = [];
  let successCount = 0;
  const delayMinutes = settings.bot_inactive_followup_delay_minutes || 30;

  console.log(`[follow-up-check] Processing bot-inactive follow-up for instance ${settings.instance_id} with ${delayMinutes}min delay`);

  const now = new Date();
  const cutoffTime = new Date(now.getTime() - delayMinutes * 60 * 1000);
  const maxWindow = new Date(now.getTime() - 24 * 60 * 60 * 1000); // max 24h window

  // Bot steps where a lead can be "stuck" (bot sent question, lead never replied)
  const activeBotSteps = ["nome", "tipo", "mes", "dia", "convidados", "welcome", "lp_sent"];

  // Find conversations stuck at active bot steps where last message is from bot and older than delay
  const { data: stuckConversations, error: convError } = await supabase
    .from("wapi_conversations")
    .select("id, remote_jid, instance_id, lead_id, bot_data, contact_name, bot_step")
    .eq("instance_id", settings.instance_id)
    .eq("bot_enabled", true)
    .eq("last_message_from_me", true)
    // Recebeu campanha e ainda não respondeu: a última mensagem é a campanha, não o robô
    .is("bot_data->>campaign_pending_reply", null)
    .not("remote_jid", "like", "%@g.us%")
    .in("bot_step", activeBotSteps)
    .lte("last_message_at", cutoffTime.toISOString())
    .gte("last_message_at", maxWindow.toISOString());

  if (convError) {
    console.error(`[follow-up-check] Error fetching stuck bot conversations:`, convError);
    return { successCount: 0, errors: [String(convError)] };
  }

  if (!stuckConversations || stuckConversations.length === 0) {
    console.log(`[follow-up-check] No conversations need bot-inactive follow-up for instance ${settings.instance_id}`);
    return { successCount: 0, errors: [] };
  }

  console.log(`[follow-up-check] Found ${stuckConversations.length} conversations needing bot-inactive follow-up`);

  // Get instance credentials
  const { data: instance } = await supabase
    .from("wapi_instances")
    .select("instance_id, instance_token, company_id, provider, client_token")
    .eq("id", settings.instance_id)
    .single();

  if (!instance) {
    console.error(`[follow-up-check] No instance found for ${settings.instance_id}`);
    return { successCount: 0, errors: [`Instance not found: ${settings.instance_id}`] };
  }

  const defaultMsg = `Oi {nome}, notei que você não conseguiu concluir. Estou por aqui caso precise de ajuda! 😊

Podemos continuar de onde paramos?`;
  const messageTemplate = settings.bot_inactive_followup_message || defaultMsg;

  // Pre-fetch bot questions for this instance to re-ask the current step question
  const { data: botQuestions } = await supabase
    .from("wapi_bot_questions")
    .select("step, question_text")
    .eq("instance_id", settings.instance_id)
    .eq("is_active", true);

  // Map step to question text for quick lookup
  const stepQuestionMap: Record<string, string> = {};
  if (botQuestions) {
    for (const q of botQuestions) {
      stepQuestionMap[q.step] = q.question_text;
    }
  }

  const rampUp = await getReconnectRampUp(supabase, settings.instance_id);

  for (const conv of stuckConversations) {
    if (rampUp && successCount >= rampUp.maxSendsPerRun) {
      console.log(`[follow-up-check] 🐢 Ramp-up cap reached (${rampUp.maxSendsPerRun}) for bot-inactive follow-up on instance ${settings.instance_id} — deferring remaining ${stuckConversations.length - successCount} sends`);
      break;
    }
    try {
      // Test mode guard: skip if not the test number
      if (shouldSkipTestMode(settings.test_mode_enabled, settings.test_mode_number, conv.remote_jid)) {
        console.log(`[follow-up-check] 🧪 Test mode active — skipping bot-inactive follow-up for ${conv.remote_jid}`);
        continue;
      }

      const botData = (conv.bot_data || {}) as Record<string, unknown>;
      
      // Skip if already reminded (prevent duplicate reminders)
      if (botData._inactive_reminded) {
        console.log(`[follow-up-check] Skipping conv ${conv.id} - already reminded`);
        continue;
      }
      
      // Try to fetch lead name as additional fallback
      let leadName: string | null = null;
      if (conv.lead_id) {
        const { data: lead } = await supabase
          .from('campaign_leads')
          .select('name')
          .eq('id', conv.lead_id)
          .single();
        leadName = lead?.name || null;
      }
      const firstName = resolveFirstName(botData, conv.contact_name, leadName);
      
      let personalizedMessage = messageTemplate.replace(/\{nome\}/g, firstName);

      // Append the original question the lead didn't answer (from DB or DEFAULT_QUESTIONS fallback)
      const currentStep = conv.bot_step as string;
      const stepQuestion = stepQuestionMap[currentStep];
      if (stepQuestion) {
        const personalizedQuestion = stepQuestion.replace(/\{nome\}/g, firstName);
        personalizedMessage += `\n\n${personalizedQuestion}`;
      } else {
        // Fallback: use default question for this step
        const DEFAULT_QUESTIONS_MAP: Record<string, string> = {
          nome: 'Para começar, me conta: qual é o seu nome? 😊',
          tipo: `Você já é nosso cliente e tem uma festa agendada, ou gostaria de receber um orçamento? 🎉\n\nResponda com o *número*:\n\n1️⃣ Já sou cliente\n2️⃣ Quero um orçamento\n3️⃣ Trabalhe Conosco`,
          mes: `Que legal! 🎉 E pra qual mês você tá pensando em fazer essa festa incrível?\n\n📅 Responda com o *número*:\n\n2️⃣ Fevereiro\n3️⃣ Março\n4️⃣ Abril\n5️⃣ Maio\n6️⃣ Junho\n7️⃣ Julho\n8️⃣ Agosto\n9️⃣ Setembro\n🔟 Outubro\n1️⃣1️⃣ Novembro\n1️⃣2️⃣ Dezembro`,
          dia: `Maravilha! Tem preferência de dia da semana? 🗓️\n\nResponda com o *número*:\n\n1️⃣ Segunda a Quinta\n2️⃣ Sexta\n3️⃣ Sábado\n4️⃣ Domingo`,
          convidados: `E quantos convidados você pretende chamar pra essa festa mágica? 🎈\n\n👥 Responda com o *número*:\n\n1️⃣ 50 pessoas\n2️⃣ 60 pessoas\n3️⃣ 70 pessoas\n4️⃣ 80 pessoas\n5️⃣ 90 pessoas\n6️⃣ 100 pessoas`,
          welcome: 'Para começar, me conta: qual é o seu nome? 😊',
          lp_sent: 'Oi {nome}, ainda estou por aqui! Escolha a opção que mais te agrada:\n\n1️⃣ - Receber agora meu orçamento\n2️⃣ - Falar com um atendente',
        };
        const fallbackQuestion = DEFAULT_QUESTIONS_MAP[currentStep];
        if (fallbackQuestion) {
          const personalizedQuestion = fallbackQuestion.replace(/\{nome\}/g, firstName);
          personalizedMessage += `\n\n${personalizedQuestion}`;
        }
      }
      const phone = conv.remote_jid.replace("@s.whatsapp.net", "").replace("@c.us", "");

      if (await isConversationPaused(supabase, conv.id)) {
        console.warn(`[follow-up-check] ⏸ Skipping bot-inactive follow-up — conversation ${conv.id} paused (loop guard)`);
        continue;
      }

      const slot = await claimSystemSendSlot(supabase, { id: settings.instance_id, provider: instance.provider });
      if (!slot.ok) {
        console.log(`[follow-up-check] ⏱️ Ritmo do sistema (${slot.reason}) — lembretes de robô parado restantes ficam para a próxima rodada`);
        break;
      }

      const sendResult = await providerSendText(instance, phone, personalizedMessage);

      if (!sendResult.ok) {
        console.error(`[follow-up-check] Failed to send bot-inactive follow-up to ${phone}:`, sendResult.error);
        errors.push(`Failed bot-inactive follow-up to ${phone}: ${sendResult.error}`);
        continue;
      }

      console.log(`[follow-up-check] Bot-inactive follow-up sent to ${phone} (was stuck at step: ${conv.bot_step})`);

      const sentMsgId = sendResult.messageId;

      // Save message
      await supabase.from("wapi_messages").insert({
        conversation_id: conv.id,
        content: personalizedMessage,
        from_me: true,
        message_type: "text",
        message_id: sentMsgId,
        status: "sent",
        timestamp: new Date().toISOString(),
        metadata: { source: "auto_reminder", type: "bot_inactive" },
        company_id: instance.company_id,
      });

      // Always keep bot enabled so it can process the lead's reply
      // Mark _inactive_reminded in bot_data to prevent duplicate reminders
      const updatedBotData = { ...botData, _inactive_reminded: true };
      await supabase
        .from("wapi_conversations")
        .update({
          bot_step: conv.bot_step, // keep current step so bot re-processes the answer
          bot_enabled: true, // always reactivate
          bot_data: updatedBotData,
          last_message_at: new Date().toISOString(),
          last_message_content: personalizedMessage.substring(0, 100),
          last_message_from_me: true,
        })
        .eq("id", conv.id);

      successCount++;
      // Número com ritmo do sistema: o próximo só sai depois de 60–180 s (próxima rodada)
      if (slot.paced) break;

      // Safe delay between sends to avoid WhatsApp rate limiting (ramp-up overrides)
      const minDelay = rampUp ? rampUp.minDelay : (settings.follow_up_send_min_delay ?? 8);
      const maxDelay = rampUp ? rampUp.maxDelay : (settings.follow_up_send_max_delay ?? 15);
      if (successCount < stuckConversations.length) {
        console.log(`[follow-up-check] ⏳ Waiting ${minDelay}-${maxDelay}s before next bot-inactive send...`);
        await randomSafeDelay(minDelay, maxDelay);
      }
    } catch (err) {
      console.error(`[follow-up-check] Error processing bot-inactive follow-up for conv ${conv.id}:`, err);
      errors.push(`Error with conv ${conv.id}: ${String(err)}`);
    }
  }

  return { successCount, errors };
}

// ============= AUTO-LOST AFTER 4TH FOLLOW-UP =============

interface ProcessAutoLostParams {
  supabase: SupabaseAdmin;
  settings: FollowUpSettings;
}

async function processAutoLost({
  supabase,
  settings,
}: ProcessAutoLostParams): Promise<{ successCount: number; errors: string[] }> {
  const errors: string[] = [];
  let successCount = 0;
  const delayHours = settings.auto_lost_delay_hours || 48;

  // Determine the last enabled follow-up action dynamically
  let lastFollowUpAction: string | null = null;
  let lastFollowUpLabel: string = "";

  if (settings.follow_up_4_enabled) {
    lastFollowUpAction = "Follow-up #4 automático enviado";
    lastFollowUpLabel = "4º follow-up";
  } else if (settings.follow_up_3_enabled) {
    lastFollowUpAction = "Follow-up #3 automático enviado";
    lastFollowUpLabel = "3º follow-up";
  } else if (settings.follow_up_2_enabled) {
    lastFollowUpAction = "Follow-up #2 automático enviado";
    lastFollowUpLabel = "2º follow-up";
  } else if (settings.follow_up_enabled) {
    lastFollowUpAction = "Follow-up automático enviado";
    lastFollowUpLabel = "1º follow-up";
  }

  if (!lastFollowUpAction) {
    console.log(`[follow-up-check] No follow-ups enabled for instance ${settings.instance_id}, skipping auto-lost`);
    return { successCount: 0, errors: [] };
  }

  console.log(`[follow-up-check] Processing auto-lost for instance ${settings.instance_id} with ${delayHours}h delay after "${lastFollowUpAction}"`);

  const now = new Date();
  const cutoffTime = new Date(now.getTime() - delayHours * 60 * 60 * 1000);

  // Find leads that received the last enabled follow-up before the cutoff
  const { data: lastFollowUps, error: histError } = await supabase
    .from("lead_history")
    .select("lead_id, created_at")
    .eq("action", lastFollowUpAction)
    .lte("created_at", cutoffTime.toISOString());

  if (histError) {
    console.error(`[follow-up-check] Error fetching follow-up history:`, histError);
    return { successCount: 0, errors: [String(histError)] };
  }

  if (!lastFollowUps || lastFollowUps.length === 0) {
    console.log(`[follow-up-check] No leads eligible for auto-lost for instance ${settings.instance_id}`);
    return { successCount: 0, errors: [] };
  }

  // Lead que voltou recomeça a sequência: o último follow-up e o perdido
  // automático da tentativa anterior não contam.
  const candidateIds: string[] = [...new Set<string>(lastFollowUps.map((f: any) => f.lead_id as string))];
  const lastReturns = await fetchLastReturns(supabase, candidateIds);
  const leadIds = [...leadsWithActionSinceReturn(lastFollowUps, lastReturns)];

  // Check which leads already have been auto-lost
  const { data: alreadyLost } = await chunkedInQuery(
    (chunk) =>
      supabase
        .from("lead_history")
        .select("lead_id, created_at")
        .in("lead_id", chunk)
        .eq("action", "Lead movido para perdido automaticamente"),
    leadIds,
  );

  const alreadyLostSet = leadsWithActionSinceReturn(alreadyLost || [], lastReturns);
  const eligibleLeadIds = leadIds.filter((id: any) => !alreadyLostSet.has(id));

  if (eligibleLeadIds.length === 0) {
    console.log(`[follow-up-check] All leads already processed for auto-lost`);
    return { successCount: 0, errors: [] };
  }

  // Get leads that are still in aguardando_resposta
  const { data: activeLeads, error: leadsError } = await chunkedInQuery(
    (chunk) =>
      supabase
        .from("campaign_leads")
        .select("id, name, whatsapp, responsavel_id")
        .in("id", chunk)
        .eq("status", "aguardando_resposta"),
    eligibleLeadIds,
  );

  if (leadsError) {
    console.error(`[follow-up-check] Error fetching active leads:`, leadsError);
    return { successCount: 0, errors: [String(leadsError)] };
  }

  if (!activeLeads || activeLeads.length === 0) {
    console.log(`[follow-up-check] No active leads in aguardando_resposta for auto-lost`);
    return { successCount: 0, errors: [] };
  }

  // Filter: only leads whose conversation belongs to this instance AND last_message_from_me = true (no reply)
  const activeLeadIds = activeLeads.map((l: any) => l.id);
  const { data: conversations } = await chunkedInQuery(
    (chunk) =>
      supabase
        .from("wapi_conversations")
        .select("lead_id")
        .in("lead_id", chunk)
        .eq("instance_id", settings.instance_id)
        .eq("last_message_from_me", true)
        .not("remote_jid", "like", "%@g.us%"),
    activeLeadIds,
  );

  const leadsInInstance = new Set((conversations || []).map((c: { lead_id: string }) => c.lead_id));
  const leadsToMark = activeLeads.filter((l: any) => leadsInInstance.has(l.id));

  console.log(`[follow-up-check] ${leadsToMark.length} leads will be marked as perdido (auto-lost)`);

  // Pre-fetch company_id for this instance (used in history + notifications)
  const { data: instanceData } = await supabase
    .from("wapi_instances")
    .select("company_id, unit")
    .eq("id", settings.instance_id)
    .single();
  const instanceCompanyId = instanceData?.company_id || null;

  // Lead sem responsável: o aviso vai para a equipe do número — só em empresa
  // com a IA (Castelo); nas outras, como sempre, só o responsável é avisado
  let unitTargets: string[] | null = null;
  const fallbackTargets = async (): Promise<string[]> => {
    if (unitTargets) return unitTargets;
    unitTargets = [];
    if (!instanceCompanyId) return unitTargets;
    const { data: company } = await supabase.from("companies").select("settings").eq("id", instanceCompanyId).maybeSingle();
    if (isAiConversationalEnabled(company?.settings)) {
      unitTargets = await resolveUnitNotificationTargets(supabase, instanceCompanyId, instanceData?.unit || null);
    }
    return unitTargets;
  };

  for (const lead of leadsToMark) {
    try {
      // Test mode guard
      if (shouldSkipTestMode(settings.test_mode_enabled, settings.test_mode_number, lead.whatsapp)) {
        console.log(`[follow-up-check] 🧪 Test mode — skipping auto-lost for ${lead.whatsapp}`);
        continue;
      }

      // Update lead status to perdido
      const { error: updateError } = await supabase
        .from("campaign_leads")
        .update({ status: "perdido" })
        .eq("id", lead.id);

      if (updateError) {
        console.error(`[follow-up-check] Error updating lead ${lead.id} to perdido:`, updateError);
        errors.push(`Error updating lead ${lead.id}: ${String(updateError)}`);
        continue;
      }

      // Deactivate bot on conversation linked to this lead
      await supabase
        .from("wapi_conversations")
        .update({ bot_enabled: false, bot_step: 'human_takeover' })
        .eq("lead_id", lead.id);

      // Register in lead_history
      await supabase.from("lead_history").insert({
        lead_id: lead.id,
        company_id: instanceCompanyId,
        user_id: null,
        user_name: "Sistema",
        action: "Lead movido para perdido automaticamente",
        old_value: "aguardando_resposta",
        new_value: "perdido",
      });

      // Aviso: o responsável pelo lead (ou, sem responsável, a equipe do número — só com a IA)
      if (instanceCompanyId) {
        const recipients = lead.responsavel_id ? [lead.responsavel_id] : await fallbackTargets();
        if (recipients.length > 0) {
          const { error: notifError } = await supabase.from("notifications").insert(recipients.map((uid: string) => ({
            user_id: uid,
            company_id: instanceCompanyId,
            type: "lead_lost",
            title: "Lead movido para Perdido",
            message: `O lead ${lead.name} foi movido automaticamente para Perdido após não responder ao ${lastFollowUpLabel}.`,
            data: { lead_id: lead.id, lead_name: lead.name },
          })));
          if (notifError) console.error(`[follow-up-check] Erro ao avisar sobre o perdido (lead ${lead.id}):`, notifError.message);
        }
      }

      console.log(`[follow-up-check] ✅ Lead ${lead.name} (${lead.id}) marked as perdido (auto-lost)`);
      successCount++;
    } catch (err) {
      console.error(`[follow-up-check] Error processing auto-lost for lead ${lead.id}:`, err);
      errors.push(`Error with lead ${lead.id}: ${String(err)}`);
    }
  }

  return { successCount, errors };
}

// ============= FLOW BUILDER TIMER TIMEOUT (checks expired timer nodes and triggers timeout path) =============

const WAPI_BASE_URL = 'https://api.w-api.app/v1';
const ZAPI_BASE_URL = 'https://api.z-api.io/instances';

type Provider = 'wapi' | 'zapi' | 'evolution';

// "Não enviar mais nada": recarregado a cada rodada; nenhum envio daqui sai
// para um número bloqueado (follow-ups, lembretes, retomada do bot, materiais)
let isBlockedContact: (companyId: string | null | undefined, phoneOrJid: string | null | undefined) => boolean = () => false;

interface InstanceInfo {
  instance_id: string;
  instance_token: string;
  company_id: string;
  provider?: Provider | string | null;
  client_token?: string | null;
  id?: string;
  unit?: string | null;
}

/**
 * Provider-aware send-text helper. Routes to W-API or Z-API based on provider.
 * Returns { ok, messageId, error }
 */
async function providerSendText(
  inst: InstanceInfo,
  phone: string,
  message: string,
  extraBody?: Record<string, unknown>,
): Promise<{ ok: boolean; messageId: string | null; error?: string }> {
  const provider = (inst.provider || 'wapi') as Provider;
  if (isBlockedContact(inst.company_id, phone)) {
    console.log(`[follow-up-check] 🚫 Contato bloqueado ("Não enviar mais nada") — envio ignorado`);
    return { ok: false, messageId: null, error: 'contact_blocked' };
  }
  try {
    if (provider === 'evolution') {
      const r = await evolutionSendText(inst.instance_token, phone, message);
      return r.ok ? { ok: true, messageId: extractEvolutionMessageId(r.data) } : { ok: false, messageId: null, error: r.error };
    }
    let res: Response;
    if (provider === 'zapi') {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (inst.client_token) headers['Client-Token'] = inst.client_token;
      // Link de formulário/contrato: vai com prévia; se a Z-API recusar, segue como texto
      const linkBody = extraBody ? null : await zapiLinkBody(phone.replace(/\D/g, ''), message);
      if (linkBody) {
        const lr = await fetch(`${ZAPI_BASE_URL}/${inst.instance_id}/token/${inst.instance_token}/send-link`, { method: 'POST', headers, body: JSON.stringify(linkBody) });
        const ld = await lr.json().catch(() => null);
        if (lr.ok && ld && !ld.error) return { ok: true, messageId: ld.zapiMessageId || ld.messageId || null };
        console.warn(`[follow-up-check] Z-API send-link falhou (${lr.status}) — enviando como texto`);
      }
      const url = `${ZAPI_BASE_URL}/${inst.instance_id}/token/${inst.instance_token}/send-text`;
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ phone: phone.replace(/\D/g, ''), message, ...extraBody }),
      });
    } else {
      res = await fetch(`${WAPI_BASE_URL}/message/send-text?instanceId=${inst.instance_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${inst.instance_token}` },
        body: JSON.stringify({ phone, message, ...extraBody }),
      });
    }
    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, messageId: null, error: errText };
    }
    const data = await res.json();
    const messageId = data?.zapiMessageId || data?.messageId || data?.result?.key?.id || data?.key?.id || data?.data?.messageId || data?.id || null;
    return { ok: true, messageId };
  } catch (err) {
    return { ok: false, messageId: null, error: String(err) };
  }
}

/** Provider-aware send-image helper */
async function providerSendImage(
  inst: InstanceInfo,
  phone: string,
  image: string,
  caption?: string,
): Promise<{ ok: boolean; messageId: string | null }> {
  const provider = (inst.provider || 'wapi') as Provider;
  if (isBlockedContact(inst.company_id, phone)) {
    console.log(`[follow-up-check] 🚫 Contato bloqueado ("Não enviar mais nada") — envio ignorado`);
    return { ok: false, messageId: null };
  }
  try {
    if (provider === 'evolution') {
      const r = await evolutionSendMedia(inst.instance_token, phone, 'image', image, { caption });
      return { ok: r.ok, messageId: r.ok ? extractEvolutionMessageId(r.data) : null };
    }
    let res: Response;
    if (provider === 'zapi') {
      const url = `${ZAPI_BASE_URL}/${inst.instance_id}/token/${inst.instance_token}/send-image`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (inst.client_token) headers['Client-Token'] = inst.client_token;
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ phone: phone.replace(/\D/g, ''), image, caption }) });
    } else {
      res = await fetch(`${WAPI_BASE_URL}/message/send-image?instanceId=${inst.instance_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${inst.instance_token}` },
        body: JSON.stringify({ phone, image, caption }),
      });
    }
    if (!res.ok) return { ok: false, messageId: null };
    const r = await res.json();
    return { ok: true, messageId: r.zapiMessageId || r.messageId || null };
  } catch { return { ok: false, messageId: null }; }
}

/** Provider-aware send-video helper */
async function providerSendVideo(
  inst: InstanceInfo,
  phone: string,
  video: string,
  caption?: string,
): Promise<{ ok: boolean; messageId: string | null }> {
  const provider = (inst.provider || 'wapi') as Provider;
  if (isBlockedContact(inst.company_id, phone)) {
    console.log(`[follow-up-check] 🚫 Contato bloqueado ("Não enviar mais nada") — envio ignorado`);
    return { ok: false, messageId: null };
  }
  try {
    if (provider === 'evolution') {
      const r = await evolutionSendMedia(inst.instance_token, phone, 'video', video, { caption });
      return { ok: r.ok, messageId: r.ok ? extractEvolutionMessageId(r.data) : null };
    }
    let res: Response;
    if (provider === 'zapi') {
      const url = `${ZAPI_BASE_URL}/${inst.instance_id}/token/${inst.instance_token}/send-video`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (inst.client_token) headers['Client-Token'] = inst.client_token;
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ phone: phone.replace(/\D/g, ''), video, caption }) });
    } else {
      res = await fetch(`${WAPI_BASE_URL}/message/send-video?instanceId=${inst.instance_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${inst.instance_token}` },
        body: JSON.stringify({ phone, video, caption }),
      });
    }
    if (!res.ok) return { ok: false, messageId: null };
    const r = await res.json();
    return { ok: true, messageId: r.zapiMessageId || r.messageId || null };
  } catch { return { ok: false, messageId: null }; }
}

/** Provider-aware send-document helper */
async function providerSendDocument(
  inst: InstanceInfo,
  phone: string,
  document: string,
  fileName: string,
): Promise<{ ok: boolean; messageId: string | null }> {
  const provider = (inst.provider || 'wapi') as Provider;
  if (isBlockedContact(inst.company_id, phone)) {
    console.log(`[follow-up-check] 🚫 Contato bloqueado ("Não enviar mais nada") — envio ignorado`);
    return { ok: false, messageId: null };
  }
  const ext = document.split('.').pop()?.split('?')[0] || 'pdf';
  try {
    if (provider === 'evolution') {
      const r = await evolutionSendMedia(inst.instance_token, phone, 'document', document, { filename: fileName });
      return { ok: r.ok, messageId: r.ok ? extractEvolutionMessageId(r.data) : null };
    }
    let res: Response;
    if (provider === 'zapi') {
      const url = `${ZAPI_BASE_URL}/${inst.instance_id}/token/${inst.instance_token}/send-document/${ext}`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (inst.client_token) headers['Client-Token'] = inst.client_token;
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ phone: phone.replace(/\D/g, ''), document, fileName }) });
    } else {
      res = await fetch(`${WAPI_BASE_URL}/message/send-document?instanceId=${inst.instance_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${inst.instance_token}` },
        body: JSON.stringify({ phone, document, fileName, extension: ext }),
      });
    }
    if (!res.ok) return { ok: false, messageId: null };
    const r = await res.json();
    return { ok: true, messageId: r.zapiMessageId || r.messageId || null };
  } catch { return { ok: false, messageId: null }; }
}

interface FlowTimerParams {
  supabase: SupabaseAdmin;
}

async function processFlowTimerTimeouts({
  supabase,
}: FlowTimerParams): Promise<{ successCount: number; errors: string[] }> {
  const errors: string[] = [];
  let successCount = 0;

  console.log(`[follow-up-check] Processing flow builder timer timeouts...`);

  // Find all flow_lead_state records that are waiting for reply
  const { data: waitingStates, error: statesError } = await supabase
    .from('flow_lead_state')
    .select('id, conversation_id, flow_id, current_node_id, last_sent_at, collected_data')
    .eq('waiting_for_reply', true)
    .not('current_node_id', 'is', null)
    .not('last_sent_at', 'is', null);

  if (statesError) {
    console.error(`[follow-up-check] Error fetching waiting states:`, statesError);
    return { successCount: 0, errors: [String(statesError)] };
  }

  if (!waitingStates || waitingStates.length === 0) {
    console.log(`[follow-up-check] No flow timer states waiting`);
    return { successCount: 0, errors: [] };
  }

  console.log(`[follow-up-check] Found ${waitingStates.length} waiting flow states to check`);

  for (const state of waitingStates) {
    try {
      // Get the current node to check if it's a timer
      const { data: currentNode } = await supabase
        .from('flow_nodes')
        .select('id, node_type, action_config, message_template, flow_id')
        .eq('id', state.current_node_id)
        .single();

      if (!currentNode || currentNode.node_type !== 'timer') {
        continue; // Not a timer node, skip
      }

      const timeoutMinutes = ((currentNode.action_config as Record<string, unknown>)?.timeout_minutes as number) || 10;
      const lastSentAt = new Date(state.last_sent_at!);
      const now = new Date();
      const elapsedMinutes = (now.getTime() - lastSentAt.getTime()) / (60 * 1000);

      if (elapsedMinutes < timeoutMinutes) {
        continue; // Timer hasn't expired yet
      }

      console.log(`[follow-up-check] ⏱️ Timer expired for state ${state.id} (${elapsedMinutes.toFixed(1)}min > ${timeoutMinutes}min)`);

      // Get the timeout option and edge
      const { data: nodeOptions } = await supabase
        .from('flow_node_options')
        .select('id, value')
        .eq('node_id', currentNode.id);

      const timeoutOption = nodeOptions?.find((o: any) => o.value === 'timeout');
      if (!timeoutOption) {
        console.log(`[follow-up-check] No timeout option found for timer node ${currentNode.id}`);
        continue;
      }

      const { data: timeoutEdge } = await supabase
        .from('flow_edges')
        .select('id, target_node_id')
        .eq('source_node_id', currentNode.id)
        .eq('source_option_id', timeoutOption.id)
        .single();

      if (!timeoutEdge) {
        console.log(`[follow-up-check] No timeout edge found for timer node ${currentNode.id}`);
        // Mark as no longer waiting to avoid re-checking
        await supabase.from('flow_lead_state').update({
          waiting_for_reply: false,
        }).eq('id', state.id);
        continue;
      }

      // Get conversation and instance info
      const { data: conv } = await supabase
        .from('wapi_conversations')
        .select('id, remote_jid, instance_id, company_id, contact_name, bot_data')
        .eq('id', state.conversation_id)
        .single();

      if (!conv) {
        console.log(`[follow-up-check] Conversation not found for state ${state.id}`);
        continue;
      }

      // Test mode guard for flow timer timeouts
      {
        const { data: tmSettings } = await supabase
          .from('wapi_bot_settings')
          .select('test_mode_enabled, test_mode_number')
          .eq('instance_id', conv.instance_id)
          .single();
        if (shouldSkipTestMode(tmSettings?.test_mode_enabled, tmSettings?.test_mode_number, conv.remote_jid)) {
          console.log(`[follow-up-check] 🧪 Test mode active — skipping flow timer timeout for ${conv.remote_jid}`);
          continue;
        }
      }

      const { data: instance } = await supabase
        .from('wapi_instances')
        .select('id, instance_id, instance_token, unit, company_id, provider, client_token')
        .eq('id', conv.instance_id)
        .single();

      if (!instance) {
        console.log(`[follow-up-check] Instance not found for conversation ${conv.id}`);
        continue;
      }

      // === HEALTH GATE for flow timer timeouts (per-instance) ===
      const timerHealth = await checkInstanceHealth(supabase, instance.id);
      if (!timerHealth.healthy) {
        console.log(`[follow-up-check] 🛡️ Flow timer timeout BLOCKED for conv ${conv.id}: ${timerHealth.reason}`);
        continue;
      }

      // Get target node
      const { data: targetNode } = await supabase
        .from('flow_nodes')
        .select('id, node_type, title, message_template, action_type, action_config, extract_field')
        .eq('id', timeoutEdge.target_node_id)
        .single();

      if (!targetNode) {
        console.log(`[follow-up-check] Target node not found for timeout edge`);
        continue;
      }

      const phone = conv.remote_jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
      const collectedData = (state.collected_data || {}) as Record<string, string>;
      const firstName = collectedData.customer_name || collectedData.nome || 
        (conv.contact_name || '').split(' ')[0] || 'cliente';

      // Helper to replace variables in messages
      const replaceVars = (template: string) => {
        return template
          .replace(/\{nome\}/g, firstName)
          .replace(/\{customer_name\}/g, collectedData.customer_name || firstName)
          .replace(/\{event_date\}/g, collectedData.event_date || '')
          .replace(/\{guest_count\}/g, collectedData.guest_count || '')
          .replace(/\{child_name\}/g, collectedData.child_name || '')
          .replace(/\{child_age\}/g, collectedData.child_age || '');
      };

      // Send target node message if it has one
      if (targetNode.message_template) {
        const msg = replaceVars(targetNode.message_template);
        const sendRes = await providerSendText(instance, phone, msg, { delayTyping: 1 });

        if (sendRes.ok) {
          const msgId = sendRes.messageId;

          await supabase.from('wapi_messages').insert({
            conversation_id: conv.id, message_id: msgId, from_me: true,
            message_type: 'text', content: msg, status: 'sent',
            timestamp: new Date().toISOString(), company_id: instance.company_id,
          });

          await supabase.from('wapi_conversations').update({
            last_message_at: new Date().toISOString(),
            last_message_content: msg.substring(0, 100),
            last_message_from_me: true,
          }).eq('id', conv.id);
        } else {
          const errText = await sendRes.error || 'unknown error';
          console.error(`[follow-up-check] Failed to send timer timeout message: ${errText}`);
        }
      }

      // Update flow state to target node
      await supabase.from('flow_lead_state').update({
        current_node_id: targetNode.id,
        waiting_for_reply: targetNode.node_type === 'question' || targetNode.node_type === 'timer',
        last_sent_at: new Date().toISOString(),
      }).eq('id', state.id);

      // Update conversation bot_step
      const newBotStep = targetNode.node_type === 'end' ? 'flow_complete' : `flow_node_${targetNode.id}`;
      await supabase.from('wapi_conversations').update({
        bot_step: newBotStep,
        bot_enabled: targetNode.node_type !== 'end',
      }).eq('id', conv.id);

      // Handle handoff action on target node
      if (targetNode.node_type === 'action' && targetNode.action_type === 'handoff') {
        await supabase.from('wapi_conversations').update({
          bot_enabled: false,
          bot_step: 'flow_handoff',
        }).eq('id', conv.id);
        
        await supabase.from('flow_lead_state').update({
          waiting_for_reply: false,
        }).eq('id', state.id);
      }

      // Handle end node
      if (targetNode.node_type === 'end') {
        await supabase.from('flow_lead_state').update({
          waiting_for_reply: false,
        }).eq('id', state.id);
      }

      console.log(`[follow-up-check] ⏱️ Timer timeout processed: state ${state.id} → node ${targetNode.title} (${targetNode.node_type})`);
      successCount++;
    } catch (err) {
      console.error(`[follow-up-check] Error processing timer timeout for state ${state.id}:`, err);
      errors.push(`Timer error state ${state.id}: ${String(err)}`);
    }
  }

  return { successCount, errors };
}

// ============= STUCK MESSAGE ALERTS (mensagem enviada mas nunca confirmada como entregue) =============
//
// "sent" é o status mais baixo (o WhatsApp só recebeu do provedor); se depois de
// um tempo razoável ela não virou "delivered"/"read", o mais provável é que a
// sessão do número caiu bem na hora do envio e a mensagem nunca chegou de verdade
// ao cliente — sem isso, ninguém percebe até o cliente reclamar.
//
// O alerta é por NÚMERO do buffet (regras em _shared/stuck-alert.ts): um cliente
// isolado sem o segundo tique costuma ser o celular dele desligado, então só
// avisamos quando várias conversas travam juntas ou quando o número parou de
// mandar qualquer aviso para a plataforma — nesse caso também religamos o webhook.

const STUCK_MESSAGE_MINUTES = 15; // tempo sem confirmação para considerar "travada"
const STUCK_MESSAGE_MAX_AGE_HOURS = 6; // não alerta de casos muito antigos (já esfriaram)
const STUCK_INSTANCE_ALERT_COOLDOWN_MINUTES = 60; // no máximo um alerta por número por hora


const MEDIA_LABEL: Record<string, string> = { video: "vídeo", image: "foto", document: "PDF/arquivo", audio: "áudio" };

async function processUnconfirmedMedia({
  supabase,
}: { supabase: SupabaseAdmin }): Promise<{ successCount: number; errors: string[] }> {
  const errors: string[] = [];
  let successCount = 0;
  const nowMs = Date.now();
  const { data: rows, error } = await supabase
    .from("wapi_messages")
    .select("id, conversation_id, message_id, message_type, content, media_url, timestamp, metadata, company_id")
    .eq("from_me", true)
    .eq("status", "pending")
    .eq("metadata->>ack", "awaiting")
    .lte("timestamp", new Date(nowMs - MEDIA_ACK_TIMEOUT_MS).toISOString())
    .gte("timestamp", new Date(nowMs - 24 * 3600 * 1000).toISOString())
    .order("timestamp", { ascending: true })
    .limit(50);
  if (error) return { successCount: 0, errors: [String(error.message || error)] };
  if (!rows || rows.length === 0) return { successCount: 0, errors: [] };

  const convIds = Array.from(new Set(rows.map((r: any) => r.conversation_id)));
  const { data: convs } = await supabase
    .from("wapi_conversations")
    .select("id, remote_jid, contact_name, contact_phone, instance_id, lead_id")
    .in("id", convIds);
  const convById = new Map((convs || []).map((c: any) => [c.id, c]));
  const instIds = Array.from(new Set((convs || []).map((c: any) => c.instance_id).filter(Boolean)));
  const { data: insts } = instIds.length
    ? await supabase.from("wapi_instances").select("id, instance_id, instance_token, unit, company_id").in("id", instIds)
    : { data: [] as any[] };
  const instById = new Map((insts || []).map((i: any) => [i.id, i]));
  const merge = (meta: MediaAckMeta | null, patch: Record<string, unknown>) => ({ ...(meta || {}), ...patch });

  for (const row of rows as any[]) {
    try {
      const meta = (row.metadata || {}) as MediaAckMeta & Record<string, unknown>;
      // O aviso do WhatsApp pode ter chegado antes de a mensagem ser gravada
      const { data: ackEvent } = await supabase
        .from("wapi_webhook_raw_events")
        .select("id")
        .eq("message_id", row.message_id)
        .eq("event_type", "MessageStatusCallback")
        .limit(1);
      if (ackEvent && ackEvent.length > 0) {
        await supabase.from("wapi_messages").update({ status: "sent", metadata: merge(meta, { ack: "confirmed" }) }).eq("id", row.id).eq("status", "pending");
        continue;
      }

      const conv = convById.get(row.conversation_id) as any;
      const inst = conv ? instById.get(conv.instance_id) as any : null;
      // A instância anda mandando avisos de status? Sem isso não dá para saber se saiu.
      const { data: anyAck } = inst
        ? await supabase
          .from("wapi_webhook_raw_events")
          .select("id")
          .eq("instance_id", inst.instance_id)
          .eq("event_type", "MessageStatusCallback")
          .gte("received_at", row.timestamp)
          .limit(1)
        : { data: [] as any[] };
      const decision = decideUnconfirmedMedia(row, nowMs, !!inst && !!anyAck && anyAck.length > 0);
      const label = MEDIA_LABEL[row.message_type] || "mídia";

      if (decision === "wait") continue;
      if (decision === "skip") {
        // Sem avisos de status na instância: volta ao comportamento antigo (um tique)
        await supabase.from("wapi_messages").update({ status: "sent", metadata: merge(meta, { ack: "unverified" }) }).eq("id", row.id).eq("status", "pending");
        continue;
      }

      if (decision === "retry" && conv && inst && meta.resend) {
        const phone = String(conv.remote_jid || "").replace("@s.whatsapp.net", "").replace("@c.us", "").replace(/\D/g, "");
        const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/wapi-send`, {
          method: "POST",
          headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            action: meta.resend.action,
            phone,
            instanceId: inst.instance_id,
            instanceToken: inst.instance_token,
            conversationId: conv.id,
            companyId: inst.company_id,
            mediaUrl: meta.resend.mediaUrl,
            caption: meta.resend.caption || "",
            fileName: meta.resend.fileName,
            source: "bot",
            automation: true,
            retryOf: row.id,
            messageSource: meta.source === "ai_agent" ? "ai_agent" : undefined,
          }),
        });
        const resBody = await res.json().catch(() => null);
        const ok = res.ok && resBody?.success !== false && !resBody?.error;
        await supabase.from("wapi_messages").update({
          status: "error",
          metadata: merge(meta, { ack: "failed", retried_by: ok ? (resBody?.messageId ?? null) : null }),
        }).eq("id", row.id);
        console.warn(`[follow-up-check] 🔁 ${label} sem confirmação do WhatsApp (conv ${conv.id}, msg ${row.message_id}) — reenvio: ${ok ? `OK (${resBody?.messageId})` : `falhou (${res.status} ${JSON.stringify(resBody)?.slice(0, 200)})`}`);
        if (ok) { successCount++; continue; }
      } else {
        await supabase.from("wapi_messages").update({ status: "error", metadata: merge(meta, { ack: "failed" }) }).eq("id", row.id);
        console.warn(`[follow-up-check] ❌ ${label} não chegou ao WhatsApp (conv ${row.conversation_id}, msg ${row.message_id}${meta.retry_of ? ", já era o reenvio" : ""})`);
      }

      // Não saiu nem no reenvio: avisa a equipe no sininho
      if (conv && inst) {
        const name = conv.contact_name || conv.contact_phone || "Cliente";
        const targets = await resolveUnitNotificationTargets(supabase, inst.company_id, inst.unit);
        if (targets.length > 0) {
          await supabase.from("notifications").insert(targets.map((uid: string) => ({
            user_id: uid,
            company_id: inst.company_id,
            type: "media_not_delivered",
            title: `📵 ${label.charAt(0).toUpperCase()}${label.slice(1)} não chegou ao cliente`,
            message: `O ${label} enviado para ${name} (${inst.unit || "WhatsApp"}) não chegou no WhatsApp${meta.retry_of || decision === "retry" ? ", nem na nova tentativa" : ""}. Reenvie pela conversa ou mande por outro meio.`,
            data: { conversation_id: conv.id, lead_id: conv.lead_id, contact_phone: conv.contact_phone, unit: inst.unit, reason: "media_not_delivered", message_id: row.message_id, media_url: row.media_url },
            read: false,
          })));
        }
      }
      successCount++;
    } catch (e) {
      errors.push(String(e));
    }
  }
  return { successCount, errors };
}

async function processStuckSentMessages({
  supabase,
}: { supabase: SupabaseAdmin }): Promise<{ successCount: number; errors: string[] }> {
  const errors: string[] = [];
  let successCount = 0;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const cutoff = new Date(nowMs - STUCK_MESSAGE_MINUTES * 60 * 1000).toISOString();
  const tooOld = new Date(nowMs - STUCK_MESSAGE_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();

  const { data: stuckMessages, error } = await supabase
    .from("wapi_messages")
    .select("id, conversation_id, timestamp")
    .eq("from_me", true)
    .eq("status", "sent")
    .is("stuck_alert_sent_at", null)
    .lte("timestamp", cutoff)
    .gte("timestamp", tooOld)
    .limit(500);

  if (error) {
    console.error("[follow-up-check] Erro ao buscar mensagens travadas:", error);
    return { successCount: 0, errors: [String(error)] };
  }
  if (!stuckMessages || stuckMessages.length === 0) return { successCount: 0, errors: [] };

  // Toda mensagem olhada aqui é marcada no fim, com ou sem alerta, para não ser
  // reavaliada a cada execução.
  const markChecked = async (ids: string[]) => {
    if (ids.length === 0) return;
    const { error: markErr } = await supabase.from("wapi_messages").update({ stuck_alert_sent_at: nowIso }).in("id", ids);
    if (markErr) errors.push(String(markErr));
  };

  const convIds = Array.from(new Set(stuckMessages.map((m: any) => m.conversation_id)));
  const { data: convs } = await supabase
    .from("wapi_conversations")
    .select("id, contact_name, contact_phone, remote_jid, instance_id, lead_id")
    .in("id", convIds);
  const convById = new Map((convs || []).map((c: any) => [c.id, c]));

  const instanceIds = Array.from(new Set((convs || []).map((c: any) => c.instance_id).filter(Boolean)));
  const { data: instances } = instanceIds.length
    ? await supabase.from("wapi_instances").select("id, instance_id, instance_token, unit, company_id, is_active").in("id", instanceIds)
    : { data: [] as any[] };
  const instById = new Map((instances || []).map((i: any) => [i.id, i]));

  const { data: tmRows } = instanceIds.length
    ? await supabase.from("wapi_bot_settings").select("instance_id, test_mode_enabled, test_mode_number").in("instance_id", instanceIds)
    : { data: [] as any[] };
  const tmByInstance = new Map((tmRows || []).map((t: any) => [t.instance_id, t]));

  // Agrupa por NÚMERO do buffet: o alerta é sobre o número, não sobre cada cliente
  type Group = { inst: any; msgIds: string[]; convs: Map<string, any>; oldest: string };
  const groups = new Map<string, Group>();
  const skipIds: string[] = [];
  for (const m of stuckMessages as any[]) {
    const conv = convById.get(m.conversation_id) as any;
    const inst = conv ? instById.get(conv.instance_id) as any : null;
    // Conversa apagada, número desativado ou sem instância: nada a avisar
    if (!conv || !inst || inst.is_active === false) { skipIds.push(m.id); continue; }
    const tm = tmByInstance.get(inst.id) as any;
    if (shouldSkipTestMode(tm?.test_mode_enabled, tm?.test_mode_number, conv.remote_jid || "")) { skipIds.push(m.id); continue; }
    const g: Group = groups.get(inst.id) || { inst, msgIds: [], convs: new Map(), oldest: m.timestamp };
    g.msgIds.push(m.id);
    g.convs.set(conv.id, conv);
    if (m.timestamp < g.oldest) g.oldest = m.timestamp;
    groups.set(inst.id, g);
  }
  await markChecked(skipIds);

  for (const [instId, g] of groups) {
    const inst = g.inst;
    try {
      const { data: lastEvent } = await supabase
        .from("wapi_webhook_raw_events")
        .select("received_at")
        .eq("instance_id", inst.instance_id)
        .order("received_at", { ascending: false })
        .limit(1);
      const lastWebhookEventAt = lastEvent?.[0]?.received_at ?? null;
      // Quantas conversas desse número receberam mensagem da plataforma no mesmo período
      const { data: sentRows } = await supabase
        .from("wapi_messages")
        .select("conversation_id, wapi_conversations!inner(instance_id)")
        .eq("from_me", true)
        .eq("wapi_conversations.instance_id", instId)
        .lte("timestamp", cutoff)
        .gte("timestamp", tooOld)
        .limit(5000);
      const activeConversationCount = new Set((sentRows || []).map((r: any) => r.conversation_id)).size;
      // Evolution: o monitor checa status + /user/check a cada 5 min; se ele
      // confirmou o número online há pouco, falta de aviso é só falta de mensagem
      const { data: health } = await supabase.from("provider_health").select("state, last_check_at").eq("key", `instance:${instId}`).maybeSingle();
      const providerConfirmedOnline = health?.state === "online" && !!health.last_check_at && nowMs - Date.parse(health.last_check_at) < 15 * 60 * 1000;
      const decision = decideStuckAlert({ conversationCount: g.convs.size, activeConversationCount, lastWebhookEventAt, now: nowMs, providerConfirmedOnline });

      if (!decision.notify) {
        // Só um ou dois clientes sem o segundo tique: normalmente é o celular do
        // cliente desligado/sem internet — não é problema do número do buffet.
        await markChecked(g.msgIds);
        continue;
      }

      const cooldownSince = new Date(nowMs - STUCK_INSTANCE_ALERT_COOLDOWN_MINUTES * 60 * 1000).toISOString();
      const { data: recentAlert } = await supabase
        .from("notifications")
        .select("id")
        .eq("company_id", inst.company_id)
        .eq("type", "message_stuck")
        .eq("data->>instance_id", instId)
        .gte("created_at", cooldownSince)
        .limit(1);
      if (recentAlert && recentAlert.length > 0) {
        console.log(`[follow-up-check] Alerta de mensagem travada para ${inst.unit} já enviado há pouco — só marcando`);
        await markChecked(g.msgIds);
        continue;
      }

      // Número mudo: o provedor costuma "perder" a configuração de webhook (ver
      // src/lib/wapi-webhook-config.ts). Religa automaticamente antes de avisar.
      let webhookReconfigured = false;
      if (decision.webhookSilent) {
        try {
          const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/wapi-send`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              action: "configure-webhooks",
              webhookUrl: `${Deno.env.get("SUPABASE_URL")}/functions/v1/wapi-webhook`,
              instanceId: inst.instance_id,
              instanceToken: inst.instance_token,
            }),
          });
          const resBody = await res.json().catch(() => null);
          webhookReconfigured = res.ok && resBody?.success !== false;
          console.log(`[follow-up-check] 🔌 ${inst.unit} sem avisos do WhatsApp desde ${lastWebhookEventAt ?? "nunca"} — reconfigurar webhooks: ${webhookReconfigured ? "OK" : `falhou (${res.status} ${JSON.stringify(resBody)?.substring(0, 200)})`}`);
        } catch (e) {
          console.error(`[follow-up-check] Erro ao reconfigurar webhooks de ${inst.unit}:`, e);
        }
      }

      const convList = Array.from(g.convs.values());
      const contacts = formatContactList(convList.map((c: any) => c.contact_name || c.contact_phone || ""));
      const unitLabel = inst.unit || "WhatsApp";
      const minutesStuck = Math.max(STUCK_MESSAGE_MINUTES, Math.round((nowMs - new Date(g.oldest).getTime()) / 60000));
      const countLabel = g.msgIds.length > 1 ? `${g.msgIds.length} mensagens` : "1 mensagem";

      const title = decision.webhookSilent
        ? `⚠️ ${unitLabel}: mensagens podem não estar chegando`
        : `⚠️ ${unitLabel}: mensagens sem confirmação de entrega`;
      const message = decision.webhookSilent
        ? `Atenção: o WhatsApp do ${unitLabel} não manda avisos para a plataforma há mais de 2h e ${countLabel} enviada(s) (${contacts}) seguem sem confirmação. ${webhookReconfigured ? "Já religamos a conexão automaticamente. " : ""}${SAFE_CHECK_HINT}`
        : `${countLabel} para ${g.convs.size} contatos (${contacts}) sem confirmação de entrega há mais de ${minutesStuck} min. Pode ser instabilidade na conexão do número — vale conferir e reenviar.`;

      // Número mudo: avisa também o dono da plataforma no WhatsApp (no máximo a cada 3h por número)
      let ownerWhatsAppSent = false;
      if (decision.webhookSilent) {
        ownerWhatsAppSent = await sendOwnerSilentInstanceAlert(supabase, inst, instId, lastWebhookEventAt);
      }

      const targetUserIds = await resolveUnitNotificationTargets(supabase, inst.company_id, inst.unit);
      if (targetUserIds.length > 0) {
        const single = convList.length === 1 ? convList[0] : null;
        const notifications = targetUserIds.map((uid: string) => ({
          user_id: uid,
          company_id: inst.company_id,
          type: "message_stuck",
          title,
          message,
          data: {
            instance_id: instId,
            unit: inst.unit,
            conversation_ids: convList.map((c: any) => c.id),
            message_count: g.msgIds.length,
            webhook_silent: decision.webhookSilent,
            webhook_reconfigured: webhookReconfigured,
            last_webhook_event_at: lastWebhookEventAt,
            owner_whatsapp_sent: ownerWhatsAppSent,
            ...(single ? { conversation_id: single.id, lead_id: single.lead_id, contact_phone: single.contact_phone } : {}),
          },
        }));
        const { error: notifErr } = await supabase.from("notifications").insert(notifications);
        if (notifErr) {
          console.error("[follow-up-check] Erro ao criar alerta de mensagem travada:", notifErr);
          errors.push(String(notifErr));
          continue;
        }
      }

      await markChecked(g.msgIds);
      console.log(`[follow-up-check] ⚠️ Alerta de mensagem travada: ${unitLabel} (${g.msgIds.length} msg em ${g.convs.size} conversas, webhook mudo=${decision.webhookSilent})`);
      successCount++;
    } catch (e) {
      console.error(`[follow-up-check] Erro inesperado no alerta de mensagem travada (instância ${instId}):`, e);
      errors.push(String(e));
    }
  }

  return { successCount, errors };
}

// ============= CLIENTE SEM RESPOSTA DO ROBÔ (rede de segurança) =============
//
// Regras em _shared/unanswered-bot.ts. Pega qualquer causa: reconexão do número,
// mensagem que a plataforma não consegue ler ("[Mensagem]"), falha nova.

// ============= ALERTA FORTE: PASSAGEM DA IA SEM RESPOSTA DA EQUIPE =============
// A IA (beta) marca bot_data.ai_handoff = { at, reason, lead_name, alerted_at }
// ao passar a conversa. Se ninguém da equipe responder em
// ai_agent_settings.handoff_alert_minutes (padrão 10) minutos DENTRO do
// horário de atendimento (team_hours; vazio = padrão 9h–18h, sáb 9h–13h), manda um
// WhatsApp para ai_agent_settings.handoff_alert_phone (a partir de um número
// da própria empresa) e um novo aviso no sininho. Um alerta por passagem.
const DEFAULT_HANDOFF_ALERT_MINUTES = 10;

async function processAiHandoffAlerts({
  supabase,
}: { supabase: SupabaseAdmin }): Promise<{ sent: number; errors: string[] }> {
  const errors: string[] = [];
  let sent = 0;
  const nowMs = Date.now();
  const oldest = new Date(nowMs - 3 * 86400000).toISOString();

  const { data: convs, error } = await supabase
    .from("wapi_conversations")
    .select("id, instance_id, lead_id, contact_name, contact_phone, remote_jid, bot_data")
    .eq("bot_step", "human_takeover")
    .not("bot_data->ai_handoff->>at", "is", null)
    .is("bot_data->ai_handoff->>alerted_at", null)
    .gte("last_message_at", oldest)
    .limit(100);
  if (error) return { sent, errors: [String(error.message || error)] };
  if (!convs || convs.length === 0) return { sent, errors };

  const settingsByCompany = new Map<string, any>();
  for (const conv of convs as any[]) {
    try {
      const handoff = conv.bot_data?.ai_handoff || {};
      const at = String(handoff.at || "");
      if (!at) continue;

      const { data: inst } = await supabase
        .from("wapi_instances")
        .select("id, unit, company_id")
        .eq("id", conv.instance_id)
        .maybeSingle();
      if (!inst) continue;
      if (!settingsByCompany.has(inst.company_id)) {
        const { data: st } = await supabase.from("ai_agent_settings").select("*").eq("company_id", inst.company_id).maybeSingle();
        settingsByCompany.set(inst.company_id, st || null);
      }
      const settings = settingsByCompany.get(inst.company_id);
      if (!settings) continue;
      const minutes = Number(settings.handoff_alert_minutes) || DEFAULT_HANDOFF_ALERT_MINUTES;
      const hours = parseVisitHours(teamHoursText(settings.team_hours));
      // Recesso não pausa o alerta: o buffet fecha festas e visitas, mas a equipe segue atendendo

      const markAlerted = async (value: string) => {
        const { data: fresh } = await supabase.from("wapi_conversations").select("bot_data").eq("id", conv.id).maybeSingle();
        const bd = (fresh?.bot_data || {}) as Record<string, any>;
        if (!bd.ai_handoff || bd.ai_handoff.alerted_at) return false;
        await supabase.from("wapi_conversations")
          .update({ bot_data: { ...bd, ai_handoff: { ...bd.ai_handoff, alerted_at: value } } })
          .eq("id", conv.id);
        return true;
      };

      // Equipe respondeu depois da passagem? Encerra sem alerta.
      const { data: outgoing } = await supabase
        .from("wapi_messages")
        .select("from_me, timestamp, metadata")
        .eq("conversation_id", conv.id)
        .eq("from_me", true)
        .gt("timestamp", at)
        .limit(20);
      if (teamRepliedAfter((outgoing || []) as any[], at)) {
        await markAlerted(`respondido`);
        continue;
      }

      const waited = businessMinutesBetween(hours, Date.parse(at), nowMs);
      if (waited < minutes) continue;
      if (!(await markAlerted(new Date(nowMs).toISOString()))) continue;

      const { data: lastIn } = await supabase
        .from("wapi_messages")
        .select("content, message_type")
        .eq("conversation_id", conv.id)
        .eq("from_me", false)
        .order("timestamp", { ascending: false })
        .limit(1);
      const lastText = lastIn?.[0]
        ? (lastIn[0].message_type === "text" ? String(lastIn[0].content || "") : `[${lastIn[0].message_type}]`).slice(0, 160)
        : "";
      const clientPhone = String(conv.contact_phone || conv.remote_jid || "").replace(/@.*/, "");
      const name = handoff.lead_name || conv.contact_name || clientPhone;
      const unitLabel = inst.unit || "WhatsApp";
      const atLabel = new Date(at).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
      const text = `🚨 *Cliente sem resposta — ${unitLabel}*\n\n` +
        `A IA passou *${name}* (${clientPhone}) para a equipe às ${atLabel} e ninguém respondeu há ${waited} min de expediente.\n` +
        `Motivo: ${handoff.reason || "—"}` +
        (lastText ? `\nÚltima mensagem do cliente: "${lastText}"` : "") +
        `\n\n👉 Responda agora pela Central de Atendimento do Celebrei ou pelo celular do ${unitLabel}.`;

      const alertPhone = String(settings.handoff_alert_phone || "").replace(/\D/g, "");
      let whatsappSent = false;
      if (alertPhone.length >= 10) {
        whatsappSent = await sendHandoffAlertWhatsApp(supabase, inst, alertPhone.startsWith("55") ? alertPhone : `55${alertPhone}`, text);
      } else {
        console.warn(`[follow-up-check] Alerta de passagem sem WhatsApp configurado (empresa ${inst.company_id}) — só sininho`);
      }

      const targetUserIds = await resolveUnitNotificationTargets(supabase, inst.company_id, inst.unit);
      if (targetUserIds.length > 0) {
        await supabase.from("notifications").insert(targetUserIds.map((uid: string) => ({
          user_id: uid,
          company_id: inst.company_id,
          type: "lead_needs_human",
          title: `🚨 Cliente sem resposta há ${waited} min`,
          message: `${name} (${unitLabel}) foi passado pela IA às ${atLabel} e ninguém respondeu. Responda agora!`,
          data: { conversation_id: conv.id, lead_id: conv.lead_id || handoff.lead_id || null, contact_phone: clientPhone, unit: inst.unit, reason: "ai_handoff_unanswered", owner_whatsapp_sent: whatsappSent },
          read: false,
        })));
      }
      console.log(`[follow-up-check] 🚨 Passagem da IA sem resposta: conv ${conv.id} (${unitLabel}, ${waited} min) — WhatsApp: ${whatsappSent}`);
      sent++;
    } catch (e) {
      errors.push(String(e));
    }
  }
  return { sent, errors };
}

// ============= ALERTA: FESTA NOS PRÓXIMOS 60 DIAS =============
// Buffets com ai_agent_settings.party_soon_alert ligado: lead que entrou nos
// últimos 2 dias e informou uma festa próxima (regras em _shared/party-soon.ts)
// gera um aviso no sininho e entra num WhatsApp único por empresa para o
// handoff_alert_phone (mesmo remetente do alerta de passagem). Uma vez por
// lead: a marca fica no histórico do lead.
const PARTY_SOON_LOOKBACK_MS = 2 * 86400000;
const PARTY_SOON_SKIP_STATUS = ["fechado", "perdido", "trabalhe_conosco", "fornecedor", "outros"];

async function processPartySoonAlerts({
  supabase,
}: { supabase: SupabaseAdmin }): Promise<{ sent: number; errors: string[] }> {
  const errors: string[] = [];
  let sent = 0;
  const { data: companies, error } = await supabase
    .from("ai_agent_settings")
    .select("company_id, handoff_alert_phone")
    .eq("party_soon_alert", true);
  // Banco ainda sem a coluna: alerta desligado
  if (error) return { sent, errors: /party_soon_alert/.test(String(error.message)) ? [] : [String(error.message || error)] };
  if (!companies || companies.length === 0) return { sent, errors };

  const nowMs = Date.now();
  const since = new Date(nowMs - PARTY_SOON_LOOKBACK_MS).toISOString();
  const todayYmd = new Date(nowMs).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

  for (const cfg of companies as any[]) {
    try {
      const { data: leads } = await supabase
        .from("campaign_leads")
        .select("id, name, whatsapp, unit, month, day_of_month, status")
        .eq("company_id", cfg.company_id)
        .not("month", "is", null)
        .not("status", "in", `(${PARTY_SOON_SKIP_STATUS.join(",")})`)
        .or(`created_at.gte.${since},last_entry_at.gte.${since}`)
        .limit(300);
      const soon = ((leads || []) as any[])
        .map((l) => ({ ...l, when: partySoon(l.month, l.day_of_month, todayYmd) }))
        .filter((l) => l.when);
      if (soon.length === 0) continue;

      const { data: done } = await supabase
        .from("lead_history")
        .select("lead_id")
        .in("lead_id", soon.map((l) => l.id))
        .eq("action", PARTY_SOON_ACTION);
      const already = new Set(((done || []) as any[]).map((d) => d.lead_id));
      const fresh = soon.filter((l) => !already.has(l.id));
      if (fresh.length === 0) continue;

      // Marca antes de avisar: se algo falhar, não repete o alerta a cada rodada
      const { error: histErr } = await supabase.from("lead_history").insert(fresh.map((l) => ({
        lead_id: l.id,
        company_id: cfg.company_id,
        action: PARTY_SOON_ACTION,
        new_value: l.when,
        user_name: "Sistema",
      })));
      if (histErr) {
        errors.push(`histórico ${cfg.company_id}: ${histErr.message}`);
        continue;
      }

      const line = (l: any) => `• *${l.name || "Cliente"}* (${String(l.whatsapp || "").replace(/\D/g, "")}) — festa em ${partySoonLabel(l.when)}${l.unit ? ` · ${l.unit}` : ""}`;
      for (const l of fresh) {
        const targets = await resolveUnitNotificationTargets(supabase, cfg.company_id, l.unit);
        if (targets.length === 0) continue;
        await supabase.from("notifications").insert(targets.map((uid: string) => ({
          user_id: uid,
          company_id: cfg.company_id,
          type: "party_soon",
          title: `🎉 Festa em ${partySoonLabel(l.when)}: cliente com pressa`,
          message: `${l.name || "Cliente"}${l.unit ? ` (${l.unit})` : ""} quer festa nos próximos 60 dias. Dê prioridade ao atendimento!`,
          data: { lead_id: l.id, contact_phone: l.whatsapp, unit: l.unit, party: l.when, reason: "party_soon" },
          read: false,
        })));
      }

      const alertPhone = String(cfg.handoff_alert_phone || "").replace(/\D/g, "");
      let whatsappSent = false;
      if (alertPhone.length >= 10) {
        const text = `🎉 *Festa próxima — prioridade*\n\n` +
          `${fresh.length === 1 ? "Este cliente quer" : "Estes clientes querem"} festa nos próximos 60 dias:\n` +
          fresh.slice(0, 15).map(line).join("\n") +
          (fresh.length > 15 ? `\n… e mais ${fresh.length - 15} (veja no sininho)` : "") +
          `\n\n👉 Dê prioridade pela Central de Atendimento do Celebrei.`;
        whatsappSent = await sendHandoffAlertWhatsApp(supabase, { id: "", company_id: cfg.company_id }, alertPhone.startsWith("55") ? alertPhone : `55${alertPhone}`, text);
      }
      console.log(`[follow-up-check] 🎉 Festa próxima: ${fresh.length} lead(s) da empresa ${cfg.company_id} — WhatsApp: ${whatsappSent}`);
      sent += fresh.length;
    } catch (e) {
      errors.push(String(e));
    }
  }
  return { sent, errors };
}

// ============= DADOS DO CONTRATANTE: ENVIO AO FECHAR, COBRANÇAS E AVISOS =============
// Buffets com form_automation_settings (contrato) auto_on_closed / reminders_enabled:
// 1) lead que virou "Fechado" (closed_at nos últimos 2 dias) sem pedido → manda o link;
// 2) pedido sem resposta → cobranças nos prazos configurados, só no horário de
//    atendimento (Configurar IA; sem configuração, 9h–18h) e nunca depois das 20h;
//    pausa se o cliente/equipe falaram nas últimas 2 h ou se o cliente espera resposta;
// 3) cobranças acabaram (24 h depois da última) → alerta à equipe e etiqueta "atrasado";
// 4) cliente preencheu → aviso no sininho e no WhatsApp de alerta.
// Regras em _shared/client-data.ts. Desligado: nada disso roda para o buffet.
async function processClientDataRequests({
  supabase,
}: { supabase: SupabaseAdmin }): Promise<{ sent: number; errors: string[] }> {
  const errors: string[] = [];
  let sent = 0;
  const { data: configs, error } = await supabase
    .from("form_automation_settings")
    .select("company_id, message_template, auto_on_closed, reminders_enabled, reminder_hours, reminder_messages")
    .eq("form_type", "contrato")
    .or("auto_on_closed.eq.true,reminders_enabled.eq.true");
  // Banco sem as colunas novas: desligado
  if (error) return { sent, errors: /auto_on_closed|reminders_enabled|reminder_/.test(String(error.message)) ? [] : [String(error.message)] };
  if (!configs || configs.length === 0) return { sent, errors };

  const nowMs = Date.now();
  const localHour = Number(new Date(nowMs).toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false })) % 24;

  for (const cfg of configs as any[]) {
    try {
      const companyId = cfg.company_id as string;
      const [{ data: company }, { data: aiSettings }] = await Promise.all([
        supabase.from("companies").select("name, custom_domain").eq("id", companyId).maybeSingle(),
        supabase.from("ai_agent_settings").select("team_hours, handoff_alert_phone").eq("company_id", companyId).maybeSingle(),
      ]);
      const hours = parseVisitHours(teamHoursText(aiSettings?.team_hours));
      const canMessageClient = isOpenAt(hours, nowMs) && localHour < 20;
      const reminderHours = normalizeReminderHours(cfg.reminder_hours);
      const reminderTexts = DEFAULT_CLIENT_DATA_REMINDERS.map((d, i) => String((cfg.reminder_messages || [])[i] || "").trim() || d);
      while (reminderTexts.length < reminderHours.length) reminderTexts.push(reminderTexts[reminderTexts.length - 1]);

      // Conversa e número do cliente (a mais recente do lead, fora de grupos)
      const clientConversation = async (leadId: string) => {
        const { data: convs } = await supabase.from("wapi_conversations")
          .select("id, instance_id, remote_jid, contact_phone, last_message_at, last_message_from_me")
          .eq("lead_id", leadId).not("remote_jid", "like", "%@g.us%")
          .order("last_message_at", { ascending: false }).limit(1);
        const conv = (convs || [])[0];
        if (!conv) return null;
        const { data: inst } = await supabase.from("wapi_instances")
          .select("id, instance_id, instance_token, client_token, provider, company_id, unit, status, is_active")
          .eq("id", conv.instance_id).maybeSingle();
        if (!inst || inst.is_active === false || inst.status !== "connected") return null;
        return { conv, inst };
      };
      const sendToClient = async (leadId: string, text: string): Promise<boolean> => {
        const target = await clientConversation(leadId);
        if (!target) return false;
        const phone = String(target.conv.contact_phone || target.conv.remote_jid || "").replace(/@.*/, "").replace(/\D/g, "");
        if (phone.length < 10) return false;
        const slot = await claimSystemSendSlot(supabase, { id: target.inst.id, provider: target.inst.provider });
        if (!slot.ok) return false;
        const res = await providerSendText(target.inst as any, phone, text);
        if (!res.ok) {
          errors.push(`envio dados do contratante (${leadId}): ${res.error}`);
          return false;
        }
        const nowIso = new Date().toISOString();
        await supabase.from("wapi_messages").upsert({
          conversation_id: target.conv.id,
          message_id: res.messageId || `client_data_${Date.now()}`,
          from_me: true, message_type: "text", content: text, status: "sent",
          timestamp: nowIso, company_id: companyId,
          metadata: { source: "client_data" },
        }, { onConflict: "conversation_id,message_id", ignoreDuplicates: true });
        await supabase.from("wapi_conversations").update({
          last_message_at: nowIso, last_message_content: text.substring(0, 100), last_message_from_me: true,
        }).eq("id", target.conv.id);
        return true;
      };
      // Cliente já mandou os dados por texto no chat (CPF válido numa mensagem dele): sem link nem cobrança
      const sentDataInChat = async (leadId: string, sinceIso: string): Promise<boolean> => {
        const { data: convs } = await supabase.from("wapi_conversations").select("id").eq("lead_id", leadId);
        const ids = ((convs || []) as Array<{ id: string }>).map((c) => c.id);
        if (ids.length === 0) return false;
        const { data: msgs } = await supabase.from("wapi_messages").select("content")
          .in("conversation_id", ids).eq("from_me", false).gte("timestamp", sinceIso).limit(300);
        return ((msgs || []) as Array<{ content: string | null }>).some((m) => hasCpfInText(m.content));
      };
      // Sem festa ligada ao pedido: só a próxima festa do lead (a de uma cliente que voltou já passou)
      const eventDateLabel = async (eventId: string | null, leadId: string) => {
        let q = supabase.from("company_events").select("event_date");
        q = eventId ? q.eq("id", eventId) : q.eq("lead_id", leadId).neq("status", "cancelado")
          .gte("event_date", new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" })).order("event_date", { ascending: true }).limit(1);
        const { data } = await q;
        const d = (data || [])[0]?.event_date as string | undefined;
        return d ? d.split("-").reverse().join("/") : "";
      };
      const notifyTeam = async (leadId: string, unit: string | null, title: string, message: string, whatsappText: string, extra: Record<string, unknown> = {}) => {
        const targets = await resolveUnitNotificationTargets(supabase, companyId, unit);
        if (targets.length > 0) {
          await supabase.from("notifications").insert(targets.map((uid: string) => ({
            user_id: uid, company_id: companyId, type: "client_data", title, message,
            data: { lead_id: leadId, reason: "client_data", ...extra }, read: false,
          })));
        }
        const alertPhone = String(aiSettings?.handoff_alert_phone || "").replace(/\D/g, "");
        if (alertPhone.length >= 10) {
          await sendHandoffAlertWhatsApp(supabase, { id: "", company_id: companyId }, alertPhone.startsWith("55") ? alertPhone : `55${alertPhone}`, whatsappText);
        }
      };

      // 4) Cliente preencheu (últimos 3 dias) → avisa uma vez
      const { data: done } = await supabase.from("client_data_requests")
        .select("id, lead_id, client_data, completed_at")
        .eq("company_id", companyId).in("status", ["completed", "reviewed"]).is("notified_at", null)
        .gte("completed_at", new Date(nowMs - 3 * 86400000).toISOString()).limit(50);
      for (const r of (done || []) as any[]) {
        const { data: marked } = await supabase.from("client_data_requests").update({ notified_at: new Date().toISOString() })
          .eq("id", r.id).is("notified_at", null).select("id");
        if (!marked || marked.length === 0) continue;
        const { data: lead } = r.lead_id ? await supabase.from("campaign_leads").select("name, unit").eq("id", r.lead_id).maybeSingle() : { data: null };
        const name = String(r.client_data?.nome || lead?.name || "Cliente");
        // Conversa do cliente: o aviso grande da Central abre direto nela
        const { data: convs } = r.lead_id
          ? await supabase.from("wapi_conversations").select("id, contact_phone, remote_jid")
            .eq("lead_id", r.lead_id).not("remote_jid", "like", "%@g.us%")
            .order("last_message_at", { ascending: false }).limit(1)
          : { data: [] };
        const conv = ((convs || []) as any[])[0];
        await notifyTeam(r.lead_id, lead?.unit || null, `✅ ${name} preencheu os dados do contrato`, "Os dados já estão na festa e no contrato. Abra a conversa para conferir.",
          `✅ *Dados do contrato recebidos*\n\n${name} preencheu o cadastro (CPF, endereço e aniversariante). Já estão na festa e no contrato. 🎉`,
          conv ? { reason: "client_data_done", conversation_id: conv.id, contact_phone: String(conv.contact_phone || conv.remote_jid || "").replace(/@.*/, "") } : {});
        // Agradece ao cliente pelo mesmo número (logo depois de preencher; resposta ao que ele acabou de fazer)
        if (r.lead_id && r.completed_at && nowMs - Date.parse(r.completed_at) <= 6 * 3600000) {
          if (await sendToClient(r.lead_id, clientDataThanks(name))) sent++;
        }
      }

      if (!canMessageClient) continue;

      // 1) Virou "Fechado" sem pedido → manda o link
      if (cfg.auto_on_closed === true) {
        const { data: closed } = await supabase.from("campaign_leads")
          .select("id, name, unit")
          .eq("company_id", companyId).eq("status", "fechado")
          .gte("closed_at", new Date(nowMs - 2 * 86400000).toISOString()).limit(50);
        const todayBr = new Date(nowMs).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
        for (const lead of (closed || []) as any[]) {
          // Cliente que voltou: pedidos e contratos de festas que já aconteceram não contam
          const { data: existing } = await supabase.from("client_data_requests").select("id, event:company_events(event_date)").eq("lead_id", lead.id);
          if ((existing || []).some((r: any) => !r.event?.event_date || r.event.event_date >= todayBr)) continue;
          // Fechado automático (contrato assinado): os dados do contratante já estão na plataforma
          const { data: contracts } = await supabase.from("generated_contracts").select("id, event:company_events(event_date)").eq("lead_id", lead.id).neq("status", "cancelado");
          if ((contracts || []).some((c: any) => !c.event?.event_date || c.event.event_date >= todayBr)) continue;
          if (await sentDataInChat(lead.id, new Date(nowMs - 14 * 86400000).toISOString())) {
            console.log(`[follow-up-check] 📋 Lead ${lead.id} já mandou os dados pelo chat — sem link automático`);
            continue;
          }
          // Só a próxima festa: sem ela, o pedido entra sozinho na festa nova quando for criada
          const { data: events } = await supabase.from("company_events").select("id").eq("company_id", companyId).eq("lead_id", lead.id)
            .neq("status", "cancelado").gte("event_date", todayBr).order("event_date", { ascending: true }).limit(1);
          const token = shortClientToken();
          const { data: created, error: insErr } = await supabase.from("client_data_requests").insert({
            company_id: companyId, lead_id: lead.id, event_id: events?.[0]?.id || null, token,
            status: "sent", sent_at: new Date().toISOString(), sent_via: "fechado",
          }).select("id, event_id").single();
          if (insErr || !created) { errors.push(`pedido ${lead.id}: ${insErr?.message}`); continue; }
          const text = fillClientDataTemplate(String(cfg.message_template || "").trim() || DEFAULT_CLIENT_DATA_MESSAGE, {
            nome: lead.name, empresa: company?.name, data_evento: await eventDateLabel(created.event_id, lead.id), link: clientDataLink(token, company?.custom_domain),
          });
          if (await sendToClient(lead.id, text)) {
            sent++;
            console.log(`[follow-up-check] 📋 Link dos dados do contrato enviado ao fechar (lead ${lead.id})`);
          } else {
            // Sem conversa/número conectado: desfaz para tentar de novo (ou a equipe manda pelo botão)
            await supabase.from("client_data_requests").delete().eq("id", created.id).eq("status", "sent");
          }
        }
      }

      // 2) e 3) Cobranças e atraso
      if (cfg.reminders_enabled === true) {
        const { data: pending } = await supabase.from("client_data_requests")
          .select("id, lead_id, event_id, token, sent_at, reminder_count, last_reminder_at, overdue_alerted_at")
          .eq("company_id", companyId).in("status", ["pending", "sent"]).lt("reminder_count", 99)
          .gte("sent_at", new Date(nowMs - 20 * 86400000).toISOString()).not("lead_id", "is", null).limit(100);
        for (const r of (pending || []) as any[]) {
          const { data: lead } = await supabase.from("campaign_leads").select("name, unit, status").eq("id", r.lead_id).maybeSingle();
          if (!lead || lead.status === "perdido") continue;
          if (isOverdue(r, reminderHours, nowMs)) {
            if (!r.overdue_alerted_at) {
              const { data: marked } = await supabase.from("client_data_requests").update({ overdue_alerted_at: new Date().toISOString() })
                .eq("id", r.id).is("overdue_alerted_at", null).select("id");
              if (marked && marked.length > 0) {
                const days = Math.max(1, Math.floor((nowMs - Date.parse(r.sent_at)) / 86400000));
                await notifyTeam(r.lead_id, lead.unit, `⚠️ ${lead.name} não preencheu os dados do contrato`, `Faz ${days} dia(s) e ${r.reminder_count} cobrança(s). Vale ligar para o cliente.`,
                  `⚠️ *Dados do contrato atrasados*\n\n${lead.name} não preencheu o cadastro há ${days} dia(s), mesmo com ${r.reminder_count} cobrança(s).\n\n👉 Vale ligar para o cliente.`);
              }
            }
            continue;
          }
          const idx = dueReminder(r, reminderHours, nowMs);
          if (idx === null) continue;
          if (await sentDataInChat(r.lead_id, new Date(Date.parse(r.sent_at) - 14 * 86400000).toISOString())) {
            // Mandou os dados por texto: para as cobranças (sem alerta de atraso)
            await supabase.from("client_data_requests").update({ reminder_count: 99 }).eq("id", r.id);
            console.log(`[follow-up-check] 📋 Lead ${r.lead_id} mandou os dados pelo chat — cobranças encerradas`);
            continue;
          }
          // Conversa ativa ou cliente esperando resposta: a cobrança espera
          const target = await clientConversation(r.lead_id);
          if (!target) continue;
          const lastMs = Date.parse(String(target.conv.last_message_at || ""));
          if (Number.isFinite(lastMs) && nowMs - lastMs < 2 * 3600000) continue;
          if (target.conv.last_message_from_me === false) continue;
          const text = fillClientDataTemplate(reminderTexts[idx], {
            nome: lead.name, empresa: company?.name, data_evento: await eventDateLabel(r.event_id, r.lead_id), link: clientDataLink(r.token, company?.custom_domain),
          });
          // Marca antes de enviar: nunca duas cobranças iguais
          const { data: marked } = await supabase.from("client_data_requests")
            .update({ reminder_count: idx + 1, last_reminder_at: new Date().toISOString() })
            .eq("id", r.id).eq("reminder_count", idx).select("id");
          if (!marked || marked.length === 0) continue;
          if (await sendToClient(r.lead_id, text)) {
            sent++;
            console.log(`[follow-up-check] 📋 Cobrança ${idx + 1} dos dados do contrato (lead ${r.lead_id})`);
          } else {
            await supabase.from("client_data_requests").update({ reminder_count: idx, last_reminder_at: r.last_reminder_at }).eq("id", r.id);
          }
        }
      }
    } catch (e) {
      errors.push(String(e));
    }
  }
  return { sent, errors };
}

// Remetente do alerta: número da PRÓPRIA empresa, conectado; prefere um
// diferente do que atende a conversa (para não misturar com o atendimento)
// e Z-API primeiro. Grava a mensagem antes do eco para o webhook não achar
// que alguém digitou no celular.
// 2 horários livres de visita, em texto ("quinta (23/10) às 15h"), pelos
// horários de visita da IA, tirando os já marcados e o recesso
async function visitOffers(supabase: SupabaseAdmin, companyId: string, ai: Record<string, any>, nowMs: number, todayYmd: string): Promise<string[]> {
  return pickTwoOffers(await freeVisitSlots(supabase, companyId, ai, nowMs, todayYmd)).map((sl) => friendlyVisitSlot(sl, todayYmd));
}

// "Vou agendar depois" (Automações → Visitas, Castelo 22/10):
// 1) cliente escreveu quando quer retomar ("início de novembro", "semana que
//    vem"): a IA lê a frase e devolve a data; fica no lead ("Retomar em …");
// 2) no dia, a partir das 10h e no horário da equipe (nunca depois das 20h),
//    sai a mensagem com 2 horários de visita (quem já visitou: "seguir com a
//    festa"). Cancela se o lead fechou/perdeu, marcou visita ou voltou a
//    conversar depois de combinar. Conversa com a equipe: a resposta do
//    cliente vira aviso grande na Central.
async function processScheduledReturns({ supabase }: { supabase: SupabaseAdmin }): Promise<{ found: number; sent: number; errors: string[] }> {
  const errors: string[] = [];
  let found = 0;
  let sent = 0;
  const { data: cfgs, error } = await supabase.from("visit_confirmation_settings").select("company_id").eq("scheduled_return_enabled", true);
  if (error) return { found, sent, errors: /scheduled_return/.test(String(error.message)) ? [] : [String(error.message)] };
  if (!cfgs || cfgs.length === 0) return { found, sent, errors };

  const nowMs = Date.now();
  const todayYmd = new Date(nowMs - 3 * 3600000).toISOString().slice(0, 10);
  const localHour = Number(new Date(nowMs).toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false })) % 24;
  const weekday = new Date(nowMs).toLocaleDateString("pt-BR", { weekday: "long", timeZone: "America/Sao_Paulo" });
  const openaiKey = Deno.env.get("OPENAI_API_KEY") || null;
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY") || null;
  const isBlocked = await loadBlockedContacts(supabase);

  for (const cfg of cfgs as Array<{ company_id: string }>) {
    const companyId = cfg.company_id;
    try {
      const [{ data: company }, { data: ai }] = await Promise.all([
        supabase.from("companies").select("name").eq("id", companyId).maybeSingle(),
        supabase.from("ai_agent_settings").select("model, team_hours, closed_periods, visit_hours").eq("company_id", companyId).maybeSingle(),
      ]);

      // 1) Mensagens novas do cliente que falam em retomar numa data
      const { data: msgs } = await supabase.from("wapi_messages")
        .select("id, conversation_id, content, timestamp, metadata")
        .eq("company_id", companyId).eq("from_me", false).eq("message_type", "text")
        .gte("timestamp", new Date(nowMs - 20 * 60000).toISOString()).limit(300);
      for (const m of (msgs || []) as any[]) {
        if ((m.metadata as Record<string, unknown> | null)?.return_checked || !mentionsLaterTime(m.content)) continue;
        await supabase.from("wapi_messages").update({ metadata: { ...((m.metadata as Record<string, unknown>) || {}), return_checked: true } }).eq("id", m.id);
        const { data: conv } = await supabase.from("wapi_conversations").select("id, lead_id, remote_jid").eq("id", m.conversation_id).maybeSingle();
        if (!conv?.lead_id || String(conv.remote_jid || "").includes("@g.us")) continue;
        const { data: lead } = await supabase.from("campaign_leads").select("id, status").eq("id", conv.lead_id).maybeSingle();
        if (!lead || ["fechado", "perdido"].includes(lead.status)) continue;
        const { data: ctx } = await supabase.from("wapi_messages").select("from_me, content").eq("conversation_id", conv.id)
          .lte("timestamp", m.timestamp).order("timestamp", { ascending: false }).limit(6);
        const context = ((ctx || []) as Array<{ from_me: boolean; content: string | null }>).reverse()
          .map((c) => `${c.from_me ? "Buffet" : "Cliente"}: ${String(c.content || "").slice(0, 300)}`).join("\n");
        const model = ai?.model || DEFAULT_AI_MODEL;
        const session = createLlmSession({ model, system: returnPrompt(todayYmd, weekday), history: [{ role: "user", content: `Conversa (a última mensagem é a que importa):\n${context}` }], tools: [], openaiKey, anthropicKey });
        if (!session) continue;
        const step = await session.step();
        await supabase.from("ai_agent_usage").insert({
          company_id: companyId, conversation_id: conv.id, lead_id: lead.id,
          provider: providerForModel(step.servedModel || model), model: step.servedModel || model, kind: "chat",
          input_tokens: step.usage.inputTokens, cached_input_tokens: step.usage.cachedInputTokens, cache_write_tokens: step.usage.cacheWriteTokens,
          output_tokens: step.usage.outputTokens, cost_usd: estimateChatCostUsd(step.servedModel || model, step.usage), is_test: false,
        });
        const plan = parseReturnJson(step.text, todayYmd);
        if (!plan) continue;
        await supabase.from("campaign_leads").update({
          return_at: plan.date, return_when_text: plan.whenText || null, return_note: plan.note || String(m.content || "").slice(0, 140),
          return_status: "pending", return_set_at: new Date().toISOString(), return_sent_at: null,
        }).eq("id", lead.id);
        await supabase.from("lead_history").insert({
          lead_id: lead.id, company_id: companyId, user_name: "IA",
          action: "Retorno combinado", new_value: `${plan.date.split("-").reverse().join("/")} · disse: ${plan.note || String(m.content || "").slice(0, 100)}`,
        });
        found++;
      }

      // 2) Respostas a retornos já enviados (conversa com a equipe → aviso grande)
      const { data: sentLeads } = await supabase.from("campaign_leads").select("id, name, unit, return_sent_at")
        .eq("company_id", companyId).eq("return_status", "sent").gte("return_sent_at", new Date(nowMs - 7 * 86400000).toISOString()).limit(200);
      for (const l of (sentLeads || []) as any[]) {
        const { data: convs } = await supabase.from("wapi_conversations").select("id, contact_phone, remote_jid, bot_step")
          .eq("lead_id", l.id).not("remote_jid", "like", "%@g.us%").order("last_message_at", { ascending: false }).limit(1);
        const conv = ((convs || []) as any[])[0];
        if (!conv) continue;
        const { data: reply } = await supabase.from("wapi_messages").select("content").eq("conversation_id", conv.id).eq("from_me", false)
          .gt("timestamp", l.return_sent_at).order("timestamp", { ascending: true }).limit(1);
        const first = ((reply || []) as Array<{ content: string | null }>)[0];
        if (!first) continue;
        const { data: marked } = await supabase.from("campaign_leads").update({ return_status: "replied" }).eq("id", l.id).eq("return_status", "sent").select("id");
        if (!marked || marked.length === 0 || conv.bot_step === "ai_agent") continue; // com a IA: ela mesma responde
        const targets = await resolveUnitNotificationTargets(supabase, companyId, l.unit || null);
        if (targets.length > 0) {
          await supabase.from("notifications").insert(targets.map((uid: string) => ({
            user_id: uid, company_id: companyId, type: "lead_needs_human",
            title: `💬 ${firstNameOf(l.name) || "Cliente"} respondeu o retorno combinado`,
            message: String(first.content || "").slice(0, 120) || "Abra a conversa para responder.",
            data: { reason: "scheduled_return_reply", conversation_id: conv.id, contact_phone: String(conv.contact_phone || conv.remote_jid || "").replace(/@.*/, ""), lead_id: l.id },
            read: false,
          })));
        }
      }

      // 3) Retornos do dia
      const canSend = isOpenAt(parseVisitHours(teamHoursText(ai?.team_hours)), nowMs) && localHour < 20 && localHour >= RETURN_HOUR;
      if (!canSend) continue;
      const { data: due } = await supabase.from("campaign_leads")
        .select("id, name, status, unit, return_at, return_when_text, return_status, return_set_at")
        .eq("company_id", companyId).eq("return_status", "pending").lte("return_at", todayYmd).limit(100);
      for (const l of (due || []) as any[]) {
        if (!returnDue(l.return_at, l.return_status, todayYmd, localHour)) continue;
        const cancel = async (why: string) => {
          await supabase.from("campaign_leads").update({ return_status: "cancelled" }).eq("id", l.id);
          console.log(`[follow-up-check] Retorno do lead ${l.id} cancelado: ${why}`);
        };
        if (["fechado", "perdido"].includes(l.status)) { await cancel("lead fechado/perdido"); continue; }
        const { data: visitAhead } = await supabase.from("lead_visits").select("id").eq("lead_id", l.id).gte("data_visita", todayYmd)
          .in("status_visita", ["agendada", "confirmada", "remarcada"]).limit(1);
        if ((visitAhead || []).length > 0) { await cancel("visita marcada"); continue; }
        const { data: convs } = await supabase.from("wapi_conversations")
          .select("id, instance_id, remote_jid, contact_phone, contact_name, bot_step, bot_data")
          .eq("lead_id", l.id).not("remote_jid", "like", "%@g.us%").order("last_message_at", { ascending: false }).limit(1);
        const conv = ((convs || []) as any[])[0];
        if (!conv) continue;
        if (isBlocked(companyId, conv.remote_jid)) { await cancel("contato bloqueado"); continue; }
        const setMs = l.return_set_at ? Date.parse(l.return_set_at) : 0;
        const { data: later } = await supabase.from("wapi_messages").select("id").eq("conversation_id", conv.id).eq("from_me", false)
          .gt("timestamp", new Date(setMs + RETURN_STALE_REPLY_MS).toISOString()).limit(1);
        if ((later || []).length > 0) { await cancel("cliente voltou a conversar"); continue; }
        // Uma mensagem automática por dia / janela do pós-visita: espera
        if ((await pacingHeldLeads(supabase, companyId, [l.id])).has(l.id)) continue;

        const { data: inst } = await supabase.from("wapi_instances")
          .select("id, instance_id, instance_token, client_token, provider, company_id, unit, status, is_active")
          .eq("id", conv.instance_id).maybeSingle();
        if (!inst || inst.is_active === false || inst.status !== "connected") continue;
        const phone = String(conv.contact_phone || conv.remote_jid || "").replace(/@.*/, "").replace(/\D/g, "");
        if (phone.length < 10) continue;
        const { data: pastVisit } = await supabase.from("lead_visits").select("id").eq("lead_id", l.id).eq("status_visita", "realizada").limit(1);
        const visited = (pastVisit || []).length > 0;
        const offers = !visited && ai ? await visitOffers(supabase, companyId, ai, nowMs, todayYmd) : [];
        const text = returnMessage({
          firstName: firstNameOf(l.name || conv.contact_name),
          companyName: String(company?.name || "buffet"),
          whenText: l.return_when_text,
          offers,
          visited,
          childName: firstNameOf((conv.bot_data as Record<string, any> | null)?.aniversariante) || null,
        });

        const { data: claimed } = await supabase.from("campaign_leads").update({ return_status: "sending" }).eq("id", l.id).eq("return_status", "pending").select("id");
        if (!claimed || claimed.length === 0) continue;
        const slot = await claimSystemSendSlot(supabase, { id: inst.id, provider: inst.provider });
        if (!slot.ok) { await supabase.from("campaign_leads").update({ return_status: "pending" }).eq("id", l.id); continue; }
        const res = await providerSendText(inst as any, phone, text);
        if (!res.ok) {
          await supabase.from("campaign_leads").update({ return_status: "pending" }).eq("id", l.id);
          errors.push(`retorno (${l.id}): ${res.error}`);
          continue;
        }
        const nowIso = new Date().toISOString();
        await supabase.from("wapi_messages").upsert({
          conversation_id: conv.id, message_id: res.messageId || `scheduled_return_${Date.now()}`,
          from_me: true, message_type: "text", content: text, status: "sent", timestamp: nowIso, company_id: companyId,
          metadata: { source: "scheduled_return" },
        }, { onConflict: "conversation_id,message_id", ignoreDuplicates: true });
        await supabase.from("wapi_conversations").update({ last_message_at: nowIso, last_message_content: text.substring(0, 100), last_message_from_me: true }).eq("id", conv.id);
        await supabase.from("campaign_leads").update({ return_status: "sent", return_sent_at: nowIso }).eq("id", l.id);
        await supabase.from("lead_history").insert({ lead_id: l.id, company_id: companyId, user_name: "Sistema", action: "Retorno combinado enviado", new_value: text.slice(0, 200) });
        sent++;
      }
    } catch (err) {
      errors.push(`empresa ${companyId}: ${String(err)}`);
    }
  }
  return { found, sent, errors };
}

// Pós-visita (Automações → Visitas, Castelo 22/10): no dia seguinte à visita,
// a partir das 10h e no horário da equipe (nunca depois das 20h):
// - visitou (Realizada) e não fechou → mensagem; sem resposta, outra 3 dias depois;
// - não compareceu → convite para remarcar com 2 horários livres.
// Não sai se a equipe ou o cliente conversaram depois da visita, se a festa já
// foi criada ou o lead está Fechado/Perdido. A resposta do cliente vai para a
// equipe (aviso grande na Central); a IA não assume a negociação.
async function processPostVisit({ supabase }: { supabase: SupabaseAdmin }): Promise<{ sent: number; errors: string[] }> {
  const errors: string[] = [];
  let sent = 0;
  const { data: cfgs, error } = await supabase.from("visit_confirmation_settings").select("company_id").eq("post_visit_enabled", true);
  if (error) return { sent, errors: /post_visit/.test(String(error.message)) ? [] : [String(error.message)] };
  if (!cfgs || cfgs.length === 0) return { sent, errors };

  const nowMs = Date.now();
  const todayYmd = new Date(nowMs - 3 * 3600000).toISOString().slice(0, 10);
  const localHour = Number(new Date(nowMs).toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false })) % 24;
  const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const isBlocked = await loadBlockedContacts(supabase);

  for (const cfg of cfgs as Array<{ company_id: string }>) {
    const companyId = cfg.company_id;
    try {
      const [{ data: company }, { data: ai }] = await Promise.all([
        supabase.from("companies").select("name").eq("id", companyId).maybeSingle(),
        supabase.from("ai_agent_settings").select("team_hours, extra_instructions, party_slots, closed_periods, visit_hours").eq("company_id", companyId).maybeSingle(),
      ]);
      const canSend = isOpenAt(parseVisitHours(teamHoursText(ai?.team_hours)), nowMs) && localHour < 20;

      const { data: visits } = await supabase.from("lead_visits")
        .select("id, lead_id, data_visita, horario_visita, status_visita, post_visit_count, post_visit_last_at, post_visit_replied_at")
        .eq("company_id", companyId).in("status_visita", ["realizada", "nao_compareceu"])
        .gte("data_visita", addDays(todayYmd, -10)).lt("data_visita", todayYmd)
        .order("data_visita", { ascending: false }).limit(300);
      // Só a visita mais recente de cada lead (e nenhuma visita marcada depois dela)
      const latest = new Map<string, any>();
      for (const v of (visits || []) as any[]) if (!latest.has(v.lead_id)) latest.set(v.lead_id, v);
      if (latest.size === 0) continue;
      const leadIds = [...latest.keys()];
      const { data: newer } = await supabase.from("lead_visits").select("lead_id, data_visita").in("lead_id", leadIds).gte("data_visita", todayYmd)
        .in("status_visita", ["agendada", "confirmada", "remarcada"]);
      const rebooked = new Set(((newer || []) as Array<{ lead_id: string }>).map((v) => v.lead_id));

      for (const v of latest.values()) {
        const count = Number(v.post_visit_count || 0);
        const lastAtMs = v.post_visit_last_at ? Date.parse(v.post_visit_last_at) : null;
        const { data: convs } = await supabase.from("wapi_conversations")
          .select("id, instance_id, remote_jid, contact_phone, contact_name, bot_step, bot_data")
          .eq("lead_id", v.lead_id).not("remote_jid", "like", "%@g.us%")
          .order("last_message_at", { ascending: false }).limit(1);
        const conv = ((convs || []) as any[])[0];
        if (!conv) continue;

        // Cliente respondeu ao pós-visita → avisa a equipe (uma vez) e encerra
        if (count >= 1 && count < 99 && lastAtMs && !v.post_visit_replied_at) {
          const { data: reply } = await supabase.from("wapi_messages").select("content")
            .eq("conversation_id", conv.id).eq("from_me", false).gt("timestamp", new Date(lastAtMs).toISOString())
            .order("timestamp", { ascending: true }).limit(1);
          const first = ((reply || []) as Array<{ content: string | null }>)[0];
          if (first) {
            const { data: marked } = await supabase.from("lead_visits").update({ post_visit_replied_at: new Date().toISOString(), post_visit_count: 99 })
              .eq("id", v.id).is("post_visit_replied_at", null).select("id");
            if (marked && marked.length > 0) {
              const { data: lead } = await supabase.from("campaign_leads").select("name, unit").eq("id", v.lead_id).maybeSingle();
              const name = firstNameOf(lead?.name || conv.contact_name) || "Cliente";
              const targets = await resolveUnitNotificationTargets(supabase, companyId, lead?.unit || null);
              if (targets.length > 0) {
                await supabase.from("notifications").insert(targets.map((uid: string) => ({
                  user_id: uid, company_id: companyId, type: "lead_needs_human",
                  title: `💬 ${name} respondeu a mensagem pós-visita`,
                  message: String(first.content || "").slice(0, 120) || "Abra a conversa para responder.",
                  data: { reason: "post_visit_reply", conversation_id: conv.id, contact_phone: String(conv.contact_phone || conv.remote_jid || "").replace(/@.*/, ""), lead_id: v.lead_id },
                  read: false,
                })));
              }
            }
          }
          continue;
        }

        if (!canSend || rebooked.has(v.lead_id)) continue;
        const step = postVisitDue({ status: v.status_visita, visitYmd: v.data_visita, count, lastAtMs }, todayYmd, localHour, nowMs);
        if (!step) continue;
        if (isBlocked(companyId, conv.remote_jid)) continue;

        const stop = async () => { await supabase.from("lead_visits").update({ post_visit_count: 99 }).eq("id", v.id); };
        const { data: lead } = await supabase.from("campaign_leads").select("name, status, month, day_of_month").eq("id", v.lead_id).maybeSingle();
        if (!lead || ["fechado", "perdido"].includes(lead.status)) { await stop(); continue; }
        const { data: events } = await supabase.from("company_events").select("id").eq("lead_id", v.lead_id).neq("status", "cancelado").limit(1);
        if ((events || []).length > 0) { await stop(); continue; }

        // Equipe ou cliente conversaram depois da visita (ou da 1ª mensagem): a equipe já está cuidando
        const refMs = step === "second" ? (lastAtMs as number) : visitStartMs(v.data_visita, v.horario_visita) + 3600000;
        const { data: since } = await supabase.from("wapi_messages").select("conversation_id, from_me, metadata")
          .eq("conversation_id", conv.id).gt("timestamp", new Date(refMs).toISOString()).limit(500);
        if (activeConversations((since || []) as any[]).has(conv.id)) { await stop(); continue; }

        // Uma mensagem automática por dia: espera (tenta de novo na próxima rodada)
        if ((await pacingHeldLeads(supabase, companyId, [v.lead_id], { forPostVisit: true })).has(v.lead_id)) continue;

        const { data: inst } = await supabase.from("wapi_instances")
          .select("id, instance_id, instance_token, client_token, provider, company_id, unit, status, is_active")
          .eq("id", conv.instance_id).maybeSingle();
        if (!inst || inst.is_active === false || inst.status !== "connected") continue;
        const phone = String(conv.contact_phone || conv.remote_jid || "").replace(/@.*/, "").replace(/\D/g, "");
        if (phone.length < 10) continue;

        // Dados para a mensagem: aniversariante, data da festa (livre agora?), promoção, horários de visita
        const bd = (conv.bot_data || {}) as Record<string, any>;
        const partyYmd = (typeof bd.data_festa === "string" && bd.data_festa > todayYmd ? bd.data_festa : null)
          || partyYmdFromLead(lead.month, lead.day_of_month, todayYmd);
        let partyFree: boolean | null = null;
        if (step === "first" && partyYmd && ai) {
          partyFree = (await freeSlotsBetween(supabase, ai, companyId, partyYmd, partyYmd)).length > 0;
        }
        const offers = step === "no_show" && ai ? await visitOffers(supabase, companyId, ai, nowMs, todayYmd) : [];
        const promoFound = findPromotion(ai?.extra_instructions, todayYmd);
        // Festa fora do ano da promoção: a mensagem pós-visita não cita
        const promo = promoFound && promoFitsParty(promoFound, partyYmd ? Number(partyYmd.slice(0, 4)) : null) ? promoFound : null;
        const text = postVisitMessage(step, {
          firstName: firstNameOf(lead.name || conv.contact_name),
          companyName: String(company?.name || "buffet"),
          childName: firstNameOf(bd.aniversariante) || null,
          visitYmd: v.data_visita,
          todayYmd,
          partyYmd,
          partyFree,
          promo: promo ? { title: promo.title, endYmd: promo.endYmd } : null,
          offers,
        });

        // Reserva a vez (duas rodadas juntas não mandam duas vezes)
        const { data: claimed } = await supabase.from("lead_visits").update({ post_visit_count: count + 1, post_visit_last_at: new Date().toISOString() })
          .eq("id", v.id).eq("post_visit_count", count).select("id");
        if (!claimed || claimed.length === 0) continue;
        const slot = await claimSystemSendSlot(supabase, { id: inst.id, provider: inst.provider });
        if (!slot.ok) {
          await supabase.from("lead_visits").update({ post_visit_count: count, post_visit_last_at: v.post_visit_last_at }).eq("id", v.id);
          continue;
        }
        const res = await providerSendText(inst as any, phone, text);
        if (!res.ok) {
          await supabase.from("lead_visits").update({ post_visit_count: count, post_visit_last_at: v.post_visit_last_at }).eq("id", v.id);
          errors.push(`pós-visita (${v.lead_id}): ${res.error}`);
          continue;
        }
        const nowIso = new Date().toISOString();
        await supabase.from("wapi_messages").upsert({
          conversation_id: conv.id, message_id: res.messageId || `post_visit_${Date.now()}`,
          from_me: true, message_type: "text", content: text, status: "sent", timestamp: nowIso, company_id: companyId,
          metadata: { source: "post_visit", step },
        }, { onConflict: "conversation_id,message_id", ignoreDuplicates: true });
        // Depois da visita quem conduz é a equipe: conversa da IA passa para a equipe
        const convPatch: Record<string, unknown> = { last_message_at: nowIso, last_message_content: text.substring(0, 100), last_message_from_me: true };
        if (conv.bot_step === "ai_agent") convPatch.bot_step = "human_takeover";
        await supabase.from("wapi_conversations").update(convPatch).eq("id", conv.id);
        await supabase.from("lead_history").insert({
          lead_id: v.lead_id, company_id: companyId, user_name: "Sistema",
          action: step === "no_show" ? "Pós-visita: convite para remarcar" : `Pós-visita: mensagem ${step === "first" ? "1" : "2"}`,
          new_value: text.slice(0, 200),
        });
        sent++;
      }
    } catch (err) {
      errors.push(`empresa ${companyId}: ${String(err)}`);
    }
  }
  return { sent, errors };
}

// Oferta da Vamu 3D (parceira de lembrancinhas, Castelo 31/10): UMA mensagem
// por festa de aniversário, com o link já preenchido, quando a festa entra na
// janela de 40 a 4 dias antes. Ligada em companies.settings.vamu3d_offer:
// "test" manda uma amostra só para vamu3d_offer_test_phone; "on" manda para as
// famílias (até 6 por dia, uma por rodada, das festas mais próximas). Só no
// horário da equipe, no mesmo número da conversa, no ritmo seguro de envio.
async function processVamuOffers({ supabase }: { supabase: SupabaseAdmin }): Promise<{ sent: number; errors: string[] }> {
  const errors: string[] = [];
  let sent = 0;
  const { data: companies, error } = await supabase.from("companies").select("id, name, settings").eq("settings->>vamu3d", "true");
  if (error || !companies || companies.length === 0) return { sent, errors: error ? [String(error.message)] : [] };

  const nowMs = Date.now();
  const todayYmd = new Date(nowMs - 3 * 3600000).toISOString().slice(0, 10);
  const localHour = Number(new Date(nowMs).toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false })) % 24;
  const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const isBlocked = await loadBlockedContacts(supabase);

  for (const company of companies as Array<{ id: string; name: string | null; settings: Record<string, any> | null }>) {
    const companyId = company.id;
    const settings = company.settings || {};
    const mode = String(settings.vamu3d_offer || "off");
    if (mode !== "test" && mode !== "on") continue;
    if (mode === "test" && settings.vamu3d_offer_test_sent_at) continue;
    try {
      const { data: ai } = await supabase.from("ai_agent_settings").select("team_hours").eq("company_id", companyId).maybeSingle();
      // Teste (só para o dono): qualquer hora entre 9h e 20h; famílias: só no horário da equipe
      if (localHour < 9 || localHour >= 20) continue;
      if (mode === "on" && !isOpenAt(parseVisitHours(teamHoursText(ai?.team_hours)), nowMs)) continue;

      // Já mandadas (uma por festa) e o limite do dia
      const { data: offered } = await supabase.from("lead_history").select("new_value, created_at")
        .eq("company_id", companyId).eq("action", VAMU_OFFER_ACTION).gte("created_at", new Date(nowMs - 90 * 86400000).toISOString()).limit(2000);
      const offeredEvents = new Set(((offered || []) as any[]).map((h) => vamuOfferEventId(h.new_value)).filter(Boolean));
      const sentToday = ((offered || []) as any[]).filter((h) => new Date(Date.parse(h.created_at) - 3 * 3600000).toISOString().slice(0, 10) === todayYmd).length;
      if (mode === "on" && sentToday >= VAMU_OFFER_DAILY_CAP) continue;

      const { data: events } = await supabase.from("company_events")
        .select("id, lead_id, title, child_name, child_age, event_date, status")
        .eq("company_id", companyId).not("lead_id", "is", null).neq("status", "cancelado")
        .gte("event_date", addDays(todayYmd, VAMU_OFFER_MIN_DAYS)).lte("event_date", addDays(todayYmd, VAMU_OFFER_MAX_DAYS))
        .order("event_date", { ascending: true }).limit(200);
      const pending = ((events || []) as any[]).filter((e) => !offeredEvents.has(e.id) && isBirthdayParty(e.title, e.child_name));
      if (pending.length === 0) continue;
      // Quem já pediu na Vamu não recebe a oferta
      const { data: ordered } = await supabase.from("lead_history").select("lead_id")
        .eq("action", "Pedido Vamu 3D").in("lead_id", [...new Set(pending.map((e) => e.lead_id))]);
      const orderedLeads = new Set(((ordered || []) as any[]).map((o) => o.lead_id));

      for (const ev of pending) {
        if (orderedLeads.has(ev.lead_id)) continue;
        const { data: convs } = await supabase.from("wapi_conversations")
          .select("id, instance_id, remote_jid, contact_phone, contact_name")
          .eq("lead_id", ev.lead_id).not("remote_jid", "like", "%@g.us%").order("last_message_at", { ascending: false }).limit(1);
        const conv = ((convs || []) as any[])[0];
        if (!conv) continue;
        const { data: inst } = await supabase.from("wapi_instances")
          .select("id, instance_id, instance_token, client_token, provider, company_id, unit, status, is_active")
          .eq("id", conv.instance_id).maybeSingle();
        if (!inst || inst.company_id !== companyId || inst.is_active === false || inst.status !== "connected") continue;
        const familyPhone = String(conv.contact_phone || conv.remote_jid || "").replace(/@.*/, "").replace(/\D/g, "");
        const testPhone = String(settings.vamu3d_offer_test_phone || "").replace(/\D/g, "");
        const phone = mode === "test" ? testPhone : familyPhone;
        if (phone.length < 10) {
          if (mode === "test") errors.push("oferta Vamu: vamu3d_offer_test_phone não configurado");
          if (mode === "test") break;
          continue;
        }
        if (isBlocked(companyId, mode === "test" ? phone : conv.remote_jid)) continue;
        if (mode === "on" && (await pacingHeldLeads(supabase, companyId, [ev.lead_id])).has(ev.lead_id)) continue;

        const { data: lead } = await supabase.from("campaign_leads").select("name").eq("id", ev.lead_id).maybeSingle();
        const childName = cleanFirstName(ev.child_name || ev.title);
        const link = vamuPartyLink({ id: ev.id, child_name: childName, child_age: partyAge(ev.child_age, ev.child_name), event_date: ev.event_date }, "oferta");
        const text = vamuOfferMessage({
          parentName: cleanFirstName(lead?.name || conv.contact_name), childName, companyName: String(company.name || "buffet"), link,
        });

        const tag = vamuOfferTag(ev.id);
        let claimId: string | null = null;
        if (mode === "on") {
          // Reserva a festa antes de enviar (duas rodadas juntas não mandam duas vezes)
          const { data: claim } = await supabase.from("lead_history").insert({
            lead_id: ev.lead_id, company_id: companyId, user_name: "Sistema", action: VAMU_OFFER_ACTION, new_value: `${text.slice(0, 160)} ${tag}`,
          }).select("id").maybeSingle();
          claimId = claim?.id || null;
          const { data: dup } = await supabase.from("lead_history").select("id").eq("lead_id", ev.lead_id).eq("action", VAMU_OFFER_ACTION).ilike("new_value", `%${tag}%`);
          if (!claimId || (dup || []).length > 1) {
            if (claimId) await supabase.from("lead_history").delete().eq("id", claimId);
            continue;
          }
        }
        const release = async () => { if (claimId) await supabase.from("lead_history").delete().eq("id", claimId); };

        const slot = await claimSystemSendSlot(supabase, { id: inst.id, provider: inst.provider });
        if (!slot.ok) { await release(); break; }
        const body = mode === "test" ? `🧪 Teste da oferta da Vamu (só para você). Assim chega para os pais:\n\n${text}` : text;
        const res = await providerSendText(inst as any, phone, body);
        if (!res.ok) {
          await release();
          errors.push(`oferta Vamu (festa ${ev.id}): ${res.error}`);
          break;
        }
        if (mode === "test") {
          await supabase.from("companies").update({ settings: { ...settings, vamu3d_offer_test_sent_at: new Date().toISOString() } }).eq("id", companyId);
          console.log(`[follow-up-check] Oferta Vamu: teste enviado (festa ${ev.id})`);
        } else {
          const nowIso = new Date().toISOString();
          await supabase.from("wapi_messages").upsert({
            conversation_id: conv.id, message_id: res.messageId || `vamu_offer_${Date.now()}`,
            from_me: true, message_type: "text", content: text, status: "sent", timestamp: nowIso, company_id: companyId,
            metadata: { source: "vamu_offer", event_id: ev.id },
          }, { onConflict: "conversation_id,message_id", ignoreDuplicates: true });
          await supabase.from("wapi_conversations").update({ last_message_at: nowIso, last_message_content: text.substring(0, 100), last_message_from_me: true }).eq("id", conv.id);
          console.log(`[follow-up-check] Oferta Vamu enviada (festa ${ev.id}, ${ev.event_date})`);
        }
        sent++;
        break; // uma por rodada (a cada 5 min): espaça os envios
      }
    } catch (err) {
      errors.push(`oferta Vamu (empresa ${companyId}): ${String(err)}`);
    }
  }
  return { sent, errors };
}

// Formulários automáticos (Mensagens automáticas → Formulários, Castelo 27/10), por buffet:
// - pré-festa: X dias antes da festa;
// - cardápio: X min depois que o buffet gera o contrato da festa, com o cardápio
//   do pacote (sem cardápio que case com o pacote não manda: avisa a equipe);
// - avaliação: X horas depois que a festa termina.
// Só no horário da equipe (nunca depois das 20h), uma vez por festa, e nunca se
// o cliente já respondeu ou o link já foi mandado na conversa. Regras em _shared/form-auto.ts.
async function processFormAutoSends({ supabase }: { supabase: SupabaseAdmin }): Promise<{ sent: number; errors: string[] }> {
  const errors: string[] = [];
  let sent = 0;
  const { data: cfgs, error } = await supabase.from("form_automation_settings")
    .select("company_id, form_type, message_template, auto_delay_minutes, auto_enabled_at")
    .eq("auto_send", true).eq("is_enabled", true).in("form_type", ["prefesta", "cardapio", "avaliacao"]);
  // Colunas novas ainda não criadas no banco: nada a fazer
  if (error) return { sent, errors: /auto_send|auto_delay|auto_enabled/.test(String(error.message)) ? [] : [String(error.message)] };
  if (!cfgs || cfgs.length === 0) return { sent, errors };

  const nowMs = Date.now();
  const todayYmd = new Date(nowMs - 3 * 3600000).toISOString().slice(0, 10);
  const localHour = Number(new Date(nowMs).toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false })) % 24;
  const isBlocked = await loadBlockedContacts(supabase);
  const byCompany = new Map<string, any[]>();
  for (const c of cfgs as any[]) byCompany.set(c.company_id, [...(byCompany.get(c.company_id) || []), c]);

  for (const [companyId, list] of byCompany) {
    try {
      const [{ data: company }, { data: ai }] = await Promise.all([
        supabase.from("companies").select("name, slug, custom_domain").eq("id", companyId).maybeSingle(),
        supabase.from("ai_agent_settings").select("team_hours").eq("company_id", companyId).maybeSingle(),
      ]);
      if (!(isOpenAt(parseVisitHours(teamHoursText(ai?.team_hours)), nowMs) && localHour < 20)) continue;

      for (const cfg of list) {
        const type = cfg.form_type as AutoFormType;
        const delay = Number.isFinite(Number(cfg.auto_delay_minutes)) && cfg.auto_delay_minutes !== null ? Number(cfg.auto_delay_minutes) : FORM_AUTO_DEFAULT_DELAY_MIN[type];
        const enabledAtMs = cfg.auto_enabled_at ? Date.parse(cfg.auto_enabled_at) : null;
        const sinceIso = new Date(nowMs - delay * 60000 - FORM_AUTO_MAX_LATE_MS[type]).toISOString();

        // Festas candidatas e o momento de referência (contrato gerado / fim da festa / início da festa)
        const refByEvent = new Map<string, number>();
        if (type === "prefesta") {
          const { data: events } = await supabase.from("company_events").select("id, event_date, start_time")
            .eq("company_id", companyId).eq("status", "confirmado")
            .gte("event_date", todayYmd).lte("event_date", new Date(nowMs - 3 * 3600000 + (delay / 1440 + 1) * 86400000).toISOString().slice(0, 10)).limit(300);
          for (const e of (events || []) as any[]) refByEvent.set(e.id, partyStartMs(e.event_date, e.start_time));
        } else if (type === "cardapio") {
          const { data: contracts } = await supabase.from("generated_contracts").select("event_id, created_at, status")
            .eq("company_id", companyId).not("event_id", "is", null).neq("status", "cancelado").gte("created_at", sinceIso)
            .order("created_at", { ascending: true }).limit(200);
          for (const c of (contracts || []) as any[]) if (!refByEvent.has(c.event_id)) refByEvent.set(c.event_id, Date.parse(c.created_at));
        } else {
          const { data: events } = await supabase.from("company_events").select("id, event_date, start_time, end_time")
            .eq("company_id", companyId).eq("status", "confirmado")
            .gte("event_date", new Date(nowMs - 3 * 3600000 - 6 * 86400000).toISOString().slice(0, 10)).lte("event_date", todayYmd).limit(300);
          for (const e of (events || []) as any[]) refByEvent.set(e.id, partyEndMs(e.event_date, e.start_time, e.end_time));
        }
        const dueIds = [...refByEvent].filter(([, ref]) => type === "prefesta" ? prefestaDue(ref, delay, enabledAtMs, nowMs) : formAutoDue(type, ref, delay, enabledAtMs, nowMs)).map(([id]) => id);
        if (dueIds.length === 0) continue;

        const { data: templates } = await supabase.from(type === "cardapio" ? "cardapio_templates" : type === "prefesta" ? "prefesta_templates" : "evaluation_templates")
          .select("id, name, slug").eq("company_id", companyId).eq("is_active", true).order("created_at", { ascending: true });
        const tpls = (templates || []) as FormTemplateRow[];

        for (const eventId of dueIds) {
          const { data: ev } = await supabase.from("company_events")
            .select("id, lead_id, event_date, status, package_name, title").eq("id", eventId).maybeSingle();
          if (!ev || ev.status === "cancelado" || !ev.lead_id) continue;
          if (type === "cardapio" && String(ev.event_date) < todayYmd) continue; // a festa já passou

          // Já foi (automático ou pela Agenda) ou já respondeu: não manda de novo
          const { data: prior } = await supabase.from("lead_history").select("id").eq("lead_id", ev.lead_id)
            .in("action", [FORM_SENT_ACTION, "form_auto_skipped"]).like("new_value", `%"event_id":"${eventId}"%`).like("new_value", `%"form_type":"${type}"%`).limit(1);
          if ((prior || []).length > 0) continue;
          const { data: answered } = await supabase.from(type === "cardapio" ? "cardapio_responses" : type === "prefesta" ? "prefesta_responses" : "evaluation_responses").select("id").eq("event_id", eventId).limit(1);
          if ((answered || []).length > 0) continue;

          const { data: lead } = await supabase.from("campaign_leads").select("name, unit").eq("id", ev.lead_id).maybeSingle();
          const template = type === "cardapio" ? pickCardapioTemplate(tpls, ev.package_name, company?.name) : (tpls[0] || null);
          if (!template) {
            // Sem cardápio para o pacote: avisa a equipe uma vez e não manda nada
            await supabase.from("lead_history").insert({
              lead_id: ev.lead_id, company_id: companyId, user_name: "Sistema", action: "form_auto_skipped",
              new_value: formSentRecord({ form_type: type, template_id: "", event_id: eventId }),
            });
            if (type === "cardapio") {
              const targets = await resolveUnitNotificationTargets(supabase, companyId, lead?.unit || null);
              if (targets.length > 0) {
                await supabase.from("notifications").insert(targets.map((uid: string) => ({
                  user_id: uid, company_id: companyId, type: "lead_needs_human",
                  title: `🍽️ Cardápio não enviado: ${firstNameOf(lead?.name) || ev.title || "festa"}`,
                  message: ev.package_name ? `O pacote "${ev.package_name}" não tem um cardápio que combine. Mande pela Agenda.` : "A festa está sem pacote. Escolha o pacote e mande o cardápio pela Agenda.",
                  data: { reason: "form_auto_skipped", lead_id: ev.lead_id, event_id: eventId },
                  read: false,
                })));
              }
            }
            continue;
          }

          const { data: convs } = await supabase.from("wapi_conversations")
            .select("id, instance_id, remote_jid, contact_phone").eq("lead_id", ev.lead_id).not("remote_jid", "like", "%@g.us%")
            .order("last_message_at", { ascending: false }).limit(1);
          const conv = ((convs || []) as any[])[0];
          if (!conv || isBlocked(companyId, conv.remote_jid)) continue;
          // Link desse formulário já mandado na conversa (envio manual de antes deste registro)
          const { data: linkSent } = await supabase.from("wapi_messages").select("id").eq("conversation_id", conv.id).eq("from_me", true)
            .like("content", `%/${formAutoPath(type)}/%`).gte("timestamp", new Date(nowMs - 120 * 86400000).toISOString()).limit(1);
          if ((linkSent || []).length > 0) continue;

          const { data: inst } = await supabase.from("wapi_instances")
            .select("id, instance_id, instance_token, client_token, provider, company_id, unit, status, is_active").eq("id", conv.instance_id).maybeSingle();
          if (!inst || inst.is_active === false || inst.status !== "connected") continue;
          const phone = String(conv.contact_phone || conv.remote_jid || "").replace(/@.*/, "").replace(/\D/g, "");
          if (phone.length < 10) continue;

          // Reserva a vez: se duas rodadas chegarem juntas, só a primeira manda
          const record = formSentRecord({ form_type: type, template_id: template.id, event_id: eventId, template_name: template.name, auto: true });
          const { data: mine } = await supabase.from("lead_history").insert({
            lead_id: ev.lead_id, company_id: companyId, user_name: "Sistema", action: FORM_SENT_ACTION, new_value: record,
          }).select("id, created_at").single();
          if (!mine) continue;
          const { data: first } = await supabase.from("lead_history").select("id").eq("lead_id", ev.lead_id).eq("action", FORM_SENT_ACTION)
            .like("new_value", `%"event_id":"${eventId}"%`).like("new_value", `%"form_type":"${type}"%`).order("created_at", { ascending: true }).limit(1);
          const undo = async () => { await supabase.from("lead_history").delete().eq("id", mine.id); };
          if (((first || []) as any[])[0]?.id !== mine.id) { await undo(); continue; }
          const slot = await claimSystemSendSlot(supabase, { id: inst.id, provider: inst.provider });
          if (!slot.ok) { await undo(); continue; }

          const link = formAutoLink(type, { customDomain: company?.custom_domain, companySlug: company?.slug, templateId: template.id, templateSlug: template.slug, eventId });
          const [y, m, d] = String(ev.event_date).slice(0, 10).split("-");
          const text = fillClientDataTemplate(String(cfg.message_template || "").trim() || FORM_AUTO_DEFAULT_MESSAGES[type], {
            nome: firstNameOf(lead?.name) || null, empresa: company?.name || "", data_evento: `${d}/${m}/${y}`, link,
          });
          const res = await providerSendText(inst as any, phone, text);
          if (!res.ok) {
            await undo();
            errors.push(`${type} (${eventId}): ${res.error}`);
            continue;
          }
          const nowIso = new Date().toISOString();
          await supabase.from("wapi_messages").upsert({
            conversation_id: conv.id, message_id: res.messageId || `form_auto_${Date.now()}`,
            from_me: true, message_type: "text", content: text, status: "sent", timestamp: nowIso, company_id: companyId,
            metadata: { source: "form_auto", form_type: type, event_id: eventId },
          }, { onConflict: "conversation_id,message_id", ignoreDuplicates: true });
          await supabase.from("wapi_conversations").update({ last_message_at: nowIso, last_message_content: text.substring(0, 100), last_message_from_me: true }).eq("id", conv.id);
          sent++;
        }
      }
    } catch (err) {
      errors.push(`empresa ${companyId}: ${String(err)}`);
    }
  }
  return { sent, errors };
}

async function sendHandoffAlertWhatsApp(
  supabase: SupabaseAdmin,
  inst: { id: string; company_id: string },
  phone: string,
  text: string,
): Promise<boolean> {
  try {
    const { data: candidates } = await supabase
      .from("wapi_instances")
      .select("id, instance_id, instance_token, client_token, provider, company_id, unit")
      .eq("company_id", inst.company_id)
      .eq("is_active", true)
      .eq("status", "connected");
    const sender = ((candidates || []) as any[]).sort((a, b) =>
      ((a.id === inst.id ? 1 : 0) - (b.id === inst.id ? 1 : 0)) ||
      ((a.provider === "zapi" ? 0 : 1) - (b.provider === "zapi" ? 0 : 1))
    )[0];
    if (!sender) {
      console.warn(`[follow-up-check] Nenhum número conectado da empresa ${inst.company_id} para mandar o alerta de passagem`);
      return false;
    }
    const res = await providerSendText(sender, phone, text);
    if (!res.ok) {
      console.error("[follow-up-check] Falha no alerta de passagem pelo WhatsApp:", res.error);
      return false;
    }
    if (res.messageId) {
      const variants = [phone, phone.length === 13 ? phone.slice(0, 4) + phone.slice(5) : phone].map((p) => `${p}@s.whatsapp.net`);
      const { data: c } = await supabase
        .from("wapi_conversations")
        .select("id")
        .eq("instance_id", sender.id)
        .in("remote_jid", variants)
        .limit(1);
      if (c && c[0]) {
        await supabase.from("wapi_messages").upsert({
          conversation_id: c[0].id,
          message_id: res.messageId,
          from_me: true,
          message_type: "text",
          content: text,
          status: "sent",
          timestamp: new Date().toISOString(),
          company_id: sender.company_id,
          metadata: { source: "system_alert" },
        }, { onConflict: "conversation_id,message_id", ignoreDuplicates: true });
      }
    }
    return true;
  } catch (e) {
    console.error("[follow-up-check] Erro no alerta de passagem:", e);
    return false;
  }
}

async function processUnansweredBotConversations({
  supabase,
}: { supabase: SupabaseAdmin }): Promise<{ successCount: number; errors: string[] }> {
  const errors: string[] = [];
  let successCount = 0;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - UNANSWERED_MINUTES * 60 * 1000).toISOString();
  const oldest = new Date(nowMs - UNANSWERED_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();

  const { data: convs, error } = await supabase
    .from("wapi_conversations")
    .select("id, instance_id, lead_id, contact_name, contact_phone, remote_jid, bot_step, last_message_at")
    .eq("bot_enabled", true)
    .in("bot_step", BOT_STEPS_WAITING_ANSWER)
    .eq("last_message_from_me", false)
    .lte("last_message_at", cutoff)
    .gte("last_message_at", oldest)
    .not("remote_jid", "like", "%@g.us%")
    .or(`bot_paused_until.is.null,bot_paused_until.lt.${nowIso}`)
    .limit(100);

  if (error) {
    console.error("[follow-up-check] Erro ao buscar conversas sem resposta do robô:", error);
    return { successCount: 0, errors: [String(error)] };
  }
  if (!convs || convs.length === 0) return { successCount: 0, errors: [] };

  const instanceIds = Array.from(new Set(convs.map((c: any) => c.instance_id).filter(Boolean)));
  const { data: instances } = await supabase
    .from("wapi_instances")
    .select("id, unit, company_id, is_active")
    .in("id", instanceIds);
  const instById = new Map((instances || []).map((i: any) => [i.id, i]));
  const { data: settingsRows } = await supabase
    .from("wapi_bot_settings")
    .select("instance_id, bot_enabled, test_mode_enabled, test_mode_number")
    .in("instance_id", instanceIds);
  const settingsByInstance = new Map((settingsRows || []).map((s: any) => [s.instance_id, s]));

  for (const conv of convs as any[]) {
    try {
      const inst = instById.get(conv.instance_id) as any;
      if (!inst || inst.is_active === false) continue;
      const s = settingsByInstance.get(conv.instance_id) as any;
      const isTestNumber = !!s?.test_mode_enabled && !!s?.test_mode_number && !shouldSkipTestMode(true, s.test_mode_number, conv.remote_jid || "");
      if (!botShouldHaveAnswered(s, isTestNumber)) continue;

      // Pausa atômica: só a primeira execução que pegar essa mensagem avisa a equipe
      const pausedUntil = new Date(nowMs + 24 * 3600 * 1000).toISOString();
      const { data: claimed } = await supabase
        .from("wapi_conversations")
        .update({ bot_paused_until: pausedUntil, bot_paused_reason: "unanswered_handover", bot_paused_at: nowIso })
        .eq("id", conv.id)
        .eq("last_message_from_me", false)
        .eq("last_message_at", conv.last_message_at)
        .or(`bot_paused_until.is.null,bot_paused_until.lt.${nowIso}`)
        .select("id");
      if (!claimed || claimed.length === 0) continue;

      const name = conv.contact_name || conv.contact_phone || "Cliente";
      const unitLabel = inst.unit || "WhatsApp";
      const targetUserIds = await resolveUnitNotificationTargets(supabase, inst.company_id, inst.unit);
      if (targetUserIds.length > 0) {
        const { error: notifErr } = await supabase.from("notifications").insert(
          targetUserIds.map((uid: string) => ({
            user_id: uid,
            company_id: inst.company_id,
            type: "lead_needs_human",
            title: "🤝 Cliente ficou sem resposta do robô",
            message: `${name} respondeu no ${unitLabel} e o robô não continuou a conversa. O robô foi pausado nela — assuma o atendimento.`,
            data: { conversation_id: conv.id, lead_id: conv.lead_id, contact_phone: conv.contact_phone, unit: inst.unit, reason: "bot_unanswered", bot_step: conv.bot_step },
            read: false,
          })),
        );
        if (notifErr) errors.push(String(notifErr));
      }
      console.log(`[follow-up-check] 🤝 Cliente sem resposta do robô: conv ${conv.id} (${unitLabel}, step ${conv.bot_step}) — pausado e equipe avisada`);
      successCount++;
    } catch (e) {
      console.error(`[follow-up-check] Erro na conversa sem resposta ${conv.id}:`, e);
      errors.push(String(e));
    }
  }

  return { successCount, errors };
}


// ============= AVISO NO WHATSAPP DO DONO QUANDO UM NÚMERO FICA MUDO =============
//
// A notificação no sininho passou horas sem ninguém ver (VENDAS 1, 02/10). Quando
// um número para de mandar avisos à plataforma, o dono recebe uma mensagem no
// WhatsApp, enviada por outro número do próprio Castelo (nunca de buffet cliente).

const OWNER_ALERT_PHONE = "5515981121710";
const OWNER_ALERT_COOLDOWN_HOURS = 3;
const CASTELO_COMPANY_ID = "a0000000-0000-0000-0000-000000000001";

// Instrução segura para todo alerta de número: conferir antes de mexer.
// Nunca "desconectar o aparelho" (destrói uma sessão que pode estar funcionando)
const SAFE_CHECK_HINT = "Verifique no Hub se o número está Online e mande uma mensagem de teste. Só reconecte pelo QR se o Hub mostrar Desconectado.";

type OwnerAlertKind = "silent" | "disconnected" | "degraded" | "not_delivering" | "media_not_delivering";

/**
 * Número que parou de entregar: as mensagens saem da plataforma ("enviado"),
 * mas o WhatsApp não confirma a entrega para nenhum cliente. Avisa a equipe
 * (pop-up e sininho) e o dono no WhatsApp, por outro número. Uma vez a cada 3h
 * por número, só das 8h às 22h (de madrugada cliente não lê e daria alarme falso).
 */
// Regras e motivo em _shared/lost-first-message.ts
async function processLostAutoMessages({
  supabase,
}: { supabase: SupabaseAdmin }): Promise<{ successCount: number; errors: string[] }> {
  const errors: string[] = [];
  let successCount = 0;
  const nowMs = Date.now();
  const { data: rows, error } = await supabase
    .from("wapi_messages")
    .select("id, conversation_id, content, message_type, status, timestamp, metadata, company_id")
    .eq("from_me", true)
    .eq("status", "sent")
    .eq("message_type", "text")
    .in("metadata->>source", LOST_RESEND_SOURCES)
    .lte("timestamp", new Date(nowMs - LOST_RESEND_AFTER_MS).toISOString())
    .gte("timestamp", new Date(nowMs - LOST_RESEND_MAX_AGE_MS).toISOString())
    .order("timestamp", { ascending: true })
    .limit(100);
  if (error) return { successCount: 0, errors: [String(error.message || error)] };
  const candidates = ((rows || []) as any[]).filter((r) => {
    const meta = (r.metadata || {}) as Record<string, unknown>;
    return !meta.lost_resend && !meta.retry_of && String(r.content || "").trim();
  });
  if (candidates.length === 0) return { successCount: 0, errors: [] };

  const convIds = Array.from(new Set(candidates.map((r) => r.conversation_id)));
  const { data: convs } = await supabase
    .from("wapi_conversations")
    .select("id, remote_jid, contact_name, instance_id, company_id")
    .in("id", convIds);
  const convById = new Map((convs || []).map((c: any) => [c.id, c]));
  const instIds = Array.from(new Set((convs || []).map((c: any) => c.instance_id).filter(Boolean)));
  const { data: insts } = instIds.length
    ? await supabase.from("wapi_instances").select("id, instance_token, unit, provider, company_id").in("id", instIds).eq("provider", "evolution")
    : { data: [] as any[] };
  const instById = new Map((insts || []).map((i: any) => [i.id, i]));
  if (instById.size === 0) return { successCount: 0, errors: [] };

  const sinceIso = candidates[0].timestamp;
  // Conversa andou: qualquer mensagem (dos dois lados) depois da candidata
  const { data: laterRows } = await supabase
    .from("wapi_messages")
    .select("id, conversation_id, timestamp")
    .in("conversation_id", convIds)
    .gt("timestamp", sinceIso)
    .limit(2000);
  // Número entregando: alguma mensagem nossa entregue/lida depois da candidata
  const companyIds = Array.from(new Set((insts || []).map((i: any) => i.company_id)));
  const { data: deliveredRows } = await supabase
    .from("wapi_messages")
    .select("conversation_id, timestamp")
    .in("company_id", companyIds)
    .eq("from_me", true)
    .in("status", ["delivered", "read"])
    .gt("timestamp", sinceIso)
    .order("timestamp", { ascending: false })
    .limit(1000);
  const deliveredConvIds = Array.from(new Set(((deliveredRows || []) as any[]).map((r) => r.conversation_id)));
  const { data: deliveredConvs } = deliveredConvIds.length
    ? await supabase.from("wapi_conversations").select("id, instance_id").in("id", deliveredConvIds)
    : { data: [] as any[] };
  const instOfConv = new Map<string, string>((deliveredConvs || []).map((c: any) => [c.id, c.instance_id]));
  const lastDeliveredByInst = new Map<string, number>();
  for (const r of (deliveredRows || []) as any[]) {
    const instId = instOfConv.get(r.conversation_id);
    if (!instId) continue;
    lastDeliveredByInst.set(instId, Math.max(lastDeliveredByInst.get(instId) || 0, Date.parse(r.timestamp)));
  }

  for (const row of candidates) {
    try {
      const conv = convById.get(row.conversation_id) as any;
      const inst = conv ? instById.get(conv.instance_id) as any : null;
      if (!conv || !inst) continue;
      const ts = Date.parse(row.timestamp);
      const conversationMovedOn = ((laterRows || []) as any[]).some((m) => m.conversation_id === conv.id && m.id !== row.id && Date.parse(m.timestamp) > ts);
      const instanceDeliveredSince = (lastDeliveredByInst.get(inst.id) || 0) > ts;
      if (!shouldResendLost(row, { conversationMovedOn, instanceDeliveredSince }, nowMs)) continue;

      const phone = String(conv.remote_jid || "").replace("@s.whatsapp.net", "").replace("@c.us", "").replace(/\D/g, "");
      if (!phone || String(conv.remote_jid || "").endsWith("@g.us")) continue;
      if (isBlockedContact(inst.company_id, phone)) continue;
      if (await isConversationPaused(supabase, conv.id)) continue;
      const slot = await claimSystemSendSlot(supabase, inst);
      if (!slot.ok) {
        console.log(`[lost-resend] ${inst.unit}: ritmo do sistema (${slot.reason}) — fica para a próxima rodada`);
        continue;
      }

      const meta = (row.metadata || {}) as Record<string, unknown>;
      const res = await evolutionSendText(inst.instance_token, phone, row.content);
      const newId = res.ok ? extractEvolutionMessageId(res.data) : null;
      const sentAt = new Date().toISOString();
      // Marca a original de qualquer jeito: uma tentativa só
      await supabase.from("wapi_messages").update({
        metadata: { ...meta, lost_resend: { at: sentAt, ok: res.ok, message_id: newId, error: res.ok ? null : String(res.error || "").slice(0, 200) } },
      }).eq("id", row.id);
      if (!res.ok) {
        errors.push(`reenvio falhou (conv ${conv.id}): ${String(res.error || "").slice(0, 200)}`);
        continue;
      }
      await supabase.from("wapi_messages").insert({
        conversation_id: conv.id,
        content: row.content,
        from_me: true,
        message_type: "text",
        message_id: newId,
        status: "sent",
        timestamp: sentAt,
        metadata: { ...meta, retry_of: row.id, lost_resend: undefined },
        company_id: row.company_id || inst.company_id,
      });
      successCount++;
      console.warn(`[lost-resend] 🔁 ${inst.unit}: ${meta.source} para ${conv.contact_name || phone} ficou só "enviada" desde ${row.timestamp} — reenviada (${newId})`);
    } catch (err) {
      errors.push(String((err as Error)?.message || err));
    }
  }
  return { successCount, errors };
}

async function processDeliveryStallAlerts(supabase: SupabaseAdmin): Promise<void> {
  const nowMs = Date.now();
  const hourBR = new Date(nowMs - 3 * 3600000).getUTCHours();
  if (hourBR < 8 || hourBR >= 22) return;
  const sinceIso = new Date(nowMs - STALL_LOOKBACK_MS).toISOString();

  const { data: instances } = await supabase
    .from("wapi_instances")
    .select("id, instance_id, company_id, unit, status")
    .eq("is_active", true)
    .in("status", ["connected", "degraded"]);

  for (const inst of (instances || []) as Array<{ id: string; instance_id: string; company_id: string; unit: string | null }>) {
    const { data: convs } = await supabase
      .from("wapi_conversations")
      .select("id")
      .eq("instance_id", inst.id)
      .gte("last_message_at", sinceIso)
      .limit(300);
    const convIds = (convs || []).map((c: { id: string }) => c.id);
    if (convIds.length < 2) continue;
    const { data: rows } = await supabase
      .from("wapi_messages")
      .select("status, timestamp, conversation_id, message_type, metadata")
      .in("conversation_id", convIds)
      .eq("from_me", true)
      .gte("timestamp", sinceIso)
      .limit(2000);
    const decision = decideDeliveryStall((rows || []) as OutgoingRow[], nowMs);
    if (!decision.stalled) continue;

    const cooldown = new Date(nowMs - 3 * 3600000).toISOString();
    const { data: recent } = await supabase
      .from("notifications")
      .select("id")
      .eq("type", "delivery_stall")
      .eq("data->>instance_id", inst.id)
      .gte("created_at", cooldown)
      .limit(1);
    if (recent && recent.length > 0) continue;

    const unitName = inst.unit || "WhatsApp";
    const sinceLabel = new Date(decision.since as string).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
    const mediaOnly = decision.kind === "media";
    console.warn(`[delivery-stall] ${unitName} (${inst.company_id}) sem entregar ${mediaOnly ? "mídia" : "nada"} desde ${sinceLabel}: ${decision.stuck} mensagens paradas em ${decision.conversations} conversas`);

    const ownerWhatsAppSent = await sendOwnerSilentInstanceAlert(
      supabase, inst, inst.id, decision.since, mediaOnly ? "media_not_delivering" : "not_delivering",
    );
    let targets = await resolveUnitNotificationTargets(supabase, inst.company_id, inst.unit);
    if (targets.length === 0) {
      const { data: companyUsers } = await supabase.from("user_companies").select("user_id").eq("company_id", inst.company_id);
      targets = (companyUsers || []).map((u: { user_id: string }) => u.user_id);
    }
    if (targets.length === 0) continue;
    await supabase.from("notifications").insert(targets.map((uid) => ({
      user_id: uid,
      company_id: inst.company_id,
      type: "delivery_stall",
      title: mediaOnly ? `⚠️ ${unitName}: fotos e PDFs não estão chegando` : `🚨 ${unitName} não está entregando mensagens`,
      message: mediaOnly
        ? `Desde ${sinceLabel}, fotos, vídeos e PDFs enviados por este número não chegam aos clientes (${decision.stuck} parados). ${SAFE_CHECK_HINT}`
        : `Desde ${sinceLabel}, nenhuma mensagem enviada por este número chegou aos clientes (${decision.stuck} paradas em ${decision.conversations} conversas). ${SAFE_CHECK_HINT}`,
      data: {
        instance_id: inst.id,
        unit: unitName,
        reason: "delivery_stall",
        kind: decision.kind,
        since: decision.since,
        stuck: decision.stuck,
        owner_whatsapp_sent: ownerWhatsAppSent,
      },
    })));
  }
}

async function sendOwnerSilentInstanceAlert(
  supabase: SupabaseAdmin,
  inst: { id: string; unit: string | null; company_id: string },
  instId: string,
  lastWebhookEventAt: string | null,
  kind: OwnerAlertKind = "silent",
): Promise<boolean> {
  try {
    const since = new Date(Date.now() - OWNER_ALERT_COOLDOWN_HOURS * 3600 * 1000).toISOString();
    const { data: recent } = await supabase
      .from("notifications")
      .select("id")
      .in("type", ["message_stuck", "instance_disconnected", "instance_degraded", "delivery_stall"])
      .eq("data->>instance_id", instId)
      .eq("data->>owner_whatsapp_sent", "true")
      .gte("created_at", since)
      .limit(1);
    if (recent && recent.length > 0) return false;

    // Remetente: SEMPRE um número do próprio Castelo (nunca de um buffet cliente),
    // conectado e diferente do número com problema. Z-API primeiro (não tem caído).
    const { data: senders } = await supabase
      .from("wapi_instances")
      .select("id, instance_id, instance_token, client_token, provider, company_id, unit")
      .eq("company_id", CASTELO_COMPANY_ID)
      .eq("is_active", true)
      .eq("status", "connected")
      .neq("id", instId);
    const sender = (senders || []).sort((a: any, b: any) =>
      (a.provider === "zapi" ? 0 : 1) - (b.provider === "zapi" ? 0 : 1)
    )[0] as any;
    if (!sender) {
      console.warn("[follow-up-check] Nenhum número do Castelo conectado para avisar o dono no WhatsApp");
      return false;
    }

    const { data: company } = await supabase.from("companies").select("name").eq("id", inst.company_id).maybeSingle();
    const sinceLabel = lastWebhookEventAt
      ? new Date(lastWebhookEventAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
      : "algumas horas";
    const who = `${company?.name || "Buffet"} · *${inst.unit || "WhatsApp"}*`;
    // Nunca mandar desconectar o aparelho: isso destrói uma sessão que pode estar funcionando
    const reconnect = `👉 ${SAFE_CHECK_HINT}`;
    const text = kind === "not_delivering"
      ? `🚨 *Celebrei — número não está entregando*\n\n${who}: desde ${sinceLabel} nenhuma mensagem enviada pela plataforma chegou aos clientes. O número aparece conectado, mas as mensagens ficam só como "enviadas".\n\n${reconnect}`
      : kind === "media_not_delivering"
      ? `⚠️ *Celebrei — fotos e PDFs não estão chegando*\n\n${who}: desde ${sinceLabel} fotos, vídeos e PDFs enviados pela plataforma não chegam aos clientes (os textos ainda chegam).\n\n${reconnect}`
      : kind === "disconnected"
      ? `🔴 *Celebrei — número desconectado*\n\n${who} está desconectado do WhatsApp. Nada entra nem sai pela plataforma.\n\n${reconnect}`
      : kind === "degraded"
        ? `⚠️ *Celebrei — sessão incompleta*\n\n${who} está com a sessão do WhatsApp incompleta: as mensagens podem não ser entregues.\n\n${reconnect}`
        : `⚠️ *Celebrei — atenção: número sem avisos do WhatsApp*\n\n${who} não manda nenhum aviso para a plataforma desde ${sinceLabel}. Pode ser só falta de mensagens, mas vale conferir.\n\n${reconnect}`;

    const sent = await providerSendText(sender, OWNER_ALERT_PHONE, text);
    if (!sent.ok) {
      console.error("[follow-up-check] Falha ao avisar o dono no WhatsApp:", sent.error);
      return false;
    }

    // Grava a mensagem na conversa (se existir) antes do eco do webhook: sem isso
    // o webhook acha que foi digitada no celular e desliga o robô dessa conversa.
    if (sent.messageId) {
      const variants = [OWNER_ALERT_PHONE, OWNER_ALERT_PHONE.slice(0, 4) + OWNER_ALERT_PHONE.slice(5)]
        .map((p) => `${p}@s.whatsapp.net`);
      const { data: conv } = await supabase
        .from("wapi_conversations")
        .select("id")
        .eq("instance_id", sender.id)
        .in("remote_jid", variants)
        .limit(1);
      if (conv && conv[0]) {
        await supabase.from("wapi_messages").upsert({
          conversation_id: conv[0].id,
          message_id: sent.messageId,
          from_me: true,
          message_type: "text",
          content: text,
          status: "sent",
          timestamp: new Date().toISOString(),
          company_id: sender.company_id,
          metadata: { source: "system_alert" },
        }, { onConflict: "conversation_id,message_id", ignoreDuplicates: true });
      }
    }
    console.log(`[follow-up-check] 📲 Dono avisado no WhatsApp: ${inst.unit} (${kind}, via ${sender.unit})`);
    return true;
  } catch (e) {
    console.error("[follow-up-check] Erro ao avisar o dono no WhatsApp:", e);
    return false;
  }
}


// Número desconectado: avisa a equipe da empresa (sininho) e o dono no WhatsApp.
// No máximo uma vez a cada 6h por número.
async function notifyInstanceDisconnected(
  supabase: SupabaseAdmin,
  inst: { id: string; instance_id: string; unit: string | null; company_id: string },
): Promise<void> {
  try {
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data: recent } = await supabase
      .from("notifications")
      .select("id")
      .eq("type", "instance_disconnected")
      .eq("data->>instance_id", inst.id)
      .gte("created_at", sixHoursAgo)
      .limit(1);
    if (recent && recent.length > 0) return;

    const unitName = inst.unit || inst.instance_id || "WhatsApp";
    const ownerWhatsAppSent = await sendOwnerSilentInstanceAlert(supabase, inst, inst.id, null, "disconnected");
    const { data: companyUsers } = await supabase
      .from("user_companies")
      .select("user_id")
      .eq("company_id", inst.company_id);
    if (companyUsers && companyUsers.length > 0) {
      await supabase.from("notifications").insert(companyUsers.map((u: { user_id: string }) => ({
        user_id: u.user_id,
        company_id: inst.company_id,
        type: "instance_disconnected",
        title: "⚠️ WhatsApp desconectado",
        message: `WhatsApp da unidade ${unitName} perdeu conexão. Reconecte via QR Code em Configurações.`,
        data: { instance_id: inst.id, instance_name: unitName, owner_whatsapp_sent: ownerWhatsAppSent },
      })));
    }
    console.log(`[health-check] Disconnect notification sent for ${inst.instance_id} (dono avisado: ${ownerWhatsAppSent})`);
  } catch (e) {
    console.error(`[health-check] Erro ao avisar desconexão de ${inst.instance_id}:`, e);
  }
}

// ============= STALE REMINDED ALERTS (notify when lead stuck at proximo_passo_reminded for 2h+) =============

async function processStaleRemindedAlerts({
  supabase,
}: { supabase: SupabaseAdmin }): Promise<void> {
  const STALE_HOURS = 2;
  const cutoff = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000).toISOString();

  // Find conversations stuck at proximo_passo_reminded for 2h+ with no reply
  const { data: staleConvs, error } = await supabase
    .from("wapi_conversations")
    .select("id, company_id, lead_id, contact_name, contact_phone, last_message_at, instance_id, remote_jid")
    .eq("bot_step", "proximo_passo_reminded")
    .eq("last_message_from_me", true)
    .is("bot_data->>campaign_pending_reply", null) // a última mensagem foi a campanha
    .not("remote_jid", "like", "%@g.us%")
    .lte("last_message_at", cutoff);

  if (error || !staleConvs || staleConvs.length === 0) {
    if (error) console.error("[follow-up-check] Error fetching stale reminded convs:", error);
    return;
  }

  console.log(`[follow-up-check] Found ${staleConvs.length} leads stale at proximo_passo_reminded (2h+)`);

  // Check which leads already have this alert (avoid duplicates)
  const leadIds = staleConvs.map((c: any) => c.lead_id).filter(Boolean);
  if (leadIds.length === 0) return;

  // Paginate to bypass Supabase's 1000-row default limit (otherwise leads beyond
  // the first 1000 get re-alerted on every cron run, flooding notifications)
  const alreadyAlerted = new Set<string>();
  const BATCH = 200;
  for (let i = 0; i < leadIds.length; i += BATCH) {
    const slice = leadIds.slice(i, i + BATCH);
    const { data: existingAlerts } = await supabase
      .from("lead_history")
      .select("lead_id")
      .in("lead_id", slice)
      .eq("action", "alerta_reminded_2h")
      .limit(slice.length);
    (existingAlerts || []).forEach((a: any) => a.lead_id && alreadyAlerted.add(a.lead_id));
  }
  const newStale = staleConvs.filter((c: any) => c.lead_id && !alreadyAlerted.has(c.lead_id));

  if (newStale.length === 0) return;

  console.log(`[follow-up-check] Creating alerts for ${newStale.length} new stale leads`);

  for (const conv of newStale) {
    // Test mode guard
    {
      const { data: tmSettings } = await supabase
        .from('wapi_bot_settings')
        .select('test_mode_enabled, test_mode_number')
        .eq('instance_id', conv.instance_id)
        .single();
      if (shouldSkipTestMode(tmSettings?.test_mode_enabled, tmSettings?.test_mode_number, conv.remote_jid)) {
        console.log(`[follow-up-check] 🧪 Test mode active — skipping stale alert for ${conv.remote_jid}`);
        continue;
      }
    }

    const leadName = conv.contact_name || "Lead";

    // Record in lead_history to prevent duplicate alerts
    await supabase.from("lead_history").insert({
      lead_id: conv.lead_id,
      company_id: conv.company_id,
      action: "alerta_reminded_2h",
      new_value: `Sem resposta há mais de ${STALE_HOURS}h após lembrete`,
    });

    // Notify all company users
    const { data: companyUsers } = await supabase
      .from("user_companies")
      .select("user_id")
      .eq("company_id", conv.company_id);

    if (companyUsers) {
      const notifications = companyUsers.map((u: any) => ({
        user_id: u.user_id,
        company_id: conv.company_id,
        type: "stale_reminded",
        title: "⏰ Lead sem resposta após lembrete",
        message: `${leadName} está há mais de ${STALE_HOURS}h sem responder após o lembrete de próximo passo.`,
        data: {
          lead_id: conv.lead_id,
          lead_name: leadName,
          phone: conv.contact_phone,
          stale_since: conv.last_message_at,
        },
      }));

      await supabase.from("notifications").insert(notifications);
    }

    console.log(`[follow-up-check] ⏰ Stale alert created for ${leadName} (lead ${conv.lead_id})`);
  }
}

// ============= STUCK BOT RECOVERY (reprocesses conversations where webhook timed out) =============

// --- Validation functions (copied from wapi-webhook since edge functions can't share code) ---

const RECOVERY_MONTH_OPTIONS = [
  { num: 1, value: 'Fevereiro' }, { num: 2, value: 'Março' }, { num: 3, value: 'Abril' },
  { num: 4, value: 'Maio' }, { num: 5, value: 'Junho' }, { num: 6, value: 'Julho' },
  { num: 7, value: 'Agosto' }, { num: 8, value: 'Setembro' }, { num: 9, value: 'Outubro' },
  { num: 10, value: 'Novembro' }, { num: 11, value: 'Dezembro' },
];

const RECOVERY_DAY_OPTIONS = [
  { num: 1, value: 'Segunda a Quinta' }, { num: 2, value: 'Sexta' },
  { num: 3, value: 'Sábado' }, { num: 4, value: 'Domingo' },
];

const RECOVERY_DEFAULT_GUEST_OPTIONS = [
  { num: 1, value: '50 pessoas' }, { num: 2, value: '60 pessoas' },
  { num: 3, value: '70 pessoas' }, { num: 4, value: '80 pessoas' },
  { num: 5, value: '90 pessoas' }, { num: 6, value: '100 pessoas' },
];

const RECOVERY_TIPO_OPTIONS = [
  { num: 1, value: 'Já sou cliente' }, { num: 2, value: 'Quero um orçamento' },
  { num: 3, value: 'Trabalhe Conosco' },
];

const RECOVERY_PROXIMO_PASSO_OPTIONS = [
  { num: 1, value: 'Agendar visita' }, { num: 2, value: 'Tirar dúvidas' },
  { num: 3, value: 'Analisar com calma' },
];

function recoveryNumToKeycap(n: number): string {
  if (n === 10) return '🔟';
  return String(n).split('').map(d => `${d}\uFE0F\u20E3`).join('');
}

function recoveryBuildMenuText(options: { num: number; value: string }[]): string {
  return options.map(opt => `${recoveryNumToKeycap(opt.num)} - ${opt.value}`).join('\n');
}

function recoveryEmojiDigitsToNumber(text: string): number | null {
  if (text.includes('🔟')) return 10;
  const keycapPattern = /([\d])\uFE0F?\u20E3/g;
  let digits = '';
  let m: RegExpExecArray | null;
  while ((m = keycapPattern.exec(text)) !== null) digits += m[1];
  return digits ? parseInt(digits, 10) : null;
}

function recoveryExtractOptionsFromQuestion(questionText: string): { num: number; value: string }[] | null {
  const lines = questionText.split('\n');
  const options: { num: number; value: string }[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Pattern "1 - texto" / "1. texto" / "*1* texto"
    const match = trimmed.match(/^\*?(\d+)\*?\s*[-\.]\s*(.+)$/);
    if (match) {
      options.push({ num: parseInt(match[1]), value: match[2].trim() });
      continue;
    }
    // Emoji keycap digits: "1️⃣ Maio", "🔟 Fevereiro/27", "1️⃣1️⃣ Março/27"
    const emojiNum = recoveryEmojiDigitsToNumber(trimmed);
    if (emojiNum !== null) {
      const label = trimmed
        .replace(/🔟/g, '')
        .replace(/[\d]\uFE0F?\u20E3/g, '')
        .replace(/^\s*[-\.]\s*/, '')
        .trim();
      if (label) options.push({ num: emojiNum, value: label });
    }
  }
  return options.length > 0 ? options : null;
}

function recoveryValidateName(input: string): { valid: boolean; value?: string; error?: string } {
  let name = input.trim();
  const namePatterns = [
    /^(?:(?:o\s+)?meu\s+nome\s+(?:é|e)\s+)(.+)/i,
    /^(?:me\s+chamo\s+)(.+)/i,
    /^(?:(?:eu\s+)?sou\s+(?:o|a)\s+)(.+)/i,
    /^(?:pode\s+me\s+chamar\s+(?:de\s+)?)(.+)/i,
    /^(?:é\s+)(.+)/i,
    /^(?:nome:?\s+)(.+)/i,
  ];
  for (const pattern of namePatterns) {
    const match = name.match(pattern);
    if (match && match[1]) { name = match[1].trim(); break; }
  }
  if (name.length < 2) return { valid: false, error: 'Hmm, não consegui entender seu nome 🤔\n\nPor favor, digite seu nome:' };
  if (!/^[\p{L}\s'-]+$/u.test(name)) return { valid: false, error: 'Por favor, digite apenas seu nome (sem números ou símbolos):' };
  const words = name.split(/\s+/).filter(w => w.length > 0);
  if (words.length > 5) return { valid: false, error: 'Hmm, parece uma frase 🤔\n\nPor favor, digite apenas seu *nome*:' };
  const nonNameWords = ['que','tem','como','quero','queria','gostaria','preciso','vi','vou','estou','tenho','pode','posso','sobre','instagram','facebook','whatsapp','site','promoção','promocao','preço','preco','valor','orçamento','orcamento','festa','evento','buffet','aniversário','aniversario','obrigado','obrigada','por favor','bom dia','boa tarde','boa noite','olá','ola','oi','hey','hello'];
  const lowerName = name.toLowerCase();
  const hasNonNameWord = nonNameWords.some(w => new RegExp(`\\b${w}\\b`, 'i').test(lowerName));
  if (hasNonNameWord) return { valid: false, error: 'Hmm, não consegui entender seu nome 🤔\n\nPor favor, digite apenas seu *nome*:' };
  name = name.replace(/\b\w/g, (c) => c.toUpperCase());
  return { valid: true, value: name };
}

function recoveryValidateMenuChoice(input: string, options: { num: number; value: string }[]): { valid: boolean; value?: string; error?: string } {
  // "1️⃣2️⃣" → "12" (antes virava a opção 1); "1 2" → "12" como no webhook
  const keyed = keycapsToDigits(input.trim());
  const normalized = /^\d[\d\s\-,./]*\d$/.test(keyed) ? keyed.replace(/[\s\-,./]+/g, "") : keyed;
  const numMatch = normalized.match(/^(\d+)/);
  if (numMatch) {
    const num = parseInt(numMatch[1]);
    const option = options.find(opt => opt.num === num);
    if (option) return { valid: true, value: option.value };
  }
  const lower = normalized.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  if (lower.length >= 3) {
    for (const opt of options) {
      const optLower = opt.value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
      if (optLower === lower || optLower.includes(lower) || lower.includes(optLower)) {
        return { valid: true, value: opt.value };
      }
    }
    const keywordMap: Record<string, string[]> = {
      'cliente': ['cliente', 'ja sou', 'já sou', 'sou cliente'],
      'orçamento': ['orcamento', 'orçamento', 'quero um', 'preço', 'preco', 'valor', 'quanto custa'],
      'trabalhe': ['trabalhe', 'trabalhar', 'emprego', 'vaga', 'curriculo', 'currículo'],
      'visita': ['visita', 'agendar', 'conhecer'],
      'dúvidas': ['duvida', 'dúvida', 'duvidas', 'dúvidas', 'pergunta', 'saber mais'],
      'analisar': ['analisar', 'pensar', 'calma', 'depois', 'mais tarde'],
    };
    for (const opt of options) {
      const optLower = opt.value.toLowerCase();
      for (const [keyword, variations] of Object.entries(keywordMap)) {
        if (optLower.includes(keyword)) {
          for (const variation of variations) {
            if (lower.includes(variation)) return { valid: true, value: opt.value };
          }
        }
      }
    }
  }
  const validNumbers = options.map(opt => opt.num).join(', ');
  return { valid: false, error: `Por favor, responda apenas com o *número* da opção desejada (${validNumbers}) 👇\n\n${recoveryBuildMenuText(options)}` };
}

function recoveryValidateAnswer(step: string, input: string, questionText?: string): { valid: boolean; value?: string; error?: string } {
  switch (step) {
    case 'nome': return recoveryValidateName(input);
    case 'tipo': {
      const co = questionText ? recoveryExtractOptionsFromQuestion(questionText) : null;
      return recoveryValidateMenuChoice(input, co || RECOVERY_TIPO_OPTIONS);
    }
    case 'mes': {
      const co = questionText ? recoveryExtractOptionsFromQuestion(questionText) : null;
      return recoveryValidateMenuChoice(input, co || RECOVERY_MONTH_OPTIONS);
    }
    case 'dia': {
      const co = questionText ? recoveryExtractOptionsFromQuestion(questionText) : null;
      return recoveryValidateMenuChoice(input, co || RECOVERY_DAY_OPTIONS);
    }
    case 'convidados': {
      const co = questionText ? recoveryExtractOptionsFromQuestion(questionText) : null;
      return recoveryValidateMenuChoice(input, co || RECOVERY_DEFAULT_GUEST_OPTIONS);
    }
    case 'proximo_passo': case 'proximo_passo_reminded': {
      const co = questionText ? recoveryExtractOptionsFromQuestion(questionText) : null;
      return recoveryValidateMenuChoice(input, co || RECOVERY_PROXIMO_PASSO_OPTIONS);
    }
    default: return { valid: true, value: input.trim() };
  }
}

function recoveryReplaceVariables(text: string, data: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(data)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Support {{key}}, {{ key }}, and {key}
    result = result.replace(new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, 'gi'), value);
    result = result.replace(new RegExp(`\\{${escaped}\\}`, 'gi'), value);
  }
  return result;
}

// --- Main recovery function ---

async function processStuckBotRecovery({
  supabase,
  skipInstanceIds,
}: { supabase: SupabaseAdmin; skipInstanceIds?: Set<string> }): Promise<{ successCount: number; errors: string[] }> {
  const errors: string[] = [];
  let successCount = 0;

  const now = new Date();
  const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
  const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

  console.log(`[follow-up-check] 🔄 Processing stuck bot recovery...`);

  // Find conversations where lead responded but bot never advanced
  const activeBotSteps = ['nome', 'tipo', 'mes', 'dia', 'convidados', 'welcome'];
  const { data: stuckConversations, error: convError } = await supabase
    .from('wapi_conversations')
    .select('id, remote_jid, instance_id, lead_id, bot_data, bot_step, contact_name')
    .eq('bot_enabled', true)
    .eq('last_message_from_me', false)  // Lead responded
    .not('remote_jid', 'like', '%@g.us%')
    .in('bot_step', activeBotSteps)
    .lt('last_message_at', twoMinutesAgo)   // At least 2 min ago
    .gt('last_message_at', thirtyMinutesAgo); // Within 30 min window

  if (convError) {
    console.error(`[follow-up-check] Error fetching stuck bot conversations:`, convError);
    return { successCount: 0, errors: [String(convError)] };
  }

  if (!stuckConversations || stuckConversations.length === 0) {
    console.log(`[follow-up-check] 🔄 No stuck bot conversations found`);
    return { successCount: 0, errors: [] };
  }

  console.log(`[follow-up-check] 🔄 Found ${stuckConversations.length} stuck bot conversations to recover`);

  let recoveryMessagesSent = 0;
  const perInstanceSends = new Map<string, number>();

  for (const conv of stuckConversations) {
    if (skipInstanceIds?.has(String(conv.instance_id))) continue; // número da IA: bot fixo não retoma
    // Per-instance ramp-up cap (anti-burst after reconnection)
    const rampUpEarly = await getReconnectRampUp(supabase, conv.instance_id);
    if (rampUpEarly && (perInstanceSends.get(conv.instance_id) ?? 0) >= rampUpEarly.maxSendsPerRun) {
      console.log(`[follow-up-check] 🐢 Ramp-up cap reached (${rampUpEarly.maxSendsPerRun}) for stuck bot recovery on instance ${conv.instance_id} — skipping conv ${conv.id}`);
      continue;
    }

    // Safe delay between sends to avoid WhatsApp rate limiting (ramp-up overrides)
    if (recoveryMessagesSent > 0) {
      const minD = rampUpEarly ? rampUpEarly.minDelay : 8;
      const maxD = rampUpEarly ? rampUpEarly.maxDelay : 15;
      console.log(`[follow-up-check] ⏳ Waiting ${minD}-${maxD}s before next stuck bot recovery send...`);
      await randomSafeDelay(minD, maxD);
    }

    try {
      // Test mode guard: fetch settings for this instance and skip if not test number
      {
        const { data: tmSettings } = await supabase
          .from('wapi_bot_settings')
          .select('test_mode_enabled, test_mode_number')
          .eq('instance_id', conv.instance_id)
          .single();
        if (shouldSkipTestMode(tmSettings?.test_mode_enabled, tmSettings?.test_mode_number, conv.remote_jid)) {
          console.log(`[follow-up-check] 🧪 Test mode active — skipping stuck bot recovery for ${conv.remote_jid}`);
          continue;
        }
      }

      const botData = (conv.bot_data || {}) as Record<string, string>;

      // Skip if already recovered (prevent loops) — but notify the team that the bot is still stuck
      if ((botData as Record<string, unknown>)._recovery_attempted) {
        console.log(`[follow-up-check] 🔄 Skipping conv ${conv.id} - already recovered`);

        // Notify team once per stuck-recovery cycle (cleared when lead message advances bot in webhook)
        if (!(botData as Record<string, unknown>)._recovery_notified) {
          try {
            const { data: instForNotif } = await supabase
              .from('wapi_instances')
              .select('id, company_id, unit, instance_id')
              .eq('id', conv.instance_id)
              .single();

            if (instForNotif?.company_id) {
              const stepLabels: Record<string, string> = {
                welcome: 'Boas-vindas',
                nome: 'Nome do cliente',
                tipo: 'Tipo de atendimento',
                mes: 'Mês da festa',
                dia: 'Dia da semana',
                convidados: 'Quantidade de convidados',
                proximo_passo: 'Próximo passo',
                proximo_passo_reminded: 'Próximo passo',
              };
              const stepLabel = stepLabels[conv.bot_step || ''] || conv.bot_step || 'desconhecido';
              const contactName = conv.contact_name || conv.remote_jid?.replace(/@.*/, '') || 'Lead';
              const unitName = instForNotif.unit || instForNotif.instance_id || 'WhatsApp';

              const { data: companyUsers } = await supabase
                .from('user_companies')
                .select('user_id')
                .eq('company_id', instForNotif.company_id);

              if (companyUsers && companyUsers.length > 0) {
                const notifications = companyUsers.map((u: { user_id: string }) => ({
                  user_id: u.user_id,
                  company_id: instForNotif.company_id,
                  type: 'bot_recovery_failed',
                  title: '🤖 Bot travado — atendimento manual necessário',
                  message: `${contactName} (${unitName}) não avançou após tentativa de recuperação. Passo esperado: ${stepLabel}. Assuma a conversa para continuar.`,
                  data: {
                    conversation_id: conv.id,
                    lead_id: conv.lead_id,
                    instance_id: instForNotif.id,
                    bot_step: conv.bot_step,
                    step_label: stepLabel,
                    contact_name: contactName,
                  },
                }));
                await supabase.from('notifications').insert(notifications);
                console.log(`[follow-up-check] 🔔 bot_recovery_failed notification sent for conv ${conv.id}`);
              }

              // Mark as notified so we don't spam
              await supabase
                .from('wapi_conversations')
                .update({ bot_data: { ...botData, _recovery_notified: true } })
                .eq('id', conv.id);
            }
          } catch (notifErr) {
            console.error(`[follow-up-check] Failed to send bot_recovery_failed notification for conv ${conv.id}:`, notifErr);
          }
        }
        continue;
      }

      // Get last message from lead
      const { data: lastMsg } = await supabase
        .from('wapi_messages')
        .select('content, timestamp')
        .eq('conversation_id', conv.id)
        .eq('from_me', false)
        .order('timestamp', { ascending: false })
        .limit(1)
        .single();

      if (!lastMsg?.content) {
        console.log(`[follow-up-check] 🔄 No lead message found for conv ${conv.id}`);
        continue;
      }

      const content = lastMsg.content.trim();
      console.log(`[follow-up-check] 🔄 Recovering conv ${conv.id}, step: ${conv.bot_step}, answer: "${content.substring(0, 50)}"`);

      // Get instance info
      const { data: instance } = await supabase
        .from('wapi_instances')
        .select('id, instance_id, instance_token, unit, company_id, provider, client_token')
        .eq('id', conv.instance_id)
        .single();

      if (!instance) {
        console.log(`[follow-up-check] 🔄 Instance not found for conv ${conv.id}`);
        continue;
      }

      // === HEALTH GATE for stuck bot recovery (per-instance) ===
      const recoveryHealth = await checkInstanceHealth(supabase, instance.id);
      if (!recoveryHealth.healthy) {
        console.log(`[follow-up-check] 🛡️ Stuck bot recovery BLOCKED for conv ${conv.id}: ${recoveryHealth.reason}`);
        continue;
      }

      // Fetch company name for variable injection
      let companyName = '';
      if (instance.company_id) {
        const { data: companyRow } = await supabase
          .from('companies')
          .select('name')
          .eq('id', instance.company_id)
          .single();
        companyName = companyRow?.name || '';
      }
      if (!companyName) {
        console.log(`[follow-up-check] 🔄 Warning: no company name found for instance ${instance.id}`);
      }

      // Get bot questions for this instance
      const { data: botQuestionsData } = await supabase
        .from('wapi_bot_questions')
        .select('step, question_text, confirmation_text, sort_order')
        .eq('instance_id', instance.id)
        .eq('is_active', true)
        .order('sort_order', { ascending: true });

      // Build questions chain
      const questions: Record<string, { question: string; confirmation: string | null; next: string }> = {};
      if (botQuestionsData && botQuestionsData.length > 0) {
        for (let i = 0; i < botQuestionsData.length; i++) {
          const q = botQuestionsData[i];
          const nextStep = i < botQuestionsData.length - 1 ? botQuestionsData[i + 1].step : 'complete';
          questions[q.step] = { question: q.question_text, confirmation: q.confirmation_text || null, next: nextStep };
        }
      } else {
        // Default questions
        questions['nome'] = { question: 'Para começar, me conta: qual é o seu nome? 😊', confirmation: 'Muito prazer, {nome}! 🥰✨', next: 'tipo' };
        questions['tipo'] = { question: `Você já é nosso cliente e tem uma festa agendada, ou gostaria de receber um orçamento? 🎉\n\nResponda com o *número*:\n\n${recoveryBuildMenuText(RECOVERY_TIPO_OPTIONS)}`, confirmation: null, next: 'mes' };
        questions['mes'] = { question: `Que legal! 🎉 E pra qual mês você tá pensando em fazer essa festa incrível?\n\n📅 Responda com o *número*:\n\n${recoveryBuildMenuText(RECOVERY_MONTH_OPTIONS)}`, confirmation: '{mes}, ótima escolha! 🎊', next: 'dia' };
        questions['dia'] = { question: `Maravilha! Tem preferência de dia da semana? 🗓️\n\nResponda com o *número*:\n\n${recoveryBuildMenuText(RECOVERY_DAY_OPTIONS)}`, confirmation: 'Anotado!', next: 'convidados' };
        questions['convidados'] = { question: `E quantos convidados você pretende chamar pra essa festa mágica? 🎈\n\n👥 Responda com o *número*:\n\n${recoveryBuildMenuText(RECOVERY_DEFAULT_GUEST_OPTIONS)}`, confirmation: null, next: 'complete' };
      }

      const step = conv.bot_step || 'welcome';
      const updated = { ...botData };
      delete (updated as Record<string, unknown>)._inactive_reminded;

      // Inject company aliases into variable map
      if (companyName) {
        updated['empresa'] = companyName;
        updated['buffet'] = companyName;
        updated['nome_empresa'] = companyName;
        updated['nome-empresa'] = companyName;
      }

      // Get bot settings for messages
      const { data: settings } = await supabase
        .from('wapi_bot_settings')
        .select('*')
        .eq('instance_id', instance.id)
        .single();

      // Handle welcome step - the lead's first message, need to send welcome + first question
      if (step === 'welcome') {
        const questionSteps = Object.keys(questions);
        const firstStep = questionSteps[0] || 'nome';
        const firstQ = questions[firstStep];
        const rawWelcome = settings?.welcome_message || 'Olá! 👋';
        const renderedWelcome = recoveryReplaceVariables(rawWelcome, updated);
        // Avoid duplicating name question if welcome already contains it
        const firstQuestion = firstQ?.question || 'Para começar, me conta: qual é o seu nome? 😊';
        const welcomeAlreadyAsksName = /qual\s+(?:é\s+)?(?:o\s+)?seu\s+nome/i.test(rawWelcome);
        const welcomeMsg = welcomeAlreadyAsksName ? renderedWelcome : renderedWelcome + '\n\n' + firstQuestion;

        const phone = conv.remote_jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
        const sendRes = await providerSendText(instance, phone, welcomeMsg, { delayTyping: 1 });
        const msgId = sendRes.messageId;

        if (msgId) {
          await supabase.from('wapi_messages').insert({
            conversation_id: conv.id, message_id: msgId, from_me: true,
            message_type: 'text', content: welcomeMsg, status: 'sent',
            timestamp: new Date().toISOString(), company_id: instance.company_id,
            metadata: { source: 'bot' },
          });
        }

        const recoveryData = { ...updated, _recovery_attempted: true };
        await supabase.from('wapi_conversations').update({
          bot_step: firstStep, bot_data: recoveryData, bot_enabled: true,
          last_message_at: new Date().toISOString(),
          last_message_content: welcomeMsg.substring(0, 100),
          last_message_from_me: true,
        }).eq('id', conv.id);

        console.log(`[follow-up-check] 🔄 Recovered welcome step for conv ${conv.id}`);
        successCount++;
        recoveryMessagesSent++; perInstanceSends.set(conv.instance_id, (perInstanceSends.get(conv.instance_id) ?? 0) + 1);
        continue;
      }

      // For active qualification steps, validate the answer
      const currentQuestionText = questions[step]?.question;
      const validation = recoveryValidateAnswer(step, content, currentQuestionText);

      if (!validation.valid) {
        // Invalid answer - re-send the question with error
        const errorMsg = validation.error || 'Não entendi sua resposta. Por favor, tente novamente.';
        const phone = conv.remote_jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
        
        const sendRes = await providerSendText(instance, phone, errorMsg, { delayTyping: 1 });
        const msgId = sendRes.messageId;
        
        if (msgId) {
          await supabase.from('wapi_messages').insert({
            conversation_id: conv.id, message_id: msgId, from_me: true,
            message_type: 'text', content: errorMsg, status: 'sent',
            timestamp: new Date().toISOString(), company_id: instance.company_id,
            metadata: { source: 'bot' },
          });
        }

        const recoveryData = { ...updated, _recovery_attempted: true };
        await supabase.from('wapi_conversations').update({
          bot_step: step, bot_data: recoveryData, bot_enabled: true,
          last_message_at: new Date().toISOString(),
          last_message_content: errorMsg.substring(0, 100),
          last_message_from_me: true,
        }).eq('id', conv.id);

        console.log(`[follow-up-check] 🔄 Invalid answer for conv ${conv.id}, re-sent question`);
        successCount++;
        recoveryMessagesSent++; perInstanceSends.set(conv.instance_id, (perInstanceSends.get(conv.instance_id) ?? 0) + 1);
        continue;
      }

      // Valid answer - save and advance
      updated[step] = validation.value || content;

      // Special handling for tipo step
      if (step === 'tipo') {
        const isAlreadyClient = validation.value === 'Já sou cliente' || content.trim() === '1';
        const wantsWork = validation.value === 'Trabalhe Conosco' || content.trim() === '3';

        if (isAlreadyClient) {
          const defaultTransfer = `Entendido, {nome}! 😊\n\nVou transferir sua conversa para nossa equipe comercial.\n\nAguarde um momento! 💜`;
          const transferMsg = recoveryReplaceVariables(settings?.transfer_message || defaultTransfer, updated);
          const phone = conv.remote_jid.replace('@s.whatsapp.net', '').replace('@c.us', '');

          const sendRes = await providerSendText(instance, phone, transferMsg, { delayTyping: 1 });
          const msgId = sendRes.messageId;
          if (msgId) {
            await supabase.from('wapi_messages').insert({
              conversation_id: conv.id, message_id: msgId, from_me: true,
              message_type: 'text', content: transferMsg, status: 'sent',
              timestamp: new Date().toISOString(), company_id: instance.company_id,
              metadata: { source: 'bot' },
            });
          }
          await supabase.from('wapi_conversations').update({
            bot_step: 'transferred', bot_data: updated, bot_enabled: false,
            last_message_at: new Date().toISOString(),
            last_message_content: transferMsg.substring(0, 100),
            last_message_from_me: true,
          }).eq('id', conv.id);

          console.log(`[follow-up-check] 🔄 Recovered conv ${conv.id} - client transfer`);
          successCount++;
          recoveryMessagesSent++; perInstanceSends.set(conv.instance_id, (perInstanceSends.get(conv.instance_id) ?? 0) + 1);
          continue;
        }

        if (wantsWork) {
          const defaultWork = `Que legal que você quer fazer parte do nosso time! 💼✨\n\nEnvie seu currículo aqui nesta conversa!\n\nObrigado pelo interesse! 😊`;
          const workMsg = recoveryReplaceVariables(settings?.work_here_response || defaultWork, updated);
          const phone = conv.remote_jid.replace('@s.whatsapp.net', '').replace('@c.us', '');

          const sendRes = await providerSendText(instance, phone, workMsg, { delayTyping: 1 });
          const msgId = sendRes.messageId;
          if (msgId) {
            await supabase.from('wapi_messages').insert({
              conversation_id: conv.id, message_id: msgId, from_me: true,
              message_type: 'text', content: workMsg, status: 'sent',
              timestamp: new Date().toISOString(), company_id: instance.company_id,
              metadata: { source: 'bot' },
            });
          }

          // Create RH lead
          const leadName = updated.nome || conv.contact_name || conv.remote_jid;
          const n = conv.remote_jid.replace('@s.whatsapp.net', '').replace('@c.us', '').replace(/\D/g, '');
          const { data: newLead } = await supabase.from('campaign_leads').insert({
            name: leadName, whatsapp: n, unit: 'Trabalhe Conosco',
            campaign_id: 'whatsapp-bot-rh', campaign_name: 'WhatsApp (Bot) - RH',
            status: 'trabalhe_conosco', company_id: instance.company_id,
          }).select('id').single();

          if (newLead) {
            await supabase.from('wapi_conversations').update({ lead_id: newLead.id }).eq('id', conv.id);
          }

          await supabase.from('wapi_conversations').update({
            bot_step: 'work_interest', bot_data: updated, bot_enabled: false,
            last_message_at: new Date().toISOString(),
            last_message_content: workMsg.substring(0, 100),
            last_message_from_me: true,
          }).eq('id', conv.id);

          console.log(`[follow-up-check] 🔄 Recovered conv ${conv.id} - work interest`);
          successCount++;
          recoveryMessagesSent++; perInstanceSends.set(conv.instance_id, (perInstanceSends.get(conv.instance_id) ?? 0) + 1);
          continue;
        }
        // Option 2 (quote) - continue normal flow below
      }

      // Update contact_name when bot collects the lead's real name
      if (step === 'nome' && validation.value) {
        await supabase.from('wapi_conversations').update({ contact_name: validation.value }).eq('id', conv.id);
      }

      const currentQ = questions[step];
      const nextStepKey = currentQ?.next || 'complete';

      if (nextStepKey === 'complete') {
        // Qualification complete - create/update lead + send completion message
        const defaultCompletion = `Perfeito, {nome}! 🎉✨\n\nAnotei tudo aqui:\n\n📅 Mês: {mes}\n🗓️ Dia: {dia}\n👥 Convidados: {convidados}`;
        const completionMsg = recoveryReplaceVariables(settings?.completion_message || defaultCompletion, updated);
        const phone = conv.remote_jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
        const n = phone.replace(/\D/g, '');

        // Send completion message
        const sendRes = await providerSendText(instance, phone, completionMsg, { delayTyping: 1 });
        const msgId = sendRes.messageId;
        if (msgId) {
          await supabase.from('wapi_messages').insert({
            conversation_id: conv.id, message_id: msgId, from_me: true,
            message_type: 'text', content: completionMsg, status: 'sent',
            timestamp: new Date().toISOString(), company_id: instance.company_id,
            metadata: { source: 'bot' },
          });
        }

        // Create or update lead
        if (conv.lead_id) {
          await supabase.from('campaign_leads').update({
            name: updated.nome || conv.contact_name || phone,
            month: updated.mes || null,
            day_preference: updated.dia || null,
            guests: updated.convidados || null,
          }).eq('id', conv.lead_id);
        } else {
          // Pessoa que já é lead da empresa (qualquer formato de telefone/unidade): reaproveita
          const existing = await findLeadByPhone<{ id: string }>(supabase, instance.company_id, n, 'id');
          const { data: newLead } = existing
            ? await supabase.from('campaign_leads').update({
                name: updated.nome || conv.contact_name || phone,
                month: updated.mes || null,
                day_preference: updated.dia || null,
                guests: updated.convidados || null,
              }).eq('id', existing.id).select('id').single()
            : await supabase.from('campaign_leads').insert({
            name: updated.nome || conv.contact_name || phone,
            whatsapp: n,
            unit: instance.unit,
            campaign_id: 'whatsapp-bot',
            campaign_name: 'WhatsApp (Bot)',
            status: 'novo',
            month: updated.mes || null,
            day_preference: updated.dia || null,
            guests: updated.convidados || null,
            company_id: instance.company_id,
          }).select('id').single();
          if (newLead) {
            await supabase.from('wapi_conversations').update({ lead_id: newLead.id }).eq('id', conv.id);
          }
        }

        // Update conversation to sending_materials step
        const recoveryData = { ...updated, _recovery_attempted: true };
        await supabase.from('wapi_conversations').update({
          bot_step: 'sending_materials', bot_data: recoveryData, bot_enabled: true,
          last_message_at: new Date().toISOString(),
          last_message_content: completionMsg.substring(0, 100),
          last_message_from_me: true,
        }).eq('id', conv.id);

        // ===== SEND MATERIALS (photos, videos, PDFs) =====
        await recoverySendMaterials(supabase, instance, conv, updated, settings);

        // Now send the next step question after materials
        const defaultNextStepQuestion = `E agora, como você gostaria de continuar? 🤔\n\nResponda com o *número*:\n\n${recoveryBuildMenuText(RECOVERY_PROXIMO_PASSO_OPTIONS)}`;
        const nextStepQuestion = settings?.next_step_question || defaultNextStepQuestion;

        // Wait a bit then send next step question
        const nsMsgDelay = (settings?.message_delay_seconds || 5) * 1000;
        await new Promise(r => setTimeout(r, nsMsgDelay));
        
        const sendRes2 = await providerSendText(instance, phone, nextStepQuestion, { delayTyping: 2 });
        const msgId2 = sendRes2.messageId;
        if (msgId2) {
          await supabase.from('wapi_messages').insert({
            conversation_id: conv.id, message_id: msgId2, from_me: true,
            message_type: 'text', content: nextStepQuestion, status: 'sent',
            timestamp: new Date().toISOString(), company_id: instance.company_id,
            metadata: { source: 'bot' },
          });
        }

        await supabase.from('wapi_conversations').update({
          bot_step: 'proximo_passo',
          last_message_at: new Date().toISOString(),
          last_message_content: nextStepQuestion.substring(0, 100),
          last_message_from_me: true,
        }).eq('id', conv.id);

        console.log(`[follow-up-check] 🔄 Recovered conv ${conv.id} - qualification complete, materials sent, next step question sent`);
        successCount++;
        recoveryMessagesSent++; perInstanceSends.set(conv.instance_id, (perInstanceSends.get(conv.instance_id) ?? 0) + 1);
        continue;
      }

      // Normal step progression - send confirmation + next question
      const nextQ = questions[nextStepKey];
      let confirmation = currentQ?.confirmation || '';
      if (confirmation) confirmation = recoveryReplaceVariables(confirmation, updated);
      const nextQuestionMsg = confirmation
        ? `${confirmation}\n\n${nextQ?.question || ''}`
        : (nextQ?.question || '');

      const phone = conv.remote_jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
      const sendRes = await providerSendText(instance, phone, nextQuestionMsg, { delayTyping: 1 });
      const msgId = sendRes.messageId;
      if (msgId) {
        await supabase.from('wapi_messages').insert({
          conversation_id: conv.id, message_id: msgId, from_me: true,
          message_type: 'text', content: nextQuestionMsg, status: 'sent',
          timestamp: new Date().toISOString(), company_id: instance.company_id,
          metadata: { source: 'bot' },
        });
      }

      const recoveryData = { ...updated, _recovery_attempted: true };
      await supabase.from('wapi_conversations').update({
        bot_step: nextStepKey, bot_data: recoveryData, bot_enabled: true,
        last_message_at: new Date().toISOString(),
        last_message_content: nextQuestionMsg.substring(0, 100),
        last_message_from_me: true,
      }).eq('id', conv.id);

      console.log(`[follow-up-check] 🔄 Recovered conv ${conv.id}: ${step} → ${nextStepKey}`);
      successCount++;
      recoveryMessagesSent++; perInstanceSends.set(conv.instance_id, (perInstanceSends.get(conv.instance_id) ?? 0) + 1);
    } catch (err) {
      console.error(`[follow-up-check] 🔄 Error recovering conv ${conv.id}:`, err);
      errors.push(`Recovery error conv ${conv.id}: ${String(err)}`);
    }
  }

  return { successCount, errors };
}

// ============= RECOVERY: SEND MATERIALS (photos, videos, PDFs) =============

async function recoverySendMaterials(
  supabase: SupabaseAdmin,
  instance: { id: string; instance_id: string; instance_token: string; unit: string | null; company_id: string },
  conv: { id: string; remote_jid: string },
  botData: Record<string, string>,
  settings: Record<string, unknown> | null
) {
  if (settings?.auto_send_materials === false) {
    console.log('[Recovery Materials] Auto-send is disabled');
    return;
  }

  const unit = instance.unit;
  const month = botData.mes || '';
  const guestsStr = botData.convidados || '';
  const phone = conv.remote_jid.replace('@s.whatsapp.net', '').replace('@c.us', '');

  // Fetch company name for customer-facing messages
  let companyName = unit || '';
  if (instance.company_id) {
    const { data: companyRow } = await supabase.from('companies').select('name').eq('id', instance.company_id).maybeSingle();
    if (companyRow?.name) companyName = companyRow.name;
  }

  if (!unit) {
    console.log('[Recovery Materials] No unit configured, skipping');
    return;
  }

  const sendPhotos = settings?.auto_send_photos !== false;
  const sendPresentationVideo = settings?.auto_send_presentation_video !== false;
  const sendPromoVideo = settings?.auto_send_promo_video !== false;
  const sendPdf = settings?.auto_send_pdf !== false;
  const messageDelay = ((settings?.message_delay_seconds as number) || 5) * 1000;
  const photosIntro = (settings?.auto_send_photos_intro as string) || '✨ Conheça nosso espaço incrível! 🎈🎉';
  const pdfIntro = (settings?.auto_send_pdf_intro as string) || '📋 Oi {nome}! Segue o pacote completo para {convidados} no {empresa}. Qualquer dúvida é só chamar! 💜';

  await new Promise(r => setTimeout(r, messageDelay));

  // Fetch captions
  const { data: captions } = await supabase
    .from('sales_material_captions')
    .select('caption_type, caption_text')
    .eq('is_active', true);

  const captionMap: Record<string, string> = {};
  captions?.forEach((c: { caption_type: string; caption_text: string }) => { captionMap[c.caption_type] = c.caption_text; });

  // Fetch materials
  const { data: materials, error: matError } = await supabase
    .from('sales_materials')
    .select('*')
    .eq('unit', unit)
    .eq('is_active', true)
    .order('type', { ascending: true })
    .order('sort_order', { ascending: true });

  if (matError || !materials?.length) {
    console.log(`[Recovery Materials] No materials found for unit ${unit}`);
    return;
  }

  console.log(`[Recovery Materials] Found ${materials.length} materials for ${unit}`);

  const photoCollections = materials.filter((m: any) => m.type === 'photo_collection');
  const presentationVideos = materials.filter((m: any) => m.type === 'video' && m.name?.toLowerCase().includes('apresentação'));
  const promoVideos = materials.filter((m: any) => m.type === 'video' && (m.name?.toLowerCase().includes('promo') || m.name?.toLowerCase().includes('carnaval')));
  const pdfPackages = materials.filter((m: any) => m.type === 'pdf_package');

  const guestMatch = guestsStr.match(/(\d+)/);
  const guestCount = guestMatch ? parseInt(guestMatch[1]) : null;
  // Promo video is now controlled solely by the auto_send_promo_video flag

  // Helper functions
  const sendImage = async (url: string, caption: string) => {
    try {
      const imgRes = await fetch(url);
      if (!imgRes.ok) return null;
      const buf = await imgRes.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 32768) {
        const chunk = bytes.subarray(i, Math.min(i + 32768, bytes.length));
        bin += String.fromCharCode.apply(null, Array.from(chunk));
      }
      const ct = imgRes.headers.get('content-type') || 'image/jpeg';
      const base64 = `data:${ct};base64,${btoa(bin)}`;
      const sendRes = await providerSendImage(instance, phone, base64, caption);
      return sendRes.messageId;
    } catch (e) { console.error('[Recovery Materials] Error sending image:', e); return null; }
  };

  const sendVideo = async (url: string, caption: string) => {
    try {
      const sendRes = await providerSendVideo(instance, phone, url, caption);
      return sendRes.messageId;
    } catch (e) { console.error('[Recovery Materials] Error sending video:', e); return null; }
  };

  const sendDocument = async (url: string, fileName: string) => {
    try {
      const sendRes = await providerSendDocument(instance, phone, url, fileName);
      return sendRes.messageId;
    } catch (e) { console.error('[Recovery Materials] Error sending document:', e); return null; }
  };

  const sendText = async (message: string) => {
    try {
      const sendRes = await providerSendText(instance, phone, message, { delayTyping: 1 });
      return sendRes.messageId;
    } catch (e) { console.error('[Recovery Materials] Error sending text:', e); return null; }
  };

  const saveMessage = async (msgId: string, type: string, content: string, mediaUrl?: string) => {
    await supabase.from('wapi_messages').insert({
      conversation_id: conv.id, message_id: msgId, from_me: true,
      message_type: type, content, media_url: mediaUrl || null,
      status: 'sent', timestamp: new Date().toISOString(),
      company_id: instance.company_id,
      metadata: { source: 'bot' },
    });
  };

  // 1. PHOTOS
  if (sendPhotos && photoCollections.length > 0) {
    const collection = photoCollections[0] as any;
    const photos = collection.photo_urls || [];
    if (photos.length > 0) {
      console.log(`[Recovery Materials] Sending ${photos.length} photos`);
      const introText = photosIntro.replace(/\{unidade\}/gi, companyName).replace(/\{empresa\}/gi, companyName);
      const introMsgId = await sendText(introText);
      if (introMsgId) await saveMessage(introMsgId, 'text', introText);
      await new Promise(r => setTimeout(r, messageDelay / 2));
      for (let i = 0; i < photos.length; i++) {
        const msgId = await sendImage(photos[i], '');
        if (msgId) await saveMessage(msgId, 'image', '📷', photos[i]);
        if (i < photos.length - 1) await new Promise(r => setTimeout(r, 2000));
      }
      console.log(`[Recovery Materials] Photos sent`);
      await new Promise(r => setTimeout(r, messageDelay));
    }
  }

  // 2. PRESENTATION VIDEO
  if (sendPresentationVideo && presentationVideos.length > 0) {
    const video = presentationVideos[0] as any;
    console.log(`[Recovery Materials] Sending presentation video: ${video.name}`);
    const videoCaption = captionMap['video'] || `🎬 Conheça o ${companyName}! ✨`;
    const caption = videoCaption.replace(/\{unidade\}/gi, companyName).replace(/\{empresa\}/gi, companyName);
    const msgId = await sendVideo(video.file_url, caption);
    if (msgId) await saveMessage(msgId, 'video', caption, video.file_url);
    await new Promise(r => setTimeout(r, messageDelay));
  }

  // 3. PDF PACKAGE
  if (sendPdf && guestCount && pdfPackages.length > 0) {
    let matchingPdf = pdfPackages.find((p: any) => p.guest_count === guestCount) as any;
    if (!matchingPdf) {
      const sorted = pdfPackages.filter((p: any) => p.guest_count).sort((a: any, b: any) => (a.guest_count || 0) - (b.guest_count || 0));
      matchingPdf = sorted.find((p: any) => (p.guest_count || 0) >= guestCount) || sorted[sorted.length - 1];
    }
    if (matchingPdf) {
      console.log(`[Recovery Materials] Sending PDF: ${matchingPdf.name} for ${guestCount} guests`);
      const firstName = (botData.nome || '').split(' ')[0] || 'você';
      const pdfIntroText = pdfIntro
        .replace(/\{nome\}/gi, firstName)
        .replace(/\{convidados\}/gi, guestsStr)
        .replace(/\{unidade\}/gi, companyName)
        .replace(/\{empresa\}/gi, companyName);
      const introMsgId = await sendText(pdfIntroText);
      if (introMsgId) await saveMessage(introMsgId, 'text', pdfIntroText);
      await new Promise(r => setTimeout(r, messageDelay / 4));
      const fileExt = matchingPdf.file_url.split('?')[0].split('.').pop()?.toLowerCase() || '';
      const isPkgImage = ['jpg', 'jpeg', 'png', 'webp'].includes(fileExt);
      if (isPkgImage) {
        const caption = matchingPdf.name || 'Pacote';
        const msgId = await sendImage(matchingPdf.file_url, caption);
        if (msgId) await saveMessage(msgId, 'image', caption, matchingPdf.file_url);
      } else {
        const fileName = matchingPdf.name?.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, ' ').trim() + '.pdf' || `Pacote ${guestCount} pessoas.pdf`;
        const msgId = await sendDocument(matchingPdf.file_url, fileName);
        if (msgId) await saveMessage(msgId, 'document', fileName, matchingPdf.file_url);
      }
      await new Promise(r => setTimeout(r, messageDelay));
    }
  }

  // 4. PROMO VIDEO
  if (sendPromoVideo && promoVideos.length > 0) {
    const promoVideo = promoVideos[0] as any;
    console.log(`[Recovery Materials] Sending promo video: ${promoVideo.name}`);
    const promoCaption = captionMap['video_promo'] || captionMap['video'] || `🎬 Confira nosso vídeo! ✨`;
    const caption = promoCaption.replace(/\{unidade\}/gi, unit);
    const msgId = await sendVideo(promoVideo.file_url, caption);
    if (msgId) await saveMessage(msgId, 'video', caption, promoVideo.file_url);
    await new Promise(r => setTimeout(r, messageDelay * 1.5));
  }

  await supabase.from('wapi_conversations').update({
    last_message_at: new Date().toISOString(),
    last_message_content: '📄 Materiais enviados (recovery)',
    last_message_from_me: true,
  }).eq('id', conv.id);

  console.log(`[Recovery Materials] Auto-send complete for ${phone}`);
}

// ============= INSTANCE HEALTH CHECK (Auto-Recovery) =============

async function processInstanceHealthCheck(
  supabase: SupabaseAdmin
): Promise<void> {
  console.log("[health-check] Starting instance health check...");

  // Fetch ALL instances: connected, degraded AND disconnected (for auto-reconnection)
  const { data: instances, error: instError } = await supabase
    .from("wapi_instances")
    .select("id, instance_id, instance_token, company_id, unit, status, last_health_check, auto_recovery_attempts, last_restart_attempt")
    .eq("is_active", true) // número desativado não deve ser reconectado/reiniciado sozinho
    .neq("provider", "evolution") // Evolution Go tem monitor próprio (evolution-monitor)
    .in("status", ["connected", "degraded", "disconnected"]);

  if (instError || !instances || instances.length === 0) {
    if (instError) console.error("[health-check] Error fetching instances:", instError);
    else console.log("[health-check] No instances to check");
    return;
  }

  console.log(`[health-check] Checking ${instances.length} instances (connected + degraded + disconnected)...`);
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  for (const inst of instances) {
    try {
      // For connected/degraded: cooldown 30 min between checks
      // For disconnected: cooldown 30 min between restart attempts
      const cooldownField = inst.status === "disconnected" ? inst.last_restart_attempt : inst.last_health_check;
      if (cooldownField) {
        const lastTime = new Date(cooldownField).getTime();
        const now = Date.now();
        if (now - lastTime < 30 * 60 * 1000) {
          continue; // Skip - checked/attempted recently
        }
      }

      // Call wapi-send edge function to get real status
      let detectedStatus = "disconnected";
      let detectedErrorType: string | null = null;
      let detectedPhone: string | null = null;
      try {
        const statusResponse = await fetch(
          `${SUPABASE_URL}/functions/v1/wapi-send`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              action: "get-status",
              instanceId: inst.instance_id,
              instanceToken: inst.instance_token,
            }),
          }
        );

        if (statusResponse.ok) {
          const statusData = await statusResponse.json();
          detectedStatus = statusData?.status || "disconnected";
          detectedErrorType = statusData?.errorType || null;
          detectedPhone = statusData?.phoneNumber || statusData?.phone || null;
          console.log(`[health-check] wapi-send get-status for ${inst.instance_id} (DB: ${inst.status}): ${detectedStatus}${detectedErrorType ? ` / ${detectedErrorType}` : ""}`);
        } else {
          const errText = await statusResponse.text();
          console.warn(`[health-check] wapi-send get-status failed for ${inst.instance_id} (${statusResponse.status}): ${errText}`);
        }
      } catch (fetchErr) {
        console.warn(`[health-check] wapi-send fetch error for ${inst.instance_id}:`, fetchErr);
      }

      // Update last_health_check timestamp
      await supabase
        .from("wapi_instances")
        .update({ last_health_check: new Date().toISOString() })
        .eq("id", inst.id);

      // === Handle detected status ===

      if (detectedStatus === "connected") {
        const updateData: Record<string, unknown> = {
          status: "connected",
          connected_at: new Date().toISOString(),
          auto_recovery_attempts: 0,
        };
        if (detectedPhone) updateData.phone_number = detectedPhone;

        if (inst.status !== "connected") {
          console.log(`[health-check] ✅ Instance ${inst.instance_id} auto-recovered! Was ${inst.status}, now connected.`);
          await supabase.from("wapi_instances").update(updateData).eq("id", inst.id);
        } else {
          console.log(`[health-check] Instance ${inst.instance_id} is healthy (connected)`);
          if (detectedPhone || (inst.auto_recovery_attempts || 0) > 0) {
            await supabase.from("wapi_instances").update(updateData).eq("id", inst.id);
          }
        }
        continue;
      }

      if (detectedStatus === "degraded") {
        if (inst.status === "connected" && detectedErrorType === "AMBIGUOUS_QR_STATE") {
          console.log(`[health-check] Instance ${inst.instance_id} returned ambiguous QR state — preserving connected status`);
          continue;
        }

        console.log(`[health-check] Instance ${inst.instance_id} is degraded${detectedErrorType ? ` (${detectedErrorType})` : ""} — keeping status, no restart`);
        if (inst.status !== "degraded") {
          await supabase.from("wapi_instances").update({ status: "degraded" }).eq("id", inst.id);
        }

        // Só avisa quando se confirma: degraded de novo na checagem seguinte
        // e sem nenhum aviso do WhatsApp nos últimos 30 min (evita alarme falso
        // de uma resposta estranha/lenta da W-API com o número funcionando).
        const { data: lastEvent } = await supabase
          .from("wapi_webhook_raw_events")
          .select("received_at")
          .eq("instance_id", inst.instance_id)
          .order("received_at", { ascending: false })
          .limit(1);
        const degradedDecision = decideDegradedAlert({
          previousStatus: inst.status,
          lastWebhookEventAt: lastEvent?.[0]?.received_at ?? null,
          now: Date.now(),
        });
        if (!degradedDecision.alert) {
          console.log(`[health-check] ${inst.unit || inst.instance_id} degraded sem aviso ainda (${degradedDecision.reason})`);
          continue;
        }

        // Send notification only once (check if there's a recent one in the last 6 hours)
        const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
        const { data: recentNotif } = await supabase
          .from("notifications")
          .select("id")
          .eq("company_id", inst.company_id)
          .eq("type", "instance_degraded")
          .gte("created_at", sixHoursAgo)
          .limit(1);

        if (!recentNotif || recentNotif.length === 0) {
          const unitName = inst.unit || inst.instance_id || "WhatsApp";
          const ownerWhatsAppSent = await sendOwnerSilentInstanceAlert(supabase, inst, inst.id, null, "degraded");
          const { data: companyUsers } = await supabase
            .from("user_companies")
            .select("user_id")
            .eq("company_id", inst.company_id);

          if (companyUsers && companyUsers.length > 0) {
            const notifications = companyUsers.map((u: { user_id: string }) => ({
              user_id: u.user_id,
              company_id: inst.company_id,
              type: "instance_degraded",
              title: "⚠️ WhatsApp em modo degradado",
              message: `A instância ${unitName} está funcionando parcialmente. Alguns recursos podem estar limitados.`,
              data: { instance_id: inst.id, instance_name: unitName, owner_whatsapp_sent: ownerWhatsAppSent },
            }));
            await supabase.from("notifications").insert(notifications);
            console.log(`[health-check] Degraded notification sent for ${inst.instance_id}`);
          }
        }
        continue;
      }

      // === Status is "disconnected" or "instance_not_found" ===

      // If the instance was already degraded in our DB, keep it as degraded — don't worsen it
      if (inst.status === "degraded") {
        console.log(`[health-check] Instance ${inst.instance_id} returned ${detectedStatus} but was degraded in DB — keeping degraded, no restart`);
        continue;
      }

      // If the provider reports disconnected, update our DB to reflect reality
      // so users see the real status and can reconnect.
      if (inst.status === "connected" && detectedStatus === "disconnected") {
        console.log(`[health-check] Instance ${inst.instance_id} confirmed disconnected — updating DB status to disconnected`);
        await supabase
          .from("wapi_instances")
          .update({ status: "disconnected" })
          .eq("id", inst.id);
        await notifyInstanceDisconnected(supabase, inst);
        continue;
      }

      // Instance is disconnected — attempt restart (with cooldown via last_restart_attempt)
      console.log(`[health-check] Instance ${inst.instance_id} is ${detectedStatus} (DB: ${inst.status}). Attempting auto-restart...`);

      // Update last_restart_attempt to enforce cooldown
      await supabase
        .from("wapi_instances")
        .update({ last_restart_attempt: new Date().toISOString() })
        .eq("id", inst.id);

      try {
        const restartResponse = await fetch(
          `${SUPABASE_URL}/functions/v1/wapi-send`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              action: "restart-instance",
              instanceId: inst.instance_id,
              instanceToken: inst.instance_token,
            }),
          }
        );

        if (restartResponse.ok) {
          console.log(`[health-check] ✅ Auto-restart successful for ${inst.instance_id}`);
          await supabase
            .from("wapi_instances")
            .update({ auto_recovery_attempts: (inst.auto_recovery_attempts || 0) + 1 })
            .eq("id", inst.id);
          continue;
        }

        const restartErr = await restartResponse.text();
        console.error(`[health-check] ❌ Auto-restart FAILED for ${inst.instance_id}: ${restartErr}`);
      } catch (restartFetchErr) {
        console.error(`[health-check] ❌ Auto-restart fetch error for ${inst.instance_id}:`, restartFetchErr);
      }

      // Restart failed — if was connected, mark as disconnected and notify
      if (inst.status === "connected") {
        await supabase
          .from("wapi_instances")
          .update({
            status: "disconnected",
            connected_at: null,
            auto_recovery_attempts: 0,
          })
          .eq("id", inst.id);

        await notifyInstanceDisconnected(supabase, inst);
      }
      // If already disconnected, just log - don't spam notifications
      else if (inst.status === "disconnected") {
        console.log(`[health-check] Instance ${inst.instance_id} still disconnected after restart attempt. Will retry in 30min.`);
      }
    } catch (err) {
      console.error(`[health-check] Error checking instance ${inst.instance_id}:`, err);
    }
  }

  console.log("[health-check] Instance health check complete");
}

// ============= STUCK SENDING_MATERIALS RECOVERY =============
// Recovers conversations where materials were sent but proximo_passo question never arrived
// (typically because EdgeRuntime.waitUntil background task timed out)
async function processStuckSendingMaterials({
  supabase,
  skipInstanceIds,
}: { supabase: SupabaseAdmin; skipInstanceIds?: Set<string> }): Promise<{ successCount: number; errors: string[] }> {
  const now = new Date();
  const threeMinutesAgo = new Date(now.getTime() - 3 * 60 * 1000).toISOString();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();

  console.log(`[follow-up-check] 🔄 Processing stuck sending_materials recovery...`);

  const { data: stuckConversations, error: convError } = await supabase
    .from('wapi_conversations')
    .select('id, remote_jid, instance_id, lead_id, bot_data, bot_step, contact_name, company_id')
    .eq('bot_enabled', true)
    .eq('bot_step', 'sending_materials')
    .not('remote_jid', 'like', '%@g.us%')
    .lt('last_message_at', threeMinutesAgo)   // At least 3 min stuck
    .gt('last_message_at', twoHoursAgo);       // Within 2h window

  if (convError) {
    console.error(`[follow-up-check] Error fetching stuck sending_materials:`, convError);
    return { successCount: 0, errors: [String(convError)] };
  }

  if (!stuckConversations || stuckConversations.length === 0) {
    console.log(`[follow-up-check] 🔄 No stuck sending_materials conversations found`);
    return { successCount: 0, errors: [] };
  }

  console.log(`[follow-up-check] 🔄 Found ${stuckConversations.length} conversations stuck at sending_materials`);

  let successCount = 0;
  const errors: string[] = [];

  for (const conv of stuckConversations) {
    if (skipInstanceIds?.has(String(conv.instance_id))) continue; // número da IA: bot fixo não retoma
    try {
      const phone = conv.remote_jid.replace('@s.whatsapp.net', '').replace('@c.us', '');

      // Get instance credentials
      const { data: instance } = await supabase
        .from('wapi_instances')
        .select('id, instance_id, instance_token, company_id, unit, provider, client_token')
        .eq('id', conv.instance_id)
        .single();

      if (!instance) {
        console.log(`[follow-up-check] 🔄 No instance found for conv ${conv.id}, skipping`);
        continue;
      }

      // Health gate
      const health = await checkInstanceHealth(supabase, instance.id, {
        allowRecentActivityBypass: true,
        recentActivityMinutes: 30,
      });
      if (!health.healthy) {
        console.log(`[follow-up-check] 🛡️ Sending_materials recovery BLOCKED for conv ${conv.id}: ${health.reason}`);
        continue;
      }

      // Get settings for next step question
      const { data: settings } = await supabase
        .from('wapi_bot_settings')
        .select('next_step_question, message_delay_seconds')
        .eq('instance_id', instance.id)
        .single();

      const RECOVERY_PROXIMO_PASSO = [
        { key: '1', label: '📅 Agendar visita' },
        { key: '2', label: '❓ Tirar dúvidas' },
        { key: '3', label: '🤔 Analisar com calma' },
      ];
      const menuText = RECOVERY_PROXIMO_PASSO.map(o => `${o.key}️⃣ - ${o.label}`).join('\n');
      const defaultQuestion = `E agora, como você gostaria de continuar? 🤔\n\nResponda com o *número*:\n\n${menuText}`;
      const nextStepQuestion = settings?.next_step_question || defaultQuestion;

      // Safe delay between sends
      if (successCount > 0) {
        await new Promise(r => setTimeout(r, 8000 + Math.random() * 7000));
      }

      // Send the proximo_passo question
      const sendRes = await providerSendText(instance, phone, nextStepQuestion, { delayTyping: 2 });
      const msgId = sendRes.messageId;

      if (msgId) {
        await supabase.from('wapi_messages').insert({
          conversation_id: conv.id,
          message_id: msgId,
          from_me: true,
          message_type: 'text',
          content: nextStepQuestion,
          status: 'sent',
          timestamp: new Date().toISOString(),
          company_id: instance.company_id,
          metadata: { source: 'sending_materials_recovery' },
        });
      }

      // Advance to proximo_passo
      await supabase.from('wapi_conversations').update({
        bot_step: 'proximo_passo',
        last_message_at: new Date().toISOString(),
        last_message_content: nextStepQuestion.substring(0, 100),
        last_message_from_me: true,
      }).eq('id', conv.id).eq('bot_step', 'sending_materials');

      // Add lead history
      if (conv.lead_id) {
        await supabase.from('lead_history').insert({
          lead_id: conv.lead_id,
          action: 'sending_materials_recovery',
          details: 'Pergunta próximo passo enviada via recovery (background task falhou)',
        });
      }

      console.log(`[follow-up-check] 🔄 Recovered sending_materials for conv ${conv.id} (${conv.contact_name || phone})`);
      successCount++;
    } catch (err) {
      console.error(`[follow-up-check] Error recovering sending_materials for conv ${conv.id}:`, err);
      errors.push(String(err));
    }
  }

  console.log(`[follow-up-check] 🔄 Sending_materials recovery complete: ${successCount} recovered`);
  return { successCount, errors };
}
