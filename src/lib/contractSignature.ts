import { supabase } from "@/integrations/supabase/client";
import { getContractSendTemplate, logContractAction, resolveContractSendMessage } from "@/components/contracts/contractAuditHelpers";
import { getBrazilianPhoneVariants, toCanonicalBrazilianPhone } from "@/lib/whatsappConversationHelper";

// "Enviar para assinatura" — antes havia 3 cópias (Agenda, ficha da festa e
// lista de contratos), cada uma com um defeito:
// - telefone sem o 55 (lead salvo "15991116657") ia assim para o WhatsApp e
//   para o código de verificação;
// - cada clique criava um link novo (o anterior continuava aberto);
// - mandava pelo primeiro número conectado, não pelo da conversa do cliente.

export interface SignatureContract {
  id: string;
  nome_documento: string;
  lead_id: string | null;
  event_id: string | null;
  template_id: string | null;
}

export interface SignatureInstance {
  instance_id: string;
  instance_token: string;
  unit?: string | null;
}

export interface SendForSignatureResult {
  ok: boolean;
  error?: string;
  link?: string;
  copied?: boolean;
  unit?: string | null;
}

/** Número do buffet para falar com o cliente: o da conversa dele (se conectado); senão, o primeiro conectado */
async function pickInstance(companyId: string, leadId: string, phone: string): Promise<(SignatureInstance & { id: string }) | null> {
  const { data: connected } = await (supabase as any)
    .from("wapi_instances")
    .select("id, instance_id, instance_token, unit")
    .eq("company_id", companyId)
    .eq("status", "connected");
  const list = (connected || []) as Array<SignatureInstance & { id: string }>;
  if (list.length === 0) return null;
  const variants = getBrazilianPhoneVariants(phone);
  const { data: convs } = await (supabase as any)
    .from("wapi_conversations")
    .select("instance_id")
    .in("instance_id", list.map((i) => i.id))
    .or([`lead_id.eq.${leadId}`, ...variants.map((p) => `contact_phone.eq.${p}`)].join(","))
    .order("last_message_at", { ascending: false })
    .limit(1);
  const preferred = convs?.[0]?.instance_id;
  return list.find((i) => i.id === preferred) || list[0];
}

export async function sendContractForSignature(opts: {
  companyId: string;
  companyName: string;
  contract: SignatureContract;
  userId: string;
  instance?: SignatureInstance | null;
}): Promise<SendForSignatureResult> {
  const { companyId, contract } = opts;
  let leadId = contract.lead_id;
  if (!leadId && contract.event_id) {
    const { data: ev } = await supabase.from("company_events").select("lead_id").eq("id", contract.event_id).maybeSingle();
    leadId = ev?.lead_id || null;
  }
  if (!leadId) return { ok: false, error: "Este contrato não tem cliente vinculado." };
  const { data: lead } = await supabase.from("campaign_leads").select("name, whatsapp").eq("id", leadId).maybeSingle();
  const phone = toCanonicalBrazilianPhone(lead?.whatsapp);
  if (!lead || phone.length < 12) return { ok: false, error: "O cliente não tem WhatsApp válido cadastrado." };

  // Link aberto do mesmo contrato: reaproveita (o cliente fica com um link só)
  const { data: open } = await (supabase as any)
    .from("contract_signatures")
    .select("id, token")
    .eq("contract_id", contract.id)
    .in("status", ["pending", "otp_sent"])
    .order("created_at", { ascending: false })
    .limit(1);
  let token: string = open?.[0]?.token;
  const created = !token;
  if (created) {
    token = crypto.randomUUID();
    const { error } = await (supabase as any).from("contract_signatures").insert({
      contract_id: contract.id,
      company_id: companyId,
      signer_name: lead.name,
      signer_phone: phone,
      token,
    });
    if (error) return { ok: false, error: `Não consegui criar o link: ${error.message}` };
  } else {
    await (supabase as any).from("contract_signatures").update({ signer_name: lead.name, signer_phone: phone }).eq("id", open[0].id);
  }
  const link = `${window.location.origin}/assinar-contrato/${token}`;

  const instance = opts.instance || (await pickInstance(companyId, leadId, phone));
  const markSent = async () => {
    await (supabase as any).from("generated_contracts").update({ status: "aguardando_assinatura", signature_token: token }).eq("id", contract.id).neq("status", "assinado");
    await logContractAction(companyId, contract.id, contract.template_id, "contract_sent_for_signature", opts.userId, { lead_id: leadId, instance_unit: instance?.unit || null });
  };

  if (!instance) {
    // Sem WhatsApp conectado: o link vai para a área de transferência
    await navigator.clipboard.writeText(link).catch(() => {});
    await markSent();
    return { ok: true, link, copied: true, unit: null };
  }

  const template = await getContractSendTemplate(companyId);
  const message = resolveContractSendMessage(template, {
    nome: lead.name || "",
    link,
    nome_contrato: contract.nome_documento,
    empresa: opts.companyName,
  });
  const { data: sendResult, error: sendErr } = await supabase.functions.invoke("wapi-send", {
    body: { action: "send-text", instanceId: instance.instance_id, instanceToken: instance.instance_token, phone, message },
  });
  const payload = sendResult as { success?: boolean; error?: string } | null;
  if (sendErr || payload?.success === false) {
    if (created) await (supabase as any).from("contract_signatures").delete().eq("token", token);
    return { ok: false, error: sendErr?.message || payload?.error || "Falha no envio pelo WhatsApp." };
  }
  await markSent();
  return { ok: true, link, copied: false, unit: instance.unit || null };
}
