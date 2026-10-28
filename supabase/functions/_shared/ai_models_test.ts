import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import {
  estimateChatCostUsd,
  estimateTranscriptionCostUsd,
  isOpenAiReasoningModel,
  openAiReasoningEffortWithTools,
  normalizeAnthropicUsage,
  normalizeOpenAiUsage,
  providerForModel,
  summarizeAiUsage,
} from "./ai-models.ts";

Deno.test("providerForModel: Claude vai para Anthropic, o resto para OpenAI", () => {
  assertEquals(providerForModel("claude-sonnet-5-5"), "anthropic");
  assertEquals(providerForModel("claude-qualquer-coisa-nova"), "anthropic");
  assertEquals(providerForModel("gpt-5.4-mini"), "openai");
  assertEquals(providerForModel(null), "openai");
});

Deno.test("isOpenAiReasoningModel: só a família GPT-5 / o-series", () => {
  assertEquals(isOpenAiReasoningModel("gpt-5.4-mini"), true);
  assertEquals(isOpenAiReasoningModel("gpt-4o-mini"), false);
});

Deno.test("openAiReasoningEffortWithTools: GPT-5.x usa 'none' (a OpenAI recusa ferramentas com raciocínio)", () => {
  assertEquals(openAiReasoningEffortWithTools("gpt-5.4-mini"), "none");
  assertEquals(openAiReasoningEffortWithTools("gpt-5.4"), "none");
  assertEquals(openAiReasoningEffortWithTools("gpt-5-mini"), "minimal");
  assertEquals(openAiReasoningEffortWithTools("gpt-4o-mini"), null);
});

Deno.test("normalizeOpenAiUsage: separa os tokens que vieram do cache", () => {
  assertEquals(
    normalizeOpenAiUsage({ prompt_tokens: 3000, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 2048 } }),
    { inputTokens: 952, cachedInputTokens: 2048, cacheWriteTokens: 0, outputTokens: 120 },
  );
  assertEquals(normalizeOpenAiUsage(undefined), { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
});

Deno.test("normalizeAnthropicUsage: leitura e escrita do cache em campos separados", () => {
  assertEquals(
    normalizeAnthropicUsage({ input_tokens: 400, cache_read_input_tokens: 2500, cache_creation_input_tokens: 0, output_tokens: 300 }),
    { inputTokens: 400, cachedInputTokens: 2500, cacheWriteTokens: 0, outputTokens: 300 },
  );
});

Deno.test("estimateChatCostUsd: aplica o preço de cada tipo de token", () => {
  // Sonnet 5.5: 1000 × $2/M + 2000 × $0,20/M + 500 × $10/M = 0,002 + 0,0004 + 0,005
  assertEquals(
    estimateChatCostUsd("claude-sonnet-5-5", { inputTokens: 1000, cachedInputTokens: 2000, cacheWriteTokens: 0, outputTokens: 500 }),
    0.0074,
  );
  // GPT-4o mini: 3000 × $0,15/M + 100 × $0,60/M
  assertEquals(
    estimateChatCostUsd("gpt-4o-mini", { inputTokens: 3000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }),
    0.00051,
  );
  // Nome com a data da versão (como a OpenAI devolve): preço do GPT-5.4, não do padrão
  // 3000 × $2,50/M + 1000 × $0,25/M + 100 × $15/M = 0,0075 + 0,00025 + 0,0015
  assertEquals(
    estimateChatCostUsd("gpt-5.4-2026-03-05", { inputTokens: 3000, cachedInputTokens: 1000, cacheWriteTokens: 0, outputTokens: 100 }),
    0.00925,
  );
  assertEquals(
    estimateChatCostUsd("claude-haiku-4-5-20251001", { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }),
    0.001,
  );
  // Modelo desconhecido: cobra como o padrão, Claude Sonnet 5.5 (nunca zera o custo)
  // 3000 × $2/M + 100 × $10/M
  assertEquals(
    estimateChatCostUsd("modelo-novo", { inputTokens: 3000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }),
    0.007,
  );
});

Deno.test("estimateTranscriptionCostUsd: por tokens ou por minuto", () => {
  assertEquals(estimateTranscriptionCostUsd({ audioTokens: 1000, textOutputTokens: 100 }), 0.0035);
  assertEquals(estimateTranscriptionCostUsd({ seconds: 30 }), 0.0015);
});

Deno.test("summarizeAiUsage: custo total e média por conversa, por modelo", () => {
  const rows = [
    { conversation_id: "c1", model: "gpt-4o-mini", kind: "chat", cost_usd: "0.002000" },
    { conversation_id: "c1", model: "gpt-4o-mini", kind: "chat", cost_usd: "0.001000" },
    // áudio da conversa c1 conta no modelo que estava conversando
    { conversation_id: "c1", model: "gpt-4o-mini-transcribe", kind: "transcription", cost_usd: "0.001000" },
    { conversation_id: "c2", model: "gpt-4o-mini", kind: "chat", cost_usd: "0.002000" },
    { conversation_id: "c3", model: "claude-sonnet-5-5", kind: "chat", cost_usd: 0.03 },
  ];
  assertEquals(summarizeAiUsage(rows), [
    { model: "claude-sonnet-5-5", conversations: 1, totalUsd: 0.03, avgPerConversationUsd: 0.03 },
    { model: "gpt-4o-mini", conversations: 2, totalUsd: 0.006, avgPerConversationUsd: 0.003 },
  ]);
});
