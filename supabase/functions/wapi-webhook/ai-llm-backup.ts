// Fica fora de ai-llm.ts para dar para testar sem o SDK da Anthropic.
import type { LlmSession, LlmStep } from "./ai-llm.ts";

// Reserva quando o Claude falha (crédito da Anthropic acabou, fora do ar,
// limite de uso): a resposta sai pelo GPT e o cliente não fica sem resposta.
export const CLAUDE_BACKUP_MODEL = "gpt-5.4";

/**
 * Começa no Claude; se a PRIMEIRA rodada der erro, refaz tudo pelo GPT
 * (servedModel mostra quem respondeu, e o custo vai para ele). Erro depois
 * de a IA já ter pedido ferramentas continua como antes: trocar de provedor
 * no meio repetiria ferramentas que gravam dados.
 */
export class ClaudeWithBackupSession implements LlmSession {
  private current: LlmSession;
  private started = false;
  private usingBackup = false;
  constructor(primary: LlmSession, private makeBackup: () => LlmSession | null) {
    this.current = primary;
  }

  async step(): Promise<LlmStep> {
    try {
      const out = await this.current.step();
      this.started = true;
      return out;
    } catch (err) {
      if (this.started || this.usingBackup) throw err;
      const backup = this.makeBackup();
      if (!backup) throw err;
      console.warn(`[AI] Claude falhou (${String((err as Error)?.message || err).slice(0, 200)}) — respondendo pelo ${CLAUDE_BACKUP_MODEL}`);
      this.current = backup;
      this.usingBackup = true;
      const out = await this.current.step();
      this.started = true;
      return out;
    }
  }

  addToolResults(results: Array<{ id: string; content: string }>) {
    this.current.addToolResults(results);
  }

  addUserNote(text: string) {
    this.current.addUserNote(text);
  }
}

