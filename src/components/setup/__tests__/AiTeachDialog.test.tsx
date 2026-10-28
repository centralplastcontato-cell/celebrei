import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AiTeachDialog } from "../AiTeachDialog";

const { invoke, insert } = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({
    data: { notes: [{ text: "A decoração NÃO está inclusa no Classic; só no Premium.", kind: "informacao" }], blocked: null, packageHint: true },
    error: null,
  })),
  insert: vi.fn(async () => ({ error: null })),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke },
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: () => ({ insert }),
  },
}));

describe("Ensinar a IA", () => {
  it("corrige uma resposta do teste: organiza, mostra para revisar e só grava ao confirmar", async () => {
    const onSaved = vi.fn();
    render(<AiTeachDialog open onOpenChange={() => {}} companyId="c1" context={{ cliente: "a decoração está inclusa?", resposta: "Está sim!" }} onSaved={onSaved} />);
    expect(screen.getByText("Corrigir esta resposta")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "decoração não vem no classic" } });
    fireEvent.click(screen.getByText("Continuar"));
    await screen.findByDisplayValue("A decoração NÃO está inclusa no Classic; só no Premium.");
    expect(invoke).toHaveBeenCalledWith("ai-teach", { body: expect.objectContaining({ action: "propose", resposta: "Está sim!" }) });
    expect(screen.getByText(/Operações → Pacotes/)).toBeTruthy();
    expect(insert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Ensinar a IA"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(insert).toHaveBeenCalledWith([expect.objectContaining({ company_id: "c1", kind: "informacao", source: "teste" })]);
  });
});
