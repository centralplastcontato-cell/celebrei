import { supabase } from "@/integrations/supabase/client";

// "Formulário enviado" fica no histórico do lead (lead_history.new_value, em
// JSON). Antes ia para uma coluna "details" que não existe na tabela: o
// registro falhava calado e a Agenda nunca mostrava "enviado". O envio
// automático (follow-up-check) usa o mesmo formato para não mandar de novo.

export const FORM_SENT_ACTION = "form_sent_whatsapp";

export interface FormSentRecord {
  form_type: string;
  template_id: string;
  event_id: string;
  template_name?: string;
  auto?: boolean;
}

export async function recordFormSent(leadId: string, companyId: string, record: FormSentRecord, userName?: string | null) {
  const { error } = await supabase.from("lead_history").insert({
    lead_id: leadId,
    company_id: companyId,
    action: FORM_SENT_ACTION,
    user_name: userName || null,
    new_value: JSON.stringify(record),
  });
  if (error) console.error("[formSentHistory] Falha ao registrar envio:", error);
}

/** Envios registrados para a festa */
export async function loadFormsSent(eventId: string): Promise<FormSentRecord[]> {
  const { data, error } = await supabase
    .from("lead_history")
    .select("new_value")
    .eq("action", FORM_SENT_ACTION)
    .like("new_value", `%"event_id":"${eventId}"%`);
  if (error) {
    console.error("[formSentHistory] Falha ao ler envios:", error);
    return [];
  }
  const out: FormSentRecord[] = [];
  for (const row of (data || []) as Array<{ new_value: string | null }>) {
    try {
      const r = JSON.parse(row.new_value || "");
      if (r?.form_type && r?.event_id === eventId) out.push(r);
    } catch { /* registro antigo em outro formato */ }
  }
  return out;
}
