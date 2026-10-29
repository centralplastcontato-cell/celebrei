import { linkPreviewText } from "./link-preview.ts";
export { linkPreviewText };
// Evolution Go (whatsmeow) — terceiro provedor de WhatsApp, ao lado da W-API e
// da Z-API (wapi_instances.provider = 'evolution').
//
// - wapi_instances.instance_id = instanceId da Evolution; instance_token = token
//   da instância (header `apikey`). A chave global da Evolution não fica aqui.
// - URL do servidor: variável de ambiente EVOLUTION_GO_URL.
// - O webhook da Evolution é convertido para o formato padrão (messages.upsert /
//   webhookDelivery / disconnection) que o resto do sistema já entende.

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

export const EVOLUTION_DEFAULT_URL = "https://evolution-go.hubcelebrei.com.br";

export function evolutionBaseUrl(): string {
  const env = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get("EVOLUTION_GO_URL");
  return (env || EVOLUTION_DEFAULT_URL).replace(/\/+$/, "");
}

/** Assinaturas do webhook que a plataforma precisa (mensagens, recibos e conexão) */
export const EVOLUTION_WEBHOOK_EVENTS = ["MESSAGE", "READ_RECEIPT", "CONNECTION"];

export interface EvolutionResult {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
  /** Não chamou a Evolution: janela de 2 min após queda, trava ou número pausado */
  held?: boolean;
}

// Trava de TODAS as chamadas à Evolution (envios, status, mídia, reação,
// connect...). Cada função instala a sua no começo da requisição
// (installEvolutionCallGuard em evolution-guard.ts). Devolve o motivo para
// segurar a chamada, ou null para seguir.
type CallGuard = (token: string, path: string) => Promise<string | null>;
let callGuard: CallGuard | null = null;
export function setEvolutionCallGuard(fn: CallGuard | null): void {
  callGuard = fn;
}

export const HELD_PREFIX = "evolution_held:";
// O monitor trava o número só enquanto checa (poucos segundos, a cada 5 min).
// Quem chama nesse meio-tempo espera a checagem acabar em vez de falhar: a IA
// tratava a falha como "não saiu" e passava a conversa para a equipe sem os
// materiais (Juliana Siqueira, VENDAS 2, 24/10 07:55)
export const MONITOR_HOLD_REASON = "monitor checando o número";
export const monitorHoldWait = { totalMs: 20000, stepMs: 2000 };
export function isHeldError(error: string | undefined | null): boolean {
  return String(error || "").startsWith(HELD_PREFIX);
}

