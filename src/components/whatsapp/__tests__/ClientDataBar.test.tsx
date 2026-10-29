import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/lib/clientDataRequest", async (orig) => {
  const real = await orig<typeof import("@/lib/clientDataRequest")>();
  return {
    ...real,
    latestClientDataByLead: vi.fn(async () => new Map([["lead-1", {
      id: "r1", token: "BPBZCF9", status: "completed", sent_at: "2026-10-20T23:52:00Z", completed_at: "2026-10-21T00:00:00Z",
      client_data: {
        nome: "Victor Costa", cpf: "323.243.778-88", nascimento: "1985-03-06", email: "a@b.com",
        endereco: "Rua Tobias Avino", numero: "491", bairro: "Central Parque", cidade: "Sorocaba", estado: "SP", cep: "18051-120",
        birthday_children: [{ name: "Murilo", age: "15", birthdate: "2013-07-04" }],
        responsaveis: [{ name: "Ana", phone: "15981007979", relation: "mãe" }],
      },
    }], ["lead-2", {
      id: "r2", token: "K7M2QX9", status: "completed", sent_at: "2026-04-20T23:52:00Z", completed_at: "2026-04-21T00:00:00Z",
      client_data: { nome: "Patrícia" }, event_id: "ev-old", event_date: "2026-05-01",
    }]])),
  };
});

import { ClientDataBar } from "../ClientDataBar";

describe("ClientDataBar", () => {
  it("mostra Dados recebidos e abre os dados formatados", async () => {
    render(<ClientDataBar companyId="c" companyName="Castelo" lead={{ id: "lead-1", name: "Victor", status: "fechado" }} sendText={async () => {}} />);
    await waitFor(() => expect(screen.getByText("✅ Dados recebidos")).toBeTruthy());
    fireEvent.click(screen.getByText("Ver dados"));
    await waitFor(() => expect(screen.getByText("06/03/1985")).toBeTruthy());
    expect(screen.getByText("15 anos · 04/07/2013")).toBeTruthy();
    expect(screen.getByText("(15) 98100-7979")).toBeTruthy();
    expect(screen.getByText("Copiar todos os dados")).toBeTruthy();
  });

  it("cliente que voltou: dados da festa que já passou e botão para pedir os da nova festa", async () => {
    render(<ClientDataBar companyId="c" companyName="Castelo" lead={{ id: "lead-2", name: "Patrícia", status: "fechado" }} sendText={async () => {}} />);
    await waitFor(() => expect(screen.getByText("Pedir dados da nova festa")).toBeTruthy());
    expect(screen.getByText(/festa de 01\/05\/2026/)).toBeTruthy();
    expect(screen.getByText("Ver dados")).toBeTruthy();
  });
});
