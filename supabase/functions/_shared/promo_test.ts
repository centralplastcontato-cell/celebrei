import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import { findPromotion, partyYearOf, promoCountdown, promoFitsParty, promoMentions, promoNote, promoOffNote } from "./promo.ts";

const CADASTRO = [
  "Regras e o que não fazemos: ... EXCEÇÃO: a promoção vigente descrita em \"Outras informações\" é pública (até 30/12).",
  "PROMOÇÃO MÊS DAS CRIANÇAS (válida até 17/10/2026): para festas realizadas em 2026, quem fechar o contrato até 17/10 ganha 10x sem juros e +10 amiguinhos grátis.",
].join("\n");

Deno.test("findPromotion: prazo, dias que faltam e ano das festas", () => {
  assertEquals(findPromotion(CADASTRO, "2026-10-07"), { title: "PROMOÇÃO MÊS DAS CRIANÇAS", endYmd: "2026-10-17", daysLeft: 10, partyYear: 2026 });
  assertEquals(findPromotion(CADASTRO, "2026-10-17")?.daysLeft, 0);
  assertEquals(findPromotion(CADASTRO, "2026-10-18"), null); // acabou: some sozinha
  assertEquals(findPromotion("Sem promoção nenhuma", "2026-10-07"), null);
  assertEquals(findPromotion(null, "2026-10-07"), null);
});

Deno.test("promoCountdown", () => {
  const p = findPromotion(CADASTRO, "2026-10-07")!;
  assertEquals(promoCountdown(p), "faltam 10 dias");
  assertEquals(promoCountdown({ ...p, daysLeft: 1 }), "termina amanhã");
  assertEquals(promoCountdown({ ...p, daysLeft: 0 }), "termina HOJE");
});

Deno.test("promoMentions e promoNote: oferece, lembra uma vez e para", () => {
  const p = findPromotion(CADASTRO, "2026-10-07")!;
  assertEquals(promoMentions(["Olha os valores 🥳", "Fechando até 17 de outubro você ganha 10x sem juros 🎁"], p), 1);
  assertEquals(promoMentions(["Oi!"], p), 0);
  assertEquals(promoNote(p, 0).includes("Na PRIMEIRA vez que passar valores"), true);
  assertEquals(promoNote(p, 0).includes("sábado, 17 de outubro"), true);
  assertEquals(promoNote(p, 0).includes("Só para festas em 2026"), true);
  assertEquals(promoNote(p, 1).includes("MAIS UMA vez"), true);
  assertEquals(promoNote(p, 2).includes("não fale mais dela"), true);
});

Deno.test("partyYearOf: data exata, mês com ano e mês que já passou = ano que vem", () => {
  assertEquals(partyYearOf("2027-02-17", "Fevereiro", "2026-10-28"), 2027);
  assertEquals(partyYearOf(null, "Fevereiro", "2026-10-28"), 2027);
  assertEquals(partyYearOf(null, "fevereiro/27", "2026-10-28"), 2027);
  assertEquals(partyYearOf(null, "Dezembro", "2026-10-28"), 2026);
  assertEquals(partyYearOf(null, "Outubro", "2026-10-28"), 2026);
  assertEquals(partyYearOf(null, null, "2026-10-28"), null);
});

Deno.test("promoFitsParty: Claudia, festa em 2027, não recebe a promoção de 2026", () => {
  const p = findPromotion(CADASTRO, "2026-10-07")!;
  assertEquals(promoFitsParty(p, 2027), false);
  assertEquals(promoFitsParty(p, 2026), true);
  assertEquals(promoFitsParty(p, null), true); // ano da festa ainda não sabido
  assertEquals(promoFitsParty({ ...p, partyYear: null }, 2027), true); // promoção sem ano
  assertEquals(promoOffNote(p, 2027).includes("NÃO fale dessa promoção"), true);
});

Deno.test("promoção da tela própria (campo \"Promoção:\"): título, prazo e ano da festa", () => {
  const extra = "Promoção: PROMOÇÃO BLACK FRIDAY (válida para contratos fechados até 30/11/2026, para festas realizadas em 2026): 10 convidados a mais.\nEndereço: Rua X, 1";
  const p = findPromotion(extra, "2026-11-20");
  assertEquals(p?.title, "PROMOÇÃO BLACK FRIDAY");
  assertEquals(p?.endYmd, "2026-11-30");
  assertEquals(p?.daysLeft, 10);
  assertEquals(p?.partyYear, 2026);
  assertEquals(findPromotion(extra, "2026-12-01"), null);
});
