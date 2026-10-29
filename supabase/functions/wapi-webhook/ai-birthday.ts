import { firstNameOrEmpty } from "./qualification-materials.ts";

type Json = Record<string, unknown>;

/**
 * Vitor (29/10): a IA foi de nome → mês → convidados → materiais e nunca
 * perguntou de quem era a festa. Na conversa de festa, sem aniversariante
 * registrado e sem ter perguntado ainda, a próxima mensagem pergunta.
 */
export function birthdayQuestionDue(bd: Json, lastUserText: string, assistantTexts: string[]): boolean {
  if (bd.tipo_evento === 'empresa' || firstNameOrEmpty(bd.aniversariante as string)) return false;
  if (!bd.mes && !bd.convidados && !/anivers/i.test(lastUserText || '')) return false;
  // Só a pergunta em si: a legenda das fotos fala da "carinha de quem faz aniversário" e não conta
  const asked = /de quem (é|e|vai ser) a festa|nome d[oa] (criança|aniversariante)|quem (é|vai ser) [oa] aniversariante/i;
  return !assistantTexts.some((t) => asked.test(String(t || '')));
}
