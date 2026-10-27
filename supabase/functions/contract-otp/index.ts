import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// Assinatura digital do contrato (página /assinar-contrato/:token):
// - send-otp: manda o código de 6 dígitos pelo WhatsApp do buffet — de
//   preferência pelo número com que o cliente já conversa;
// - submit: confere o código e grava a assinatura (submit_contract_signature)
//   com o IP real de quem assinou.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Pedir outro código: no máximo a cada 45 s
const RESEND_COOLDOWN_MS = 45_000;

/** Celular brasileiro sempre com o 55 (lead salvo como "15991116657" ia sem DDI) */
function canonicalPhone(raw: string): string {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length >= 12 && d.startsWith("55")) return d;
  if (d.length === 10 || d.length === 11) return `55${d}`;
  return d;
}

/** Com e sem o 9 do celular (o WhatsApp guarda muitos números sem ele) */
function phoneVariants(phone: string): string[] {
  const local = phone.startsWith("55") ? phone.slice(2) : phone;
  const set = new Set([phone, local]);
  if (local.length === 11 && local[2] === "9") set.add(local.slice(0, 2) + local.slice(3));
  if (local.length === 10) set.add(local.slice(0, 2) + "9" + local.slice(2));
  return [...set];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { token, action } = body || {};
    if (!token || !action) return json({ success: false, error: "Missing token or action" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    if (action === "send-otp") {
      const { data: sig, error: sigErr } = await sb
        .from("contract_signatures")
        .select("id, contract_id, signer_phone, status, company_id, otp_sent_at")
        .eq("token", token)
        .single();

      if (sigErr || !sig) return json({ success: false, error: "Link inválido." });
      if (sig.status === "signed") return json({ success: false, error: "Este contrato já foi assinado." });
      if (!sig.signer_phone) return json({ success: false, error: "Não encontramos o WhatsApp de quem assina. Fale com o buffet." });

      const sentAt = sig.otp_sent_at ? Date.parse(sig.otp_sent_at) : 0;
      if (sig.status === "otp_sent" && Date.now() - sentAt < RESEND_COOLDOWN_MS) {
        const wait = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - sentAt)) / 1000);
        return json({ success: false, error: `Aguarde ${wait} segundos para pedir outro código.`, wait });
      }

      const phone = canonicalPhone(sig.signer_phone);

      // Número do buffet: o da conversa com o cliente (se conectado); senão, o primeiro conectado
      const { data: connected } = await sb
        .from("wapi_instances")
        .select("id, instance_id, instance_token, status")
        .eq("company_id", sig.company_id)
        .eq("status", "connected");
      const instances = (connected || []) as Array<{ id: string; instance_id: string; instance_token: string }>;
      if (instances.length === 0) return json({ success: false, error: "O WhatsApp do buffet está desconectado agora. Tente de novo em alguns minutos." });
      let instance = instances[0];
      const { data: convs } = await sb
        .from("wapi_conversations")
        .select("instance_id, last_message_at")
        .in("instance_id", instances.map((i) => i.id))
        .or(phoneVariants(phone).map((p) => `contact_phone.ilike.%${p}`).join(","))
        .order("last_message_at", { ascending: false })
        .limit(1);
      const convInstance = (convs || [])[0]?.instance_id;
      if (convInstance) instance = instances.find((i) => i.id === convInstance) || instance;

      const otp = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
      const { data: company } = await sb.from("companies").select("name").eq("id", sig.company_id).maybeSingle();
      const message = `🔐 *Código para assinar o contrato${company?.name ? ` — ${company.name}` : ""}*\n\n*${otp}*\n\nDigite esse código na página do contrato. Ele vale por 10 minutos.\n\n_Não compartilhe este código com ninguém._`;

      const { data: sendData, error: sendErr } = await sb.functions.invoke("wapi-send", {
        body: { action: "send-text", instanceId: instance.instance_id, instanceToken: instance.instance_token, phone, message },
      });
      const sendPayload = sendData as { success?: boolean; error?: string } | null;
      if (sendErr || sendPayload?.success === false) {
        console.error("OTP send error:", sendErr || sendPayload?.error);
        return json({ success: false, error: "Não conseguimos mandar o código pelo WhatsApp. Tente de novo em instantes." });
      }

      // Só grava o código depois de enviado (falha no envio não troca o código válido)
      await sb.from("contract_signatures").update({
        otp_code: otp,
        otp_sent_at: new Date().toISOString(),
        otp_attempts: 0,
        status: "otp_sent",
        signer_phone: phone,
      }).eq("id", sig.id);

      const masked = `(${phone.slice(2, 4)}) •••••-${phone.slice(-4)}`;
      return json({ success: true, maskedPhone: masked, cooldown: RESEND_COOLDOWN_MS / 1000 });
    }

    if (action === "submit") {
      const { otp, signature } = body;
      if (!otp || !signature) return json({ success: false, error: "Faltou o código ou a assinatura." });
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "desconhecido";
      const userAgent = req.headers.get("user-agent") || "";
      const { data, error } = await sb.rpc("submit_contract_signature", {
        _token: token,
        _otp: String(otp),
        _signature_base64: String(signature),
        _ip: ip,
        _user_agent: userAgent,
      });
      if (error) {
        console.error("submit_contract_signature error:", error);
        return json({ success: false, error: "Não conseguimos registrar a assinatura. Tente de novo." });
      }
      return json(typeof data === "string" ? JSON.parse(data) : data);
    }

    return json({ success: false, error: "Invalid action." }, 400);
  } catch (e: any) {
    console.error("contract-otp error:", e);
    return json({ success: false, error: e.message || "Erro interno." }, 500);
  }
});
