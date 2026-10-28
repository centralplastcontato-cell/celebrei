import { describe, expect, it } from "vitest";
import { freeDateLabel, freeWeekendDates, freeWeekendSlots, presetGoal, presetMatches, shortDateBR, upcomingMonths } from "../campaignPresets";

const now = Date.parse("2026-10-24T12:00:00Z");
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString();

describe("campanhas prontas", () => {
  it("datas livres: só quem quer festa no mês escolhido", () => {
    expect(presetMatches("datas_livres", { id: "1", status: "novo", month: "Novembro", source: "base" }, { month: "Novembro" })).toBe(true);
    expect(presetMatches("datas_livres", { id: "1", status: "novo", month: "Dezembro", source: "crm" }, { month: "Novembro" })).toBe(false);
  });

  it("sumiu: orçamento aberto, entre 7 e 120 dias, sem conversa recente", () => {
    const lead = { id: "1", status: "orcamento_enviado", month: null, source: "crm" as const, createdAt: daysAgo(20), tail: "91112222" };
    expect(presetMatches("sumiu", lead, { nowMs: now })).toBe(true);
    expect(presetMatches("sumiu", lead, { nowMs: now, recentChatTails: new Set(["91112222"]) })).toBe(false);
    expect(presetMatches("sumiu", { ...lead, createdAt: daysAgo(3) }, { nowMs: now })).toBe(false);
    expect(presetMatches("sumiu", { ...lead, createdAt: daysAgo(200) }, { nowMs: now })).toBe(false);
    expect(presetMatches("sumiu", { ...lead, status: "fechado" }, { nowMs: now })).toBe(false);
  });

  it("perdidos do último ano e festa do ano que vem", () => {
    expect(presetMatches("perdidos", { id: "1", status: "perdido", month: null, source: "crm", createdAt: daysAgo(100) }, { nowMs: now })).toBe(true);
    expect(presetMatches("perdidos", { id: "1", status: "perdido", month: null, source: "crm", createdAt: daysAgo(500) }, { nowMs: now })).toBe(false);
    expect(presetMatches("ano_que_vem", { id: "a", status: "fechado", month: null, source: "crm" }, { pastPartyLeadIds: new Set(["a"]) })).toBe(true);
    expect(presetMatches("ano_que_vem", { id: "b", status: "fechado", month: null, source: "crm" }, { pastPartyLeadIds: new Set(["a"]) })).toBe(false);
  });

  it("fins de semana livres do mês", () => {
    // Novembro/2026: sábados 7,14,21,28 e domingos 1,8,15,22,29
    const free = freeWeekendDates(2026, 10, new Set(["2026-11-07", "2026-11-08"]), "2026-10-24");
    expect(free[0]).toBe("2026-11-01");
    expect(free.includes("2026-11-07")).toBe(false);
    expect(free.length).toBe(7);
    expect(shortDateBR("2026-11-14")).toBe("14/11 (sáb)");
    expect(presetGoal("datas_livres", { month: "Novembro", freeDates: ["2026-11-14"] })).toContain("14/11 (sáb)");
  });

  it("próximos meses: pula o atual quando falta pouco", () => {
    expect(upcomingMonths("2026-10-24").map((m) => m.name)).toEqual(["Novembro", "Dezembro", "Janeiro"]);
    expect(upcomingMonths("2026-10-05").map((m) => m.name)).toEqual(["Outubro", "Novembro", "Dezembro"]);
    expect(upcomingMonths("2026-12-28")[0]).toEqual({ year: 2027, monthIndex: 0, name: "Janeiro" });
  });
});

describe("datas livres por horário (igual à IA)", () => {
  it("sábado com o almoço reservado e a noite livre continua na lista, marcado", () => {
    const free = new Map<string, string[]>([
      ["2026-11-07", ["almoço", "noite"]],
      ["2026-11-14", ["noite"]],
      ["2026-11-08", []],
      ["2026-11-10", ["almoço", "noite"]], // terça: não entra
    ]);
    const r = freeWeekendSlots(2026, 10, free, 2, "2026-10-27");
    expect(r.dates).toEqual(["2026-11-07", "2026-11-14"]);
    expect(r.partial).toEqual({ "2026-11-14": "noite" });
    expect(freeDateLabel("2026-11-14", r.partial)).toBe("14/11 (sáb, só noite)");
    expect(freeDateLabel("2026-11-07", r.partial)).toBe("07/11 (sáb)");
  });

  it("objetivo da campanha leva o horário quando só parte do dia está livre", () => {
    const goal = presetGoal("datas_livres", { month: "Novembro", freeDates: ["2026-11-14"], partialDates: { "2026-11-14": "noite" } });
    expect(goal).toContain("14/11 (sáb, só noite)");
  });
});
