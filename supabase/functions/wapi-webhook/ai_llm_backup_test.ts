import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import { ClaudeWithBackupSession } from "./ai-llm-backup.ts";
import type { LlmSession, LlmStep } from "./ai-llm.ts";

const usage = { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 };
const ok = (servedModel: string): LlmStep => ({ text: "oi", toolCalls: [], usage, servedModel, refused: false });

function fake(steps: Array<LlmStep | Error>, log: string[], name: string): LlmSession {
  return {
    step: () => {
      const s = steps.shift();
      return s instanceof Error ? Promise.reject(s) : Promise.resolve(s!);
    },
    addToolResults: () => log.push(`${name}:tools`),
    addUserNote: () => log.push(`${name}:note`),
  };
}

Deno.test("Claude sem crédito: a resposta sai pelo GPT", async () => {
  const log: string[] = [];
  const s = new ClaudeWithBackupSession(
    fake([new Error("400 Your credit balance is too low")], log, "claude"),
    () => fake([ok("gpt-5.4-2026-03-05"), ok("gpt-5.4-2026-03-05")], log, "gpt"),
  );
  assertEquals((await s.step()).servedModel, "gpt-5.4-2026-03-05");
  s.addToolResults([]);
  assertEquals(log, ["gpt:tools"]);
  assertEquals((await s.step()).servedModel, "gpt-5.4-2026-03-05");
});

Deno.test("Claude funcionando: não usa o GPT", async () => {
  let made = 0;
  const s = new ClaudeWithBackupSession(fake([ok("claude-sonnet-5-5")], [], "claude"), () => { made++; return null; });
  assertEquals((await s.step()).servedModel, "claude-sonnet-5-5");
  assertEquals(made, 0);
});

Deno.test("erro depois de a IA já ter respondido: não troca no meio", async () => {
  let made = 0;
  const s = new ClaudeWithBackupSession(fake([ok("claude-sonnet-5-5"), new Error("500")], [], "claude"), () => { made++; return null; });
  await s.step();
  let failed = false;
  try { await s.step(); } catch { failed = true; }
  assertEquals(failed, true);
  assertEquals(made, 0);
});
