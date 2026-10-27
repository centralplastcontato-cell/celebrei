// Bolinha ao lado do horário das mensagens enviadas: quem mandou.
// 🟡 equipe pela plataforma · 🟣 IA · ⚪ celular do buffet (fora da plataforma).
// Automações (follow-up, retorno combinado, confirmação de visita…) não têm
// bolinha: ganham uma etiqueta curta com texto (senderTag), que dá para ler no celular.

type Meta = { source?: unknown; type?: unknown; form_type?: unknown } | null | undefined;

export interface SenderDot {
  className: string;
  title: string;
}

const metaOf = (msg: { metadata?: unknown }) => (msg.metadata && typeof msg.metadata === "object" ? msg.metadata : null) as Meta;

export function senderDot(msg: { from_me: boolean; metadata?: unknown }): SenderDot | null {
  if (!msg.from_me) return null;
  const meta = metaOf(msg);
  const source = meta?.source;
  if (source === "platform" && !meta?.type) return { className: "bg-yellow-400", title: "Enviado pela plataforma (equipe)" };
  if (source === "ai_agent" || source === "bia") return { className: "bg-purple-500", title: "Enviado pela IA" };
  if (source === "phone") return { className: "bg-white ring-1 ring-black/20", title: "Enviado pelo celular do buffet" };
  return null;
}

const AUTOMATION_TAGS: Record<string, string> = {
  scheduled_return: "🔁 Retorno combinado",
  auto_reminder: "⏰ Lembrete automático",
  visit_confirmation: "✅ Confirmação de visita",
  post_visit: "💬 Pós-visita",
  client_data: "📝 Pedido de dados",
  reactivation_engine: "🔄 Reativação",
  campaign: "📣 Campanha",
};

/** Etiqueta das mensagens enviadas por automação (Glaucia, 26/10: ninguém sabia quem tinha mandado). */
export function senderTag(msg: { from_me: boolean; metadata?: unknown }): string | null {
  if (!msg.from_me) return null;
  const meta = metaOf(msg);
  const source = meta?.source;
  if (source === "form_auto") return meta?.form_type === "avaliacao" ? "⭐ Avaliação automática" : "🍽️ Cardápio automático";
  return typeof source === "string" ? AUTOMATION_TAGS[source] ?? null : null;
}
