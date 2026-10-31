import { decodeHtmlEntities } from "../_shared/social-post.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Fetches Open Graph metadata (title, description, image) from a given URL.
 * Used for link previews in the WhatsApp chat.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { url } = await req.json();

    if (!url || typeof url !== "string") {
      return new Response(
        JSON.stringify({ error: "URL is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate URL format
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url.startsWith("http") ? url : `https://${url}`);
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid URL" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch the page with a timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    let response: Response;
    try {
      response = await fetch(parsedUrl.toString(), {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; CelebreiBot/1.0; +https://hubcelebrei.com.br)",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        },
        signal: controller.signal,
        redirect: "follow",
      });
    } catch (fetchErr) {
      clearTimeout(timeout);
      console.error("Fetch error:", fetchErr);
      return new Response(
        JSON.stringify({ error: "Failed to fetch URL" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    clearTimeout(timeout);

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: `HTTP ${response.status}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return new Response(
        JSON.stringify({ title: parsedUrl.hostname, url: parsedUrl.toString() }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Read only first 50KB to avoid memory issues
    const reader = response.body?.getReader();
    let html = "";
    const decoder = new TextDecoder();
    const maxBytes = 50 * 1024;
    let totalBytes = 0;

    if (reader) {
      while (totalBytes < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        totalBytes += value.byteLength;
      }
      reader.cancel();
    }

    // Parse OG metadata using regex (fast, no DOM parser needed)
    const getMetaContent = (property: string): string | null => {
      // Try og: property first
      const ogMatch = html.match(
        new RegExp(`<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']*?)["']`, "i")
      ) || html.match(
        new RegExp(`<meta[^>]*content=["']([^"']*?)["'][^>]*property=["']${property}["']`, "i")
      );
      if (ogMatch) return ogMatch[1];

      // Try name= fallback (for twitter:, description, etc.)
      const nameMatch = html.match(
        new RegExp(`<meta[^>]*name=["']${property}["'][^>]*content=["']([^"']*?)["']`, "i")
      ) || html.match(
        new RegExp(`<meta[^>]*content=["']([^"']*?)["'][^>]*name=["']${property}["']`, "i")
      );
      return nameMatch ? nameMatch[1] : null;
    };

    const title =
      getMetaContent("og:title") ||
      getMetaContent("twitter:title") ||
      html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ||
      parsedUrl.hostname;

    const description =
      getMetaContent("og:description") ||
      getMetaContent("twitter:description") ||
      getMetaContent("description") ||
      null;

    // "&amp;" no endereço da imagem (Instagram) quebra a assinatura e a foto não abre
    const rawImage = getMetaContent("og:image") || getMetaContent("twitter:image") || null;
    let image = rawImage ? decodeHTMLEntities(rawImage) : null;

    // Resolve relative image URLs
    if (image && !image.startsWith("http")) {
      try {
        image = new URL(image, parsedUrl.origin).toString();
      } catch {
        image = null;
      }
    }

    const siteName =
      getMetaContent("og:site_name") ||
      parsedUrl.hostname.replace(/^www\./, "");

    // Instagram/Facebook não deixam a foto aparecer em outro site e o endereço
    // expira em dias: a foto vem junto, já baixada (só se for pequena)
    if (image) image = (await inlineImage(image)) || image;

    const result = {
      title: decodeHTMLEntities(title),
      description: description ? decodeHTMLEntities(description) : null,
      image,
      siteName: decodeHTMLEntities(siteName),
      url: parsedUrl.toString(),
    };

    return new Response(JSON.stringify(result), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    console.error("og-fetch error:", error);
    return new Response(
      JSON.stringify({ error: "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

const decodeHTMLEntities = decodeHtmlEntities;

const MAX_INLINE_IMAGE = 400 * 1024;

/** Foto da prévia como data: (até 400 KB); null se não der para baixar */
async function inlineImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "facebookexternalhit/1.1", "Accept": "image/*" },
      signal: AbortSignal.timeout(5000),
    });
    const type = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!res.ok || !/^image\/(jpeg|png|webp|gif)$/i.test(type)) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_INLINE_IMAGE) return null;
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${type};base64,${btoa(bin)}`;
  } catch {
    return null;
  }
}
