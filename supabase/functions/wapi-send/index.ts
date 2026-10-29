import { createClient } from "npm:@supabase/supabase-js@2";
import { isConversationPaused } from "../_shared/bot-loop-guard.ts";
import { mediaAckMetadata } from "../_shared/media-ack.ts";
import { zapiLinkBody } from "../_shared/link-preview.ts";
import { EVOLUTION_WEBHOOK_EVENTS, isHeldError, evolutionDownloadMedia, evolutionReact, evolutionRequest, evolutionStatus, type EvolutionQuoted, evolutionSendMedia, evolutionSendText, extractEvolutionMessageId } from "../_shared/evolution.ts";
import { decryptWhatsAppMedia, encryptedMediaUrl, type WaMediaType } from "../_shared/whatsapp-media-crypto.ts";
import { classifyEvolutionStatus, skipLoggedOutCheck } from "../_shared/evolution-health.ts";
import { isContactBlocked } from "../_shared/contact-block.ts";
import { replyOnlyUntil } from "../_shared/system-send-pacing.ts";
import { claimEvolutionLock, installEvolutionCallGuard, PAUSED_INSTANCE_ROW_IDS, recentConnectionEvent, releaseEvolutionLock } from "../_shared/evolution-guard.ts";
import { aiTakesSiteLead, buildAiSiteWelcome, cleanSiteLead, type SiteLeadInfo, siteLeadBotData } from "../_shared/ai-site-lead.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const WAPI_BASE_URL = 'https://api.w-api.app/v1';
const ZAPI_BASE_URL = 'https://api.z-api.io/instances';
const RECONNECT_AUTOMATION_QUARANTINE_MS = 15 * 60 * 1000;

type Provider = 'wapi' | 'zapi' | 'evolution';

function waitUntil(promise: Promise<unknown>): void {
  const runtime = (globalThis as Record<string, unknown>).EdgeRuntime as { waitUntil?: (promise: Promise<unknown>) => void } | undefined;
  if (runtime?.waitUntil) {
    runtime.waitUntil(promise);
    return;
  }
  promise.catch((err) => console.error('[Background task] Unhandled error:', err));
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Outbound message trace (non-blocking, fire-and-forget)
// Writes to public.message_trace_logs via RPC log_message_trace.
// NEVER throws — any failure is swallowed so the send path is unaffected.
// ─────────────────────────────────────────────────────────────────────────────
function fireTrace(
  supabase: any,
  args: {
    tracking_id: string;
    stage: string;
    status?: string;
    provider?: string | null;
    instance_id?: string | null;
    company_id?: string | null;
    conversation_id?: string | null;
    message_id?: string | null;
    phone?: string | null;
    direction?: string;
    error_message?: string | null;
    latency_ms?: number | null;
    payload_summary?: Record<string, unknown> | null;
  },
): void {
  try {
    const p = supabase.rpc('log_message_trace', {
      _tracking_id: args.tracking_id,
      _provider: args.provider ?? null,
      _instance_id: args.instance_id ?? null,
      _company_id: args.company_id ?? null,
      _conversation_id: args.conversation_id ?? null,
      _message_id: args.message_id ?? null,
      _phone: args.phone ?? null,
      _direction: args.direction ?? 'outbound',
      _stage: args.stage,
      _status: args.status ?? 'info',
      _payload_summary: args.payload_summary ?? null,
      _error_message: args.error_message ?? null,
      _latency_ms: args.latency_ms ?? null,
    });
    if (p && typeof (p as Promise<unknown>).then === 'function') {
      (p as Promise<unknown>).then(() => {}, () => {});
    }
  } catch (_e) {
    // swallow — tracing must NEVER break the outbound send
  }
}

function newTrackingId(): string {
  try {
    return `out_${crypto.randomUUID()}`;
  } catch {
    return `out_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function getReconnectQuarantineUntil(instance: Record<string, unknown> | null | undefined): Date | null {
  const connectedAt = instance?.connected_at ? new Date(String(instance.connected_at)).getTime() : 0;
  if (!connectedAt || Number.isNaN(connectedAt)) return null;
  const quarantineUntil = connectedAt + RECONNECT_AUTOMATION_QUARANTINE_MS;
  if (quarantineUntil <= Date.now()) return null;
  return new Date(quarantineUntil);
}

// ─────────────────────────────────────────────────────────────────────────────
// LID → Real phone resolution
// ─────────────────────────────────────────────────────────────────────────────
// When Z-API returns a conversation with `remote_jid = <digits>@lid`, the
// `<digits>` are NOT a routable phone — they are an internal WhatsApp Linked
// Identifier. Sending to that "number" is silently accepted by Z-API
// (returns messageId, status=sent) but the message NEVER reaches the device.
//
// This helper tries to resolve a real BR phone number for a LID-based send,
// using progressively wider sources.
async function resolveLidToRealPhone(
  supabase: any,
  rawPhone: string,
  conversationId: string | null,
  companyId: string | null
): Promise<{ phone: string; resolved: boolean; source?: string }> {
  const original = String(rawPhone || '');
  // Detect LID candidates: caller passed "<digits>@lid" OR conversation row is @lid
  const looksLikeLidLiteral = original.toLowerCase().endsWith('@lid');
  // After /\D/g cleanup the front sends only digits — but if those digits don't
  // start with country code 55 AND length is unusual (15+), it's almost certainly a LID.
  const digitsOnly = original.replace(/\D/g, '');
  const looksLikeLidNumeric = !looksLikeLidLiteral && digitsOnly.length >= 14 && !digitsOnly.startsWith('55');

  let conv: any = null;
  if (conversationId) {
    const { data } = await supabase
      .from('wapi_conversations')
      .select('id, company_id, instance_id, remote_jid, contact_name, contact_phone, lead_id')
      .eq('id', conversationId)
      .maybeSingle();
    conv = data;
  }

  const convIsLid = conv?.remote_jid?.toLowerCase?.().endsWith('@lid');

  // Bail out fast if nothing suggests this is a LID send
  if (!looksLikeLidLiteral && !looksLikeLidNumeric && !convIsLid) {
    return { phone: digitsOnly || original, resolved: false };
  }

  console.log(`[resolveLid] Attempting LID resolution. raw="${original}" convIsLid=${convIsLid} convId=${conversationId}`);

  // Heuristic: a Brazilian phone with country code is 12-13 digits and starts with 55
  const isValidBrPhone = (p: string | null | undefined): boolean => {
    if (!p) return false;
    const d = p.replace(/\D/g, '');
    return d.length >= 12 && d.length <= 13 && d.startsWith('55');
  };

  // 1) If the conversation already has a real contact_phone stored, use it
  if (conv?.contact_phone && isValidBrPhone(conv.contact_phone)) {
    const p = conv.contact_phone.replace(/\D/g, '');
    console.log(`[resolveLid] ✅ source=conv.contact_phone → ${p}`);
    return { phone: p, resolved: true, source: 'conv.contact_phone' };
  }

  // 2) Try metadata.real_phone from the latest received message in this conversation
  if (conv?.id) {
    const { data: lastMsg } = await supabase
      .from('wapi_messages')
      .select('metadata')
      .eq('conversation_id', conv.id)
      .eq('from_me', false)
      .not('metadata->>real_phone', 'is', null)
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle();
    const realFromMeta = lastMsg?.metadata?.real_phone;
    if (isValidBrPhone(realFromMeta)) {
      const p = String(realFromMeta).replace(/\D/g, '');
      console.log(`[resolveLid] ✅ source=metadata.real_phone → ${p}`);
      // Persist on the conversation for future sends
      await supabase.from('wapi_conversations').update({ contact_phone: p }).eq('id', conv.id);
      return { phone: p, resolved: true, source: 'metadata.real_phone' };
    }
  }

  // 3) If conversation is linked to a lead, use the lead's whatsapp number
  if (conv?.lead_id) {
    const { data: lead } = await supabase
      .from('campaign_leads')
      .select('whatsapp')
      .eq('id', conv.lead_id)
      .maybeSingle();
    if (isValidBrPhone(lead?.whatsapp)) {
      const p = String(lead.whatsapp).replace(/\D/g, '');
      const phoneWithCC = p.startsWith('55') ? p : `55${p}`;
      console.log(`[resolveLid] ✅ source=lead.whatsapp → ${phoneWithCC}`);
      await supabase.from('wapi_conversations').update({ contact_phone: phoneWithCC }).eq('id', conv.id);
      return { phone: phoneWithCC, resolved: true, source: 'lead.whatsapp' };
    }
  }

  // 4) Cross-reference with another conversation (same company) sharing the contact_name
  //    that has a real @s.whatsapp.net jid.
  if (conv?.contact_name && (conv.company_id || companyId)) {
    const cid = conv.company_id || companyId;
    const { data: sibling } = await supabase
      .from('wapi_conversations')
      .select('contact_phone, remote_jid')
      .eq('company_id', cid)
      .eq('contact_name', conv.contact_name)
      .like('remote_jid', '%@s.whatsapp.net')
      .order('last_message_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (isValidBrPhone(sibling?.contact_phone)) {
      const p = sibling.contact_phone.replace(/\D/g, '');
      console.log(`[resolveLid] ✅ source=sibling_conversation → ${p}`);
      await supabase.from('wapi_conversations').update({ contact_phone: p }).eq('id', conv.id);
      return { phone: p, resolved: true, source: 'sibling_conversation' };
    }
  }

  console.warn(`[resolveLid] ❌ Unable to resolve LID "${original}" to a real phone (convId=${conversationId})`);
  return { phone: digitsOnly || original, resolved: false };
}

interface InstanceCredentials {
  instance_id: string;
  instance_token: string;
  provider: Provider;
  client_token: string | null;
}

// Helper to get instance credentials
async function getInstanceCredentials(
  supabase: any,
  req: Request,
  body: { instanceId?: string; instanceToken?: string; unit?: string; companyId?: string }
): Promise<InstanceCredentials | Response> {
  const { unit, companyId } = body;
  const instanceId = typeof body.instanceId === 'string' ? body.instanceId.trim() : body.instanceId;
  const instanceToken = typeof body.instanceToken === 'string' ? body.instanceToken.trim() : body.instanceToken;
  
  // Direct credentials provided (backward compat for webhook/config flows)
  if (instanceId && instanceToken) {
    // Always verify instance exists in DB — never fall back to caller-provided token
    // if the instance is unknown. This prevents phantom-instance abuse.
    const { data: providerInfo } = await supabase
      .from('wapi_instances')
      .select('instance_token, provider, client_token')
      .eq('instance_id', instanceId)
      .maybeSingle();
    if (!providerInfo) {
      return new Response(JSON.stringify({ error: 'Instância não registrada no sistema' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return {
      instance_id: instanceId,
      instance_token: providerInfo.instance_token.trim(),
      provider: (providerInfo.provider as Provider) || 'wapi',
      client_token: providerInfo.client_token || null,
    };
  }

  // Fetch by unit (public chatbot flow)
  if (unit) {
    // limit(1)+maybeSingle: uma unidade pode ter mais de uma instância conectada —
    // .single() estourava erro e derrubava o envio da LP nesse caso.
    const { data: instance, error } = await supabase
      .from('wapi_instances')
      .select('instance_id, instance_token, provider, client_token')
      .eq('unit', unit)
      .eq('status', 'connected')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error || !instance) {
      return new Response(JSON.stringify({ error: `Instância não encontrada para unidade ${unit}` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return { instance_id: instance.instance_id, instance_token: instance.instance_token, provider: (instance.provider as Provider) || 'wapi', client_token: instance.client_token || null };
  }

  // Authenticated user flow — resolve token server-side
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const jwtToken = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(jwtToken);

  if (authError || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Verify user has company access before returning credentials
  if (instanceId) {
    // Lookup by instanceId (without token) — verify user belongs to the same company
    const { data: instance } = await supabase
      .from('wapi_instances')
      .select('instance_id, instance_token, company_id, provider, client_token')
      .eq('instance_id', instanceId)
      .single();

    if (!instance) {
      return new Response(JSON.stringify({ error: 'Instance not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Verify user has access to this company
    const { data: hasAccess } = await supabase.rpc('user_has_company_access', {
      _user_id: user.id,
      _company_id: instance.company_id,
    });

    if (!hasAccess) {
      return new Response(JSON.stringify({ error: 'Access denied to this instance' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return { instance_id: instance.instance_id, instance_token: instance.instance_token, provider: (instance.provider as Provider) || 'wapi', client_token: instance.client_token || null };
  }

  // Lookup by companyId — get first connected instance
  if (companyId) {
    const { data: hasAccess } = await supabase.rpc('user_has_company_access', {
      _user_id: user.id,
      _company_id: companyId,
    });

    if (!hasAccess) {
      return new Response(JSON.stringify({ error: 'Access denied' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: instance } = await supabase
      .from('wapi_instances')
      .select('instance_id, instance_token, provider, client_token')
      .eq('company_id', companyId)
      .eq('status', 'connected')
      .limit(1)
      .maybeSingle();

    if (!instance) {
      return new Response(JSON.stringify({ error: 'No connected instance for this company' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return { instance_id: instance.instance_id, instance_token: instance.instance_token, provider: (instance.provider as Provider) || 'wapi', client_token: instance.client_token || null };
  }

  // Fallback: lookup by user_id
  const { data: instance } = await supabase
    .from('wapi_instances')
    .select('instance_id, instance_token, provider, client_token')
    .eq('user_id', user.id)
    .limit(1)
    .single();

  if (!instance) {
    return new Response(JSON.stringify({ error: 'No W-API instance configured' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return { instance_id: instance.instance_id, instance_token: instance.instance_token, provider: (instance.provider as Provider) || 'wapi', client_token: instance.client_token || null };
}

// Helper for W-API calls with error handling
async function wapiRequest(url: string, token: string, method: string, body?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const contentType = res.headers.get('content-type');
    if (contentType?.includes('text/html')) {
      return { ok: false, error: 'Instância W-API indisponível' };
    }

    const data = await res.json();
    const providerReportedError = typeof data.error === 'string' ? data.error : null;
    if (!res.ok || providerReportedError) {
      return { ok: false, error: providerReportedError || data.message || 'Erro na W-API' };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Erro de comunicação' };
  }
}

// ============= Z-API HELPER FUNCTIONS =============

function zapiUrl(instanceId: string, token: string, path: string): string {
  return `${ZAPI_BASE_URL}/${instanceId}/token/${token}/${path}`;
}

function normalizeZapiQrValue(qr: unknown): string | null {
  if (typeof qr !== 'string') return null;

  const trimmed = qr.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('data:')) {
    return trimmed;
  }

  const looksLikeRawQrPayload =
    trimmed.includes('https://wa.me/') ||
    trimmed.includes('@') ||
    trimmed.includes(',') ||
    trimmed.startsWith('2@');

  if (looksLikeRawQrPayload) {
    return trimmed;
  }

  const looksLikeBase64 = /^[A-Za-z0-9+/=\s]+$/.test(trimmed);
  if (looksLikeBase64) {
    return `data:image/png;base64,${trimmed}`;
  }

  return trimmed;
}

async function zapiRequest(instanceId: string, token: string, clientToken: string | null, path: string, method: string, body?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (clientToken) {
      headers['Client-Token'] = clientToken;
    }
    const url = zapiUrl(instanceId, token, path);
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const contentType = res.headers.get('content-type');
    if (contentType?.includes('text/html')) {
      return { ok: false, error: 'Instância Z-API indisponível' };
    }

    const data = await res.json();
    const providerReportedError = typeof data.error === 'string' ? data.error : null;
    if (!res.ok || providerReportedError) {
      return { ok: false, data, error: data.message || providerReportedError || 'Erro na Z-API' };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Erro de comunicação Z-API' };
  }
}

async function zapiReinforceNotifySentByMe(instanceId: string, token: string, clientToken: string | null, context: string): Promise<void> {
  const webhookUrl = `${(Deno.env.get('SUPABASE_URL') || 'https://rsezgnkfhodltrsewlhz.supabase.co').replace(/\/$/, '')}/functions/v1/wapi-webhook`;
  const attempts = await Promise.allSettled([
    zapiRequest(instanceId, token, clientToken, 'update-notify-sent-by-me', 'PUT', { notifySentByMe: true }),
    zapiRequest(instanceId, token, clientToken, 'update-webhook-received', 'PUT', { value: webhookUrl, notifySentByMe: true }),
    zapiRequest(instanceId, token, clientToken, 'update-webhook-receive-all-notifications', 'PUT', { value: webhookUrl, notifySentByMe: true }),
  ]);
  console.log(`[zapi-webhook] reinforce notify-sent-by-me (${context}): ${attempts.map((r) => r.status === 'fulfilled' && r.value.ok ? 'OK' : 'FAIL').join(',')}`);
}

// Z-API send text. When messageId is present, Z-API sends a native WhatsApp reply/quote.
async function zapiSendText(instanceId: string, token: string, clientToken: string | null, rawPhone: string, message: string, quotedProviderMessageId?: string | null, delayTyping?: number): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const phone = rawPhone.endsWith('@g.us') ? rawPhone : String(rawPhone || '').replace(/\D/g, '');
  // Link de formulário/contrato: vai com prévia (imagem e nome do buffet); se a Z-API recusar, segue como texto
  if (!quotedProviderMessageId) {
    const linkBody = await zapiLinkBody(phone, message);
    if (linkBody) {
      const res = await zapiRequest(instanceId, token, clientToken, 'send-link', 'POST', linkBody);
      if (res.ok) {
        console.log(`[Z-API] send-link success to ${phone}`);
        waitUntil(zapiReinforceNotifySentByMe(instanceId, token, clientToken, 'after-send-text'));
        return res;
      }
      console.warn(`[Z-API] send-link falhou (${res.error}) — enviando como texto`);
    }
  }
  const payload: Record<string, unknown> = { phone, message };
  if (quotedProviderMessageId) payload.messageId = quotedProviderMessageId;
  // "digitando..." no WhatsApp do cliente por N segundos antes da mensagem (Z-API: 1 a 15)
  if (delayTyping && delayTyping >= 1) payload.delayTyping = Math.min(15, Math.round(delayTyping));
  const res = await zapiRequest(instanceId, token, clientToken, 'send-text', 'POST', payload);
  if (res.ok) {
    console.log(`[Z-API] send-text success to ${phone}${quotedProviderMessageId ? ` replyingTo=${quotedProviderMessageId}` : ''}`);
    waitUntil(zapiReinforceNotifySentByMe(instanceId, token, clientToken, 'after-send-text'));
  }
  return res;
}

// Z-API send image
async function zapiSendImage(instanceId: string, token: string, clientToken: string | null, phone: string, imageUrl: string, caption?: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return zapiRequest(instanceId, token, clientToken, 'send-image', 'POST', {
    phone: String(phone).replace(/\D/g, ''),
    image: imageUrl,
    caption: caption || '',
  });
}

// Z-API send audio
async function zapiSendAudio(instanceId: string, token: string, clientToken: string | null, phone: string, audioUrl: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return zapiRequest(instanceId, token, clientToken, 'send-audio', 'POST', {
    phone: String(phone).replace(/\D/g, ''),
    audio: audioUrl,
  });
}

// Z-API send video
async function zapiSendVideo(instanceId: string, token: string, clientToken: string | null, phone: string, videoUrl: string, caption?: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return zapiRequest(instanceId, token, clientToken, 'send-video', 'POST', {
    phone: String(phone).replace(/\D/g, ''),
    video: videoUrl,
    caption: caption || '',
  });
}

// Z-API send document (requires extension in URL path)
async function zapiSendDocument(instanceId: string, token: string, clientToken: string | null, phone: string, docUrl: string, fileName: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const ext = fileName.split('.').pop() || docUrl.split('.').pop()?.split('?')[0] || 'pdf';
  return zapiRequest(instanceId, token, clientToken, `send-document/${ext}`, 'POST', {
    phone: String(phone).replace(/\D/g, ''),
    document: docUrl,
    fileName,
  });
}

// Z-API get QR code — use 'qr-code' (JSON with base64) not 'qr-code/image' (raw binary)
async function zapiGetQr(instanceId: string, token: string, clientToken: string | null): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return zapiRequest(instanceId, token, clientToken, 'qr-code', 'GET');
}

// Z-API get status
async function zapiGetStatus(instanceId: string, token: string, clientToken: string | null): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return zapiRequest(instanceId, token, clientToken, 'status', 'GET');
}

// Z-API disconnect
async function zapiDisconnect(instanceId: string, token: string, clientToken: string | null): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return zapiRequest(instanceId, token, clientToken, 'disconnect', 'GET');
}

// Z-API request pairing code
async function zapiRequestPairingCode(instanceId: string, token: string, clientToken: string | null, phoneNumber: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return zapiRequest(instanceId, token, clientToken, `phone-code/${phoneNumber}`, 'GET');
}

// Z-API configure webhooks (all at once)
async function zapiConfigureWebhooks(instanceId: string, token: string, clientToken: string | null, webhookUrl: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  // Z-API exposes a single endpoint that registers the same URL for ALL webhook
  // events at once (received, on-send/fromMe, delivery, status, connected, etc.).
  // This is preferred over per-event endpoints because some of those (notably
  // 'update-webhook-message-sent') return NOT_FOUND on certain Z-API plans,
  // leaving the on-send webhook unregistered — which causes mensagens enviadas
  // pelo celular do buffet to never reach our backend.
  // CRITICAL: notifySentByMe=true makes the "Ao receber" webhook ALSO fire for
  // messages the buffet sends from the phone (with full content), not just status
  // callbacks. Without this, mensagens enviadas pelo celular nunca aparecem na
  // plataforma porque o backend só recebe MessageStatusCallback (sem conteúdo).
  const primary = await zapiRequest(instanceId, token, clientToken, 'update-every-webhooks', 'PUT', { value: webhookUrl, notifySentByMe: true });
  if (primary.ok) {
    // Also explicitly enable notifySentByMe via the dedicated endpoint as
    // double-insurance (some Z-API plans ignore the flag in update-every-webhooks).
    const notifyAttempts = await Promise.allSettled([
      zapiRequest(instanceId, token, clientToken, 'update-notify-sent-by-me', 'PUT', { notifySentByMe: true }),
      zapiRequest(instanceId, token, clientToken, 'update-notify-sent-by-me', 'PUT', { value: true }),
      zapiRequest(instanceId, token, clientToken, 'update-notify-sent-by-me', 'POST', { notifySentByMe: true }),
      zapiRequest(instanceId, token, clientToken, 'update-webhook-received', 'PUT', { value: webhookUrl, notifySentByMe: true }),
      zapiRequest(instanceId, token, clientToken, 'update-webhook-receive-all-notifications', 'PUT', { value: webhookUrl, notifySentByMe: true }),
    ]);
    console.log(`[zapi-webhook] notify-sent-by-me attempts: ${notifyAttempts.map((r) => r.status === 'fulfilled' && r.value.ok ? 'OK' : 'FAIL').join(',')}`);
    return { ok: true, data: primary.data };
  }

  // Fallback: per-event endpoints (older Z-API behavior). We tolerate NOT_FOUND
  // on individual endpoints — what matters is that AT LEAST one succeeds and
  // the primary update-every-webhooks already covers the modern accounts.
  const endpoints = [
    'update-webhook-received',
    'update-webhook-message-sent',
    'update-webhook-delivery',
    'update-webhook-message-status',
    'update-webhook-receive-all-notifications',
    'update-webhook-connected',
    'update-webhook-disconnected',
    'update-webhook-chat-presence',
  ];

  const results: Array<{ endpoint: string; ok: boolean; error?: string }> = [];
  let anyOk = false;
  let lastError = '';

  for (const ep of endpoints) {
    const res = await zapiRequest(instanceId, token, clientToken, ep, 'PUT', { value: webhookUrl });
    results.push({ endpoint: ep, ok: res.ok, error: res.error });
    if (res.ok) {
      anyOk = true;
    } else if (res.error) {
      lastError = res.error;
    }
    console.log(`[zapi-webhook] ${ep}: ${res.ok ? 'OK' : 'FAIL'}${res.error ? ` (${res.error})` : ''}`);
  }

  // Also enable "notify sent by me" so we receive our own outgoing messages WITH
  // CONTENT via the on-receive webhook. The correct body per Z-API docs is
  // { notifySentByMe: true } — the previous { value: true } silently failed.
  const notifyAttempts = await Promise.allSettled([
    zapiRequest(instanceId, token, clientToken, 'update-notify-sent-by-me', 'PUT', { notifySentByMe: true }),
    zapiRequest(instanceId, token, clientToken, 'update-notify-sent-by-me', 'PUT', { value: true }),
    zapiRequest(instanceId, token, clientToken, 'update-notify-sent-by-me', 'POST', { notifySentByMe: true }),
  ]);
  console.log(`[zapi-webhook] notify-sent-by-me attempts: ${notifyAttempts.map((r) => r.status === 'fulfilled' && r.value.ok ? 'OK' : 'FAIL').join(',')}`);

  return {
    ok: anyOk,
    data: results,
    error: anyOk ? undefined : (lastError || 'Falha ao configurar webhooks Z-API'),
  };
}

async function tryWapiWebhookRequest(
  endpoint: { url: string; method: string; body?: unknown },
  instanceToken: string,
): Promise<{ ok: boolean; status: number; data?: unknown; text?: string; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(endpoint.url, {
      method: endpoint.method,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${instanceToken}` },
      body: endpoint.body !== undefined ? JSON.stringify(endpoint.body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      return { ok: res.ok && !data?.error, status: res.status, data, error: data?.message || data?.error };
    }

    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'Erro de comunicação' };
  }
}

