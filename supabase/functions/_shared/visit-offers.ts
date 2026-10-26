// Horários de visita livres de verdade (janelas de visita da IA, tirando as
// visitas já marcadas e o recesso), para as mensagens automáticas oferecerem
// só o que existe na agenda.
//
// Daiane (Castelo, 26/10): o follow-up não recebia a agenda e inventou
// "quarta à noite ou quinta à noite" — as visitas vão até 17h na semana.

import { listAvailableSlots, normalizeTime, parseVisitHours, pickTwoOffers, type Slot, slotKey, weekdayOf } from "./business-hours.ts";
import { isClosedDay, parseClosedPeriods } from "./closed-periods.ts";
import { friendlyVisitSlot } from "./ai-turn.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

export async function freeVisitSlots(supabase: Db, companyId: string, ai: Record<string, unknown>, nowMs: number, todayYmd: string): Promise<Slot[]> {
  const { data: booked } = await supabase.from("lead_visits").select("data_visita, horario_visita")
    .eq("company_id", companyId).gte("data_visita", todayYmd).in("status_visita", ["agendada", "confirmada", "remarcada"]).limit(1000);
  const keys = new Set<string>();
  for (const b of (booked || []) as Array<{ data_visita: string; horario_visita: string | null }>) {
    const t = normalizeTime(b.horario_visita || "");
    if (t) keys.add(slotKey({ date: String(b.data_visita).slice(0, 10), time: t }));
  }
  const closed = parseClosedPeriods(ai.closed_periods);
  return listAvailableSlots(parseVisitHours((ai.visit_hours as string | null) ?? null), nowMs, keys, { days: 14, minLeadMinutes: 120, max: 60 })
    .filter((sl) => !isClosedDay(sl.date, closed));
}

/**
 * Opções para a mensagem automática: os 2 de sempre e, se nenhum deles cair
 * no fim de semana, o primeiro horário de sábado (quem trabalha na semana).
 */
export function visitOptions(free: Slot[]): Slot[] {
  const two = pickTwoOffers(free);
  const weekend = (s: Slot) => [0, 6].includes(weekdayOf(s.date));
  if (two.some(weekend)) return two;
  const sat = free.find(weekend);
  return sat ? [...two, sat] : two;
}

export const friendlyOffers = (slots: Slot[], todayYmd: string): string[] => slots.map((s) => friendlyVisitSlot(s, todayYmd));
