import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import { offerScore, parseSlotPriority, priorityAlternatives, priorityMonthDates } from "./slot-priority.ts";
import type { FreeSlot } from "./party-availability.ts";

// Castelo (28/10): do que mais vende para o que menos vende
const CASTELO = parseSlotPriority(["Sábado-Noite", "sab-almoco", "sex-noite", "dom-almoco", "dom-noite", "qui", "qua", "ter", "seg"])!;
const L = { start: "13:00", end: "17:00" };
const N = { start: "19:00", end: "23:00" };
const dowOf = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const fs = (date: string, ...slots: Array<typeof L>): FreeSlot[] => slots.map((slot) => ({ date, dow: dowOf(date), slot }));
const show = (days: Array<{ date: string; slots: Array<{ start: string }> }>) => days.map((d) => `${d.date} ${d.slots.map((s) => s.start).join("+")}`);

Deno.test("lista do buffet: nomes com acento e dia sem horário", () => {
  assertEquals(CASTELO[0], "sab-noite");
  assertEquals(offerScore(CASTELO, 1, "13:00") > offerScore(CASTELO, 0, "19:00"), true); // segunda vende menos que domingo à noite
  assertEquals(offerScore(CASTELO, 0, "19:00") > offerScore(CASTELO, 0, "13:00"), true); // domingo noite < domingo almoço
  assertEquals(offerScore(CASTELO, 5, "13:00"), 0); // sexta almoço não está na lista: por último
  assertEquals(parseSlotPriority([]), null);
  assertEquals(parseSlotPriority("x"), null);
});

Deno.test("sábado 28/11 à tarde ocupado (caso do Marcio): domingos à noite primeiro + o sábado à tarde mais perto", () => {
  const free = [
    ...fs("2026-11-21", L, N), ...fs("2026-11-22", N), ...fs("2026-11-29", N),
    ...fs("2026-11-25", L), // quarta: não entra num pedido de fim de semana
    ...fs("2026-12-05", L, N), ...fs("2026-12-06", L, N),
  ];
  assertEquals(show(priorityAlternatives(free, "2026-11-28", CASTELO, { wantStart: "13:00" })), [
    "2026-11-22 19:00",
    "2026-11-29 19:00",
    "2026-11-21 13:00+19:00",
  ]);
});

Deno.test("quarta ocupada: terça/quinta da mesma semana, não a outra quarta; segundas primeiro", () => {
  const free = [
    ...fs("2026-11-16", L), ...fs("2026-11-17", L), ...fs("2026-11-19", L), ...fs("2026-11-23", L), ...fs("2026-11-25", L),
    ...fs("2026-11-21", L, N), // sábado: não entra num pedido de dia de semana
  ];
  assertEquals(show(priorityAlternatives(free, "2026-11-18", CASTELO, { wantStart: "13:00" })), [
    "2026-11-16 13:00",
    "2026-11-23 13:00",
    "2026-11-17 13:00",
  ]);
});

Deno.test("mês com preferência de fim de semana: domingo à noite, depois domingo almoço…", () => {
  const free = [...fs("2026-11-07", L, N), ...fs("2026-11-08", N), ...fs("2026-11-15", L, N), ...fs("2026-11-21", L, N), ...fs("2026-11-22", N)];
  assertEquals(show(priorityMonthDates(free, [6, 0], CASTELO, 3)), [
    "2026-11-08 19:00",
    "2026-11-15 19:00+13:00",
    "2026-11-22 19:00",
  ]);
});
