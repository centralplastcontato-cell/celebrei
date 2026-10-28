import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import { buildArtPrompt } from "./gpt-art.ts";

const has = (p: string, part: string) => assertEquals(p.includes(part), true, `faltou: ${part}`);

Deno.test("arte com IA: tema, texto exato, logo e foto na ordem das imagens", () => {
  const p = buildArtPrompt({ idea: "Datas livres em novembro, tema festa neon", artText: "Datas livres em Novembro", companyName: "Castelo da Diversão", hasLogo: true, hasPhoto: true });
  has(p, 'EXACTLY this text in Brazilian Portuguese');
  has(p, '"Datas livres em Novembro"');
  has(p, "Image 1 is the buffet logo");
  has(p, "Image 2 is a real photo");
  has(p, "Never invent prices");
});

Deno.test("arte com IA: sem texto pedido, não escreve nada; sem logo, foto é a imagem 1", () => {
  const p = buildArtPrompt({ idea: "Halloween", hasLogo: false, hasPhoto: true });
  has(p, "Do not write any words");
  has(p, "Image 1 is a real photo");
});

Deno.test("arte com IA: ajuste muda só o pedido e mantém o resto", () => {
  const p = buildArtPrompt({ idea: "x", artText: "Natal Mágico", hasLogo: true, hasPhoto: false, adjust: "fundo azul" });
  has(p, "Change only this: fundo azul.");
  has(p, '"Natal Mágico"');
  assertEquals(p.includes("Image 2"), false);
});
