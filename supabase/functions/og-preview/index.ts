import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BOT_UA_RE =
  /facebookexternalhit|Facebot|WhatsApp|Twitterbot|Slackbot|LinkedInBot|Discordbot|TelegramBot|Googlebot|bingbot|Pinterestbot|redditbot|Applebot|Embedly|Quora Link Preview|Showyoubot|outbrain|vkShare|W3C_Validator/i;

const STATIC_BRANDS: Record<string, { title: string; description: string; image: string; url: string }> = {
  hubcelebrei: {
    title: "Celebrei | A melhor plataforma para buffets infantis",
    description: "Plataforma completa para buffets infantis. Automatize seu atendimento, capture leads e aumente suas vendas com a Celebrei.",
    image: "https://hubcelebrei.com.br/og-para-buffets.jpg",
    url: "https://hubcelebrei.com.br",
  },
  castelodadiversao: {
    title: "Castelo da Diversão | Buffet Infantil",
    description: "O melhor buffet infantil para a festa do seu filho! Conheça nossos pacotes e agende uma visita.",
    image: "https://www.castelodadiversao.online/og-image.jpg",
    url: "https://www.castelodadiversao.online",
  },
  buffetplanetadivertido: {
    title: "Buffet Planeta Divertido | Festa Infantil",
    description: "Venha celebrar no Planeta Divertido! O melhor buffet infantil para a festa inesquecível do seu filho.",
    image: "https://www.buffetplanetadivertido.online/og-planeta.jpg",
    url: "https://www.buffetplanetadivertido.online",
  },
  buffetmegamagic: {
    title: "Buffet Mega Magic | Festa Infantil em São Paulo",
    description: "A festa mágica que seu filho sempre sonhou! Diversão, decoração temática e cardápio completo em São Paulo.",
    image: "https://www.buffetmegamagic.com.br/og-megamagic.jpg",
    url: "https://www.buffetmegamagic.com.br",
  },
};

// Form type display labels
const FORM_LABELS: Record<string, string> = {
  avaliacao: "Avaliação Pós-Festa",
  "pre-festa": "Pré-Festa",
  contrato: "Contrato",
  cardapio: "Escolha de Cardápio",
};

// Form type to DB table mapping
const FORM_TABLE_MAP: Record<string, string> = {
  avaliacao: "evaluation_templates",
  "pre-festa": "prefesta_templates",
  contrato: "contrato_templates",
  cardapio: "cardapio_templates",
};

/** Facebook/WhatsApp exigem og:image ABSOLUTA. Se vier relativa ("/logo.png"),
 *  resolve contra o domínio do buffet; senão o crawler descarta e cai no cache antigo. */
