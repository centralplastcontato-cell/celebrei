import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AiHandoffReasons } from "../AiHandoffReasons";

const chain = (result: unknown) => {
  const c: Record<string, unknown> = {};
  for (const k of ["select", "eq", "gte", "order", "in", "like"]) c[k] = () => c;
  c.limit = async () => result;
  c.maybeSingle = async () => result;
  c.then = (r: (v: unknown) => unknown) => Promise.resolve(result).then(r);
  return c;
};
const row = (id: string, motivo: string) => ({ id, created_at: "2026-10-17T15:00:00Z", lead_id: "l1", new_value: `Motivo: ${motivo}` });
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: vi.fn() },
    auth: { getUser: async () => ({ data: { user: null } }) },
    from: (t: string) => t === "lead_history"
      ? chain({ data: [
        row("h1", "cliente perguntou se pode levar cachorro"),
        row("h2", "Cliente quer fechar a festa e assinar o contrato"),
        row("h3", "cliente perguntou se tem fraldário"),
        row("h4", "condições de pagamento"),
        row("h5", "data dentro do recesso"),
        row("h6", "cliente perguntou se pode levar bolo de pote"),
      ] })
      : t === "campaign_leads"
      ? chain({ data: [{ id: "l1", name: "Ana" }] })
      : chain({ data: [{ source: "passagem:h3" }] }),
  },
}));

describe("AiHandoffReasons", () => {
  it("mostra 5, separa assunto da equipe e marca o que já foi ensinado", async () => {
    render(<AiHandoffReasons companyId="c" />);
    expect(await screen.findByText("cliente perguntou se pode levar cachorro")).toBeInTheDocument();
    expect(screen.queryByText("cliente perguntou se pode levar bolo de pote")).not.toBeInTheDocument();
    expect(screen.getAllByText("assunto da equipe")).toHaveLength(3); // fechar, pagamento, recesso
    expect(screen.getByText("Ensinado")).toBeInTheDocument(); // fraldário, ensinado em outro aparelho
    expect(screen.getAllByText("Ensinar")).toHaveLength(1);

    fireEvent.click(screen.getByText("Ver todos (6)"));
    expect(screen.getByText("cliente perguntou se pode levar bolo de pote")).toBeInTheDocument();
    expect(screen.getAllByText("Ensinar")).toHaveLength(2);
  });

  it("Ensinar abre o Ensinar a IA com o motivo da passagem", async () => {
    render(<AiHandoffReasons companyId="c" />);
    fireEvent.click((await screen.findAllByText("Ensinar"))[0]);
    expect(await screen.findByText("A IA passou para a equipe porque:")).toBeInTheDocument();
    expect(screen.getAllByText("cliente perguntou se pode levar cachorro").length).toBeGreaterThan(1);
  });
});
