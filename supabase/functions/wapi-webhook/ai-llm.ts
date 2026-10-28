// ============= PROVEDORES DE IA (OpenAI / Anthropic) =============
// Uma "sessão" por resposta da IA: guarda a conversa no formato de cada
// provedor e devolve, a cada rodada, o texto, as ferramentas pedidas e o
// consumo (tokens) já no formato único de _shared/ai-models.ts.

// deno-lint-ignore-file no-explicit-any

import Anthropic from "npm:@anthropic-ai/sdk@0.131.0";
import {
  type AiUsageTokens,
  isOpenAiReasoningModel,
  openAiReasoningEffortWithTools,
  normalizeAnthropicUsage,
  normalizeOpenAiUsage,
  providerForModel,
} from "../_shared/ai-models.ts";
import { CLAUDE_BACKUP_MODEL, ClaudeWithBackupSession } from "./ai-llm-backup.ts";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmStep {
  text: string;
  toolCalls: ToolCall[];
  usage: AiUsageTokens;
  // Modelo que de fato respondeu (no Claude pode ser o reserva, se o
  // principal recusar) — é por ele que o custo é calculado.
  servedModel: string;
  refused: boolean;
}

export interface LlmSession {
  step(): Promise<LlmStep>;
  addToolResults(results: Array<{ id: string; content: string }>): void;
  /** Aviso interno do sistema depois de uma resposta (o cliente não vê) para a IA refazer */
  addUserNote(text: string): void;
}

export interface LlmSessionInput {
  model: string;
  system: string;
  history: ChatTurn[];
  tools: ToolDef[];
  openaiKey: string | null;
  anthropicKey: string | null;
}

const OPENAI_TIMEOUT_MS = 45_000;

function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

class OpenAiSession implements LlmSession {
  private messages: Array<Record<string, unknown>>;
  constructor(private input: LlmSessionInput & { openaiKey: string }) {
    this.messages = [{ role: "system", content: input.system }, ...input.history];
  }

  async step(): Promise<LlmStep> {
    const { model } = this.input;
    const body: Record<string, unknown> = { model, messages: this.messages };
    // Sem ferramentas (ex.: mensagem de acompanhamento): a API não aceita lista vazia
    if (this.input.tools.length > 0) body.tools = this.input.tools.map((t) => ({ type: "function", function: t }));
    if (isOpenAiReasoningModel(model)) {
      // Família GPT-5: sem temperature; o limite inclui o "raciocínio" interno
      body.max_completion_tokens = 1500;
      // Com as ferramentas da IA, o chat/completions só aceita raciocínio desligado
      body.reasoning_effort = openAiReasoningEffortWithTools(model);
    } else {
      body.temperature = 0.6;
      body.max_tokens = 400;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.input.openaiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new Error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    const result = await response.json() as Record<string, any>;
    const message = result?.choices?.[0]?.message;
    if (!message) throw new Error("OpenAI: resposta sem mensagem");
    this.messages.push(message);
    const toolCalls = ((message.tool_calls || []) as Array<{ id: string; function: { name: string; arguments: string } }>)
      .map((c) => ({ id: c.id, name: c.function.name, args: safeParseArgs(c.function.arguments) }));
    return {
      text: String(message.content || "").trim(),
      toolCalls,
      usage: normalizeOpenAiUsage(result.usage),
      servedModel: String(result.model || model),
      refused: false,
    };
  }

  addToolResults(results: Array<{ id: string; content: string }>) {
    for (const r of results) this.messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
  }

  addUserNote(text: string) {
    this.messages.push({ role: "system", content: text });
  }
}

// Modelos Claude 5.x: pensam por padrão (adaptive) e aceitam "effort" e o
// modelo reserva automático se o principal recusar. Haiku 4.5 não aceita nenhum dos dois.
const CLAUDE_WITH_EFFORT = new Set(["claude-sonnet-5-5", "claude-opus-5-5"]);

class AnthropicSession implements LlmSession {
  private client: Anthropic;
  private messages: Anthropic.Beta.BetaMessageParam[];
  private tools: Anthropic.Beta.BetaTool[];
  constructor(private input: LlmSessionInput & { anthropicKey: string }) {
    this.client = new Anthropic({ apiKey: input.anthropicKey, maxRetries: 1, timeout: 60_000 });
    const history = [...input.history];
    // A API exige que a conversa comece pelo cliente
    if (history.length === 0 || history[0].role !== "user") {
      history.unshift({ role: "user", content: "(o cliente iniciou a conversa)" });
    }
    this.messages = history.map((t) => ({ role: t.role, content: t.content }));
    this.tools = input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
    }));
  }

  async step(): Promise<LlmStep> {
    const { model } = this.input;
    const withEffort = CLAUDE_WITH_EFFORT.has(model);
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model,
      // Inclui o "pensamento" interno; o tamanho da resposta é controlado pelo prompt
      max_tokens: withEffort ? 4000 : 1024,
      system: [{ type: "text", text: this.input.system, cache_control: { type: "ephemeral" } }],
      messages: this.messages,
      ...(this.tools.length > 0 ? { tools: this.tools } : {}),
    };
    if (withEffort) {
      params.output_config = { effort: "low" };
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    const response = await this.client.beta.messages.create(params);
    this.messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const toolCalls = response.content
      .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, args: (b.input || {}) as Record<string, unknown> }));
    return {
      text,
      toolCalls,
      usage: normalizeAnthropicUsage(response.usage as unknown as Record<string, unknown>),
      servedModel: response.model || model,
      refused: response.stop_reason === "refusal",
    };
  }

  addToolResults(results: Array<{ id: string; content: string }>) {
    // Todas as respostas das ferramentas vão juntas numa única mensagem
    this.messages.push({
      role: "user",
      content: results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content })),
    });
  }

  addUserNote(text: string) {
    this.messages.push({ role: "user", content: `[Aviso interno do sistema — não é mensagem do cliente] ${text}` });
  }
}

// Devolve null quando falta a chave do provedor do modelo escolhido.
export function createLlmSession(input: LlmSessionInput): LlmSession | null {
  if (providerForModel(input.model) === "anthropic") {
    if (!input.anthropicKey) return null;
    const claude = new AnthropicSession({ ...input, anthropicKey: input.anthropicKey });
    return new ClaudeWithBackupSession(claude, () =>
      input.openaiKey ? new OpenAiSession({ ...input, model: CLAUDE_BACKUP_MODEL, openaiKey: input.openaiKey }) : null
    );
  }
  return input.openaiKey ? new OpenAiSession({ ...input, openaiKey: input.openaiKey }) : null;
}
