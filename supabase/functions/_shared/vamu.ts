// Vamu 3D (lembrancinhas impressas em 3D) ↔ Celebrei. A página
// vamu3d.com.br/castelo abre já preenchida pelo link de cada festa, e cada
// pedido feito lá volta para o Celebrei (função vamu-order) amarrado à festa
// pelo código ?festa= — o id da festa (company_events.id).

export const VAMU_PAGE = "https://vamu3d.com.br/castelo";

export interface VamuLinkParty {
  id: string;
  child_name?: string | null;
  child_age?: string | number | null;
  event_date?: string | null; // AAAA-MM-DD
  theme?: string | null;
}

/** Link da página da Vamu já preenchido com os dados da festa */
export function vamuPartyLink(p: VamuLinkParty, origem = "celebrei"): string {
  const q = new URLSearchParams();
  const name = String(p.child_name || "").trim().split(/\s+/)[0];
  if (name) q.set("nome", name);
  const age = Number(String(p.child_age ?? "").match(/\d+/)?.[0]);
  if (Number.isInteger(age) && age > 0 && age < 30) q.set("idade", String(age));
  if (p.event_date && /^\d{4}-\d{2}-\d{2}/.test(p.event_date)) q.set("data", p.event_date.slice(0, 10));
  if (p.theme?.trim()) q.set("tema", p.theme.trim());
  q.set("festa", p.id);
  q.set("origem", origem);
  return `${VAMU_PAGE}?${q.toString()}`;
}

export interface VamuOrder {
  id: string; // id do pedido na Vamu
  festa: string | null;
  childName: string | null;
  childAge: string | null;
  partyDate: string | null;
  theme: string | null;
  products: string[];
  quantity: string | null;
  contactName: string | null;
  whatsapp: string | null;
  details: string | null;
  origem: string | null;
}

const text = (v: unknown, max = 300): string | null => {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : null;
};

/** Pedido que chegou da Vamu (aceita snake_case ou camelCase); null se faltar o id */
export function parseVamuOrder(body: unknown): VamuOrder | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const id = text(b.id, 60);
  if (!id) return null;
  const rawProducts = b.products;
  const products = (Array.isArray(rawProducts) ? rawProducts : String(rawProducts || "").split(","))
    .map((p) => String(p).trim()).filter(Boolean).slice(0, 20);
  return {
    id,
    festa: text(b.festa ?? b.festa_code, 80),
    childName: text(b.child_name ?? b.childName, 80),
    childAge: text(b.child_age ?? b.childAge, 10),
    partyDate: text(b.party_date ?? b.partyDate, 20),
    theme: text(b.theme, 120),
    products,
    quantity: text(b.quantity, 40),
    contactName: text(b.contact_name ?? b.contactName, 80),
    whatsapp: text(b.whatsapp, 30),
    details: text(b.details, 500),
    origem: text(b.origem, 30),
  };
}

export const isUuid = (s: string | null): s is string =>
  !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Marca do pedido no histórico e na festa (evita registrar duas vezes) */
export const vamuOrderTag = (id: string) => `#vamu-${id}`;

/** "Chaveiro com nome, Topo de bolo (30 un.) · Alice, 5 anos" */
export function vamuOrderSummary(o: VamuOrder): string {
  const what = o.products.length ? o.products.join(", ") : "produtos a combinar";
  const qty = o.quantity ? ` (${o.quantity}${/^\d+$/.test(o.quantity) ? " un." : ""})` : "";
  const who = [o.childName, o.childAge ? `${o.childAge} anos` : null].filter(Boolean).join(", ");
  return `${what}${qty}${who ? ` · ${who}` : ""}`;
}
