// Catálogo dos modelos que a IA Conversacional (beta) pode usar, com o preço
// de cada um, para escolher o modelo pela configuração e calcular o custo de
// cada resposta. Usado pela edge function (Deno) e pela tela (React) — não
// pode depender de nada do Deno nem do navegador.
//
// Preços em US$ por 1 milhão de tokens (tabela oficial de cada provedor,
// conferida em out/2026). Se um provedor mudar o preço, basta ajustar aqui.

export type AiProvider = "openai" | "anthropic";

export interface AiModelInfo {
  id: string;
  provider: AiProvider;
  label: string;
  // Frase curta para a tela de configuração
  hint: string;
  inputPerM: number;
  cachedInputPerM: number;
  // Escrita no cache (só Anthropic cobra à parte; OpenAI cacheia de graça)
  cacheWritePerM: number;
  outputPerM: number;
  // "Pensa" antes de responder (tokens extras cobrados como saída)
  thinks: boolean;
}

// Modelo de quem ainda não escolheu (buffets novos): o mesmo nível do Castelo
// (28/10 — "tudo igual"). Antes era o GPT-4o mini, o mais simples.
export const DEFAULT_AI_MODEL = "claude-sonnet-5-5";
// Sem a chave da Anthropic no Supabase, os modelos Claude caem para este
export const NO_ANTHROPIC_KEY_MODEL = "gpt-5.4";

export const AI_MODELS: AiModelInfo[] = [
  { id: "gpt-4o-mini", provider: "openai", label: "GPT-4o mini (OpenAI)", hint: "O mais barato, o mais simples", inputPerM: 0.15, cachedInputPerM: 0.075, cacheWritePerM: 0, outputPerM: 0.6, thinks: false },
  { id: "gpt-5.4-mini", provider: "openai", label: "GPT-5.4 mini (OpenAI)", hint: "Bem melhor que o 4o mini, ainda barato", inputPerM: 0.75, cachedInputPerM: 0.075, cacheWritePerM: 0, outputPerM: 4.5, thinks: false },
  { id: "gpt-5.4", provider: "openai", label: "GPT-5.4 (OpenAI)", hint: "O forte da OpenAI para produção", inputPerM: 2.5, cachedInputPerM: 0.25, cacheWritePerM: 0, outputPerM: 15, thinks: false },
  { id: "claude-haiku-4-5", provider: "anthropic", label: "Claude Haiku 4.5 (Anthropic)", hint: "Rápido e barato", inputPerM: 1, cachedInputPerM: 0.1, cacheWritePerM: 1.25, outputPerM: 5, thinks: false },
  { id: "claude-sonnet-5-5", provider: "anthropic", label: "Claude Sonnet 5.5 (Anthropic)", hint: "Conversa mais natural, ótimo custo-benefício", inputPerM: 2, cachedInputPerM: 0.2, cacheWritePerM: 2.5, outputPerM: 10, thinks: true },
  { id: "claude-opus-5-5", provider: "anthropic", label: "Claude Opus 5.5 (Anthropic)", hint: "O mais inteligente — o mais caro", inputPerM: 4, cachedInputPerM: 0.2, cacheWritePerM: 5, outputPerM: 20, thinks: true },
];

// Modelos auxiliares (não aparecem na escolha): ouvir áudio e descrever foto.
export const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
export const VISION_MODEL = "gpt-4o-mini";
// gpt-4o-mini-transcribe: áudio de entrada US$ 3/M tokens, texto de saída US$ 5/M
// (≈ US$ 0,003 por minuto). Quando a resposta vem em segundos, usa o por minuto.
const TRANSCRIBE_AUDIO_PER_M = 3;
const TRANSCRIBE_TEXT_OUT_PER_M = 5;
const TRANSCRIBE_PER_MINUTE = 0.003;

// Cotação usada só para mostrar o valor em reais na tela (aproximado;
// dólar comercial em out/2026 ≈ R$ 5,00).
export const USD_TO_BRL = 5.0;

// A resposta do provedor traz o nome com a data da versão ("gpt-5.4-2026-03-05",
// "claude-haiku-4-5-20251001"); sem tirar a data, o preço caía no do modelo padrão.
const SNAPSHOT_SUFFIX = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;

export function getAiModel(id: string | null | undefined): AiModelInfo | null {
  if (!id) return null;
  const base = id.replace(SNAPSHOT_SUFFIX, "");
  return AI_MODELS.find((m) => m.id === id) || AI_MODELS.find((m) => m.id === base) || null;
}

export function providerForModel(id: string | null | undefined): AiProvider {
  const known = getAiModel(id);
  if (known) return known.provider;
  return (id || "").startsWith("claude") ? "anthropic" : "openai";
}

// Família GPT-5 é "de raciocínio": não aceita temperature e usa
// max_completion_tokens + reasoning_effort no lugar de max_tokens.
export function isOpenAiReasoningModel(id: string): boolean {
  return /^(gpt-5|o\d)/.test(id);
}

