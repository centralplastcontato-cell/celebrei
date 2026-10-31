import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import { isUuid, parseVamuOrder, vamuOrderSummary, vamuOrderTag, vamuPartyLink } from "./vamu.ts";

const ID = "3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";

Deno.test("vamuPartyLink: link preenchido com o primeiro nome, a idade e a data", () => {
  assertEquals(
    vamuPartyLink({ id: ID, child_name: "Alice Souza", child_age: "5 anos", event_date: "2026-12-12" }),
    `https://vamu3d.com.br/castelo?nome=Alice&idade=5&data=2026-12-12&festa=${ID}&origem=celebrei`,
  );
  assertEquals(vamuPartyLink({ id: ID, child_name: "João", child_age: null, event_date: null }, "cartao"),
    `https://vamu3d.com.br/castelo?nome=Jo%C3%A3o&festa=${ID}&origem=cartao`);
});

Deno.test("parseVamuOrder: aceita snake_case, camelCase e produtos em texto ou lista", () => {
  const a = parseVamuOrder({ id: 12, festa_code: ID, child_name: "Alice", child_age: 5, products: "Topo de bolo, Chaveiro com nome", quantity: "30", whatsapp: "15 99999-0000", origem: "celebrei" })!;
  assertEquals(a.id, "12");
  assertEquals(a.festa, ID);
  assertEquals(a.childAge, "5");
  assertEquals(a.products, ["Topo de bolo", "Chaveiro com nome"]);
  const b = parseVamuOrder({ id: "13", festa: null, childName: "Pedro", products: ["Lembrancinhas"] })!;
  assertEquals(b.festa, null);
  assertEquals(b.childName, "Pedro");
  assertEquals(parseVamuOrder({ child_name: "sem id" }), null);
  assertEquals(parseVamuOrder(null), null);
});

Deno.test("vamuOrderSummary, vamuOrderTag e isUuid", () => {
  const o = parseVamuOrder({ id: 12, child_name: "Alice", child_age: 5, products: "Topo de bolo, Chaveiro com nome", quantity: "30" })!;
  assertEquals(vamuOrderSummary(o), "Topo de bolo, Chaveiro com nome (30 un.) · Alice, 5 anos");
  assertEquals(vamuOrderSummary(parseVamuOrder({ id: 1 })!), "produtos a combinar");
  assertEquals(vamuOrderTag("12"), "#vamu-12");
  assertEquals(isUuid(ID), true);
  assertEquals(isUuid("K7X2P"), false);
});

Deno.test("oferta: nomes limpos, idade e só festa de aniversário", async () => {
  const { cleanFirstName, partyAge, isBirthdayParty, vamuOfferTag, vamuOfferEventId } = await import("./vamu.ts");
  assertEquals(cleanFirstName(" Lívia 02 anos"), "Lívia");
  assertEquals(cleanFirstName("MIGUEL GLAUSER TOLENTINO"), "Miguel");
  assertEquals(cleanFirstName("Thaís Festa. 14.11.2026 ."), "Thaís");
  assertEquals(cleanFirstName("MaríLia"), "Marília");
  assertEquals(cleanFirstName("Fabiana 05.12.26"), "Fabiana");
  assertEquals(cleanFirstName("5515999990000"), "");
  assertEquals(partyAge("6", "Noah"), 6);
  assertEquals(partyAge(null, " Kauã 08 anos"), 8);
  assertEquals(partyAge("2 anos", "Vinicius"), 2);
  assertEquals(partyAge(null, "Francisco"), null);
  assertEquals(isBirthdayParty("Festa do Eduardo", "EDUARDO"), true);
  for (const t of ["Formatura Colégio EMEB", "COLÉGIO AUGE", "Clubinho Arte e Brinca", "Escola Maternita", "E.M. Prof.ª Renice Seraphim"]) {
    assertEquals(isBirthdayParty(t, t), false);
  }
  assertEquals(vamuOfferEventId(`texto ${vamuOfferTag(ID)}`), ID);
});

Deno.test("oferta: mensagem sem do/da e com o link no fim", async () => {
  const { vamuOfferMessage } = await import("./vamu.ts");
  const msg = vamuOfferMessage({ parentName: "Mariana", childName: "Eduardo", companyName: "Castelo da Diversão", link: "https://vamu3d.com.br/castelo?nome=Eduardo" });
  assertEquals(msg.startsWith("Oi, Mariana! 🎉 A festa está chegando!"), true);
  assertEquals(msg.includes("com o nome de Eduardo"), true);
  assertEquals(msg.endsWith("https://vamu3d.com.br/castelo?nome=Eduardo"), true);
  assertEquals(vamuOfferMessage({ parentName: "", childName: "", companyName: "X", link: "L" }).startsWith("Oi! 🎉"), true);
});
