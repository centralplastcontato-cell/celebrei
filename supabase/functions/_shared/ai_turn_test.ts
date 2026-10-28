import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import { askPartyDayAfterMaterials, needsPartyDay, clientAffirms, clientAskedPrice, closingAfterMaterials, friendlyVisitSlot, hasVisitInvite, visitInviteAfterMaterials, confirmsPartyInterest, crossedWithLastReply, dayPreferenceFrom, debounceMsFor, dropMaterialsBreak, mergeConsecutiveTurns, priceRequestPending, pickLatestIncoming, promisesTeamHandoff, repliesSinceVisitInvite, smallestPackageGuests, splitAroundMaterials, teamRepliedAfter } from "./ai-turn.ts";

Deno.test("pickLatestIncoming: a última mensagem do cliente responde por todas", () => {
  assertEquals(pickLatestIncoming([
    { message_id: "A", timestamp: "2026-10-05T22:10:01Z" },
    { message_id: "C", timestamp: "2026-10-05T22:10:07Z" },
    { message_id: "B", timestamp: "2026-10-05T22:10:04Z" },
  ]), "C");
});

Deno.test("pickLatestIncoming: empate no mesmo segundo tem vencedor único", () => {
  const rows = [
    { message_id: "3EB0AAA", timestamp: "2026-10-05T22:10:07Z" },
    { message_id: "3EB0BBB", timestamp: "2026-10-05T22:10:07Z" },
  ];
  assertEquals(pickLatestIncoming(rows), "3EB0BBB");
  assertEquals(pickLatestIncoming([...rows].reverse()), "3EB0BBB");
});

Deno.test("teamRepliedAfter: só resposta de gente da equipe conta", () => {
  const since = "2026-10-05T22:00:00Z";
  assertEquals(teamRepliedAfter([
    { from_me: true, timestamp: "2026-10-05T21:59:00Z", metadata: { source: "platform" } }, // antes
    { from_me: false, timestamp: "2026-10-05T22:01:00Z", metadata: null }, // cliente
    { from_me: true, timestamp: "2026-10-05T22:02:00Z", metadata: { source: "auto_reminder" } }, // follow-up
  ], since), false);
  assertEquals(teamRepliedAfter([{ from_me: true, timestamp: "2026-10-05T23:30:00Z", metadata: { source: "platform" } }], since), true);
  assertEquals(teamRepliedAfter([{ from_me: true, timestamp: "2026-10-05T22:03:00Z", metadata: null }], since), true); // pelo celular
  // Reativação e confirmação de visita são automáticas, não são a equipe
  assertEquals(teamRepliedAfter([{ from_me: true, timestamp: "2026-10-05T23:30:00Z", metadata: { source: "reactivation_engine" } }], since), false);
  assertEquals(teamRepliedAfter([{ from_me: true, timestamp: "2026-10-05T23:30:00Z", metadata: { source: "visit_confirmation" } }], since), false);
});

Deno.test("mergeConsecutiveTurns: perguntas picadas viram um turno só, contando as pendentes", () => {
  assertEquals(mergeConsecutiveTurns([
    { role: "assistant", content: "Oi! Qual seu nome?" },
    { role: "user", content: "Victor" },
    { role: "assistant", content: "Prazer, Victor!" },
    { role: "user", content: "vocês fazem festa à noite?" },
    { role: "user", content: "tem estacionamento?" },
  ]), {
    merged: [
      { role: "assistant", content: "Oi! Qual seu nome?" },
      { role: "user", content: "Victor" },
      { role: "assistant", content: "Prazer, Victor!" },
      { role: "user", content: "vocês fazem festa à noite?\ntem estacionamento?" },
    ],
    pendingUserMessages: 2,
  });
});

Deno.test("teamRepliedAfter: 'platform' de antes da marcação da IA não conta; celular conta", () => {
  const since = "2026-10-05T22:56:24Z"; // passagem às 19:56
  // resposta da IA antiga, gravada como se fosse do Celebrei
  assertEquals(teamRepliedAfter([{ from_me: true, timestamp: "2026-10-05T22:56:30Z", metadata: { source: "platform", provider: "zapi" } }], since), false);
  // depois da atualização, "platform" é gente da equipe
  assertEquals(teamRepliedAfter([{ from_me: true, timestamp: "2026-10-05T23:30:00Z", metadata: { source: "platform" } }], since), true);
  // pelo celular (sem metadata) sempre foi gente
  assertEquals(teamRepliedAfter([{ from_me: true, timestamp: "2026-10-05T22:58:00Z", metadata: null }], since), true);
});

