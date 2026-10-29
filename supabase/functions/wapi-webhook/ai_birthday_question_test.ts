import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import { birthdayQuestionDue } from "./ai-birthday.ts";

Deno.test("aniversariante: pergunta na conversa de festa enquanto não souber", () => {
  // Vitor (29/10): "Aniversário" → a próxima mensagem já pergunta de quem é a festa
  assertEquals(birthdayQuestionDue({}, "Aniversário", ["Prazer, Vitor! Me conta, como posso te ajudar?"]), true);
  // Mês e convidados anotados, legenda das fotos falando de "quem faz aniversário" não conta como pergunta
  assertEquals(birthdayQuestionDue({ mes: "Março", convidados: "60" }, "60", ["Já imaginou a carinha de quem faz aniversário chegando? ✨"]), true);
});

Deno.test("aniversariante: não pergunta de novo nem fora de hora", () => {
  assertEquals(birthdayQuestionDue({ aniversariante: "Arthur" }, "60", []), false);
  assertEquals(birthdayQuestionDue({ mes: "Março" }, "ok", ["Me conta: de quem é a festa? 🎈"]), false);
  assertEquals(birthdayQuestionDue({ tipo_evento: "empresa", mes: "Dezembro" }, "40", []), false);
  assertEquals(birthdayQuestionDue({}, "Olá", []), false);
});
