import { describe, expect, it } from "vitest";
import { ALL_QUESTIONS, cleanAnswers, prefillFromSettings, questionnaireProgress, QUESTIONNAIRE, sectionProgress } from "../aiQuestionnaire";

describe("questionário da IA", () => {
  it("chaves únicas", () => {
    const keys = ALL_QUESTIONS.map((q) => q.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("progresso conta só as obrigatórias", () => {
    const empty = questionnaireProgress({});
    expect(empty.done).toBe(0);
    expect(empty.total).toBe(ALL_QUESTIONS.filter((q) => !q.optional).length);
    const some = questionnaireProgress({ tom: "Simpático e equilibrado", passar_equipe: ["Fornecedores e parcerias"], mais_alguma: "x" });
    expect(some.done).toBe(2);
    const tom = QUESTIONNAIRE.find((s) => s.id === "tom")!;
    expect(sectionProgress(tom, { tom: "Simpático e equilibrado", emojis: "  " })).toEqual({ done: 1, total: 4 });
  });

  it("sobre o buffet usa as mesmas chaves e opções das abas", () => {
    const rapidas = QUESTIONNAIRE.find((s) => s.id === "rapidas")!;
    expect(rapidas.questions.length).toBe(12);
    expect(rapidas.questions.find((q) => q.key === "degustacao")?.type).toBe("select");
    expect(rapidas.questions.find((q) => q.key === "degustacao_como")?.optional).toBe(true);
    const bebida = rapidas.questions.find((q) => q.key === "bebida_alcoolica")!;
    expect(bebida.type).toBe("select");
    expect(bebida.options?.length).toBeGreaterThan(1);
    expect(ALL_QUESTIONS.find((q) => q.key === "outros")?.optional).toBe(true);
  });

  it("limpa respostas: tira opção inválida, vazio e chave desconhecida", () => {
    expect(cleanAnswers({
      tom: "Inventado",
      emojis: "Nenhum",
      proibido: "  falar mal de concorrente  ",
      passar_equipe: ["Fornecedores e parcerias", "Outra coisa"],
      conversas: "   ",
      hack: "x",
    })).toEqual({ emojis: "Nenhum", proibido: "falar mal de concorrente", passar_equipe: ["Fornecedores e parcerias"] });
  });

  it("puxa os fatos já cadastrados na IA", () => {
    const pre = prefillFromSettings({
      extra_instructions: "Texto antigo solto\nEndereço: Av. General Osório, 1442\nEstacionamento: Vaga própria grátis\nBebida alcoólica: Pode trazer cerveja, sem destilados",
      assistant_name: "Ana Castelo",
      visit_hours: "Segunda a sexta, das 10:00 às 17:00",
      team_hours: null,
    });
    expect(pre.assistente).toBe("Ana Castelo");
    expect(pre.endereco).toBe("Av. General Osório, 1442");
    expect(pre.estacionamento).toBe("Vaga própria grátis");
    // "Outra resposta" escrita pelo buffet fica (Rodrigo, Mega Magic 27/10)
    expect(pre.bebida_alcoolica).toBe("Pode trazer cerveja, sem destilados");
    expect(pre.horarios_visita).toBe("Segunda a sexta, das 10:00 às 17:00");
    expect(pre.outros).toBe("Texto antigo solto");
    expect(prefillFromSettings(null)).toEqual({});
  });
});
