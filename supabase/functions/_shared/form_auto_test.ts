import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import { formAutoDue, formAutoLink, partyEndMs, partyStartMs, pickCardapioTemplate, prefestaDue } from "./form-auto.ts";

const CASTELO = [
  { id: "c", name: "Cardápio Festa Castelo", slug: "cardapio-festa-castelo" },
  { id: "s", name: "Cardápio Festa Super", slug: "cardapio-festa-super" },
  { id: "p", name: "Cardápio Festa Premium", slug: "cardapio-festa-premium" },
];
const BUFFET = "Castelo da Diversão";

Deno.test("pickCardapioTemplate: cada pacote do Castelo no seu cardápio", () => {
  assertEquals(pickCardapioTemplate(CASTELO, "CASTELO", BUFFET)?.id, "c");
  assertEquals(pickCardapioTemplate(CASTELO, "SUPER CASTELO", BUFFET)?.id, "s");
  assertEquals(pickCardapioTemplate(CASTELO, "CASTELO PREMIUM", BUFFET)?.id, "p");
});

Deno.test("pickCardapioTemplate: sem pacote ou pacote sem cardápio não manda", () => {
  assertEquals(pickCardapioTemplate(CASTELO, null, BUFFET), null);
  assertEquals(pickCardapioTemplate(CASTELO, "Sem pacote", BUFFET), null);
  assertEquals(pickCardapioTemplate(CASTELO, "FORMATURA", BUFFET), null);
  assertEquals(pickCardapioTemplate(CASTELO, "ESCOLAR", BUFFET), null);
  assertEquals(pickCardapioTemplate([], "CASTELO", BUFFET), null);
});

Deno.test("formAutoLink: domínio do buffet, caminho público e a festa", () => {
  assertEquals(
    formAutoLink("cardapio", { customDomain: "https://www.castelodadiversao.com.br/", companySlug: "castelo-da-diversao", templateId: "c", templateSlug: "cardapio-festa-castelo", eventId: "ev1" }),
    "www.castelodadiversao.com.br/cardapio/castelo-da-diversao/cardapio-festa-castelo?event_id=ev1",
  );
  assertEquals(formAutoLink("avaliacao", { customDomain: null, companySlug: null, templateId: "t9", eventId: "ev2" }), "hubcelebrei.com.br/avaliacao/t9?event_id=ev2");
});

Deno.test("partyEndMs: fim cadastrado, virada da noite, sem fim e sem horário", () => {
  assertEquals(new Date(partyEndMs("2026-11-07", "13:00", "17:00")).toISOString(), "2026-11-07T20:00:00.000Z");
  assertEquals(new Date(partyEndMs("2026-11-07", "19:00", "00:00")).toISOString(), "2026-11-08T03:00:00.000Z");
  assertEquals(new Date(partyEndMs("2026-11-07", "19:00:00", null)).toISOString(), "2026-11-08T02:00:00.000Z");
  assertEquals(new Date(partyEndMs("2026-11-07", null, null)).toISOString(), "2026-11-08T02:00:00.000Z");
});

Deno.test("formAutoDue: espera o tempo, não pega o que é de antes de ligar nem o muito atrasado", () => {
  const ref = Date.parse("2026-10-27T13:00:00Z");
  assertEquals(formAutoDue("cardapio", ref, 20, null, ref + 19 * 60000), false);
  assertEquals(formAutoDue("cardapio", ref, 20, null, ref + 21 * 60000), true);
  assertEquals(formAutoDue("cardapio", ref, 20, ref + 1, ref + 21 * 60000), false);
  assertEquals(formAutoDue("cardapio", ref, 20, null, ref + 5 * 86400000), false);
  assertEquals(formAutoDue("avaliacao", ref, 1440, null, ref + 25 * 3600000), true);
});

Deno.test("prefestaDue: X dias antes, só festa que não começou e só depois de ligar", () => {
  const start = partyStartMs("2026-11-14", "19:00");
  assertEquals(new Date(start).toISOString(), "2026-11-14T22:00:00.000Z");
  const week = 7 * 1440;
  assertEquals(prefestaDue(start, week, null, start - 8 * 86400000), false);
  assertEquals(prefestaDue(start, week, null, start - 6 * 86400000), true);
  assertEquals(prefestaDue(start, week, null, start + 60000), false);
  // Ligou ontem, festa daqui a 3 dias: o momento (7 dias antes) foi antes de ligar
  assertEquals(prefestaDue(start, week, start - 4 * 86400000, start - 3 * 86400000), false);
  assertEquals(new Date(partyStartMs("2026-11-14", null)).toISOString(), "2026-11-14T15:00:00.000Z");
});
