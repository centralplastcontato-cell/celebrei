import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { CampaignContextStep } from "../CampaignContextStep";
import type { CampaignDraft } from "../CampaignWizard";

vi.mock("@/contexts/CompanyContext", () => ({ useCompany: () => ({ currentCompanyId: "c1", currentCompany: { id: "c1" } }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: vi.fn() }, from: vi.fn() } }));

const base: CampaignDraft = {
  name: "Datas livres em Novembro",
  campaignType: "",
  description: "Avisar quem tem interesse em festa em Novembro...",
  variations: [
    { tone: "profissional", text: "Olá {nome}, aqui é da {empresa}. Temos 21/11 livre." },
    { tone: "curta", text: "Oi {nome}! Sobrou 08/11 à noite." },
  ],
  imageUrl: null,
  selectedLeadIds: [],
  leads: [],
  pauseBotOnReply: true,
  sendMode: "smart",
  sendInstanceId: "",
  autoReplyMessage: "",
  presetId: "datas_livres",
  presetMonth: "Novembro",
};

function Harness() {
  const [draft, setDraft] = useState(base);
  return <CampaignContextStep draft={draft} setDraft={setDraft} companyName="Castelo" />;
}

describe("Nova campanha — passo das mensagens", () => {
  it("esconde o pedido para a IA e mostra uma mensagem por vez, como no WhatsApp", () => {
    render(<Harness />);
    expect(screen.queryByDisplayValue(/Avisar quem tem interesse/)).toBeNull();
    fireEvent.click(screen.getByText("Ver ou ajustar o pedido para a IA"));
    expect(screen.getByDisplayValue(/Avisar quem tem interesse/)).toBeTruthy();

    expect(screen.getByText("Mensagem 1 de 2")).toBeTruthy();
    expect(screen.getByText("Olá Maria, aqui é da Castelo. Temos 21/11 livre.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Próxima mensagem"));
    expect(screen.getByText("Mensagem 2 de 2")).toBeTruthy();
    expect(screen.getByText("Oi Maria! Sobrou 08/11 à noite.")).toBeTruthy();

    fireEvent.click(screen.getByText("Não usar esta"));
    expect(screen.getByText("Mensagem 1 de 1")).toBeTruthy();
  });
});