Deno.test("teamRepliedAfter: mensagem da IA (ai_agent) não conta como equipe", () => {
  assertEquals(teamRepliedAfter([{ from_me: true, timestamp: "2026-10-05T22:03:00Z", metadata: { source: "ai_agent" } }], "2026-10-05T22:00:00Z"), false);
});

Deno.test("repliesSinceVisitInvite: conta respostas desde o último convite", () => {
  const base = [
    { role: "user" as const, content: "oi" },
    { role: "assistant" as const, content: "Oi! Quer agendar uma visita sem compromisso?" },
    { role: "user" as const, content: "tem estacionamento?" },
    { role: "assistant" as const, content: "Tem sim!" },
    { role: "user" as const, content: "e cama elástica?" },
    { role: "assistant" as const, content: "Temos também." },
  ];
  assertEquals(repliesSinceVisitInvite(base), 2);
  assertEquals(repliesSinceVisitInvite(base.slice(0, 2)), 0);
  assertEquals(repliesSinceVisitInvite([{ role: "assistant", content: "🧪 Conversa reiniciada" }, { role: "user", content: "oi" }]), null);
});

Deno.test("smallestPackageGuests: menor pacote com quantidade", () => {
  assertEquals(smallestPackageGuests([
    { type: "pdf_package", guest_count: 80 },
    { type: "pdf_package", guest_count: 50 },
    { type: "pdf_package", guest_count: null },
    { type: "video", guest_count: 10 },
  ]), 50);
  assertEquals(smallestPackageGuests([{ type: "pdf_package", guest_count: null }]), null);
});

Deno.test("debounceMsFor: pergunta/frase longa espera pouco; 'Olá'/'Então' espera mais", () => {
  assertEquals(debounceMsFor("tem estacionamento?"), 5000);
  assertEquals(debounceMsFor("quero fazer a festa do meu filho em dezembro para umas 60 pessoas"), 5000);
  assertEquals(debounceMsFor("", true), 5000); // áudio/foto
  assertEquals(debounceMsFor("Olá"), 16000);
  assertEquals(debounceMsFor("Então"), 16000);
  assertEquals(debounceMsFor("dezembro"), 16000); // uma palavra só
  assertEquals(debounceMsFor("queria saber sobre a festa,"), 16000);
  assertEquals(debounceMsFor("dia 5 de dezembro"), 9000);
  // respondendo pergunta da IA
  assertEquals(debounceMsFor("dezembro", false, true), 5000);
  assertEquals(debounceMsFor("60", false, true), 5000);
  assertEquals(debounceMsFor("Então", false, true), 16000);
});

Deno.test("priceRequestPending: pediu valor no começo e ainda não recebeu", () => {
  assertEquals(priceRequestPending([
    { role: "user", content: "oi, quanto custa uma festa?" },
    { role: "assistant", content: "Oi! Para quantos convidados?" },
    { role: "user", content: "60, dia 26 de dezembro" },
  ]), true);
  assertEquals(priceRequestPending([
    { role: "user", content: "qual o valor?" },
    { role: "assistant", content: "🏰 *Castelo* — R$ 6.890" },
    { role: "user", content: "legal" },
  ]), false);
  assertEquals(priceRequestPending([{ role: "user", content: "tem estacionamento?" }]), false);
});

Deno.test("crossedWithLastReply: mensagem do cliente chegou junto com a resposta", () => {
  // teste de 06/10 12:38: resposta saiu 15:38:08 e o cliente escreveu no mesmo segundo
  assertEquals(crossedWithLastReply([
    { from_me: false, timestamp: "2026-10-06T15:37:54Z" },
    { from_me: true, timestamp: "2026-10-06T15:38:08Z" },
    { from_me: false, timestamp: "2026-10-06T15:38:08Z" },
  ]), true);
  // cliente respondeu 20 s depois: viu a pergunta
  assertEquals(crossedWithLastReply([
    { from_me: true, timestamp: "2026-10-06T15:38:08Z" },
    { from_me: false, timestamp: "2026-10-06T15:38:28Z" },
  ]), false);
});

import { clientAsksVisit, clientDeclined, stripVisitInvite } from "./ai-turn.ts";

