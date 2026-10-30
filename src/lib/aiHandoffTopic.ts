// "O que a IA passou para a equipe": a maioria das passagens é assunto da
// equipe (fechar, pagar, degustação, data no recesso…) e não falta de
// informação. Nessas não cabe "Ensinar" — virava regra fixa sobre um cliente.

const TEAM_TOPIC_RE = new RegExp(
  [
    "fech", "contrat", "assin", "pagament", "parcel", "pix", "boleto", "cart[ãa]o de cr[ée]dito",
    "desconto", "negocia", "condi[çc]", "valor especial", "or[çc]amento personalizado",
    "degusta", "recesso", "j[áa] reservad", "ocupad", "sem datas livres", "disponibilidade",
    "visita", "remarc", "cancel", "reclama", "insatisf", "reembols", "estorno",
    "permuta", "parceri", "quer trabalhar", "curr[ií]culo", "vaga de", "fornecedor",
    "pediu (um |uma |para falar com )?(atendente|pessoa|humano)", "falar com (um |uma )?(atendente|pessoa|humano)",
  ].join("|"),
  "i",
);

/** A passagem foi por um assunto que é da equipe (não uma dúvida que a IA não sabia)? */
export function isTeamTopic(reason: string): boolean {
  return TEAM_TOPIC_RE.test(reason || "");
}

/** Marca do ensinamento que veio de uma passagem (ai_owner_notes.source) */
export const handoffTeachSource = (historyId: string) => `passagem:${historyId}`;
