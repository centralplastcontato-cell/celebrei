import { describe, expect, it } from "vitest";
import { senderDot, senderTag } from "../messageSender";

describe("senderTag", () => {
  it("etiqueta as automações e nada mais", () => {
    expect(senderTag({ from_me: true, metadata: { source: "scheduled_return" } })).toBe("🔁 Retorno combinado");
    expect(senderTag({ from_me: true, metadata: { source: "auto_reminder", type: "follow_up_1" } })).toBe("⏰ Lembrete automático");
    expect(senderTag({ from_me: true, metadata: { source: "visit_confirmation" } })).toBe("✅ Confirmação de visita");
    expect(senderTag({ from_me: true, metadata: { source: "form_auto", form_type: "cardapio" } })).toBe("🍽️ Cardápio automático");
    expect(senderTag({ from_me: true, metadata: { source: "form_auto", form_type: "avaliacao" } })).toBe("⭐ Avaliação automática");
    expect(senderTag({ from_me: true, metadata: { source: "form_auto", form_type: "prefesta" } })).toBe("🎉 Pré-festa automático");
    expect(senderTag({ from_me: true, metadata: { source: "ai_agent" } })).toBeNull();
    expect(senderTag({ from_me: true, metadata: { source: "platform" } })).toBeNull();
    expect(senderTag({ from_me: false, metadata: { source: "scheduled_return" } })).toBeNull();
    expect(senderTag({ from_me: true, metadata: null })).toBeNull();
  });
});

describe("senderDot", () => {
  it("marca equipe, IA e celular; robô e cliente sem bolinha", () => {
    expect(senderDot({ from_me: true, metadata: { source: "platform" } })?.className).toBe("bg-yellow-400");
    expect(senderDot({ from_me: true, metadata: { source: "ai_agent" } })?.className).toBe("bg-purple-500");
    expect(senderDot({ from_me: true, metadata: { source: "bia" } })?.className).toBe("bg-purple-500");
    expect(senderDot({ from_me: true, metadata: { source: "phone" } })?.title).toBe("Enviado pelo celular do buffet");
    expect(senderDot({ from_me: true, metadata: { source: "auto_reminder", type: "follow_up_1" } })).toBeNull();
    expect(senderDot({ from_me: true, metadata: null })).toBeNull();
    expect(senderDot({ from_me: false, metadata: { source: "platform" } })).toBeNull();
  });
});