Deno.test("stripVisitInvite: tira só o convite (conversas reais do simulador)", () => {
  const a = stripVisitInvite("Aaah, eu entendo, Renata 😕💜\n\nMesmo assim, se você quiser, vale super conhecer sem compromisso, porque muita família se surpreende 🎉🏰\n\nSe fizer sentido pra você, posso deixar uma visitinha na quarta, 7 de outubro às 10h ou na quinta, 8 de outubro às 11h 😊");
  assertEquals(a.removed, true);
  assertEquals(a.text, "Aaah, eu entendo, Renata 😕💜");
  const b = stripVisitInvite("Simone, as condições de pagamento quem confirma é a equipe no fechamento, tá bem? ✨💜\n\nSe você quiser, vale muito a pena conhecer o espaço primeiro — posso te agendar uma visita sem compromisso na quarta às 10h 🏰😊");
  assertEquals(b.text, "Simone, as condições de pagamento quem confirma é a equipe no fechamento, tá bem? ✨💜");
  // sem convite: não mexe
  const c = stripVisitInvite("Perfeito, Patrícia! 🥳 Sua visita ficou agendada para quinta, 8 de outubro, às 11h.");
  assertEquals(c, { text: "Perfeito, Patrícia! 🥳 Sua visita ficou agendada para quinta, 8 de outubro, às 11h.", removed: false });
  // só convite: devolve o original (melhor que mandar vazio)
  assertEquals(stripVisitInvite("Posso te receber na quarta às 10h?").removed, false);
});

Deno.test("clientAsksVisit / clientDeclined", () => {
  assertEquals(clientAsksVisit("pode me passar os horários de visita?"), true);
  assertEquals(clientAsksVisit("no à vista tem desconto?"), false);
  assertEquals(clientDeclined("Nesse caso não vai dar pra fechar então"), true);
  assertEquals(clientDeclined("vou pensar"), false);
});

Deno.test("repliesSinceVisitInvite: convite sem a palavra 'visita' também conta", () => {
  assertEquals(repliesSinceVisitInvite([
    { role: "assistant", content: "Se você quiser conhecer o espaço de pertinho, tenho quarta às 10h 🏰" },
    { role: "user", content: "obrigada" },
  ]), 0);
  assertEquals(clientAsksVisit("qual o horário da festa?"), false);
});

Deno.test("repliesSinceVisitInvite: fotos/vídeo/PDF seguidos contam como uma vez só", () => {
  assertEquals(repliesSinceVisitInvite([
    { role: "assistant", content: "Posso te receber na quarta às 10h? 😊" },
    { role: "user", content: "vou ver" },
    { role: "assistant", content: "Olha só o espaço 😍" },
    { role: "assistant", content: "[image]" },
    { role: "assistant", content: "[image]" },
    { role: "assistant", content: "[video] Conheça o Castelo" },
    { role: "assistant", content: "Já te mandei tudo 🎉" },
    { role: "user", content: "legal" },
  ]), 1);
});

Deno.test("stripVisitInvite: 'conhecendo o espaço de perto' depois da desistência", () => {
  const r = stripVisitInvite("Entendo totalmente, Luana 💜 Obrigada por me contar! Às vezes, conhecendo o espaço de perto, dá pra ver melhor o custo-benefício 🏰");
  assertEquals(r, { text: "Entendo totalmente, Luana 💜 Obrigada por me contar!", removed: true });
});

Deno.test("asksPartnership: permuta/parceria sim, divulgação comum não", async () => {
  const { asksPartnership } = await import("./ai-turn.ts");
  for (const t of [
    "Oi! Sou influenciadora com 50 mil seguidores, toparia fazer a festa em permuta?",
    "vcs fazem parceria com influencer?",
    "faço stories e posts em troca da festa",
    "tenho 30k seguidores e posso divulgar o buffet",
    "Vocês aceitam patrocínio?",
  ]) assertEquals(asksPartnership(t), true, t);
  for (const t of [
    "vi a divulgação de vocês no instagram",
    "quanto fica pra 60 convidados?",
    "posso postar fotos da festa depois?",
    "minha filha é fã de uma influenciadora",
  ]) assertEquals(asksPartnership(t), false, t);
});

Deno.test("contactIntent: quem não quer orçamento", async () => {
  const { contactIntent } = await import("./ai-turn.ts");
  assertEquals(contactIntent("Oi, vocês estão contratando? Queria trabalhar aí"), "trabalhar");
  assertEquals(contactIntent("Boa tarde, gostaria de deixar meu currículo"), "trabalhar");
  assertEquals(contactIntent("Sou representante de uma marca de doces e gostaria de apresentar nossos produtos"), "fornecedor");
  assertEquals(contactIntent("Já fechei a festa com vocês dia 14, queria saber o horário de chegada"), "cliente_com_festa");
  assertEquals(contactIntent("Tenho uma festa marcada aí em novembro"), "cliente_com_festa");
  assertEquals(contactIntent("Tenho uma festa no mês que vem e quero tirar uma dúvida"), "duvida_festa");
  assertEquals(contactIntent("Quanto fica uma festa pra 60 pessoas?"), null);
  assertEquals(contactIntent("Os monitores trabalham até que horas?"), null);
});

