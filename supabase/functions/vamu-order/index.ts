// Pedido de lembrancinhas feito na Vamu 3D (vamu3d.com.br/castelo) chegando
// no Celebrei. O servidor da Vamu chama esta função com o segredo combinado
// (VAMU_WEBHOOK_SECRET). O pedido é ligado à festa pelo código ?festa= (id da
// festa); sem código (QR do cartão impresso), pelo WhatsApp de quem pediu,
// dentro da empresa parceira (VAMU_COMPANY_ID). Fica no histórico do lead, nas
// observações internas da festa (para entregar no dia) e no sininho da equipe.
import { createClient } from "npm:@supabase/supabase-js@2";
import { findLeadByPhone } from "../_shared/lead-phone.ts";
import { resolveUnitNotificationTargets } from "../_shared/notification-targets.ts";
import { isUuid, parseVamuOrder, vamuOrderSummary, vamuOrderTag } from "../_shared/vamu.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const firstName = (s: string | null) => (s || "").trim().split(/\s+/)[0] || "";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const secret = Deno.env.get("VAMU_WEBHOOK_SECRET") || "";
  const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!secret || !sameSecret(auth, secret)) return json({ error: "Não autorizado" }, 401);

  const order = parseVamuOrder(await req.json().catch(() => null));
  if (!order) return json({ error: "Pedido inválido: falta o id" }, 400);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const tag = vamuOrderTag(order.id);

    // 1) Festa pelo código do link
    let event: Row | null = null;
    if (isUuid(order.festa)) {
      const { data } = await admin.from("company_events")
        .select("id, company_id, lead_id, unit, title, event_date, internal_notes").eq("id", order.festa).maybeSingle();
      event = data;
    }
    const companyId: string | null = event?.company_id || Deno.env.get("VAMU_COMPANY_ID") || null;
    if (!companyId) return json({ ok: true, matched: false, reason: "festa não encontrada e VAMU_COMPANY_ID não configurado" });

    // 2) Lead: o da festa ou, sem festa, pelo WhatsApp de quem pediu
    let lead: Row | null = null;
    if (event?.lead_id) {
      const { data } = await admin.from("campaign_leads").select("id, name, unit, whatsapp").eq("id", event.lead_id).maybeSingle();
      lead = data;
    }
    if (!lead && order.whatsapp) lead = await findLeadByPhone(admin, companyId, order.whatsapp, "id, name, unit, whatsapp");
    if (lead && !event) {
      const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
      const { data } = await admin.from("company_events")
        .select("id, company_id, lead_id, unit, title, event_date, internal_notes")
        .eq("lead_id", lead.id).gte("event_date", today).order("event_date", { ascending: true }).limit(1);
      event = data?.[0] || null;
    }

    // Já registrado (a Vamu mandou de novo): não duplica
    if (lead) {
      const { data: seen } = await admin.from("lead_history").select("id")
        .eq("lead_id", lead.id).eq("action", "Pedido Vamu 3D").ilike("new_value", `%${tag}%`).limit(1);
      if (seen && seen.length > 0) return json({ ok: true, matched: true, duplicate: true, lead_id: lead.id, event_id: event?.id || null });
    }

    const summary = vamuOrderSummary(order);
    const contact = [order.contactName, order.whatsapp].filter(Boolean).join(" · ");
    if (lead) {
      await admin.from("lead_history").insert({
        lead_id: lead.id, company_id: companyId, user_id: null, user_name: "Vamu 3D",
        action: "Pedido Vamu 3D",
        new_value: `${summary}${order.details ? ` · Obs.: ${order.details}` : ""}${contact ? ` · Pedido por ${contact}` : ""} ${tag}`,
      });
    }
    // Na festa, para a equipe lembrar de entregar o kit no dia
    if (event && !String(event.internal_notes || "").includes(tag)) {
      const line = `🛍️ Kit Vamu 3D para entregar na festa: ${summary} ${tag}`;
      await admin.from("company_events")
        .update({ internal_notes: event.internal_notes ? `${event.internal_notes}\n${line}` : line }).eq("id", event.id);
    }

    const targets = await resolveUnitNotificationTargets(admin, companyId, event?.unit || lead?.unit || null);
    if (targets.length > 0) {
      const who = firstName(order.childName) || firstName(lead?.name) || firstName(order.contactName) || "Cliente";
      await admin.from("notifications").insert(targets.map((uid: string) => ({
        user_id: uid, company_id: companyId, type: "vamu_order",
        title: `🛍️ Pedido de lembrancinhas Vamu 3D: ${who}`,
        message: `${summary}${event ? "" : " · festa não identificada"}`.slice(0, 200),
        data: { reason: "vamu_order", vamu_order_id: order.id, lead_id: lead?.id || null, event_id: event?.id || null, origem: order.origem },
      })));
    }
    console.log(`[vamu-order] Pedido ${order.id}: lead ${lead?.id || "-"}, festa ${event?.id || "-"}, origem ${order.origem || "-"}`);
    return json({ ok: true, matched: Boolean(lead || event), lead_id: lead?.id || null, event_id: event?.id || null });
  } catch (err) {
    console.error("[vamu-order] Erro:", err);
    return json({ error: "Erro ao registrar o pedido" }, 500);
  }
});
