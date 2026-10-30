import { describe, expect, it } from "vitest";
import { handoffTeachSource, isTeamTopic } from "../aiHandoffTopic";

describe("isTeamTopic", () => {
  it("fechamento, pagamento, degustação, recesso e afins são da equipe", () => {
    for (const r of [
      "Cliente quer fechar festa em 28/08/2027 e saber condições de pagamento: parcelas, entrada e Pix parcelado.",
      "Patrícia quer fechar a festa de 01/05/2027 e assinar o contrato. Quer confirmar disponibilidade da data.",
      "Cliente quer combinar degustação e condições de fechamento.",
      "Cliente quer festa para 50 pessoas em 30/12/2026, data dentro do recesso; insiste nessa data.",
      "proposta de permuta/parceria (a IA não passou sozinha)",
      "Cliente pediu para falar com um atendente",
      "data pedida (sábado, 12 de dezembro) já reservada, sem datas livres por perto — ofereça opções",
    ]) expect(isTeamTopic(r)).toBe(true);
  });
  it("dúvida que a IA não sabia continua ensinável", () => {
    for (const r of [
      "cliente perguntou se pode levar cachorro",
      "Cliente perguntou se tem fraldário e trocador",
      "Quer saber se pode levar bolo de pote de fora",
      "Pergunta se o salão tem gerador",
    ]) expect(isTeamTopic(r)).toBe(false);
  });
  it("marca do ensinamento", () => {
    expect(handoffTeachSource("h1")).toBe("passagem:h1");
  });
});
