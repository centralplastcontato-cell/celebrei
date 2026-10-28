// ============= AGENTE DE IA CONVERSACIONAL (BETA) =============
// Atende conversas de UMA unidade configurada (ex: VENDAS 3), somente para
// leads/conversas novos (criados após a ativação). Conversa natural, envia
// materiais, agenda visitas e transfere para humano quando necessário.
// Regras duras: nunca fala preços, nunca promete, nunca inventa.
//
// Módulo autocontido: não importa nada de index.ts (evita import circular).

// deno-lint-ignore-file no-explicit-any
import { findLeadByPhone } from "../_shared/lead-phone.ts";
import { parseGuestCount, pickPackagePdfs } from "../_shared/package-pdf.ts";
import { DEFAULT_AI_MODEL, estimateChatCostUsd, NO_ANTHROPIC_KEY_MODEL, providerForModel } from "../_shared/ai-models.ts";
import { type ChatTurn, createLlmSession, type LlmStep, type ToolDef } from "./ai-llm.ts";
import { describeImage, fetchMediaBytes, mediaHistoryText, transcribeAudio } from "./ai-media.ts";
import {
  describeTeamHours,
  formatSlot,
  isOpenAt,
  isSlotInHours,
  listAvailableSlots,
  nearestSlots,
  nextOpeningText,
  normalizeTime,
  type ParsedHours,
  parseVisitHours,
  pickTwoOffers,
  visitSlotsByDay,
  type Slot,
  slotKey,
  teamHoursText,
} from "../_shared/business-hours.ts";
import { allowedMoneyValues, formatBRL, holidayName, isHolidayEveYmd, isHolidayYmd, localHolidaysFrom, moneyValuesIn, type PackageQuote, type PartyDay, quotePackages, weekdayYmd } from "../_shared/package-pricing.ts";
import { addDaysYmd, type FreeDay, type FreeSlot, freePartySlots, monthFromText, monthRange, parsePartySlots, pickPartyDates, weekdayOf } from "../_shared/party-availability.ts";
import { waitForMediaAck } from "../_shared/media-ack.ts";
import { airyParagraphs, spaceHighlightList, fixWeekdays, hoursForWhatsApp, markTodayTomorrow, moneyWithCents, weekdayMismatches, formatBRLShort, formatDateLong, formatDayHeader, formatSlotLabel, formatSlotRange, packageEmoji, prettyPackageName, venueEmoji } from "../_shared/whatsapp-format.ts";
import { guardAiDb } from "./ai-db-guard.ts";
import { loadAiConversationalEnabled } from "../_shared/ai-module.ts";
import { aiUnitFor, aiUnits } from "../_shared/ai-units.ts";
import { inSandbox, sandboxSleep } from "./ai-sandbox.ts";
import { buildCandidateLink, candidateName, inviteCode, shortCandidateLink, withCandidateLink } from "../_shared/ai-candidate.ts";
import { findPromotion, promoMentions, promoNote } from "../_shared/promo.ts";
import { campaignPromptNote, loadCampaignContext } from "../_shared/campaign-context.ts";
import { closedPeriodAt, closedPeriodsNote, formatClosedPeriod, isClosedDay, parseClosedPeriods } from "../_shared/closed-periods.ts";
import { dayWithArticle, nearestAlternativeDays, partyDateFreeNote, partyDateTakenMessage } from "../_shared/party-date-check.ts";
import { parseSlotPriority, priorityAlternatives, priorityMonthDates } from "../_shared/slot-priority.ts";
import { birthdayFlavored, corporateCaptions, corporateLeadNote, corporatePromptBlock, mentionsCorporate } from "../_shared/corporate-event.ts";
import { AI_INBOUND_LAG_MS, asksPartnership, clientAffirms, clientAskedPrice, PRICE_ASK_WINDOW_MS, askPartyDayAfterMaterials, closingAfterMaterials, needsPartyDay, visitInviteAfterMaterials, confirmsPartyInterest, contactIntent, clientAsksVisit, clientDeclined, crossedWithLastReply, dayPreferenceFrom, debounceMsFor, dropMaterialsBreak, mergeConsecutiveTurns, pickLatestIncoming, priceRequestPending, repliesSinceVisitInvite, smallestPackageGuests, splitAroundMaterials, stripVisitInvite, teamRepliedAfter } from "../_shared/ai-turn.ts";
import { firstNameOrEmpty, sendQualificationMaterials } from "./qualification-materials.ts";
import { askedForName, nameFromAnswer } from "../_shared/name-answer.ts";
import { falseMaterialClaims, hasMaterialClaim, hasSubstance, refersToMaterial, stripFalseMaterialClaims } from "../_shared/material-claims.ts";
import { enforceHouseRules, houseRuleNote, houseRuleViolatingSentences, houseRuleViolations, parseHouseRules, topicsAsked, TOPIC_ASK } from "../_shared/house-rules.ts";
import { resumeNote } from "../_shared/ai-resume.ts";

type Json = Record<string, unknown>;

interface AgentInstance {
  id: string;
  instance_id: string;
  instance_token: string;
  unit: string | null;
  company_id: string;
  provider?: string | null;
}

interface AgentConv {
  id: string;
  remote_jid: string;
  bot_enabled: boolean | null;
  bot_step: string | null;
  bot_data: Json | null;
  lead_id: string | null;
  created_at?: string | null;
  // Marcado quando a IA passou a conversa para a equipe no turno atual
  __handoffThisTurn?: boolean;
  // Valores (R$) que a consulta da tabela devolveu neste turno — a IA só pode citar estes
  __quotedValues?: number[];
  // Fotos/vídeo/PDF ficam para DEPOIS da resposta deste turno (a IA cumprimenta antes)
  __deferMaterials?: boolean;
  // Resposta ainda não confirma que é sobre a festa: materiais seguram neste turno
  __holdMaterials?: boolean;
  // 1ª resposta da IA: se os materiais forem liberados, vão DEPOIS da apresentação
  __firstReply?: boolean;
  // Quer trabalhar: link do cadastro de candidatos que o sistema põe no fim da resposta
  __candidateLink?: string;
  // Data da festa pedida conferida na agenda neste turno (para a mensagem depois do PDF)
  __partyDate?: PartyDateCheck | null;
  // Buffet atende confraternização de empresas (roteiro próprio)
  __corporateEnabled?: boolean;
}

interface AiSettings {
  enabled: boolean;
  unit: string | null;
  activated_at: string | null;
  extra_instructions: string | null;
  visit_hours: string;
  model: string;
  // Modo de Teste da própria IA — separado do Modo de Teste do bot fixo
  // (wapi_bot_settings). Deixa testar só a IA, com um número específico,
  // sem desligar o bot fixo para os clientes de verdade.
  test_mode_enabled: boolean;
  test_mode_number: string | null;
  // Modelo só para o número de teste (vazio = o mesmo dos clientes). Deixa
  // comparar um modelo novo sem trocar o que os clientes estão usando.
  test_model?: string | null;
  // Horário de atendimento da equipe (mesmo formato de visit_hours, sem o
  // intervalo). Vazio = usa o horário de visitas.
  team_hours?: string | null;
  party_slots?: string | null;
  // Ordem de venda dos horários (do que mais vende ao que menos vende): com
  // ela, as alternativas começam pelos horários que menos vendem
  slot_priority?: unknown;
  // Alerta forte quando a equipe não responde depois da passagem
  handoff_alert_minutes?: number | null;
  handoff_alert_phone?: string | null;
  // Recesso / dias fechados: [{ start, end }] (sem festas, visitas e equipe)
  closed_periods?: unknown;
  // Apresentação: nome da assistente e a arte dela (vai na 1ª mensagem)
  assistant_name?: string | null;
  intro_image_url?: string | null;
  // Confraternização de empresas: roteiro próprio (sem aniversariante) e capacidade do espaço
  corporate_events_enabled?: boolean | null;
  corporate_max_guests?: number | null;
}

// Áudio ou foto que o cliente acabou de mandar (a mensagem já está salva)
export interface AgentMedia {
  type: 'audio' | 'image';
  messageId: string;
  url: Promise<string | null>;
}

const AI_STEP = 'ai_agent';

/** "Como posso te ajudar?": as opções uma por linha, cada uma com um emoji (fica mais bonito que tudo numa frase) */
const helpOptionsFormat = (corporate = false) => `Mostre as opções em linhas separadas, uma por linha, cada uma começando com um emoji (sem números e sem hífen), depois de uma linha em branco, e NÃO repita a pergunta depois da lista. Exemplo:\n"Me conta, como posso te ajudar? 😊\n\n🎈 Orçamento para uma festa\n${corporate ? '🏢 Confraternização de empresa\n' : ''}📅 Já tenho festa marcada\n💬 Outro assunto"`;

// Arte de apresentação da Bia (só link https do nosso storage ou outro https)
function introImageUrl(settings: AiSettings): string | null {
  const url = String(settings.intro_image_url || '').trim();
  return /^https:\/\/\S+$/.test(url) && url.length <= 1000 ? url : null;
}
const MAX_HISTORY_MESSAGES = 30;
const MAX_TOOL_ROUNDS = 4;

function getPhoneVariantsBR(phone: string): string[] {
  const clean = phone.replace(/\D/g, '');
  const variants = new Set<string>([clean]);
  const without55 = clean.startsWith('55') ? clean.slice(2) : clean;
  const with55 = clean.startsWith('55') ? clean : `55${clean}`;
  variants.add(without55);
  variants.add(with55);
  // Variantes com/sem o nono dígito (DDD + 9XXXXXXXX vs DDD + XXXXXXXX)
  if (without55.length === 11 && without55[2] === '9') {
    const short = without55.slice(0, 2) + without55.slice(3);
    variants.add(short);
    variants.add(`55${short}`);
  } else if (without55.length === 10) {
    const long = without55.slice(0, 2) + '9' + without55.slice(2);
    variants.add(long);
    variants.add(`55${long}`);
  }
  return Array.from(variants);
}

// Envia pelo wapi-send e marca a mensagem como da IA (metadata.source =
// "ai_agent"): é assim que dá para separar resposta da IA de resposta de uma
// pessoa da equipe depois da passagem.
async function sendViaWapiSend(
  supabase: any,
  action: 'send-text' | 'send-image' | 'send-video' | 'send-document',
  instance: AgentInstance,
  conv: AgentConv,
  payload: { message?: string; mediaUrl?: string; caption?: string; fileName?: string; delayTyping?: number },
): Promise<boolean> {
  return (await sendViaWapiSendId(supabase, action, instance, conv, payload)) !== null;
}

