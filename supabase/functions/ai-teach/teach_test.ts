import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import { buildTeachPrompt, buildTeachUserMessage, parseTeachProposal } from "./teach.ts";

Deno.test("ensinar: lê as notas, o bloqueio e o aviso de pacote (com texto em volta)", () => {
  const p = parseTeachProposal('Claro! {"notas":[{"texto":"A decoração NÃO está inclusa no Classic.","tipo":"informacao"},{"texto":"x","tipo":"orientacao"}],"bloqueado":null,"pacote":true}');
  assertEquals(p, { notes: [{ text: "A decoração NÃO está inclusa no Classic.", kind: "informacao" }], blocked: null, packageHint: true, visitHint: false });
});

Deno.test("ensinar: pedido de desconto vem bloqueado e sem notas", () => {
  const p = parseTeachProposal('{"notas":[],"bloqueado":"A IA não pode oferecer desconto.","pacote":false}');
  assertEquals(p?.notes.length, 0);
  assertEquals(p?.blocked, "A IA não pode oferecer desconto.");
});

Deno.test("ensinar: resposta sem JSON vira null", () => {
  assertEquals(parseTeachProposal("não entendi"), null);
});

Deno.test("ensinar: o pedido leva o que já foi ensinado e a resposta corrigida", () => {
  assertEquals(buildTeachPrompt("Mega Magic", ["Fale de você"]).includes("- Fale de você"), true);
  const u = buildTeachUserMessage("decoração não vem no classic", { cliente: "a decoração está inclusa?", resposta: "Está sim!" });
  assertEquals(u.includes('Resposta da IA que o dono quer corrigir: "Está sim!"'), true);
});

Deno.test("ensinar: pedido de não marcar visita traz o aviso da configuração", () => {
  const p = parseTeachProposal('{"notas":[{"texto":"Não ofereça horários de visita.","tipo":"orientacao"}],"bloqueado":null,"pacote":false,"visita":true}');
  assertEquals(p?.visitHint, true);
});

Deno.test("ensinar: dúvida de uma passagem para a equipe leva o motivo", () => {
  const msg = buildTeachUserMessage("Pode sim, desde que fique na coleira.", { motivo: "cliente perguntou se pode levar cachorro" });
  assertEquals(msg.includes('Motivo anotado: "cliente perguntou se pode levar cachorro"'), true);
  assertEquals(msg.includes("regra geral"), true);
  assertEquals(msg.includes("Pergunta do cliente no teste"), false);
});
