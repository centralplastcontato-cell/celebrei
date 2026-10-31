// Ritmo das mensagens automáticas para o mesmo cliente (Castelo, 22/10):
// 1) no máximo UMA mensagem automática de venda por cliente a cada 24 h,
//    somando todas as automações (follow-up do robô, jornada da IA, reativação,
//    pós-visita) — a que chega depois espera, não é cancelada;
// 2) depois da visita (realizada ou não compareceu), por 7 dias, quem fala com
//    o cliente é o pós-visita: follow-ups, jornada e reativação esperam.
// Lembretes curtos no meio da conversa (inatividade, "bot parado"), confirmação
// de visita e dados do contrato não são barrados (respondem ao que acabou de
// acontecer), mas contam como mensagem do dia.
// Ligado por empresa em visit_confirmation_settings (auto_one_per_day,
// post_visit_enabled). Sem as colunas no banco: nada muda.

// deno-lint-ignore no-explicit-any
type Db = any;

export const PACING_WINDOW_MS = 24 * 3600000;
export const POST_VISIT_HOLD_DAYS = 7;

/** Mensagem automática de venda que conta para o limite do dia */
export function isPacedAutomatic(metadata: Record<string, unknown> | null | undefined): boolean {
  const m = metadata || {};
  const source = typeof m.source === "string" ? m.source : "";
  if (source === "auto_reminder" || source === "reactivation_engine" || source === "post_visit" || source === "scheduled_return" || source === "vamu_offer") return true;
  // Follow-up da jornada da IA (as respostas dela ao cliente não contam)
  return source === "ai_agent" && typeof m.ai_followup === "string" && m.ai_followup !== "";
}

export interface PacingSettings {
  onePerDay: boolean;
  postVisit: boolean;
}

// Guardado por alguns minutos (a função fica "quente" entre rodadas: mudança na tela vale logo)
const cache = new Map<string, { at: number; cfg: PacingSettings }>();
const CACHE_MS = 2 * 60000;

export async function loadPacingSettings(supabase: Db, companyId: string): Promise<PacingSettings> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.cfg;
  const { data, error } = await supabase.from("visit_confirmation_settings")
    .select("auto_one_per_day, post_visit_enabled").eq("company_id", companyId).maybeSingle();
  const out = error || !data
    ? { onePerDay: false, postVisit: false }
    : { onePerDay: data.auto_one_per_day === true, postVisit: data.post_visit_enabled === true };
  cache.set(companyId, { at: Date.now(), cfg: out });
  return out;
}

const ymdBR = (ms: number) => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * Leads que NÃO devem receber agora uma mensagem automática de venda:
 * receberam outra nas últimas 24 h (regra 1) ou estão na janela do pós-visita
 * (regra 2, a não ser que quem pergunta seja o próprio pós-visita).
 */
export async function pacingHeldLeads(
  supabase: Db,
  companyId: string,
  leadIds: string[],
  opts: { nowMs?: number; forPostVisit?: boolean } = {},
): Promise<Set<string>> {
  const held = new Set<string>();
  if (leadIds.length === 0) return held;
  const cfg = await loadPacingSettings(supabase, companyId);
  if (!cfg.onePerDay && !cfg.postVisit) return held;
  const nowMs = opts.nowMs ?? Date.now();

  for (let i = 0; i < leadIds.length; i += 200) {
    const chunk = leadIds.slice(i, i + 200);
    if (cfg.postVisit && !opts.forPostVisit) {
      const today = ymdBR(nowMs);
      const { data: visits } = await supabase.from("lead_visits").select("lead_id")
        .in("lead_id", chunk).in("status_visita", ["realizada", "nao_compareceu"])
        .gte("data_visita", addDays(today, -POST_VISIT_HOLD_DAYS)).lte("data_visita", today);
      for (const v of (visits || []) as Array<{ lead_id: string }>) held.add(v.lead_id);
    }
    if (cfg.onePerDay) {
      const { data: convs } = await supabase.from("wapi_conversations").select("id, lead_id")
        .in("lead_id", chunk).not("remote_jid", "like", "%@g.us%");
      const convToLead = new Map(((convs || []) as Array<{ id: string; lead_id: string }>).map((c) => [c.id, c.lead_id]));
      const ids = [...convToLead.keys()];
      for (let j = 0; j < ids.length; j += 200) {
        const { data: msgs } = await supabase.from("wapi_messages").select("conversation_id, metadata")
          .in("conversation_id", ids.slice(j, j + 200)).eq("from_me", true)
          .gte("timestamp", new Date(nowMs - PACING_WINDOW_MS).toISOString()).limit(2000);
        for (const m of (msgs || []) as Array<{ conversation_id: string; metadata: Record<string, unknown> | null }>) {
          if (isPacedAutomatic(m.metadata)) {
            const lead = convToLead.get(m.conversation_id);
            if (lead) held.add(lead);
          }
        }
      }
    }
  }
  return held;
}

/** Conversa sem lead: só a regra 1 (mensagem automática nas últimas 24 h) */
export async function conversationPacedRecently(supabase: Db, companyId: string, conversationId: string, nowMs = Date.now()): Promise<boolean> {
  const cfg = await loadPacingSettings(supabase, companyId);
  if (!cfg.onePerDay) return false;
  const { data: msgs } = await supabase.from("wapi_messages").select("metadata")
    .eq("conversation_id", conversationId).eq("from_me", true)
    .gte("timestamp", new Date(nowMs - PACING_WINDOW_MS).toISOString()).limit(200);
  return ((msgs || []) as Array<{ metadata: Record<string, unknown> | null }>).some((m) => isPacedAutomatic(m.metadata));
}