Deno.test("confirmsPartyInterest: resposta sobre a festa libera os materiais; oi, foto solta e outros assuntos não", () => {
  for (const t of ["Murilo", "É do meu filho Pedro", "oi, é pro Murilo 🎈", "Quanto custa?", "sim, é pra minha filha", "[Áudio do cliente, transcrito]: é a festa do Murilo"]) {
    assertEquals(confirmsPartyInterest(t), true, t);
  }
  for (const t of ["oi", "Olá, bom dia!", "Oi tudo bem?", "ok", "👍", "?", "Quem é?", "quem fala", "[Foto enviada pelo cliente — o que aparece: print de uma conversa de WhatsApp]", "[O cliente mandou uma foto que não foi possível ver]", "[sticker] ", "Quero trabalhar com vocês", "Sou fornecedor de doces", "Já tenho festa marcada aí"]) {
    assertEquals(confirmsPartyInterest(t), false, t);
  }
  // Foto com legenda sobre a festa conta
  assertEquals(confirmsPartyInterest("[Foto enviada pelo cliente — o que aparece: bolo] Legenda: quero esse tema"), true);
});

Deno.test("splitAroundMaterials: antes das fotos e depois do PDF", () => {
  assertEquals(splitAroundMaterials("Que lindo, Murilo! 🥳\nVou te mostrar o espaço 👇\n---\nE aí, o que achou? 😍"), { before: "Que lindo, Murilo! 🥳\nVou te mostrar o espaço 👇", after: "E aí, o que achou? 😍" });
  assertEquals(splitAroundMaterials("Sem divisão 😊"), { before: "Sem divisão 😊", after: "" });
  assertEquals(splitAroundMaterials("A\n --- \nB\n---\nC"), { before: "A", after: "B\n\nC" });
  assertEquals(dropMaterialsBreak("A\n---\nB"), "A\n\nB");
  assertEquals(dropMaterialsBreak("Sem nada"), "Sem nada");
  assertEquals(closingAfterMaterials("Victor", 0).includes("Victor"), true);
  assertEquals(closingAfterMaterials("", 7).includes(", ,"), false);
});

Deno.test("clientAffirms: aceite curto sim; pergunta ou texto longo não", () => {
  for (const t of ["Ok", "Ótimo", "ótimo!", "Gostei", "Perfeito 😍", "pode ser", "Sim", "👍", "Adorei demais", "Ok obrigado"]) assertEquals(clientAffirms(t), true, t);
  for (const t of ["Ok, mas quanto fica para 80?", "Não gostei", "Qual o valor?", "Gostei do Super Castelo, mas tem como trocar o salgado?", "Murilo"]) assertEquals(clientAffirms(t), false, t);
});

Deno.test("stripVisitInvite: tira a pergunta que dependia do convite cortado", () => {
  const r = stripVisitInvite("Perfeito, Victor! 🥳 Fico feliz que tenha gostado ✨\n\nQue tal vir conhecer o espaço? Tenho quinta às 15h ou sábado às 10h 😍 Qual horário fica melhor pra você? 🎈");
  assertEquals(r.removed, true);
  assertEquals(r.text.includes("Qual horário"), false);
  assertEquals(r.text.startsWith("Perfeito, Victor!"), true);
  // Sem convite cortado, a pergunta fica
  assertEquals(stripVisitInvite("Qual horário da festa você prefere: almoço ou noite? 😊").removed, false);
});

Deno.test("teamRepliedAfter: reação (emoji) da equipe não conta como resposta", () => {
  assertEquals(teamRepliedAfter([
    { from_me: true, timestamp: "2026-10-09T12:00:00Z", metadata: { source: "reaction" } },
  ], "2026-10-09T11:00:00Z"), false);
});

Deno.test("clientAskedPrice: só pergunta de preço conta, \"orçamento\" sozinho não", () => {
  const u = (content: string) => [{ role: "assistant" as const, content: "Oi!" }, { role: "user" as const, content }];
  assertEquals(clientAskedPrice(u("Quero saber o valor pra 50 e 80 pessoas")), true);
  assertEquals(clientAskedPrice(u("Qual opções e valores pacotes 50 pessoas?")), true);
  assertEquals(clientAskedPrice(u("quanto fica pra 60?")), true);
  assertEquals(clientAskedPrice(u("qual o preço?")), true);
  assertEquals(clientAskedPrice(u("Orçamento para a festa")), false);
  assertEquals(clientAskedPrice(u("Queria fazer um orçamento")), false);
  assertEquals(clientAskedPrice(u("1")), false);
  assertEquals(clientAskedPrice(u("Eu amei")), false);
});

