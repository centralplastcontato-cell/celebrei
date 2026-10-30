import { describe, expect, it } from "vitest";
import { buffetInfoProgress } from "../aiBuffetFields";

describe("buffetInfoProgress", () => {
  it("conta só os campos importantes (degustação detalhada e outros são opcionais)", () => {
    const empty = buffetInfoProgress(null);
    expect(empty.filled).toBe(0);
    const some = buffetInfoProgress("Endereço: Rua X\nDuração da festa: 4 horas\nOutras informações: algo");
    expect(some.filled).toBe(2);
    expect(some.total).toBe(empty.total);
  });

  it("diz o nome do que falta (Mega Magic: só a faixa etária)", () => {
    const some = buffetInfoProgress("Endereço: Rua X\nDuração da festa: 4 horas");
    expect(some.missing).toContain("Faixa etária");
    expect(some.missing).not.toContain("Endereço");
    expect(some.missing.length).toBe(some.total - some.filled);
  });
});

describe("sugestões para tocar", () => {
  it("acrescenta e tira itens de lista e frases", async () => {
    const { toggleSuggestion } = await import("../aiBuffetFields");
    expect(toggleSuggestion("", "Cama elástica", ", ")).toBe("Cama elástica");
    expect(toggleSuggestion("Cama elástica", "Fraldário", ", ")).toBe("Cama elástica, Fraldário");
    expect(toggleSuggestion("Cama elástica, Fraldário, Tobogã", "Fraldário", ", ")).toBe("Cama elástica, Tobogã");
    expect(toggleSuggestion("Cama elástica, Fraldário", "Cama elástica", ", ")).toBe("Fraldário");
    expect(toggleSuggestion("Pix", "Boleto.", " ")).toBe("Pix. Boleto.");
    expect(toggleSuggestion("Pix. Boleto. Cartão de crédito.", "Boleto.", " ")).toBe("Pix. Cartão de crédito.");
  });
});
