// "Arte com IA": a pessoa descreve o tema (como pediria no ChatGPT) e o
// gerador de imagem da OpenAI devolve a arte pronta — com o texto em
// português, o logo do buffet e, se quiser, uma foto real do espaço.
// Também ajusta uma arte já feita ("deixa o fundo azul").

export interface ArtRequest {
  idea: string;
  artText?: string | null;
  companyName?: string | null;
  hasLogo: boolean;
  hasPhoto: boolean;
  /** pedido de ajuste sobre a arte anterior (a arte vai como 1ª imagem) */
  adjust?: string | null;
}

export function buildArtPrompt(r: ArtRequest): string {
  const text = (r.artText || "").trim();
  const textRule = text
    ? `The art must show EXACTLY this text in Brazilian Portuguese, spelled exactly as written (same accents), large, bold and easy to read on a phone: "${text}". Do not write any other words.`
    : "Do not write any words or letters in the art.";

  if (r.adjust?.trim()) {
    const refs = [r.hasLogo ? "The logo image is the buffet logo: keep it exactly as it is." : ""].filter(Boolean).join(" ");
    return [
      "Edit the first image (a promotional art for a children's party venue).",
      `Change only this: ${r.adjust.trim()}.`,
      "Keep everything else as it is: layout, colors, text and logo, unless the change asks otherwise.",
      text ? `If there is text, it must stay spelled exactly: "${text}".` : "",
      refs,
      "Never invent prices, discounts, phone numbers, dates or addresses.",
    ].filter(Boolean).join("\n");
  }

  const refs: string[] = [];
  let n = 1;
  if (r.hasLogo) refs.push(`Image ${n++} is the buffet logo: place it intact and unaltered (same shape, colors and letters), clearly visible but not huge, near a corner or the top.`);
  if (r.hasPhoto) refs.push(`Image ${n++} is a real photo of the buffet: use it as the main scene/background, keeping the place recognizable; add the theme decoration and text around it.`);

  return [
    `Create a beautiful, professional promotional art for WhatsApp and Instagram for a children's party venue (buffet infantil)${r.companyName ? ` called "${r.companyName}"` : ""}.`,
    `Idea / theme: ${r.idea.trim()}.`,
    ...refs,
    textRule,
    "Style: modern premium advertising design, vibrant but harmonious colors, clean layout with clear hierarchy, festive and joyful for families with children. Square format.",
    "Never invent prices, discounts, percentages, phone numbers, dates or addresses that were not given.",
  ].join("\n");
}

// Do mais novo para o mais antigo: se a conta não tiver o novo, usa o anterior
export const ART_MODELS: Array<{ model: string; fidelity: boolean }> = [
  { model: "gpt-image-1.5", fidelity: true },
  { model: "gpt-image-1", fidelity: true },
  { model: "gpt-image-1", fidelity: false },
];

async function fetchImage(url: string, name: string): Promise<File> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Não consegui abrir a imagem (${name})`);
  const type = res.headers.get("content-type")?.split(";")[0] || "image/png";
  const ext = type.includes("jpeg") || type.includes("jpg") ? "jpg" : type.includes("webp") ? "webp" : "png";
  return new File([await res.arrayBuffer()], `${name}.${ext}`, { type });
}

/** Gera (ou ajusta) a arte. Devolve o PNG em base64 e o modelo usado. */
export async function generateArt(opts: {
  apiKey: string;
  prompt: string;
  /** na ordem citada no prompt: [arte anterior?, logo?, foto?] */
  imageUrls: string[];
}): Promise<{ b64: string; model: string }> {
  const files = await Promise.all(opts.imageUrls.map((u, i) => fetchImage(u, `ref${i + 1}`)));
  let lastErr = "";
  for (const cfg of ART_MODELS) {
    let res: Response;
    if (files.length > 0) {
      const form = new FormData();
      form.append("model", cfg.model);
      form.append("prompt", opts.prompt);
      form.append("size", "1024x1024");
      form.append("quality", "medium");
      if (cfg.fidelity) form.append("input_fidelity", "high");
      for (const f of files) form.append("image[]", f);
      res = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        body: form,
      });
    } else {
      res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: cfg.model, prompt: opts.prompt, size: "1024x1024", quality: "medium", n: 1 }),
      });
    }
    if (res.ok) {
      const data = await res.json();
      const b64 = data.data?.[0]?.b64_json;
      if (b64) return { b64, model: cfg.model };
      lastErr = "a IA não devolveu imagem";
      continue;
    }
    const errText = await res.text();
    lastErr = `${res.status} ${errText.slice(0, 300)}`;
    console.error(`[campaign-image] ${cfg.model} falhou:`, lastErr);
    if (res.status === 429) throw new Error("Muitos pedidos de arte agora. Tente de novo em 1 minuto.");
    if (/verif/i.test(errText)) {
      throw new Error("A conta da OpenAI precisa ser verificada para usar o gerador de arte novo (platform.openai.com → Settings → Organization → Verify).");
    }
    if (/safety|moderation/i.test(errText)) throw new Error("A IA recusou esse pedido. Tente descrever de outro jeito.");
    // 400/403/404 (modelo ou opção indisponível): tenta o próximo
    if (res.status >= 500 || [400, 403, 404].includes(res.status)) continue;
    break;
  }
  throw new Error(`Não consegui criar a arte agora (${lastErr}).`);
}
