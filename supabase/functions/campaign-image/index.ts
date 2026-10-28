import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkCompanyAccess } from "../_shared/company-access.ts";
import { buildArtPrompt, generateArt } from "./gpt-art.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { base_image_url, logo_url, company_id, position, campaign_theme, context, generation_mode } = body;

    // Só quem está logado com acesso à empresa (antes qualquer um gerava arte paga)
    const access = await checkCompanyAccess(
      createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
      req,
      company_id,
    );
    if (!access.ok) {
      return new Response(
        JSON.stringify({ error: access.error }),
        { status: access.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const isThemeOnly = generation_mode === "theme_only";
    const isGpt = generation_mode === "gpt";
    let imageUrl: string | null = null;
    let usedModel = "dall-e-3";
    let costUsd = 0.08;

    if (isGpt) {
      const idea = String(body.idea || "").trim();
      const adjust = String(body.adjust || "").trim();
      const previousUrl = body.previous_url ? String(body.previous_url) : null;
      if (!idea && !adjust) {
        return new Response(
          JSON.stringify({ error: "Descreva a arte que você quer" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const apiKey = Deno.env.get("OPENAI_API_KEY");
      if (!apiKey) throw new Error("OPENAI_API_KEY not configured");
      const isAdjust = !!(adjust && previousUrl);
      const photoUrl = !isAdjust && body.photo_url ? String(body.photo_url) : null;
      const logo = logo_url ? String(logo_url) : null;
      const prompt = buildArtPrompt({
        idea,
        artText: body.art_text,
        companyName: body.company_name,
        hasLogo: !!logo,
        hasPhoto: !!photoUrl,
        adjust: isAdjust ? adjust : null,
      });
      const refs = isAdjust ? [previousUrl!, ...(logo ? [logo] : [])] : [...(logo ? [logo] : []), ...(photoUrl ? [photoUrl] : [])];
      const art = await generateArt({ apiKey, prompt, imageUrls: refs });
      imageUrl = art.b64;
      usedModel = art.model;
      costUsd = 0.07;
    }

    if (!isGpt) {

    if (!isThemeOnly && !base_image_url) {
      return new Response(
        JSON.stringify({ error: "base_image_url é obrigatório no modo com foto" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (isThemeOnly && !campaign_theme && !context) {
      return new Response(
        JSON.stringify({ error: "Informe um tema ou descrição para gerar a arte" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) throw new Error("OPENAI_API_KEY not configured");

    // Position mapping
    const positionMap: Record<string, string> = {
      "top-left": "top-left corner",
      "top-right": "top-right corner",
      "bottom-left": "bottom-left corner",
      "bottom-right": "bottom-right corner",
      "center": "center",
    };
    const posLabel = positionMap[position] || "bottom-right corner";

    let promptText: string;

    if (isThemeOnly) {
      const themeDesc = campaign_theme || "children's party";
      const contextHint = context ? ` Additional context: ${context}.` : "";

      const logoInstruction = logo_url
        ? `Reserve a small clean area in the ${posLabel} of the image for a logo (no text rendered).`
        : "";

      promptText = `Professional promotional artwork for a children's party venue marketing campaign on WhatsApp.
Main theme: "${themeDesc}".${contextHint}

Composition requirements:
- The artwork must be CLEARLY and INSTANTLY recognizable as the theme "${themeDesc}" — the theme is the hero of the image, not a side element.
- Focus on 2 or 3 ICONIC, well-rendered hero objects that represent the theme (for example: a soccer ball and trophy for "Copa do Mundo"; pumpkins and spider webs for Halloween; Christmas tree and gift boxes for Natal). Render these objects large, well-lit and beautifully designed.
- Clean, intentional composition with breathing room. AVOID cluttered scenes packed with random toys, candies, cakes, sweets or food unless the theme is specifically about food/sweets.
- Use a cohesive color palette directly inspired by the theme (e.g. green field + gold for World Cup; orange + black for Halloween).
- Add subtle festive accents (a few balloons, confetti, light particles, soft bokeh) only as supporting background — never overpowering the hero theme.
- Modern editorial / premium advertising aesthetic, soft depth of field, professional lighting, polished gradients, rich but balanced colors.
- Negative space is encouraged so text can be added later on top.
- Square 1:1 format. Background must complement the theme — never plain white, never visually noisy.
${logoInstruction}

ABSOLUTE RULE: Do NOT add ANY text, letters, words, numbers, banners with text, signs, logos with text or written characters of any kind in any language. Only visual decorative elements. ZERO text rendered in the image.`;
    } else {
      const themeHint = campaign_theme
        ? `Main theme: "${campaign_theme}". The decorative elements must clearly represent this theme (e.g. soccer ball + trophy for "Copa do Mundo"). Keep them refined and iconic, not cluttered.`
        : "Add a few refined festive accents (subtle confetti, soft balloons or light particles) on the edges only.";

      const contextHint = context ? ` Additional context: ${context}.` : "";

      const logoInstruction = logo_url
        ? `Reserve a small clean area in the ${posLabel} for a logo (no text rendered).`
        : "";

      promptText = `Professional promotional artwork for a children's party venue marketing campaign on WhatsApp.
Transform the concept into a polished, editorial-quality promotional piece.

Composition requirements:
- ${themeHint}
- Create an elegant, minimal decorative frame/border that frames the central content without crowding it.
- Use 2 or 3 iconic, well-rendered theme objects as hero accents — never a cluttered scene of random toys, candies or food.
- Cohesive color palette inspired by the theme. Soft depth of field and premium lighting.
- ${logoInstruction}
- Leave generous negative space so text can be added on top later.
- Square 1:1 format, modern editorial advertising aesthetic.${contextHint}

ABSOLUTE RULE: Do NOT add ANY text, letters, words, numbers, banners with text, signs or written characters of any kind in any language. Only visual decorative elements. ZERO text rendered in the image.`;
    }

    // For photo-based mode with DALL-E, we can only generate (not edit inline with text prompt easily)
    // So we generate a new image inspired by the theme for both modes
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${openaiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "dall-e-3",
            prompt: promptText,
            n: 1,
            size: "1024x1024",
            quality: "hd",
            response_format: "b64_json",
          }),
        });

        if (response.ok) {
          const data = await response.json();
          const b64 = data.data?.[0]?.b64_json;
          if (b64) {
            imageUrl = b64;
            break;
          }
          throw new Error("Nenhuma imagem retornada pela OpenAI");
        }

        const errText = await response.text();
        console.error(`OpenAI DALL-E error (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`, response.status, errText);

        if (response.status === 429) {
          return new Response(
            JSON.stringify({ error: "Limite de requisições atingido. Tente novamente em alguns minutos." }),
            { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        if (response.status >= 500 && attempt < MAX_RETRIES) {
          const delay = (attempt + 1) * 3000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        throw new Error(`OpenAI API error: ${response.status} - ${errText}`);
      } catch (fetchErr) {
        if (attempt >= MAX_RETRIES) throw fetchErr;
        const delay = (attempt + 1) * 3000;
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    }

    if (!imageUrl) throw new Error("OpenAI falhou após tentativas de retry");

    // Decode base64 to Uint8Array
    const binaryStr = atob(imageUrl);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    // Upload to Supabase Storage
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const filePath = `campaigns/composed-${Date.now()}.png`;
    const { error: uploadError } = await supabase.storage
      .from("sales-materials")
      .upload(filePath, bytes, { contentType: "image/png", upsert: false });

    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    const { data: urlData } = supabase.storage.from("sales-materials").getPublicUrl(filePath);

    // Generate thumbnail
    let thumbnailUrl: string | null = null;
    try {
      const resizeResp = await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/resize-image`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ image_url: urlData.publicUrl, company_id }),
        }
      );
      if (resizeResp.ok) {
        const resizeData = await resizeResp.json();
        thumbnailUrl = resizeData.thumbnail_url || null;
      } else {
        await resizeResp.text();
      }
    } catch (thumbErr) {
      console.error("Thumbnail generation failed:", thumbErr);
    }

    // Log AI usage
    await supabase.from("ai_usage_logs").insert({
      company_id,
      function_name: "campaign-image",
      model: usedModel,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      estimated_cost_usd: costUsd,
    });

    return new Response(
      JSON.stringify({ url: urlData.publicUrl, thumbnail_url: thumbnailUrl }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Erro ao compor arte";
    console.error("campaign-image error:", err);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
