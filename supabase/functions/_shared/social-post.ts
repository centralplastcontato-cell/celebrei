// Link de post do Instagram / Facebook / TikTok que o cliente manda na conversa
// (ex.: veio pelo post da promoção). A IA não abre links: o sistema busca o
// título e o texto do post (as mesmas informações da prévia do WhatsApp) e
// entrega para a IA saber de que post o cliente está falando.

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** "&#x1f5a4;", "&#127881;", "&amp;"… → caractere de verdade (emojis inclusive) */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return NAMED[code.toLowerCase()] ?? all;
  });
}

const SOCIAL_POST = /(?:https?:\/\/)?(?:www\.|m\.|web\.|vm\.)?(?:instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/[\w-]+\/?(?:\?[^\s]*)?|facebook\.com\/[^\s]+|fb\.watch\/[\w-]+|tiktok\.com\/[^\s]+)/i;

/** Primeiro link de post de rede social do texto (com https://), ou null */
export function socialPostUrl(text: string | null | undefined): string | null {
  const m = (text || "").match(SOCIAL_POST);
  if (!m) return null;
  const url = m[0].replace(/[).,!?]+$/, "");
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export function socialNetworkName(url: string): string {
  if (/instagram\.com/i.test(url)) return "Instagram";
  if (/tiktok\.com/i.test(url)) return "TikTok";
  return "Facebook";
}

export interface SocialPost {
  network: string;
  /** Quem postou ("Buffet Mega Magic") */
  author: string;
  /** Texto do post (legenda), já sem "3 likes, 0 comments…" */
  caption: string;
}

/**
 * og:title / og:description do post → quem postou e a legenda.
 * Instagram: título 'Buffet X no Instagram: "legenda…"' e descrição
 * '3 likes, 0 comments - perfil on October 30, 2026: "legenda completa"'.
 */
export function parseSocialPost(url: string, title: string, description: string): SocialPost | null {
  const t = decodeHtmlEntities(title || "").trim();
  const d = decodeHtmlEntities(description || "").trim();
  const quoted = (s: string) => s.match(/[“"]([\s\S]+?)[”"]?\s*$/)?.[1]?.trim() || "";
  const author = t.match(/^(.+?)\s+(?:on|no|en)\s+(?:Instagram|Facebook|TikTok)\b/i)?.[1]?.trim() || "";
  const caption = quoted(d.replace(/^[^:]*?\b(?:likes?|curtidas?|comments?|comentários?)\b[^:]*:\s*/i, "")) ||
    quoted(t) ||
    (/^\d[\d.,kKmM]*\s+(?:likes?|curtidas?)/i.test(d) ? "" : d);
  const clean = caption.replace(/\s+/g, " ").trim().slice(0, 600);
  if (!clean && !author) return null;
  return { network: socialNetworkName(url), author, caption: clean };
}

/** Nota para a IA, junto da mensagem do cliente */
export function socialPostNote(post: SocialPost): string {
  const who = post.author ? ` de ${post.author}` : "";
  const text = post.caption ? ` Texto do post: "${post.caption}"` : "";
  return `[O cliente mandou um link de post do ${post.network}${who}.${text} — você não abre links, mas este é o post: responda pelo assunto dele (ex.: se for promoção, fale da promoção) sem dizer que não consegue abrir.]`;
}

/** Busca título e texto do post como a prévia do WhatsApp faz. null se não der. */
export async function fetchSocialPost(url: string, timeoutMs = 6000): Promise<SocialPost | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "accept-language": "pt-BR,pt;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 300_000);
    const tag = (name: string) => {
      const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i"));
      const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, "i"));
      return a?.[1] || b?.[1] || "";
    };
    return parseSocialPost(url, tag("og:title") || tag("twitter:title"), tag("og:description") || tag("description"));
  } catch {
    return null;
  }
}
