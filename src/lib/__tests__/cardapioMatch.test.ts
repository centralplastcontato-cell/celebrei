import { describe, expect, it } from "vitest";
import { filterCardapioTemplatesByPackage, pickCardapioTemplate } from "../cardapioMatch";

const CASTELO = [
  { id: "c", name: "Cardápio Festa Castelo" },
  { id: "s", name: "Cardápio Festa Super" },
  { id: "p", name: "Cardápio Festa Premium" },
];

describe("cardápio do pacote", () => {
  it("cada pacote do Castelo no seu cardápio (pelo nome ou pelo slug do buffet)", () => {
    for (const brand of ["Castelo da Diversão", "castelo-da-diversao"]) {
      expect(pickCardapioTemplate(CASTELO, "CASTELO", brand)?.id).toBe("c");
      expect(pickCardapioTemplate(CASTELO, "SUPER CASTELO", brand)?.id).toBe("s");
      expect(pickCardapioTemplate(CASTELO, "CASTELO PREMIUM", brand)?.id).toBe("p");
    }
  });

  it("pacote sem cardápio: nenhum para enviar; sem pacote a Agenda mostra todos", () => {
    expect(pickCardapioTemplate(CASTELO, "FORMATURA", "castelo-da-diversao")).toBeNull();
    expect(pickCardapioTemplate(CASTELO, null, "castelo-da-diversao")).toBeNull();
    expect(filterCardapioTemplatesByPackage(CASTELO, null)).toHaveLength(3);
    expect(filterCardapioTemplatesByPackage(CASTELO, "ESCOLAR", "castelo-da-diversao")).toHaveLength(0);
  });
});
