import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import { parseOgMeta, previewLinkUrl } from "./link-preview.ts";

Deno.test("prévia: acha o link do formulário (com https://) no texto", () => {
  assertEquals(previewLinkUrl("Oi, Vitor! Segue o link:\n\nwww.castelodadiversao.com.br/dados/S7VVHZE"), "https://www.castelodadiversao.com.br/dados/S7VVHZE");
  assertEquals(previewLinkUrl("Avalie: https://buffet.com.br/avaliacao/castelo/festa."), "https://buffet.com.br/avaliacao/castelo/festa");
  assertEquals(previewLinkUrl("Nosso Instagram: instagram.com/castelo"), null);
});

Deno.test("prévia: lê título, descrição e imagem da og-preview", () => {
  const html = `<html><head><title>X</title>
<meta property="og:title" content="Castelo da Divers&atilde;o | Buffet Infantil" />
<meta property="og:description" content="O melhor buffet infantil" />
<meta property="og:image" content="https://www.castelodadiversao.online/og-image.jpg" /></head></html>`;
  assertEquals(parseOgMeta(html), { title: "Castelo da Divers&atilde;o | Buffet Infantil", description: "O melhor buffet infantil", image: "https://www.castelodadiversao.online/og-image.jpg" });
  assertEquals(parseOgMeta("<title>Sem imagem</title>"), null);
});

Deno.test("Z-API: link vai para o fim da mensagem (modelos antigos tinham texto depois)", async () => {
  const { linkAtEnd } = await import("./link-preview.ts");
  const url = "https://www.castelodadiversao.com.br/dados/S7VVHZE";
  assertEquals(
    linkAtEnd(`Preencha no link abaixo:\n\n${url}\n\nAssim o buffet consegue finalizar o contrato. 🎉`, url),
    `Preencha no link abaixo:\n\nAssim o buffet consegue finalizar o contrato. 🎉\n\n${url}`,
  );
  assertEquals(linkAtEnd(`Segue o link:\n\n${url}`, url), `Segue o link:\n\n${url}`);
});

Deno.test("prévia: link da Vamu 3D (parceira) também vai com miniatura", () => {
  assertEquals(
    previewLinkUrl("Aqui está o link: https://vamu3d.com.br/castelo?origem=ia 🎉"),
    "https://vamu3d.com.br/castelo?origem=ia",
  );
  assertEquals(previewLinkUrl("Veja: vamu3d.com.br/castelo?origem=ia"), "https://vamu3d.com.br/castelo?origem=ia");
  assertEquals(previewLinkUrl("Site: https://vamu3d.com.br/empresas"), null);
});