// Nível de raciocínio que dá para usar JUNTO com as ferramentas da IA no
// /v1/chat/completions. A OpenAI recusa ferramentas com raciocínio ligado nos
// GPT-5.x ("Function tools with reasoning_effort are not supported ... set
// reasoning_effort to 'none'"); o GPT-5 original não tem "none", usa "minimal".
export function openAiReasoningEffortWithTools(id: string): "none" | "minimal" | null {
  if (!isOpenAiReasoningModel(id)) return null;
  if (/^gpt-5\.\d/.test(id)) return "none";
  return "minimal";
}

export interface AiUsageTokens {
  // Tokens de entrada cobrados a preço cheio (sem os que vieram do cache)
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function estimateChatCostUsd(modelId: string, usage: AiUsageTokens): number {
  const m = getAiModel(modelId) || getAiModel(DEFAULT_AI_MODEL)!;
  const cost =
    (usage.inputTokens * m.inputPerM +
      usage.cachedInputTokens * m.cachedInputPerM +
      usage.cacheWriteTokens * m.cacheWritePerM +
      usage.outputTokens * m.outputPerM) / 1_000_000;
  return round6(cost);
}

export function estimateTranscriptionCostUsd(usage: { audioTokens?: number; textOutputTokens?: number; seconds?: number }): number {
  if (usage.audioTokens || usage.textOutputTokens) {
    return round6(((usage.audioTokens || 0) * TRANSCRIBE_AUDIO_PER_M + (usage.textOutputTokens || 0) * TRANSCRIBE_TEXT_OUT_PER_M) / 1_000_000);
  }
  return round6(((usage.seconds || 0) / 60) * TRANSCRIBE_PER_MINUTE);
}

// Lê o "usage" da resposta de cada provedor e devolve no formato único acima.
// OpenAI: prompt_tokens já inclui os cacheados. Anthropic: input_tokens é só
// a parte sem cache; leitura/escrita do cache vêm em campos separados.
type UsageLike = Record<string, unknown> | null | undefined;

export function normalizeOpenAiUsage(usage: UsageLike): AiUsageTokens {
  const prompt = Number(usage?.prompt_tokens) || 0;
  const details = usage?.prompt_tokens_details as UsageLike;
  const cached = Number(details?.cached_tokens) || 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    cachedInputTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: Number(usage?.completion_tokens) || 0,
  };
}

export function normalizeAnthropicUsage(usage: UsageLike): AiUsageTokens {
  return {
    inputTokens: Number(usage?.input_tokens) || 0,
    cachedInputTokens: Number(usage?.cache_read_input_tokens) || 0,
    cacheWriteTokens: Number(usage?.cache_creation_input_tokens) || 0,
    outputTokens: Number(usage?.output_tokens) || 0,
  };
}

// Estimativa de uma conversa típica, para comparar modelos antes de testar:
// ~15 chamadas (respostas + rodadas de ferramenta) de ~3.000 tokens de
// entrada (instruções + histórico) e ~150 de resposta, sem contar o desconto
// do cache. O custo real fica registrado em ai_agent_usage.
const TYPICAL_CALLS = 15;
const TYPICAL_INPUT_PER_CALL = 3000;
const TYPICAL_OUTPUT_PER_CALL = 150;
const TYPICAL_THINKING_PER_CALL = 150;

export function estimateTypicalConversationUsd(modelId: string): number {
  const m = getAiModel(modelId) || getAiModel(DEFAULT_AI_MODEL)!;
  return estimateChatCostUsd(m.id, {
    inputTokens: TYPICAL_CALLS * TYPICAL_INPUT_PER_CALL,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: TYPICAL_CALLS * (TYPICAL_OUTPUT_PER_CALL + (m.thinks ? TYPICAL_THINKING_PER_CALL : 0)),
  });
}

export interface AiUsageRow {
  conversation_id: string | null;
  model: string;
  kind: string;
  cost_usd: number | string;
  is_test?: boolean | null;
}

export interface AiUsageSummary {
  model: string;
  conversations: number;
  totalUsd: number;
  avgPerConversationUsd: number;
}

// Agrupa o consumo por modelo: custo total e média por conversa. Áudio e foto
// entram no modelo de conversa que estava em uso naquela conversa.
export function summarizeAiUsage(rows: AiUsageRow[]): AiUsageSummary[] {
  const chatModelByConv = new Map<string, string>();
  for (const r of rows) {
    if (r.kind === "chat" && r.conversation_id && !chatModelByConv.has(r.conversation_id)) {
      chatModelByConv.set(r.conversation_id, r.model);
    }
  }
  const byModel = new Map<string, { convs: Set<string>; total: number }>();
  for (const r of rows) {
    const raw = r.kind === "chat" ? r.model : (r.conversation_id && chatModelByConv.get(r.conversation_id)) || r.model;
    // Junta "gpt-5.4" e "gpt-5.4-2026-03-05" na mesma linha
    const model = getAiModel(raw)?.id || raw;
    const entry = byModel.get(model) || { convs: new Set<string>(), total: 0 };
    if (r.conversation_id) entry.convs.add(r.conversation_id);
    entry.total += Number(r.cost_usd) || 0;
    byModel.set(model, entry);
  }
  return Array.from(byModel.entries())
    .map(([model, e]) => ({
      model,
      conversations: e.convs.size,
      totalUsd: round6(e.total),
      avgPerConversationUsd: e.convs.size > 0 ? round6(e.total / e.convs.size) : 0,
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd);
}