// Igual, devolvendo o id da mensagem ('' quando o provedor não devolve id;
// null = falhou). O id serve para esperar a confirmação do WhatsApp.
async function sendViaWapiSendId(
  supabase: any,
  action: 'send-text' | 'send-image' | 'send-video' | 'send-document',
  instance: AgentInstance,
  conv: AgentConv,
  payload: { message?: string; mediaUrl?: string; caption?: string; fileName?: string; delayTyping?: number },
): Promise<string | null> {
  // Simulador: nada sai pelo WhatsApp
  const sandbox = inSandbox();
  if (sandbox) return sandbox.send(action, conv.id, payload);
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) return null;

  const phone = conv.remote_jid.replace('@s.whatsapp.net', '').replace('@c.us', '').replace(/\D/g, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), action === 'send-video' ? 60000 : 30000);
  try {
    const body: Json = {
      action,
      phone,
      instanceId: instance.instance_id,
      instanceToken: instance.instance_token,
      conversationId: conv.id,
      companyId: instance.company_id,
      source: 'bot',
      automation: true,
      messageSource: 'ai_agent',
      ...payload,
    };
    const response = await fetch(`${supabaseUrl}/functions/v1/wapi-send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(`[AI Agent] ${action} failed (${response.status}): ${await response.text()}`);
      return null;
    }
    const parsed = await response.json().catch(() => null) as Json | null;
    if (parsed?.success === false || parsed?.error) {
      console.error(`[AI Agent] ${action} returned error:`, parsed);
      return null;
    }
    const messageId = typeof parsed?.messageId === 'string' ? parsed.messageId : null;
    if (messageId && supabase) {
      // Junta com a metadata gravada pelo wapi-send (a da mídia guarda o que
      // é preciso para conferir/reenviar)
      const { data: row } = await supabase.from('wapi_messages').select('id, metadata')
        .eq('conversation_id', conv.id).eq('message_id', messageId).maybeSingle();
      if (row?.id) {
        const { error } = await supabase.from('wapi_messages')
          .update({ metadata: { ...((row.metadata as Json) || {}), source: 'ai_agent' } })
          .eq('id', row.id);
        if (error) console.error('[AI Agent] Erro ao marcar mensagem da IA:', error.message);
      }
    }
    return messageId ?? '';
  } catch (err) {
    console.error(`[AI Agent] ${action} threw:`, err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// select('*'): colunas novas entram sem quebrar quando a migration ainda não rodou
async function loadSettings(supabase: any, companyId: string): Promise<AiSettings | null> {
  const { data } = await supabase
    .from('ai_agent_settings')
    .select('*')
    .eq('company_id', companyId)
    .maybeSingle();
  return (data as AiSettings) || null;
}

// Número de teste da IA (Modo de Teste ligado e o telefone bate)
function isAiTestNumber(settings: AiSettings, phone: string): boolean {
  // O número de teste vale mesmo com o "só esse número" desligado: o dono
  // continua testando (#reiniciar) depois de liberar a IA para todos
  if (!(settings.test_mode_number || '').replace(/\D/g, '')) return false;
  const testVariants = getPhoneVariantsBR(settings.test_mode_number || '');
  return getPhoneVariantsBR(phone).some(v => testVariants.includes(v));
}

// Para o webhook: a mensagem veio do número de teste da IA desta unidade? Ele
// é o celular do dono testando — não passa pela trava anti-loop (mandar
// "#reiniciar" ou perguntas repetidas é normal no teste).
export async function isAiTestPhoneFor(supabase: any, instance: AgentInstance, phone: string): Promise<boolean> {
  if (!instance.company_id || !instance.unit) return false;
  const settings = await loadSettings(supabase, instance.company_id);
  if (!settings?.enabled) return false;
  if (!aiUnitFor(settings, instance.unit)) return false;
  if (!(await loadAiConversationalEnabled(supabase, instance.company_id))) return false;
  return isAiTestNumber(settings, phone);
}

/**
 * A IA pode atender a resposta de uma campanha neste número? (IA e módulo
 * ligados para a unidade; com o Modo de Teste, só o número de teste.)
 */
export async function campaignAiReady(supabase: any, instance: AgentInstance, phone: string): Promise<boolean> {
  if (!instance.company_id || !instance.unit) return false;
  const settings = await loadSettings(supabase, instance.company_id);
  if (!settings?.enabled || !aiUnitFor(settings, instance.unit)) return false;
  if (settings.test_mode_enabled && !isAiTestNumber(settings, phone)) return false;
  return loadAiConversationalEnabled(supabase, instance.company_id);
}

const teamHoursOf = (settings: AiSettings): ParsedHours =>
  parseVisitHours(teamHoursText(settings.team_hours));

// Visitas já marcadas (um horário = uma visita). Todos os números da empresa
// atendem o mesmo espaço: a visita marcada por qualquer número ocupa o horário.
// excludeLeadId: a visita do próprio cliente nunca conta como conflito para ele
async function loadBookedSlots(supabase: any, instance: AgentInstance, excludeLeadId?: string | null): Promise<Set<string>> {
  const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  const { data } = await supabase
    .from('lead_visits')
    .select('data_visita, horario_visita, status_visita, unit, lead_id')
    .eq('company_id', instance.company_id)
    .gte('data_visita', today)
    .in('status_visita', ['agendada', 'confirmada', 'remarcada'])
    .limit(1000);
  const booked = new Set<string>();
  for (const v of (data || []) as Array<{ data_visita: string; horario_visita: string | null; unit: string | null; lead_id?: string | null }>) {
    if (excludeLeadId && v.lead_id === excludeLeadId) continue;
    const t = normalizeTime(v.horario_visita || '');
    if (t) booked.add(slotKey({ date: String(v.data_visita).slice(0, 10), time: t }));
  }
  return booked;
}

// Próxima visita ativa deste lead (agendada/confirmada/remarcada, de hoje em diante)
async function loadLeadVisit(supabase: any, leadId: string | null): Promise<{ id: string; data_visita: string; horario_visita: string } | null> {
  if (!leadId) return null;
  const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  const { data } = await supabase
    .from('lead_visits')
    .select('id, data_visita, horario_visita')
    .eq('lead_id', leadId)
    .gte('data_visita', today)
    .in('status_visita', ['agendada', 'confirmada', 'remarcada'])
    .order('data_visita', { ascending: true })
    .limit(1);
  const v = (data || [])[0];
  return v ? { id: v.id, data_visita: String(v.data_visita).slice(0, 10), horario_visita: normalizeTime(v.horario_visita || '') || String(v.horario_visita || '') } : null;
}

const visitText = (date: string, time: string) => `${formatDateLong(date)}, às ${time.endsWith(':00') ? `${Number(time.slice(0, 2))}h` : time.replace(':', 'h')}`;

// Texto com o horário da equipe para o cliente, dizendo quando volta se estiver fechado
const ymdBR = (ms: number) => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);
// Recesso em andamento (hoje está dentro de um período fechado)
// Equipe atendendo agora: dentro do horário. O recesso fecha festas e visitas,
// mas a equipe continua atendendo (pedido do buffet)
const teamOpenNow = (settings: AiSettings, nowMs = Date.now()) => isOpenAt(teamHoursOf(settings), nowMs);
// Quando a equipe volta ("amanhã às 9h")
const teamReturnText = (settings: AiSettings, nowMs = Date.now()) => hoursForWhatsApp(nextOpeningText(teamHoursOf(settings), nowMs));

// Horário da equipe para o cliente, com "9h às 18h" (sem "09:00", que o WhatsApp sublinha)
function teamHoursMessage(settings: AiSettings, nowMs = Date.now()): string {
  return hoursForWhatsApp(teamHoursRaw(settings, nowMs));
}

function teamHoursRaw(settings: AiSettings, nowMs: number): string {
  const hours = teamHoursOf(settings);
  const text = describeTeamHours(hours);
  if (isOpenAt(hours, nowMs)) return `Nossa equipe atende ${text}.`;
  return `Nossa equipe atende ${text} — volta ${nextOpeningText(hours, nowMs)}.`;
}

type MaterialTipo = 'fotos' | 'video' | 'pacotes';
const MATERIAL_LABEL: Record<MaterialTipo, string> = { fotos: 'fotos do espaço', video: 'vídeo de apresentação', pacotes: 'PDF de pacotes' };

// Quanto a IA espera o WhatsApp confirmar fotos/vídeo/PDF antes de responder
const AI_MEDIA_ACK_WAIT_MS = 40000;
const MATERIAL_OF_ACTION: Record<string, MaterialTipo> = { 'send-image': 'fotos', 'send-video': 'video', 'send-document': 'pacotes' };

// Espera a confirmação do WhatsApp; um tipo só conta como enviado se todas as
// mídias dele confirmaram. Id vazio = provedor sem rastreio (conta como enviado).
async function confirmMaterials(
  supabase: any,
  sent: Array<{ tipo: MaterialTipo; id: string }>,
): Promise<{ confirmed: MaterialTipo[]; unconfirmed: MaterialTipo[] }> {
  const tracked = sent.filter((s) => s.id);
  const ack = tracked.length > 0
    ? await waitForMediaAck(supabase, tracked.map((s) => s.id), AI_MEDIA_ACK_WAIT_MS)
    : { confirmed: [] as string[], failed: [] as string[], pending: [] as string[] };
  const tipos = Array.from(new Set(sent.map((s) => s.tipo)));
  const unconfirmed = tipos.filter((t) => sent.some((s) => s.tipo === t && s.id && !ack.confirmed.includes(s.id)));
  if (unconfirmed.length > 0) {
    console.warn(`[AI Agent] WhatsApp não confirmou em ${AI_MEDIA_ACK_WAIT_MS / 1000}s: ${unconfirmed.join(', ')} (o follow-up-check reenvia/marca erro)`);
  }
  return { confirmed: tipos.filter((t) => !unconfirmed.includes(t)), unconfirmed };
}

function unconfirmedNote(unconfirmed: MaterialTipo[], confirmed: MaterialTipo[]): string {
  if (unconfirmed.length === 0) return '';
  const pend = unconfirmed.map((t) => MATERIAL_LABEL[t]).join(', ');
  const ok = confirmed.map((t) => MATERIAL_LABEL[t]).join(', ');
  return ` ATENÇÃO: o WhatsApp ainda NÃO confirmou a entrega de: ${pend}. NÃO diga que mandou ${unconfirmed.length > 1 ? 'esses materiais' : 'esse material'}${ok ? ` — fale só do que foi confirmado (${ok})` : ' — não diga que mandou material nenhum'}. Se o cliente perguntar, diga que está enviando e que a equipe confere.`;
}

// Material conta como "já enviado" só por 30 dias: lead que volta depois disso
// recebe o material (atualizado) de novo.
const MATERIAL_RESEND_DAYS = 30;
const materialWindowStart = () => new Date(Date.now() - MATERIAL_RESEND_DAYS * 86400000).toISOString();
// Depois de #reiniciar (número de teste) só conta o que foi enviado desde então
const materialSince = (conv: AgentConv) => {
  const since = (conv.bot_data as Json | null)?.ai_history_since;
  const windowStart = materialWindowStart();
  return typeof since === 'string' && since > windowStart ? since : windowStart;
};
const isWithinMaterialWindow = (iso: unknown) =>
  typeof iso === 'string' && Date.parse(iso) >= Date.now() - MATERIAL_RESEND_DAYS * 86400000;

function sentMaterials(conv: AgentConv): Partial<Record<MaterialTipo, string>> {
  const raw = (conv.bot_data as Json | null)?.ai_materials_sent;
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<MaterialTipo, string>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isWithinMaterialWindow(v)) out[k as MaterialTipo] = v as string;
  }
  return out;
}

const fmtTimeBR = (iso: string) => new Date(iso).toLocaleString('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

async function mergeBotData(supabase: any, conv: AgentConv, patch: Json): Promise<void> {
  const { data: fresh } = await supabase.from('wapi_conversations').select('bot_data').eq('id', conv.id).maybeSingle();
  const merged = { ...((fresh?.bot_data as Json) || conv.bot_data || {}), ...patch } as Json;
  await supabase.from('wapi_conversations').update({ bot_data: merged }).eq('id', conv.id);
  conv.bot_data = merged;
}

interface UsageLog {
  companyId: string;
  conversationId: string;
  leadId: string | null;
  model: string;
  kind: 'chat' | 'transcription' | 'vision';
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
  isTest: boolean;
}

// Uma linha por chamada paga (resposta, transcrição ou foto). Falha ao gravar
// o consumo nunca atrapalha a conversa.
async function logUsage(supabase: any, u: UsageLog): Promise<void> {
  const { error } = await supabase.from('ai_agent_usage').insert({
    company_id: u.companyId,
    conversation_id: u.conversationId,
    lead_id: u.leadId,
    provider: providerForModel(u.model),
    model: u.model,
    kind: u.kind,
    input_tokens: u.inputTokens,
    cached_input_tokens: u.cachedInputTokens,
    cache_write_tokens: u.cacheWriteTokens,
    output_tokens: u.outputTokens,
    cost_usd: u.costUsd,
    is_test: u.isTest,
  });
  if (error) console.error('[AI Agent] Erro ao gravar consumo:', error.message);
}

async function notifyTeam(
  supabase: any,
  instance: AgentInstance,
  payload: { title: string; message: string; data: Json; type?: string },
): Promise<void> {
  try {
    const unitLower = (instance.unit || '').toLowerCase().trim().replace(/\s+/g, '-');
    let ids: string[] = [];
    const { data, error } = await supabase.rpc('get_company_notification_targets', {
      p_company_id: instance.company_id,
      p_unit_permission: `leads.unit.${unitLower}`,
    });
    if (error) console.error('[AI Agent] Erro ao buscar quem avisar:', error.message);
    else ids = ((data || []) as Array<{ user_id: string }>).map((r) => r.user_id);
    if (ids.length === 0) {
      // Ninguém com permissão específica: avisa todos da empresa (nunca em silêncio)
      const { data: companyUsers } = await supabase
        .from('user_companies')
        .select('user_id')
        .eq('company_id', instance.company_id);
      ids = ((companyUsers || []) as Array<{ user_id: string }>).map((u) => u.user_id);
    }
    if (ids.length === 0) {
      console.error(`[AI Agent] Nenhum usuário para avisar na empresa ${instance.company_id}`);
      return;
    }
    const { error: insErr } = await supabase.from('notifications').insert(ids.map((uid) => ({
      user_id: uid,
      company_id: instance.company_id,
      type: payload.type || 'lead_needs_human',
      title: payload.title,
      message: payload.message,
      data: payload.data,
      read: false,
    })));
    if (insErr) console.error('[AI Agent] Erro ao criar aviso:', insErr.message);
    else console.log(`[AI Agent] Aviso no sininho criado para ${ids.length} usuário(s)`);
  } catch (err) {
    console.error('[AI Agent] Erro ao avisar a equipe:', err);
  }
}

// Lead de empresa (confraternização): marca no lead para a equipe filtrar e
// avisa a equipe uma vez — o ticket é maior e vale um contato rápido
async function markCorporateLead(supabase: any, instance: AgentInstance, conv: AgentConv, leadId: string | null, phone: string): Promise<void> {
  if (leadId) {
    const { error } = await supabase.from('campaign_leads').update({ lead_kind: 'empresa' }).eq('id', leadId);
    if (error) console.error('[AI Agent] Erro ao marcar lead de empresa:', error.message);
  }
  const bd = (conv.bot_data || {}) as Json;
  if (bd.empresa_avisada) return;
  await mergeBotData(supabase, conv, { empresa_avisada: new Date().toISOString() });
  const who = firstNameOrEmpty(bd.nome as string) || 'Cliente';
  await notifyTeam(supabase, instance, {
    title: `🏢 ${who}${bd.empresa ? ` (${bd.empresa})` : ''} quer orçamento de confraternização`,
    message: `Lead de empresa${bd.convidados ? ` · ${bd.convidados}` : ''}${bd.mes ? ` · ${bd.mes}` : ''}. A IA segue o atendimento — vale um contato rápido da equipe.`,
    data: { reason: 'company_lead', conversation_id: conv.id, contact_phone: phone, lead_id: leadId },
  });
}

// Decide (uma única vez por conversa) se a IA pode assumir. O resultado fica
// gravado em bot_data.ai_agent ('on'/'off') para não reavaliar a cada mensagem.
/**
 * A IA assume a conversa? Regra (pedido do dono): no número com a IA ligada,
 * ONDE O BOT FIXO RESPONDERIA, QUEM RESPONDE É A IA — conversa nova, cliente
 * antigo voltando, bot fixo no meio da qualificação ou lead do site. Onde o
 * bot fixo já não responderia (a equipe assumiu ou desligou o bot naquela
 * conversa), a IA também fica de fora: quem conversa é a equipe.
 * "on" é definitivo; antes havia "off" definitivo (regras antigas de "só leads
 * novos") — agora é reavaliado a cada mensagem.
 */
async function isEligible(
  supabase: any,
  _settings: AiSettings,
  conv: AgentConv,
  _phone: string,
  _companyId: string,
): Promise<boolean> {
  const botData = (conv.bot_data || {}) as Json;
  if (botData.ai_agent === 'on') return true;

  // Mesma regra do bot fixo: bot desligado na conversa (fora o lead do site
  // aguardando resposta) = a equipe está com ela
  const botWouldReply = conv.bot_step === 'lp_sent' || (conv.bot_enabled !== false && conv.bot_step !== 'human_takeover');
  if (!botWouldReply) {
    console.log(`[AI Agent] Conversa ${conv.id} com a equipe (bot desligado, passo "${conv.bot_step}") — IA não entra`);
    return false;
  }

  console.log(`[AI Agent] Conversa ${conv.id}: a IA assume (passo anterior "${conv.bot_step ?? 'novo'}")`);
  const newBotData = { ...(conv.bot_data || {}), ai_agent: 'on' } as Json;
  await supabase.from('wapi_conversations').update({ bot_data: newBotData }).eq('id', conv.id);
  conv.bot_data = newBotData;
  return true;
}

/**
 * Número em que só a IA conversa: IA ligada para ele e o "Só esse número fala
 * com a IA" desligado. Nesses números o bot fixo nunca responde nem manda os
 * lembretes dele (com o modo de teste ligado, o bot fixo segue com os outros
 * clientes, como antes).
 */
export async function isAiOnlyInstance(supabase: any, instance: AgentInstance): Promise<boolean> {
  if (!instance.company_id || !instance.unit) return false;
  const settings = await loadSettings(supabase, instance.company_id);
  if (!settings?.enabled || settings.test_mode_enabled) return false;
  if (!aiUnitFor(settings, instance.unit)) return false;
  return loadAiConversationalEnabled(supabase, instance.company_id);
}

interface PromptContext {
  // "Retomar com a IA agora": como continuar a conversa interrompida
  resumeNote?: string | null;
  offers: Slot[];
  sentMaterialsText: string;
  teamHoursText: string;
  knownDataText: string;
  isFirstReply: boolean;
  pendingUserMessages: number;
  afterHoursHandoff: { reason: string; returns: string } | null;
  // Quer trabalhar e já recebeu o link do cadastro: a IA só agradece, despede-se e tira dúvida do cadastro
  candidateLinkSent: string | null;
  // Respostas da IA desde o último convite para visita (null = ainda não convidou)
  visitRepliesAgo: number | null;
  // O cliente só confirmou ("ok", "ótimo", "gostei"): hora de conduzir para o próximo passo
  clientAffirmed: boolean;
  minPackageGuests: number | null;
  packagesText: string | null; // o que cada pacote inclui (Operações → Pacotes)
  pricePending: boolean; // cliente pediu o valor e ainda não recebeu
  crossedMessage: boolean; // a mensagem do cliente cruzou com a última resposta da IA
  visitText: string | null; // visita já marcada deste cliente
  visitConfirmPending?: boolean; // perguntamos se ele confirma a visita e ainda não respondeu
  visitSlotsText: string; // horários de visita livres dos próximos dias
  weekdayNote: string | null; // cliente escreveu dia da semana que não bate com a data
  houseNote: string | null; // cliente perguntou de regra do cadastro (comida de fora, animal)
  singleVenue: boolean; // buffet com um único espaço físico (sem outra unidade/filial)
  recessNote: string | null; // recesso / dias fechados (Configurar IA)
  materialsNote: string | null; // fotos/vídeo/PDF saem logo depois da resposta deste turno
  promoNote: string | null; // promoção vigente do cadastro: quando e como oferecer
  campaignNote?: string | null; // campanha que o cliente recebeu há poucos dias (ele está respondendo a ela)
  intentNote: string | null; // contato que talvez não queira orçamento (trabalho, fornecedor, cliente com festa)
  corporateNote?: string | null; // contato é (ou parece ser) uma empresa — confraternização
}

// Convidar para a visita no máximo a cada 3–4 respostas, ou quando fizer sentido
function visitInviteRule(repliesAgo: number | null, clientAffirmed = false): string {
  // "Ok" logo depois do convite: ele provavelmente aceitou — fecha o horário
  if (clientAffirmed && repliesAgo === 0) {
    return 'O cliente respondeu "ok"/"ótimo" logo depois do seu convite para visita: ele provavelmente aceitou. Confirme qual dos 2 horários que você ofereceu ele prefere (repita os dois) — ou, se ele já escolheu, agende. Não mude de assunto.';
  }
  // "Ok", "ótimo", "gostei" depois de valores/fotos: é a hora de conduzir, não de travar
  if (clientAffirmed) {
    return 'O cliente só confirmou ("ok", "ótimo", "gostei"). Conduza para o PRÓXIMO PASSO CONCRETO: se ele ainda não marcou visita, convide para conhecer o espaço oferecendo 2 horários concretos; se ele já disse que não quer visita, pergunte se quer que a equipe garanta a data dele. Nunca responda só com "o que você quer ver agora?" ou uma lista de opções.';
  }
  if (repliesAgo !== null && repliesAgo < 3) {
    const when = repliesAgo === 0 ? 'na sua última resposta' : `há ${repliesAgo} resposta(s)`;
    return `Você já convidou para a visita ${when}. NESTA resposta NÃO convide de novo e não termine com "posso agendar uma visita" — só responda o que o cliente perguntou. Exceção: só se o próprio cliente falar de visita ou pedir para conhecer o espaço. (Se você convidar fora de hora, o convite é cortado da mensagem.)`;
  }
  return 'Pode convidar para a visita nesta resposta SE fizer sentido (o cliente mostrou interesse, perguntou de valores/fechamento, acabou de receber os materiais ou disse que vai pensar). Não termine toda mensagem com convite.';
}

// As instruções vão em duas partes (28/10): "stable" é igual para todas as
// conversas do buffet (regras + informações do buffet) e fica no cache do
// provedor — a releitura sai ~10x mais barata; "dynamic" é o que muda a cada
// conversa/mensagem (data de hoje, dados do cliente, avisos do momento) e vem
// DEPOIS. Antes tudo era um texto só, com partes da conversa no começo: o
// cache era regravado a cada resposta e quase nunca reaproveitado.
interface SystemPromptParts {
  stable: string;
  dynamic: string;
}

function buildSystemPrompt(companyName: string, unit: string, settings: AiSettings, today: string, ctx: PromptContext): SystemPromptParts {
  const offersText = ctx.offers.length > 0
    ? ctx.offers.map(formatSlot).join(' ou ')
    : 'nenhum horário livre nos próximos dias — nesse caso transfira para a equipe';
  const assistantName = String(settings.assistant_name || '').trim();
  const stable = `Você é ${assistantName ? `a ${assistantName}, ` : ''}a assistente virtual de vendas do ${companyName} (buffet infantil), atendendo por um dos WhatsApps de atendimento ("${unit}" é só o nome interno deste número: nunca cite ao cliente nem chame de unidade). A data de hoje e o que já se sabe desta conversa estão em SITUAÇÃO DESTA CONVERSA, no fim destas instruções — leia sempre.${assistantName ? ` SEU NOME é ${assistantName} (definido nas configurações): use sempre este nome, mesmo que as informações do buffet ou mensagens antigas da conversa citem outro.` : ''}

${ctx.singleVenue ? `ESPAÇO ÚNICO: o ${companyName} tem UM único espaço (o endereço das informações do buffet). NÃO existe outra unidade ou filial. Se o cliente perguntar de outra unidade ("unidade 1", outro endereço, qual fica mais perto), responda com naturalidade que hoje o ${companyName} fica só nesse endereço e siga a conversa. Nunca diga "esta unidade", nunca dê a entender que existe outra e não passe para a equipe por isso.\n\n` : ''}MENSAGENS DA EQUIPE: no histórico, o que começa com "[Equipe]" foi escrito por uma pessoa da equipe, não por você. Respeite o que ela combinou (valores, condições, horários, visitas): não contradiga nem repita; se o cliente pedir algo além do que ela combinou, passe para a equipe. Nunca escreva "[Equipe]" nas suas respostas.

SEU OBJETIVO PRINCIPAL: conduzir a conversa de forma simpática e natural até AGENDAR UMA VISITA ao buffet. A visita é o passo que mais fecha festas.

COMO CONVERSAR:
- Português brasileiro, tom caloroso, animado e humano, mensagens CURTAS (2 a 4 frases; a de valores pode ter um bloco curto por pacote).
- Use 3 a 4 emojis por mensagem, variados e combinando com o assunto (🎉 🥳 🎈 🎊 😍 ✨ 🎂 💜…), de preferência no fim das frases, sem repetir sempre os mesmos. Se as informações do buffet trouxerem instruções de estilo/personalidade, elas valem mais do que esta.
- FORMATO LEVE NO WHATSAPP: nunca um bloco de texto corrido. No máximo 2 frases curtas por parágrafo, com uma linha em branco entre os parágrafos, e a pergunta final sozinha no último parágrafo. Formato:
  "Claro! 😊 [resposta direta, numa frase] 🍝

  [um detalhe ou benefício, numa frase] ✨

  [uma pergunta simples para seguir] 😍"
- Termine com UMA pergunta direta, que diga a que se refere ("Qual horário fica melhor para a visita: quinta às 15h ou sábado às 10h?", nunca só "Qual horário fica melhor?"). Nada de "posso seguir de duas formas", de oferecer opções em sequência nem de "o que você quer ver agora?".
- Você conduz a conversa: quando o cliente responde só "ok", "ótimo" ou "gostei", entenda a que ele está respondendo e dê o próximo passo (data → valores → visita → garantir a data com a equipe).
- Se o cliente perguntar um detalhe que não está nas informações do buffet: responda o que você sabe e diga com leveza que a equipe explica certinho (ou que ele vê de perto na visita). Não se justifique ("prefiro não te passar nada errado", "os detalhes podem variar") — soa robótico.
- Primeira resposta, nome do cliente e dados já registrados: veja SITUAÇÃO DESTA CONVERSA. Não pergunte de novo o que já sabe.
- Se o cliente mandar várias perguntas, responda todas numa única mensagem.
- Uma pergunta por vez, e UMA mensagem por vez: depois de perguntar, espere a resposta antes de perguntar outra coisa. Nunca envie listas de opções numeradas — converse como gente (a única lista é a de "como posso te ajudar", no formato de QUEM É O CONTATO).
- Nunca use a palavra "sistema" com o cliente (nada de "o sistema já te envia"): fale em primeira pessoa ("já te mando as fotos").
- Descubra naturalmente: nome da pessoa, mês/data desejada da festa e número de convidados, se ainda não souber — mas só depois de saber que a pessoa quer orçamento (veja QUEM É O CONTATO).

QUEM É O CONTATO (nem todo mundo quer orçamento):
- Se a pessoa só cumprimentou ("oi", "bom dia") ou mandou algo solto (uma foto, "quem é?"), não suponha que é orçamento: cumprimente e pergunte como pode ajudar — se é orçamento de festa, se ela já tem festa com a gente ou se é outro assunto. ${helpOptionsFormat(settings.corporate_events_enabled === true)} (Na primeira resposta, se ainda não souber o nome, pergunte só o nome e deixe esta lista para a resposta seguinte.)
- Depois da lista de "como posso te ajudar", se a pessoa responder com um tipo de festa ("aniversário", "festa", "festa infantil", "15 anos", "orçamento"), ISSO JÁ É ORÇAMENTO: não pergunte de novo se é orçamento ou festa marcada — comemore e siga direto para o próximo passo (mês/data e número de convidados). Só trate como festa marcada se ela disser que já tem festa/contrato com a gente.
- Se não estiver claro o que a pessoa quer, pergunte com gentileza qual é a dúvida — e, se ela disser que "tem uma festa" sem deixar claro, se a festa já está marcada com a gente ou se ela está procurando orçamento — ANTES de falar de pacotes, mês ou convidados.
- Pediu para NÃO RECEBER MAIS MENSAGENS ("sair da lista", "não quero mais receber", "para de me mandar"): responda UMA mensagem curta e gentil, chamando pelo nome se souber, dizendo que entendeu e que a equipe já foi avisada para tirar o número da lista (ex.: "Tudo bem, [nome]! Já avisei a equipe para não te mandarmos mais mensagens 😊 Se um dia precisar, é só chamar."). Não ofereça nada, não convide para visita, não faça pergunta e não chame ferramentas.
- Já tem festa marcada/contrato com a gente (festa que ainda vai acontecer): NÃO trate como orçamento (nada de pacotes, valores, promoção ou visita). Dúvidas gerais do buffet (endereço, regras, o que tem no espaço) você responde; sobre a festa contratada (horários, cardápio escolhido, convidados, pagamentos, mudanças) use transferir_para_atendente com assunto cliente_com_festa.
- Quer trabalhar / enviar currículo: use transferir_para_atendente com assunto trabalhar (e, em funcoes, as funções que a pessoa citou). Não precisa perguntar a função antes.
- Fornecedor, quer vender algo ou oferecer um serviço (fora permuta/parceria de divulgação, que tem regra própria): use transferir_para_atendente com assunto fornecedor.
- Quer orçamento de festa: siga normalmente. Quem já fez festa com a gente antes ("fizemos ano passado") e quer outra é orçamento normal — não passe para a equipe por isso.
- Perguntou da promoção: responda com as regras das INFORMAÇÕES DO BUFFET e siga a conversa — perguntar da promoção NÃO é motivo para passar para a equipe (Joyce, Castelo 26/10). Só passe se ele pedir desconto, parcelamento ou outra condição além da promoção, como na regra abaixo.
- Quebre objeções com empatia ("vou pensar" → ofereça a visita sem compromisso; "tá caro" → valorize o que está incluso).
- Se o cliente disser que não vai fechar / desistiu / não dá agora: aceite com gentileza, agradeça e deixe a porta aberta ("se mudar de ideia, é só me chamar") — NÃO insista, NÃO ofereça visita nem horários.
- Permuta, parceria, patrocínio ou divulgação em troca da festa (influenciador): NÃO aceite, NÃO recuse e NÃO fale em desconto — diga com simpatia que vai passar a proposta para a equipe avaliar e use transferir_para_atendente (motivo: proposta de permuta/parceria).
- Formas de pagamento: se as INFORMAÇÕES DO BUFFET trazem "Formas de pagamento", responda você mesma com elas ("aceita boleto?", "como é o pagamento?", "aceita cartão?") e siga a conversa — NÃO passe para a equipe por isso (Mayara, Castelo 27/10). Fale só o que está escrito ali (formas e prazo de quitação); não invente número de parcelas, entrada nem datas.
- Desconto, à vista com desconto, número de parcelas, entrada, datas ou valores de parcelas, ou qualquer negociação (e forma de pagamento quando as INFORMAÇÕES DO BUFFET não dizem nada sobre isso): na primeira vez diga que as condições de pagamento e o fechamento são com a equipe. Se o cliente perguntar DE NOVO sobre isso, não repita a mesma resposta: use transferir_para_atendente (motivo: condições de pagamento).
- Nunca repita a mesma resposta duas vezes seguidas: se o cliente repetir a pergunta, responda de outro jeito (mais curto, ou pergunte o que exatamente ele quer saber). Só passe para a equipe se for sobre condições de pagamento ou se ele pedir um atendente.
- Áudios do cliente chegam para você já transcritos e fotos chegam descritas: responda ao conteúdo normalmente, sem comentar que foi transcrito. Se aparecer que um áudio ou uma foto não pôde ser ouvido/visto, peça com gentileza para a pessoa escrever.

FORMATAÇÃO NO WHATSAPP:
- Negrito do WhatsApp com asterisco simples (*assim*) só para nomes de pacotes e valores. Datas e horários SEM negrito (o celular já sublinha e fica pesado). Nada de **duplo**, # ou listas com hífen.
- Horário de início: os horários de festa são os da agenda (ex.: almoço 13h, noite 19h). Se o cliente pedir outro horário de início (ex.: 20h), NÃO diga que não dá: apresente o horário padrão com entusiasmo e incentive-o; se ele insistir, use transferir_para_atendente para a equipe confirmar.
- Valores sempre com centavos: "R$ 7.400,00" (nunca "R$ 7.400" nem "7,4 mil").
- Datas sempre por extenso ("sábado, 26 de dezembro"), nunca "26/12". Se a data for hoje ou amanhã, diga isso: "amanhã (quarta, 7 de outubro), às 11h". Horários como "almoço (13h)" ou "noite (19h)", nunca "13:00" (o WhatsApp sublinha como link). O que vier entre [colchetes] nas ferramentas é só para você — não copie.
${ctx.packagesText
    ? `- Mensagem de valores: comece com entusiasmo e mostre o VALOR ANTES DO PREÇO — o que o pacote entrega e, embaixo, o preço (siga o "COMO PASSAR" da ferramenta consultar_valor_pacote). Termine com o próximo passo (garantir a data ou visita — respeitando a regra do CONVITE PARA VISITA), sem perguntar se ele quer saber o que muda entre os pacotes. Formato:
  "Aaah, que demais, [nome]! 🥳 Para 60 convidados no sábado, 26 de dezembro, todos os pacotes têm [o que é comum a todos, do cadastro] ✨
  🎉 *[Pacote 1]* — [4 ou 5 itens principais]
  👉 R$ [valor da ferramenta]
  ⭐ *[Pacote 2]* — tudo do [Pacote 1] + [o que ele tem a mais]
  👉 R$ [valor da ferramenta]
  E o melhor: esse dia ainda tem os dois horários livres, almoço (13h) ou noite (19h) 🎉
  Quer vir conhecer o espaço ou prefere já ver a melhor data? 😍"
`
    : `- Mensagem de valores: comece com entusiasmo, use as linhas prontas da ferramenta (um pacote por linha, cada um com o emoji que a ferramenta já traz) e termine com uma pergunta que puxe o próximo passo. Exemplo:
  "Aaah, que demais, [nome]! 🥳 Olha os valores para 60 convidados no sábado, 26 de dezembro:
  🎉 *[Pacote 1]* — R$ [valor da ferramenta]
  ⭐ *[Pacote 2]* — R$ [valor da ferramenta]
  👑 *[Pacote 3]* — R$ [valor da ferramenta]
  E o melhor: esse dia ainda tem os dois horários livres, almoço (13h) ou noite (19h) 🎉
  Quer que eu te conte o que cada pacote tem? 😍"
`}
REGRAS INEGOCIÁVEIS:
1. VALORES: informe somente os valores da tabela oficial, obtidos com a ferramenta consultar_valor_pacote — nunca de cabeça, nunca estimativa, nunca arredondado, nunca somando outros itens. Para consultar você precisa da quantidade de convidados E do dia da festa (a data ou, pelo menos, o dia da semana): se faltar algum, pergunte ANTES de falar qualquer valor. Desconto, condição à vista, parcelamento, brinde, entrada diferente ou qualquer negociação: NUNCA ofereça nem prometa — diga que as condições de pagamento e o fechamento são com a equipe. Se a ferramenta não trouxer valor, envie o PDF de pacotes (enviar_materiais, tipo "pacotes").
   VALOR SÓ PARA QUEM PERGUNTA O PREÇO: passe valores só quando o cliente perguntar o preço (preço, valor, quanto fica/custa, "e o investimento?"). Pedir "orçamento" ou escolher a opção de orçamento NÃO é perguntar o preço: ele recebe fotos, vídeo e o PDF dos pacotes, e você conduz para a data e a visita, sem escrever valores. Por iniciativa própria, não passe valores nem ofereça passar ("quer que eu te passe os valores?") — mesmo que as informações do buffet digam "informe o valor". Quem não perguntou já tem o PDF de pacotes; conduza pela data, pelo espaço e pela visita.
   Se o cliente pediu o valor e você já sabe a quantidade e o dia (ou a data), chame consultar_valor_pacote JÁ e dê o valor NESTA resposta — nunca pergunte "quer que eu te passe o valor?". Com data e horário, a ferramenta confere a agenda: se estiver ocupado, avise e ofereça o horário livre mais próximo.
2. NUNCA prometa nada: disponibilidade de data, brindes, itens inclusos, exceções. Quem confirma detalhes é a equipe.
   DEGUSTAÇÃO: só diga se o buffet faz e como funciona o que estiver nas INFORMAÇÕES DO BUFFET; se não estiver, diga que a equipe confirma. Você NUNCA marca degustação nem diz dia ou horário para ela — quem agenda é a equipe. Se oferecer ou marcar VISITA logo depois de o cliente falar de degustação, deixe claro que é uma visita para conhecer o espaço, não a degustação.
3. NUNCA invente informações. Se não souber responder, use a ferramenta transferir_para_atendente.
4. Se a pessoa pedir para falar com um humano/atendente, ou demonstrar irritação, use transferir_para_atendente imediatamente.
5. Não diga que você é uma IA a menos que perguntem diretamente; se perguntarem, admita com naturalidade.

DADOS DA FESTA: sempre que o cliente informar nome, mês da festa ou número de convidados, chame registrar_dados_festa. Assim que mês e convidados estiverem registrados, fotos, vídeo e PDF de pacotes saem automaticamente, cada um com a legenda que você escrever (legenda_fotos, legenda_video, legenda_pdf — curtas, animadas, com o nome do cliente e do aniversariante; escreva-as SEMPRE que chamar registrar_dados_festa). Não chame enviar_materiais para eles depois disso; só comente brevemente e convide para a visita. Pergunte o nome do aniversariante de forma natural se ainda não souber. Quando o cliente disser o nome do aniversariante e você quiser elogiar o nome, deixe claro que o elogio é para o aniversariante, com o nome dele na frase ("Cecília, que nome lindo! 🥰" ou "Que nome lindo o da Cecília! 🥰") — nunca "Que nome lindo, [nome do cliente]!", que parece elogio ao nome de quem está conversando.

MATERIAIS (ferramenta enviar_materiais):
- Cada material vai NO MÁXIMO UMA VEZ por conversa. O PDF de pacotes só quando o cliente pedir o PDF/os pacotes ou quando consultar_valor_pacote não trouxer valor — nunca em resposta a outras perguntas.
- Só reenvie (reenviar=true) se o cliente pedir EXPLICITAMENTE para mandar de novo.
- Já enviados nesta conversa: veja SITUAÇÃO DESTA CONVERSA.
- Junto com as fotos pode sair uma imagem de avaliação de cliente (prova social). Não comente, não cite nem resuma essa avaliação: siga a conversa normalmente.

${settings.corporate_events_enabled ? `${corporatePromptBlock(companyName, settings.corporate_max_guests ?? null)}

OUTROS TIPOS DE EVENTO: você atende festas de aniversário e confraternizações de empresas. Se o cliente quiser formatura, festa escolar ou outro evento que não seja nenhum dos dois, NÃO passe valor nem compare pacotes: pergunte (o que ainda não souber) o tipo de evento, a data e a quantidade de pessoas, e então use transferir_para_atendente com o motivo no formato "Evento: … | Data: … | Pessoas: …".` : `OUTROS TIPOS DE EVENTO: você atende festas de aniversário. Se o cliente quiser formatura, festa escolar, confraternização, evento corporativo ou outro evento que não seja aniversário, NÃO passe valor nem compare pacotes: pergunte (o que ainda não souber) o tipo de evento, a data e a quantidade de pessoas, e então use transferir_para_atendente com o motivo no formato "Evento: … | Data: … | Pessoas: …".`}

DATAS DA FESTA (agenda):
- Antes de listar datas, se o cliente ainda não disse, pergunte se ele prefere fim de semana ou dia de semana (e passe a preferência para a ferramenta). Se ele já disse — "na semana", "durante a semana", "dia útil" = dia de semana; "final de semana", "sábado ou domingo" = fim de semana — NÃO pergunte de novo: consulte com essa preferência e mostre as datas.
- Nunca faça a mesma pergunta duas vezes na mesma resposta (nem com outras palavras).
- Datas futuras (inclusive no ano que vem): consulte a agenda normalmente (consultar_datas_livres com o mês e o ano) e mostre o que está disponível — NUNCA diga que "ainda não dá para reservar" ou que a agenda não abriu. A reserva é feita com contrato e sinal pela equipe.
- Quando o cliente perguntar por data livre, ou disser o mês/data da festa, use consultar_datas_livres (com o dia da semana ou a preferência dele).
- Lista de datas: use as linhas prontas da ferramenta (🗓️ dia, ☀️ almoço, 🌙 noite, horários embaixo de cada data, sem negrito) e termine com uma pergunta; o aviso de contrato e sinal vai curto, entre parênteses, no final. Exemplo:
  "Aaah, [nome]! Olha as datas que ainda tenho em dezembro 🎉🎈
  🗓️ Terça, 1 de dezembro
  ☀️ Almoço (13h às 17h)
  🌙 Noite (19h às 23h)
  🗓️ Quarta, 2 de dezembro
  ☀️ Almoço (13h às 17h)
  Qual delas combina mais com a festa? 😍 (A data fica garantida com contrato e sinal ✨)"
- Fale "tenho o sábado, 5 de dezembro, disponível" — nunca "tem festa sim no sábado" (parece que já tem festa marcada).
- Ofereça no máximo 2 ou 3 opções por vez. Diga sempre "disponível neste momento" e que a data só fica garantida com contrato e sinal com a equipe.
- Você NÃO reserva, NÃO segura e NÃO bloqueia datas — nunca diga que fez isso. Se o cliente quiser garantir a data, ofereça passar para a equipe fechar.
- Quando o cliente escolher uma data, use essa data (e o horário) em consultar_valor_pacote para dar o valor certo (dia da semana, véspera ou feriado).

${ctx.packagesText
    ? `O QUE CADA PACOTE INCLUI (cadastro do buffet — use para explicar e comparar os pacotes; só cite o que está aqui; valores NUNCA daqui, só de consultar_valor_pacote):\n${ctx.packagesText}\n` +
      `COMO MOSTRAR O QUE O PACOTE INCLUI: nunca um parágrafo corrido. Agrupe em linhas curtas, cada uma começando com um emoji e o nome do grupo em negrito (só os grupos que existirem no cadastro), e termine com uma pergunta. Exemplo:\n` +
      `  "No *[nome do pacote]* vem tudo isso, [nome] 🥳\n` +
      `  🍿 *Comidinhas:* [o que o cadastro diz]\n` +
      `  🍰 *Doces:* [o que o cadastro diz]\n` +
      `  🥤 *Bebidas:* [o que o cadastro diz]\n` +
      `  🎠 *Diversão:* [o que o cadastro diz]\n` +
      `  🏠 *Estrutura:* [o que o cadastro diz]\n` +
      `  Qual desses combina mais com a festa? 😍"\n` +
      `Para COMPARAR pacotes, mostre só o que muda (o que um tem a mais que o outro), no mesmo formato, sem repetir o que é igual.\n` +
      `PERGUNTA DO FIM (depois de explicar ou comparar pacotes): simples e que leve a conversa para frente — qual pacote combina mais com a festa, ou, se ainda não marcou visita, o convite com 2 horários. NUNCA ofereça mostrar "o que um pacote tem a menos" nem fique oferecendo mais comparações em sequência.\n\n`
    : 'O QUE CADA PACOTE INCLUI: não cadastrado — se perguntarem a diferença entre os pacotes, envie o PDF de pacotes (enviar_materiais, tipo "pacotes") em vez de transferir.\n\n'}${ctx.minPackageGuests ? `PACOTES: o menor pacote é para ${ctx.minPackageGuests} convidados. Se o cliente falar em menos de ${ctx.minPackageGuests} convidados ou pedir orçamento para menos, explique JÁ NA MESMA RESPOSTA (não espere ele perguntar), com naturalidade, que o menor pacote é para ${ctx.minPackageGuests} pessoas e que a equipe explica como fica para um grupo menor. Se ele pediu o valor e já disse o dia, consulte o valor para ${ctx.minPackageGuests} convidados (consultar_valor_pacote) e passe na mesma resposta, deixando claro que é o valor do pacote mínimo.\n\n` : ''}COMO APRESENTAR O BUFFET (diferenciais, estrutura, atrações — ex.: na primeira resposta): nunca um parágrafo corrido com tudo emendado. Abra com "Só aqui você vai encontrar 🥳" e depois 3 a 4 linhas curtas (no máximo umas 7 palavras cada, para caber numa linha do celular), cada uma começando com um emoji, juntando o que combina (mesmo que as informações do buffet peçam "2 ou 3 linhas", use este formato). Só cite o que estiver nas INFORMAÇÕES DO BUFFET. Formato:
  "Só aqui você vai encontrar 🥳
  🏆 [tradição e número de festas]
  ⭐ [avaliação]
  🎢 [principais atrações]
  🚗 [comodidades, ex.: estacionamento]"

CONVITE PARA VISITA (não seja repetitiva): a regra desta resposta está em SITUAÇÃO DESTA CONVERSA.

AGENDAMENTO DE VISITAS:
- Janelas de visita: ${settings.visit_hours}.
- Ao oferecer visita, ofereça JÁ NA MESMA MENSAGEM 2 horários concretos (os sugeridos em SITUAÇÃO DESTA CONVERSA). Nunca diga que vai passar horários sem passá-los.
- O convite para visita TERMINA SEMPRE com uma pergunta direta para a pessoa escolher — nada de "se quiser, posso agendar…" solto. Ex.: "Tenho amanhã, sexta, às 11h ou sábado às 10h. Qual fica melhor pra você vir conhecer? 😍".
- Horários de visita livres nos próximos dias: veja SITUAÇÃO DESTA CONVERSA. Se o cliente pedir outro dia ou horário de visita, ou quiser TROCAR a visita que já marcou, ofereça desta lista e use agendar_visita (remarcar=true se ele já tem visita) — NUNCA passe para a equipe por causa de visita.
- Se o cliente pedir um dia/horário fora das janelas ou já ocupado, NÃO transfira: diga com gentileza que nesse horário não dá e ofereça os horários livres mais próximos (a ferramenta agendar_visita devolve quais são).
- QUANDO O CLIENTE PODE: se, depois de um convite de visita, ele disser quando consegue ("só à noite", "eu trabalho durante o dia", "só no fim de semana"), isso é sobre a VISITA (não sobre o horário da festa). Ofereça na mesma resposta 2 horários da lista que encaixam, com dia e hora. Se nenhum encaixa (ex.: ele quer à noite e as visitas vão só até a tarde), diga com gentileza quais são as janelas de visita e ofereça a opção mais próxima do que ele pediu (ex.: sábado de manhã). Nunca ofereça horário de visita fora das janelas nem escreva só "à noite"/"de manhã" sem a hora, e termine com uma pergunta para ele escolher.
- Quando a pessoa confirmar dia e horário, use agendar_visita. Depois confirme por mensagem o dia/horário e diga que a equipe confirma a visita.

PASSAGEM PARA A EQUIPE: ao usar transferir_para_atendente, avise o cliente que um atendente vai continuar por aqui, sem escrever horários — o sistema acrescenta o horário de atendimento da equipe (veja SITUAÇÃO DESTA CONVERSA). As janelas de visita NÃO são o horário de atendimento da equipe: nunca use uma no lugar da outra.
${settings.extra_instructions ? `\nINFORMAÇÕES DO BUFFET (fonte única para fatos sobre o buffet; instruções de estilo/personalidade que estiverem aqui devem ser seguidas):\n${settings.extra_instructions}` : ''}`;

  const notes = [
    ctx.resumeNote ? `ATENÇÃO — RETOMADA: ${ctx.resumeNote}` : '',
    ctx.weekdayNote ? `ATENÇÃO — DIA DA SEMANA: ${ctx.weekdayNote} Na resposta, avise com gentileza e pergunte qual dia ele quer (antes de consultar datas ou valores).` : '',
    ctx.houseNote ? `ATENÇÃO — REGRA DO BUFFET: ${ctx.houseNote}` : '',
    ctx.recessNote ? `ATENÇÃO — ${ctx.recessNote}` : '',
    ctx.intentNote ? `ATENÇÃO — QUEM É O CONTATO: ${ctx.intentNote}` : '',
    ctx.corporateNote ? `ATENÇÃO — ${ctx.corporateNote}` : '',
    ctx.campaignNote || '',
    ctx.promoNote || '',
    ctx.materialsNote ? `ATENÇÃO — MATERIAIS NESTE TURNO: ${ctx.materialsNote}` : '',
  ].filter(Boolean);
  const lines = [
    `- Hoje é ${today}.`,
    `- ${ctx.isFirstReply ? 'ESTA É A SUA PRIMEIRA RESPOSTA: apresente-se (diga seu nome' + (assistantName ? ' — ' + assistantName : ', se ele estiver nas informações do buffet,') + ' e que é do ' + companyName + ') e, se ainda não souber o nome do cliente, já pergunte o nome dele NESTA mensagem, junto com a resposta ao que ele perguntou. Se ele só cumprimentou e você ainda não sabe o nome: apresente-se, mostre os diferenciais do buffet no formato de COMO APRESENTAR O BUFFET ("Só aqui você vai encontrar 🥳" + as linhas com emoji) e termine perguntando SÓ o nome — a lista de "como posso te ajudar" vem na próxima, depois que ele disser o nome.' : 'Se ainda não souber o nome do cliente, não interrompa a conversa para pedir — aproveite um momento natural.'}`,
    `- Dados do cliente já registrados: ${ctx.knownDataText}. Não pergunte de novo o que já sabe.`,
    ctx.pricePending ? '- O CLIENTE JÁ PEDIU O VALOR e ainda não recebeu: assim que você souber a quantidade de convidados e o dia/data (já registrados ou nesta mensagem), chame consultar_valor_pacote e passe o valor NESTA resposta, sem esperar ele pedir de novo. Se ainda faltar um dos dois, pergunte só o que falta.' : '',
    ctx.pendingUserMessages > 1 ? `- O cliente mandou ${ctx.pendingUserMessages} mensagens seguidas desde a sua última resposta: responda a TODAS as perguntas delas numa única mensagem, sem ignorar nenhuma.` : '',
    ctx.crossedMessage ? '- ATENÇÃO: a mensagem do cliente chegou junto com a sua última resposta, então ele ainda não viu a sua pergunta. NÃO faça uma pergunta nova: responda só o que ele disse agora (se precisar) e deixe a sua pergunta anterior em aberto. Se não houver nada a responder, mande só uma frase curta.' : '',
    ctx.visitText ? `- Este cliente JÁ TEM VISITA MARCADA: ${ctx.visitText}. "Ok", "beleza", "obrigado" depois disso são só confirmação — responda com carinho, sem agendar de novo.` : '',
    ctx.visitText && ctx.visitConfirmPending ? `- ATENÇÃO — PERGUNTAMOS AO CLIENTE SE ELE CONFIRMA ESSA VISITA (${ctx.visitText}) e ele ainda não tinha respondido. Se a resposta confirma (sim, ok, confirmo, vou sim, estarei aí, 👍, ❤️), chame confirmar_visita e responda curto e carinhoso que está tudo certo e que estamos esperando. Se ele não puder nesse dia/horário ou quiser trocar, ofereça 2 horários livres e use agendar_visita com remarcar=true quando ele escolher. Se ele disser que não vem mais, não insista: use transferir_para_atendente com o motivo "cliente avisou que não vem mais — desmarcar na agenda". Não pergunte de novo se ele confirma.` : '',
    `- Materiais já enviados nesta conversa: ${ctx.sentMaterialsText}.`,
    `- Convite para visita nesta resposta: ${visitInviteRule(ctx.visitRepliesAgo, ctx.clientAffirmed)}`,
    `- Horários de visita para sugerir (2 deles): ${offersText}.`,
    `- Horários de visita livres nos próximos dias: ${ctx.visitSlotsText}.`,
    `- Horário de atendimento da equipe: ${ctx.teamHoursText}.`,
  ].filter(Boolean);
  const handoff = `${ctx.candidateLinkSent ? `\nATENÇÃO — ESTA PESSOA QUER TRABALHAR NO BUFFET e você já mandou o link do cadastro de candidatos (${ctx.candidateLinkSent}). Responda só sobre isso, curto e simpático: se ela só agradeceu ou confirmou ("ok", "obrigado"), despeça-se com carinho (ex.: "Imagina! Boa sorte 🍀 Qualquer dúvida no cadastro, é só chamar 😊", com o nome dela se souber); se tiver dúvida sobre o cadastro, explique (é rápido, pelo celular, e se o perfil combinar a equipe chama por aqui); se não conseguiu abrir, mande o link de novo, escrito exatamente assim: ${ctx.candidateLinkSent}. Não prometa vaga nem fale de salário. NÃO fale de festa, pacotes, valores nem visita e NÃO chame transferir_para_atendente de novo.` : ctx.afterHoursHandoff ? `\nATENÇÃO — ESTA CONVERSA JÁ FOI PASSADA PARA A EQUIPE (motivo: ${ctx.afterHoursHandoff.reason || 'não informado'}). A equipe está fora do horário agora e volta ${ctx.afterHoursHandoff.returns}. Enquanto isso, continue tirando dúvidas informativas com base nas informações do buffet (estrutura, o que tem, como funciona, materiais, horários de visita). Para o assunto que motivou a passagem e para negociação/fechamento, diga com gentileza que a equipe continua ${ctx.afterHoursHandoff.returns}. NÃO chame transferir_para_atendente de novo.` : ''}`.trim();
  const dynamic = `SITUAÇÃO DESTA CONVERSA (o que vale agora; os avisos de ATENÇÃO valem mais que as regras gerais acima):\n${[...notes, ...lines].join('\n')}${handoff ? `\n${handoff}` : ''}`;
  return { stable, dynamic };
}

const TOOLS: ToolDef[] = [
  {
    name: 'registrar_dados_festa',
    description: 'Registra o nome, o aniversariante, o mês da festa e o número de convidados assim que o cliente informar (pode chamar com só um deles). Quando mês e convidados estiverem registrados, fotos, vídeo e PDF de pacotes são enviados AUTOMATICAMENTE ao cliente, cada um precedido pelas suas legendas (escreva-as sempre).',
    parameters: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome da pessoa' },
        aniversariante: { type: 'string', description: 'Nome do aniversariante, se o cliente disse' },
        mes: { type: 'string', description: 'Mês da festa, com o ano se o cliente disse (ex.: Novembro, abril de 2027)' },
        convidados: { type: 'string', description: 'Número de convidados, ex.: 80' },
        confraternizacao: { type: 'boolean', description: 'true quando o evento é de EMPRESA (confraternização, fim de ano da equipe, colaboradores) e não aniversário' },
        empresa: { type: 'string', description: 'Nome da empresa, se for confraternização e o cliente disse' },
        legenda_fotos: { type: 'string', description: 'Mensagem que vai ANTES das fotos e precisa ENCANTAR (não só "olha onde vai ser a festa"): 2 frases curtas — chame pelo nome, cite o aniversariante se souber (só nomes que o cliente disse — nunca invente) e desperte a imaginação do dia da festa (o espaço todinho deles, a criançada brincando, a carinha de quem faz aniversário chegando). Use o nome do buffet, nunca o de outro lugar. 2–3 emojis. Ex.: "Aaah, [nome], olha só o espaço que vai ser todinho de vocês no dia da festa! 😍🎈 Já imaginou a carinha de [aniversariante] chegando e vendo tudo isso preparado? ✨"' },
        legenda_video: { type: 'string', description: 'Legenda curta e animada do vídeo, diferente da das fotos, mostrando a festa acontecendo. Ex.: "E agora olha o [nome do buffet] em dia de festa: brinquedos, monitores e muita diversão 🎬🎉"' },
        legenda_pdf: { type: 'string', description: 'Mensagem curta que vai ANTES do PDF de pacotes, com a quantidade de convidados. Ex.: "E aqui estão os nossos pacotes pra 80 convidados 📋✨". Sem valores. Se o cliente falou em menos convidados que o menor pacote, não cite o número dele.' },
      },
    },
  },
  {
    name: 'agendar_visita',
    description: 'Registra a visita quando o cliente CONFIRMAR dia e horário. Use somente após confirmação explícita de um NOVO pedido — "ok", "beleza", "obrigado" depois do agendamento são só confirmação, não chame de novo. Cada cliente tem no máximo uma visita; para mudar a data dela use remarcar=true.',
    parameters: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'Data da visita no formato YYYY-MM-DD' },
        horario: { type: 'string', description: 'Horário no formato HH:MM (ex: 10:00, 15:30)' },
        nome_cliente: { type: 'string', description: 'Nome da pessoa, se ela informou' },
        remarcar: { type: 'boolean', description: 'true só se o cliente pediu explicitamente para mudar a visita que já tem' },
      },
      required: ['data', 'horario'],
    },
  },
  {
    name: 'enviar_materiais',
    description: 'Envia materiais do buffet para o cliente: fotos do espaço, vídeo de apresentação ou PDF de pacotes.',
    parameters: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['fotos', 'video', 'pacotes'], description: 'Qual material enviar' },
        reenviar: { type: 'boolean', description: 'true SOMENTE se o cliente pediu explicitamente para mandar de novo um material já enviado' },
      },
      required: ['tipo'],
    },
  },
  {
    name: 'consultar_datas_livres',
    description: 'Consulta a agenda do buffet (festas fechadas e pré-reservas) e devolve datas e horários de festa livres NESTE MOMENTO. Use quando o cliente perguntar se tem data, quais datas estão livres, ou quando disser o mês/data da festa. Só consulta: não reserva nada.',
    parameters: {
      type: 'object',
      properties: {
        mes: { type: 'string', description: 'Mês da festa, com o ano se o cliente disse (ex.: Novembro, abril de 2027)' },
        data: { type: 'string', description: 'Data específica no formato AAAA-MM-DD, se o cliente falou uma' },
        dia_semana: { type: 'string', description: 'Dia da semana preferido (ex.: sábado), se o cliente falou' },
        preferencia: { type: 'string', description: '"fim de semana" ou "dia de semana", se o cliente disse a preferência' },
      },
    },
  },
  {
    name: 'consultar_valor_pacote',
    description: 'Consulta na tabela oficial do buffet o valor dos pacotes para a quantidade de convidados e o dia da festa. Use SEMPRE que o cliente perguntar valor/preço/quanto custa — é a única fonte de valores. Precisa da quantidade de convidados e do dia da festa (a data é melhor, porque detecta feriado e véspera; senão, o dia da semana). Se faltar algum dos dois, pergunte ao cliente antes de chamar.',
    parameters: {
      type: 'object',
      properties: {
        convidados: { type: 'string', description: 'Número de convidados, ex.: 70' },
        data: { type: 'string', description: 'Data da festa no formato AAAA-MM-DD, se o cliente informou' },
        dia_semana: { type: 'string', description: 'Dia da semana da festa (segunda, terça, quarta, quinta, sexta, sábado ou domingo), se o cliente não deu a data' },
        pacote: { type: 'string', description: 'Nome do pacote, se o cliente perguntou de um específico' },
        horario: { type: 'string', description: 'Horário de início da festa escolhido (ex.: 13:00 ou 19:00), se já definido' },
      },
    },
  },
  {
    name: 'transferir_para_atendente',
    description: 'Transfere a conversa para a equipe humana. Use quando o cliente pedir, quando você não souber responder, ou em situações delicadas.',
    parameters: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Motivo curto da transferência, para a equipe saber o que aconteceu' },
        assunto: {
          type: 'string',
          enum: ['orcamento', 'cliente_com_festa', 'trabalhar', 'fornecedor', 'outro'],
          description: 'Quem é o contato: orcamento (quer fazer festa), cliente_com_festa (já tem festa marcada/contrato), trabalhar (quer emprego/enviar currículo), fornecedor (quer vender algo ou oferecer serviço), outro',
        },
        funcoes: {
          type: 'string',
          description: 'Só com assunto trabalhar: as funções que a pessoa disse querer, em palavras simples separadas por vírgula (ex.: "garçom, monitor", "cozinha", "segurança"). Vazio se ela não disse.',
        },
      },
      required: ['motivo'],
    },
  },
];

// Só entra na lista quando perguntamos se o cliente confirma a visita
const CONFIRM_VISIT_TOOL: ToolDef = {
  name: 'confirmar_visita',
  description: 'Marca como CONFIRMADA a visita que o cliente já tem marcada, quando perguntamos se ele confirma e ele disse que sim. Não use para marcar visita nova nem para trocar dia/horário (para isso é agendar_visita).',
  parameters: { type: 'object', properties: {} },
};

// Confirmação de visita enviada (pela rotina de confirmação) e ainda sem resposta
async function loadPendingVisitConfirmation(supabase: any, visitId: string): Promise<string | null> {
  const cutoff = new Date(Date.now() - 72 * 3600000).toISOString();
  const { data } = await supabase
    .from('visit_confirmation_history')
    .select('id')
    .eq('visit_id', visitId)
    .eq('status', 'sent')
    .eq('response_received', false)
    .gte('sent_at', cutoff)
    .order('sent_at', { ascending: false })
    .limit(1);
  return (data || [])[0]?.id || null;
}

// O cliente respondeu a confirmação (confirmou ou remarcou com a IA)
async function markVisitConfirmationAnswered(supabase: any, visitId: string, responseType: 'confirmed' | 'reschedule'): Promise<void> {
  const { error } = await supabase
    .from('visit_confirmation_history')
    .update({ response_received: true, response_type: responseType, response_at: new Date().toISOString(), status: 'responded' })
    .eq('visit_id', visitId)
    .eq('response_received', false)
    .eq('status', 'sent');
  if (error) console.error('[AI Agent] visit_confirmation_history update error:', error);
}

async function toolConfirmarVisita(supabase: any, instance: AgentInstance, conv: AgentConv): Promise<string> {
  const visit = await loadLeadVisit(supabase, conv.lead_id);
  if (!visit || !conv.lead_id) return 'ERRO: este cliente não tem visita marcada. Não diga que confirmou.';
  const { error } = await supabase.from('lead_visits').update({ status_visita: 'confirmada' }).eq('id', visit.id);
  if (error) {
    console.error('[AI Agent] lead_visits confirm error:', error);
    return 'ERRO: falha ao confirmar a visita. Diga ao cliente que está anotado e que a equipe confirma por aqui.';
  }
  await markVisitConfirmationAnswered(supabase, visit.id, 'confirmed');
  await supabase.from('lead_history').insert({
    lead_id: conv.lead_id,
    company_id: instance.company_id,
    user_id: null,
    user_name: 'IA',
    action: 'Visita confirmada pelo cliente (IA)',
    new_value: `${visit.data_visita.split('-').reverse().join('/')} às ${visit.horario_visita}`,
  }).then(({ error: hErr }: { error: unknown }) => { if (hErr) console.error('[AI Agent] lead_history error:', hErr); });
  console.log(`[AI Agent] Visita ${visit.id} confirmada pelo cliente (conv ${conv.id})`);
  return `OK: visita de ${visitText(visit.data_visita, visit.horario_visita)} confirmada. Responda curto e carinhoso que está tudo certo e que estamos esperando — sem perguntar mais nada sobre a visita.`;
}

// O nome que o cliente disse vale mais que o nome do perfil do WhatsApp
// (que pode ser apelido, frase ou o nome salvo na agenda do celular)
async function saveCustomerName(supabase: any, conv: AgentConv, nome: string): Promise<void> {
  const { error } = await supabase.from('wapi_conversations').update({ contact_name: nome }).eq('id', conv.id);
  if (error) console.error('[AI Agent] Erro ao salvar nome na conversa:', error.message);
  if (conv.lead_id) await supabase.from('campaign_leads').update({ name: nome }).eq('id', conv.lead_id);
}

async function ensureLead(
  supabase: any,
  instance: AgentInstance,
  conv: AgentConv,
  phone: string,
  contactName: string | null,
  nomeCliente?: string,
): Promise<string | null> {
  if (conv.lead_id) {
    if (nomeCliente) {
      await supabase.from('campaign_leads').update({ name: nomeCliente }).eq('id', conv.lead_id);
    }
    return conv.lead_id;
  }
  const clean = phone.replace(/\D/g, '');
  // Pessoa que já é lead da empresa (qualquer formato de telefone/unidade): reaproveita
  const existing = await findLeadByPhone<{ id: string }>(supabase, instance.company_id, clean, 'id');
  if (existing) {
    if (nomeCliente) {
      await supabase.from('campaign_leads').update({ name: nomeCliente }).eq('id', existing.id);
    }
    await supabase.from('wapi_conversations').update({ lead_id: existing.id }).eq('id', conv.id);
    conv.lead_id = existing.id;
    return existing.id;
  }
  const { data: newLead } = await supabase.from('campaign_leads').insert({
    name: nomeCliente || (firstNameOrEmpty((conv.bot_data as Json | null)?.nome as string) ? String((conv.bot_data as Json).nome) : '') || contactName || clean,
    whatsapp: clean.startsWith('55') ? clean : `55${clean}`,
    unit: instance.unit,
    campaign_id: 'ai-agent',
    campaign_name: 'WhatsApp (IA)',
    status: 'novo',
    company_id: instance.company_id,
  }).select('id').single();
  if (newLead?.id) {
    await supabase.from('wapi_conversations').update({ lead_id: newLead.id }).eq('id', conv.id);
    conv.lead_id = newLead.id as string;
    return newLead.id as string;
  }
  return null;
}

// Feriado (nacional, SP/Sorocaba ou cadastrado pela empresa) não tem visita:
// caso Lya, 09/10 — a IA marcou visita na segunda 12/10 (Aparecida) e a
// equipe teve que desmarcar
async function loadLocalHolidays(supabase: any, companyId: string): Promise<string[]> {
  const { data: company } = await supabase.from('companies').select('settings').eq('id', companyId).maybeSingle();
  return localHolidaysFrom((company?.settings || null) as any);
}

function isHolidayDate(ymd: string, localHolidays: string[]): boolean {
  const [y, m, d] = ymd.split('-').map(Number);
  return !!y && !!m && !!d && isHolidayYmd(y, m, d, localHolidays);
}

async function toolAgendarVisita(
  supabase: any,
  instance: AgentInstance,
  conv: AgentConv,
  phone: string,
  contactName: string | null,
  settings: AiSettings,
  args: { data?: string; horario?: string; nome_cliente?: string; remarcar?: boolean },
): Promise<string> {
  const dataVisita = (args.data || '').trim();
  const horario = normalizeTime(args.horario || '') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataVisita) || !horario) {
    return 'ERRO: data ou horário em formato inválido. Peça a confirmação do dia e horário novamente.';
  }

  // Um lead = no máximo uma visita marcada. Já tem? Só confirma (ou remarca, se pedido).
  const existing = await loadLeadVisit(supabase, conv.lead_id);
  if (existing && existing.data_visita === dataVisita && existing.horario_visita === horario) {
    console.log(`[AI Agent] Visita ${dataVisita} ${horario} já é deste cliente — só confirmando`);
    return `JÁ AGENDADA: esta visita já está marcada para o cliente (${visitText(existing.data_visita, existing.horario_visita)}). NÃO agende de novo — só confirme com carinho, ex.: "Sua visita está confirmada para ${visitText(existing.data_visita, existing.horario_visita)} 😊".`;
  }
  if (existing && !args.remarcar) {
    return `JÁ TEM VISITA: o cliente já tem visita marcada para ${visitText(existing.data_visita, existing.horario_visita)}. NÃO crie outra. Se ele só confirmou (ok, beleza, obrigado), apenas confirme essa visita. Se ele pediu EXPLICITAMENTE para mudar o dia/horário, chame agendar_visita de novo com remarcar=true.`;
  }

  // Fora das janelas, já passou ou já ocupado: NÃO transfere — devolve os
  // horários livres mais próximos para a IA oferecer.
  const visitHours = parseVisitHours(settings.visit_hours);
  const booked = await loadBookedSlots(supabase, instance, conv.lead_id);
  // Recesso e feriados: sem visitas nesses dias
  const closed = parseClosedPeriods(settings.closed_periods);
  const holidays = await loadLocalHolidays(supabase, instance.company_id);
  const available = listAvailableSlots(visitHours, Date.now(), booked, { days: 21, minLeadMinutes: 60, max: 1000 })
    .filter((sl) => !isClosedDay(sl.date, closed) && !isHolidayDate(sl.date, holidays));
  const requested: Slot = { date: dataVisita, time: horario };
  const isAvailable = available.some((sl) => slotKey(sl) === slotKey(requested));
  if (!isAvailable) {
    const recess = closedPeriodAt(dataVisita, closed);
    const why = recess ? `cai no recesso do buffet (fechado ${formatClosedPeriod(recess, ymdBR(Date.now()))})`
      : isHolidayDate(dataVisita, holidays) ? 'é feriado (o buffet não recebe visitas)'
      : !isSlotInHours(visitHours, dataVisita, horario)
      ? 'está fora das janelas de visita'
      : booked.has(slotKey(requested)) ? 'já está ocupado' : 'já passou ou está muito em cima da hora';
    const options = nearestSlots(available, dataVisita, horario).map(formatSlot);
    console.log(`[AI Agent] Visita pedida ${dataVisita} ${horario} indisponível (${why}) — oferecendo: ${options.join(' / ')}`);
    return options.length > 0
      ? `INDISPONÍVEL: ${dataVisita.split('-').reverse().join('/')} às ${horario} ${why}. NÃO transfira. Diga com gentileza que nesse horário não dá e ofereça estes horários livres mais próximos: ${options.join(' ou ')}.`
      : 'INDISPONÍVEL: não há horários livres nas próximas semanas. Use transferir_para_atendente.';
  }

  const leadId = await ensureLead(supabase, instance, conv, phone, contactName, args.nome_cliente);
  if (!leadId) return 'ERRO: não foi possível registrar o lead. Use transferir_para_atendente.';

  // Remarcação: muda a visita que já existe (o lead nunca fica com duas)
  if (existing) {
    const { error: upErr } = await supabase.from('lead_visits')
      .update({ data_visita: dataVisita, horario_visita: horario, status_visita: 'remarcada' })
      .eq('id', existing.id);
    if (upErr) {
      console.error('[AI Agent] lead_visits update error:', upErr);
      return 'ERRO: falha ao remarcar a visita. Use transferir_para_atendente.';
    }
    await supabase.from('lead_history').insert({
      lead_id: leadId,
      company_id: instance.company_id,
      user_id: null,
      user_name: 'IA (beta)',
      action: 'Visita remarcada',
      old_value: `${existing.data_visita.split('-').reverse().join('/')} às ${existing.horario_visita}`,
      new_value: `${dataVisita.split('-').reverse().join('/')} às ${horario}`,
    }).then(({ error: hErr }: { error: unknown }) => { if (hErr) console.error('[AI Agent] lead_history error:', hErr); });
    // Se ele estava respondendo a confirmação da visita, ela fica respondida (a data nova é confirmada perto do dia)
    await markVisitConfirmationAnswered(supabase, existing.id, 'reschedule');
    await notifyAiVisit(supabase, instance, conv, phone, leadId, dataVisita, horario, true);
    return `OK: visita remarcada para ${visitText(dataVisita, horario)}. Confirme para o cliente.`;
  }

  const { error } = await supabase.from('lead_visits').insert({
    lead_id: leadId,
    company_id: instance.company_id,
    data_visita: dataVisita,
    horario_visita: horario,
    status_visita: 'agendada',
    observacoes: 'Visita agendada pela IA (beta)',
    unit: instance.unit,
    visit_type: 'visita',
  });
  if (error) {
    console.error('[AI Agent] lead_visits insert error:', error);
    return 'ERRO: falha ao registrar a visita. Use transferir_para_atendente.';
  }

  // Mesma regra da visita registrada à mão (src/lib/visitLeadStatus.ts): Novo,
  // Negociando, Orçamento enviado e Cliente Retorno viram Visita; Fechado,
  // Perdido etc. ficam como estão
  await supabase.from('campaign_leads').update({ status: 'em_contato' }).eq('id', leadId).in('status', ['novo', 'aguardando_resposta', 'orcamento_enviado', 'cliente_retorno']);
  await supabase.from('wapi_conversations').update({ has_scheduled_visit: true }).eq('id', conv.id);
  await supabase.from('lead_history').insert({
    lead_id: leadId,
    company_id: instance.company_id,
    user_id: null,
    user_name: 'IA (beta)',
    action: 'Visita agendada',
    new_value: `${dataVisita.split('-').reverse().join('/')} às ${horario}`,
  }).then(({ error: hErr }: { error: unknown }) => { if (hErr) console.error('[AI Agent] lead_history error:', hErr); });

  await notifyAiVisit(supabase, instance, conv, phone, leadId, dataVisita, horario, false);
  return `OK: visita registrada para ${visitText(dataVisita, horario)}. Confirme para o cliente.`;
}

// Visita marcada (ou remarcada) pela IA: aviso no sininho e no pop-up da equipe
async function notifyAiVisit(
  supabase: any,
  instance: AgentInstance,
  conv: AgentConv,
  phone: string,
  leadId: string,
  dataVisita: string,
  horario: string,
  remarcada: boolean,
): Promise<void> {
  const { data: lead } = await supabase.from('campaign_leads').select('name').eq('id', leadId).maybeSingle();
  const name = (lead?.name as string) || phone;
  await notifyTeam(supabase, instance, {
    type: 'visit_scheduled',
    title: remarcada ? '🗓️ Visita remarcada pela IA' : '🗓️ Visita agendada pela IA',
    message: `${name} (${instance.unit || 'WhatsApp'}) — ${visitText(dataVisita, horario)}. Confirme a visita com o cliente.`,
    data: { conversation_id: conv.id, lead_id: leadId, contact_phone: phone, unit: instance.unit, reason: 'ai_visit', data_visita: dataVisita, horario_visita: horario },
  });
}

// PDF de pacotes enviado = orçamento enviado: o lead passa para "Orçamento
// enviado" e entra nos follow-ups automáticos do número (os mesmos do bot fixo).
// Só sai de "Novo" — não mexe em lead com visita marcada ou já trabalhado.
async function markQuoteSent(
  supabase: any,
  instance: AgentInstance,
  conv: AgentConv,
  phone: string,
  contactName: string | null,
  via = 'PDF de pacotes enviado pela IA',
): Promise<void> {
  const leadId = await ensureLead(supabase, instance, conv, phone, contactName);
  if (!leadId) return;
  const { data: updated, error } = await supabase
    .from('campaign_leads')
    .update({ status: 'orcamento_enviado' })
    .eq('id', leadId)
    .eq('status', 'novo')
    .select('id');
  if (error) {
    console.error('[AI Agent] Erro ao marcar orçamento enviado:', error.message);
    return;
  }
  if (!updated || updated.length === 0) return;
  await supabase.from('lead_history').insert({
    lead_id: leadId,
    company_id: instance.company_id,
    user_id: null,
    user_name: 'IA (beta)',
    action: 'Alteração de status',
    old_value: 'novo',
    new_value: 'orcamento_enviado',
  }).then(({ error: hErr }: { error: unknown }) => { if (hErr) console.error('[AI Agent] lead_history error:', hErr); });
  console.log(`[AI Agent] Lead ${leadId} → Orçamento enviado (${via})`);
}

async function loadSalesMaterials(supabase: any, instance: AgentInstance): Promise<any[]> {
  // Sempre da própria empresa: dois buffets podem ter unidades com o mesmo nome
  const { data } = await supabase
    .from('sales_materials')
    .select('*')
    .eq('company_id', instance.company_id)
    .eq('unit', instance.unit)
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (data && data.length > 0) return data;
  const fallback = await supabase
    .from('sales_materials')
    .select('*')
    .eq('company_id', instance.company_id)
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  return fallback.data || [];
}

// Materiais que JÁ estão na conversa nos últimos 30 dias (qualquer envio, da
// IA, do bot fixo ou da equipe), pelo link do arquivo — vale mesmo depois de #reiniciar.
async function materialsAlreadyInChat(
  supabase: any,
  conv: AgentConv,
  materials: any[],
): Promise<Partial<Record<MaterialTipo, boolean>>> {
  const urlType = new Map<string, MaterialTipo>();
  for (const m of materials) {
    if (m.type === 'photo_collection' && Array.isArray(m.photo_urls) && m.photo_urls[0]) urlType.set(m.photo_urls[0], 'fotos');
    if (m.type === 'video' && m.file_url) urlType.set(m.file_url, 'video');
    if (m.type === 'pdf_package' && m.file_url) urlType.set(m.file_url, 'pacotes');
  }
  if (urlType.size === 0) return {};
  const { data } = await supabase
    .from('wapi_messages')
    .select('media_url')
    .eq('conversation_id', conv.id)
    .eq('from_me', true)
    .in('media_url', Array.from(urlType.keys()))
    .gte('timestamp', materialSince(conv))
    .or('status.is.null,status.neq.error') // o que não chegou no WhatsApp não conta
    .limit(50);
  const found: Partial<Record<MaterialTipo, boolean>> = {};
  for (const r of (data || []) as Array<{ media_url: string }>) {
    const t = urlType.get(r.media_url);
    if (t) found[t] = true;
  }
  return found;
}

async function toolEnviarMateriais(
  supabase: any,
  instance: AgentInstance,
  conv: AgentConv,
  phone: string,
  contactName: string | null,
  tipo: string,
  reenviar = false,
): Promise<string> {
  if (conv.__holdMaterials) {
    return 'AINDA NÃO: a mensagem do cliente não deixa claro que é sobre a festa. Não mande materiais nem diga que vai mandar — pergunte antes como pode ajudar.';
  }
  // Cada material vai uma vez por conversa (a menos que o cliente peça de novo)
  if (tipo === 'fotos' || tipo === 'video' || tipo === 'pacotes') {
    const sentAt = sentMaterials(conv)[tipo];
    if (sentAt && !reenviar) {
      console.log(`[AI Agent] ${tipo} já enviado em ${sentAt} (conv ${conv.id}) — não reenviando`);
      return `JÁ ENVIADO: o ${MATERIAL_LABEL[tipo]} já foi enviado nesta conversa (${fmtTimeBR(sentAt)}). Não reenvie; responda a pergunta do cliente normalmente. Só use reenviar=true se o cliente pedir explicitamente para mandar de novo.`;
    }
  }
  const materials = await loadSalesMaterials(supabase, instance);
  if (materials.length === 0) {
    return 'ERRO: nenhum material cadastrado. Diga que a equipe vai enviar os materiais em seguida.';
  }
  if (!reenviar && (tipo === 'fotos' || tipo === 'video' || tipo === 'pacotes')) {
    const inChat = await materialsAlreadyInChat(supabase, conv, materials);
    if (inChat[tipo]) {
      console.log(`[AI Agent] ${tipo} já está na conversa (envio anterior) — não reenviando`);
      return `JÁ ENVIADO: o ${MATERIAL_LABEL[tipo]} já foi enviado nesta conversa nos últimos ${MATERIAL_RESEND_DAYS} dias. Não reenvie; responda a pergunta do cliente normalmente. Só use reenviar=true se o cliente pedir explicitamente para mandar de novo.`;
    }
  }

  if (tipo === 'fotos') {
    const collection = (materials as any[]).find((m) => m.type === 'photo_collection');
    const photos: string[] = collection?.photo_urls || [];
    if (photos.length === 0) return 'ERRO: sem fotos cadastradas.';
    const sent: Array<{ tipo: MaterialTipo; id: string }> = [];
    for (let i = 0; i < Math.min(photos.length, 6); i++) {
      const id = await sendViaWapiSendId(supabase, 'send-image', instance, conv, { mediaUrl: photos[i], caption: '' });
      if (id !== null) sent.push({ tipo: 'fotos', id });
      await sandboxSleep(800);
    }
    if (sent.length === 0) return 'ERRO: falha ao enviar as fotos. Não diga que mandou; diga que a equipe envia em seguida.';
    const ack = await confirmMaterials(supabase, sent);
    if (ack.unconfirmed.length > 0) return `PENDENTE:${unconfirmedNote(ack.unconfirmed, ack.confirmed)}`;
    await mergeBotData(supabase, conv, { ai_materials_sent: { ...sentMaterials(conv), fotos: new Date().toISOString() } });
    return `OK: ${sent.length} fotos enviadas e confirmadas pelo WhatsApp.`;
  }

  if (tipo === 'video') {
    const video = (materials as any[]).find((m) => m.type === 'video');
    if (!video?.file_url) return 'ERRO: sem vídeo cadastrado.';
    const id = await sendViaWapiSendId(supabase, 'send-video', instance, conv, { mediaUrl: video.file_url, caption: '' });
    if (id === null) return 'ERRO: falha ao enviar o vídeo. Não diga que mandou; diga que a equipe envia em seguida.';
    const ack = await confirmMaterials(supabase, [{ tipo: 'video', id }]);
    if (ack.unconfirmed.length > 0) return `PENDENTE:${unconfirmedNote(ack.unconfirmed, ack.confirmed)}`;
    await mergeBotData(supabase, conv, { ai_materials_sent: { ...sentMaterials(conv), video: new Date().toISOString() } });
    return 'OK: vídeo enviado e confirmado pelo WhatsApp.';
  }

  if (tipo === 'pacotes') {
    // Vários PDFs por faixa de convidados: o mesmo critério do envio automático
    const allPdfs = (materials as any[]).filter((m) => m.type === 'pdf_package' && m.file_url);
    if (!allPdfs.length) return 'ERRO: sem PDF de pacotes cadastrado.';
    const guests = parseGuestCount((conv.bot_data as Json | null)?.convidados);
    const picked = pickPackagePdfs(allPdfs, guests);
    if (picked.needGuests) {
      return 'AINDA NÃO: os pacotes são separados por quantidade de convidados. Pergunte quantos convidados (e registre com registrar_dados_festa) antes de mandar o PDF.';
    }
    const pdf = picked.pdfs[0] || allPdfs[0];
    const id = await sendViaWapiSendId(supabase, 'send-document', instance, conv, {
      mediaUrl: pdf.file_url,
      fileName: pdf.name ? `${pdf.name}.pdf` : 'Pacotes.pdf',
    });
    if (id === null) return 'ERRO: falha ao enviar o PDF. Não diga que mandou; diga que a equipe envia em seguida.';
    const ack = await confirmMaterials(supabase, [{ tipo: 'pacotes', id }]);
    if (ack.unconfirmed.length > 0) return `PENDENTE:${unconfirmedNote(ack.unconfirmed, ack.confirmed)}`;
    await mergeBotData(supabase, conv, { ai_materials_sent: { ...sentMaterials(conv), pacotes: new Date().toISOString() } });
    await markQuoteSent(supabase, instance, conv, phone, contactName);
    return 'OK: PDF de pacotes enviado e confirmado pelo WhatsApp (os valores estão no PDF).';
  }

  return 'ERRO: tipo de material desconhecido.';
}

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// "nov" / "novembro" / "11" → "Novembro" (como o bot fixo grava)
function normalizeMonth(raw: string): string {
  const t = raw.trim().toLowerCase();
  const n = parseInt(t, 10);
  if (!isNaN(n) && n >= 1 && n <= 12 && /^\d{1,2}$/.test(t)) return MONTHS[n - 1].replace(/^./, (c) => c.toUpperCase());
  const found = MONTHS.find((m) => t.startsWith(m.slice(0, 3)) || t.includes(m));
  return found ? found.replace(/^./, (c) => c.toUpperCase()) : raw.trim();
}

// "80" → "80 pessoas" (como o bot fixo grava)
function normalizeGuests(raw: string): string {
  const t = raw.trim();
  return /^\d+$/.test(t) ? `${t} pessoas` : t;
}

// Registra nome/mês/convidados e, quando tem mês + convidados, envia uma vez
// só fotos + vídeo + PDF pela MESMA rotina do bot fixo (qualification-materials.ts),
// respeitando as opções de envio automático do número e pulando o que a IA já mandou.
async function toolRegistrarDados(
  supabase: any,
  instance: AgentInstance,
  conv: AgentConv,
  phone: string,
  contactName: string | null,
  botSettings: any,
  args: { nome?: string; aniversariante?: string; mes?: string; convidados?: string; confraternizacao?: boolean; empresa?: string; legenda_fotos?: string; legenda_video?: string; legenda_pdf?: string },
): Promise<string> {
  const patch: Json = {};
  // Confraternização de empresa (só nos buffets com a opção ligada)
  const corporateNow = conv.__corporateEnabled === true && (args.confraternizacao === true || !!String(args.empresa || '').trim());
  const wasCorporate = ((conv.bot_data || {}) as Json).tipo_evento === 'empresa';
  if (corporateNow) {
    patch.tipo_evento = 'empresa';
    const empresa = String(args.empresa || '').trim().slice(0, 80);
    if (empresa) patch.empresa = empresa;
  }
  const nome = String(args.nome || '').trim();
  if (nome && firstNameOrEmpty(nome)) patch.nome = nome;
  const aniversariante = String(args.aniversariante || '').trim();
  if (aniversariante && firstNameOrEmpty(aniversariante)) patch.aniversariante = aniversariante;
  if (args.mes && String(args.mes).trim()) patch.mes = normalizeMonth(String(args.mes));
  if (args.convidados && String(args.convidados).trim()) patch.convidados = normalizeGuests(String(args.convidados));
  if (Object.keys(patch).length > 0) await mergeBotData(supabase, conv, patch);

  const bd = (conv.bot_data || {}) as Json;
  const leadId = await ensureLead(supabase, instance, conv, phone, contactName, patch.nome as string | undefined);
  if (patch.nome) await saveCustomerName(supabase, conv, patch.nome as string);
  if (corporateNow && !wasCorporate) await markCorporateLead(supabase, instance, conv, leadId, phone);
  if (leadId && (patch.mes || patch.convidados)) {
    const leadPatch: Json = {};
    if (patch.mes) leadPatch.month = patch.mes;
    if (patch.convidados) leadPatch.guests = patch.convidados;
    const { error } = await supabase.from('campaign_leads').update(leadPatch).eq('id', leadId);
    if (error) console.error('[AI Agent] Erro ao salvar mês/convidados no lead:', error.message);
  }

  // Pediu para menos convidados que o menor pacote: a IA explica já nesta resposta
  const materials = await loadSalesMaterials(supabase, instance);
  const minGuests = smallestPackageGuests(materials);
  const askedGuests = parseInt(String(bd.convidados || '').replace(/\D/g, ''), 10);
  const minNote = patch.convidados && minGuests && askedGuests && askedGuests < minGuests
    ? ` IMPORTANTE — explique JÁ NESTA resposta, com naturalidade: o cliente falou em ${askedGuests} convidados, mas o menor pacote é para ${minGuests} pessoas; a equipe explica como fica para um grupo menor. Se ele pediu o valor e já disse o dia, consulte o valor para ${minGuests} convidados e passe nesta mesma resposta (é o valor do pacote mínimo).`
    : '';

  const missing = [!bd.mes && 'mês da festa', !bd.convidados && 'número de convidados'].filter(Boolean);
  if (missing.length > 0) return `OK: dados salvos. Ainda falta descobrir: ${missing.join(' e ')}.${minNote}`;
  if (conv.__deferMaterials) return `OK: dados salvos. As fotos, o vídeo e o PDF vão logo DEPOIS da sua resposta — não diga que já mandou.${minNote}`;
  if (conv.__firstReply) {
    // Primeira resposta: apresentação primeiro, fotos/vídeo/PDF depois dela
    conv.__deferMaterials = true;
    return `OK: dados salvos. As fotos, o vídeo e o PDF vão logo DEPOIS da sua resposta (não diga que já mandou). Escreva a resposta em DUAS partes, separadas por uma linha só com ---: a 1ª (antes dos materiais) se apresenta, responde o que o cliente disse e termina avisando que vai mostrar o espaço (ex.: "Vou te mostrar o nosso espaço 😍👇"); a 2ª (depois do PDF) é UMA frase curta convidando para conhecer o espaço, com os 2 horários de visita livres que você tem (ex.: "Se fizer sentido pra vocês, te recebo pra conhecer o espaço: amanhã às 10h ou quinta às 15h, qual fica melhor? 😊") — se ele já tem visita marcada, pergunte só o que achou. Na 1ª parte, não passe valores nem convide para visita, a menos que o cliente tenha pedido.${minNote}`;
  }
  if (conv.__holdMaterials) return `OK: dados salvos. Ainda não mande materiais: a mensagem do cliente não deixa claro que é sobre a festa — pergunte antes como pode ajudar.${minNote}`;
  return await autoSendMaterials(supabase, instance, conv, phone, contactName, botSettings, args, minNote, askedGuests);
}

const AI_MATERIAL_PACING = { startMs: 2000, photoGapMs: 2000, afterPhotosMs: 4000, afterVideoMs: 5000, typingSeconds: 3 };

// Fotos, vídeo e PDF automáticos (uma vez por conversa), assim que mês e
// convidados são conhecidos — pelo registrar_dados_festa ou já no começo do
// turno (lead do site, que chega com os dados do formulário). Devolve o texto
// para a IA (resultado da ferramenta / aviso no prompt).
async function autoSendMaterials(
  supabase: any,
  instance: AgentInstance,
  conv: AgentConv,
  phone: string,
  contactName: string | null,
  botSettings: any,
  args: { legenda_fotos?: string; legenda_video?: string; legenda_pdf?: string },
  minNote = '',
  askedGuests = NaN,
  out?: { sent: boolean },
): Promise<string> {
  const bd = (conv.bot_data || {}) as Json;
  const materials = await loadSalesMaterials(supabase, instance);
  if (isWithinMaterialWindow(bd.ai_auto_materials_at)) {
    return `OK: dados salvos. Os materiais automáticos já foram enviados antes nesta conversa — não reenvie.${minNote}`;
  }

  // Marca antes de enviar: outra execução concorrente não manda de novo, e as
  // respostas a mensagens que chegarem durante o envio esperam ele terminar
  await mergeBotData(supabase, conv, {
    ai_auto_materials_at: new Date().toISOString(),
    ai_materials_busy_until: new Date(Date.now() + 4 * 60000).toISOString(),
  });
  const inChat = await materialsAlreadyInChat(supabase, conv, materials);
  const flags = sentMaterials(conv);
  const already: Partial<Record<MaterialTipo, string | boolean>> = {
    fotos: flags.fotos || inChat.fotos,
    video: flags.video || inChat.video,
    pacotes: flags.pacotes || inChat.pacotes,
  };
  const settingsForSend = {
    ...(botSettings || {}),
    auto_send_photos: already.fotos ? false : botSettings?.auto_send_photos,
    auto_send_presentation_video: already.video ? false : botSettings?.auto_send_presentation_video,
    auto_send_promo_video: already.video ? false : botSettings?.auto_send_promo_video,
    auto_send_pdf: already.pacotes ? false : botSettings?.auto_send_pdf,
  };
  console.log(`[AI Agent] Mês e convidados conhecidos (${bd.mes}, ${bd.convidados}) — enviando materiais automáticos (conv ${conv.id})`);
  const sentMedia: Array<{ tipo: MaterialTipo; id: string }> = [];
  let result: Awaited<ReturnType<typeof sendQualificationMaterials>>;
  let ack: { confirmed: MaterialTipo[]; unconfirmed: MaterialTipo[] } = { confirmed: [], unconfirmed: [] };
  try {
    result = await sendQualificationMaterials(
      supabase,
      instance,
      conv,
      { nome: String(bd.nome || ''), mes: String(bd.mes), convidados: String(bd.convidados) },
      settingsForSend,
      async (action, payload) => {
        const id = await sendViaWapiSendId(supabase, action, instance, conv, payload);
        if (id !== null && MATERIAL_OF_ACTION[action]) sentMedia.push({ tipo: MATERIAL_OF_ACTION[action], id });
        return id !== null ? 'ok' : null;
      },
      // Legendas da IA, no tom dela (as fixas ficam para o bot fixo)
      await materialTexts(supabase, instance, bd, args),
      // Com calma: "digitando..." antes de cada texto e um respiro entre as fotos
      AI_MATERIAL_PACING,
    );
    // Só conta como enviado o que o WhatsApp confirmou
    if (result.sentAny) ack = await confirmMaterials(supabase, sentMedia);
  } finally {
    await mergeBotData(supabase, conv, { ai_materials_busy_until: null });
  }
  if (!result.sentAny) {
    console.warn(`[AI Agent] Materiais automáticos não enviados (falhas: ${result.failedSteps.join(', ') || 'nenhum material/desligado'})`);
    return `OK: dados salvos. Os materiais automáticos não puderam ser enviados agora; siga a conversa (se o cliente pedir valores, use enviar_materiais).${minNote}`;
  }

  if (out) out.sent = true;
  const nowIso = new Date().toISOString();
  const sentNow: Partial<Record<MaterialTipo, string>> = { ...flags };
  for (const tipo of ack.confirmed) if (!already[tipo]) sentNow[tipo] = nowIso;
  await mergeBotData(supabase, conv, { ai_materials_sent: sentNow });
  if (ack.confirmed.includes('pacotes') && !already.pacotes) await markQuoteSent(supabase, instance, conv, phone, contactName);
  const pdfNote = !minNote && result.pdfGuestCount && askedGuests && askedGuests < result.pdfGuestCount
    ? ` IMPORTANTE — explique JÁ NESTA resposta: o cliente falou em ${askedGuests} convidados e o PDF enviado é o do pacote de ${result.pdfGuestCount} pessoas (a faixa logo acima).`
    : '';
  const skipped = (['fotos', 'video', 'pacotes'] as MaterialTipo[]).filter((k) => already[k]).map((k) => MATERIAL_LABEL[k]);
  const skippedNote = skipped.length > 0 ? ` (${skipped.join(', ')} já tinha(m) sido enviado(s) antes e não foi reenviado.)` : '';
  const confirmedText = ack.confirmed.length > 0 ? ack.confirmed.map((t) => MATERIAL_LABEL[t]).join(', ') : 'nenhum ainda';
  // Ainda sem o DIA da festa: pergunta o dia (para conferir na agenda) antes do convite
  const askDay = ack.confirmed.includes('pacotes') && needsPartyDay(bd);
  if (askDay) await mergeBotData(supabase, conv, { dia_perguntado: new Date().toISOString() });
  const nextStep = askDay
    ? ` Não reenvie nada: comente brevemente e pergunte, de forma natural, se ele já tem um DIA em mente${bd.mes ? ` em ${String(bd.mes).toLowerCase()}` : ''}, para você conferir na agenda se está livre (ex.: "Vocês já têm um dia em mente em dezembro? Assim já confiro aqui na agenda se está livre 😊"). NESTA resposta NÃO convide para visita — o convite vem depois que ele responder o dia.`
    : ' Não reenvie nada: comente brevemente e, se você não convidou para visita nas últimas 3 respostas, convide oferecendo 2 horários concretos.';
  return `OK: dados salvos e os materiais foram enviados agora, automaticamente, com as legendas (confirmados pelo WhatsApp: ${confirmedText}).${skippedNote}${nextStep}${unconfirmedNote(ack.unconfirmed, ack.confirmed)}${minNote}${pdfNote}`;
}

const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function weekdayFromText(text: string): number | null {
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const keys = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  const i = keys.findIndex((k) => t.includes(k));
  return i >= 0 ? i : null;
}

// "🏰 *Castelo* (almoço)"
function quoteName(q: PackageQuote): string {
  const turno = q.shift === 'almoco' ? ' (almoço)' : q.shift === 'jantar' ? ' (noite)' : '';
  return `${packageEmoji(q.packageName)} *${prettyPackageName(q.packageName)}*${turno}`;
}

// "R$ 6.890,00" (com a conta dos adicionais quando passa da faixa)
function quotePrice(q: PackageQuote): string {
  if (q.extraGuests === 0) return formatBRLShort(q.tierPrice);
  if (q.total != null && q.extraUnit != null) {
    return `${formatBRLShort(q.total)} (${formatBRLShort(q.tierPrice)} do pacote de ${q.tier} + ${q.extraGuests} pessoa(s) adicional(is) × ${formatBRLShort(q.extraUnit)})`;
  }
  const sep = [q.adultExtra != null ? `adulto adicional ${formatBRLShort(q.adultExtra)}` : null, q.childExtra != null ? `criança adicional ${formatBRLShort(q.childExtra)}` : null].filter(Boolean).join(', ');
  return `${formatBRLShort(q.tierPrice)} até ${q.tier} convidados${sep ? ` + adicionais (${sep})` : ' + adicionais (a equipe confirma o valor)'}`;
}

// Linha pronta para o cliente: "🏰 *Castelo* — R$ 6.890,00"
function quoteLine(q: PackageQuote): string {
  return `${quoteName(q)} — ${quotePrice(q)}`;
}

// Bloco com o valor antes do preço: "🏰 *Castelo* — {destaques}" + "👉 R$ 6.890,00"
const HIGHLIGHTS = '{destaques}';
function quoteBlock(q: PackageQuote): string {
  return `${quoteName(q)} — ${HIGHLIGHTS}\n👉 ${quotePrice(q)}`;
}

const fmtDateBR = (ymd: string) => formatDateLong(ymd);
const fmtHour = (t: string) => (t.endsWith(':00') ? `${Number(t.slice(0, 2))}h` : t.replace(':', 'h'));

const toolRefsLine = (days: FreeDay[]) => `Para ferramentas (não mostre): ${days.map((d) => `${d.date} → ${d.slots.map((sl) => sl.start).join(', ')}`).join('; ')}`;

// Bloco pronto: "🗓️ Sábado, 5 de dezembro" + "🌙 Noite (19h às 23h)" por horário
function daysBlock(days: FreeDay[]): string {
  return days.map((d) => [formatDayHeader(d.date), ...d.slots.map((sl) => formatSlotRange(sl.start, sl.end))].join('\n')).join('\n');
}


// Agenda da empresa entre duas datas: horários livres por unidade física.
// SÓ LEITURA (festas e pré-reservas).
async function loadFreeSlots(
  supabase: any,
  instance: AgentInstance,
  settings: AiSettings,
  from: string,
  to: string,
): Promise<{ perUnit: Array<{ unit: string | null; free: FreeSlot[] }>; events: number; pre: number }> {
  const [{ data: units }, { data: events }, { data: pre }] = await Promise.all([
    supabase.from('company_units').select('name').eq('company_id', instance.company_id).eq('is_active', true).eq('is_physical', true),
    supabase.from('company_events').select('event_date, start_time, end_time, status, unit')
      .eq('company_id', instance.company_id).gte('event_date', from).lte('event_date', to),
    supabase.from('pre_reservations').select('event_date, unit')
      .eq('company_id', instance.company_id).eq('status', 'ativa')
      .gt('reservation_expires_at', new Date().toISOString())
      .gte('event_date', from).lte('event_date', to),
  ]);
  const slots = parsePartySlots(settings.party_slots);
  // Recesso: sem festas nesses dias
  const closed = parseClosedPeriods(settings.closed_periods);
  const unitNames = ((units || []) as Array<{ name: string }>).map((u) => u.name).filter(Boolean);
  const units_ = unitNames.length > 1 ? unitNames : [unitNames[0] || null];
  return {
    perUnit: units_.map((unit) => ({
      unit,
      free: freePartySlots({ from, to, slots, events: (events || []) as any[], preReservations: (pre || []) as any[], unit, physicalUnits: unitNames })
        .filter((f) => !isClosedDay(f.date, closed)),
    })),
    events: (events || []).length,
    pre: (pre || []).length,
  };
}

interface PartyDateCheck {
  date: string;
  status: 'free' | 'taken' | 'recess';
  alternatives: string | null; // linhas prontas (uma data por bloco), só quando não está livre
}

// Data da festa pedida (formulário do site ou conversa) ainda não conferida
// com o cliente: null quando não há data exata, já passou ou já foi conferida
function pendingPartyDate(conv: AgentConv): string | null {
  const bd = (conv.bot_data || {}) as Json;
  const ymd = typeof bd.data_festa === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(bd.data_festa) ? bd.data_festa as string : null;
  if (!ymd || bd.data_conferida === ymd) return null;
  return ymd > ymdBR(Date.now()) ? ymd : null;
}

// Data conferida (e avisada, se reservada): não confere de novo nem repete o aviso
async function markPartyDateChecked(supabase: any, conv: AgentConv, check: PartyDateCheck): Promise<void> {
  const patch: Json = { data_conferida: check.date, ...(check.status !== 'free' ? { data_ocupada_avisada: check.date } : {}) };
  await mergeBotData(supabase, conv, patch);
  conv.bot_data = { ...(conv.bot_data || {}), ...patch } as Json;
}

// Confere a data da festa na agenda: livre, reservada ou no recesso (com
// datas próximas livres). SÓ LEITURA.
async function checkPartyDate(supabase: any, instance: AgentInstance, settings: AiSettings, ymd: string): Promise<PartyDateCheck> {
  const tomorrow = addDaysYmd(ymdBR(Date.now()), 1);
  const from = addDaysYmd(ymd, -14) < tomorrow ? tomorrow : addDaysYmd(ymd, -14);
  const agenda = await loadFreeSlots(supabase, instance, settings, from, addDaysYmd(ymd, 28));
  if (agenda.perUnit.some((u) => u.free.some((f) => f.date === ymd))) return { date: ymd, status: 'free', alternatives: null };
  const recess = !!closedPeriodAt(ymd, parseClosedPeriods(settings.closed_periods));
  const blocks = agenda.perUnit
    .map(({ unit, free }) => {
      const prio = parseSlotPriority(settings.slot_priority);
      const days = prio ? priorityAlternatives(free, ymd, prio) : nearestAlternativeDays(free, ymd, 3);
      if (days.length === 0) return null;
      return `${agenda.perUnit.length > 1 ? `*Unidade ${unit}*\n` : ''}${daysBlock(days)}`;
    })
    .filter(Boolean) as string[];
  console.log(`[AI Agent] Data da festa ${ymd}: ${recess ? 'recesso' : 'reservada'} — ${blocks.length > 0 ? 'com' : 'sem'} datas próximas livres`);
  return { date: ymd, status: recess ? 'recess' : 'taken', alternatives: blocks.length > 0 ? blocks.join('\n\n') : null };
}

// "O que inclui" de cada pacote ativo, para o prompt (Operações → Pacotes)
async function loadPackagesText(supabase: any, instance: AgentInstance): Promise<string | null> {
  const { data } = await supabase.from('company_packages').select('*')
    .eq('company_id', instance.company_id).eq('is_active', true).order('sort_order', { ascending: true });
  const lines: string[] = [];
  for (const p of (data || []) as Array<{ name: string; description?: string | null; includes?: string | null; ai_quote?: boolean | null }>) {
    if (p.ai_quote === false) continue; // formatura, escolar etc. ficam com a equipe
    const items = String(p.includes || '').split('\n').map((l) => l.replace(/^[-•*\s]+/, '').trim()).filter(Boolean);
    const desc = String(p.description || '').trim();
    if (items.length === 0 && !desc) continue;
    lines.push(`- ${p.name}${desc ? `: ${desc}` : ''}${items.length > 0 ? `\n  Inclui: ${items.join('; ')}` : ''}`);
  }
  const text = lines.join('\n');
  // Conferência: quais pacotes a IA recebeu e com quantos itens
  const summary = ((data || []) as Array<{ name: string; includes?: string | null; ai_quote?: boolean | null }>)
    .map((p) => p.ai_quote === false ? `${p.name} (fora da IA)` : `${p.name} (${String(p.includes || '').split('\n').filter((l) => l.trim()).length} itens)`).join(', ');
  console.log(`[AI Agent] Pacotes lidos para a IA: ${summary || 'nenhum ativo'}${/R\$/.test(text) ? ' — atenção: "O que inclui" tem valores em R$ (a IA não pode citar)' : ''}`);
  // Os três pacotes do Castelo juntos passam de 3.300 caracteres: limite folgado
  return text ? text.slice(0, 12000) : null;
}

// Datas e horários livres na agenda (festas + pré-reservas). SÓ LEITURA.
async function toolConsultarDatas(
  supabase: any,
  instance: AgentInstance,
  settings: AiSettings,
  args: { mes?: string; data?: string; dia_semana?: string; preferencia?: string },
  conv?: AgentConv,
): Promise<string> {
  const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  const tomorrow = addDaysYmd(today, 1);
  const preferredDow = args.dia_semana ? weekdayFromText(String(args.dia_semana)) : null;
  const pref = String(args.preferencia || '').toLowerCase();
  const preferredDows = preferredDow !== null ? [preferredDow]
    : /fim/.test(pref) ? [6, 0] // fim de semana: sábado e domingo (o simulador pegou sexta oferecida como fim de semana)
    : /semana|util|útil/.test(pref) ? [1, 2, 3, 4, 5] : [];
  // Lista de datas do mês sem saber a preferência: pergunta antes (o simulador
  // pegou a IA listando direto). Data específica não precisa.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args.data || '')) && preferredDows.length === 0) {
    return 'ANTES DE LISTAR DATAS: pergunte ao cliente se ele prefere fim de semana ou dia de semana (ou um dia específico). Não liste datas nesta resposta; depois consulte de novo com preferencia ou dia_semana.';
  }
  let from: string;
  let to: string;
  let askedDate: string | null = null;
  const dateMatch = String(args.data || '').match(/^\d{4}-\d{2}-\d{2}$/);
  if (dateMatch) {
    askedDate = String(args.data);
    if (askedDate < tomorrow) return `DATA JÁ PASSOU OU É HOJE (${askedDate}): confirme a data com o cliente.`;
    from = addDaysYmd(askedDate, -14) < tomorrow ? tomorrow : addDaysYmd(askedDate, -14);
    to = addDaysYmd(askedDate, 28);
  } else {
    const month = args.mes ? monthFromText(String(args.mes)) : null;
    if (!month) return 'FALTA O MÊS: pergunte o mês (ou a data) da festa antes de consultar a agenda.';
    const yearInText = String(args.mes || '').match(/\b(20\d{2})\b/);
    ({ from, to } = monthRange(month, today, yearInText ? Number(yearInText[1]) : null));
    if (from < tomorrow) from = tomorrow;
    if (from > to) return 'ESSE MÊS JÁ ESTÁ NO FIM: pergunte se a festa é para o mesmo mês do ano que vem ou para outro mês.';
  }

  // Unidade física da festa: com mais de uma, a agenda é olhada por unidade
  const agenda = await loadFreeSlots(supabase, instance, settings, from, to);
  const perUnit = agenda.perUnit;
  const rules = 'Use as linhas prontas como estão (uma data por bloco, horários embaixo, sem negrito). Fale "tenho o sábado, 5 de dezembro, disponível" — nunca "tem festa" nessa data. No final, curto e entre parênteses: "(A data fica garantida com contrato e sinal ✨)". NUNCA diga que reservou, segurou ou bloqueou a data. Quando o cliente escolher uma data, use consultar_valor_pacote com a data e o horário da linha "Para ferramentas".';
  const toolRefs = toolRefsLine;

  const blocks: string[] = [];
  for (const { unit, free } of perUnit) {
    const label = perUnit.length > 1 ? `Unidade ${unit}: ` : '';
    if (askedDate) {
      const onDay = pickPartyDates(free.filter((f) => f.date === askedDate), [], 1);
      const prio = parseSlotPriority(settings.slot_priority);
      const others = prio
        ? priorityAlternatives(free, askedDate, prio)
        : pickPartyDates(free.filter((f) => f.date !== askedDate), [weekdayOf(askedDate)], 3);
      const recess = closedPeriodAt(askedDate, parseClosedPeriods(settings.closed_periods));
      blocks.push(onDay.length > 0
        ? `${label}${formatDateLong(askedDate)} — disponível neste momento. Linhas prontas:\n${daysBlock(onDay)}\n${toolRefs(onDay)}`
        : `${label}${formatDateLong(askedDate)} ${recess ? `cai no RECESSO do buffet (fechado ${formatClosedPeriod(recess, today)}, sem festas) — explique isso com gentileza.` : 'está OCUPADO.'} Datas próximas disponíveis neste momento — linhas prontas:\n${others.length > 0 ? `${daysBlock(others)}\n${toolRefs(others)}` : '(nenhuma nas semanas próximas — passe para a equipe)'}`);
    } else {
      const prio = parseSlotPriority(settings.slot_priority);
      const days = prio ? priorityMonthDates(free, preferredDows, prio, 3) : pickPartyDates(free, preferredDows, 3);
      blocks.push(days.length > 0
        ? `${label}Datas disponíveis neste momento (no máximo estas) — linhas prontas:\n${daysBlock(days)}\n${toolRefs(days)}${preferredDows.length > 0 && !days.some((d) => preferredDows.includes(d.dow)) ? '\n(nenhuma data no dia preferido nesse mês — diga isso e ofereça estas)' : ''}`
        : `${label}Nenhum horário livre nesse período — ofereça outro mês ou passe para a equipe.`);
    }
  }
  console.log(`[AI Agent] Consulta de agenda (${askedDate || `${from}..${to}`}): ${agenda.events} festa(s), ${agenda.pre} pré-reserva(s)`);
  // A própria IA já conferiu esta data com o cliente: o sistema não repete
  if (askedDate && conv) {
    const busy = !perUnit.some((u) => u.free.some((f) => f.date === askedDate));
    const bd = (conv.bot_data || {}) as Json;
    // Data pedida estava reservada e ele olhou outra, livre: passa a ser a data da festa
    if (!busy && bd.data_festa !== askedDate && (bd.data_ocupada_avisada === bd.data_festa || (!bd.data_festa && bd.dia_perguntado))) {
      await mergeBotData(supabase, conv, { data_festa: askedDate });
      conv.bot_data = { ...bd, data_festa: askedDate } as Json;
    }
    await markPartyDateChecked(supabase, conv, { date: askedDate, status: busy ? 'taken' : 'free', alternatives: null });
  }
  return `AGENDA (só consulta, nada foi reservado):\n${blocks.join('\n\n')}\n${rules}`;
}

const OTHER_EVENT_INSTRUCTION = 'OUTRO TIPO DE EVENTO (não é aniversário): NÃO passe valor nem fale de pacotes. Pergunte o que faltar entre tipo de evento, data e quantidade de pessoas e então use transferir_para_atendente com o motivo no formato "Evento: … | Data: … | Pessoas: …".';

// Valor do pacote pela "Grade de preços por faixa" (Operações → Pacotes)
async function toolConsultarValor(
  supabase: any,
  instance: AgentInstance,
  settings: AiSettings,
  conv: AgentConv,
  phone: string,
  contactName: string | null,
  args: { convidados?: string; data?: string; dia_semana?: string; pacote?: string; horario?: string },
): Promise<string> {
  const bd = (conv.bot_data || {}) as Json;
  const guests = parseInt(String(args.convidados || bd.convidados || '').replace(/\D/g, ''), 10);
  if (!guests) return 'FALTA A QUANTIDADE: pergunte quantos convidados o cliente espera antes de informar qualquer valor.';
  const { data: company } = await supabase.from('companies').select('settings').eq('id', instance.company_id).maybeSingle();
  const localHolidays = localHolidaysFrom((company?.settings || null) as any);

  // Data da festa já combinada nesta conversa: vale de novo quando a IA pede
  // outro valor sem dizer o dia (no simulador ela trocou o feriado 12/10 por "domingo")
  const savedDate = typeof bd.data_festa === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(bd.data_festa) ? bd.data_festa as string : null;
  const todayYmd = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  // (data já avisada como reservada não vale: o cliente vai escolher outra)
  if (!args.data && savedDate && savedDate >= todayYmd && !args.dia_semana && bd.data_ocupada_avisada !== savedDate) args = { ...args, data: savedDate };

  let day: PartyDay | null = null;
  let dayText = '';
  let holidayNote = '';
  const dateMatch = String(args.data || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    const [y, m, d] = [Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3])];
    const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    if (String(args.data) < today) return `DATA JÁ PASSOU (${args.data}): confirme com o cliente a data/ano da festa antes de informar valor.`;
    day = { dow: weekdayYmd(y, m, d), holiday: isHolidayYmd(y, m, d, localHolidays), holidayEve: isHolidayEveYmd(y, m, d, localHolidays) };
    const hName = day.holiday ? holidayName(y, m, d, localHolidays) : null;
    dayText = `${formatDateLong(String(args.data))}${day.holiday ? ` (feriado${hName ? `: ${hName}` : ''})` : day.holidayEve ? ' (véspera de feriado)' : ''}`;
  } else if (args.dia_semana && weekdayFromText(String(args.dia_semana)) !== null) {
    day = { dow: weekdayFromText(String(args.dia_semana)) as number };
    dayText = WEEKDAYS[day.dow];
    holidayNote = ` É o valor de ${dayText} normal: se a data cair em feriado ou véspera de feriado, o valor pode ser outro — diga isso ao cliente.`;
  }
  if (!day) return 'FALTA O DIA: pergunte o dia da semana (ou a data) da festa antes de informar qualquer valor.';

  // Horário de início fora do padrão (ex.: 20h com a noite das 19h às 23h):
  // vale o horário da agenda que contém essa hora; a IA incentiva o padrão e,
  // se o cliente insistir, a equipe confirma (às vezes fazem, mas não divulgam)
  let customStartNote = '';
  const askedHour = parseInt(String(args.horario || '').replace(/\D.*$/, ''), 10);
  const partySlots = parsePartySlots(settings.party_slots);
  if (!isNaN(askedHour) && partySlots.length > 0 && !partySlots.some((sl) => Number(sl.start.slice(0, 2)) === askedHour)) {
    const within = partySlots.find((sl) => askedHour >= Number(sl.start.slice(0, 2)) && askedHour < Number(sl.end.slice(0, 2) || 24));
    const standard = within ? formatSlotRange(within.start, within.end) : partySlots.map((sl) => formatSlotRange(sl.start, sl.end)).join(' ou ');
    customStartNote = ` HORÁRIO DE INÍCIO DIFERENTE: o cliente pediu para começar às ${askedHour}h. Nosso horário de festa é ${standard}: NÃO diga que não dá — apresente esse horário com entusiasmo e incentive-o. Se o cliente insistir em começar às ${askedHour}h, use transferir_para_atendente (motivo: "pediu início às ${askedHour}h") para a equipe confirmar.`;
    args = { ...args, horario: within ? within.start : undefined };
  }

  // Data específica: confere a agenda ANTES de dar o valor (horário ocupado não tem preço)
  let freeHours: string[] | null = null;
  if (dateMatch) {
    const date = String(args.data);
    const agenda = await loadFreeSlots(supabase, instance, settings, addDaysYmd(date, -14), addDaysYmd(date, 28));
    const free = agenda.perUnit.flatMap((u) => u.free);
    const onDay = free.filter((f) => f.date === date);
    const wantHour = parseInt(String(args.horario || '').replace(/\D.*$/, ''), 10);
    const wanted = isNaN(wantHour) ? onDay : onDay.filter((f) => Number(f.slot.start.slice(0, 2)) === wantHour);
    if (wanted.length === 0) {
      const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
      // 2–3 opções: outro horário no mesmo dia + o mesmo dia da semana nas
      // próximas semanas (de preferência no horário pedido). Antes vinha só o
      // outro horário do mesmo dia (achado do simulador).
      const sameDow = free.filter((f) => f.date > today && f.date !== date && weekdayOf(f.date) === weekdayOf(date));
      const sameHour = isNaN(wantHour) ? sameDow : sameDow.filter((f) => Number(f.slot.start.slice(0, 2)) === wantHour);
      const prio = parseSlotPriority(settings.slot_priority);
      const others = prio
        ? priorityAlternatives(free.filter((f) => f.date > today), date, prio, { wantStart: isNaN(wantHour) ? null : `${String(wantHour).padStart(2, '0')}:00`, max: onDay.length > 0 ? 2 : 3 })
        : pickPartyDates(sameHour.length > 0 ? sameHour : sameDow, [], 3);
      // Com a ordem de venda, mantém os que menos vendem na frente
      const nearest = [...(onDay.length > 0 ? pickPartyDates(onDay, [], 1) : []), ...others]
        .slice(0, 3)
        .sort((x, y) => (prio ? 0 : x.date.localeCompare(y.date)));
      const recess = closedPeriodAt(date, parseClosedPeriods(settings.closed_periods));
      const what = recess
        ? `${fmtDateBR(date)} cai no RECESSO do buffet (fechado ${formatClosedPeriod(recess, today)}, sem festas)`
        : isNaN(wantHour) ? `${fmtDateBR(date)} está OCUPADO` : `${fmtDateBR(date)}, ${formatSlotLabel(`${String(wantHour).padStart(2, '0')}:00`)}, está OCUPADO`;
      console.log(`[AI Agent] Valor pedido para horário ocupado (${date} ${args.horario || 'dia todo'}) — oferecendo alternativas`);
      if (onDay.length === 0) await markPartyDateChecked(supabase, conv, { date, status: recess ? 'recess' : 'taken', alternatives: null });
      return `${what} na agenda: NÃO informe valor para esse horário. Avise o cliente e ofereça o(s) horário(s) livre(s) mais próximo(s) (disponível neste momento) — linhas prontas:\n${nearest.length > 0 ? `${daysBlock(nearest)}\n${toolRefsLine(nearest)}` : '(nenhum nas semanas próximas — passe para a equipe)'}\nSe ele escolher um deles, consulte o valor de novo com a nova data/horário.`;
    }
    freeHours = wanted.map((f) => f.slot.start);
    if (bd.data_festa !== date) {
      await mergeBotData(supabase, conv, { data_festa: date });
      conv.bot_data = { ...(conv.bot_data || {}), data_festa: date } as Json;
    }
    if (bd.data_conferida !== date) await markPartyDateChecked(supabase, conv, { date, status: 'free', alternatives: null });
  }

  const [{ data: packages }, { data: tiers }] = await Promise.all([
    // select('*'): ai_quote pode ainda não existir (migration não rodada)
    supabase.from('company_packages').select('*')
      .eq('company_id', instance.company_id).eq('is_active', true).order('sort_order', { ascending: true }),
    supabase.from('package_price_tiers').select('package_id, guest_count, day_type, price').eq('company_id', instance.company_id),
  ]);
  const allPkgs = (packages || []) as any[];
  // Só os pacotes que a IA pode cotar (ai_quote). Os outros (formatura, escolar...) são com a equipe.
  let pkgs = allPkgs.filter((p) => p.ai_quote !== false);
  const wanted = String(args.pacote || '').trim().toLowerCase();
  if (wanted && allPkgs.some((p) => p.ai_quote === false && String(p.name).toLowerCase().includes(wanted))) {
    return OTHER_EVENT_INSTRUCTION;
  }
  if (wanted) {
    const exact = pkgs.filter((p) => String(p.name).toLowerCase() === wanted);
    const partial = pkgs.filter((p) => String(p.name).toLowerCase().includes(wanted));
    if (exact.length > 0) pkgs = exact;
    else if (partial.length > 0) pkgs = partial;
  }
  let quotes = quotePackages(pkgs, (tiers || []) as any[], (company?.settings || null) as any, guests, day);
  // Horário escolhido (ou o único livre no dia): a grade pode separar almoço (antes das 16h) e jantar
  const hour = parseInt(String(args.horario || (freeHours?.length === 1 ? freeHours[0] : '')).replace(/\D.*$/, ''), 10);
  if (!isNaN(hour) && quotes.some((q) => q.shift)) {
    const shift = hour < 16 ? 'almoco' : 'jantar';
    const byShift = quotes.filter((q) => q.shift === shift);
    if (byShift.length > 0) quotes = byShift;
  }
  console.log(`[AI Agent] Consulta de valor (${guests} convidados, ${dayText}): ${quotes.length} valor(es) na tabela`);
  if (quotes.length === 0) {
    return 'SEM VALOR NA TABELA para essa quantidade/dia: não informe valor. Envie o PDF de pacotes (enviar_materiais, tipo "pacotes") ou diga que a equipe passa o valor.';
  }

  conv.__quotedValues = [...(conv.__quotedValues || []), ...quotes.flatMap((q) => [q.tierPrice, q.total, q.extraUnit, q.adultExtra, q.childExtra].filter((v): v is number => typeof v === 'number'))];
  await markQuoteSent(supabase, instance, conv, phone, contactName, 'valor da tabela informado pela IA');

  const minTier = Math.min(...quotes.map((q) => q.tier));
  const minNote = guests < minTier ? ` O cliente falou em ${guests} convidados, mas a menor faixa da tabela é de ${minTier}: explique que o valor é o do pacote de ${minTier} pessoas.` : '';
  const betweenNote = quotes.some((q) => q.tier > guests && guests >= minTier) ? ` Para ${guests} convidados vale a faixa de ${quotes[0].tier} (a tabela é por faixa).` : '';
  const freeNote = freeHours && !args.horario
    ? ` Nesse dia, disponível neste momento: ${freeHours.map((h) => formatSlotLabel(h)).join(' ou ')} — diga isso junto com o valor.`
    : '';
  const tierInfo = Array.from(new Set(quotes.map((q) => `${prettyPackageName(q.packageName)}: faixa de ${q.tier} convidados, coluna "${q.dayTypeLabel}"`))).join('; ');
  // Com o "o que inclui" cadastrado, o preço vem depois do que o pacote
  // entrega (gera valor antes do número)
  const header = `VALORES DA TABELA para ${guests} convidados, ${dayText}${args.horario ? `, ${formatSlotLabel(String(args.horario))}` : ''}.`;
  const lines = (await loadPackagesText(supabase, instance))
    ? `${header} COMO PASSAR (valor antes do preço): comece com 1 frase curta com o que TODOS os pacotes têm em comum (do cadastro O QUE CADA PACOTE INCLUI). Depois copie os blocos abaixo, com uma linha em branco entre eles, trocando ${HIGHLIGHTS} pelos destaques do cadastro: no primeiro pacote, os 4 ou 5 itens principais; nos seguintes, "tudo do [pacote anterior] + " e só o que ele tem a mais (até 5 itens). A linha do 👉 com o preço fica exatamente como está (sem arredondar nem somar nada). Só cite o que está no cadastro. Depois dos blocos, siga com a data/horário e o próximo passo (data, visita) — não pergunte se ele quer saber o que muda entre os pacotes, isso já foi mostrado.\n${quotes.map(quoteBlock).join('\n\n')}`
    : `${header} Linhas prontas para o cliente (copie como estão, um pacote por linha, sem arredondar nem somar nada):\n${quotes.map(quoteLine).join('\n')}`;
  return `${lines}\n(Só para você: ${tierInfo}.)${minNote}${betweenNote}${holidayNote}${freeNote}${customStartNote} Se o cliente pedir a diferença entre dois pacotes, pode dizer a diferença exata (um valor menos o outro) — não passe para a equipe por isso. PROIBIDO oferecer ou prometer desconto, condição à vista, parcelamento, brinde ou entrada diferente: se o cliente pedir, diga que as condições de pagamento e o fechamento são com a equipe.`.trim();
}

// Legendas antes de fotos/vídeo/PDF quando a IA envia o material: as que ela
// escreveu (sem valores) ou, se faltar, um modelo animado com o que já se sabe.
async function materialTexts(
  supabase: any,
  instance: AgentInstance,
  bd: Json,
  args: { legenda_fotos?: string; legenda_video?: string; legenda_pdf?: string },
): Promise<{ photosIntro: string; videoCaption: string; pdfIntro: string }> {
  const clean = (t: unknown) => {
    const v = String(t || '').trim();
    return v && v.length <= 300 && moneyValuesIn(v).length === 0 && !/sistema/i.test(v) ? v : '';
  };
  let companyName = instance.unit || '';
  const { data: company } = await supabase.from('companies').select('name').eq('id', instance.company_id).maybeSingle();
  if (company?.name) companyName = company.name as string;
  const nome = firstNameOrEmpty(bd.nome as string);
  const child = firstNameOrEmpty(bd.aniversariante as string);
  const guests = parseInt(String(bd.convidados || '').replace(/\D/g, ''), 10);
  // Menos convidados que o menor pacote: a legenda não fala "pacotes pra 30" mandando o PDF de 50
  const minGuests = smallestPackageGuests(await loadSalesMaterials(supabase, instance));
  const belowMin = !!(minGuests && guests && guests < minGuests);
  if (bd.tipo_evento === 'empresa') {
    // Empresa: legendas da IA só se não falarem de aniversário/criançada
    const corp = corporateCaptions({ firstName: nome, companyName, guests: guests || null });
    const ok = (t: unknown) => { const v = clean(t); return v && !birthdayFlavored(v) ? v : ''; };
    return {
      photosIntro: ok(args.legenda_fotos) || corp.photosIntro,
      videoCaption: ok(args.legenda_video) || corp.videoCaption,
      pdfIntro: belowMin ? `E aqui estão os nossos pacotes, a partir de ${minGuests} pessoas 📋✨` : ok(args.legenda_pdf) || corp.pdfIntro,
    };
  }
  return {
    photosIntro: clean(args.legenda_fotos)
      // "do Murilo" / "da Lívia" depende do gênero, que não sabemos: frase neutra
      || `${nome ? `Aaah, ${nome}, olha` : 'Olha'} só o espaço que vai ser todinho de vocês no dia da festa! 😍${venueEmoji(companyName)} Já imaginou ${child ? `a carinha de ${child}` : 'a criançada'} chegando e vendo tudo isso preparado? ✨`,
    videoCaption: clean(args.legenda_video) || `E agora olha o ${companyName} em dia de festa: brinquedos, monitores e muita diversão 🎬🎉`,
    pdfIntro: belowMin
      ? `E aqui estão os nossos pacotes, a partir de ${minGuests} convidados 📋✨`
      : clean(args.legenda_pdf) || `E aqui estão os nossos pacotes${guests ? ` pra ${guests} convidados` : ''} 📋✨`,
  };
}

// Passagem para a equipe: tira a IA da conversa, registra no histórico do
// lead com o motivo e avisa a equipe no sininho.
async function toolTransferir(
  supabase: any,
  instance: AgentInstance,
  conv: AgentConv,
  phone: string,
  contactName: string | null,
  settings: AiSettings | null,
  motivo: string,
  assunto = '',
  funcoes = '',
): Promise<string> {
  const reason = (motivo || '').trim() || 'sem motivo informado';
  // Já passada para a equipe (IA atendendo fora do horário): não repete aviso
  if (conv.bot_step === 'human_takeover' && (conv.bot_data as Json | null)?.ai_handoff) {
    const hoursText = settings ? ` ${teamHoursMessage(settings)}` : '';
    return `JÁ TRANSFERIDA: a conversa já está com a equipe.${hoursText} Diga isso ao cliente e continue ajudando com dúvidas informativas.`;
  }
  conv.__handoffThisTurn = true;
  await supabase.from('wapi_conversations').update({
    bot_enabled: false,
    bot_step: 'human_takeover',
    unread_count: 99,
  }).eq('id', conv.id);
  conv.bot_enabled = false;
  conv.bot_step = 'human_takeover';
  console.log(`[AI Agent] Transferred conv ${conv.id} to human. Motivo: ${reason}`);

  // Quem não quer orçamento não vira lead de venda: quem quer trabalhar vai
  // para "Trabalhe Conosco", quem já tem festa vira "cliente retorno" (igual
  // ao bot fixo) e fornecedor não entra no funil
  const leadId = assunto === 'fornecedor'
    ? null
    : (assunto === 'trabalhar' || assunto === 'cliente_com_festa')
    ? await ensureSpecialLead(supabase, instance, conv, phone, contactName, assunto).catch(() => null)
    : await ensureLead(supabase, instance, conv, phone, contactName).catch(() => null);
  let leadName = contactName || phone;
  if (leadId) {
    const { data: lead } = await supabase.from('campaign_leads').select('name').eq('id', leadId).maybeSingle();
    if (lead?.name) leadName = lead.name as string;
    await supabase.from('lead_history').insert({
      lead_id: leadId,
      company_id: instance.company_id,
      user_id: null,
      user_name: 'IA (beta)',
      action: 'Transferido para a equipe',
      new_value: `Motivo: ${reason}`,
    }).then(({ error: hErr }: { error: unknown }) => { if (hErr) console.error('[AI Agent] lead_history error:', hErr); });
  }

  // Marca da passagem: o follow-up-check usa para disparar o alerta forte se
  // ninguém da equipe responder em X minutos dentro do horário de atendimento.
  // "at" é renovado depois da última mensagem da IA neste turno.
  // Currículo e fornecedor não são urgentes: sem alerta forte no WhatsApp do dono
  const urgent = assunto !== 'trabalhar' && assunto !== 'fornecedor';
  // Quer trabalhar e o buffet tem o formulário de candidatura: a Bia manda o
  // link (já com nome, WhatsApp e funções) e a equipe só é avisada quando o
  // formulário chegar (pop-up "Novo candidato") — nada de pedir currículo
  const candidateLink = assunto === 'trabalhar'
    ? await candidateFormLink(supabase, instance, conv, phone, contactName, funcoes).catch(() => null)
    : null;
  await mergeBotData(supabase, conv, {
    ai_handoff: { at: new Date().toISOString(), reason, lead_name: leadName, lead_id: leadId, alerted_at: urgent ? null : 'nao_urgente', assunto: assunto || null, ...(candidateLink ? { candidatura_link: candidateLink } : {}) },
  });
  if (candidateLink) {
    conv.__candidateLink = candidateLink;
    console.log(`[AI Agent] Quer trabalhar: link do cadastro de candidatos vai na resposta (conv ${conv.id})`);
    if (leadId) {
      await supabase.from('lead_history').insert({
        lead_id: leadId,
        company_id: instance.company_id,
        user_id: null,
        user_name: 'IA (beta)',
        action: 'Link do cadastro de candidatos enviado',
        new_value: funcoes ? `Funções: ${funcoes}` : null,
      }).then(({ error: hErr }: { error: unknown }) => { if (hErr) console.error('[AI Agent] lead_history error:', hErr); });
    }
    return 'OK: o cadastro de candidatos está pronto — o sistema coloca o link sozinho no fim da sua mensagem (NÃO escreva link nenhum). Agradeça o interesse com simpatia e diga que é só preencher o cadastro rapidinho pelo link abaixo (leva uns 2 minutinhos, o nome e o WhatsApp já vão preenchidos); se o perfil combinar, a equipe chama por aqui. NÃO peça currículo, NÃO fale de pacotes, valores nem visita e NÃO escreva horário nenhum.';
  }

  await notifyTeam(supabase, instance, {
    title: assunto === 'trabalhar' ? '👷 Interesse em trabalhar na empresa'
      : assunto === 'fornecedor' ? '📦 Fornecedor / proposta comercial'
      : assunto === 'cliente_com_festa' ? '🎉 Cliente com festa marcada precisa da equipe'
      : '🤝 IA passou a conversa para a equipe',
    message: `${leadName} (${instance.unit || 'WhatsApp'}) — motivo: ${reason}. Assuma o atendimento.`,
    data: { conversation_id: conv.id, lead_id: leadId, contact_phone: phone, unit: instance.unit, reason: 'ai_handoff', motivo: reason },
  });
  const noHours = 'NÃO escreva horário nenhum: o sistema acrescenta sozinho, no fim da sua mensagem, o horário de atendimento da equipe.';
  if (assunto === 'trabalhar') return `OK: passado para a equipe (RH). Agradeça o interesse com simpatia e peça para a pessoa enviar o currículo aqui mesmo nesta conversa — a equipe analisa. NÃO fale de pacotes, valores nem visita. ${noHours}`;
  if (assunto === 'fornecedor') return `OK: passado para a equipe responsável. Agradeça com simpatia e diga que a equipe vai avaliar e retorna se tiver interesse. NÃO fale de pacotes, valores nem visita. ${noHours}`;
  if (assunto === 'cliente_com_festa') return `OK: passado para a equipe que cuida das festas. Diga com carinho que um atendente vai continuar por aqui para ajudar com a festa dele. NÃO fale de pacotes, valores, promoção nem visita. ${noHours}`;
  return `OK: conversa transferida para a equipe. Avise o cliente que um atendente vai continuar por aqui. ${noHours}`;
}

// Link do formulário de candidatura da empresa (ativo, com slug, no domínio
// do buffet). Curto (www.buffet.com.br/trabalhe/k7m2qx, com nome/WhatsApp/
// funções guardados no código); sem a tabela dos links curtos, o link longo.
// Sem formulário ou sem domínio: null (a Bia pede o currículo, como antes)
async function candidateFormLink(
  supabase: any,
  instance: AgentInstance,
  conv: AgentConv,
  phone: string,
  contactName: string | null,
  funcoes: string,
): Promise<string | null> {
  const [{ data: tpl }, { data: company }] = await Promise.all([
    supabase.from('freelancer_templates').select('id, slug').eq('company_id', instance.company_id).eq('purpose', 'candidatura').eq('is_active', true).not('slug', 'is', null).order('created_at', { ascending: true }).limit(1).maybeSingle(),
    supabase.from('companies').select('slug, custom_domain').eq('id', instance.company_id).maybeSingle(),
  ]);
  if (!tpl?.slug || !company?.slug || !company?.custom_domain) return null;
  const botName = (conv.bot_data as Json | null)?.nome as string | undefined;
  const name = (botName && firstNameOrEmpty(botName)) ? botName : contactName;
  const roles = String(funcoes || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = inviteCode(crypto.getRandomValues(new Uint8Array(6)));
    // Qualquer falha aqui (tabela ainda não criada, trava de escrita) vira o link longo
    const { error } = await Promise.resolve().then(() => supabase.from('freelancer_invites').insert({
      code,
      company_id: instance.company_id,
      template_id: tpl.id,
      name: candidateName(name) || null,
      phone: phone.replace(/\D/g, '') || null,
      roles: roles || null,
      source: 'bia',
      conversation_id: conv.id,
    })).catch((err: unknown) => ({ error: { code: 'thrown', message: String(err) } }));
    if (!error) return shortCandidateLink(company.custom_domain as string, code);
    if (error.code !== '23505') { // código repetido: tenta outro; outro erro: link longo
      console.warn('[AI Agent] Link curto do cadastro indisponível, vai o longo:', error.message);
      break;
    }
  }
  return buildCandidateLink({
    domain: company.custom_domain as string,
    companySlug: company.slug as string,
    templateSlug: tpl.slug as string,
    name,
    phone,
    roles,
  });
}

// Lead de quem não quer orçamento (mesmo formato do bot fixo): reaproveita o
// lead que já existe com esse telefone; senão cria em "Trabalhe Conosco" ou
// como "cliente retorno"
async function ensureSpecialLead(
  supabase: any,
  instance: AgentInstance,
  conv: AgentConv,
  phone: string,
  contactName: string | null,
  assunto: 'trabalhar' | 'cliente_com_festa',
): Promise<string | null> {
  if (conv.lead_id) return conv.lead_id;
  const clean = phone.replace(/\D/g, '');
  const existing = await findLeadByPhone<{ id: string }>(supabase, instance.company_id, clean, 'id');
  if (existing) {
    await supabase.from('wapi_conversations').update({ lead_id: existing.id }).eq('id', conv.id);
    conv.lead_id = existing.id;
    return existing.id;
  }
  const work = assunto === 'trabalhar';
  const botName = (conv.bot_data as Json | null)?.nome as string | undefined;
  const { data: newLead } = await supabase.from('campaign_leads').insert({
    name: (botName && firstNameOrEmpty(botName)) ? botName : (contactName || clean),
    whatsapp: clean.startsWith('55') ? clean : `55${clean}`,
    unit: work ? 'Trabalhe Conosco' : instance.unit,
    campaign_id: work ? 'ai-agent-rh' : 'ai-agent-cliente',
    campaign_name: work ? 'WhatsApp (IA) - RH' : 'WhatsApp (IA) - Cliente',
    status: work ? 'trabalhe_conosco' : 'cliente_retorno',
    company_id: instance.company_id,
    ...(work ? {} : { observacoes: 'Cliente com festa marcada - falou com a IA pelo WhatsApp' }),
  }).select('id').single();
  if (newLead?.id) {
    await supabase.from('wapi_conversations').update({ lead_id: newLead.id }).eq('id', conv.id);
    conv.lead_id = newLead.id as string;
  }
  return conv.lead_id || null;
}

// Depois da última mensagem da IA num turno com passagem: renova a marca para
// que só respostas da equipe DEPOIS dela contem.
async function touchHandoffMark(supabase: any, conv: AgentConv): Promise<void> {
  const handoff = (conv.bot_data as Json | null)?.ai_handoff as Json | undefined;
  if (!handoff || conv.bot_step !== 'human_takeover' || !conv.__handoffThisTurn) return;
  await mergeBotData(supabase, conv, { ai_handoff: { ...handoff, at: new Date().toISOString() } });
}

// Alguém da equipe escreveu na conversa depois da passagem? (mensagens da IA,
// follow-up e avisos do sistema não contam)
async function teamRepliedSince(supabase: any, convId: string, sinceIso: string): Promise<boolean> {
  const { data } = await supabase
    .from('wapi_messages')
    .select('from_me, timestamp, metadata')
    .eq('conversation_id', convId)
    .eq('from_me', true)
    .gt('timestamp', sinceIso)
    .limit(30);
  return teamRepliedAfter((data || []) as Array<{ from_me: boolean; timestamp: string; metadata: Record<string, unknown> | null }>, sinceIso);
}

async function latestIncomingId(supabase: any, convId: string): Promise<string | null> {
  const { data } = await supabase
    .from('wapi_messages')
    .select('message_id, timestamp')
    .eq('conversation_id', convId)
    .eq('from_me', false)
    .order('timestamp', { ascending: false })
    .limit(5);
  return pickLatestIncoming((data || []) as Array<{ message_id: string | null; timestamp: string }>);
}

// Fotos/vídeo/PDF automáticos sendo enviados: espera terminar antes de
// responder, para a resposta não cair no meio dos materiais.
async function waitMaterialsIdle(supabase: any, convId: string, maxMs = 120000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const { data } = await supabase.from('wapi_conversations').select('bot_data').eq('id', convId).maybeSingle();
    const busyUntil = (data?.bot_data as Json | null)?.ai_materials_busy_until;
    if (typeof busyUntil !== 'string' || Date.parse(busyUntil) <= Date.now()) return;
    await sandboxSleep(3000);
  }
}

const TEST_RESTART_COMMAND = '#reiniciar';

// Transcreve o áudio / descreve a foto que acabou de chegar e guarda o texto
// na própria mensagem, para a IA e para as próximas respostas.
async function processIncomingMedia(
  supabase: any,
  instance: AgentInstance,
  conv: AgentConv,
  media: AgentMedia,
  openaiKey: string | null,
  isTest: boolean,
): Promise<void> {
  if (!openaiKey) {
    console.error('[AI Agent] OPENAI_API_KEY ausente — não dá para ouvir áudio / ver foto');
    return;
  }
  const url = await media.url.catch(() => null);
  if (!url) {
    console.warn(`[AI Agent] ${media.type} sem link para baixar (msg ${media.messageId})`);
    return;
  }
  const file = await fetchMediaBytes(url);
  if (!file) return;
  const result = media.type === 'audio'
    ? await transcribeAudio(openaiKey, file.bytes, file.mime)
    : await describeImage(openaiKey, file.bytes, file.mime);
  if (!result) return;
  console.log(`[AI Agent] ${media.type === 'audio' ? 'Áudio transcrito' : 'Foto descrita'} (conv ${conv.id}): "${result.text.slice(0, 80)}"`);

  const { data: row } = await supabase
    .from('wapi_messages')
    .select('id, metadata')
    .eq('conversation_id', conv.id)
    .eq('message_id', media.messageId)
    .maybeSingle();
  if (row?.id) {
    await supabase.from('wapi_messages').update({
      metadata: { ...((row.metadata as Json) || {}), ai_media_text: result.text, ai_media_model: result.model },
    }).eq('id', row.id);
  }
  await logUsage(supabase, {
    companyId: instance.company_id,
    conversationId: conv.id,
    leadId: conv.lead_id,
    model: result.model,
    kind: media.type === 'audio' ? 'transcription' : 'vision',
    inputTokens: result.inputTokens,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    isTest,
  });
}

// Ponto de entrada. Retorna true quando a IA cuidou da mensagem (o bot fixo não roda).
export async function maybeHandleWithAiAgent(
  supabase: any,
  instance: AgentInstance,
  conv: AgentConv,
  content: string,
  phone: string,
  contactName: string | null,
  botSettings?: any, // Bot settings para test mode check
  media?: AgentMedia,
  // Id (do provedor) da mensagem de texto que disparou esta execução — usado
  // para juntar mensagens seguidas numa resposta só
  incomingMessageId?: string | null,
  // resume: a equipe clicou em "Retomar com a IA agora" — a IA volta para a
  // conversa e escreve já, sem mensagem nova do cliente (ver _shared/ai-resume.ts)
  opts: { resume?: boolean } = {},
): Promise<boolean> {
  const resume = opts.resume === true;
  // Só leitura fora das tabelas liberadas (ver ai-db-guard.ts)
  supabase = guardAiDb(supabase);
  let settings: AiSettings | null = null;
  try {
    if (!instance.unit || !instance.company_id) {
      console.log(`[AI Agent] Sem unidade/empresa na instância — pulando (conv ${conv.id})`);
      return false;
    }

    // Test mode: se ativado, apenas deixa passar o número de teste configurado
    if (botSettings?.test_mode_enabled && botSettings?.test_mode_number) {
      const testPhoneVariants = getPhoneVariantsBR(botSettings.test_mode_number);
      const incomingPhoneVariants = getPhoneVariantsBR(phone);
      const isTestPhone = incomingPhoneVariants.some(v => testPhoneVariants.includes(v));
      if (!isTestPhone) {
        console.log(`[AI Agent] Test mode ON — phone ${phone} is NOT test number, skipping`);
        return false;
      }
    }

    settings = await loadSettings(supabase, instance.company_id);
    // O simulador testa mesmo com a IA ainda desligada para os clientes
    if (!settings || (!settings.enabled && !inSandbox()) || !settings.unit) {
      console.log(`[AI Agent] IA desligada ou sem unidade configurada para a empresa ${instance.company_id} — pulando`);
      return false;
    }
    // Módulo do Hub: sem ele a IA não responde, mesmo com a configuração ligada
    // (no teste isolado do dono o módulo ainda pode estar desligado: nada sai nem é gravado)
    if (!inSandbox() && !(await loadAiConversationalEnabled(supabase, instance.company_id))) {
      console.log(`[AI Agent] Módulo IA Conversacional desligado no Hub para a empresa ${instance.company_id} — pulando`);
      return false;
    }
    // Números com a IA (principal + outros liberados), cada um com a sua data de liberação
    const aiUnit = aiUnitFor(settings, instance.unit);
    if (!aiUnit) {
      console.log(`[AI Agent] IA configurada para "${aiUnits(settings).map((u) => u.unit).join(', ')}", mensagem chegou em "${instance.unit}" — pulando`);
      return false;
    }
    // "Só conversas novas" conta a partir da liberação DESTE número
    settings = { ...settings, activated_at: aiUnit.activated_at };

    // Modo de Teste da IA: enquanto ligado, ela só conversa com este número.
    // Para qualquer outro, devolve false e a conversa segue com o bot fixo
    // normalmente — nada muda para os clientes de verdade.
    // No simulador a conversa conta como a do número de teste (mesmo modelo
    // e sem a regra de "só leads novos")
    const sandbox = inSandbox();
    const isAiTestPhone = sandbox ? true : isAiTestNumber(settings, phone);
    if (settings.test_mode_enabled && !isAiTestPhone) {
      console.log(`[AI Agent] Modo de Teste da IA ligado — ${phone} não é o número de teste, seguindo com o bot fixo`);
      return false;
    }

    // Número de teste manda "#reiniciar": a IA começa uma conversa nova do
    // zero (esquece o histórico anterior e volta a atender mesmo depois de
    // ter passado para a equipe). Só vale para o número de teste.
    if (isAiTestPhone && !sandbox && !media && content.trim().toLowerCase() === TEST_RESTART_COMMAND) {
      const newBotData = {
        ...(conv.bot_data || {}),
        ai_agent: 'on',
        ai_history_since: new Date().toISOString(),
        ai_materials_sent: {},
        ai_handoff: null,
        ai_auto_materials_at: null,
        ai_materials_busy_until: null,
        nome: null,
        mes: null,
        convidados: null,
        data_festa: null,
      } as Json;
      // Limpa também qualquer pausa (trava anti-loop, passagem do bot fixo...):
      // conversa pausada nem chega na IA.
      await supabase.from('wapi_conversations').update({
        bot_step: AI_STEP,
        bot_enabled: true,
        bot_data: newBotData,
        bot_paused_until: null,
        bot_paused_reason: null,
        bot_paused_at: null,
      }).eq('id', conv.id);
      console.log(`[AI Agent] #reiniciar no número de teste — conversa ${conv.id} zerada (passagem e pausas limpas)`);
      conv.bot_step = AI_STEP;
      conv.bot_enabled = true;
      conv.bot_data = newBotData;
      const model = (settings.test_model || settings.model || DEFAULT_AI_MODEL);
      await sendViaWapiSend(supabase, 'send-text', instance, conv, { message: `🧪 Conversa reiniciada. Modelo em teste: ${model}. Pode mandar a primeira mensagem como se fosse um cliente.` });
      return true;
    }

    // Retomada: a conversa volta para a IA (passagem e pausas encerradas)
    if (resume) {
      const bdResume = { ...(conv.bot_data || {}), ai_agent: 'on', ai_handoff: null, ai_returned_at: new Date().toISOString() } as Json;
      await supabase.from('wapi_conversations').update({
        bot_step: AI_STEP, bot_enabled: true, bot_data: bdResume,
        bot_paused_until: null, bot_paused_reason: null, bot_paused_at: null,
      }).eq('id', conv.id);
      conv.bot_step = AI_STEP;
      conv.bot_enabled = true;
      conv.bot_data = bdResume;
      console.log(`[AI Agent] Retomada pela equipe (conv ${conv.id})`);
    }

    // Equipe assumiu (botão Inativo, mensagem humana ou transferência): IA fica
    // fora — exceto quando foi a IA que passou, a equipe está fora do horário e
    // ninguém da equipe escreveu ainda: aí ela segue tirando dúvidas.
    let afterHoursHandoff: Json | null = null;
    if (conv.bot_step === 'human_takeover') {
      const handoff = (conv.bot_data as Json | null)?.ai_handoff as Json | undefined;
      const handoffAt = typeof handoff?.at === 'string' ? handoff.at : null;
      // Quem quer trabalhar e recebeu o link do cadastro (até 7 dias): a IA
      // responde o "ok, obrigado" e dúvidas do cadastro, em qualquer horário
      const candidateLink = handoff?.assunto === 'trabalhar' && typeof handoff?.candidatura_link === 'string' &&
        handoffAt && Date.now() - Date.parse(handoffAt) < 7 * 86400000;
      if (handoffAt && (candidateLink || !teamOpenNow(settings)) && !(await teamRepliedSince(supabase, conv.id, handoffAt))) {
        afterHoursHandoff = handoff as Json;
        console.log(candidateLink
          ? `[AI Agent] Conversa ${conv.id}: candidato já recebeu o link do cadastro e ninguém da equipe escreveu — IA responde`
          : `[AI Agent] Conversa ${conv.id} já passada para a equipe, fora do horário e sem resposta humana — IA segue tirando dúvidas`);
      } else {
        console.log(`[AI Agent] Conversa ${conv.id} em human_takeover — pulando`);
        return false;
      }
    }
    if (conv.bot_step === AI_STEP && conv.bot_enabled === false) {
      console.log(`[AI Agent] Conversa ${conv.id} estava com a IA mas foi desligada (bot_enabled=false) — pulando`);
      return false;
    }

    // O número de teste é sempre atendido pela IA (a conversa dele costuma
    // ser antiga, de antes da ativação, e cairia na regra de "só leads novos").
    if (!resume && !afterHoursHandoff && !isAiTestPhone && !(await isEligible(supabase, settings, conv, phone, instance.company_id))) {
      console.log(`[AI Agent] Conversa ${conv.id} não elegível (ver motivo acima) — seguindo com o bot fixo`);
      return false;
    }

    const openaiKey = Deno.env.get('OPENAI_API_KEY') || null;
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') || null;
    let model = sandbox?.model || ((isAiTestPhone && settings.test_model) ? settings.test_model : (settings.model || DEFAULT_AI_MODEL));
    if (providerForModel(model) === 'anthropic' && !anthropicKey) {
      console.error(`[AI Agent] Modelo ${model} escolhido, mas ANTHROPIC_API_KEY não está configurada — usando ${NO_ANTHROPIC_KEY_MODEL}`);
      model = NO_ANTHROPIC_KEY_MODEL;
    }
    if (providerForModel(model) === 'openai' && !openaiKey) {
      console.error('[AI Agent] OPENAI_API_KEY not configured — falling back to fixed bot');
      return false;
    }

    // Adota a conversa (depois de uma passagem fora do horário, continua com a equipe)
    if (!afterHoursHandoff && (conv.bot_step !== AI_STEP || conv.bot_enabled !== true)) {
      await supabase.from('wapi_conversations').update({ bot_step: AI_STEP, bot_enabled: true }).eq('id', conv.id);
      conv.bot_step = AI_STEP;
      conv.bot_enabled = true;
      if (isAiTestPhone) {
        const newBotData = { ...(conv.bot_data || {}), ai_agent: 'on' } as Json;
        await supabase.from('wapi_conversations').update({ bot_data: newBotData }).eq('id', conv.id);
        conv.bot_data = newBotData;
      }
    }

    if (media) {
      await processIncomingMedia(supabase, instance, conv, media, openaiKey, isAiTestPhone);
    }

    // Junta mensagens seguidas: espera alguns segundos e só responde se esta
    // ainda for a última mensagem do cliente — a última responde por todas.
    const myMessageId = media?.messageId || incomingMessageId || null;
    const tStart = Date.now();
    // A IA acabou de perguntar algo? Então resposta curta já é completa.
    const { data: lastOut } = await supabase.from('wapi_messages').select('content')
      .eq('conversation_id', conv.id).eq('from_me', true).order('timestamp', { ascending: false }).limit(1);
    const aiAsked = /\?\s*\S{0,3}\s*$/.test(String((lastOut as Array<{ content: string | null }> | null)?.[0]?.content || ''));
    const waitMs = debounceMsFor(content, !!media, aiAsked);
    if (myMessageId) {
      await sandboxSleep(waitMs);
      await waitMaterialsIdle(supabase, conv.id);
      const latest = await latestIncomingId(supabase, conv.id);
      if (latest && latest !== myMessageId) {
        console.log(`[AI Agent] Mensagem ${myMessageId} não é a última do cliente (última: ${latest}) — a última responde por todas`);
        return true;
      }
      // Estado pode ter mudado durante a espera (equipe assumiu, #reiniciar...)
      const { data: freshConv } = await supabase
        .from('wapi_conversations')
        .select('bot_step, bot_enabled, bot_data, lead_id')
        .eq('id', conv.id)
        .maybeSingle();
      if (freshConv) {
        conv.bot_step = freshConv.bot_step;
        conv.bot_enabled = freshConv.bot_enabled;
        conv.bot_data = freshConv.bot_data;
        conv.lead_id = freshConv.lead_id ?? conv.lead_id;
      }
      const stillMine = afterHoursHandoff
        ? conv.bot_step === 'human_takeover' && !(await teamRepliedSince(supabase, conv.id, String(afterHoursHandoff.at)))
        : conv.bot_step === AI_STEP && conv.bot_enabled !== false;
      if (!stillMine) {
        console.log(`[AI Agent] Conversa ${conv.id} mudou durante a espera (step ${conv.bot_step}) — não responde`);
        return true;
      }
    }

    const tAfterWait = Date.now();
    // Histórico da conversa (no número de teste, só depois do último #reiniciar)
    let historyQuery = supabase
      .from('wapi_messages')
      .select('from_me, content, message_type, timestamp, metadata')
      .eq('conversation_id', conv.id);
    const historySince = isAiTestPhone ? (conv.bot_data as Json | null)?.ai_history_since : null;
    if (typeof historySince === 'string') historyQuery = historyQuery.gt('timestamp', historySince);
    const { data: history } = await historyQuery
      .order('timestamp', { ascending: false })
      .limit(MAX_HISTORY_MESSAGES);

    const ordered = ((history || []) as Array<{ from_me: boolean; content: string | null; message_type: string; timestamp: string; metadata: Json | null }>).reverse();
    // Mensagem nossa escrita por uma pessoa da equipe (Celebrei ou celular), não pela Bia
    const byTeam = (m: { from_me: boolean; timestamp: string; metadata: Json | null }) =>
      m.from_me && teamRepliedAfter([m as { from_me: boolean; timestamp: string; metadata: Record<string, unknown> | null }], '1970-01-01T00:00:00Z');
    const chatMessages: ChatTurn[] = ordered
      .filter((m) => (m.content || '').trim().length > 0 || m.message_type !== 'text')
      .map((m) => {
        if (m.message_type === 'text') {
          return { role: m.from_me ? 'assistant' : 'user', content: `${byTeam(m) ? '[Equipe] ' : ''}${m.content || ''}` } as ChatTurn;
        }
        if (!m.from_me && (m.message_type === 'audio' || m.message_type === 'image')) {
          return { role: 'user', content: mediaHistoryText(m.message_type, m.content || '', m.metadata?.ai_media_text as string | undefined) } as ChatTurn;
        }
        return { role: m.from_me ? 'assistant' : 'user', content: `[${m.message_type}] ${m.content || ''}`.trim() } as ChatTurn;
      });
    // Garante que a última mensagem do cliente está presente
    if (chatMessages.length === 0 || chatMessages[chatMessages.length - 1].role !== 'user') {
      chatMessages.push({ role: 'user', content: media ? mediaHistoryText(media.type, content, null) : content });
    }
    // Perguntou o nome e o cliente respondeu só o nome: salva já (a IA às vezes
    // chama pelo nome sem registrar e a conversa fica com o nome do WhatsApp)
    if (!firstNameOrEmpty((conv.bot_data as Json | null)?.nome as string)) {
      const lastOurs = ordered.map((m) => m.from_me).lastIndexOf(true);
      const answer = lastOurs >= 0 ? ordered.slice(lastOurs + 1).find((m) => !m.from_me && m.message_type === 'text') : null;
      const nome = answer && askedForName(ordered[lastOurs].content) ? nameFromAnswer(answer.content) : null;
      if (nome) {
        console.log(`[AI Agent] Nome respondido pelo cliente: "${nome}" (conv ${conv.id})`);
        await mergeBotData(supabase, conv, { nome });
        await saveCustomerName(supabase, conv, nome);
      }
    }
    // Pergunta de preço só vale se for recente: cliente que volta depois de
    // semanas segue a regra do zero (caso Amanda, 14/10 — "Qual valor?" de
    // 09/09 fez a IA passar valores depois do "1 - Receber o orçamento")
    const priceSinceMs = Date.now() - PRICE_ASK_WINDOW_MS;
    const priceTurns: ChatTurn[] = ordered
      .filter((m) => Date.parse(m.timestamp) >= priceSinceMs && (m.content || '').trim())
      .map((m) => ({ role: m.from_me ? 'assistant' : 'user', content: m.content || '' }) as ChatTurn);
    if (chatMessages.length && chatMessages[chatMessages.length - 1].role === 'user' && (!ordered.length || ordered[ordered.length - 1].from_me)) {
      priceTurns.push(chatMessages[chatMessages.length - 1]);
    }
    const isFirstReply = !chatMessages.some((m) => m.role === 'assistant' && !m.content.startsWith('🧪'));
    conv.__firstReply = isFirstReply;
    conv.__corporateEnabled = settings.corporate_events_enabled === true;
    const { merged: mergedHistory, pendingUserMessages } = mergeConsecutiveTurns(chatMessages);
    // Na retomada, a "mensagem" que dispara não é do cliente: vale a última dele
    const lastUserText = resume
      ? ([...ordered].reverse().find((m) => !m.from_me)?.content || '')
      : [...mergedHistory].reverse().find((m) => m.role === 'user')?.content || '';

    let companyName = instance.unit || '';
    const { data: companyRow } = await supabase.from('companies').select('name').eq('id', instance.company_id).maybeSingle();
    if (companyRow?.name) companyName = companyRow.name as string;

    const today = new Date().toLocaleDateString('pt-BR', {
      weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo',
    });
    const nowMs = Date.now();
    const booked = await loadBookedSlots(supabase, instance);
    const closedPeriods = parseClosedPeriods(settings.closed_periods);
    const visitHolidays = await loadLocalHolidays(supabase, instance.company_id);
    // Recesso e feriados: sem visitas nesses dias (14 dias à frente + o tamanho do recesso)
    const available = listAvailableSlots(parseVisitHours(settings.visit_hours), nowMs, booked, { days: 28, minLeadMinutes: 120, max: 120 })
      .filter((sl) => !isClosedDay(sl.date, closedPeriods) && !isHolidayDate(sl.date, visitHolidays))
      .slice(0, 60);
    // Mês e convidados já conhecidos sem os materiais terem saído (lead do
    // site chega com os dados do formulário e a IA não precisa registrar):
    // a IA responde primeiro (cumprimenta, responde) e fotos, vídeo e PDF
    // saem logo depois da resposta dela
    let materialsNote: string | null = null;
    const bdNow = (conv.bot_data || {}) as Json;
    if (bdNow.mes && bdNow.convidados && !isWithinMaterialWindow(bdNow.ai_auto_materials_at) && !afterHoursHandoff) {
      // Retomada: o cliente já tinha confirmado a festa (era a vez dos materiais)
      if (resume || confirmsPartyInterest(lastUserText)) {
        console.log(`[AI Agent] Mês e convidados já conhecidos e materiais ainda não enviados — saem depois da resposta (conv ${conv.id})`);
        conv.__deferMaterials = true;
        // Data da festa do formulário: conferida agora; o aviso (livre ou
        // reservada, com outras datas) sai pelo sistema depois do PDF
        const pendingDate = pendingPartyDate(conv);
        conv.__partyDate = pendingDate ? await checkPartyDate(supabase, instance, settings, pendingDate) : null;
        materialsNote = conv.__partyDate && conv.__partyDate.status !== 'free'
          ? 'logo DEPOIS da sua resposta, o sistema vai mandar as fotos do espaço, o vídeo e o PDF dos pacotes (com legendas próprias) e, depois do PDF, uma mensagem sobre a data da festa. Escreva UMA parte só (sem ---): responda o que o cliente disse (se ele cumprimentou, cumprimente de volta) e termine avisando, com naturalidade, que vai mostrar o espaço — ex.: "Vou te mostrar o nosso espaço 😍👇". NÃO diga que já mandou. NÃO fale se a data está livre ou reservada e NÃO convide para visita nesta resposta. Não passe valores, a menos que o cliente tenha pedido.'
          : 'logo DEPOIS da sua resposta, o sistema vai mandar as fotos do espaço, o vídeo e o PDF dos pacotes (com legendas próprias). Escreva a resposta em DUAS partes, separadas por uma linha só com ---. A 1ª parte sai ANTES dos materiais: responda o que o cliente disse (se ele cumprimentou, cumprimente de volta) e termine avisando, com naturalidade, que vai mostrar o espaço — ex.: "Vou te mostrar o nosso espaço 😍👇". A 2ª parte sai DEPOIS do PDF: UMA frase curta convidando para conhecer o espaço, com os 2 horários de visita livres que você tem — ex.: "Se fizer sentido pra vocês, te recebo pra conhecer o espaço: amanhã às 10h ou quinta às 15h, qual fica melhor? 😊" (se ele já tem visita marcada, pergunte só o que achou). NÃO diga que já mandou. Na 1ª parte, não passe valores nem convide para visita, a menos que o cliente tenha pedido.' + (conv.__partyDate ? ' Não diga se a data está livre: o sistema já conta isso antes da sua 2ª parte.' : '');
      } else {
        // Lead do site com data e convidados, mas a resposta não fala da festa
        // (só "oi", uma foto solta, outro assunto): pergunta antes de mandar
        console.log(`[AI Agent] Dados da festa conhecidos, mas a mensagem não confirma que é sobre a festa — materiais seguram (conv ${conv.id})`);
        conv.__holdMaterials = true;
        materialsNote = 'a data e os convidados já estão anotados (vieram do formulário do site ou da conversa), mas a mensagem do cliente ainda NÃO deixa claro que é sobre a festa (pode ser só um oi, uma foto solta ou outro assunto). Ainda NÃO mande fotos, vídeo, PDF nem valores, e não diga que vai mandar. Responda com simpatia ao que ele mandou e pergunte como pode ajudar — se é sobre a festa do pedido, se ele já tem festa com a gente ou se é outro assunto. ' + helpOptionsFormat(settings.corporate_events_enabled === true);
      }
    }
    const sent = sentMaterials(conv);
    const sentList = (Object.keys(sent) as MaterialTipo[]).map((k) => `${MATERIAL_LABEL[k]} (${fmtTimeBR(sent[k] as string)})`);
    const bd = (conv.bot_data || {}) as Json;
    const known = [
      firstNameOrEmpty(bd.nome as string) ? `nome ${bd.nome}` : null,
      bd.mes ? `mês ${bd.mes}` : null,
      bd.convidados ? `${bd.convidados}` : null,
      bd.dia_perguntado && !bd.data_festa && bd.mes
        ? 'DIA DA FESTA: ainda não sabemos — você perguntou se ele já tem um dia em mente. Se ele disser um dia, use consultar_datas_livres com essa data e conte se está livre; se estiver, convide para conhecer o espaço com 2 horários. Se ele ainda não souber o dia, siga com o convite para a visita'
        : null,
      bd.tipo_evento === 'empresa' ? `EMPRESA — confraternização${bd.empresa ? ` da ${bd.empresa}` : ''} (não pergunte de aniversariante)` : null,
      typeof bd.data_festa === 'string' && bd.data_ocupada_avisada === bd.data_festa
        ? `data pedida ${formatDateLong(bd.data_festa)} (${bd.data_festa}) — JÁ RESERVADA: o cliente já foi avisado e recebeu outras datas livres; não trate como a data da festa e, quando ele escolher outra, consulte essa nova data`
        : typeof bd.data_festa === 'string' ? `data da festa ${formatDateLong(bd.data_festa)} (${bd.data_festa}) — use esta data em consultar_valor_pacote enquanto o cliente não mudar${
          // Ainda não conferida com o cliente (e não vai pelo sistema depois do PDF neste turno)
          pendingPartyDate(conv) && !conv.__deferMaterials ? '; ainda NÃO conferida na agenda: antes de convidar para visita, use consultar_datas_livres com essa data e conte ao cliente se está livre' : ''}` : null,
    ].filter(Boolean) as string[];
    const leadVisit = await loadLeadVisit(supabase, conv.lead_id);
    const visitConfirmPending = leadVisit ? !!(await loadPendingVisitConfirmation(supabase, leadVisit.id)) : false;
    // Regras do cadastro (comida de fora, animal): a IA recebe a resposta exata quando o cliente pergunta
    const houseRules = parseHouseRules(settings.extra_instructions);
    // Um único espaço físico ativo: a IA não pode dar a entender que existe outra unidade
    const { data: physicalUnits } = await supabase.from('company_units').select('name')
      .eq('company_id', instance.company_id).eq('is_active', true).eq('is_physical', true);
    const singleVenue = ((physicalUnits || []) as Array<{ name: string }>).filter((u) => !/trabalhe conosco/i.test(u?.name || '')).length <= 1;
    const askedTopics = topicsAsked(lastUserText);
    const lastAny = ordered[ordered.length - 1];
    const promptParts = buildSystemPrompt(companyName, instance.unit, settings, today, {
      resumeNote: resume
        ? resumeNote({
          gapMs: lastAny ? nowMs - Date.parse(lastAny.timestamp) : 0,
          clientWaiting: !!lastAny && !lastAny.from_me,
          materialsPending: !!conv.__deferMaterials,
        })
        : null,
      offers: pickTwoOffers(available),
      sentMaterialsText: sentList.length > 0 ? sentList.join(', ') : 'nenhum',
      teamHoursText: teamHoursMessage(settings, nowMs),
      knownDataText: known.length > 0 ? known.join(', ') : 'nada ainda',
      isFirstReply,
      pendingUserMessages,
      afterHoursHandoff: afterHoursHandoff
        ? { reason: String(afterHoursHandoff.reason || ''), returns: teamReturnText(settings, nowMs) }
        : null,
      candidateLinkSent: afterHoursHandoff?.assunto === 'trabalhar' && typeof afterHoursHandoff?.candidatura_link === 'string'
        ? String(afterHoursHandoff.candidatura_link)
        : null,
      visitRepliesAgo: repliesSinceVisitInvite(chatMessages),
      clientAffirmed: clientAffirms(lastUserText),
      minPackageGuests: smallestPackageGuests(await loadSalesMaterials(supabase, instance)),
      packagesText: await loadPackagesText(supabase, instance),
      pricePending: priceRequestPending(priceTurns),
      crossedMessage: crossedWithLastReply(((history || []) as Array<{ from_me: boolean; timestamp: string }>)),
      weekdayNote: (() => {
        const wrong = weekdayMismatches(lastUserText, new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10));
        return wrong.length > 0 ? wrong.map((w) => `o cliente escreveu "${w.said}", mas no calendário é "${w.right}".`).join(' ') : null;
      })(),
      houseNote: houseRuleNote(houseRules, askedTopics),
      singleVenue,
      recessNote: closedPeriodsNote(closedPeriods, ymdBR(nowMs)),
      materialsNote,
      intentNote: (() => {
        const intent = contactIntent(lastUserText);
        if (intent === 'trabalhar') return 'a pessoa parece querer trabalhar no buffet (vaga/currículo). Não fale de festa: use transferir_para_atendente com assunto trabalhar (e funcoes, se ela citou alguma).';
        if (intent === 'fornecedor') return 'a pessoa parece ser fornecedor ou querer vender algo. Não fale de festa: use transferir_para_atendente com assunto fornecedor.';
        if (intent === 'cliente_com_festa') return 'a pessoa parece já ter festa marcada com a gente. Não trate como orçamento: entenda a dúvida; se for sobre a festa contratada, use transferir_para_atendente com assunto cliente_com_festa.';
        if (intent === 'duvida_festa') return 'a pessoa disse que tem uma festa e quer tirar uma dúvida. Pergunte qual é a dúvida e se a festa já está marcada com a gente, antes de falar de orçamento, mês ou convidados.';
        return null;
      })(),
      corporateNote: (() => {
        if (!settings.corporate_events_enabled) return null;
        if (bd.tipo_evento === 'empresa') return corporateLeadNote(bd.empresa as string);
        if (mentionsCorporate(lastUserText)) return 'o cliente falou de empresa/confraternização: trate como CONFRATERNIZAÇÃO DE EMPRESAS — chame registrar_dados_festa com confraternizacao=true e siga o roteiro de empresa (sem aniversariante).';
        return null;
      })(),
      campaignNote: await (async () => {
        try {
          const camp = await loadCampaignContext(supabase, instance.company_id as string, phone, companyName, nowMs);
          return camp ? campaignPromptNote(camp, nowMs) : null;
        } catch (err) {
          console.error('[AI Agent] Falha ao ler a campanha recebida:', err);
          return null;
        }
      })(),
      promoNote: (() => {
        // Promoção do cadastro ainda no prazo: oferecer depois dos valores, lembrar no máximo 1 vez
        const promo = findPromotion(settings.extra_instructions, ymdBR(nowMs));
        return promo ? promoNote(promo, promoMentions(chatMessages.filter((m) => m.role === 'assistant').map((m) => m.content), promo)) : null;
      })(),
      visitSlotsText: visitSlotsByDay(available)
        .map((d) => `${formatDateLong(d.date)}: ${d.times.map((t) => (t.endsWith(':00') ? `${Number(t.slice(0, 2))}h` : t.replace(':', 'h'))).join(', ')}`)
        .join('; ') || 'nenhum',
      visitText: leadVisit ? visitText(leadVisit.data_visita, leadVisit.horario_visita) : null,
      visitConfirmPending,
    });

    const session = createLlmSession({
      model,
      system: promptParts.stable,
      systemDynamic: promptParts.dynamic,
      history: mergedHistory,
      tools: visitConfirmPending ? [...TOOLS, CONFIRM_VISIT_TOOL] : TOOLS,
      openaiKey,
      anthropicKey,
    });
    if (!session) {
      console.error(`[AI Agent] Sem chave para o modelo ${model} — seguindo com o bot fixo`);
      return false;
    }
    console.log(`[AI Agent] Respondendo conv ${conv.id} com ${model}${isAiTestPhone ? ' (número de teste)' : ''}`);
    const tPrepared = Date.now();
    let modelMs = 0;
    let toolMs = 0;
    // Materiais com envio registrado nesta conversa (pela IA, pelo bot fixo ou
    // pela equipe — inclusive foto/vídeo/PDF que a equipe mandou pelo celular)
    const MEDIA_TIPO: Record<string, MaterialTipo> = { image: 'fotos', video: 'video', document: 'pacotes' };
    const registeredMaterials = async (): Promise<Set<MaterialTipo>> => {
      const inChat = await materialsAlreadyInChat(supabase, conv, await loadSalesMaterials(supabase, instance));
      return new Set([
        ...(Object.keys(sentMaterials(conv)) as MaterialTipo[]),
        ...(Object.keys(inChat) as MaterialTipo[]).filter((k) => inChat[k]),
        ...ordered.filter((m) => m.from_me && MEDIA_TIPO[m.message_type]).map((m) => MEDIA_TIPO[m.message_type]),
      ]);
    };
    let maxRounds = MAX_TOOL_ROUNDS;
    let redoAsked = false;

    for (let round = 0; round < maxRounds; round++) {
      let step: LlmStep;
      try {
        const tModel = Date.now();
        step = await session.step();
        modelMs += Date.now() - tModel;
      } catch (llmErr) {
        // Provedor fora do ar / erro: não deixa o cliente sem resposta —
        // passa para a equipe (sem mandar nada ao cliente)
        console.error(`[AI Agent] Erro do provedor (${model}):`, llmErr);
        await handOffOnFailure(supabase, instance, conv, phone, contactName, settings, `falha técnica da IA (${model}) — responda o cliente`);
        return true;
      }
      console.log(`[AI Agent] Rodada ${round + 1} (${step.servedModel}): ${step.toolCalls.length} ferramenta(s), texto ${step.text.length} caracteres, tokens in=${step.usage.inputTokens + step.usage.cachedInputTokens} out=${step.usage.outputTokens}`);

      await logUsage(supabase, {
        companyId: instance.company_id,
        conversationId: conv.id,
        leadId: conv.lead_id,
        model: step.servedModel || model,
        kind: 'chat',
        ...step.usage,
        costUsd: estimateChatCostUsd(step.servedModel || model, step.usage),
        isTest: isAiTestPhone,
      });

      if (step.refused) {
        console.warn(`[AI Agent] Modelo recusou responder (conv ${conv.id}) — passando para a equipe`);
        await handOffOnFailure(supabase, instance, conv, phone, contactName, settings, 'a IA não soube responder esta mensagem');
        return true;
      }

      if (step.toolCalls.length > 0) {
        const tTools = Date.now();
        const results: Array<{ id: string; content: string }> = [];
        for (const call of step.toolCalls) {
          const args = call.args as any;
          let toolResult = 'ERRO: ferramenta desconhecida.';
          if (call.name === 'registrar_dados_festa') {
            toolResult = await toolRegistrarDados(supabase, instance, conv, phone, contactName, botSettings, args);
            // Materiais saíram agora e a resposta da IA vem depois do PDF: ela
            // já conta da data da festa (livre ou reservada, com outras datas)
            const pendingDate = toolResult.startsWith('OK: dados salvos e os materiais foram enviados agora') ? pendingPartyDate(conv) : null;
            if (pendingDate) {
              const pd = await checkPartyDate(supabase, instance, settings, pendingDate);
              await markPartyDateChecked(supabase, conv, pd);
              const day = formatDateLong(pd.date);
              toolResult += pd.status === 'free'
                ? ` DATA DA FESTA: ${day} está disponível neste momento — conte isso junto do convite para visita (ex.: "e uma notícia boa: ${dayWithArticle(pd.date)} ainda está livre na agenda ✅"). Não diga que reservou ou segurou a data.`
                : pd.alternatives
                ? ` DATA DA FESTA: ${day} ${pd.status === 'recess' ? 'cai no RECESSO do buffet (sem festas)' : 'JÁ FOI RESERVADA'}. Nesta resposta NÃO convide para visita: avise com gentileza (ex.: "${dayWithArticle(pd.date)} já está reservad${/^o /.test(dayWithArticle(pd.date)) ? 'o' : 'a'} 😕") e ofereça estas datas livres — linhas prontas, copie como estão:\n${pd.alternatives}\nTermine perguntando se alguma delas funciona, e no fim, entre parênteses: "(A data fica garantida com contrato e sinal ✨)".`
                : ` DATA DA FESTA: ${day} ${pd.status === 'recess' ? 'cai no RECESSO do buffet (sem festas)' : 'JÁ FOI RESERVADA'} e não há datas livres por perto. Avise com gentileza, diga que vai ver com a equipe as melhores opções de data e use transferir_para_atendente (motivo: "data pedida (${day}) já reservada, sem datas livres por perto — ofereça opções").`;
            }
          } else if (call.name === 'agendar_visita') {
            toolResult = await toolAgendarVisita(supabase, instance, conv, phone, contactName, settings, args);
          } else if (call.name === 'confirmar_visita' && visitConfirmPending) {
            toolResult = await toolConfirmarVisita(supabase, instance, conv);
          } else if (call.name === 'enviar_materiais') {
            toolResult = await toolEnviarMateriais(supabase, instance, conv, phone, contactName, String(args.tipo || ''), args.reenviar === true);
          } else if (call.name === 'consultar_datas_livres') {
            // Joyce (26/10): disse "na semana em janeiro" e a IA consultou sem a
            // preferência, então perguntou de novo em vez de mostrar as datas
            const inferred = !args.preferencia && !args.dia_semana ? dayPreferenceFrom(lastUserText) : null;
            toolResult = await toolConsultarDatas(supabase, instance, settings, inferred ? { ...args, preferencia: inferred } : args, conv);
          } else if (call.name === 'consultar_valor_pacote' && !clientAskedPrice(priceTurns)) {
            // Valor aberto só para quem perguntou o preço (pedir "orçamento" não conta)
            toolResult = 'NÃO PASSE VALORES: o cliente ainda não perguntou o preço (pedir "orçamento" não é perguntar o preço). Não escreva nenhum valor em R$ nem ofereça passar. Os pacotes estão no PDF; responda o que ele disse e conduza para a data e a visita.';
            console.log(`[AI Agent] Consulta de valor recusada — cliente não perguntou o preço (conv ${conv.id})`);
          } else if (call.name === 'consultar_valor_pacote') {
            toolResult = await toolConsultarValor(supabase, instance, settings, conv, phone, contactName, args);
          } else if (call.name === 'transferir_para_atendente') {
            const motivo = String(args.motivo || '');
            // Visita (marcar, trocar, outro horário) a IA resolve sozinha — o
            // simulador pegou ela passando "troca de visita" para a equipe
            if (singleVenue && /unidade|filial/i.test(motivo) && !/atendente|pessoa|humano|reclama/i.test(motivo)) {
              toolResult = `NÃO TRANSFIRA por causa de unidade: o ${companyName} tem um único espaço (o endereço das informações do buffet), não existe outra unidade. Diga isso com naturalidade ao cliente e siga a conversa.`;
              console.log(`[AI Agent] Passagem por "outra unidade" recusada — espaço único (conv ${conv.id})`);
            } else if (/visita|remarc/i.test(motivo) && !/atendente|pessoa|humano|reclama/i.test(motivo)) {
              toolResult = 'NÃO TRANSFIRA por causa de visita: você mesma resolve. Ofereça horários livres da lista de visitas do sistema (2 opções no dia/turno que o cliente pediu) e, quando ele escolher, use agendar_visita — com remarcar=true se ele já tem visita marcada.';
              console.log(`[AI Agent] Passagem por visita recusada (conv ${conv.id}): ${motivo.slice(0, 80)}`);
            } else {
              toolResult = await toolTransferir(supabase, instance, conv, phone, contactName, settings, motivo, String(args.assunto || ''), String(args.funcoes || ''));
            }
          }
          results.push({ id: call.id, content: toolResult });
          sandbox?.state.tools.push({ name: call.name, args: (call.args || {}) as Record<string, unknown>, result: toolResult });
        }
        session.addToolResults(results);
        toolMs += Date.now() - tTools;
        continue; // nova rodada para a IA redigir a resposta final
      }

      if (!step.text) {
        // Nada para mandar: nunca deixa o cliente no vácuo
        console.error(`[AI Agent] ${model} não devolveu texto nem ferramenta (conv ${conv.id})`);
        await handOffOnFailure(supabase, instance, conv, phone, contactName, settings, 'a IA não conseguiu gerar resposta — responda o cliente');
        return true;
      }
      let finalText = step.text;
      // Travas que fazem a IA refazer a resposta (uma vez): dizer que mandou
      // fotos/vídeo/PDF sem o envio registrado e contradizer o cadastro
      // (comida de fora, animal). Se insistir, o sistema corrige a frase.
      const falseClaims = hasMaterialClaim(finalText) ? falseMaterialClaims(finalText, await registeredMaterials()) : [];
      const brokenRules = houseRuleViolations(finalText, houseRules, askedTopics);
      // Proposta de permuta/parceria tem de ir para a equipe (o simulador pegou
      // a IA dizendo "não consigo confirmar por aqui" sem passar)
      const partnershipPending = asksPartnership(lastUserText) && !conv.__handoffThisTurn && conv.bot_step !== 'human_takeover';
      if ((falseClaims.length > 0 || brokenRules.length > 0 || partnershipPending) && !redoAsked) {
        redoAsked = true;
        // Uma rodada para refazer e outra se ela precisar de ferramenta (ex.: enviar_materiais)
        maxRounds = Math.max(maxRounds, round + 3);
        const problems: string[] = [];
        if (falseClaims.length > 0) {
          problems.push(`ela diz que você mandou material que NÃO foi enviado nesta conversa ("${falseClaims[0].slice(0, 160)}"). Não diga que mandou; se o cliente pediu para ver, use enviar_materiais.`);
        }
        if (brokenRules.length > 0) {
          const said = houseRuleViolatingSentences(finalText, houseRules, askedTopics)[0] || '';
          problems.push(`${said ? `a frase "${said.slice(0, 160)}" ` : 'ela '}contradiz o cadastro do buffet sobre ${brokenRules.map((r) => `${TOPIC_ASK[r.topic]} (resposta do cadastro: "${r.answer}")`).join(' e ')}. Diga com gentileza que isso não pode, sem abrir exceção, e mantenha o resto da resposta.`);
        }
        if (partnershipPending) {
          problems.push('o cliente propôs permuta/parceria/divulgação e você não passou para a equipe. Use transferir_para_atendente (motivo: proposta de permuta/parceria) e diga com simpatia que a equipe vai avaliar a proposta, sem aceitar, recusar ou falar em desconto.');
        }
        console.warn(`[AI Agent] Resposta refeita (conv ${conv.id}):${partnershipPending ? ' permuta sem passar para a equipe;' : ''} ${falseClaims.length > 0 ? `disse que mandou material sem envio registrado (${falseClaims[0].slice(0, 80)})` : ''}${brokenRules.length > 0 ? ` contradisse o cadastro (${brokenRules.map((r) => r.topic).join(', ')})` : ''}`);
        session.addUserNote(`Sua resposta anterior NÃO foi enviada ao cliente porque ${problems.join(' Além disso, ')} Escreva de novo a resposta completa para o cliente, já corrigida, sem mencionar este aviso e sem pedir desculpas.`);
        continue;
      }
      if (falseClaims.length > 0) {
        const stripped = stripFalseMaterialClaims(finalText, await registeredMaterials());
        // Sem texto ou o resto ainda fala do material ("o que achou delas?"): a equipe confere e manda
        if (!hasSubstance(stripped.text) || refersToMaterial(stripped.text)) {
          console.error(`[AI Agent] IA insistiu em dizer que mandou material sem envio registrado — passando para a equipe (conv ${conv.id})`);
          await handOffOnFailure(supabase, instance, conv, phone, contactName, settings, 'a IA ia dizer que mandou fotos/vídeo/PDF que não saíram — confira e mande os materiais ao cliente');
          return true;
        }
        console.warn(`[AI Agent] Frase de material não enviado tirada da resposta (conv ${conv.id}): ${stripped.removed.join(' | ').slice(0, 200)}`);
        finalText = stripped.text;
      }
      if (partnershipPending) {
        // Insistiu em não passar: o sistema passa (o horário da equipe vai junto, logo abaixo)
        console.warn(`[AI Agent] Permuta/parceria passada para a equipe pelo sistema (conv ${conv.id})`);
        const motivo = 'proposta de permuta/parceria (a IA não passou sozinha)';
        const result = await toolTransferir(supabase, instance, conv, phone, contactName, settings, motivo);
        sandbox?.state.tools.push({ name: 'transferir_para_atendente', args: { motivo }, result });
      }
      if (brokenRules.length > 0) {
        const enforced = enforceHouseRules(finalText, brokenRules);
        console.warn(`[AI Agent] Resposta corrigida pelo cadastro (conv ${conv.id}): ${enforced.removed.join(' | ').slice(0, 200)}`);
        finalText = enforced.text;
      }
      // Passou para a equipe neste turno: o horário da EQUIPE vai sempre por
      // conta do sistema (a IA confundia com as janelas de visita)
      if (conv.__handoffThisTurn && !conv.__candidateLink && !finalText.includes(hoursForWhatsApp(describeTeamHours(teamHoursOf(settings))))) {
        finalText = `${finalText}\n\n${teamHoursMessage(settings)}`;
      }
      // Dia da semana errado junto de uma data ("sexta-feira, 17 de outubro" quando é sábado): corrige
      // + "amanhã (quarta, 7 de outubro)" quando a data é hoje ou amanhã
      // Marcador interno do histórico nunca vai ao cliente
      finalText = finalText.replace(/^\s*\[Equipe\]\s*/i, '');
      // Destaque do pacote que a IA esqueceu de preencher não vai ao cliente
      finalText = finalText.replace(/\s*[—–-]\s*\{destaques\}/g, '').replace(/\{destaques\}/g, '');
      const fixedText = markTodayTomorrow(fixWeekdays(finalText, ymdBR(Date.now())), ymdBR(Date.now()));
      if (fixedText !== finalText) {
        console.warn(`[AI Agent] Data ajustada na resposta (dia da semana ou hoje/amanhã) (conv ${conv.id})`);
        finalText = fixedText;
      }
      // Convite para visita fora de hora (convidou há menos de 3 respostas, o
      // cliente desistiu ou já tem visita marcada) e o cliente não pediu: sai da mensagem
      const visitAgo = repliesSinceVisitInvite(chatMessages);
      const affirmedNow = clientAffirms(lastUserText);
      if (!clientAsksVisit(lastUserText) && ((visitAgo !== null && visitAgo < 3 && !affirmedNow) || clientDeclined(lastUserText) || leadVisit)) {
        const stripped = stripVisitInvite(finalText);
        if (stripped.removed) {
          console.warn(`[AI Agent] Convite para visita fora de hora tirado da resposta (conv ${conv.id}, convidou há ${visitAgo ?? '-'} resposta(s))`);
          finalText = stripped.text;
        }
      }
      // Trava de valores: todo "R$" da resposta tem de ter vindo da tabela (neste
      // turno ou já dito antes na conversa). Valor inventado não sai.
      const allowedValues = allowedMoneyValues([
        ...(conv.__quotedValues || []),
        // Valor que está na resposta do cadastro (ex.: "só o bolo, com taxa de R$ 150")
        ...houseRules.flatMap((r) => moneyValuesIn(r.answer)),
        ...chatMessages.filter((m) => m.role === 'assistant').flatMap((m) => moneyValuesIn(m.content)),
      ]);
      const unknownValues = moneyValuesIn(finalText).filter((v) => !allowedValues.some((a) => Math.abs(a - v) < 0.01));
      if (unknownValues.length > 0) {
        console.error(`[AI Agent] Resposta citou valor fora da tabela (${unknownValues.map(formatBRL).join(', ')}) — não enviada (conv ${conv.id})`);
        await handOffOnFailure(supabase, instance, conv, phone, contactName, settings, `a IA ia citar valor fora da tabela (${unknownValues.map(formatBRL).join(', ')}) — passe o valor ao cliente`);
        return true;
      }
      // Chegou mensagem nova do cliente enquanto esta resposta era montada (ex.:
      // durante o envio dos materiais): descarta esta e deixa a execução da
      // mensagem mais nova responder tudo de uma vez. Confere no último
      // instante, logo antes de enviar, depois de esperar a mensagem que ainda
      // pode estar a caminho (no lugar do "digitando..." de 2 s).
      const lateCheck = Boolean(myMessageId && !conv.__handoffThisTurn);
      if (lateCheck) {
        await sandboxSleep(AI_INBOUND_LAG_MS);
        const latestNow = await latestIncomingId(supabase, conv.id);
        if (latestNow && latestNow !== myMessageId) {
          console.log(`[AI Agent] Mensagem nova (${latestNow}) chegou durante a resposta — a mais nova responde por todas`);
          return true;
        }
      }
      // Valores sempre com centavos ("R$ 7.400,00") e parágrafo corrido em blocos curtos
      finalText = spaceHighlightList(airyParagraphs(moneyWithCents(finalText)));
      // Quer trabalhar: o link do cadastro vai sempre pelo sistema, no fim
      if (conv.__candidateLink) finalText = withCandidateLink(finalText, conv.__candidateLink);
      // Resposta que vai com fotos, vídeo e PDF: a 1ª parte sai antes e a
      // pergunta ("o que achou?") depois do PDF, para a Bia não ficar quieta
      const withMaterials = Boolean(conv.__deferMaterials && !conv.__handoffThisTurn && conv.bot_step !== 'human_takeover');
      const parts = withMaterials ? splitAroundMaterials(finalText) : { before: dropMaterialsBreak(finalText), after: '' };
      const firstText = parts.before || dropMaterialsBreak(finalText);
      // "digitando..." por 2 s no WhatsApp do cliente antes da resposta (Z-API)
      const tSend = Date.now();
      // 1ª resposta da Bia: vai com a arte dela, a apresentação na legenda
      const introImage = isFirstReply ? introImageUrl(settings) : null;
      let delivered = false;
      if (introImage && firstText.length <= 1000) {
        delivered = await sendViaWapiSend(supabase, 'send-image', instance, conv, { mediaUrl: introImage, caption: firstText });
        if (!delivered) console.warn(`[AI Agent] Arte de apresentação não saiu — vai só o texto (conv ${conv.id})`);
      }
      if (!delivered) delivered = await sendViaWapiSend(supabase, 'send-text', instance, conv, lateCheck ? { message: firstText } : { message: firstText, delayTyping: 2 });
      console.log(`[AI Agent] Tempos (conv ${conv.id}): espera ${((tAfterWait - tStart) / 1000).toFixed(1)}s (alvo ${waitMs / 1000}s), preparo ${((tPrepared - tAfterWait) / 1000).toFixed(1)}s, modelo ${(modelMs / 1000).toFixed(1)}s, ferramentas ${(toolMs / 1000).toFixed(1)}s, envio ${((Date.now() - tSend) / 1000).toFixed(1)}s, total ${((Date.now() - tStart) / 1000).toFixed(1)}s`);
      if (!delivered) {
        console.error(`[AI Agent] Resposta da IA não foi entregue ao WhatsApp (conv ${conv.id})`);
        await handOffOnFailure(supabase, instance, conv, phone, contactName, settings, 'a resposta da IA não saiu no WhatsApp — responda o cliente');
        return true;
      }
      await touchHandoffMark(supabase, conv);
      // Fotos, vídeo e PDF depois da resposta (lead do site com mês e
      // convidados já conhecidos) — só se a conversa seguiu com a IA
      if (withMaterials) {
        conv.__deferMaterials = false;
        const out = { sent: false };
        await autoSendMaterials(supabase, instance, conv, phone, contactName, botSettings, {}, '', NaN, out);
        // Depois do PDF, a pergunta — a não ser que o cliente já tenha escrito
        // de novo (aí a resposta a ele é que vale)
        if (out.sent) {
          const latestNow = myMessageId ? await latestIncomingId(supabase, conv.id) : null;
          if (latestNow && latestNow !== myMessageId) {
            console.log(`[AI Agent] Cliente escreveu durante o envio dos materiais — a pergunta final fica para a próxima resposta (conv ${conv.id})`);
          } else {
            // Sem a 2ª parte da IA: convite para visita com 2 horários livres
            // (ou "o que achou?" se já tem visita, acabou de convidar ou não há horário)
            const firstName = firstNameOrEmpty(String(bd.nome || ''));
            const seed = Math.floor(Date.now() / 1000);
            const recentInvite = repliesSinceVisitInvite(chatMessages);
            const canInvite = !leadVisit && !(recentInvite !== null && recentInvite < 3) && !clientDeclined(lastUserText);
            // Sem o dia da festa (só o mês): pergunta o dia antes do convite
            // (autoSendMaterials já marcou dia_perguntado quando o PDF saiu)
            const bdAfter = (conv.bot_data || {}) as Json;
            const askDay = !pendingPartyDate(conv) && typeof bdAfter.dia_perguntado === 'string' &&
              Date.now() - Date.parse(bdAfter.dia_perguntado) < 10 * 60000 && !bdAfter.data_festa;
            let closing = askDay
              ? askPartyDayAfterMaterials(firstName, String(bdAfter.mes || ''), seed)
              : parts.after
              || (canInvite ? visitInviteAfterMaterials(firstName, pickTwoOffers(available), ymdBR(Date.now()), seed) : null)
              || closingAfterMaterials(firstName, seed);
            // Data da festa pedida: livre → boa notícia junto do convite;
            // reservada → no lugar do convite, aviso com datas livres (o
            // convite fica para depois que ele escolher)
            const pendingDate = pendingPartyDate(conv);
            const pd = conv.__partyDate && conv.__partyDate.date === pendingDate
              ? conv.__partyDate
              : pendingDate ? await checkPartyDate(supabase, instance, settings, pendingDate) : null;
            if (pd && pd.status === 'free') {
              closing = `${partyDateFreeNote(pd.date)}\n\n${closing}`;
            } else if (pd) {
              closing = partyDateTakenMessage({
                firstName,
                ymd: pd.date,
                alternatives: pd.alternatives,
                recess: pd.status === 'recess',
                birthdayName: firstNameOrEmpty(String((conv.bot_data as Json | null)?.aniversariante || '')) || null,
              });
            }
            const closingSent = await sendViaWapiSend(supabase, 'send-text', instance, conv, { message: closing, delayTyping: 2 });
            if (pd && closingSent) {
              await markPartyDateChecked(supabase, conv, pd);
              if (pd.status !== 'free' && !pd.alternatives) {
                await toolTransferir(supabase, instance, conv, phone, contactName, settings, `data pedida (${formatDateLong(pd.date)}) já reservada, sem datas livres por perto — ofereça opções`);
              }
            }
          }
        }
      }
      return true;
    }

    console.warn('[AI Agent] Max tool rounds reached without final reply');
    await handOffOnFailure(supabase, instance, conv, phone, contactName, settings, 'a IA se enrolou e não terminou a resposta — responda o cliente');
    return true;
  } catch (err) {
    console.error('[AI Agent] Unexpected error:', err);
    // Conversa já era da IA: passa para a equipe em vez de ficar em silêncio
    // (e não deixa o bot fixo atropelar no meio). Antes de adotar, segue o bot fixo.
    if (conv.bot_step === AI_STEP) {
      await handOffOnFailure(supabase, instance, conv, phone, contactName, settings, 'erro inesperado na IA — responda o cliente');
      return true;
    }
    return false;
  }
}

// Qualquer falha da IA numa conversa que é dela vira passagem para a equipe
// (histórico + sininho + alerta forte se ninguém responder) e o cliente
// recebe uma mensagem curta com o horário da equipe. Nunca lança.
async function handOffOnFailure(
  supabase: any,
  instance: AgentInstance,
  conv: AgentConv,
  phone: string,
  contactName: string | null,
  settings: AiSettings | null,
  reason: string,
): Promise<void> {
  try {
    // Já passou para a equipe neste turno (a IA chamou a ferramenta): não
    // duplica histórico/aviso, só garante a mensagem ao cliente
    if (conv.bot_step !== 'human_takeover') {
      await toolTransferir(supabase, instance, conv, phone, contactName, settings, reason);
    }
    const hours = settings ? ` ${teamHoursMessage(settings)}` : '';
    await sendViaWapiSend(supabase, 'send-text', instance, conv, {
      message: `Vou pedir para alguém da nossa equipe continuar com você por aqui, tá? 😊${hours}`,
    });
    await touchHandoffMark(supabase, conv);
  } catch (err) {
    console.error('[AI Agent] Falha até ao passar para a equipe:', err);
  }
}
