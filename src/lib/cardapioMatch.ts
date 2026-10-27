// Cardápio do pacote da festa. Mesma regra do envio automático
// (supabase/functions/_shared/form-auto.ts) — mantenha as duas iguais.
// Palavras do nome do buffet não diferenciam pacote: em "SUPER CASTELO" o que
// conta é "SUPER" (antes empatava com o cardápio "Festa Castelo" e ganhava o errado).

export interface NamedTemplate {
  id: string;
  name: string;
}

const IGNORED = new Set(["a", "o", "as", "os", "da", "de", "do", "das", "dos", "e", "cardapio", "pacote", "formulario", "template"]);

const normalize = (value?: string | null) =>
  (value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

const tokens = (value?: string | null) => normalize(value).split(" ").filter((t) => t && !IGNORED.has(t));

function score(templateName: string, packageName: string): number {
  const t = normalize(templateName);
  const p = normalize(packageName);
  if (!t || !p) return 0;
  if (t === p) return 1000;
  if (t.includes(p)) return 900 - Math.max(t.length - p.length, 0);
  const pt = tokens(packageName);
  const tt = tokens(templateName);
  if (pt.length === 0 || tt.length === 0) return 0;
  const overlap = pt.filter((x) => tt.includes(x)).length;
  if (overlap === 0) return 0;
  return overlap * 100 - (pt.length - overlap) * 35 - (tt.length - overlap) * 5;
}

/** "SUPER CASTELO" no Castelo da Diversão → "super"; "CASTELO" sozinho fica "CASTELO" */
export function packageKey(packageName: string, brand?: string | null): string {
  const brandTokens = new Set(tokens((brand || "").replace(/-/g, " ")));
  const own = tokens(packageName).filter((t) => !brandTokens.has(t));
  return own.length > 0 ? own.join(" ") : packageName;
}

/** Melhores cardápios para o pacote ([] = nenhum casa) */
export function matchCardapioTemplates<T extends NamedTemplate>(templates: T[], rawPackageName: string, brand?: string | null): T[] {
  const packageName = packageKey(rawPackageName, brand);
  const pt = tokens(packageName);
  if (pt.length === 0) return [];
  const scored = templates.map((template) => ({ template, s: score(template.name, packageName) }))
    .filter(({ s }) => s > 0).sort((a, b) => b.s - a.s);
  if (scored.length === 0) return [];
  const best = scored.filter(({ s }) => s === scored[0].s).map(({ template }) => template);
  if (best.length === 1) return best;
  const strict = best.filter((t) => pt.every((x) => tokens(t.name).includes(x)));
  if (strict.length > 0) return [strict[0]];
  // Desempate: o que tem a ÚLTIMA palavra do pacote ("PREMIUM" em "CASTELO PREMIUM")
  for (let i = pt.length - 1; i >= 0; i--) {
    const m = best.find((t) => tokens(t.name).includes(pt[i]));
    if (m) return [m];
  }
  return [best[0]];
}

/** Agenda: sem pacote mostra todos; com pacote, só o(s) que casa(m) */
export function filterCardapioTemplatesByPackage<T extends NamedTemplate>(templates: T[], packageName?: string | null, brand?: string | null): T[] {
  if (!packageName || packageName === "Sem pacote") return templates;
  return matchCardapioTemplates(templates, packageName, brand);
}

/** Um cardápio só (para enviar): sem pacote ou sem cardápio que case, nenhum */
export function pickCardapioTemplate<T extends NamedTemplate>(templates: T[], packageName?: string | null, brand?: string | null): T | null {
  if (!packageName || packageName === "Sem pacote") return null;
  return matchCardapioTemplates(templates, packageName, brand)[0] || null;
}