export async function evolutionRequest(token: string, path: string, method = "GET", body?: unknown, timeoutMs = 90000): Promise<EvolutionResult> {
  if (callGuard) {
    let reason: string | null = null;
    const waitUntil = Date.now() + monitorHoldWait.totalMs;
    for (;;) {
      try {
        reason = await callGuard(token, path);
      } catch (e) {
        console.warn("[evolution] trava indisponível, seguindo:", e instanceof Error ? e.message : e);
        reason = null;
      }
      if (reason !== MONITOR_HOLD_REASON || Date.now() + monitorHoldWait.stepMs > waitUntil) break;
      await new Promise((r) => setTimeout(r, monitorHoldWait.stepMs));
    }
    if (reason) {
      console.warn(`[evolution] ${method} ${path} segurado: ${reason}`);
      return { ok: false, held: true, error: `${HELD_PREFIX} ${reason}` };
    }
  }
  try {
    const res = await fetch(`${evolutionBaseUrl()}${path}`, {
      method,
      headers: { "Content-Type": "application/json", apikey: token },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch { /* texto puro */ }
    if (!res.ok) {
      const msg = data && typeof data === "object" ? ((data as Json).message || (data as Json).error) : null;
      return { ok: false, status: res.status, data, error: String(msg || text || `HTTP ${res.status}`).slice(0, 300) };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Checagem "de verdade" (detecta servidor travado): pergunta ao WhatsApp, em
 * tempo real, se um número existe — sem enviar nada. Em 12/10 o servidor travou
 * e o /instance/status seguiu dizendo LoggedIn=true; esta consulta falha ou
 * demora. Atenção: com falha interna a Evolution responde 200 com data null.
 */
export const ALIVE_TIMEOUT_MS = 15000;
export async function evolutionCheckAlive(token: string, number: string): Promise<EvolutionResult & { ms: number }> {
  const t0 = Date.now();
  const res = await evolutionRequest(token, "/user/check", "POST", { number: [evolutionNumber(number)], formatJid: true }, ALIVE_TIMEOUT_MS);
  return { ...res, ms: Date.now() - t0 };
}

/** Número de destino: só dígitos; grupo vai com o JID inteiro (…@g.us) */
export function evolutionNumber(raw: string): string {
  const v = String(raw || "").trim();
  if (v.endsWith("@g.us")) return v;
  return v.replace(/@.*$/, "").replace(/\D/g, "");
}

/** Id da mensagem enviada, qualquer que seja o formato da resposta */
export function extractEvolutionMessageId(payload: unknown): string | null {
  const seen = new Set<unknown>();
  const visit = (v: unknown, depth: number): string | null => {
    if (!v || typeof v !== "object" || seen.has(v) || depth > 4) return null;
    seen.add(v);
    const o = v as Json;
    for (const k of ["ID", "Id", "id", "messageId", "MessageID", "messageID"]) {
      if (typeof o[k] === "string" && o[k].length >= 8) return o[k];
    }
    for (const k of ["data", "Info", "info", "key", "message", "result"]) {
      const found = visit(o[k], depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(payload, 0);
}

/** Mensagem citada: id + quem escreveu (JID). A Evolution monta a citação pelo id. */
export interface EvolutionQuoted {
  messageId: string;
  participant: string;
}

export async function evolutionSendText(token: string, to: string, text: string, quoted?: EvolutionQuoted | null): Promise<EvolutionResult> {
  const withPreview = quoted ? null : linkPreviewText(text);
  if (withPreview) {
    // Sem prévia (página fora do ar, imagem que não abre): a Evolution responde erro e
    // vai como texto, igual antes. Sem resposta (tempo esgotado) não reenvia: pode ter saído.
    const res = await evolutionRequest(token, "/send/link", "POST", { number: evolutionNumber(to), text: withPreview }, 45000);
    if (res.ok || isHeldError(res.error) || res.status === undefined) return res;
    console.warn(`[evolution] /send/link falhou (${res.status}): ${String(res.error || "").slice(0, 120)} — enviando como texto`);
  }
  return evolutionRequest(token, "/send/text", "POST", { number: evolutionNumber(to), text, ...(quoted ? { quoted } : {}) });
}

/**
 * Reage a uma mensagem. fromMe = a mensagem reagida foi enviada por nós.
 * Remover reação: emoji vazio vira "remove" (a API recusa vazio).
 */
export function evolutionReact(token: string, to: string, messageId: string, fromMe: boolean, emoji: string, participant?: string | null): Promise<EvolutionResult> {
  const body: Json = { number: evolutionNumber(to), reaction: emoji && emoji.trim() ? emoji : "remove", id: messageId, fromMe };
  if (participant) body.participant = participant;
  return evolutionRequest(token, "/message/react", "POST", body);
}

export type EvolutionMediaType = "image" | "video" | "audio" | "document";

/**
 * O link da mídia devolve o arquivo de verdade? Nos testes (09/10), link
 * bloqueado (página HTML / 403) virou vídeo vazio no celular sem erro na API,
 * e áudio deu 500 "error during conversion". null = ok; texto = motivo.
 */
export function mediaUrlProblem(status: number, contentType: string | null): string | null {
  if (status >= 400) return `o link da mídia respondeu ${status}`;
  const ct = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (ct === "text/html" || ct === "application/json" || ct === "application/xml" || ct === "text/xml") {
    return `o link da mídia não devolve o arquivo (${ct})`;
  }
  return null;
}

export async function checkMediaUrl(url: string): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return "a mídia precisa estar num link (https)";
  try {
    const res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(10000) });
    await res.body?.cancel();
    return mediaUrlProblem(res.status, res.headers.get("content-type"));
  } catch (err) {
    return `o link da mídia não abriu (${err instanceof Error ? err.message : String(err)})`;
  }
}

export async function evolutionSendMedia(
  token: string,
  to: string,
  type: EvolutionMediaType,
  url: string,
  opts: { caption?: string; filename?: string; quoted?: EvolutionQuoted | null } = {},
): Promise<EvolutionResult> {
  const problem = await checkMediaUrl(url);
  if (problem) return { ok: false, error: `Mídia não enviada: ${problem}` };
  const body: Json = { number: evolutionNumber(to), type, url };
  if (opts.caption) body.caption = opts.caption;
  if (opts.filename) body.filename = opts.filename;
  if (opts.quoted) body.quoted = opts.quoted;
  const res = await evolutionRequest(token, "/send/media", "POST", body);
  // 500 de conversão (ffmpeg) não se resolve tentando de novo
  if (!res.ok && /conversion|Invalid data/i.test(res.error || "")) {
    return { ...res, error: `Mídia não enviada: o arquivo não pôde ser convertido (${res.error})` };
  }
  return res;
}

/** data URL ("data:audio/ogg; codecs=opus;base64,....") → bytes + mimetype */
export function parseDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) return null;
  const header = dataUrl.slice(5, comma);
  const mime = header.split(";")[0].trim() || "application/octet-stream";
  try {
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime };
  } catch {
    return null;
  }
}

/**
 * Baixa mídia recebida pela Evolution: POST /message/downloadmedia com o
 * data.Message do webhook do jeito que veio. Resposta: { data: { base64: "data:...;base64,..." } }
 */
export async function evolutionDownloadMedia(token: string, message: Json): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const res = await evolutionRequest(token, "/message/downloadmedia", "POST", { message });
  if (!res.ok) return null;
  const d = res.data as Json | null;
  const b64 = d?.data?.base64 ?? d?.base64;
  return typeof b64 === "string" ? parseDataUrl(b64) : null;
}

// ─── Webhook ──────────────────────────────────────────────────────────────

/** POST que veio da Evolution Go (tem o envelope próprio dela) */
export function isEvolutionPayload(body: Json | null | undefined): boolean {
  return !!body && typeof body.event === "string" && typeof body.instanceId === "string" &&
    "instanceToken" in body && "data" in body;
}

/** Comparação de token sem atalho por tamanho de prefixo */
export function sameToken(a: unknown, b: unknown): boolean {
  const x = String(a ?? "");
  const y = String(b ?? "");
  if (!x || !y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** Cópia para guardar no log bruto, sem o token da instância */
export function redactEvolutionPayload(body: Json): Json {
  return { ...body, instanceToken: body.instanceToken ? "***" : body.instanceToken };
}

const isPhoneJid = (j: unknown) => typeof j === "string" && j.endsWith("@s.whatsapp.net");
const isLid = (j: unknown) => typeof j === "string" && j.endsWith("@lid");

// whatsmeow manda URL/PTT em maiúsculas; o resto do sistema lê url/ptt
const MEDIA_KEYS = ["imageMessage", "audioMessage", "videoMessage", "documentMessage", "stickerMessage", "documentWithCaptionMessage"];

function normalizeMediaFields(m: Json): Json {
  const out: Json = { ...m };
  if (out.URL !== undefined && out.url === undefined) out.url = out.URL;
  if (out.PTT !== undefined && out.ptt === undefined) out.ptt = out.PTT;
  if (out.fileName === undefined && typeof out.FileName === "string") out.fileName = out.FileName;
  return out;
}

// Resposta citando: a Evolution manda contextInfo.stanzaID; o resto do sistema lê stanzaId
function normalizeContextInfo(m: Json): Json {
  const ctx = m.contextInfo as Json | undefined;
  if (!ctx || typeof ctx !== "object" || ctx.stanzaId !== undefined || ctx.stanzaID === undefined) return m;
  return { ...m, contextInfo: { ...ctx, stanzaId: ctx.stanzaID } };
}

function normalizeMessageContent(message: Json): Json {
  const out: Json = { ...message };
  for (const k of MEDIA_KEYS) {
    if (out[k] && typeof out[k] === "object") out[k] = normalizeMediaFields(out[k]);
  }
  for (const k of [...MEDIA_KEYS, "extendedTextMessage"]) {
    if (out[k] && typeof out[k] === "object") out[k] = normalizeContextInfo(out[k]);
  }
  const btn = out.buttonsResponseMessage as Json | undefined;
  if (btn && typeof btn === "object") {
    out.buttonsResponseMessage = {
      ...btn,
      selectedButtonId: btn.selectedButtonId ?? btn.selectedButtonID,
      selectedDisplayText: btn.selectedDisplayText ?? btn.SelectedDisplayText,
    };
  }
  return out;
}

/**
 * Converte o webhook da Evolution Go para o formato padrão. null = ignorar
 * (clique de botão duplicado, recibo "lido por mim", evento sem uso).
 */
export function normalizeEvolutionPayload(body: Json): Json | null {
  const event = String(body.event || "");
  const data = (body.data || {}) as Json;
  const instanceId = body.instanceId;

  if (event === "Message") {
    const info = (data.Info || {}) as Json;
    if (!info.ID) return null;
    const isGroup = info.IsGroup === true || String(info.Chat || "").endsWith("@g.us");
    const fromMe = info.IsFromMe === true;
    let message = normalizeMessageContent((data.Message || {}) as Json);

    // Reação: vira "[Reação] ❤️" apontando para a mensagem que recebeu (como na Z-API)
    let referenceMessageId: string | null = null;
    const reaction = message.reactionMessage as Json | undefined;
    if (reaction && typeof reaction === "object") {
      const emoji = String(reaction.text ?? reaction.Text ?? "").trim();
      const key = (reaction.key || reaction.Key || {}) as Json;
      referenceMessageId = (key.id || key.ID || null) as string | null;
      message = emoji ? { conversation: `[Reação] ${emoji}` } : {};
    }

    const key: Json = { fromMe, id: info.ID };
    const out: Json = {
      pushName: info.PushName || null,
      message,
      messageTimestamp: Math.floor((Date.parse(info.Timestamp) || Date.now()) / 1000),
    };

    if (isGroup) {
      key.remoteJid = info.Chat;
      const author = [info.Sender, info.SenderAlt].find(isPhoneJid) || info.Sender || null;
      if (author && !fromMe) key.participant = author;
    } else {
      // Cliente → nós: Chat/Sender = telefone e SenderAlt = @lid.
      // Celular da equipe → cliente: Chat = @lid e RecipientAlt = telefone.
      const phone = fromMe
        ? [info.RecipientAlt, info.Chat].find(isPhoneJid)
        : [info.Chat, info.Sender, info.SenderAlt].find(isPhoneJid);
      const lid = fromMe
        ? [info.Chat, info.RecipientAlt].find(isLid)
        : [info.SenderAlt, info.Chat, info.Sender].find(isLid);
      if (phone && lid) {
        // @lid na chave + telefone no "sender": o webhook troca pelo telefone e
        // grava o par @lid ↔ telefone (recibos chegam só com o @lid)
        key.remoteJid = lid;
        out.sender = { id: phone };
      } else {
        key.remoteJid = phone || lid || info.Chat;
      }
    }

    out.key = key;
    if (referenceMessageId) {
      out.referenceMessageId = referenceMessageId;
      out.contextInfo = { stanzaId: referenceMessageId, quotedMessageId: referenceMessageId };
    }
    return { event: "messages.upsert", instanceId, data: out };
  }

  if (event === "Receipt") {
    const state = String(body.state || "");
    const ids = Array.isArray(data.MessageIDs) ? data.MessageIDs.filter((x: unknown) => typeof x === "string") : [];
    if (ids.length === 0) return null;
    // "ReadSelf" = o próprio número leu (outro aparelho): não muda tique de ninguém
    const status = state === "Delivered" ? "DELIVERED" : state === "Read" ? "READ" : state === "Played" ? "PLAYED" : null;
    if (!status) return null;
    return { event: "webhookDelivery", instanceId, data: { messageId: ids[0], ids, status } };
  }

  // Eventos de conexão (Connected, Disconnected, LoggedOut…) não viram mensagem:
  // o webhook trata com evolutionConnectionEvent e chama o monitor na hora.
  return null; // ButtonClick (duplicado do Message), conexão, Presence…
}

// ─── Conexão ──────────────────────────────────────────────────────────────

/**
 * Evento CONNECTION da Evolution (whatsmeow) → o que ele indica. null = não é
 * evento de conexão. O monitor confere o status real antes de agir/alertar.
 */
export function evolutionConnectionEvent(body: Json): { hint: "online" | "reconnecting" | "needs_qr"; event: string } | null {
  const event = String(body?.event || "");
  if (/^(Connected|PairSuccess|KeepAliveRestored)$/.test(event)) return { hint: "online", event };
  if (/^(LoggedOut|ClientOutdated)$/.test(event)) return { hint: "needs_qr", event };
  if (/^(Disconnected|StreamReplaced|ConnectFailure|TemporaryBan|KeepAliveTimeout|StreamError)$/.test(event)) return { hint: "reconnecting", event };
  return null;
}

export function evolutionStatus(token: string): Promise<EvolutionResult> {
  return evolutionRequest(token, "/instance/status", "GET", undefined, 15000);
}

/**
 * Religa o cliente de uma instância parada (ex.: depois de reiniciar o servidor
 * da Evolution, as que estavam desconectadas não voltam sozinhas). Com a sessão
 * salva, volta logada sem QR. Mesmo webhook e eventos da conexão pela tela.
 */
export function evolutionConnect(token: string, webhookUrl: string): Promise<EvolutionResult> {
  return evolutionRequest(token, "/instance/connect", "POST", { webhookUrl, subscribe: EVOLUTION_WEBHOOK_EVENTS }, 30000);
}

export function evolutionReconnect(token: string): Promise<EvolutionResult> {
  return evolutionRequest(token, "/instance/reconnect", "POST", undefined, 30000);
}
