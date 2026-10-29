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
