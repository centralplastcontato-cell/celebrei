// Ordem de venda dos horários de festa (ai_agent_settings.slot_priority),
// do que MAIS vende para o que MENOS vende. Ex. do Castelo (28/10):
//   ["sab-noite", "sab-almoco", "sex-noite", "dom-almoco", "dom-noite", "qui", "qua", "ter", "seg"]
// Com ela, quando a data pedida está ocupada (ou o cliente pergunta por um
// mês), a IA oferece primeiro os horários que vendem MENOS, perto do que ele
// pediu — e não só o mesmo dia da semana. Sem a lista, nada muda.

import type { FreeDay, FreeSlot } from "./party-availability.ts";

const DOW_KEYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];
const noon = (ymd: string) => Date.parse(`${ymd}T12:00:00Z`);
const DAY_MS = 86400000;

const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z-]/g, "")
    .replace(/^(seg|ter|qua|qui|sex|sab|dom)[a-z]*/, "$1");

/** Lista salva → chaves normalizadas ("Sábado-Noite" → "sab-noite"); vazia = sem prioridade */
export function parseSlotPriority(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const keys = raw.map((k) => norm(String(k || ""))).filter((k) => /^(seg|ter|qua|qui|sex|sab|dom)(-(almoco|noite))?$/.test(k));
  return keys.length > 0 ? keys : null;
}

export const slotPeriod = (start: string) => (Number(start.slice(0, 2)) < 16 ? "almoco" : "noite");

/**
 * Quanto mais alto, MENOS vende (oferecer primeiro). Horário fora da lista
 * fica por último (0).
 */
export function offerScore(priority: string[], dow: number, start: string): number {
  const day = DOW_KEYS[dow];
  let idx = priority.indexOf(`${day}-${slotPeriod(start)}`);
  if (idx < 0) idx = priority.indexOf(day);
  return idx < 0 ? 0 : idx + 1;
}

/** Fim de semana na venda: sexta à noite, sábado e domingo */
function isWeekendSlot(dow: number, start: string | null): boolean {
  if (dow === 0 || dow === 6) return true;
  return dow === 5 && (start === null || slotPeriod(start) === "noite");
}

function toDays(slots: FreeSlot[], priority: string[]): FreeDay[] {
  const byDate = new Map<string, FreeDay>();
  for (const f of slots) {
    const day = byDate.get(f.date) || { date: f.date, dow: f.dow, slots: [] };
    if (!day.slots.some((s) => s.start === f.slot.start)) day.slots.push(f.slot);
    byDate.set(f.date, day);
  }
  const worst = (d: FreeDay) => Math.max(...d.slots.map((s) => offerScore(priority, d.dow, s.start)));
  // Horário que menos vende primeiro; dentro do dia, também
  return [...byDate.values()]
    .map((d) => ({ ...d, slots: [...d.slots].sort((a, b) => offerScore(priority, d.dow, b.start) - offerScore(priority, d.dow, a.start) || a.start.localeCompare(b.start)) }))
    .sort((a, b) => worst(b) - worst(a) || a.date.localeCompare(b.date));
}

/**
 * Data pedida ocupada: até `max` datas perto dela (uma semana antes e depois;
 * se não houver, as semanas carregadas), do mesmo tipo (fim de semana ou dia de
 * semana). Uma é a mais parecida com o pedido (no horário pedido e a mais
 * perto); as outras são as que menos vendem.
 */
export function priorityAlternatives(
  free: FreeSlot[],
  askedYmd: string,
  priority: string[],
  opts: { wantStart?: string | null; max?: number } = {},
): FreeDay[] {
  const max = opts.max ?? 3;
  const askedDow = new Date(noon(askedYmd)).getUTCDay();
  const weekendAsk = isWeekendSlot(askedDow, opts.wantStart ?? null);
  const dist = (d: string) => Math.abs(noon(d) - noon(askedYmd)) / DAY_MS;
  const others = free.filter((f) => f.date !== askedYmd);
  const sameKind = others.filter((f) => isWeekendSlot(f.dow, f.slot.start) === weekendAsk);
  const pool0 = sameKind.length > 0 ? sameKind : others;
  const near = pool0.filter((f) => dist(f.date) <= 7);
  const pool = new Set(near.map((f) => f.date)).size >= max ? near : pool0;
  if (pool.length === 0) return [];

  // A mais parecida: no horário pedido (almoço/noite) e o mais perto possível
  // — pediu quarta, pode ser a terça ou a quinta, não precisa ser a outra quarta
  const wantPeriod = opts.wantStart ? slotPeriod(opts.wantStart) : null;
  const likeness = (f: FreeSlot) => (wantPeriod && slotPeriod(f.slot.start) !== wantPeriod ? 1 : 0);
  const closest = [...pool].sort((a, b) => likeness(a) - likeness(b) || dist(a.date) - dist(b.date) || a.date.localeCompare(b.date))[0];

  const byScore = [...pool].sort((a, b) =>
    offerScore(priority, b.dow, b.slot.start) - offerScore(priority, a.dow, a.slot.start) || dist(a.date) - dist(b.date) || a.date.localeCompare(b.date)
  );
  const dates: string[] = [];
  for (const f of byScore) {
    if (dates.length >= max - 1) break;
    if (f.date !== closest.date && !dates.includes(f.date)) dates.push(f.date);
  }
  dates.push(closest.date);
  return toDays(pool.filter((f) => dates.includes(f.date)), priority);
}

/** Datas de um mês (com a preferência do cliente): as que menos vendem primeiro */
export function priorityMonthDates(free: FreeSlot[], preferredDows: number[], priority: string[], max = 3): FreeDay[] {
  const preferred = preferredDows.length > 0 ? free.filter((f) => preferredDows.includes(f.dow)) : [];
  const pool = preferred.length > 0 ? preferred : free;
  const byScore = [...pool].sort((a, b) =>
    offerScore(priority, b.dow, b.slot.start) - offerScore(priority, a.dow, a.slot.start) || a.date.localeCompare(b.date)
  );
  const dates: string[] = [];
  for (const f of byScore) {
    if (dates.length >= max) break;
    if (!dates.includes(f.date)) dates.push(f.date);
  }
  return toDays(pool.filter((f) => dates.includes(f.date)), priority);
}
