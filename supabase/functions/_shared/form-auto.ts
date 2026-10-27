// Envio automático de formulários da festa (Automações → Formulários):
// - cardápio: X minutos depois que o buffet gera o contrato da festa;
// - avaliação (pós-festa): X horas depois que a festa termina.
// Só no horário de atendimento (nunca depois das 20h), uma vez por festa.
// Regras puras — quem envia é o follow-up-check.

export type AutoFormType = "cardapio" | "avaliacao";

export interface FormTemplateRow {
  id: string;
  name: string;
  slug: string | null;
}

// Mesmo critério da Agenda (EventComplementaryTab) para achar o cardápio do pacote
const MATCH_IGNORED_WORDS = new Set(["a", "o", "as", "os", "da", "de", "do", "das", "dos", "e", "cardapio", "pacote", "formulario", "template"]);

const normalizeName = (value?: string | null) =>
  (value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

const tokensOf = (value?: string | null) => normalizeName(value).split(" ").filter((t) => t && !MATCH_IGNORED_WORDS.has(t));

function matchScore(templateName: string, packageName: string): number {
  const t = normalizeName(templateName);
  const p = normalizeName(packageName);
  if (!t || !p) return 0;
  if (t === p) return 1000;
  if (t.includes(p)) return 900 - Math.max(t.length - p.length, 0);
  const pt = tokensOf(packageName);
  const tt = tokensOf(templateName);
  if (pt.length === 0 || tt.length === 0) return 0;
  const overlap = pt.filter((x) => tt.includes(x)).length;
  if (overlap === 0) return 0;
  return overlap * 100 - (pt.length - overlap) * 35 - (tt.length - overlap) * 5;
}

/**
 * Palavras do nome do buffet não diferenciam pacote: em "SUPER CASTELO" o que
 * conta é "SUPER" (senão empatava com o cardápio "Festa Castelo"). Se o pacote
 * só tem essas palavras ("CASTELO"), elas valem.
 */
export function packageKey(packageName: string, companyName?: string | null): string {
  const brand = new Set(tokensOf(companyName));
  const own = tokensOf(packageName).filter((t) => !brand.has(t));
  return own.length > 0 ? own.join(" ") : packageName;
}

/**
 * O cardápio do pacote da festa. Diferente da Agenda (que mostra todos quando
 * não há pacote), aqui só devolve quando há um pacote e um cardápio que casa
 * com ele — na dúvida não manda (Castelo tem cardápio Castelo, Super e Premium).
 */
export function pickCardapioTemplate<T extends FormTemplateRow>(templates: T[], rawPackageName: string | null | undefined, companyName?: string | null): T | null {
  if (!rawPackageName || rawPackageName === "Sem pacote" || templates.length === 0) return null;
  const packageName = packageKey(rawPackageName, companyName);
  const pt = tokensOf(packageName);
  if (pt.length === 0) return null;
  const scored = templates.map((template) => ({ template, score: matchScore(template.name, packageName) }))
    .filter(({ score }) => score > 0).sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  const best = scored.filter(({ score }) => score === scored[0].score).map(({ template }) => template);
  if (best.length === 1) return best[0];
  const strict = best.filter((t) => pt.every((x) => tokensOf(t.name).includes(x)));
  if (strict.length > 0) return strict[0];
  // Desempate: o cardápio que tem a ÚLTIMA palavra do pacote ("PREMIUM" em "CASTELO PREMIUM")
  for (let i = pt.length - 1; i >= 0; i--) {
    const m = best.find((t) => tokensOf(t.name).includes(pt[i]));
    if (m) return m;
  }
  return best[0];
}

const PUBLIC_PATH: Record<AutoFormType, string> = { cardapio: "cardapio", avaliacao: "avaliacao" };

/**
 * Link do formulário no domínio do buffet (igual ao link dos dados do
 * contratante), já com a festa: www.castelodadiversao.com.br/cardapio/castelo-da-diversao/cardapio-festa-castelo?event_id=…
 */
export function formAutoLink(
  type: AutoFormType,
  opts: { customDomain?: string | null; companySlug?: string | null; templateId: string; templateSlug?: string | null; eventId: string },
): string {
  const domain = (opts.customDomain || "").trim().replace(/\/$/, "").replace(/^https?:\/\//i, "") || "hubcelebrei.com.br";
  const path = opts.templateSlug && opts.companySlug
    ? `/${PUBLIC_PATH[type]}/${opts.companySlug}/${opts.templateSlug}`
    : `/${PUBLIC_PATH[type]}/${opts.templateId}`;
  return `${domain}${path}?event_id=${encodeURIComponent(opts.eventId)}`;
}

const hm = (t: string | null | undefined): [number, number] | null => {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})/);
  return m ? [Number(m[1]), Number(m[2])] : null;
};
const brtMs = (ymd: string, h: number, m: number) => Date.parse(`${ymd}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-03:00`);

