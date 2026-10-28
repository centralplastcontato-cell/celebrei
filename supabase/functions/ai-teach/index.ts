// "Ensinar a IA" (Configurações → Inteligência Artificial → Testar e ensinar):
// POST { action: "transcribe", company_id, audio_base64, mime } → { text }
// POST { action: "propose", company_id, text, cliente?, resposta? }
//   → { notes: [{ text, kind }], blocked, packageHint, visitHint }
// Só sugere: quem grava (ai_owner_notes) é a tela, depois que o dono confirma.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkCompanyAccess } from "../_shared/company-access.ts";
import { DEFAULT_AI_MODEL } from "../_shared/ai-models.ts";
import { transcribeAudio } from "../wapi-webhook/ai-media.ts";
import { createLlmSession } from "../wapi-webhook/ai-llm.ts";
import { buildTeachPrompt, buildTeachUserMessage, parseTeachProposal } from "./teach.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/^data:[^,]+,/, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();
    const companyId = String(body?.company_id || "");
    const access = await checkCompanyAccess(admin, req, companyId);
    if (!access.ok) return json({ error: access.error }, access.status);
    const openaiKey = Deno.env.get("OPENAI_API_KEY") || null;
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY") || null;

    if (body.action === "transcribe") {
      if (!openaiKey) return json({ error: "Transcrição indisponível agora" }, 500);
      const bytes = fromBase64(String(body.audio_base64 || ""));
      if (bytes.length < 500) return json({ error: "Áudio vazio — grave de novo" }, 400);
      if (bytes.length > MAX_AUDIO_BYTES) return json({ error: "Áudio muito longo — grave até uns 3 minutos" }, 400);
      const r = await transcribeAudio(openaiKey, bytes, String(body.mime || "audio/webm"));
      if (!r) return json({ error: "Não consegui entender o áudio — tente de novo ou escreva" }, 400);
      return json({ text: r.text });
    }

    if (body.action === "propose") {
      const text = String(body.text || "").trim();
      if (text.length < 3) return json({ error: "Escreva ou grave o que a IA deve aprender" }, 400);
      const [{ data: company }, { data: existing }] = await Promise.all([
        admin.from("companies").select("name").eq("id", companyId).maybeSingle(),
        admin.from("ai_owner_notes").select("text").eq("company_id", companyId).eq("is_active", true).order("created_at").limit(80),
      ]);
      const session = createLlmSession({
        model: DEFAULT_AI_MODEL,
        system: buildTeachPrompt(company?.name || "Buffet", ((existing || []) as Array<{ text: string }>).map((e) => e.text)),
        history: [{ role: "user", content: buildTeachUserMessage(text, { cliente: body.cliente, resposta: body.resposta }) }],
        tools: [],
        openaiKey,
        anthropicKey,
      });
      if (!session) return json({ error: "IA indisponível agora" }, 500);
      const step = await session.step();
      const proposal = parseTeachProposal(step.text);
      if (!proposal) return json({ error: "Não consegui organizar — tente escrever de outro jeito" }, 502);
      return json(proposal);
    }

    return json({ error: "Ação inválida" }, 400);
  } catch (err) {
    console.error("[ai-teach]", err);
    return json({ error: "Erro ao processar — tente de novo" }, 500);
  }
});