function extractZapiMessageId(payload: unknown): string | null {
  const data = payload as Record<string, unknown> | undefined;
  const id = data?.zapiMessageId || data?.messageId || data?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

// Mídia pela Z-API: fica "pending" até o WhatsApp confirmar (aviso SENT). Sem
// message_id não há como acompanhar — fica "sent" como antes.
function mediaInitialStatus(messageId: string | null): 'pending' | 'sent' {
  return messageId ? 'pending' : 'sent';
}

function logZapiMediaResponse(action: string, phone: string, data: unknown): void {
  console.log(`[Z-API] ${action} aceito para ${String(phone).slice(-4).padStart(8, '*')}: ${JSON.stringify(data).slice(0, 200)}`);
}

// ─── Envio direto por link: Z-API e Evolution Go ─────────────────────────
// As duas recebem a mídia por link e usam o mesmo fluxo; muda só a chamada.
// Na Evolution (whatsmeow) a resposta só volta depois que o servidor do
// WhatsApp aceitou a mensagem, então a mídia já nasce "enviada".

type DirectProvider = 'zapi' | 'evolution';
type DirectMediaKind = 'image' | 'audio' | 'video' | 'document';

function directSendText(provider: DirectProvider, instanceId: string, token: string, clientToken: string | null, phone: string, message: string, quotedProviderMessageId?: string | null, delayTyping?: number, evoQuoted?: EvolutionQuoted | null): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  if (provider === 'evolution') return evolutionSendText(token, phone, message, evoQuoted);
  return zapiSendText(instanceId, token, clientToken, phone, message, quotedProviderMessageId, delayTyping);
}

function directSendMedia(provider: DirectProvider, instanceId: string, token: string, clientToken: string | null, phone: string, kind: DirectMediaKind, url: string, opts: { caption?: string; fileName?: string } = {}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  if (provider === 'evolution') return evolutionSendMedia(token, phone, kind, url, { caption: opts.caption, filename: opts.fileName });
  if (kind === 'image') return zapiSendImage(instanceId, token, clientToken, phone, url, opts.caption);
  if (kind === 'audio') return zapiSendAudio(instanceId, token, clientToken, phone, url);
  if (kind === 'video') return zapiSendVideo(instanceId, token, clientToken, phone, url, opts.caption);
  return zapiSendDocument(instanceId, token, clientToken, phone, url, opts.fileName || 'document');
}

function directMessageId(provider: DirectProvider, data: unknown): string | null {
  return provider === 'evolution' ? extractEvolutionMessageId(data) : extractZapiMessageId(data);
}

function directMediaStatus(provider: DirectProvider, messageId: string | null): 'pending' | 'sent' {
  return provider === 'evolution' ? 'sent' : mediaInitialStatus(messageId);
}

function directMediaMetadata(provider: DirectProvider, source: string, ack: ReturnType<typeof mediaAckMetadata>): Record<string, unknown> {
  return { source, provider, ...ack, ...(provider === 'evolution' ? { ack: 'confirmed' } : {}) };
}

/** Evolution só manda mídia por link: base64 vai antes para o storage */
async function base64ToSignedUrl(supabase: any, companyId: string | null, base64: string, fallbackMime: string, prefix: string): Promise<string | null> {
  try {
    const match = /^data:([^;,]+)[^,]*,/.exec(base64);
    const mime = match?.[1] || fallbackMime;
    const raw = base64.includes(',') ? base64.split(',')[1] : base64;
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ext = mime.split('/')[1]?.split(/[;+]/)[0] || 'bin';
    const path = `${companyId || 'unknown'}/${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await supabase.storage.from('whatsapp-media').upload(path, bytes.buffer, { contentType: mime, upsert: false });
    if (error) {
      console.error('[Evolution] upload da mídia falhou:', error.message);
      return null;
    }
    const { data } = await supabase.storage.from('whatsapp-media').createSignedUrl(path, 60 * 60 * 24 * 365);
    return data?.signedUrl || null;
  } catch (e) {
    console.error('[Evolution] upload da mídia falhou:', e);
    return null;
  }
}

/**
 * Evolution: envio automático (IA, follow-up, confirmação…) que falhou fica
 * gravado como "erro" com o que é preciso para reenviar. Quando o número volta,
 * o evolution-monitor reenvia (últimas 2h, no máximo 20, uma vez só). Link de
 * mídia bloqueado não entra: reenviar não resolve.
 */
async function persistEvolutionFailure(
  supabase: any,
  conversationId: string | null | undefined,
  companyId: string | null,
  messageType: string,
  content: string,
  resend: Record<string, unknown>,
  source: string,
  error: string | undefined,
): Promise<void> {
  if (!conversationId || /^Mídia não enviada/.test(String(error || ''))) return;
  const { error: insErr } = await supabase.from('wapi_messages').insert({
    conversation_id: conversationId,
    message_id: `failed_evo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    from_me: true,
    message_type: messageType,
    content,
    ...(typeof resend.mediaUrl === 'string' ? { media_url: resend.mediaUrl } : {}),
    status: 'error',
    timestamp: new Date().toISOString(),
    company_id: companyId,
    metadata: { source, provider: 'evolution', resend, failed_reason: String(error || '').slice(0, 300), failed_at: new Date().toISOString() },
  });
  if (insErr) console.error('[Evolution] não foi possível guardar a falha para reenvio:', insErr.message);
  else console.log(`[Evolution] envio falhou (${messageType}) — guardado para reenviar quando o número voltar`);
}

/**
 * Evolution: a citação precisa do id e de quem escreveu a mensagem citada
 * (nós = telefone do número; cliente = telefone da conversa). Em grupo, sem
 * saber o autor, vai sem citação.
 */
async function evolutionQuotedFor(supabase: any, instanceExternalId: string, conversationId: string | null | undefined, quotedId: string): Promise<EvolutionQuoted | null> {
  let q = supabase.from('wapi_messages').select('from_me, conversation_id').eq('message_id', quotedId);
  if (conversationId) q = q.eq('conversation_id', conversationId);
  const { data: rows } = await q.limit(1);
  const row = (rows as Array<{ from_me: boolean; conversation_id: string }> | null)?.[0];
  if (!row) return null;
  if (row.from_me) {
    const { data: inst } = await supabase.from('wapi_instances').select('phone_number').eq('instance_id', instanceExternalId).maybeSingle();
    const own = String(inst?.phone_number || '').replace(/\D/g, '');
    return own ? { messageId: quotedId, participant: `${own}@s.whatsapp.net` } : null;
  }
  const { data: conv } = await supabase.from('wapi_conversations').select('remote_jid').eq('id', row.conversation_id).maybeSingle();
  const jid = String(conv?.remote_jid || '');
  if (!jid || jid.endsWith('@g.us')) return null;
  return { messageId: quotedId, participant: jid.includes('@') ? jid : `${jid.replace(/\D/g, '')}@s.whatsapp.net` };
}

function evolutionWebhookUrl(): string {
  return `${(Deno.env.get('SUPABASE_URL') || 'https://rsezgnkfhodltrsewlhz.supabase.co').replace(/\/$/, '')}/functions/v1/wapi-webhook`;
}

/** Valor do QR na resposta da Evolution, qualquer que seja a capitalização */
function findEvolutionQr(payload: unknown): unknown {
  const visit = (v: unknown, depth: number): unknown => {
    if (!v || typeof v !== 'object' || depth > 3) return null;
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (/^(qrcode|qr_code|qr|base64)$/i.test(k) && typeof o[k] === 'string' && o[k]) return o[k];
    }
    for (const k of Object.keys(o)) {
      if (/^code$/i.test(k) && typeof o[k] === 'string' && o[k]) return o[k];
    }
    return visit(o.data, depth + 1);
  };
  return visit(payload, 0);
}

function extractWapiMessageId(payload: unknown): string | null {
  const data = payload as Record<string, unknown> | undefined;
  const nested = (data?.data as Record<string, unknown> | undefined) || {};
  const id = data?.messageId || nested.messageId || data?.id || nested.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * For group JIDs (@g.us), W-API needs chatId instead of phone.
 * This helper tries multiple payload variants for media sends to groups.
 */
async function sendMediaWithGroupFallback(
  endpoint: string,
  token: string,
  rawPhone: string,
  basePayload: Record<string, unknown>,
  actionName: string
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const isGroup = rawPhone && rawPhone.endsWith('@g.us');
  
  if (!isGroup) {
    // Normal individual send
    const res = await wapiRequest(endpoint, token, 'POST', { ...basePayload, phone: String(rawPhone || '').replace(/\D/g, '') });
    if (res.ok) {
      console.log(`[${actionName}] Success (individual)`);
      return { ok: true, data: res.data };
    }
    return { ok: false, error: res.error || `Falha ao enviar ${actionName}` };
  }

  // Group: try multiple payload formats
  const groupAttempts = [
    { name: 'phone', body: { ...basePayload, phone: rawPhone } },
    { name: 'chatId', body: { ...basePayload, chatId: rawPhone } },
    { name: 'number', body: { ...basePayload, number: rawPhone } },
    { name: 'groupId', body: { ...basePayload, groupId: rawPhone } },
  ];
  
  for (const attempt of groupAttempts) {
    const res = await wapiRequest(endpoint, token, 'POST', attempt.body);
    if (res.ok) {
      console.log(`[${actionName}] Group success [${attempt.name}]`);
      return { ok: true, data: res.data };
    }
    console.warn(`[${actionName}] Group failed [${attempt.name}]: ${res.error}`);
  }
  return { ok: false, error: `Falha ao enviar ${actionName} para grupo (W-API)` };
}

async function sendTextWithFallback(instanceId: string, token: string, rawPhone: string, message: string, quotedProviderMessageId?: string | null) {
  const endpoint = `${WAPI_BASE_URL}/message/send-text?instanceId=${instanceId}`;
  const withQuote = (payload: Record<string, unknown>) => quotedProviderMessageId
    ? { ...payload, messageId: quotedProviderMessageId, quotedMessageId: quotedProviderMessageId, replyToMessageId: quotedProviderMessageId }
    : payload;

  // Detect group JIDs and send directly via chatId (skip phone normalization)
  if (rawPhone && rawPhone.endsWith('@g.us')) {
    const groupAttempts = [
      { name: 'phone+message', body: withQuote({ phone: rawPhone, message, delayTyping: 1 }) },
      { name: 'phone+text', body: withQuote({ phone: rawPhone, text: message, delayTyping: 1 }) },
      { name: 'chatId+message', body: withQuote({ chatId: rawPhone, message, delayTyping: 1 }) },
      { name: 'chatId+text', body: withQuote({ chatId: rawPhone, text: message, delayTyping: 1 }) },
      { name: 'number+message', body: withQuote({ number: rawPhone, message, delayTyping: 1 }) },
      { name: 'groupId+message', body: withQuote({ groupId: rawPhone, message, delayTyping: 1 }) },
    ];
    for (const attempt of groupAttempts) {
      const res = await wapiRequest(endpoint, token, 'POST', attempt.body);
      if (res.ok) {
        const msgId = extractWapiMessageId(res.data);
        console.log(`[send-text] Group success [${attempt.name}] msgId=${msgId || 'NONE'}`);
        return { ok: true, data: res.data, attempt: attempt.name };
      }
      console.warn(`[send-text] Group failed [${attempt.name}]: ${res.error}`);
    }
    return { ok: false, error: 'Falha ao enviar para grupo (W-API)' };
  }

  const phone = String(rawPhone || '').replace(/\D/g, '');

  const attempts: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: 'phone+message', body: withQuote({ phone, message, delayTyping: 1 }) },
    { name: 'phone+text', body: withQuote({ phone, text: message, delayTyping: 1 }) },
    { name: 'phoneNumber+message', body: withQuote({ phoneNumber: phone, message, delayTyping: 1 }) },
    { name: 'phoneNumber+text', body: withQuote({ phoneNumber: phone, text: message, delayTyping: 1 }) },
    { name: 'chatId+message', body: withQuote({ chatId: `${phone}@s.whatsapp.net`, message, delayTyping: 1 }) },
    { name: 'chatId+text', body: withQuote({ chatId: `${phone}@s.whatsapp.net`, text: message, delayTyping: 1 }) },
  ];

  let lastError = 'Falha ao enviar mensagem (W-API)';

  for (const attempt of attempts) {
    const res = await wapiRequest(endpoint, token, 'POST', attempt.body);
    if (res.ok) {
      const msgId = extractWapiMessageId(res.data);
      // PHASE 1+2: Validate we got a real messageId back, log response for diagnostics
      if (!msgId) {
        console.warn(`[send-text] W-API returned ok but NO messageId [${attempt.name}]. Response:`, JSON.stringify(res.data).substring(0, 300));
        // Still return ok (provider accepted), but log the anomaly
      }
      console.log(`[send-text] Success [${attempt.name}] msgId=${msgId || 'NONE'}. Response:`, JSON.stringify(res.data).substring(0, 200));
      return { ok: true, data: res.data, attempt: attempt.name };
    }
    lastError = res.error || lastError;
    console.warn(`[send-text] Failed [${attempt.name}]: ${lastError}`);
  }

  return { ok: false, error: lastError };
}

function getExtensionFromMimeType(mimeType: string | null | undefined): string {
  const normalized = (mimeType || '').split(';')[0].trim().toLowerCase();

  switch (normalized) {
    case 'audio/webm':
      return 'webm';
    case 'audio/ogg':
    case 'audio/opus':
      return 'ogg';
    case 'audio/mp4':
    case 'audio/aac':
      return 'm4a';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    default:
      return 'webm';
  }
}

// Generate Brazilian phone variants (with/without 55, with/without 9th digit)
// Used to find an existing conversation regardless of how the phone was stored.
function getBrazilianPhoneVariants(rawPhone: string): string[] {
  const clean = (rawPhone || '').replace(/\D/g, '');
  const variants = new Set<string>();
  if (!clean) return [];
  variants.add(clean);

  if (!clean.startsWith('55') && clean.length >= 10) variants.add('55' + clean);
  if (clean.startsWith('55') && clean.length >= 12) variants.add(clean.slice(2));

  const withoutCountry = clean.startsWith('55') ? clean.slice(2) : clean;
  if (withoutCountry.length === 10) {
    const withNine = withoutCountry.slice(0, 2) + '9' + withoutCountry.slice(2);
    variants.add(withNine);
    variants.add('55' + withNine);
  }
  if (withoutCountry.length === 11 && withoutCountry[2] === '9') {
    const withoutNine = withoutCountry.slice(0, 2) + withoutCountry.slice(3);
    variants.add(withoutNine);
    variants.add('55' + withoutNine);
  }
  return Array.from(variants);
}