/** Fim da festa (horário de Brasília): fim cadastrado; sem ele, início + 4h; sem nada, 23h do dia */
export function partyEndMs(eventYmd: string, startTime: string | null | undefined, endTime: string | null | undefined): number {
  const ymd = String(eventYmd).slice(0, 10);
  const end = hm(endTime);
  const start = hm(startTime);
  if (end) {
    const endMs = brtMs(ymd, end[0], end[1]);
    // Festa que vira a noite (ex.: 19h–00h)
    if (start && end[0] * 60 + end[1] <= start[0] * 60 + start[1]) return endMs + 86400000;
    return endMs;
  }
  if (start) return brtMs(ymd, start[0], start[1]) + 4 * 3600000;
  return brtMs(ymd, 23, 0);
}

// Depois disso o envio perdeu o sentido (ex.: o sistema ficou parado): não manda mais
export const FORM_AUTO_MAX_LATE_MS: Record<AutoFormType, number> = {
  cardapio: 3 * 86400000,
  avaliacao: 4 * 86400000,
};

/**
 * Está na hora de mandar? `refMs` é quando o contrato foi gerado (cardápio)
 * ou quando a festa terminou (avaliação). Nada de antes de ligar a automação.
 */
export function formAutoDue(type: AutoFormType, refMs: number, delayMinutes: number, enabledAtMs: number | null, nowMs: number): boolean {
  if (!Number.isFinite(refMs)) return false;
  if (enabledAtMs !== null && refMs < enabledAtMs) return false;
  const dueMs = refMs + Math.max(0, delayMinutes) * 60000;
  return nowMs >= dueMs && nowMs - dueMs <= FORM_AUTO_MAX_LATE_MS[type];
}

// Iguais aos da tela (FormAutomationSection) — valem quando o buffet não mudou o texto
export const FORM_AUTO_DEFAULT_MESSAGES: Record<AutoFormType, string> = {
  cardapio: "Olá {{nome}}! 🍽️\n\nVamos definir o cardápio da sua festa? Acesse o link abaixo e escolha as opções:\n\n{{link}}",
  avaliacao: "Olá {{nome}}! ⭐\n\nEsperamos que a festa tenha sido incrível! 🎊\n\nNos ajude a melhorar cada vez mais respondendo nossa avaliação:\n{{link}}",
};

// Sem ajuste salvo: cardápio 20 min depois do contrato; avaliação 24 h depois da festa
export const FORM_AUTO_DEFAULT_DELAY_MIN: Record<AutoFormType, number> = { cardapio: 20, avaliacao: 1440 };

/** Registro no histórico do lead (dá para saber depois, na Agenda, que já foi) */
export const FORM_SENT_ACTION = "form_sent_whatsapp";
export function formSentRecord(r: { form_type: string; template_id: string; event_id: string; template_name?: string; auto?: boolean }): string {
  return JSON.stringify(r);
}
