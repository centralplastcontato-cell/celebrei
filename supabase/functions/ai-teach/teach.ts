// "Ensinar a IA": transforma o que o dono escreveu ou falou (às vezes corrigindo
// uma resposta do teste) em orientações curtas e claras para a IA. Regras puras
// (prompt e leitura da resposta) — quem chama o modelo é o index.ts.

export interface TeachContext {
  /** a pergunta do cliente no teste */
  cliente?: string | null;
  /** a resposta da IA que o dono quer corrigir */
  resposta?: string | null;
}

export interface TeachNote {
  text: string;
  kind: "orientacao" | "informacao";
}

export interface TeachProposal {
  notes: TeachNote[];
  /** pedido que vai contra as regras fixas (preço, desconto, promessa, reserva) */
  blocked: string | null;
  /** é fato de pacote: vale também acertar o cadastro do pacote */
  packageHint: boolean;
  /** é sobre a IA não marcar visita: existe a opção "Quem marca as visitas" */
  visitHint: boolean;
}

export function buildTeachPrompt(companyName: string, existing: string[]): string {
  return `Você ajuda o dono do buffet infantil "${companyName}" a ensinar a atendente virtual (IA de WhatsApp) dele.
Ele vai mandar uma correção ou orientação, escrita ou falada (transcrita, pode ter erros de fala). Às vezes vem junto a pergunta do cliente e a resposta da IA que ele não gostou.

Transforme em 1 a 4 orientações CURTAS (uma frase cada, no máximo ~35 palavras), claras e diretas para a IA seguir, em português, sem perder nada do que o dono quis dizer:
- "informacao": fato do buffet (o que o pacote inclui, regra da casa, horário, estrutura). Ex.: "A decoração NÃO está inclusa no Cardápio Classic; só no Premium."
- "orientacao": jeito de atender. Ex.: "Não convide para visita em toda mensagem; convide só quando o cliente mostrar interesse."
Escreva como regra para a IA (imperativo ou afirmação), sem citar o cliente do teste pelo nome e sem "o dono disse".

NÃO pode virar orientação (marque em "bloqueado", explicando em uma frase simples para o dono): mandar a IA inventar ou passar valores fora da tabela oficial, dar ou prometer desconto, brinde ou condição de pagamento, prometer coisas, reservar/segurar datas ou dizer que a data está garantida, ou fingir ser humana. Nesses casos, devolva sem as notas que pedem isso.

Se a correção for sobre o que um pacote inclui, marque "pacote": true (o dono também deve acertar o cadastro do pacote).
Se o dono quiser que a IA NÃO ofereça/marque horários de visita (quem marca é a equipe), marque "visita": true — existe uma configuração própria para isso.
Não repita o que já está ensinado:
${existing.length ? existing.map((e) => `- ${e}`).join("\n") : "(nada ainda)"}

Responda SÓ com JSON, sem texto em volta:
{"notas":[{"texto":"...","tipo":"informacao"|"orientacao"}],"bloqueado":null|"motivo","pacote":true|false,"visita":true|false}`;
}

export function buildTeachUserMessage(text: string, ctx: TeachContext): string {
  const parts: string[] = [];
  if (ctx.cliente) parts.push(`Pergunta do cliente no teste: "${ctx.cliente.slice(0, 600)}"`);
  if (ctx.resposta) parts.push(`Resposta da IA que o dono quer corrigir: "${ctx.resposta.slice(0, 1500)}"`);
  parts.push(`O que o dono ensinou: "${text.slice(0, 3000)}"`);
  return parts.join("\n\n");
}

/** Lê o JSON do modelo (tolerante a texto em volta) */
export function parseTeachProposal(raw: string): TeachProposal | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const notes = (Array.isArray(obj.notas) ? obj.notas : [])
    .map((n: { texto?: unknown; tipo?: unknown }) => ({
      text: String(n?.texto || "").trim().slice(0, 600),
      kind: (n?.tipo === "informacao" ? "informacao" : "orientacao") as TeachNote["kind"],
    }))
    .filter((n) => n.text.length >= 3)
    .slice(0, 4);
  const blocked = typeof obj.bloqueado === "string" && obj.bloqueado.trim() ? obj.bloqueado.trim().slice(0, 300) : null;
  return { notes, blocked, packageHint: obj.pacote === true, visitHint: obj.visita === true };
}