// Helper to find or create a conversation for LP/bot outbound messages
async function findOrCreateConversation(
  supabase: any,
  phone: string,
  instanceExternalId: string,
  lpMode?: boolean,
  contactName?: string,
): Promise<{ conversationId: string; companyId: string } | null> {
  try {
    // Normalize phone for remote_jid format
    const cleanPhone = phone.replace(/\D/g, '');
    // Canonical Brazilian format always carries the country code (55).
    // We always INSERT with this canonical jid to avoid creating "ghost" duplicates
    // when the front-end happens to send the phone without the leading 55.
    const canonicalPhone = cleanPhone.startsWith('55') ? cleanPhone : `55${cleanPhone}`;
    const canonicalJid = `${canonicalPhone}@s.whatsapp.net`;

    // Find the internal instance record
    const { data: instanceRecord } = await supabase
      .from('wapi_instances')
      .select('id, company_id')
      .eq('instance_id', instanceExternalId)
      .single();

    if (!instanceRecord) {
      console.log('findOrCreateConversation: instance not found for', instanceExternalId);
      return null;
    }

    // Procura lead existente em QUALQUER formato do número (com/sem 55, com/sem
    // 9º dígito) — vale para LP e também para envio manual da equipe, para a
    // conversa nascer já vinculada ao lead antigo (evita lead duplicado).
    let matchedLeadId: string | null = null;
    {
      const leadPhoneVariants = getBrazilianPhoneVariants(cleanPhone);
      let leadQuery = supabase
        .from('campaign_leads')
        .select('id, whatsapp')
        .eq('company_id', instanceRecord.company_id)
        .in('whatsapp', leadPhoneVariants);
      // Na LP, evita casar com lead criado pelo próprio chat (prioriza o lead da LP)
      if (lpMode) leadQuery = leadQuery.not('campaign_id', 'like', 'whatsapp%');
      const { data: matchedLead } = await leadQuery
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      matchedLeadId = matchedLead?.id || null;
    }

    // Check if conversation already exists — search ALL phone variants so we
    // reuse the existing chat even if it was originally stored with/without 55
    // or with/without the 9th digit.
    const variants = getBrazilianPhoneVariants(cleanPhone);
    const remoteJids = variants.map((v) => `${v}@s.whatsapp.net`);

    const { data: existingList } = await supabase
      .from('wapi_conversations')
      .select('id, company_id, contact_name, bot_data, remote_jid, lead_id, last_message_at')
      .eq('instance_id', instanceRecord.id)
      .in('remote_jid', remoteJids)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(5);

    // Prefer the conversation that already has a lead linked, then most recent.
    const existing = (existingList || []).sort((a: any, b: any) => {
      const aHasLead = a.lead_id ? 1 : 0;
      const bHasLead = b.lead_id ? 1 : 0;
      if (aHasLead !== bHasLead) return bHasLead - aHasLead;
      const aTs = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const bTs = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return bTs - aTs;
    })[0];

    if (existing) {
      // If lpMode, reset bot state so returning leads can re-engage
      if (lpMode) {
        const updateData: Record<string, unknown> = {
          bot_step: 'lp_sent',
          bot_enabled: true,
        };
        if (matchedLeadId && !existing.lead_id) {
          updateData.lead_id = matchedLeadId;
        }
        // Update contact_name if we have a real name and current one looks like a phone number
        if (contactName && /^\d+$/.test(existing.contact_name || '')) {
          updateData.contact_name = contactName;
        }
        // Ensure bot_data.nome is set
        if (contactName) {
          const existingBotData = (existing as any).bot_data || {};
          updateData.bot_data = { ...existingBotData, nome: contactName };
        }
        await supabase.from('wapi_conversations').update(updateData).eq('id', existing.id);
        console.log('findOrCreateConversation: reset bot_step to lp_sent for existing conversation', existing.id);
      } else {
        // Envio manual: se a conversa está órfã e existe lead com esse número,
        // vincula agora (evita que a régua de status crie um lead duplicado).
        if (matchedLeadId && !existing.lead_id) {
          await supabase.from('wapi_conversations').update({ lead_id: matchedLeadId }).eq('id', existing.id);
          console.log('findOrCreateConversation: linked orphan conversation to existing lead', existing.id, matchedLeadId);
        }
        console.log('findOrCreateConversation: found existing conversation', existing.id);
      }
      return { conversationId: existing.id, companyId: existing.company_id };
    }

    // Create new conversation — always use the canonical jid (with 55) so future
    // lookups by either format hit the same row.
    const { data: newConv, error: createError } = await supabase
      .from('wapi_conversations')
      .insert({
        instance_id: instanceRecord.id,
        company_id: instanceRecord.company_id,
        remote_jid: canonicalJid,
        contact_phone: canonicalPhone,
        contact_name: contactName || canonicalPhone,
        bot_enabled: true,
        bot_step: 'lp_sent',
        last_message_from_me: true,
        ...(matchedLeadId ? { lead_id: matchedLeadId } : {}),
        ...(contactName ? { bot_data: { nome: contactName } } : {}),
      })
      .select('id, company_id')
      .single();

    if (createError) {
      // Handle unique constraint violation (race condition)
      if (createError.code === '23505') {
        const { data: retry } = await supabase
          .from('wapi_conversations')
          .select('id, company_id')
          .eq('instance_id', instanceRecord.id)
          .in('remote_jid', remoteJids)
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle();
        if (retry) {
          console.log('findOrCreateConversation: found after conflict', retry.id);
          return { conversationId: retry.id, companyId: retry.company_id };
        }
      }
      console.error('findOrCreateConversation: create error', createError);
      return null;
    }

    console.log('findOrCreateConversation: created new conversation', newConv.id);
    return { conversationId: newConv.id, companyId: newConv.company_id };
  } catch (err) {
    console.error('findOrCreateConversation error:', err);
    return null;
  }
}

function extractConnectedPhone(statusData: Record<string, unknown> | null | undefined): string | null {
  if (!statusData) return null;

  const me = statusData.me as Record<string, unknown> | undefined;
  const data = statusData.data as Record<string, unknown> | undefined;

  return (
    (typeof statusData.phone === 'string' ? statusData.phone : null) ||
    (typeof statusData.phoneNumber === 'string' ? statusData.phoneNumber : null) ||
    (typeof statusData.connectedPhone === 'string' ? statusData.connectedPhone : null) ||
    (typeof data?.phone === 'string' ? data.phone : null) ||
    (typeof data?.phoneNumber === 'string' ? data.phoneNumber : null) ||
    (typeof data?.connectedPhone === 'string' ? data.connectedPhone : null) ||
    (typeof me?.id === 'string' ? me.id.split('@')[0] : null)
  );
}

function isWapiSessionConnected(statusData: Record<string, unknown> | null | undefined): boolean {
  if (!statusData) return false;

  if (
    statusData.connected === true ||
    statusData.status === 'connected' ||
    statusData.state === 'connected'
  ) {
    return true;
  }

  const hasQrCode = Boolean(statusData.qrcode || statusData.qrCode || statusData.qr || statusData.base64);
  return !hasQrCode && !statusData.error;
}

function hasZapiConnectedMessage(rawValue: unknown): boolean {
  if (typeof rawValue !== 'string') return false;

  const value = rawValue.toLowerCase();
  return (
    value.includes('already connected') ||
    value.includes('already-connected') ||
    value.includes('já conectado') ||
    value.includes('ja conectado') ||
    value.includes('já está conectad') ||
    value.includes('ja esta conectad')
  );
}

function isZapiSessionConnected(statusData: Record<string, unknown> | null | undefined): boolean {
  if (!statusData) return false;

  if (
    statusData.connected === true ||
    statusData.status === 'connected' ||
    statusData.state === 'connected'
  ) {
    return true;
  }

  return [statusData.message, statusData.error, statusData.statusText].some(hasZapiConnectedMessage);
}

async function hasRecentVerifiedActivity(
  supabase: any,
  instanceRecordId: string,
  windowMinutes = 30,
): Promise<boolean> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  const { data: recentConversations, error: convError } = await supabase
    .from('wapi_conversations')
    .select('id')
    .eq('instance_id', instanceRecordId)
    .gte('last_message_at', since)
    .limit(50);

  if (convError) return false;

  const conversationIds = (recentConversations || []).map((conversation: { id: string }) => conversation.id);
  if (conversationIds.length === 0) return false;

  const { data: verifiedMessages, error: msgError } = await supabase
    .from('wapi_messages')
    .select('id')
    .in('conversation_id', conversationIds)
    .gte('timestamp', since)
    .or('from_me.eq.false,status.eq.delivered,status.eq.read,status.eq.received')
    .limit(1);

  if (msgError) return false;

  return (verifiedMessages?.length || 0) > 0;
}

