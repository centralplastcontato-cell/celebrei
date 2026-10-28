import { describe, expect, it } from "vitest";
import { summarizeHubAiUsage } from "../hubAiUsage";

describe("consumo de IA no Hub", () => {
  it("soma as conversas do WhatsApp (ai_agent_usage) com as outras funções (ai_usage_logs)", () => {
    const s = summarizeHubAiUsage(
      [
        { company_id: "castelo", model: "gpt-5.4-2026-03-05", provider: "openai", kind: "chat", cost_usd: "0.30", is_test: false, conversation_id: "c1", created_at: "2026-10-27T10:00:00Z" },
        { company_id: "castelo", model: "gpt-5.4-2026-03-05", provider: "openai", kind: "chat", cost_usd: 0.2, is_test: false, conversation_id: "c1", created_at: "2026-10-27T11:00:00Z" },
        { company_id: "castelo", model: "claude-sonnet-5-5", provider: "anthropic", kind: "chat", cost_usd: 0.5, is_test: false, conversation_id: "c2", created_at: "2026-10-28T10:00:00Z" },
        { company_id: "castelo", model: "claude-sonnet-5-5", provider: "anthropic", kind: "chat", cost_usd: 0.1, is_test: true, conversation_id: "t1", created_at: "2026-10-28T09:00:00Z" },
        { company_id: "castelo", model: "gpt-4o-mini-transcribe", provider: "openai", kind: "transcription", cost_usd: 0.01, is_test: false, conversation_id: "c2", created_at: "2026-10-28T10:01:00Z" },
      ],
      [{ company_id: "castelo", function_name: "campaign-image", model: "gpt-image-1.5", estimated_cost_usd: 0.07, created_at: "2026-10-28T00:47:00Z" }],
    );
    expect(s.whatsappUsd).toBeCloseTo(1.11);
    expect(s.otherUsd).toBeCloseTo(0.07);
    expect(s.totalUsd).toBeCloseTo(1.18);
    expect(s.conversations).toBe(2); // número de teste não conta
    expect(s.byCompany.castelo.lastAt).toBe("2026-10-28T10:01:00Z");
    expect(s.byProvider.anthropic).toBeCloseTo(0.6);
    expect(s.byModel[0]).toMatchObject({ model: "claude-sonnet-5-5", calls: 2 });
    expect(s.byModel.find((m) => m.model === "gpt-5.4")?.calls).toBe(2); // sem a data da versão
    expect(s.byFeature[0].name).toBe("Atendimento WhatsApp");
    expect(s.byFeature.some((f) => f.name === "Artes de campanha")).toBe(true);
  });
});
