import { describe, expect, it } from "vitest";
import { parsePromotion, promotionDaysLeft, serializePromotion } from "../aiPromotion";

describe("promoção do buffet", () => {
  const form = { nome: "Black Friday", beneficio: "10 convidados a mais no pacote.", ate: "2026-11-30", anoFesta: "2026", regras: "Só sextas e domingos." };

  it("vira a linha que a IA entende (título, prazo e ano da festa)", () => {
    expect(serializePromotion(form)).toBe("PROMOÇÃO BLACK FRIDAY (válida para contratos fechados até 30/11/2026, para festas realizadas em 2026): 10 convidados a mais no pacote. Regras: Só sextas e domingos.");
  });

  it("volta para o formulário sem perder nada", () => {
    expect(parsePromotion(serializePromotion(form))).toEqual(form);
    const semAno = { ...form, anoFesta: "", regras: "" };
    expect(parsePromotion(serializePromotion(semAno))).toEqual(semAno);
  });

  it("sem nome, benefício ou prazo não salva promoção", () => {
    expect(serializePromotion({ ...form, ate: "" })).toBe("");
    expect(serializePromotion({ ...form, beneficio: " " })).toBe("");
  });

  it("dias que faltam", () => {
    expect(promotionDaysLeft("2026-11-30", new Date("2026-11-20T15:00:00Z"))).toBe(10);
    expect(promotionDaysLeft("2026-11-30", new Date("2026-11-30T15:00:00Z"))).toBe(0);
  });
});

describe("ideias de promoção", () => {
  it("preenche nome, benefício e regras e mantém a data escolhida", async () => {
    const { PROMOTION_IDEAS, ideaToForm } = await import("../aiPromotion");
    const bf = PROMOTION_IDEAS.find((i) => i.nome === "Black Friday")!;
    const f = ideaToForm(bf, { nome: "", beneficio: "", ate: "2026-11-30", anoFesta: "", regras: "" });
    expect(f.nome).toBe("Black Friday");
    expect(f.ate).toBe("2026-11-30");
    const next = PROMOTION_IDEAS.find((i) => i.nextYear)!;
    expect(ideaToForm(next, { nome: "", beneficio: "", ate: "", anoFesta: "", regras: "" }, new Date("2026-10-30T12:00:00Z")).anoFesta).toBe("2027");
  });
});