function absoluteImage(image: string, baseUrl: string): string {
  if (!image) return image;
  if (/^https?:\/\//i.test(image)) return image;
  try {
    return new URL(image, baseUrl).toString();
  } catch {
    return image;
  }
}

function buildHTML(meta: { title: string; description: string; image: string; url: string }, redirectUrl?: string): string {
  const finalUrl = redirectUrl || meta.url;
  const image = absoluteImage(meta.image, meta.url);
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${meta.title}</title>
  <meta name="description" content="${meta.description}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${meta.url}" />
  <meta property="og:title" content="${meta.title}" />
  <meta property="og:description" content="${meta.description}" />
  <meta property="og:image" content="${image}" />
  <meta property="og:image:secure_url" content="${image}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:locale" content="pt_BR" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${meta.title}" />
  <meta name="twitter:description" content="${meta.description}" />
  <meta name="twitter:image" content="${image}" />
</head>
<body>
  <p>Redirecionando para <a href="${finalUrl}">${meta.title}</a>...</p>
  <!-- Redirect via JS only: crawlers (que não executam JS) leem o OG e param;
       navegadores reais são encaminhados ao destino. Sem meta-refresh, que os
       bots seguem e assim perdem as tags OG desta página. -->
  <script>window.location.replace(${JSON.stringify(finalUrl)});</script>
</body>
</html>`;
}

function canonicalize(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
}

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

/** Resolve form OG preview for slug-based URLs like /avaliacao/:companySlug/:templateSlug */
async function resolveFormBySlug(formType: string, companySlug: string, templateSlug: string, baseUrl: string): Promise<Response | null> {
  const tableName = FORM_TABLE_MAP[formType];
  const label = FORM_LABELS[formType] || formType;
  if (!tableName) return null;

  const supabase = getSupabase();

  // Get company info
  const { data: company } = await supabase
    .from("companies")
    .select("id, name, logo_url, slug")
    .eq("slug", companySlug)
    .eq("is_active", true)
    .maybeSingle();

  if (!company) return null;

  // Get template info
  const { data: template } = await supabase
    .from(tableName)
    .select("name, description")
    .eq("company_id", company.id)
    .eq("slug", templateSlug)
    .eq("is_active", true)
    .maybeSingle();

  const templateName = (template as any)?.name || label;
  const description = (template as any)?.description || `${label} - ${company.name}`;
  const formUrl = `${baseUrl}/${formType}/${companySlug}/${templateSlug}`;

  const meta = {
    title: `${templateName} | ${company.name}`,
    description,
    image: company.logo_url || "https://hubcelebrei.com.br/og-para-buffets.jpg",
    url: formUrl,
  };

  return new Response(buildHTML(meta, formUrl), {
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Handle maintenance entry OG preview */
async function resolveMaintenance(recordId: string, baseUrl: string): Promise<Response | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("maintenance_entries")
    .select("id, company_id")
    .eq("id", recordId)
    .maybeSingle();

  if (!data) return null;

  const { data: company } = await supabase
    .from("companies")
    .select("name, logo_url")
    .eq("id", data.company_id)
    .single();

  const companyName = company?.name || "Manutenção";
  const logo = company?.logo_url || "https://hubcelebrei.com.br/og-para-buffets.jpg";
  const maintUrl = `${baseUrl}/manutencao/${recordId}`;

  const meta = {
    title: `Checklist de Manutenção | ${companyName}`,
    description: `Preencha o checklist de manutenção — ${companyName}`,
    image: logo,
    url: maintUrl,
  };

  return new Response(buildHTML(meta, maintUrl), {
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Handle evaluation template OG preview (legacy UUID) */
async function resolveEvaluation(templateId: string, baseUrl: string): Promise<Response | null> {
  const supabase = getSupabase();
  const { data } = await supabase.rpc("get_evaluation_template_public", { _template_id: templateId });
  if (!data || (data as any[]).length === 0) return null;

  const row = (data as any[])[0];
  const companyName = row.company_name || "Avaliação";
  const templateName = row.template_name || "Avaliação Pós-Festa";
  const description = row.description || `${companyName} quer saber como foi a sua experiência!`;
  const logo = row.company_logo || "https://hubcelebrei.com.br/og-para-buffets.jpg";
  const evalUrl = `${baseUrl}/avaliacao/${templateId}`;

  const meta = { title: `${templateName} | ${companyName}`, description, image: logo, url: evalUrl };
  return new Response(buildHTML(meta, evalUrl), {
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Handle onboarding OG preview: /onboarding/:companySlug */
async function resolveOnboarding(companySlug: string, baseUrl: string): Promise<Response | null> {
  const supabase = getSupabase();
  const { data: company } = await supabase
    .from("companies")
    .select("name, logo_url, slug")
    .eq("slug", companySlug)
    .eq("is_active", true)
    .maybeSingle();

  if (!company) return null;

  const onboardingUrl = `${baseUrl}/onboarding/${companySlug}`;
  const meta = {
    title: `Onboarding | ${company.name}`,
    description: `Preencha as informações do seu buffet para começarmos a configurar a plataforma Celebrei para o ${company.name}.`,
    image: company.logo_url || "https://hubcelebrei.com.br/og-para-buffets.jpg",
    url: onboardingUrl,
  };

  return new Response(buildHTML(meta, onboardingUrl), {
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

async function resolveClientData(token: string, canonical: string, url: string): Promise<Response | null> {
  const supabase = getSupabase();
  const { data: req } = await supabase.from("client_data_requests").select("company_id").eq("token", token).maybeSingle();
  if (!req?.company_id) return null;
  const { data: company } = await supabase.from("companies").select("name, logo_url, custom_domain, domain_canonical")
    .eq("id", req.company_id).maybeSingle();
  if (!company) return null;
  // No domínio do próprio buffet, segue a prévia normal dele (imagem já preparada)
  const own = [company.domain_canonical, canonicalize(String(company.custom_domain || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, ""))]
    .filter(Boolean) as string[];
  if (own.some((d) => canonical === d || canonical.endsWith(`.${d}`))) return null;
  const { data: lp } = await supabase.from("company_landing_pages").select("hero")
    .eq("company_id", req.company_id).eq("is_published", true).maybeSingle();
  const hero = lp?.hero as { background_image_url?: string | null } | null;
  return new Response(buildHTML({
    title: company.name,
    description: "Preencha seus dados para o contrato da festa 🎉",
    image: hero?.background_image_url || company.logo_url || "https://hubcelebrei.com.br/og-para-buffets.jpg",
    url,
  }, url), { headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" } });
}

async function resolveByDomain(domain: string, pathname: string): Promise<Response | null> {
  const canonical = canonicalize(domain);
  const baseUrl = domain.includes("localhost") ? `http://${domain}` : `https://${domain}`;

  // Check onboarding URL: /onboarding/:companySlug
  const onboardingMatch = pathname.match(/^\/onboarding\/([^/]+)\/?$/i);
  if (onboardingMatch) {
    const result = await resolveOnboarding(onboardingMatch[1], baseUrl);
    if (result) return result;
  }

  // Check maintenance UUID URL: /manutencao/:recordId
  const maintMatch = pathname.match(/^\/manutencao\/([0-9a-f-]{36})$/i);
  if (maintMatch) {
    const result = await resolveMaintenance(maintMatch[1], baseUrl);
    if (result) return result;
  }

  // Link de dados do contratante: a prévia é do buffet DONO do pedido. Sem domínio
  // próprio, o link sai pelo endereço da Celebrei e mostraria a marca da Celebrei.
  const dataMatch = pathname.match(/^\/(?:dados|dados-contratante)\/([A-Za-z0-9-]+)\/?$/);
  if (dataMatch) {
    const result = await resolveClientData(dataMatch[1], canonical, `${baseUrl}${pathname}`);
    if (result) return result;
  }

  // Check slug-based form URLs: /{formType}/{companySlug}/{templateSlug}
  const formMatch = pathname.match(/^\/(avaliacao|pre-festa|contrato|cardapio)\/([^/]+)\/([^/]+)\/?$/i);
  if (formMatch) {
    const result = await resolveFormBySlug(formMatch[1], formMatch[2], formMatch[3], baseUrl);
    if (result) return result;
  }

  // Check legacy evaluation UUID URL
  const evalMatch = pathname.match(/^\/avaliacao\/([0-9a-f-]{36})$/i);
  if (evalMatch) {
    const result = await resolveEvaluation(evalMatch[1], baseUrl);
    if (result) return result;
  }

  // Site automático: <slug>.hubcelebrei.com.br (antes das marcas fixas — "hubcelebrei" casaria com o Hub)
  const siteMatch = canonical.match(/^([a-z0-9-]+)\.hubcelebrei\.com\.br$/);
  if (siteMatch && siteMatch[1] !== "www") {
    const supabase = getSupabase();
    const { data: siteCompany } = await supabase.from("companies").select("id, name, logo_url, slug")
      .eq("slug", siteMatch[1]).eq("is_active", true).maybeSingle();
    if (siteCompany) {
      const { data: siteLp } = await supabase.from("company_landing_pages").select("hero")
        .eq("company_id", siteCompany.id).eq("is_published", true).maybeSingle();
      const siteHero = siteLp?.hero as { title?: string; subtitle?: string; background_image_url?: string | null } | null;
      const siteUrl = `https://${canonical}${pathname !== "/" ? pathname : ""}`;
      return new Response(buildHTML({
        title: siteCompany.name,
        description: siteHero?.subtitle || siteHero?.title || `Conheça o ${siteCompany.name} - buffet infantil`,
        image: siteHero?.background_image_url || siteCompany.logo_url || "https://hubcelebrei.com.br/og-para-buffets.jpg",
        url: siteUrl,
      }, siteUrl), { headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" } });
    }
  }

  // Static brands (fast path)
  for (const [key, brand] of Object.entries(STATIC_BRANDS)) {
    if (canonical.includes(key)) {
      const fullUrl = `${brand.url}${pathname !== "/" ? pathname : ""}`;
      return new Response(buildHTML({ ...brand, url: fullUrl }, fullUrl), {
        headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
      });
    }
  }

  // Dynamic: look up company by domain
  const supabase = getSupabase();
  const { data: company } = await supabase
    .from("companies")
    .select("id, name, logo_url, custom_domain, slug, domain_canonical")
    .or(`domain_canonical.eq.${canonical},slug.eq.${canonical}`)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (!company) return null;

  const { data: lp } = await supabase
    .from("company_landing_pages")
    .select("hero, offer")
    .eq("company_id", company.id)
    .eq("is_published", true)
    .maybeSingle();

  const hero = lp?.hero as { title?: string; subtitle?: string } | null;
  const targetDomain = company.custom_domain || `${company.slug}.hubcelebrei.com.br`;
  const targetUrl = `https://${targetDomain}${pathname !== "/" ? pathname : ""}`;

  const meta = {
    title: hero?.title || company.name || domain,
    description: hero?.subtitle || `Conheça o ${company.name} - buffet infantil`,
    image: company.logo_url || "https://hubcelebrei.com.br/og-para-buffets.jpg",
    url: targetUrl,
  };

  return new Response(buildHTML(meta, targetUrl), {
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

/** For non-bot requests, build a redirect URL from domain+path and 302 redirect */
function buildRedirectUrl(domain: string, path: string): string {
  const base = domain.includes("localhost") ? `http://${domain}` : `https://${domain}`;
  return `${base}${path !== "/" ? path : ""}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const ua = req.headers.get("user-agent") || "";
    const isBot = BOT_UA_RE.test(ua);

    // Mode 0: Direct evaluation OG preview via ?template_id=
    const templateIdParam = url.searchParams.get("template_id");
    if (templateIdParam) {
      const baseUrl = url.searchParams.get("base_url") || "https://hubcelebrei.com.br";
      if (!isBot) {
        return new Response(null, { status: 302, headers: { ...corsHeaders, Location: `${baseUrl}/avaliacao/${templateIdParam}` } });
      }
      const result = await resolveEvaluation(templateIdParam, baseUrl);
      if (result) return result;
      return new Response("Template not found", { status: 404, headers: corsHeaders });
    }

    // Mode 1: explicit ?domain= parameter
    const domainParam = url.searchParams.get("domain");
    const pathParam = url.searchParams.get("path") || "/";
    if (domainParam) {
      // Non-bot: 302 redirect directly to the real page
      if (!isBot) {
        return new Response(null, { status: 302, headers: { ...corsHeaders, Location: buildRedirectUrl(domainParam, pathParam) } });
      }
      const response = await resolveByDomain(domainParam, pathParam);
      if (response) return response;
      return new Response("Domain not found", { status: 404, headers: corsHeaders });
    }

    // Mode 2: Host-header based
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
    const pathname = url.searchParams.get("path") || "/";

    if (host) {
      const canonical = canonicalize(host);
      if (!canonical.includes("supabase") && !canonical.includes("functions")) {
        if (!isBot) {
          return new Response(null, { status: 302, headers: { ...corsHeaders, Location: buildRedirectUrl(host, pathname) } });
        }
        const response = await resolveByDomain(host, pathname);
        if (response) return response;
      }
    }

    return new Response(
      JSON.stringify({ error: "No domain resolved", hint: "Use ?domain=example.com or proxy via Host header", isBot }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("og-preview error:", error);
    return new Response("Internal error", { status: 500, headers: corsHeaders });
  }
});
