// Prévia de link no WhatsApp (imagem, título e descrição do buffet) para os
// links dos formulários e do contrato. Outros links seguem como texto simples.

const PREVIEW_PATH = /\/(dados|dados-contratante|assinar-contrato|avaliacao|pre-festa|prefesta|contrato)\//i;

/**
 * Texto com o 1º link de formulário já com "https://" (Evolution e Z-API só
 * montam a prévia com o endereço completo). null = sem link que mereça prévia.
 */
export function linkPreviewText(text: string): string | null {
  const re = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s]*/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    if (!PREVIEW_PATH.test(raw)) continue;
    if (/^https?:\/\//i.test(raw)) return text;
    const at = m.index ?? 0;
    // "e-mail@buffet.com.br/x" ou parte de outra palavra: não é link
    if (at > 0 && /[\w@.-]/.test(text[at - 1])) continue;
    return text.slice(0, at) + "https://" + raw + text.slice(at + raw.length);
  }
  return null;
}

/** O link de formulário da mensagem (já com https://) */
export function previewLinkUrl(text: string): string | null {
  const t = linkPreviewText(text);
  if (!t) return null;
  const m = t.match(/https?:\/\/[^\s]+/g)?.find((u) => PREVIEW_PATH.test(u));
  return m ? m.replace(/[).,!?]+$/, "") : null;
}

export interface LinkMeta {
  title: string;
  description: string;
  image: string;
}

const decode = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export function parseOgMeta(html: string): LinkMeta | null {
  const tag = (name: string) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i");
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, "i");
    return decode((html.match(re)?.[1] || html.match(re2)?.[1] || "").trim());
  };
  const title = tag("og:title") || decode((html.match(/<title>([^<]*)<\/title>/i)?.[1] || "").trim());
  const image = tag("og:image");
  if (!title || !/^https?:\/\//i.test(image)) return null;
  return { title, description: tag("og:description") || tag("description"), image };
}

/**
 * Título, descrição e imagem do buffet DONO do domínio do link (a og-preview
 * resolve o domínio → empresa; a página em si é o app e traz a prévia padrão).
 */
export async function linkPreviewMeta(url: string): Promise<LinkMeta | null> {
  try {
    const u = new URL(url);
    const base = Deno.env.get("SUPABASE_URL") || "https://rsezgnkfhodltrsewlhz.supabase.co";
    const res = await fetch(`${base}/functions/v1/og-preview?domain=${encodeURIComponent(u.host)}&path=${encodeURIComponent(u.pathname)}`, {
      headers: { "user-agent": "facebookexternalhit/1.1" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return parseOgMeta(await res.text());
  } catch {
    return null;
  }
}

/**
 * Corpo do /send-link da Z-API, ou null para mandar como texto. A Z-API pede o
 * link no FINAL da mensagem (modelos antigos tinham texto depois dele).
 */
export async function zapiLinkBody(phone: string, message: string): Promise<Record<string, unknown> | null> {
  const text = linkPreviewText(message);
  const url = text ? previewLinkUrl(text) : null;
  if (!text || !url) return null;
  const meta = await linkPreviewMeta(url);
  if (!meta) return null;
  return { phone, message: linkAtEnd(text, url), image: meta.image, linkUrl: url, title: meta.title, linkDescription: meta.description, linkType: "LARGE" };
}

/** A Z-API pede o link no fim: texto que vinha depois dele sobe para antes */
export function linkAtEnd(text: string, url: string): string {
  if (text.trimEnd().endsWith(url)) return text;
  const at = text.indexOf(url);
  if (at < 0) return text;
  const before = text.slice(0, at).trimEnd();
  const after = text.slice(at + url.length).trim();
  return [before, after, url].filter(Boolean).join("\n\n");
}
