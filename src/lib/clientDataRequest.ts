import { supabase } from "@/integrations/supabase/client";
import { getFormAutomationTemplate, resolveFormAutomationMessage } from "@/lib/formAutomationMessages";

// Dados do contratante (formulário /dados/:token): link curto no endereço do
// próprio buffet, pedido direto da conversa e etiqueta de situação.

// Sem letras/números que se confundem (0/O, 1/I/l)
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function shortClientToken(length = 7): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** https://www.castelodadiversao.com.br/dados/K7M2QX9 — domínio do buffet; sem domínio, o endereço atual */
export function clientDataUrl(token: string, customDomain?: string | null): string {
  const domain = (customDomain || "").trim().replace(/\/$/, "");
  const base = domain ? (/^https?:\/\//i.test(domain) ? domain : `https://${domain}`) : window.location.origin;
  return `${base}/dados/${token}`;
}

/** Para a mensagem do WhatsApp: sem "https://" (o WhatsApp não quebra o link em 3 linhas e continua clicável) */
export function clientDataMessageLink(token: string, customDomain?: string | null): string {
  return clientDataUrl(token, customDomain).replace(/^https?:\/\//i, "");
}

export interface ClientDataRequestRow {
  id: string;
  token: string;
  status: string;
  sent_at: string | null;
  completed_at: string | null;
  client_data: Record<string, unknown> | null;
  reminder_count?: number | null;
  overdue_alerted_at?: string | null;
  event_id?: string | null;
  /** Data da festa ligada ao pedido (para saber se é de uma festa que já aconteceu) */
  event_date?: string | null;
}

export type ClientDataState = "pendente" | "atrasado" | "recebido";

export function clientDataState(r: Pick<ClientDataRequestRow, "status" | "overdue_alerted_at">): ClientDataState {
  if (r.status === "completed" || r.status === "reviewed") return "recebido";
  return r.overdue_alerted_at ? "atrasado" : "pendente";
}

/** "📋 Dados pendentes · há 2 dias" / "⚠️ Dados atrasados" / "✅ Dados recebidos" */
export function clientDataLabel(r: Pick<ClientDataRequestRow, "status" | "overdue_alerted_at" | "sent_at">, nowMs = Date.now()): string {
  const state = clientDataState(r);
  if (state === "recebido") return "✅ Dados recebidos";
  const days = r.sent_at ? Math.floor((nowMs - Date.parse(r.sent_at)) / 86400000) : 0;
  const when = days <= 0 ? "hoje" : days === 1 ? "há 1 dia" : `há ${days} dias`;
  return state === "atrasado" ? `⚠️ Dados atrasados · ${when}` : `📋 Dados pendentes · ${when}`;
}

/** Pedido mais recente de cada lead (para as etiquetas na lista e nos cards) */
export async function latestClientDataByLead(leadIds: string[]): Promise<Map<string, ClientDataRequestRow>> {
  const out = new Map<string, ClientDataRequestRow>();
  const ids = [...new Set(leadIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await (supabase as any)
      .from("client_data_requests")
      .select("id, token, status, sent_at, completed_at, client_data, reminder_count, overdue_alerted_at, event_id, lead_id, created_at, event:company_events(event_date)")
      .in("lead_id", ids.slice(i, i + 200))
      .order("created_at", { ascending: false });
    if (error) break;
    for (const row of (data || []) as Array<ClientDataRequestRow & { lead_id: string; event?: { event_date: string | null } | null }>) {
      const { event, ...rest } = row;
      if (!out.has(row.lead_id)) out.set(row.lead_id, { ...rest, event_date: event?.event_date ?? null });
    }
  }
  return out;
}

/** "2026-10-29" no fuso do Brasil */
export function todayIsoBr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/** Pedido de uma festa que já aconteceu (cliente que voltou): não vale para a festa nova */
export function isPastEventRequest(eventDate: string | null | undefined): boolean {
  return !!eventDate && eventDate < todayIsoBr();
}

/**
 * Cria o pedido (na próxima festa do lead, se já existir) e devolve a mensagem
 * pronta com o link — quem chama envia pelo WhatsApp da conversa. Festas que já
 * aconteceram ficam de fora: na cliente que volta, o pedido espera a festa nova
 * ser criada na Agenda e entra nela sozinho.
 */
export async function createClientDataRequest(opts: {
  companyId: string;
  companyName: string;
  customDomain?: string | null;
  leadId: string;
  leadName: string;
  sentVia: "botao" | "fechado" | "agenda";
}): Promise<{ request: ClientDataRequestRow; message: string; link: string }> {
  const { data: events } = await supabase
    .from("company_events")
    .select("id, event_date")
    .eq("company_id", opts.companyId)
    .eq("lead_id", opts.leadId)
    .neq("status", "cancelado")
    .gte("event_date", todayIsoBr())
    .order("event_date", { ascending: true })
    .limit(1);
  const event = (events || [])[0] as { id: string; event_date: string | null } | undefined;

  const token = shortClientToken();
  const { data, error } = await (supabase as any)
    .from("client_data_requests")
    .insert({
      company_id: opts.companyId,
      event_id: event?.id || null,
      lead_id: opts.leadId,
      token,
      status: "sent",
      sent_at: new Date().toISOString(),
      sent_via: opts.sentVia,
    })
    .select("id, token, status, sent_at, completed_at, client_data, reminder_count, overdue_alerted_at, event_id")
    .single();
  if (error) throw error;

  const link = clientDataMessageLink(token, opts.customDomain);
  const template = await getFormAutomationTemplate(opts.companyId, "contrato");
  const dateLabel = event?.event_date ? event.event_date.split("-").reverse().join("/") : "";
  let message = resolveFormAutomationMessage(template, {
    nome: opts.leadName,
    empresa: opts.companyName,
    data_evento: dateLabel,
    link,
    link_formulario_contrato: link,
  });
  // Sem festa na Agenda ainda: tira o "no dia ." que ficaria sem data
  if (!dateLabel) message = message.replace(/\s+no dia\s*(?=[.,!])/i, "");
  return { request: data as ClientDataRequestRow, message, link };
}