Deno.test("visitInviteAfterMaterials: convite com 2 horários livres depois do PDF", () => {
  const today = "2026-10-20"; // terça
  assertEquals(friendlyVisitSlot({ date: "2026-10-21", time: "10:00" }, today), "amanhã às 10h");
  assertEquals(friendlyVisitSlot({ date: "2026-10-22", time: "15:30" }, today), "quinta (22/10) às 15h30");
  assertEquals(friendlyVisitSlot({ date: "2026-10-20", time: "17:00" }, today), "hoje às 17h");
  const offers = [{ date: "2026-10-21", time: "10:00" }, { date: "2026-10-22", time: "15:00" }];
  assertEquals(visitInviteAfterMaterials("Ana", offers, today, 0), "Se fizer sentido pra vocês, Ana, te recebo pra conhecer o espaço: amanhã às 10h ou quinta (22/10) às 15h. Qual fica melhor? 😊");
  assertEquals(visitInviteAfterMaterials("", offers, today, 1)!.includes(", ?"), false);
  assertEquals(visitInviteAfterMaterials("Ana", offers.slice(0, 1), today, 0), null);
  assertEquals(hasVisitInvite(visitInviteAfterMaterials("Ana", offers, today, 0)!), true);
  assertEquals(hasVisitInvite(visitInviteAfterMaterials("Ana", offers, today, 1)!), true);
});

Deno.test("pergunta do dia depois do PDF", () => {
  assertEquals(
    askPartyDayAfterMaterials("Vitor", "Dezembro", 0),
    "Já te mandei tudo pra vocês verem com calma, Vitor 🥳\n\nVocês já têm um dia em mente em dezembro? Assim já confiro aqui na agenda se está livre 😊",
  );
  assertEquals(askPartyDayAfterMaterials("", "abril de 2027", 1).includes("em abril?"), true);
  assertEquals(needsPartyDay({ mes: "Dezembro" }), true);
  assertEquals(needsPartyDay({ mes: "Dezembro", data_festa: "2026-12-12" }), false);
  assertEquals(needsPartyDay({ mes: "Dezembro", dia_perguntado: "2026-10-22T17:00:00Z" }), false);
  assertEquals(needsPartyDay({}), false);
});

Deno.test("dayPreferenceFrom: 'na semana' é dia de semana; 'semana que vem' não conta", () => {
  assertEquals(dayPreferenceFrom("Ok\nNa semana em janeiro\nQuais datas ?"), "dia de semana");
  assertEquals(dayPreferenceFrom("durante a semana"), "dia de semana");
  assertEquals(dayPreferenceFrom("pode ser dia útil"), "dia de semana");
  assertEquals(dayPreferenceFrom("Final de semana"), "fim de semana");
  assertEquals(dayPreferenceFrom("na semana que vem eu vejo"), null);
  assertEquals(dayPreferenceFrom("Ou para segunda semana de janeiro"), null);
  assertEquals(dayPreferenceFrom("dia de semana ou fim de semana?"), null);
  assertEquals(dayPreferenceFrom("Datas livres para 2026 dezembro"), null);
});

Deno.test("promisesTeamHandoff: promessa de a equipe seguir (Claudia, 27/10)", () => {
  assertEquals(promisesTeamHandoff("Desconto é com a equipe 😊 Um atendente vai seguir com você por aqui, combinado?"), true);
  assertEquals(promisesTeamHandoff("Nossa equipe vai continuar o seu atendimento."), true);
  assertEquals(promisesTeamHandoff("Vou passar para a equipe, tá bom?"), true);
  assertEquals(promisesTeamHandoff("Vou pedir para alguém da nossa equipe continuar com você."), true);
  assertEquals(promisesTeamHandoff("A equipe já vai falar com você sobre a degustação."), true);
  // Visita é da IA; equipe que só confirma não é passagem
  assertEquals(promisesTeamHandoff("Na visita, nossa equipe vai te atender e mostrar o espaço!"), false);
  assertEquals(promisesTeamHandoff("As condições de pagamento são com a equipe no fechamento."), false);
  assertEquals(promisesTeamHandoff("Que tal conhecer o espaço? Tenho sábado às 10h."), false);
});
