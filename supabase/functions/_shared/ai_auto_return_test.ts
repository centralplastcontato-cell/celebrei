import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import { AUTO_RETURN_AFTER_MS, type AutoReturnFacts, autoReturnBlocker } from "./ai-auto-return.ts";

const H = 3600000;
const NOW = Date.parse("2026-11-05T15:00:00Z");
const TEAM_AT = NOW - 25 * H;

function facts(over: Partial<AutoReturnFacts> = {}): AutoReturnFacts {
  return {
    nowMs: NOW,
    lastMessageAtMs: TEAM_AT,
    messages: [
      { atMs: TEAM_AT - 3 * H, fromMe: true, byTeam: false, text: "Olha os nossos pacotes 🥳" },
      { atMs: TEAM_AT - 2 * H, fromMe: false, byTeam: false, text: "Tem estacionamento?" },
      { atMs: TEAM_AT, fromMe: true, byTeam: true, text: "Temos sim, gratuito para os convidados 😊" },
    ],
    leadStatus: "orcamento_enviado",
    returnPending: false,
    hasVisit: false,
    handoffReason: null,
    handoffSubject: null,
    partyYmd: "2027-03-20",
    todayYmd: "2026-11-05",
    alreadyAutoReturned: false,
    ...over,
  };
}

Deno.test("autoReturnBlocker: equipe respondeu uma dúvida e sumiu 24 h → volta", () => {
  assertEquals(autoReturnBlocker(facts()), null);
  assertEquals(autoReturnBlocker(facts({ leadStatus: "novo" })), null);
});

Deno.test("autoReturnBlocker: antes de 24 h, cliente esperando ou última não é da equipe → fica", () => {
  const recent = NOW - AUTO_RETURN_AFTER_MS + H;
  assertEquals(autoReturnBlocker(facts({ lastMessageAtMs: recent })), "menos de 24 h");
  const waiting = facts();
  waiting.messages = [...waiting.messages, { atMs: TEAM_AT + H, fromMe: false, byTeam: false, text: "E o valor?" }];
  assertEquals(autoReturnBlocker(waiting), "cliente falou por último");
  const aiLast = facts();
  aiLast.messages = aiLast.messages.slice(0, 2).concat({ atMs: TEAM_AT, fromMe: true, byTeam: false, text: "Um atendente vai seguir com você 😊" });
  assertEquals(autoReturnBlocker(aiLast), "a última mensagem não é da equipe");
});

Deno.test("autoReturnBlocker: negociação, visita, fechado e afins ficam com a equipe", () => {
  for (const status of ["em_contato", "aguardando_resposta", "fechado", "perdido", "transferido", "trabalhe_conosco", "fornecedor", "cliente_retorno", "outros"]) {
    assertEquals(autoReturnBlocker(facts({ leadStatus: status })), `lead em ${status}`);
  }
  assertEquals(autoReturnBlocker(facts({ leadStatus: null })), "sem lead");
  assertEquals(autoReturnBlocker(facts({ hasVisit: true })), "tem visita");
  assertEquals(autoReturnBlocker(facts({ returnPending: true })), "cliente combinou data para retomar");
  assertEquals(autoReturnBlocker(facts({ handoffReason: "Cliente quer combinar degustação e condições de fechamento" })), "motivo da passagem é da equipe");
  assertEquals(autoReturnBlocker(facts({ handoffSubject: "trabalhar" })), "passagem por trabalhar");
  assertEquals(autoReturnBlocker(facts({ partyYmd: "2026-10-01" })), "data da festa já passou");
  assertEquals(autoReturnBlocker(facts({ alreadyAutoReturned: true })), "já voltou sozinha uma vez");
});

Deno.test("autoReturnBlocker: o que a equipe e o cliente escreveram decide", () => {
  const nego = facts();
  nego.messages[2] = { ...nego.messages[2], text: "Consigo um desconto de 5% no pix 😉" };
  assertEquals(autoReturnBlocker(nego), "conversa sobre negociação");
  const contrato = facts();
  contrato.messages[1] = { ...contrato.messages[1], text: "Me manda o contrato?" };
  assertEquals(autoReturnBlocker(contrato), "conversa sobre negociação");
  const promise = facts();
  promise.messages[2] = { ...promise.messages[2], text: "Vou verificar com a gerente e te retorno!" };
  assertEquals(autoReturnBlocker(promise), "a equipe ficou de retornar");
  // Negociação antes da última mensagem da IA não conta (a IA já seguiu a conversa)
  const old = facts();
  old.messages = [{ atMs: TEAM_AT - 10 * H, fromMe: false, byTeam: false, text: "tem desconto?" }, ...old.messages];
  assertEquals(autoReturnBlocker(old), null);
});

Deno.test("autoReturnBlocker: conversa assumida antes da regra não volta", () => {
  const before = Date.parse("2026-10-20T12:00:00Z");
  const f = facts({ nowMs: before + 30 * H, lastMessageAtMs: before });
  f.messages = f.messages.map((m, i) => ({ ...m, atMs: before - (2 - i) * H }));
  assertEquals(autoReturnBlocker(f), "assumida antes da regra");
});
