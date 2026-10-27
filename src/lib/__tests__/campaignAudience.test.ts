import { describe, it, expect } from "vitest";
import { phoneTail, prepareAudience, uniqueByPhone, sendDays } from "../campaignAudience";

const lead = (id: string, whatsapp: string, status = "novo", source: "crm" | "base" = "crm") => ({
  id,
  whatsapp,
  status,
  source,
});

const none = { optoutTails: new Set<string>(), recentTails: new Set<string>(), includeClosed: false, includeRecent: false };

describe("phoneTail", () => {
  it("pega os últimos 8 dígitos, com ou sem 55 e máscara", () => {
    expect(phoneTail("(15) 99111-2222")).toBe("91112222");
    expect(phoneTail("5515991112222")).toBe("91112222");
    expect(phoneTail("15 9111-2222")).toBe("91112222");
  });
  it("vazio se não tiver 8 dígitos", () => {
    expect(phoneTail("123")).toBe("");
    expect(phoneTail(null)).toBe("");
  });
});

describe("prepareAudience", () => {
  it("esconde fechados, perdidos e não clientes", () => {
    const { available, hidden } = prepareAudience(
      [lead("1", "11911110001", "novo"), lead("2", "11911110002", "fechado"), lead("3", "11911110003", "trabalhe_conosco")],
      none,
    );
    expect(available.map((l) => l.id)).toEqual(["1"]);
    expect(hidden.closed).toBe(2);
  });

  it("mostra fechados quando a pessoa pede", () => {
    const { available } = prepareAudience([lead("1", "11911110001", "fechado")], { ...none, includeClosed: true });
    expect(available).toHaveLength(1);
  });

  it("quem pediu para sair nunca aparece", () => {
    const { available, hidden } = prepareAudience([lead("1", "5511911110001", "fechado")], {
      ...none,
      includeClosed: true,
      includeRecent: true,
      optoutTails: new Set(["11110001"]),
    });
    expect(available).toHaveLength(0);
    expect(hidden.optout).toBe(1);
  });

  it("esconde quem recebeu campanha há pouco, a não ser que peça", () => {
    const leads = [lead("1", "11911110001"), lead("2", "11911110002")];
    const recentTails = new Set(["11110002"]);
    expect(prepareAudience(leads, { ...none, recentTails }).available.map((l) => l.id)).toEqual(["1"]);
    expect(prepareAudience(leads, { ...none, recentTails, includeRecent: true }).available).toHaveLength(2);
  });

  it("telefone repetido: fica um só, o do CRM", () => {
    const { available, hidden } = prepareAudience(
      [lead("base_9", "(11) 91111-0001", "novo", "base"), lead("1", "5511911110001", "em_contato")],
      none,
    );
    expect(available.map((l) => l.id)).toEqual(["1"]);
    expect(hidden.duplicate).toBe(1);
  });

  it("repetido de um fechado também sai (a pessoa já é cliente)", () => {
    const { available, hidden } = prepareAudience(
      [lead("1", "11911110001", "fechado"), lead("base_1", "11911110001", "novo", "base")],
      none,
    );
    expect(available).toHaveLength(0);
    expect(hidden).toMatchObject({ closed: 1, duplicate: 1 });
  });

  it("telefone inválido sai", () => {
    const { available, hidden } = prepareAudience([lead("1", "123")], none);
    expect(available).toHaveLength(0);
    expect(hidden.invalid).toBe(1);
  });
});

describe("uniqueByPhone", () => {
  it("um por telefone, mantendo o primeiro", () => {
    const out = uniqueByPhone([lead("a", "11911110001"), lead("b", "5511911110001"), lead("c", "x"), lead("d", "11911110002")]);
    expect(out.map((l) => l.id)).toEqual(["a", "d"]);
  });
});

describe("sendDays", () => {
  it("arredonda para cima", () => {
    expect(sendDays(0, 50)).toBe(0);
    expect(sendDays(50, 50)).toBe(1);
    expect(sendDays(51, 50)).toBe(2);
    expect(sendDays(1200, 50)).toBe(24);
  });
});

describe("prepareAudience: festa marcada, conversa em andamento e filtro de situação", () => {
  const base = { optoutTails: new Set<string>(), recentTails: new Set<string>(), includeClosed: false, includeRecent: false };
  const leads = [
    { id: "a", whatsapp: "15999990001", status: "novo", source: "crm" as const },
    { id: "b", whatsapp: "15999990002", status: "orcamento_enviado", source: "crm" as const },
    { id: "c", whatsapp: "15999990003", status: "perdido", source: "crm" as const },
    { id: "d", whatsapp: "15999990004", status: "fechado", source: "crm" as const },
  ];

  it("quem tem festa marcada nunca entra; quem está conversando entra só se pedir", () => {
    const opts = { ...base, partyLeadIds: new Set(["a"]), chatTails: new Set(["99990002"]) };
    const r = prepareAudience(leads, opts);
    expect(r.available.map((l) => l.id)).toEqual([]);
    expect(r.hidden.party).toBe(1);
    expect(r.hidden.chatting).toBe(1);
    expect(prepareAudience(leads, { ...opts, includeChatting: true }).available.map((l) => l.id)).toEqual(["b"]);
  });

  it("festa marcada vale pelo telefone: outro cadastro da mesma cliente também fica de fora", () => {
    const dupLeads = [
      { id: "z", whatsapp: "5515999990001", status: "novo", source: "crm" as const }, // repetido, sem festa, vem antes
      ...leads,
    ];
    const r = prepareAudience(dupLeads, { ...base, partyLeadIds: new Set(["a"]) });
    expect(r.available.map((l) => l.id)).toEqual(["b"]);
    expect(r.hidden.party).toBe(1);
  });

  it("escolher Perdido no filtro traz os perdidos, mas não os fechados", () => {
    const r = prepareAudience(leads, { ...base, chosenStatuses: ["perdido"] });
    expect(r.available.map((l) => l.id)).toEqual(["a", "b", "c"]);
  });
});