async function persistBlockedMessage(
  supabase: any,
  conversationId?: string,
  companyId?: string | null,
  messageContent?: string,
  reason = 'DISCONNECTED',
) {
  if (!conversationId || !messageContent) return;

  const failedMsgId = `blocked_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await supabase.from('wapi_messages').insert({
    conversation_id: conversationId,
    message_id: failedMsgId,
    from_me: true,
    message_type: 'text',
    content: messageContent,
    status: 'failed',
    timestamp: new Date().toISOString(),
    company_id: companyId,
    metadata: { blocked_reason: reason },
  });
}

// === PHASE 1: Session health preflight ===
// Checks if the instance session is healthy enough to send messages.
// Returns null if healthy, or a Response with error if blocked.
async function checkSessionHealth(
  instanceExternalId: string,
  instanceToken: string,
  supabase: any,
  action: string,
  conversationId?: string,
  companyId?: string | null,
  messageContent?: string,
  isZapi?: boolean,
): Promise<Response | null> {
  // Only block send actions, not status/config actions
  const sendActions = ['send-text', 'send-image', 'send-audio', 'send-video', 'send-document', 'send-contact'];
  if (!sendActions.includes(action)) return null;

  // 🛡️ Z-API: skip W-API-specific preflight (QR endpoint doesn't apply to Z-API,
  // causing false SESSION_UNVERIFIED blocks + duplicate "blocked_" messages when
  // the caller retries. Z-API has its own status validation downstream.)
  if (isZapi) return null;

  // Check DB first
  const { data: dbInstance } = await supabase
    .from('wapi_instances')
    .select('id, status, phone_number, connected_at')
    .eq('instance_id', instanceExternalId)
    .single();

  if (!dbInstance) return null;

  // SESSION_INCOMPLETE: connected but no phone_number — try auto-recovery first
  if (dbInstance.status === 'connected' && !dbInstance.phone_number) {
    console.warn(`[Preflight] Instance ${instanceExternalId} is connected but has no phone_number. Attempting auto-recovery...`);
    const hasVerifiedActivity = await hasRecentVerifiedActivity(supabase, dbInstance.id);
    
    try {
      const statusRes = await fetch(
        `${WAPI_BASE_URL}/instance/qr-code?instanceId=${instanceExternalId}`,
        {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${instanceToken}` },
        }
      );
      
      if (statusRes.ok) {
        const ct = statusRes.headers.get('content-type');
        if (!ct?.includes('image') && !ct?.includes('text/html')) {
          const statusData = await statusRes.json();
          const phone = extractConnectedPhone(statusData);
          const isConnected = isWapiSessionConnected(statusData);
          
          if (phone) {
            console.log(`[Preflight] ✅ Auto-recovered phone_number for ${instanceExternalId}: ${phone}`);
            await supabase.from('wapi_instances').update({ 
              phone_number: phone,
              status: 'connected',
              connected_at: new Date().toISOString(),
            }).eq('id', dbInstance.id);
            return null; // Allow send
          }

          if (isConnected && hasVerifiedActivity) {
            console.log(`[Preflight] ✅ W-API confirmed ${instanceExternalId} is connected and has recent verified activity. Allowing send.`);
            await supabase.from('wapi_instances').update({
              status: 'connected',
              connected_at: new Date().toISOString(),
            }).eq('id', dbInstance.id);
            return null;
          }
        }
      }
    } catch (err) {
      console.warn(`[Preflight] Auto-recovery check failed for ${instanceExternalId}:`, err);
    }
    
    if (hasVerifiedActivity) {
      console.warn(`[Preflight] Proceeding with ${action} for ${instanceExternalId} based on recent verified activity despite missing phone_number.`);
      return null;
    }

    console.warn(`[Preflight] BLOCKED ${action}: ${instanceExternalId} has no phone_number and no recent verified activity.`);
    await supabase.from('wapi_instances').update({ status: 'degraded' }).eq('id', dbInstance.id);
    await persistBlockedMessage(supabase, conversationId, companyId, messageContent, 'SESSION_UNVERIFIED');

    return new Response(JSON.stringify({ 
      error: 'Sessão do WhatsApp parece conectada, mas não há evidência recente de entrega. Reconecte a instância pelo QR Code.',
      errorType: 'SESSION_UNVERIFIED',
      blocked: true,
    }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // DISCONNECTED: check real status before blocking
  if (dbInstance.status === 'disconnected') {
    console.warn(`[Preflight] Instance ${instanceExternalId} is disconnected in DB. Checking real status...`);
    
    // Quick real-time check against W-API
    try {
      const statusRes = await fetch(
        `${WAPI_BASE_URL}/instance/qr-code?instanceId=${instanceExternalId}`,
        {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${instanceToken}` },
        }
      );
      
      if (statusRes.ok) {
        const ct = statusRes.headers.get('content-type');
        // If response is an image or HTML, QR is being shown = still disconnected
        if (ct?.includes('image') || ct?.includes('text/html')) {
          // Confirmed disconnected
        } else {
          const statusData = await statusRes.json();
          const isConnected = isWapiSessionConnected(statusData);
          
          if (isConnected) {
            console.log(`[Preflight] ✅ W-API says connected! Auto-recovering instance ${instanceExternalId}`);
            const phone = extractConnectedPhone(statusData);
            await supabase.from('wapi_instances').update({ 
              status: 'connected', 
              connected_at: new Date().toISOString(),
              ...(phone ? { phone_number: phone } : {}),
            }).eq('id', dbInstance.id);
            return null; // Allow send
          }
        }
      }
    } catch (err) {
      console.warn(`[Preflight] Real-time status check failed for ${instanceExternalId}:`, err);
    }
    
    // Confirmed disconnected - save message as failed
    console.warn(`[Preflight] BLOCKED ${action}: instance ${instanceExternalId} confirmed disconnected`);
    
    await persistBlockedMessage(supabase, conversationId, companyId, messageContent, 'DISCONNECTED');

    return new Response(JSON.stringify({ 
      error: 'Sessão do WhatsApp desconectada. Reconecte via QR Code nas Configurações.',
      errorType: 'DISCONNECTED',
      blocked: true,
    }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase: any = createClient(supabaseUrl, supabaseServiceKey);
    // Nenhuma chamada à Evolution logo depois de uma queda do número (2 min), com trava ou número pausado
    installEvolutionCallGuard(supabase);

    const body = await req.json();
    const { action, conversationId } = body;
    // Pode trocar: lead do site com a IA atendendo recebe a boas-vindas da IA
    let message = body.message;
    let phone: string = body.phone;

    // Phase 2 trace — single tracking_id per outbound request
    const trackingId: string = (typeof body.trackingId === 'string' && body.trackingId) || newTrackingId();

    const creds = await getInstanceCredentials(supabase, req, body);
    if (creds instanceof Response) return creds;
    // Mutáveis: o failover de LP (número bloqueado) pode trocar a instância no meio do envio.
    let { instance_id, instance_token, provider, client_token } = creds;
    let isZapi = provider === 'zapi';
    // Evolution Go segue o mesmo fluxo de envio direto por link da Z-API
    let isEvolution = provider === 'evolution';
    let directProvider: DirectProvider | null = isZapi ? 'zapi' : isEvolution ? 'evolution' : null;

    // Evolution Go: só o que já foi testado no servidor. O resto responde claro
    // em vez de cair na W-API com o token da Evolution.
    const EVOLUTION_ACTIONS = ['send-text', 'send-image', 'send-audio', 'send-video', 'send-document', 'get-status', 'get-qr', 'configure-webhooks', 'download-media', 'send-reaction'];
    if (isEvolution && !EVOLUTION_ACTIONS.includes(action)) {
      console.warn(`wapi-send: ${action} ainda não disponível para Evolution Go (instance ${instance_id})`);
      return new Response(JSON.stringify({ success: false, error: 'Esta ação ainda não está disponível para números da Evolution Go.', errorType: 'UNSUPPORTED_PROVIDER', provider }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Número do cadastro ainda esperando QR (whatsapp-connect): status/QR/connect
    // por aqui reiniciam o ciclo de QR e gastam o banco da Evolution — só a tela
    // "Conectar meu WhatsApp" mexe nele até parear
    if (isEvolution && (action === 'get-status' || action === 'get-qr' || action === 'configure-webhooks')) {
      const { data: managed } = await supabase.from('wapi_instances').select('managed_by_celebrei, is_active').eq('instance_id', instance_id).maybeSingle();
      if (managed?.managed_by_celebrei === true && managed.is_active === false) {
        return new Response(JSON.stringify({ success: false, connected: false, status: 'disconnected', error: 'Este número está sendo conectado pela tela "Conectar meu WhatsApp".', provider, cached: true }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    console.log('wapi-send:', action, phone ? `phone:${phone}` : '', 'instance:', instance_id, 'trace:', trackingId);

    // 🔭 trace: send_platform_attempt — entrada do envio outbound
    fireTrace(supabase, {
      tracking_id: trackingId,
      stage: 'send_platform_attempt',
      status: 'started',
      provider,
      instance_id,
      conversation_id: conversationId ?? null,
      phone: phone ?? null,
      payload_summary: {
        action,
        provider_kind: provider,
        source: typeof body.source === 'string' ? body.source : null,
        automation: body.automation === true,
        has_message: typeof message === 'string' && message.length > 0,
        has_media: Boolean(body.mediaUrl || body.base64 || body.audio || body.video || body.document),
        caller_tracking_id: typeof body.trackingId === 'string' ? body.trackingId : null,
      },
    });

    // Resolve company_id from conversation for message inserts
    let companyId: string | null = null;
    if (conversationId) {
      const convLookupStart = Date.now();
      // 🔭 trace: conversation_lookup_attempt
      fireTrace(supabase, {
        tracking_id: trackingId,
        stage: 'conversation_lookup_attempt',
        status: 'started',
        provider,
        instance_id,
        conversation_id: conversationId,
        phone: phone ?? null,
      });

      const { data: convData, error: convErr } = await supabase
        .from('wapi_conversations')
        .select('company_id')
        .eq('id', conversationId)
        .single();
      companyId = convData?.company_id || null;

      if (convErr || !convData) {
        // 🔭 trace: conversation_lookup_error
        fireTrace(supabase, {
          tracking_id: trackingId,
          stage: 'conversation_lookup_error',
          status: 'error',
          provider,
          instance_id,
          conversation_id: conversationId,
          phone: phone ?? null,
          error_message: convErr?.message ?? 'conversation_not_found',
          latency_ms: Date.now() - convLookupStart,
        });
      } else {
        // 🔭 trace: conversation_lookup_success
        fireTrace(supabase, {
          tracking_id: trackingId,
          stage: 'conversation_lookup_success',
          status: 'ok',
          provider,
          instance_id,
          company_id: companyId,
          conversation_id: conversationId,
          phone: phone ?? null,
          latency_ms: Date.now() - convLookupStart,
        });
      }
    }


    // === LID resolution: if the destination is a @lid identifier, resolve to real phone ===
    // Only apply for outbound send actions that target a phone (not groups, not non-send actions).
    const sendActionsForLid = ['send-text', 'send-image', 'send-audio', 'send-video', 'send-document', 'send-contact'];
    if (phone && sendActionsForLid.includes(action) && !String(phone).endsWith('@g.us')) {
      const lidResult = await resolveLidToRealPhone(supabase, phone, conversationId || null, companyId);
      if (lidResult.resolved) {
        console.log(`[wapi-send] LID resolved: ${phone} → ${lidResult.phone} (source=${lidResult.source})`);
        phone = lidResult.phone;
      } else {
        // If we detected this was a LID but couldn't resolve, refuse to send (avoid silent black-hole).
        const original = String(body.phone || '');
        const looksLid = original.toLowerCase().endsWith('@lid') ||
          (original.replace(/\D/g, '').length >= 14 && !original.replace(/\D/g, '').startsWith('55'));
        if (looksLid) {
          console.error(`[wapi-send] ❌ Refusing to send to unresolved LID: ${original}`);
          // 🔭 trace: lid_unresolved — registra no message_trace_logs para diagnóstico
          fireTrace(supabase, {
            tracking_id: trackingId,
            stage: 'lid_unresolved',
            status: 'error',
            provider,
            instance_id,
            company_id: companyId,
            conversation_id: conversationId ?? null,
            phone: original,
            error_message: 'LID_UNRESOLVED: não foi possível mapear @lid para um telefone BR real após todas as heurísticas',
            payload_summary: { action, raw_phone: original },
          });
          await persistBlockedMessage(supabase, conversationId, companyId, message, 'LID_UNRESOLVED');
          return new Response(JSON.stringify({
            error: 'Não foi possível identificar o número real deste contato. Peça para o cliente enviar uma mensagem primeiro para sincronizar o número.',
            errorType: 'LID_UNRESOLVED',
            blocked: true,
          }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
    }

    // === PHASE 1: Preflight session health check for all send actions ===
    const preflightResult = await checkSessionHealth(instance_id, instance_token, supabase, action, conversationId, companyId, message, directProvider !== null);
    if (preflightResult) return preflightResult;

    // === Só responde quem chama (VENDAS 2 depois da restrição de "reachout", 16/10) ===
    // Nesse período o número não abre conversa com quem nunca escreveu para
    // ele — nem envio automático nem a equipe. Grupos e reações passam.
    if (isEvolution && sendActionsForLid.includes(action) && !String(phone || '').endsWith('@g.us')) {
      const { data: roInst } = await supabase.from('wapi_instances').select('id, unit').eq('instance_id', instance_id).maybeSingle();
      const roUntil = roInst ? replyOnlyUntil(roInst.id, Date.now()) : null;
      if (roUntil) {
        let contactWrote = false;
        if (conversationId) {
          const { data: inbound } = await supabase.from('wapi_messages').select('id').eq('conversation_id', conversationId).eq('from_me', false).limit(1);
          contactWrote = !!(inbound && inbound[0]);
        }
        if (!contactWrote) {
          const ate = new Date(Date.parse(roUntil) - 1000).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
          console.warn(`[wapi-send] 🚫 ${roInst?.unit || instance_id} só responde quem chama até ${roUntil} — não inicia conversa (phone=${phone}, action=${action}, source=${body.source ?? body.messageSource ?? 'platform'})`);
          await persistBlockedMessage(supabase, conversationId, companyId, message, 'REPLY_ONLY');
          return new Response(JSON.stringify({
            error: `O ${roInst?.unit || 'número'} está só respondendo quem manda mensagem até ${ate} (proteção depois do bloqueio do WhatsApp). Este contato ainda não escreveu para ele: use outro número para iniciar a conversa.`,
            errorType: 'REPLY_ONLY',
            blocked: true,
          }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }
    }

    // === BOT LOOP GUARD: silently block automated outbound when convo is paused ===
    // Only blocks when caller explicitly opts-in as automation (body.automation === true
    // or body.source ∈ {'bot','flow','follow-up','reactivation','visit-confirmation','campaign'}).
    // Manual UI sends are NOT blocked.
    const automationSources = new Set(['bot', 'flow', 'flow-builder', 'follow-up', 'followup', 'reactivation', 'visit-confirmation', 'campaign']);
    // 🎯 Bot de qualificação inicial (lead novo) NUNCA entra na fila/quarentena —
    // é crítico responder leads novos imediatamente. Só follow-up/reativação/campanha
    // são protegidos pelo sistema de fila pós-reconexão.
    const queueableSources = new Set(['follow-up', 'followup', 'reactivation', 'visit-confirmation', 'campaign']);
    const isAutomatedCall = body.automation === true || (typeof body.source === 'string' && automationSources.has(body.source));
    // Evolution: envio automático que falhar fica guardado para reenviar quando o número voltar
    const queueEvolutionFailure = isEvolution && (isAutomatedCall || body.messageSource === 'ai_agent');
    // Envio segurado pela trava (queda há < 2 min, monitor checando): vai para a
    // fila de reenvio mesmo sendo manual — sai quando o número estiver ok
    const queueEvo = (err: string | undefined) => queueEvolutionFailure || (isEvolution && isHeldError(err));
    const failureSource = body.messageSource === 'ai_agent' ? 'ai_agent' : (typeof body.source === 'string' && body.source ? body.source : 'platform');
    const isQueueableAutomation = typeof body.source === 'string' && queueableSources.has(body.source);

    // 🚫 "Não enviar mais nada" ligado para este número: nada automático sai
    // (bot, IA, follow-up, reativação, campanha, confirmação de visita).
    // Envio manual da equipe passa normalmente.
    if ((isAutomatedCall || body.messageSource === 'ai_agent') && action !== 'send-reaction') {
      let blockCompany = companyId;
      if (!blockCompany) {
        const { data: bInst } = await supabase.from('wapi_instances').select('company_id').eq('instance_id', instance_id).maybeSingle();
        blockCompany = bInst?.company_id || null;
      }
      let blockPhone: string | null = phone || null;
      if (!blockPhone && conversationId) {
        const { data: bConv } = await supabase.from('wapi_conversations').select('remote_jid').eq('id', conversationId).maybeSingle();
        blockPhone = bConv?.remote_jid || null;
      }
      if (await isContactBlocked(supabase, blockCompany, blockPhone)) {
        console.warn(`[wapi-send] 🚫 Contato bloqueado ("Não enviar mais nada") — envio automático ignorado (action=${action}, source=${body.source ?? body.messageSource ?? 'automation'})`);
        return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'contact_blocked' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Fail-closed: the post-reconnect queue/drip path is disabled. Nothing from
    // the queue is allowed to bypass quarantine as a "manual" send anymore.
    if (body.source === 'queue-drip') {
      console.warn(`[wapi-send] 🚫 Blocked queue-drip send permanently (phone=${phone}, action=${action})`);
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'queue_drip_disabled' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 🧯 Quarantine enqueue for queueable automations (campaign/follow-up/reactivation/visit-confirmation)
    // applies REGARDLESS of conversationId — campaigns may send to phones without an existing conversation.
    if (isQueueableAutomation) {
      const { data: qInstance } = await supabase
        .from('wapi_instances')
        .select('id, connected_at')
        .eq('instance_id', instance_id)
        .maybeSingle();
      const qUntil = getReconnectQuarantineUntil(qInstance);
      if (qUntil) {
        console.warn(`[wapi-send] 🚫 Auto-rejecting ${body.source} during reconnect quarantine until ${qUntil.toISOString()} (phone=${phone}, action=${action})`);

        let contactName: string | null = null;
        if (conversationId) {
          const { data: convInfo } = await supabase
            .from('wapi_conversations').select('contact_name').eq('id', conversationId).maybeSingle();
          contactName = convInfo?.contact_name || null;
        }

        const previewSource = typeof message === 'string' ? message
          : (typeof body.caption === 'string' ? body.caption
          : (typeof body.text === 'string' ? body.text : `[${action}]`));
        const preview = String(previewSource).slice(0, 200);

        const queuePayload = { ...body };
        delete queuePayload.instance_id;
        delete queuePayload.instance_token;
        delete queuePayload.client_token;

        // Auto-reject: register for observability but never send
        const { error: queueErr } = await supabase
          .from('whatsapp_outbound_queue')
          .insert({
            company_id: companyId,
            instance_id: qInstance?.id,
            to_phone: phone,
            payload: queuePayload,
            source: body.source,
            status: 'rejected',
            contact_name: contactName,
            preview,
            rejected_at: new Date().toISOString(),
            last_error: 'auto_rejected_reconnect_quarantine',
          });

        if (queueErr) console.error('[wapi-send] Failed to log auto-rejected during quarantine:', queueErr);

        return new Response(JSON.stringify({
          ok: true, skipped: true,
          reason: 'reconnect_quarantine_auto_reject', until: qUntil.toISOString(),
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    if (isAutomatedCall && conversationId) {
      const paused = await isConversationPaused(supabase, conversationId);
      if (paused) {
        console.warn(`[wapi-send] ⏸ Blocked automated send to paused conversation ${conversationId} (action=${action}, source=${body.source ?? 'automation'})`);
        return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'conversation_paused' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { data: sendInstance } = await supabase
        .from('wapi_instances')
        .select('id, connected_at')
        .eq('instance_id', instance_id)
        .maybeSingle();
      const quarantineUntil = getReconnectQuarantineUntil(sendInstance);
      if (quarantineUntil && isQueueableAutomation) {
        console.warn(`[wapi-send] 🚫 Auto-rejecting automated send during reconnect quarantine until ${quarantineUntil.toISOString()} (conversation=${conversationId}, action=${action}, source=${body.source ?? 'automation'})`);

        let contactName: string | null = null;
        if (conversationId) {
          const { data: convInfo } = await supabase
            .from('wapi_conversations')
            .select('contact_name')
            .eq('id', conversationId)
            .maybeSingle();
          contactName = convInfo?.contact_name || null;
        }

        const previewSource = typeof message === 'string' ? message
          : (typeof body.caption === 'string' ? body.caption
          : (typeof body.text === 'string' ? body.text : `[${action}]`));
        const preview = String(previewSource).slice(0, 200);

        const queuePayload = { ...body };
        delete queuePayload.instance_id;
        delete queuePayload.instance_token;
        delete queuePayload.client_token;

        // Auto-reject: log for observability, never send
        const { error: queueErr } = await supabase
          .from('whatsapp_outbound_queue')
          .insert({
            company_id: companyId,
            instance_id: sendInstance?.id,
            to_phone: phone,
            payload: queuePayload,
            source: typeof body.source === 'string' ? body.source : 'bot',
            status: 'rejected',
            contact_name: contactName,
            preview,
            rejected_at: new Date().toISOString(),
            last_error: 'auto_rejected_reconnect_quarantine',
          });

        if (queueErr) {
          console.error('[wapi-send] Failed to log auto-rejected during quarantine:', queueErr);
        }

        if (conversationId) {
          await supabase.from('wapi_conversations').update({
            bot_paused_until: quarantineUntil.toISOString(),
            bot_paused_reason: 'reconnect_quarantine',
            bot_paused_at: new Date().toISOString(),
          }).eq('id', conversationId);
        }

        return new Response(JSON.stringify({
          ok: true,
          skipped: true,
          reason: 'reconnect_quarantine_auto_reject',
          until: quarantineUntil.toISOString(),
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

    }

    switch (action) {
      case 'send-text': {
        console.log(`send-text: sending message to ${phone} via ${provider}`);
        const quotedDbMessageId = typeof body.quotedDbMessageId === 'string' && body.quotedDbMessageId
          ? body.quotedDbMessageId
          : null;
        let quotedProviderMessageId = typeof body.quotedProviderMessageId === 'string' && body.quotedProviderMessageId
          ? body.quotedProviderMessageId
          : null;

        if (quotedDbMessageId && !quotedProviderMessageId) {
          const { data: quotedMsg } = await supabase
            .from('wapi_messages')
            .select('message_id')
            .eq('id', quotedDbMessageId)
            .maybeSingle();
          quotedProviderMessageId = quotedMsg?.message_id || null;
        }

        // Lead do site e a IA Conversacional atende este cliente: vai a
        // boas-vindas da IA (sem o menu 1/2 do bot fixo) e a conversa fica com ela
        let aiSiteLead: { info: SiteLeadInfo; todayYmd: string; instanceId: string; introImageUrl: string | null } | null = null;
        const siteLead = body.lpMode && !conversationId && phone ? cleanSiteLead(body.siteLead) : null;
        if (siteLead) {
          try {
            const decision = await aiTakesSiteLead(supabase, instance_id, phone);
            console.log(`send-text: lead do site ${decision.take ? 'vai para a IA' : 'segue com o bot fixo'} (${decision.reason})`);
            if (decision.take) {
              const todayYmd = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
              message = buildAiSiteWelcome(siteLead, decision.companyName, todayYmd, decision.assistantName || '');
              aiSiteLead = { info: siteLead, todayYmd, instanceId: instance_id, introImageUrl: decision.introImageUrl || null };
            }
          } catch (e) {
            console.error('send-text: não deu para decidir se a IA atende o lead do site — segue o bot fixo', e);
          }
        }

        // 🔭 trace: provider_send_attempt
        const providerStart = Date.now();
        fireTrace(supabase, {
          tracking_id: trackingId,
          stage: 'provider_send_attempt',
          status: 'started',
          provider,
          instance_id,
          company_id: companyId,
          conversation_id: conversationId ?? null,
          phone: phone ?? null,
          payload_summary: {
            action: 'send-text',
            provider_kind: provider,
            remote_jid: String(phone || '').endsWith('@g.us') ? phone : null,
            has_quoted: Boolean(quotedProviderMessageId),
            message_length: typeof message === 'string' ? message.length : 0,
          },
        });

        // Boas-vindas da IA com a arte de apresentação dela: a mensagem vai
        // como legenda. Se a imagem falhar, vai só o texto (nunca fica sem).
        let welcomeImageUrl: string | null = null;
        let sendResult: { ok: boolean; data?: unknown; error?: string } | null = null;
        if (aiSiteLead?.introImageUrl && message.length <= 1000) {
          const imgResult = directProvider
            ? await directSendMedia(directProvider, instance_id, instance_token, client_token, phone, 'image', aiSiteLead.introImageUrl, { caption: message })
            : await sendMediaWithGroupFallback(`${WAPI_BASE_URL}/message/send-image?instanceId=${instance_id}`, instance_token, phone, { image: aiSiteLead.introImageUrl, caption: message }, 'send-image');
          if (imgResult.ok) {
            sendResult = imgResult;
            welcomeImageUrl = aiSiteLead.introImageUrl;
          } else {
            console.warn('send-text: arte de apresentação da IA não saiu — vai só o texto:', imgResult.error);
          }
        }
        if (!sendResult) {
          // Evolution: a citação precisa saber quem escreveu a mensagem citada
          const evoQuoted = isEvolution && quotedProviderMessageId
            ? await evolutionQuotedFor(supabase, instance_id, conversationId, quotedProviderMessageId)
            : null;
          sendResult = directProvider
            ? await directSendText(directProvider, instance_id, instance_token, client_token, phone, message, quotedProviderMessageId, Number(body.delayTyping) || undefined, evoQuoted)
            : await sendTextWithFallback(instance_id, instance_token, phone, message, quotedProviderMessageId);
        }

        console.log('send-text response:', JSON.stringify(sendResult));

        // 🚑 Failover da LP: se o número sorteado falhou (ex.: bloqueado pelo WhatsApp,
        // que muitas vezes ainda consta como "connected"), tenta as demais instâncias
        // conectadas da MESMA empresa para o lead não ficar sem a mensagem de boas-vindas.
        if (!sendResult.ok && body.lpMode && body.unit) {
          try {
            const { data: primaryRow } = await supabase
              .from('wapi_instances')
              .select('company_id, unit')
              .eq('instance_id', instance_id)
              .maybeSingle();

            if (primaryRow?.company_id) {
              const { data: altInstances } = await supabase
                .from('wapi_instances')
                .select('instance_id, instance_token, provider, client_token, unit')
                .eq('company_id', primaryRow.company_id)
                .eq('status', 'connected')
                .neq('instance_id', instance_id)
                .order('created_at', { ascending: true });

              for (const alt of (altInstances || [])) {
                const altProvider = ((alt.provider as Provider) || 'wapi');
                const altDirect: DirectProvider | null = altProvider === 'wapi' ? null : altProvider;
                const altResult = altDirect
                  ? await directSendText(altDirect, alt.instance_id, alt.instance_token, alt.client_token, phone, message, quotedProviderMessageId, Number(body.delayTyping) || undefined)
                  : await sendTextWithFallback(alt.instance_id, alt.instance_token, phone, message, quotedProviderMessageId);

                if (!altResult.ok) {
                  console.error(`LP failover: alternativa ${alt.unit} também falhou:`, altResult.error);
                  continue;
                }

                console.log(`LP failover: unidade ${primaryRow.unit || body.unit} falhou; enviado via ${alt.unit}`);
                fireTrace(supabase, {
                  tracking_id: trackingId,
                  stage: 'send_provider_failed',
                  status: 'error',
                  provider,
                  instance_id,
                  company_id: primaryRow.company_id,
                  phone: phone ?? null,
                  error_message: sendResult.error ?? 'unknown_provider_error',
                  payload_summary: { lp_failover: true, failover_to_unit: alt.unit || null },
                });

                // Passa a operar como a instância alternativa daqui em diante
                instance_id = alt.instance_id;
                instance_token = alt.instance_token;
                provider = altProvider;
                client_token = alt.client_token || null;
                isZapi = altProvider === 'zapi';
                isEvolution = altProvider === 'evolution';
                directProvider = altDirect;
                sendResult = altResult;

                // Atualiza o lead para a unidade que realmente entregou a mensagem
                try {
                  const digits = String(phone || '').replace(/\D/g, '');
                  const noCountry = digits.startsWith('55') ? digits.slice(2) : digits;
                  const variants = Array.from(new Set([digits, noCountry, `55${noCountry}`]));
                  const { data: leadRow } = await supabase
                    .from('campaign_leads')
                    .select('id, unit')
                    .eq('company_id', primaryRow.company_id)
                    .in('whatsapp', variants)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();
                  if (leadRow) {
                    await supabase.from('campaign_leads').update({ unit: alt.unit }).eq('id', leadRow.id);
                    await supabase.from('lead_history').insert({
                      lead_id: leadRow.id,
                      company_id: primaryRow.company_id,
                      action: 'Lead redirecionado automaticamente',
                      old_value: `Falha no envio pela unidade ${primaryRow.unit || body.unit || '?'}`,
                      new_value: `Mensagem entregue pela unidade ${alt.unit}`,
                      user_name: 'Sistema',
                    });
                  }
                } catch (leadErr) {
                  console.error('LP failover: erro ao atualizar unidade do lead', leadErr);
                }

                break;
              }
            }
          } catch (foErr) {
            console.error('LP failover: erro inesperado', foErr);
          }
        }

        if (!sendResult.ok) {
          console.error('send-text failed:', sendResult.error);
          if (queueEvo(sendResult.error) && isEvolution) {
            await persistEvolutionFailure(supabase, conversationId, companyId, 'text', message, { action: 'send-text', message }, failureSource, sendResult.error);
          }
          // 🔭 trace: send_provider_failed
          fireTrace(supabase, {
            tracking_id: trackingId,
            stage: 'send_provider_failed',
            status: 'error',
            provider,
            instance_id,
            company_id: companyId,
            conversation_id: conversationId ?? null,
            phone: phone ?? null,
            error_message: sendResult.error ?? 'unknown_provider_error',
            latency_ms: Date.now() - providerStart,
            payload_summary: {
              provider_kind: provider,
              attempt: (sendResult as { attempt?: string }).attempt ?? null,
            },
          });
          // 🔭 trace: send_returned_to_frontend (error path)
          fireTrace(supabase, {
            tracking_id: trackingId,
            stage: 'send_returned_to_frontend',
            status: 'error',
            provider,
            instance_id,
            company_id: companyId,
            conversation_id: conversationId ?? null,
            phone: phone ?? null,
            error_message: sendResult.error ?? 'unknown_provider_error',
            payload_summary: { http_status: 400, success: false },
          });
          return new Response(JSON.stringify({ error: sendResult.error, trackingId }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const messageId = (directProvider ? directMessageId(directProvider, sendResult.data) : extractWapiMessageId(sendResult.data)) || `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // 🔭 trace: send_provider_success
        fireTrace(supabase, {
          tracking_id: trackingId,
          stage: 'send_provider_success',
          status: 'ok',
          provider,
          instance_id,
          company_id: companyId,
          conversation_id: conversationId ?? null,
          phone: phone ?? null,
          message_id: messageId,
          latency_ms: Date.now() - providerStart,
          payload_summary: {
            provider_kind: provider,
            attempt: (sendResult as { attempt?: string }).attempt ?? null,
            provider_status: (sendResult.data as { status?: unknown })?.status ?? null,
            had_real_message_id: !messageId.startsWith('manual_'),
          },
        });

        // Resolve or create conversation for DB tracking
        let resolvedConvId = conversationId;
        let resolvedCompanyId = companyId;

        if (!resolvedConvId && phone) {
          // Auto-find or create conversation (LP/bot outbound flow)
          const convResult = await findOrCreateConversation(supabase, phone, instance_id, body.lpMode, body.contactName);
          if (convResult) {
            resolvedConvId = convResult.conversationId;
            resolvedCompanyId = convResult.companyId;
          }
        }

        // Failover para outro número (outra unidade): a IA não atende lá — fica com o bot fixo
        const aiOwnsSiteLead = Boolean(aiSiteLead && resolvedConvId && aiSiteLead.instanceId === instance_id);
        if (aiOwnsSiteLead && aiSiteLead) {
          const { data: convRow } = await supabase.from('wapi_conversations').select('bot_data').eq('id', resolvedConvId).maybeSingle();
          await supabase.from('wapi_conversations').update({
            bot_step: 'ai_agent',
            bot_enabled: true,
            bot_data: { ...((convRow?.bot_data as Record<string, unknown>) || {}), ...siteLeadBotData(aiSiteLead.info, aiSiteLead.todayYmd) },
          }).eq('id', resolvedConvId);
          console.log(`send-text: conversa ${resolvedConvId} do site entregue à IA`);
        }

        if (resolvedConvId) {
          const quotedMessageId = quotedDbMessageId;

          const messageRecord = {
            conversation_id: resolvedConvId,
            message_id: messageId,
            from_me: true,
            message_type: welcomeImageUrl ? 'image' : 'text',
            content: message,
            ...(welcomeImageUrl ? { media_url: welcomeImageUrl } : {}),
            status: 'sent',
            timestamp: new Date().toISOString(),
            company_id: resolvedCompanyId,
            quoted_message_id: quotedMessageId,
            // Boas-vindas da IA conta como mensagem dela (não como resposta da equipe)
            metadata: { source: aiOwnsSiteLead ? 'ai_agent' : 'platform' },
          };

          await supabase
            .from('wapi_messages')
            .upsert(messageRecord, { onConflict: 'conversation_id,message_id' });

          if (quotedMessageId) {
            await supabase
              .from('wapi_messages')
              .update({ quoted_message_id: quotedMessageId })
              .eq('conversation_id', resolvedConvId)
              .eq('message_id', messageId);
          }

          await supabase.from('wapi_conversations').update({
            last_message_at: new Date().toISOString(),
            last_message_content: message.substring(0, 100),
            last_message_from_me: true,
          }).eq('id', resolvedConvId);
        }

        // 🔭 trace: send_returned_to_frontend (success path)
        fireTrace(supabase, {
          tracking_id: trackingId,
          stage: 'send_returned_to_frontend',
          status: 'ok',
          provider,
          instance_id,
          company_id: resolvedCompanyId,
          conversation_id: resolvedConvId ?? null,
          phone: phone ?? null,
          message_id: messageId,
          payload_summary: { http_status: 200, success: true },
        });

        // Site (lpMode): devolve o WhatsApp que mandou a boas-vindas (pode ser outro
        // número, se houve failover) — o botão do site abre este mesmo número
        let fromPhone: string | null = null;
        if (body.lpMode) {
          const { data: fromInst } = await supabase.from('wapi_instances').select('phone_number').eq('instance_id', instance_id).maybeSingle();
          fromPhone = fromInst?.phone_number ? String(fromInst.phone_number).replace(/\D/g, '') : null;
        }
        return new Response(JSON.stringify({ success: true, messageId, conversationId: resolvedConvId, trackingId, providerAttempt: (sendResult as { attempt?: string }).attempt, fromPhone }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'send-image': {
        const { base64, caption, mediaUrl } = body;

        // Z-API / Evolution: envio direto (Evolution só por link)
        if (directProvider) {
          const imageSource = isEvolution
            ? (mediaUrl || (base64 ? await base64ToSignedUrl(supabase, companyId, base64, 'image/jpeg', 'image') : null))
            : (mediaUrl || base64);
          if (!imageSource) {
            return new Response(JSON.stringify({ error: 'Imagem é obrigatória' }), {
              status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          const zapiRes = await directSendMedia(directProvider, instance_id, instance_token, client_token, phone, 'image', imageSource, { caption });
          if (!zapiRes.ok) {
            if (queueEvo(zapiRes.error) && /^https?:\/\//.test(imageSource)) {
              await persistEvolutionFailure(supabase, conversationId, companyId, 'image', caption || '[Imagem]', { action: 'send-image', mediaUrl: imageSource, caption: caption || '' }, failureSource, zapiRes.error);
            }
            return new Response(JSON.stringify({ error: zapiRes.error }), {
              status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          const messageId = directMessageId(directProvider, zapiRes.data);
          logZapiMediaResponse('send-image', phone, zapiRes.data);

          // Resolve or create conversation for DB tracking (campaigns/outbound)
          let resolvedConvId = conversationId;
          let resolvedCompanyId = companyId;
          if (!resolvedConvId && phone) {
            const convResult = await findOrCreateConversation(supabase, phone, instance_id, body.lpMode, body.contactName);
            if (convResult) {
              resolvedConvId = convResult.conversationId;
              resolvedCompanyId = convResult.companyId;
            }
          }

          if (resolvedConvId) {
            await supabase.from('wapi_messages').insert({
              conversation_id: resolvedConvId, message_id: messageId, from_me: true,
              message_type: 'image', content: caption || '[Imagem]', media_url: mediaUrl || (isEvolution ? imageSource : null),
              status: directMediaStatus(directProvider, messageId), timestamp: new Date().toISOString(), company_id: resolvedCompanyId,
              metadata: directMediaMetadata(directProvider, body.messageSource === 'ai_agent' ? 'ai_agent' : 'platform', mediaAckMetadata('send-image', { mediaUrl, caption }, { automation: body.automation === true, retryOf: body.retryOf })),
            });
            await supabase.from('wapi_conversations').update({ 
              last_message_at: new Date().toISOString(),
              last_message_content: caption ? `📷 ${caption.substring(0, 90)}` : '📷 Imagem',
              last_message_from_me: true,
            }).eq('id', resolvedConvId);
          }
          return new Response(JSON.stringify({ success: true, messageId, conversationId: resolvedConvId }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        let imagePayload: Record<string, unknown> = { caption: caption || '' };
        
        // Prefer sending by URL directly (avoids base64 memory/size limits)
        if (mediaUrl && !base64) {
          console.log('send-image: sending by URL:', mediaUrl.substring(0, 80));
          imagePayload.image = mediaUrl;
        } else if (base64) {
          // Use provided base64
          let imageBase64 = base64;
          if (!imageBase64.startsWith('data:')) {
            imageBase64 = `data:image/jpeg;base64,${imageBase64}`;
          }
          imagePayload.image = imageBase64;
        } else {
          return new Response(JSON.stringify({ error: 'Imagem é obrigatória' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const res = await sendMediaWithGroupFallback(
          `${WAPI_BASE_URL}/message/send-image?instanceId=${instance_id}`,
          instance_token,
          phone,
          imagePayload,
          'send-image'
        );
        
        console.log('send-image response:', JSON.stringify(res));
        
        if (!res.ok) {
          console.error('send-image failed:', res.error, 'mediaUrl:', mediaUrl?.substring(0, 80));
          return new Response(JSON.stringify({ error: res.error }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const messageId = (res.data as { messageId?: string })?.messageId;

        // Resolve or create conversation for DB tracking (campaigns/outbound)
        let resolvedConvIdImg = conversationId;
        let resolvedCompanyIdImg = companyId;
        if (!resolvedConvIdImg && phone) {
          const convResult = await findOrCreateConversation(supabase, phone, instance_id, body.lpMode, body.contactName);
          if (convResult) {
            resolvedConvIdImg = convResult.conversationId;
            resolvedCompanyIdImg = convResult.companyId;
          }
        }

        if (resolvedConvIdImg) {
          await supabase.from('wapi_messages').insert({
            conversation_id: resolvedConvIdImg,
            message_id: messageId,
            from_me: true,
            message_type: 'image',
            content: caption || '[Imagem]',
            media_url: mediaUrl || null,
            status: 'sent',
            timestamp: new Date().toISOString(),
            company_id: resolvedCompanyIdImg,
            metadata: { source: 'platform' },
          });
          await supabase.from('wapi_conversations').update({ 
            last_message_at: new Date().toISOString(),
            last_message_content: caption ? `📷 ${caption.substring(0, 90)}` : '📷 Imagem',
            last_message_from_me: true,
          }).eq('id', resolvedConvIdImg);
        }

        return new Response(JSON.stringify({ success: true, messageId, conversationId: resolvedConvIdImg }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'send-audio': {
        const { base64: audioBase64, mediaUrl: audioMediaUrl, mimeType: clientMimeType } = body;

        // Z-API / Evolution path (Evolution só por link)
        if (directProvider && (audioMediaUrl || audioBase64)) {
          const audioSource = isEvolution
            ? (audioMediaUrl || await base64ToSignedUrl(supabase, companyId, audioBase64, typeof clientMimeType === 'string' && clientMimeType ? clientMimeType : 'audio/ogg', 'audio'))
            : (audioMediaUrl || audioBase64);
          if (!audioSource) {
            return new Response(JSON.stringify({ success: false, error: 'Falha ao preparar o áudio para envio' }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          const zapiRes = await directSendMedia(directProvider, instance_id, instance_token, client_token, phone, 'audio', audioSource);
          if (!zapiRes.ok) {
            if (queueEvo(zapiRes.error) && /^https?:\/\//.test(audioSource)) {
              await persistEvolutionFailure(supabase, conversationId, companyId, 'audio', '🎤 Áudio', { action: 'send-audio', mediaUrl: audioSource }, failureSource, zapiRes.error);
            }
            return new Response(JSON.stringify({ error: zapiRes.error }), {
              status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          const messageId = directMessageId(directProvider, zapiRes.data);
          logZapiMediaResponse('send-audio', phone, zapiRes.data);
          if (conversationId) {
            await supabase.from('wapi_messages').insert({
              conversation_id: conversationId, message_id: messageId, from_me: true,
              message_type: 'audio', content: '🎤 Áudio', media_url: audioMediaUrl || (isEvolution ? audioSource : null),
              status: directMediaStatus(directProvider, messageId), timestamp: new Date().toISOString(), company_id: companyId,
              metadata: directMediaMetadata(directProvider, body.messageSource === 'ai_agent' ? 'ai_agent' : 'platform', mediaAckMetadata('send-audio', { mediaUrl: audioMediaUrl }, { automation: body.automation === true, retryOf: body.retryOf })),
            });
            await supabase.from('wapi_conversations').update({ 
              last_message_at: new Date().toISOString(),
              last_message_content: '🎤 Áudio',
              last_message_from_me: true,
            }).eq('id', conversationId);
          }
          return new Response(JSON.stringify({ success: true, messageId }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const originalMimeType = (typeof clientMimeType === 'string' && clientMimeType.trim().length > 0
          ? clientMimeType.split(';')[0].trim().toLowerCase()
          : 'audio/webm');
        const storageExtension = getExtensionFromMimeType(originalMimeType);
        const resolvedAudioMimeType = originalMimeType || 'audio/webm';
        
        let audioPayload: Record<string, unknown> = {};

        if (audioBase64) {
          let finalAudio = audioBase64;
          if (finalAudio.startsWith('data:')) {
            audioPayload.audio = finalAudio;
          } else {
            audioPayload.audio = `data:${resolvedAudioMimeType};base64,${finalAudio}`;
          }
          console.log('send-audio: using provided audio payload mimeType:', resolvedAudioMimeType);
        } else if (audioMediaUrl) {
          // W-API accepts a public URL directly. Send the URL as-is to avoid
          // re-encoding issues (especially when the source is audio/wav, which
          // W-API rejects when wrapped as data: URI).
          console.log('send-audio: sending direct URL:', audioMediaUrl.substring(0, 80));
          audioPayload.audio = audioMediaUrl;
        } else {
          return new Response(JSON.stringify({ error: 'Áudio é obrigatório' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        let res = await sendMediaWithGroupFallback(
          `${WAPI_BASE_URL}/message/send-audio?instanceId=${instance_id}`,
          instance_token,
          phone,
          audioPayload,
          'send-audio'
        );

        // Fallback: if W-API rejected the URL/payload, fetch the audio and retry
        // with raw base64 (no data: prefix) — some W-API versions require this.
        if (!res.ok && audioMediaUrl && !audioBase64) {
          try {
            console.log('send-audio: URL rejected, retrying as raw base64');
            const audioRes = await fetch(audioMediaUrl);
            if (audioRes.ok) {
              const buf = await audioRes.arrayBuffer();
              const bytes = new Uint8Array(buf);
              let bin = '';
              for (let i = 0; i < bytes.length; i += 8192) {
                const end = Math.min(i + 8192, bytes.length);
                for (let j = i; j < end; j++) bin += String.fromCharCode(bytes[j]);
              }
              const rawB64 = btoa(bin);
              res = await sendMediaWithGroupFallback(
                `${WAPI_BASE_URL}/message/send-audio?instanceId=${instance_id}`,
                instance_token,
                phone,
                { audio: rawB64 },
                'send-audio'
              );
            }
          } catch (retryErr) {
            console.error('send-audio retry failed:', retryErr);
          }
        }

        if (!res.ok) {
          console.error('send-audio failed:', res.error, 'hadBase64:', !!audioBase64, 'mediaUrl:', audioMediaUrl?.substring(0, 80));
          return new Response(JSON.stringify({ success: false, error: res.error || 'Falha ao enviar áudio' }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const messageId = (res.data as { messageId?: string })?.messageId;
        
        // If audio was sent as base64, upload to Storage to get a persistent URL
        let persistedAudioUrl = audioMediaUrl || null;
        if (audioBase64 && !persistedAudioUrl) {
          try {
            const rawBase64 = audioBase64.includes(',') ? audioBase64.split(',')[1] : audioBase64;
            const binaryStr = atob(rawBase64);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
              bytes[i] = binaryStr.charCodeAt(i);
            }
            const audioFileName = `audio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${storageExtension}`;
            const storagePath = `${companyId || 'unknown'}/${audioFileName}`;
            const { error: uploadErr } = await supabase.storage
              .from('whatsapp-media')
              .upload(storagePath, bytes.buffer, {
                contentType: originalMimeType,
                upsert: false,
              });
            if (!uploadErr) {
              // Bucket is private, use signed URL (1 year expiry)
              const { data: signedData, error: signErr } = await supabase.storage
                .from('whatsapp-media')
                .createSignedUrl(storagePath, 60 * 60 * 24 * 365);
              if (!signErr && signedData?.signedUrl) {
                persistedAudioUrl = signedData.signedUrl;
              }
            } else {
              console.error('send-audio: storage upload failed:', uploadErr.message);
            }
          } catch (uploadEx) {
            console.error('send-audio: storage upload exception:', uploadEx);
          }
        }

        if (conversationId) {
          await supabase.from('wapi_messages').insert({
            conversation_id: conversationId,
            message_id: messageId,
            from_me: true,
            message_type: 'audio',
            content: '[Áudio]',
            media_url: persistedAudioUrl,
            status: 'sent',
            timestamp: new Date().toISOString(),
            company_id: companyId,
            metadata: { source: 'platform' },
          });
          await supabase.from('wapi_conversations').update({ 
            last_message_at: new Date().toISOString(),
            last_message_content: '🎤 Áudio',
            last_message_from_me: true,
          }).eq('id', conversationId);
        }

        return new Response(JSON.stringify({ success: true, messageId }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'send-document': {
        const { fileName, mediaUrl: docUrl } = body;
        if (directProvider && docUrl) {
          const zapiRes = await directSendMedia(directProvider, instance_id, instance_token, client_token, phone, 'document', docUrl, { fileName: fileName || 'document' });
          if (!zapiRes.ok && queueEvo(zapiRes.error)) {
            await persistEvolutionFailure(supabase, conversationId, companyId, 'document', `📄 ${fileName || 'Documento'}`, { action: 'send-document', mediaUrl: docUrl, fileName: fileName || 'document' }, failureSource, zapiRes.error);
          }
          if (!zapiRes.ok) return new Response(JSON.stringify({ error: zapiRes.error }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          const messageId = directMessageId(directProvider, zapiRes.data);
          logZapiMediaResponse('send-document', phone, zapiRes.data);
          if (conversationId) {
            await supabase.from('wapi_messages').insert({ conversation_id: conversationId, message_id: messageId, from_me: true, message_type: 'document', content: `📄 ${fileName || 'Documento'}`, media_url: docUrl, status: directMediaStatus(directProvider, messageId), timestamp: new Date().toISOString(), company_id: companyId, metadata: directMediaMetadata(directProvider, body.messageSource === 'ai_agent' ? 'ai_agent' : 'platform', mediaAckMetadata('send-document', { mediaUrl: docUrl, fileName }, { automation: body.automation === true, retryOf: body.retryOf })) });
            await supabase.from('wapi_conversations').update({ last_message_at: new Date().toISOString(), last_message_content: `📄 ${fileName || 'Documento'}`, last_message_from_me: true }).eq('id', conversationId);
          }
          return new Response(JSON.stringify({ success: true, messageId }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        
        if (!docUrl) {
          return new Response(JSON.stringify({ error: 'URL do documento é obrigatória' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const ext = fileName?.split('.').pop()?.toLowerCase() || 
                    docUrl.split('.').pop()?.split('?')[0]?.toLowerCase() || 'pdf';

        const res = await sendMediaWithGroupFallback(
          `${WAPI_BASE_URL}/message/send-document?instanceId=${instance_id}`,
          instance_token,
          phone,
          { document: docUrl, fileName: fileName || 'document', extension: ext },
          'send-document'
        );
        
        if (!res.ok) {
          return new Response(JSON.stringify({ error: res.error }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const messageId = (res.data as { messageId?: string })?.messageId;
        
        if (conversationId) {
          await supabase.from('wapi_messages').insert({
            conversation_id: conversationId,
            message_id: messageId,
            from_me: true,
            message_type: 'document',
            content: fileName || '[Documento]',
            media_url: docUrl,
            status: 'sent',
            timestamp: new Date().toISOString(),
            company_id: companyId,
            metadata: { source: 'platform' },
          });
          await supabase.from('wapi_conversations').update({ 
            last_message_at: new Date().toISOString(),
            last_message_content: `📄 ${fileName || 'Documento'}`,
            last_message_from_me: true,
          }).eq('id', conversationId);
        }

        return new Response(JSON.stringify({ success: true, messageId }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'send-video': {
        const { mediaUrl: videoUrl, caption } = body;
        if (directProvider && videoUrl) {
          const zapiRes = await directSendMedia(directProvider, instance_id, instance_token, client_token, phone, 'video', videoUrl, { caption });
          if (!zapiRes.ok && queueEvo(zapiRes.error)) {
            await persistEvolutionFailure(supabase, conversationId, companyId, 'video', caption || '🎥 Vídeo', { action: 'send-video', mediaUrl: videoUrl, caption: caption || '' }, failureSource, zapiRes.error);
          }
          if (!zapiRes.ok) return new Response(JSON.stringify({ error: zapiRes.error }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          const messageId = directMessageId(directProvider, zapiRes.data);
          logZapiMediaResponse('send-video', phone, zapiRes.data);
          if (conversationId) {
            await supabase.from('wapi_messages').insert({ conversation_id: conversationId, message_id: messageId, from_me: true, message_type: 'video', content: caption || '🎥 Vídeo', media_url: videoUrl, status: directMediaStatus(directProvider, messageId), timestamp: new Date().toISOString(), company_id: companyId, metadata: directMediaMetadata(directProvider, body.messageSource === 'ai_agent' ? 'ai_agent' : 'platform', mediaAckMetadata('send-video', { mediaUrl: videoUrl, caption }, { automation: body.automation === true, retryOf: body.retryOf })) });
            await supabase.from('wapi_conversations').update({ last_message_at: new Date().toISOString(), last_message_content: caption ? `🎥 ${caption.substring(0, 90)}` : '🎥 Vídeo', last_message_from_me: true }).eq('id', conversationId);
          }
          return new Response(JSON.stringify({ success: true, messageId }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        
        if (!videoUrl) {
          return new Response(JSON.stringify({ error: 'URL do vídeo é obrigatória' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const res = await sendMediaWithGroupFallback(
          `${WAPI_BASE_URL}/message/send-video?instanceId=${instance_id}`,
          instance_token,
          phone,
          { video: videoUrl, caption: caption || '' },
          'send-video'
        );
        
        if (!res.ok) {
          return new Response(JSON.stringify({ error: res.error }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const messageId = (res.data as { messageId?: string })?.messageId;
        
        if (conversationId) {
          await supabase.from('wapi_messages').insert({
            conversation_id: conversationId,
            message_id: messageId,
            from_me: true,
            message_type: 'video',
            content: caption || '[Vídeo]',
            media_url: videoUrl,
            status: 'sent',
            timestamp: new Date().toISOString(),
            company_id: companyId,
            metadata: { source: 'platform' },
          });
          await supabase.from('wapi_conversations').update({ 
            last_message_at: new Date().toISOString(),
            last_message_content: caption ? `🎬 ${caption.substring(0, 90)}` : '🎬 Vídeo',
            last_message_from_me: true,
          }).eq('id', conversationId);
        }

        return new Response(JSON.stringify({ success: true, messageId }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'send-contact': {
        const { contactName, contactPhone } = body;
        
        if (!contactName || !contactPhone) {
          return new Response(JSON.stringify({ error: 'Nome e telefone do contato são obrigatórios' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const cleanContactPhone = contactPhone.replace(/\D/g, '');
        const cleanDestPhone = String(phone || '').replace(/\D/g, '');
        
        // Try multiple payload formats for W-API send-contact
        const contactAttempts = [
          // Format 1: contactName + contactPhone (simple)
          { name: 'simple', body: { phone: cleanDestPhone, contactName, contactPhone: cleanContactPhone } },
          // Format 2: Full contact object with vcard
          { name: 'vcard', body: { 
            phone: cleanDestPhone,
            contact: {
              fullName: contactName,
              organization: '',
              phoneNumber: `+${cleanContactPhone}`,
              wuid: cleanContactPhone,
              displayName: contactName,
            },
            name: { formatted_name: contactName, first_name: contactName },
            vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${contactName}\nTEL;type=CELL;waid=${cleanContactPhone}:+${cleanContactPhone}\nEND:VCARD`,
          }},
          // Format 3: contactsMessage array format
          { name: 'contactsMessage', body: {
            phone: cleanDestPhone,
            contactsMessage: [{
              displayName: contactName,
              vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${contactName}\nTEL;type=CELL;waid=${cleanContactPhone}:+${cleanContactPhone}\nEND:VCARD`,
            }],
          }},
        ];

        let sendContactRes: { ok: boolean; data?: unknown; error?: string } = { ok: false, error: 'Falha ao enviar contato' };
        const contactEndpoint = `${WAPI_BASE_URL}/message/send-contact?instanceId=${instance_id}`;

        for (const attempt of contactAttempts) {
          const r = await wapiRequest(contactEndpoint, instance_token, 'POST', attempt.body);
          if (r.ok) {
            console.log(`[send-contact] Success [${attempt.name}]`);
            sendContactRes = { ok: true, data: r.data };
            break;
          }
          console.warn(`[send-contact] Failed [${attempt.name}]: ${r.error}`);
          sendContactRes = { ok: false, error: r.error || 'Falha ao enviar contato' };
        }

        const res = sendContactRes;
        
        if (!res.ok) {
          return new Response(JSON.stringify({ success: false, error: res.error }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const messageId = (res.data as { messageId?: string })?.messageId;
        
        if (conversationId) {
          const contactContent = `[Contato] ${contactName} - ${contactPhone}`;
          await supabase.from('wapi_messages').insert({
            conversation_id: conversationId,
            message_id: messageId,
            from_me: true,
            message_type: 'contact',
            content: contactContent,
            status: 'sent',
            timestamp: new Date().toISOString(),
            company_id: companyId,
            metadata: { source: 'platform' },
          });
          await supabase.from('wapi_conversations').update({ 
            last_message_at: new Date().toISOString(),
            last_message_content: `👤 ${contactName}`,
            last_message_from_me: true,
          }).eq('id', conversationId);
        }

        return new Response(JSON.stringify({ success: true, messageId }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'get-status': {
        // Evolution Go: GET /instance/status → { data: { Connected, LoggedIn, Name } }
        // Devolve também o estado exato (online / reconectando / precisa de QR /
        // sem resposta) e o que o monitor sabe (desde quando, última checagem)
        if (isEvolution) {
          const { data: instRecord } = await supabase.from('wapi_instances').select('id, phone_number').eq('instance_id', instance_id).maybeSingle();
          let monitor: Record<string, unknown> | null = null;
          if (instRecord?.id) {
            const { data: h } = await supabase.from('provider_health').select('state, state_since, last_check_at, reconnect_attempts, alerted_state').eq('key', `instance:${instRecord.id}`).maybeSingle();
            monitor = h || null;
          }
          // Sem chamar a Evolution logo depois de um evento de conexão (ela está
          // reconectando sozinha; uma consulta abre uma 2ª conexão — VENDAS 1,
          // 13/10 18:47) nem enquanto o monitor checa o número: responde com o
          // que o evento/monitor já sabem
          // Número pausado (bloqueado pelo WhatsApp, 15/10): não consultar a Evolution
          if (instRecord?.id && PAUSED_INSTANCE_ROW_IDS.has(instRecord.id)) {
            console.log('[wapi-send] get-status Evolution: número pausado — sem consultar');
            return new Response(JSON.stringify({ status: 'disconnected', connected: false, phoneNumber: instRecord?.phone_number || null, provider, evolutionState: 'paused', monitor, cached: true, paused: true }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          const recentEvt = await recentConnectionEvent(supabase, instance_id);
          // Número fora e já avisado: só o monitor consulta, a cada 30 min (cada
          // consulta pode reiniciar o cliente e gastar conexões do banco da Evolution)
          const downAndWarned = !recentEvt && skipLoggedOutCheck(monitor as { state?: string; alerted_state?: string; last_check_at?: string } | null, Date.now());
          const gotLock = !recentEvt && !downAndWarned && instRecord?.id ? await claimEvolutionLock(supabase, instRecord.id, 20000) : (!recentEvt && !downAndWarned);
          if (!gotLock) {
            // "Disconnected" recente: a Evolution volta sozinha em segundos — vale o último estado do monitor
            const known = recentEvt && recentEvt.hint !== 'reconnecting' ? recentEvt.hint : String(monitor?.state || 'online');
            const knownConnected = known === 'online';
            console.log(`[wapi-send] get-status Evolution sem consultar (${recentEvt ? `evento ${recentEvt.event} recente` : downAndWarned ? 'fora e já avisado — monitor consulta a cada 30 min' : 'monitor checando'}): ${known}`);
            return new Response(JSON.stringify({ status: knownConnected ? 'connected' : (known === 'reconnecting' ? 'degraded' : 'disconnected'), connected: knownConnected, phoneNumber: instRecord?.phone_number || null, provider, evolutionState: known, monitor, cached: true }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          const evoRes = await evolutionStatus(instance_token);
          if (instRecord?.id) await releaseEvolutionLock(supabase, instRecord.id);
          const evolutionState = classifyEvolutionStatus(evoRes);
          if (evolutionState === 'unreachable') {
            return new Response(JSON.stringify({ status: 'degraded', connected: false, error: evoRes.error || 'Evolution Go sem resposta', errorType: 'TIMEOUT_OR_GATEWAY', provider, evolutionState, monitor }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          const d = (((evoRes.data as Record<string, unknown>)?.data ?? evoRes.data) || {}) as Record<string, unknown>;
          const connected = evolutionState === 'online';
          const phoneNumber = extractConnectedPhone(d) || instRecord?.phone_number || null;
          return new Response(JSON.stringify({ status: connected ? 'connected' : 'disconnected', connected, phoneNumber, provider, evolutionState, monitor }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        // Z-API status check
        if (isZapi) {
          try {
            const { data: instRecord } = await supabase
              .from('wapi_instances')
              .select('id, phone_number')
              .eq('instance_id', instance_id)
              .single();

            const zapiRes = await zapiGetStatus(instance_id, instance_token, client_token);
            const zapiData = (zapiRes.data as Record<string, unknown> | undefined) || {};
            const fallbackPhone = instRecord?.phone_number || null;
            const connected = isZapiSessionConnected(zapiData) || hasZapiConnectedMessage(zapiRes.error);
            const zapiPhone = extractConnectedPhone(zapiData) || fallbackPhone;
            const hasVerifiedActivity = instRecord?.id
              ? await hasRecentVerifiedActivity(supabase, instRecord.id, 24 * 60)
              : false;

            if (connected || (fallbackPhone && hasVerifiedActivity)) {
              return new Response(JSON.stringify({
                status: 'connected',
                connected: true,
                phoneNumber: zapiPhone,
                provider: 'zapi',
                evidenceBased: !connected,
              }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
            }

            if (!zapiRes.ok) {
              return new Response(JSON.stringify({ status: 'degraded', connected: false, error: zapiRes.error, errorType: 'TIMEOUT_OR_GATEWAY' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
            }

            return new Response(JSON.stringify({ status: connected ? 'connected' : 'disconnected', connected, phoneNumber: zapiPhone, provider: 'zapi' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          } catch (e) {
            return new Response(JSON.stringify({ status: 'degraded', connected: false, error: e instanceof Error ? e.message : 'Erro Z-API', errorType: 'TIMEOUT_OR_GATEWAY' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
        }
        try {
          console.log('get-status: checking via qr-code endpoint for', instance_id);
          
          // The only reliable endpoint in W-API LITE is /instance/qr-code
          // All other endpoints (/instance/status, /info, /connection-state, /profile) return 404
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          
          let qrRes: Response | null = null;
          try {
            qrRes = await fetch(
              `${WAPI_BASE_URL}/instance/qr-code?instanceId=${instance_id}`,
              { headers: { 'Authorization': `Bearer ${instance_token}` }, signal: controller.signal }
            );
            clearTimeout(timeout);
          } catch (fetchErr) {
            clearTimeout(timeout);
            console.warn('get-status: qr-code fetch failed:', fetchErr instanceof Error ? fetchErr.message : String(fetchErr));
            return new Response(JSON.stringify({ 
              status: 'degraded',
              connected: false,
              error: 'Instabilidade temporária na W-API.',
              errorType: 'TIMEOUT_OR_GATEWAY',
            }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          console.log('get-status qr response:', qrRes.status);
          
          if (qrRes.status === 404) {
            console.error(`get-status: qr-code returned 404 for ${instance_id}. Instance may be expired.`);
            return new Response(JSON.stringify({ 
              status: 'instance_not_found',
              connected: false,
              error: 'Instância não encontrada na W-API. Verifique no painel da W-API (w-api.app) se a instância ainda existe.',
              errorType: 'NOT_FOUND',
            }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          if (qrRes.status === 401 || qrRes.status === 403) {
            return new Response(JSON.stringify({ 
              status: 'unauthorized',
              connected: false,
              error: 'Token da W-API inválido ou expirado.',
              errorType: 'UNAUTHORIZED',
            }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          if (!qrRes.ok) {
            return new Response(JSON.stringify({ 
              status: 'degraded',
              connected: false,
              error: `W-API retornou status ${qrRes.status}`,
              errorType: 'TIMEOUT_OR_GATEWAY',
            }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          const ct = qrRes.headers.get('content-type');

          // W-API LITE can intermittently return HTML/image QR responses for sessions that are
          // still working. When we already have a known connected session in DB, treat this as
          // degraded/ambiguous instead of forcing a disconnect.
          if (ct?.includes('text/html') || ct?.includes('image')) {
            try {
              const { data: instRecord } = await supabase
                .from('wapi_instances')
                .select('id, status, phone_number')
                .eq('instance_id', instance_id)
                .maybeSingle();

              const hasKnownConnectedSession = Boolean(
                instRecord?.status === 'connected' && instRecord?.phone_number
              );
              const hasVerifiedActivity = instRecord?.id
                ? await hasRecentVerifiedActivity(supabase, instRecord.id, 24 * 60)
                : false;

              if (hasKnownConnectedSession || hasVerifiedActivity) {
                console.log(`get-status: ambiguous QR response for ${instance_id} — returning degraded instead of disconnected`);
                return new Response(JSON.stringify({
                  status: 'degraded',
                  connected: false,
                  phoneNumber: instRecord?.phone_number || null,
                  error: 'W-API retornou um estado ambíguo de QR para uma sessão já conectada.',
                  errorType: 'AMBIGUOUS_QR_STATE',
                  evidenceBased: hasVerifiedActivity,
                }), {
                  status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
              }
            } catch (ambiguityErr) {
              console.warn('get-status: ambiguous QR fallback failed:', ambiguityErr);
            }

            return new Response(JSON.stringify({ status: 'disconnected', connected: false }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          const data = await qrRes.json();
          console.log('get-status qr data:', JSON.stringify(data));
          
          if (data.connected === true) {
            const qrPhone = extractConnectedPhone(data);
            return new Response(JSON.stringify({ 
              status: 'connected',
              phoneNumber: qrPhone,
              connected: true,
            }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          const hasQrCode = data.qrcode || data.qrCode || data.qr || data.base64;
          
          if (hasQrCode) {
            // W-API LITE can intermittently return QR code in JSON for sessions that are
            // still working. Check DB status and recent activity before declaring disconnected.
            try {
              const { data: instRecord } = await supabase
                .from('wapi_instances')
                .select('id, status, phone_number')
                .eq('instance_id', instance_id)
                .maybeSingle();

              const hasKnownConnectedSession = Boolean(
                instRecord?.status === 'connected' && instRecord?.phone_number
              );
              const hasVerifiedActivity = instRecord?.id
                ? await hasRecentVerifiedActivity(supabase, instRecord.id, 24 * 60)
                : false;

              if (hasKnownConnectedSession || hasVerifiedActivity) {
                console.log(`get-status: JSON QR detected for ${instance_id} but has known session/activity — returning degraded`);
                return new Response(JSON.stringify({
                  status: 'degraded',
                  connected: false,
                  phoneNumber: instRecord?.phone_number || null,
                  error: 'W-API retornou QR code mas a instância possui atividade recente. Pode ser um falso positivo.',
                  errorType: 'AMBIGUOUS_QR_STATE',
                  evidenceBased: hasVerifiedActivity,
                }), {
                  status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
              }
            } catch (ambiguityErr) {
              console.warn('get-status: JSON QR ambiguity check failed:', ambiguityErr);
            }

            console.log(`get-status: QR detected for instance ${instance_id} — reporting disconnected`);
            return new Response(JSON.stringify({ 
              status: 'disconnected',
              phoneNumber: null,
              connected: false,
            }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          // No QR code and not explicitly connected - check if there's an error
          if (!data.error) {
            // W-API returned a response without error and without QR = likely connected
            return new Response(JSON.stringify({ 
              status: 'connected',
              phoneNumber: data.phone || data.phoneNumber || null,
              connected: true,
            }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          // Default to disconnected
          return new Response(JSON.stringify({ 
            status: 'disconnected',
            phoneNumber: null,
            connected: false,
          }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (e) {
          console.error('get-status error:', e);
          return new Response(JSON.stringify({ 
            status: 'degraded', 
            connected: false, 
            error: e instanceof Error ? e.message : 'Erro de comunicação',
            errorType: 'TIMEOUT_OR_GATEWAY',
          }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      case 'get-qr': {
        // Evolution Go: se ainda não há QR, /instance/connect (que também
        // registra o webhook) e busca de novo. Não chama o connect a cada
        // atualização da tela para não trocar o QR que está sendo lido.
        if (isEvolution) {
          const statusRes = await evolutionRequest(instance_token, '/instance/status');
          const sd = (((statusRes.data as Record<string, unknown>)?.data ?? statusRes.data) || {}) as Record<string, unknown>;
          if (statusRes.ok && sd.Connected === true && sd.LoggedIn === true) {
            return new Response(JSON.stringify({ connected: true, success: true }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          let qrRes = await evolutionRequest(instance_token, '/instance/qr');
          let qrStr = qrRes.ok ? normalizeZapiQrValue(findEvolutionQr(qrRes.data)) : null;
          if (!qrStr) {
            const connectRes = await evolutionRequest(instance_token, '/instance/connect', 'POST', { webhookUrl: evolutionWebhookUrl(), subscribe: EVOLUTION_WEBHOOK_EVENTS });
            if (!connectRes.ok) console.warn('get-qr (evolution): /instance/connect falhou:', connectRes.error);
            await new Promise((r) => setTimeout(r, 1500));
            qrRes = await evolutionRequest(instance_token, '/instance/qr');
            qrStr = qrRes.ok ? normalizeZapiQrValue(findEvolutionQr(qrRes.data)) : null;
          }
          if (qrStr) {
            return new Response(JSON.stringify({ qrCode: qrStr, success: true }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          if (!qrRes.ok) {
            return new Response(JSON.stringify({ error: qrRes.error || 'Evolution Go instável', errorType: 'TIMEOUT_OR_GATEWAY' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify({ error: 'QR não disponível (Evolution Go)' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        // Z-API QR code
        if (isZapi) {
          try {
            const zapiRes = await zapiGetQr(instance_id, instance_token, client_token);
            if (!zapiRes.ok) {
              return new Response(JSON.stringify({ error: zapiRes.error || 'Z-API instável', errorType: 'TIMEOUT_OR_GATEWAY' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
            }
            const d = zapiRes.data as Record<string, unknown>;
            if (d.connected === true) {
              return new Response(JSON.stringify({ connected: true, success: true }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
            }
            const qr = d.value || d.qrcode || d.qrCode || d.base64;
            const qrStr = normalizeZapiQrValue(qr);
            if (qrStr) {
              return new Response(JSON.stringify({ qrCode: qrStr, success: true }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
            }
            return new Response(JSON.stringify({ error: 'QR não disponível (Z-API)' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          } catch (e) {
            return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'Erro Z-API', errorType: 'UNKNOWN' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
        }
        try {
          console.log('wapi-send: get-qr - starting fetch for', instance_id);
          const qrController = new AbortController();
          const qrTimeout = setTimeout(() => qrController.abort(), 10000); // 10s timeout

          let res: Response;
          try {
            res = await fetch(
              `${WAPI_BASE_URL}/instance/qr-code?instanceId=${instance_id}&image=enable`,
              { headers: { 'Authorization': `Bearer ${instance_token}` }, signal: qrController.signal }
            );
            clearTimeout(qrTimeout);
          } catch (fetchErr) {
            clearTimeout(qrTimeout);
            const isAbort = fetchErr instanceof Error && (fetchErr.name === 'AbortError' || fetchErr.message.includes('aborted'));
            console.warn('wapi-send: get-qr fetch error:', isAbort ? 'TIMEOUT' : (fetchErr instanceof Error ? fetchErr.message : String(fetchErr)));
            return new Response(JSON.stringify({
              error: 'W-API instável no momento. Tente novamente ou conecte por Telefone.',
              errorType: 'TIMEOUT_OR_GATEWAY',
            }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          console.log('wapi-send: get-qr - received status:', res.status);

          // Gateway errors
          if (res.status === 502 || res.status === 503 || res.status === 504) {
            console.warn('wapi-send: get-qr gateway error:', res.status);
            return new Response(JSON.stringify({
              error: 'W-API instável no momento. Tente novamente ou conecte por Telefone.',
              errorType: 'TIMEOUT_OR_GATEWAY',
            }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          // W-API returns 500 OR 400 when instance needs restart/reinit — auto-restart and retry
          if (res.status === 500 || res.status === 400) {
            console.warn('wapi-send: get-qr got 500 — attempting auto-restart for', instance_id);
            
            // Try restart endpoints
            const restartUrls = [
              { url: `${WAPI_BASE_URL}/instance/restart?instanceId=${instance_id}`, method: 'POST' },
              { url: `${WAPI_BASE_URL}/instance/restart?instanceId=${instance_id}`, method: 'PUT' },
              { url: `${WAPI_BASE_URL}/instance/reboot?instanceId=${instance_id}`, method: 'POST' },
              { url: `${WAPI_BASE_URL}/instance/restart?instanceId=${instance_id}`, method: 'GET' },
            ];
            
            let restarted = false;
            for (const ep of restartUrls) {
              try {
                const rCtrl = new AbortController();
                const rTimeout = setTimeout(() => rCtrl.abort(), 8000);
                const rRes = await fetch(ep.url, {
                  method: ep.method,
                  headers: { 'Authorization': `Bearer ${instance_token}`, 'Content-Type': 'application/json' },
                  signal: rCtrl.signal,
                });
                clearTimeout(rTimeout);
                console.log(`get-qr auto-restart: ${ep.method} => ${rRes.status}`);
                if (rRes.ok) { restarted = true; break; }
              } catch (e) {
                console.warn(`get-qr auto-restart ${ep.method} failed:`, e instanceof Error ? e.message : e);
              }
            }
            
            if (restarted) {
              // Wait 4s for instance to come back, then retry QR
              await new Promise(r => setTimeout(r, 4000));
              console.log('get-qr: retrying QR after restart...');
              
              try {
                const retryCtrl = new AbortController();
                const retryTimeout = setTimeout(() => retryCtrl.abort(), 10000);
                const retryRes = await fetch(
                  `${WAPI_BASE_URL}/instance/qr-code?instanceId=${instance_id}&image=enable`,
                  { headers: { 'Authorization': `Bearer ${instance_token}` }, signal: retryCtrl.signal }
                );
                clearTimeout(retryTimeout);
                
                console.log('get-qr retry status:', retryRes.status);
                
                if (retryRes.ok) {
                  const retryCt = retryRes.headers.get('content-type');
                  if (retryCt?.includes('application/json')) {
                    const retryData = await retryRes.json();
                    if (retryData.connected) {
                      return new Response(JSON.stringify({ connected: true, success: true }), {
                        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                      });
                    }
                    const retryQr = retryData.qrcode || retryData.qrCode || retryData.qr || retryData.base64;
                    if (retryQr) {
                      return new Response(JSON.stringify({ qrCode: retryQr, success: true }), {
                        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                      });
                    }
                  } else if (retryCt?.includes('image')) {
                    const buf = await retryRes.arrayBuffer();
                    const bytes = new Uint8Array(buf);
                    let bin = '';
                    for (let i = 0; i < bytes.length; i += 32768) {
                      const chunk = bytes.subarray(i, Math.min(i + 32768, bytes.length));
                      bin += String.fromCharCode.apply(null, Array.from(chunk));
                    }
                    return new Response(JSON.stringify({ qrCode: `data:${retryCt};base64,${btoa(bin)}`, success: true }), {
                      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    });
                  }
                }
              } catch (retryErr) {
                console.warn('get-qr retry after restart failed:', retryErr instanceof Error ? retryErr.message : retryErr);
              }
            }
            
            // Restart failed or retry failed — return friendly error
            return new Response(JSON.stringify({
              error: 'Instância reiniciando. Aguarde alguns segundos e clique em "Tentar novamente".',
              errorType: restarted ? 'RESTARTING' : 'INSTANCE_ERROR',
            }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          if (!res.ok) {
            return new Response(JSON.stringify({ error: `Erro: ${res.status}` }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          const ct = res.headers.get('content-type');
          if (ct?.includes('application/json')) {
            const data = await res.json();
            if (data.connected) {
              return new Response(JSON.stringify({ connected: true, success: true }), {
                status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              });
            }
            const qr = data.qrcode || data.qrCode || data.qr || data.base64;
            if (qr) {
              return new Response(JSON.stringify({ qrCode: qr, success: true }), {
                status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              });
            }
            return new Response(JSON.stringify({ error: 'QR não disponível' }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          } else if (ct?.includes('image')) {
            const buf = await res.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let bin = '';
            for (let i = 0; i < bytes.length; i += 32768) {
              const chunk = bytes.subarray(i, Math.min(i + 32768, bytes.length));
              bin += String.fromCharCode.apply(null, Array.from(chunk));
            }
            return new Response(JSON.stringify({ qrCode: `data:${ct};base64,${btoa(bin)}`, success: true }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          return new Response(JSON.stringify({ error: 'Formato inesperado' }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (e) {
          console.error('wapi-send: get-qr unexpected error:', e instanceof Error ? e.message : String(e));
          return new Response(JSON.stringify({ 
            error: e instanceof Error ? e.message : 'Erro',
            errorType: 'UNKNOWN',
          }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      case 'request-pairing-code': {
        const { phoneNumber } = body;
        if (!phoneNumber) {
          return new Response(JSON.stringify({ error: 'Número obrigatório' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        let cleanPhone = phoneNumber.replace(/\D/g, '');
        if (!cleanPhone.startsWith('55')) cleanPhone = '55' + cleanPhone;
        if (isZapi) {
          const zapiRes = await zapiRequestPairingCode(instance_id, instance_token, client_token, cleanPhone);
          if (zapiRes.ok) {
            const d = zapiRes.data as Record<string, unknown>;
            const code = d.code || d.pairingCode || d.phone_code;
            if (code) return new Response(JSON.stringify({ success: true, pairingCode: code }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify({ error: zapiRes.error || 'Código não disponível (Z-API)' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        
        // cleanPhone already declared above
        
        try {
          const res = await fetch(
            `${WAPI_BASE_URL}/instance/pairing-code?instanceId=${instance_id}&phoneNumber=${cleanPhone}`,
            { headers: { 'Authorization': `Bearer ${instance_token}` } }
          );
          
          if (!res.ok) {
            const txt = await res.text();
            return new Response(JSON.stringify({ error: `Erro: ${res.status}`, details: txt }), {
              status: res.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          const data = await res.json();
          const code = data.pairingCode || data.code || data.pairing_code;
          if (code) {
            return new Response(JSON.stringify({ success: true, pairingCode: code }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          if (data.connected) {
            return new Response(JSON.stringify({ error: 'Instância já conectada', connected: true }), {
              status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({ error: 'Código não disponível' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'Erro' }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      case 'configure-webhooks': {
        const { webhookUrl } = body;
        if (!webhookUrl || typeof webhookUrl !== 'string' || !webhookUrl.startsWith('https://')) {
          return new Response(JSON.stringify({ error: 'Webhook HTTPS inválido' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (isEvolution) {
          const evoRes = await evolutionRequest(instance_token, '/instance/connect', 'POST', { webhookUrl, subscribe: EVOLUTION_WEBHOOK_EVENTS });
          return new Response(JSON.stringify({ success: evoRes.ok, error: evoRes.error, provider }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (isZapi) {
          const zapiRes = await zapiConfigureWebhooks(instance_id, instance_token, client_token, webhookUrl);
          return new Response(JSON.stringify({ success: zapiRes.ok, error: zapiRes.error, provider: 'zapi' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const config = {
          onConnect: webhookUrl,
          onDisconnect: webhookUrl,
          onMessageSent: webhookUrl,
          onMessageReceived: webhookUrl,
          onMessageStatus: webhookUrl,
        };

        // Try multiple endpoint/body variants for compatibility across W-API plans
        const webhookEndpoints = [
          { url: `${WAPI_BASE_URL}/instance/webhooks?instanceId=${instance_id}`, method: 'PUT', body: config },
          { url: `${WAPI_BASE_URL}/instance/webhooks?instanceId=${instance_id}`, method: 'POST', body: config },
          { url: `${WAPI_BASE_URL}/instance/set-webhooks?instanceId=${instance_id}`, method: 'POST', body: config },
          { url: `${WAPI_BASE_URL}/instance/webhook?instanceId=${instance_id}`, method: 'PUT', body: config },
          { url: `${WAPI_BASE_URL}/instance/webhook?instanceId=${instance_id}`, method: 'POST', body: config },
          { url: `${WAPI_BASE_URL}/instance/update-webhook?instanceId=${instance_id}`, method: 'PUT', body: config },
          { url: `${WAPI_BASE_URL}/instance/update-webhook?instanceId=${instance_id}`, method: 'POST', body: config },
          { url: `${WAPI_BASE_URL}/instance/webhook?instanceId=${instance_id}`, method: 'PUT', body: { url: webhookUrl, webhookUrl } },
          { url: `${WAPI_BASE_URL}/instance/webhook?instanceId=${instance_id}`, method: 'POST', body: { url: webhookUrl, webhookUrl } },
        ];

        let lastError = '';
        let lastStatus = 0;

        for (const endpoint of webhookEndpoints) {
          try {
            const res = await tryWapiWebhookRequest(endpoint, instance_token);
            lastStatus = res.status;
            
            // Gateway/timeout errors — do NOT disconnect, just try next
            if (res.status === 502 || res.status === 503 || res.status === 504) {
              console.warn(`configure-webhooks: gateway error ${res.status} on ${endpoint.method} ${endpoint.url.split('?')[0].split('/').pop()}`);
              lastError = `Timeout/gateway (${res.status})`;
              continue;
            }

            // 404 — try next endpoint variant
            if (res.status === 404) {
              console.warn(`configure-webhooks: 404 on ${endpoint.method} ${endpoint.url.split('?')[0].split('/').pop()}`);
              lastError = 'Endpoint não encontrado';
              continue;
            }

            if (res.text && !res.ok) {
              console.warn('configure-webhooks: non-JSON response:', res.status, res.text.substring(0, 200));
              lastError = 'Resposta inesperada da W-API';
              continue;
            }

            if (res.ok) {
              console.log(`configure-webhooks: SUCCESS via ${endpoint.method} ${endpoint.url.split('?')[0].split('/').pop()}`);
              return new Response(JSON.stringify({ success: true, result: res.data ?? res.text ?? null, variant: endpoint.method }), {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              });
            }

            lastError = res.error || 'Erro desconhecido';
          } catch (e) {
            console.warn(`configure-webhooks: fetch error on ${endpoint.method}:`, e instanceof Error ? e.message : String(e));
            lastError = e instanceof Error ? e.message : 'Erro de comunicação';
            // Network errors are transient — do NOT disconnect
            continue;
          }
        }

        // All attempts failed — but do NOT auto-disconnect
        console.error(`configure-webhooks: all ${webhookEndpoints.length} attempts failed for ${instance_id}. lastStatus=${lastStatus}, lastError=${lastError}`);
        
        const isTransient = lastStatus === 502 || lastStatus === 503 || lastStatus === 504 || lastError.includes('abort') || lastError.includes('Timeout');
        
        return new Response(JSON.stringify({ 
          success: false, 
          error: isTransient 
            ? 'Instabilidade temporária na W-API. Tente novamente em alguns minutos.'
            : `Não foi possível configurar webhooks: ${lastError}. Verifique as credenciais.`,
          errorType: isTransient ? 'TIMEOUT_OR_GATEWAY' : 'CONFIGURATION_FAILED',
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'check-webhooks': {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 8000);
          
          const checkEndpoints = [
            { url: `${WAPI_BASE_URL}/instance/webhooks?instanceId=${instance_id}`, method: 'GET' },
            { url: `${WAPI_BASE_URL}/instance/webhook?instanceId=${instance_id}`, method: 'GET' },
            { url: `${WAPI_BASE_URL}/instance/webhook/${instance_id}`, method: 'GET' },
          ];

          let data: any = null;
          let checkError = 'Erro ao consultar webhooks';

          for (const endpoint of checkEndpoints) {
            const res = await tryWapiWebhookRequest(endpoint, instance_token);
            clearTimeout(timeout);

            if (res.status === 502 || res.status === 503 || res.status === 504) {
              return new Response(JSON.stringify({ 
                success: false, 
                error: 'W-API instável. Tente novamente.',
                errorType: 'TIMEOUT_OR_GATEWAY',
              }), {
                status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              });
            }

            if (res.ok && res.data) {
              data = res.data;
              console.log('check-webhooks data:', JSON.stringify(data));
              break;
            }

            checkError = res.error || (res.status ? `Erro ${res.status} ao consultar webhooks` : 'Erro ao consultar webhooks');
          }

          if (!data) {
            return new Response(JSON.stringify({ 
              success: false, 
              error: checkError,
            }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          const webhookUrl = `https://rsezgnkfhodltrsewlhz.supabase.co/functions/v1/wapi-webhook`;
          
          const hasMessageReceived = data.onMessageReceived === webhookUrl;
          const hasMessageSent = data.onMessageSent === webhookUrl;
          const hasConnect = data.onConnect === webhookUrl;
          const hasDisconnect = data.onDisconnect === webhookUrl;
          
          const allConfigured = hasMessageReceived && hasMessageSent;
          
          return new Response(JSON.stringify({ 
            success: true,
            configured: allConfigured,
            details: {
              onMessageReceived: hasMessageReceived,
              onMessageSent: hasMessageSent,
              onConnect: hasConnect,
              onDisconnect: hasDisconnect,
              raw: data,
            },
          }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (e) {
          console.error('check-webhooks error:', e);
          return new Response(JSON.stringify({ 
            success: false, 
            error: e instanceof Error ? e.message : 'Erro ao verificar webhooks',
            errorType: 'TIMEOUT_OR_GATEWAY',
          }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      case 'download-media': {
        const { messageId: msgId } = body;
        if (!msgId) {
          return new Response(JSON.stringify({ error: 'messageId obrigatório' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Get message with instance info
        const { data: msg, error: msgErr } = await supabase
          .from('wapi_messages')
          .select(`media_key, media_direct_path, media_url, message_type,
            conversation:wapi_conversations!inner(instance:wapi_instances!inner(instance_id, instance_token))`)
          .eq('message_id', msgId)
          .single();
        
        if (msgErr || !msg) {
          return new Response(JSON.stringify({ success: false, error: 'Mensagem não encontrada', canRetry: false }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        // If already has a Supabase URL, return it
        if (msg.media_url && msg.media_url.includes('supabase.co')) {
          return new Response(JSON.stringify({ success: true, url: msg.media_url, mimeType: 'application/octet-stream' }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        // Evolution Go: o arquivo do WhatsApp vem criptografado — abre com a mediaKey
        if (isEvolution) {
          const encUrl = encryptedMediaUrl(msg.media_url, msg.media_direct_path);
          const failEvo = (error: string) => new Response(JSON.stringify({ success: false, error, canRetry: false }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
          if (!msg.media_key || !encUrl) return failEvo('Mídia sem chave para download');
          const mt = String(msg.message_type || 'document');
          const waType = (['image', 'video', 'audio', 'document', 'sticker'].includes(mt) ? mt : 'document') as WaMediaType;
          let plain: Uint8Array | null = null;
          let apiMime: string | null = null;
          try {
            const encRes = await fetch(encUrl);
            if (encRes.ok) plain = await decryptWhatsAppMedia(new Uint8Array(await encRes.arrayBuffer()), msg.media_key, waType);
          } catch (e) {
            console.warn('download-media (evolution): download direto falhou:', e instanceof Error ? e.message : String(e));
          }
          if (!plain) {
            // Plano B: a própria Evolution baixa (com o que ficou guardado da mensagem)
            const viaApi = await evolutionDownloadMedia(instance_token, {
              [`${waType}Message`]: { URL: msg.media_url, directPath: msg.media_direct_path, mediaKey: msg.media_key },
            });
            if (viaApi) {
              plain = viaApi.bytes;
              apiMime = viaApi.mime;
            }
          }
          if (!plain) return failEvo('Não foi possível baixar a mídia (o link do WhatsApp pode ter expirado)');
          const mimeType = apiMime || (waType === 'image' || waType === 'sticker' ? 'image/jpeg' : waType === 'video' ? 'video/mp4' : waType === 'audio' ? 'audio/ogg' : 'application/octet-stream');
          const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'application/pdf': 'pdf' } as Record<string, string>)[mimeType] || 'bin';
          const path = `received/downloads/${msgId}.${ext}`;
          const { error: upErr } = await supabase.storage.from('whatsapp-media').upload(path, plain, { contentType: mimeType, upsert: true });
          if (upErr) return failEvo(upErr.message);
          const { data: signedUrlData } = await supabase.storage.from('whatsapp-media').createSignedUrl(path, 604800);
          if (!signedUrlData?.signedUrl) return failEvo('Falha ao gerar o link da mídia');
          await supabase.from('wapi_messages').update({ media_key: null, media_direct_path: null, media_url: signedUrlData.signedUrl }).eq('message_id', msgId);
          return new Response(JSON.stringify({ success: true, url: signedUrlData.signedUrl, mimeType }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Try to download from WhatsApp URL directly if available
        if (msg.media_url && (msg.media_url.includes('mmg.whatsapp.net') || msg.media_url.includes('w-api.app'))) {
          console.log('Trying direct download from WhatsApp URL:', msg.media_url.substring(0, 60));
          try {
            const directRes = await fetch(msg.media_url);
            if (directRes.ok) {
              const ct = directRes.headers.get('content-type') || 'application/octet-stream';
              const mimeType = ct.split(';')[0].trim();
              const buf = await directRes.arrayBuffer();
              
              if (buf.byteLength > 0) {
                const extMap: Record<string, string> = { 'image/jpeg': 'jpg', 'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'application/pdf': 'pdf' };
                const ext = extMap[mimeType] || 'bin';
                const path = `received/downloads/${msgId}.${ext}`;
                
                const { error: upErr } = await supabase.storage.from('whatsapp-media').upload(path, buf, {
                  contentType: mimeType,
                  upsert: true,
                });
                
                if (!upErr) {
                  // Use signed URL for private bucket (7-day expiry)
                  const { data: signedUrlData } = await supabase.storage.from('whatsapp-media').createSignedUrl(path, 604800);
                  const signedUrl = signedUrlData?.signedUrl;
                  
                  if (signedUrl) {
                    await supabase.from('wapi_messages').update({ 
                      media_key: null, 
                      media_direct_path: null,
                      media_url: signedUrl 
                    }).eq('message_id', msgId);
                    
                    return new Response(JSON.stringify({ success: true, url: signedUrl, mimeType }), {
                      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    });
                  }
                }
              }
            }
          } catch (e) {
            console.log('Direct URL download failed, trying W-API:', e instanceof Error ? e.message : String(e));
          }
        }
        
        if (!msg.media_key || !msg.media_direct_path) {
          return new Response(JSON.stringify({ error: 'Mídia expirada ou indisponível', canRetry: false, hint: 'A mídia não pode mais ser baixada do WhatsApp' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const inst = (msg.conversation as { instance?: { instance_id: string; instance_token: string } })?.instance;
        const iId = inst?.instance_id || instance_id;
        const iToken = inst?.instance_token || instance_token;
        const msgType = msg.message_type || 'image';

        const mimeMap: Record<string, string> = { image: 'image/jpeg', video: 'video/mp4', audio: 'audio/ogg', document: 'application/pdf' };
        const extMap: Record<string, string> = { 'image/jpeg': 'jpg', 'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'application/pdf': 'pdf' };

        // Call W-API download
        const dlRes = await fetch(`${WAPI_BASE_URL}/message/download-media?instanceId=${iId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${iToken}` },
          body: JSON.stringify({
            messageId: msgId,
            type: msgType,
            mimetype: mimeMap[msgType] || 'application/octet-stream',
            mediaKey: msg.media_key,
            directPath: msg.media_direct_path,
          }),
        });

        if (!dlRes.ok) {
          const txt = await dlRes.text();
          console.error('W-API download failed:', txt.substring(0, 200));
          return new Response(JSON.stringify({ error: 'Falha no download', details: txt.substring(0, 100), canRetry: true }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const dlData = await dlRes.json();
        const fileLink = dlData.fileLink || dlData.url || dlData.link;
        let base64 = dlData.base64 || dlData.data || dlData.media;
        let mimeType = dlData.mimetype || mimeMap[msgType] || 'application/octet-stream';

        // If fileLink, fetch it (with size limit to avoid memory issues)
        if (!base64 && fileLink) {
          console.log('Fetching fileLink:', fileLink);
          const fileRes = await fetch(fileLink);
          if (!fileRes.ok) {
            return new Response(JSON.stringify({ error: 'Falha ao baixar do fileLink', canRetry: true }), {
              status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          const ct = fileRes.headers.get('content-type');
          if (ct) mimeType = ct.split(';')[0].trim();
          
          const buf = await fileRes.arrayBuffer();
          
          // For large files (>10MB), upload directly without base64
          if (buf.byteLength > 10 * 1024 * 1024) {
            const ext = extMap[mimeType] || 'bin';
            const path = `received/downloads/${msgId}.${ext}`;
            
            const { error: upErr } = await supabase.storage.from('whatsapp-media').upload(path, buf, {
              contentType: mimeType,
              upsert: true,
            });
            
            if (upErr) {
              console.error('Upload error:', upErr);
              return new Response(JSON.stringify({ error: 'Falha ao salvar mídia' }), {
                status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              });
            }
            
            // Use signed URL for private bucket (7-day expiry)
            const { data: signedUrlData } = await supabase.storage.from('whatsapp-media').createSignedUrl(path, 604800);
            const signedUrl = signedUrlData?.signedUrl;
            
            if (signedUrl) {
              await supabase.from('wapi_messages').update({ 
                media_key: null, 
                media_direct_path: null,
                media_url: signedUrl 
              }).eq('message_id', msgId);
              
              return new Response(JSON.stringify({ success: true, url: signedUrl, mimeType }), {
                status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              });
            }
          }
          
          // Smaller files: convert to base64 in chunks
          const bytes = new Uint8Array(buf);
          let bin = '';
          for (let i = 0; i < bytes.length; i += 32768) {
            const chunk = bytes.subarray(i, Math.min(i + 32768, bytes.length));
            bin += String.fromCharCode.apply(null, Array.from(chunk));
          }
          base64 = btoa(bin);
        }

        if (!base64) {
          return new Response(JSON.stringify({ error: 'Sem dados de mídia', canRetry: false }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Upload to storage
        const ext = extMap[mimeType] || 'bin';
        const path = `received/downloads/${msgId}.${ext}`;
        
        const binStr = atob(base64);
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
        
        const { error: upErr } = await supabase.storage.from('whatsapp-media').upload(path, bytes, {
          contentType: mimeType,
          upsert: true,
        });

        if (upErr) {
          console.error('Upload error:', upErr);
          return new Response(JSON.stringify({ error: 'Falha ao salvar mídia' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        // Use signed URL for private bucket (7-day expiry)
        const { data: signedUrlData } = await supabase.storage.from('whatsapp-media').createSignedUrl(path, 604800);
        const signedUrl = signedUrlData?.signedUrl;
        
        if (!signedUrl) {
          return new Response(JSON.stringify({ error: 'Falha ao gerar URL assinada' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        await supabase.from('wapi_messages').update({ 
          media_key: null, 
          media_direct_path: null,
          media_url: signedUrl 
        }).eq('message_id', msgId);
        
        return new Response(JSON.stringify({ success: true, url: signedUrl, mimeType }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'disconnect': {
        try {
          if (isZapi) {
            await zapiDisconnect(instance_id, instance_token, client_token);
            await supabase.from('wapi_instances').update({ status: 'disconnected', connected_at: null, phone_number: null }).eq('instance_id', instance_id);
            return new Response(JSON.stringify({ success: true, message: 'Desconectado via Z-API' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          // Try multiple W-API disconnect/logout endpoints
          const endpoints = [
            { url: `${WAPI_BASE_URL}/instance/logout?instanceId=${instance_id}`, method: 'DELETE' },
            { url: `${WAPI_BASE_URL}/instance/logout?instanceId=${instance_id}`, method: 'POST' },
            { url: `${WAPI_BASE_URL}/instance/disconnect?instanceId=${instance_id}`, method: 'DELETE' },
            { url: `${WAPI_BASE_URL}/instance/disconnect?instanceId=${instance_id}`, method: 'POST' },
          ];

          let disconnected = false;
          for (const ep of endpoints) {
            try {
              const res = await fetch(ep.url, {
                method: ep.method,
                headers: { 'Authorization': `Bearer ${instance_token}`, 'Content-Type': 'application/json' },
              });
              console.log(`disconnect ${ep.method} ${ep.url.split('?')[0].split('/').pop()} response:`, res.status);
              if (res.ok) {
                const data = await res.json().catch(() => ({}));
                console.log('disconnect success data:', JSON.stringify(data));
                disconnected = true;
                break;
              }
            } catch (fetchErr) {
              console.warn(`disconnect endpoint failed:`, fetchErr);
            }
          }

          // Even if W-API endpoints all fail, update local DB status so user can reconnect with new number
          if (!disconnected) {
            console.warn(`disconnect: all W-API endpoints returned non-OK for ${instance_id}. Forcing local disconnect.`);
          }

          // Always update DB to disconnected — allows user to reconnect
          await supabase
            .from('wapi_instances')
            .update({ status: 'disconnected', connected_at: null, phone_number: null })
            .eq('instance_id', instance_id);

          return new Response(JSON.stringify({ 
            success: true, 
            message: disconnected ? 'Desconectado com sucesso' : 'Desconectado localmente (W-API indisponível)',
            forced: !disconnected,
          }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (e) {
          console.error('disconnect error:', e);
          return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'Erro ao desconectar' }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      case 'edit-text': {
        // Edit a sent message via native WhatsApp edit (W-API / Z-API)
        const { messageId: editMsgId, newContent, conversationId: editConvId } = body;

        if (!editMsgId || !newContent) {
          return new Response(JSON.stringify({ error: 'messageId e newContent são obrigatórios' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // ============ Z-API ============
        if (provider === 'zapi') {
          // Z-API: PUT /send-text with messageId in body to edit
          const zUrl = zapiUrl(instance_id, instance_token, 'send-text');
          try {
            const zRes = await fetch(zUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Client-Token': client_token || '',
              },
              body: JSON.stringify({ phone, message: newContent, messageId: editMsgId, editMessage: true }),
            });
            const zData = await zRes.json().catch(() => ({}));
            if (!zRes.ok || zData?.error) {
              return new Response(JSON.stringify({
                error: zData?.error || 'A Z-API não retornou sucesso ao editar a mensagem. Sua plataforma pode não suportar edição nativa.',
              }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
            }
            await supabase.from('wapi_messages').update({ content: newContent }).eq('message_id', editMsgId);
            if (editConvId) {
              await supabase.from('wapi_conversations').update({
                last_message_content: newContent.substring(0, 100),
              }).eq('id', editConvId);
            }
            return new Response(JSON.stringify({ success: true, method: 'zapi-edit' }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          } catch (e) {
            return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'Erro Z-API edit' }), {
              status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
        }

        // ============ W-API ============
        // Try multiple endpoint/payload variants the W-API uses across plans.
        const editAttempts: Array<{ url: string; method: string; body: Record<string, unknown> }> = [
          { url: `${WAPI_BASE_URL}/message/edit-message?instanceId=${instance_id}`, method: 'POST', body: { phone, messageId: editMsgId, text: newContent } },
          { url: `${WAPI_BASE_URL}/message/edit-text?instanceId=${instance_id}`, method: 'POST', body: { phone, messageId: editMsgId, text: newContent } },
          { url: `${WAPI_BASE_URL}/message/edit?instanceId=${instance_id}`, method: 'POST', body: { phone, messageId: editMsgId, text: newContent } },
          { url: `${WAPI_BASE_URL}/message/edit?instanceId=${instance_id}`, method: 'PUT', body: { phone, messageId: editMsgId, text: newContent } },
        ];

        let lastError = 'Endpoint de edição não suportado pela W-API';
        for (const attempt of editAttempts) {
          const res = await wapiRequest(attempt.url, instance_token, attempt.method, attempt.body);
          if (res.ok) {
            await supabase.from('wapi_messages').update({ content: newContent }).eq('message_id', editMsgId);
            if (editConvId) {
              await supabase.from('wapi_conversations').update({
                last_message_content: newContent.substring(0, 100),
              }).eq('id', editConvId);
            }
            console.log(`✅ Edição nativa funcionou via ${attempt.method} ${attempt.url}`);
            return new Response(JSON.stringify({ success: true, method: 'wapi-native-edit' }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          lastError = res.error || lastError;
          console.log(`Tentativa edit falhou ${attempt.method} ${attempt.url}:`, res.error);
        }

        // No duplicate sending fallback - return error so the UI can show a clear message
        return new Response(JSON.stringify({
          error: 'Sua instância da W-API não suporta edição nativa de mensagens. ' + lastError,
          unsupported: true,
        }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      case 'repair-session': {
        // Repair a degraded instance by trying to extract phone from alternative endpoints
        // or accepting a manual phone number from the user
        const { manualPhone } = body;
        
        console.log(`[repair-session] Attempting repair for instance ${instance_id}, manualPhone=${manualPhone || 'none'}`);

        let extractedPhone: string | null = null;
        let source = 'none';

        // If manual phone provided, validate and use it
        if (manualPhone) {
          const cleaned = String(manualPhone).replace(/\D/g, '');
          if (cleaned.length >= 11 && cleaned.length <= 13) {
            extractedPhone = cleaned;
            source = 'manual';
            console.log(`[repair-session] Using manual phone: ${extractedPhone}`);
          } else {
            console.warn(`[repair-session] Invalid manual phone format: ${manualPhone}`);
            return new Response(JSON.stringify({ 
              repaired: false, 
              reason: 'Formato inválido. Use o número completo com DDI+DDD (ex: 5534991234567).' 
            }), {
              status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
        }

        // If no manual phone, try alternative endpoints
        if (!extractedPhone) {
          if (isZapi) {
            const { data: instRecord } = await supabase
              .from('wapi_instances')
              .select('id, phone_number')
              .eq('instance_id', instance_id)
              .single();

            const zapiRes = await zapiGetStatus(instance_id, instance_token, client_token);
            const zapiData = (zapiRes.data as Record<string, unknown> | undefined) || {};
            const connected = isZapiSessionConnected(zapiData) || hasZapiConnectedMessage(zapiRes.error);
            const hasVerifiedActivity = instRecord?.id
              ? await hasRecentVerifiedActivity(supabase, instRecord.id)
              : false;
            const recoveredPhone = extractConnectedPhone(zapiData) || instRecord?.phone_number || null;

            if (recoveredPhone && (connected || hasVerifiedActivity)) {
              extractedPhone = recoveredPhone;
              source = connected ? 'zapi:status' : 'zapi:evidence';
            }
          }

          if (extractedPhone) {
            // recovered via provider-specific flow
          } else {
          const safeFetch = async (url: string) => {
            try {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 8000);
              const res = await fetch(url, {
                headers: { 'Authorization': `Bearer ${instance_token}` },
                signal: controller.signal,
              });
              clearTimeout(timeout);
              return res;
            } catch {
              return null;
            }
          };

          // Try /instance/me (sometimes available on LITE)
          const meRes = await safeFetch(`${WAPI_BASE_URL}/instance/me?instanceId=${instance_id}`);
          if (meRes?.ok) {
            try {
              const meData = await meRes.json();
              console.log(`[repair-session] /instance/me data:`, JSON.stringify(meData).substring(0, 300));
              extractedPhone = meData.id?.split('@')[0] || meData.phone || meData.phoneNumber || meData.wid?.user || null;
              if (extractedPhone) source = 'auto:me';
            } catch {}
          }

          // Try /instance/qr-code for phone field
          if (!extractedPhone) {
            const qrRes = await safeFetch(`${WAPI_BASE_URL}/instance/qr-code?instanceId=${instance_id}`);
            if (qrRes?.ok) {
              try {
                const qrData = await qrRes.json();
                console.log(`[repair-session] /instance/qr-code data:`, JSON.stringify(qrData).substring(0, 300));
                extractedPhone = qrData.phone || qrData.phoneNumber || qrData.me?.id?.split('@')[0] || null;
                if (extractedPhone) source = 'auto:qr';
              } catch {}
            }
          }

          // Try /instance/status
          if (!extractedPhone) {
            const statusRes = await safeFetch(`${WAPI_BASE_URL}/instance/status?instanceId=${instance_id}`);
            if (statusRes?.ok) {
              try {
                const statusData = await statusRes.json();
                console.log(`[repair-session] /instance/status data:`, JSON.stringify(statusData).substring(0, 300));
                extractedPhone = statusData.me?.id?.split('@')[0] || statusData.phoneNumber || statusData.phone || null;
                if (extractedPhone) source = 'auto:status';
              } catch {}
            }
          }

          // Try /instance/profile
          if (!extractedPhone) {
            const profileRes = await safeFetch(`${WAPI_BASE_URL}/instance/profile?instanceId=${instance_id}`);
            if (profileRes?.ok) {
              try {
                const profileData = await profileRes.json();
                console.log(`[repair-session] /instance/profile data:`, JSON.stringify(profileData).substring(0, 300));
                extractedPhone = profileData.id?.split('@')[0] || profileData.phone || profileData.wid?.user || null;
                if (extractedPhone) source = 'auto:profile';
              } catch {}
            }
          }
          }
        }

        if (extractedPhone) {
          // Clean the phone number
          const cleanPhone = extractedPhone.replace(/\D/g, '');
          
          // Update DB: set status to connected and fill phone_number
          const { error: updateError } = await supabase
            .from('wapi_instances')
            .update({ 
              status: 'connected', 
              phone_number: cleanPhone,
              connected_at: new Date().toISOString(),
            })
            .eq('instance_id', instance_id);

          if (updateError) {
            console.error(`[repair-session] DB update failed:`, updateError);
            return new Response(JSON.stringify({ 
              repaired: false, 
              reason: 'Erro ao atualizar banco de dados.' 
            }), {
              status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          console.log(`[repair-session] SUCCESS for ${instance_id}, phone=${cleanPhone}, source=${source}`);
          return new Response(JSON.stringify({ 
            repaired: true, 
            phoneNumber: cleanPhone,
            source,
          }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Could not extract phone automatically
        console.log(`[repair-session] FAILED for ${instance_id}, no phone found from any endpoint`);
        return new Response(JSON.stringify({ 
          repaired: false, 
          reason: 'Não foi possível extrair o número automaticamente. Informe o número manualmente (visível no painel W-API).',
          needsManualPhone: true,
        }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'restart-instance': {
        if (isZapi) {
          return new Response(JSON.stringify({ 
            success: false,
            restarted: false,
            reason: 'Reinício automático não é suportado para instâncias Z-API pelo app. Se necessário, reinicie pelo painel da Z-API.',
          }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Restart the W-API instance to refresh the cryptographic session
        // This fixes "Aguardando mensagem" caused by stale E2E encryption keys
        console.log(`[restart-instance] Attempting restart for instance ${instance_id}`);

        const restartEndpoints = [
          { url: `${WAPI_BASE_URL}/instance/restart?instanceId=${instance_id}`, method: 'POST' },
          { url: `${WAPI_BASE_URL}/instance/restart?instanceId=${instance_id}`, method: 'PUT' },
          { url: `${WAPI_BASE_URL}/instance/reboot?instanceId=${instance_id}`, method: 'POST' },
          { url: `${WAPI_BASE_URL}/instance/reboot?instanceId=${instance_id}`, method: 'GET' },
          { url: `${WAPI_BASE_URL}/instance/restart?instanceId=${instance_id}`, method: 'GET' },
        ];

        let restartSuccess = false;
        let restartEndpointUsed = '';

        for (const ep of restartEndpoints) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const res = await fetch(ep.url, {
              method: ep.method,
              headers: {
                'Authorization': `Bearer ${instance_token}`,
                'Content-Type': 'application/json',
              },
              signal: controller.signal,
            });
            clearTimeout(timeout);

            const contentType = res.headers.get('content-type');
            let resBody = '';
            if (contentType?.includes('application/json')) {
              const json = await res.json();
              resBody = JSON.stringify(json).substring(0, 300);
            } else {
              resBody = await res.text().then(t => t.substring(0, 200));
            }

            console.log(`[restart-instance] ${ep.method} ${ep.url.split('?')[0].split('/').pop()} => status=${res.status}, body=${resBody}`);

            if (res.ok) {
              restartSuccess = true;
              restartEndpointUsed = `${ep.method} ${ep.url.split('?')[0].split('/').pop()}`;
              break;
            }
          } catch (e) {
            console.warn(`[restart-instance] ${ep.method} ${ep.url.split('?')[0].split('/').pop()} failed:`, e instanceof Error ? e.message : e);
          }
        }

        if (restartSuccess) {
          console.log(`[restart-instance] SUCCESS via ${restartEndpointUsed}. Waiting 3s before verifying...`);
          
          // Wait 3 seconds for the instance to restart
          await new Promise(resolve => setTimeout(resolve, 3000));

          // Verify status after restart
          let verifiedConnected = false;
          let verifiedPhone: string | null = null;

          try {
            const verifyRes = await fetch(`${WAPI_BASE_URL}/instance/qr-code?instanceId=${instance_id}`, {
              headers: { 'Authorization': `Bearer ${instance_token}` },
            });
            if (verifyRes.ok) {
              const verifyData = await verifyRes.json();
              console.log(`[restart-instance] Post-restart verify:`, JSON.stringify(verifyData).substring(0, 300));
              verifiedConnected = verifyData.connected === true;
              verifiedPhone = verifyData.phone || verifyData.phoneNumber || verifyData.me?.id?.split('@')[0] || null;
            }
          } catch (e) {
            console.warn(`[restart-instance] Post-restart verify failed:`, e);
          }

          // Update DB
          if (verifiedConnected) {
            const updateData: Record<string, unknown> = { 
              status: 'connected', 
              connected_at: new Date().toISOString() 
            };
            if (verifiedPhone) {
              updateData.phone_number = verifiedPhone.replace(/\D/g, '');
            }
            await supabase
              .from('wapi_instances')
              .update(updateData)
              .eq('instance_id', instance_id);
          }

          return new Response(JSON.stringify({ 
            success: true, 
            restarted: true,
            connected: verifiedConnected,
            phoneNumber: verifiedPhone,
            endpoint: restartEndpointUsed,
          }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // All restart endpoints failed
        console.log(`[restart-instance] FAILED for ${instance_id}, no endpoint worked`);
        return new Response(JSON.stringify({ 
          success: false, 
          restarted: false,
          reason: 'Nenhum endpoint de restart respondeu. Desconecte e reconecte a instância manualmente.',
        }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'send-reaction': {
        const { messageId: reactionMsgId, emoji } = body;
        
        if (!reactionMsgId || !emoji) {
          return new Response(JSON.stringify({ error: 'messageId e emoji são obrigatórios' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        console.log(`send-reaction: msgId=${reactionMsgId}, emoji=${emoji}, phone=${phone}, instance=${instance_id}`);

        // Evolution Go: POST /message/react {number, reaction, id, fromMe}
        if (isEvolution) {
          const { data: reactConv } = conversationId
            ? await supabase.from('wapi_conversations').select('remote_jid, contact_phone, company_id').eq('id', conversationId).maybeSingle()
            : { data: null };
          const jid = String(reactConv?.remote_jid || phone || '');
          const target = jid.endsWith('@g.us') ? jid : String(reactConv?.contact_phone || phone || jid).replace(/@.*$/, '').replace(/\D/g, '');
          let targetQ = supabase.from('wapi_messages').select('id, from_me').eq('message_id', reactionMsgId);
          if (conversationId) targetQ = targetQ.eq('conversation_id', conversationId);
          const { data: targetRows } = await targetQ.limit(1);
          const targetMsg = (targetRows as Array<{ id: string; from_me: boolean }> | null)?.[0] || null;
          if (!target) {
            return new Response(JSON.stringify({ success: false, error: 'Conversa sem telefone para reagir' }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          const res = await evolutionReact(instance_token, target, reactionMsgId, targetMsg?.from_me === true, emoji);
          console.log(`send-reaction (Evolution) => ok=${res.ok}${res.error ? ` erro=${res.error}` : ''}`);
          if (!res.ok) {
            return new Response(JSON.stringify({ success: false, error: res.error || 'Não foi possível reagir agora' }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          const sentId = extractEvolutionMessageId(res.data);
          if (conversationId && reactConv) {
            const { error: insErr } = await supabase.from('wapi_messages').upsert({
              conversation_id: conversationId,
              message_id: sentId || `reaction_${Date.now()}`,
              from_me: true,
              message_type: 'text',
              content: `[Reação] ${emoji}`,
              status: 'sent',
              timestamp: new Date().toISOString(),
              company_id: reactConv.company_id,
              quoted_message_id: targetMsg?.id || null,
              metadata: { source: 'reaction', provider: 'evolution' },
            }, { onConflict: 'conversation_id,message_id', ignoreDuplicates: true });
            if (insErr) console.error('send-reaction: falha ao gravar a reação:', insErr.message);
          }
          return new Response(JSON.stringify({ success: true, messageId: sentId }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Z-API: endpoint próprio (antes só havia o da W-API e a reação falhava
        // com "não disponível neste plano" nos números da Z-API)
        if (isZapi) {
          const { data: reactConv } = conversationId
            ? await supabase.from('wapi_conversations').select('remote_jid, contact_phone, company_id').eq('id', conversationId).maybeSingle()
            : { data: null };
          const jid = String(reactConv?.remote_jid || phone || '');
          const target = jid.endsWith('@g.us')
            ? jid
            : String(reactConv?.contact_phone || phone || jid).replace(/@.*$/, '').replace(/\D/g, '');
          if (!target) {
            return new Response(JSON.stringify({ success: false, error: 'Conversa sem telefone para reagir' }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          const res = await zapiRequest(instance_id, instance_token, client_token, 'send-reaction', 'POST', {
            phone: target, reaction: emoji, messageId: reactionMsgId,
          });
          console.log(`send-reaction (Z-API) => ok=${res.ok}${res.error ? ` erro=${res.error}` : ''}`);
          if (!res.ok) {
            return new Response(JSON.stringify({ success: false, error: res.error || 'Não foi possível reagir agora' }), {
              status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          // Grava a reação na hora: aparece embaixo da mensagem e o eco do
          // WhatsApp (mesmo id) não é confundido com mensagem do celular
          const sentId = extractZapiMessageId(res.data);
          if (conversationId && reactConv) {
            const { data: targetMsg } = await supabase.from('wapi_messages').select('id')
              .eq('conversation_id', conversationId).eq('message_id', reactionMsgId).maybeSingle();
            const { error: insErr } = await supabase.from('wapi_messages').upsert({
              conversation_id: conversationId,
              message_id: sentId || `reaction_${Date.now()}`,
              from_me: true,
              message_type: 'text',
              content: `[Reação] ${emoji}`,
              status: 'sent',
              timestamp: new Date().toISOString(),
              company_id: reactConv.company_id,
              quoted_message_id: targetMsg?.id || null,
              metadata: { source: 'reaction' },
            }, { onConflict: 'conversation_id,message_id', ignoreDuplicates: true });
            if (insErr) console.error('send-reaction: falha ao gravar a reação:', insErr.message);
          }
          return new Response(JSON.stringify({ success: true, messageId: sentId }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const reactionBody = { phone, messageId: reactionMsgId, emoji };
        
        // Try multiple endpoint/method combinations since W-API versions differ
        const attempts = [
          { url: `${WAPI_BASE_URL}/message/send-reaction?instanceId=${instance_id}`, method: 'POST' },
          { url: `${WAPI_BASE_URL}/message/sendReaction?instanceId=${instance_id}`, method: 'POST' },
          { url: `${WAPI_BASE_URL}/message/send-reaction?instanceId=${instance_id}`, method: 'PUT' },
          { url: `${WAPI_BASE_URL}/message/sendReaction?instanceId=${instance_id}`, method: 'PUT' },
        ];

        let lastStatus = 0;
        let lastBody = '';

        for (const attempt of attempts) {
          try {
            const res = await fetch(attempt.url, {
              method: attempt.method,
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${instance_token}`,
              },
              body: JSON.stringify(reactionBody),
            });
            const text = await res.text();
            console.log(`send-reaction ${attempt.method} ${attempt.url} => status=${res.status}, body=${text.slice(0, 200)}`);
            
            if (res.ok) {
              return new Response(JSON.stringify({ success: true }), {
                status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              });
            }
            lastStatus = res.status;
            lastBody = text;
          } catch (e) {
            console.error(`send-reaction ${attempt.method} error:`, e);
          }
        }

        // All attempts failed
        let errorMsg = 'Reações não disponíveis neste plano da W-API';
        try {
          const parsed = JSON.parse(lastBody);
          if (parsed.message || parsed.error) {
            errorMsg = parsed.message || parsed.error;
          }
        } catch {}
        
        console.error(`send-reaction: all attempts failed. lastStatus=${lastStatus}`);
        
        return new Response(JSON.stringify({ success: false, error: errorMsg }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      default:
        return new Response(JSON.stringify({ error: `Ação desconhecida: ${action}` }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
  } catch (error) {
    console.error('wapi-send error:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Erro interno' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
