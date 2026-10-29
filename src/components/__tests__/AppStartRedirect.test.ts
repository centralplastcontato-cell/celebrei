import { describe, expect, it } from "vitest";
import { appStartTarget } from "../AppStartRedirect";

describe("appStartTarget", () => {
  it("app aberto pela tela de Notificações (onde o iPhone guardou o ícone) vai para a Central", () => {
    expect(appStartTarget("/configuracoes", "?item=notifications")).toBe("/atendimento");
    expect(appStartTarget("/configuracoes", "?secao=notifications")).toBe("/atendimento");
    expect(appStartTarget("/", "")).toBe("/atendimento");
  });
  it("links de aviso abrem onde apontam", () => {
    expect(appStartTarget("/configuracoes", "?secao=connection")).toBeNull();
    expect(appStartTarget("/atendimento", "?phone=5515")).toBeNull();
    expect(appStartTarget("/agenda", "")).toBeNull();
  });
});
