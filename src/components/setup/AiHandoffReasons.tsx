import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { CheckCircle2, GraduationCap, Loader2, Users } from "lucide-react";
import { handoffTeachSource, isTeamTopic } from "@/lib/aiHandoffTopic";
import { AiTeachDialog, type TeachContext } from "./AiTeachDialog";

const DAYS = 30;
// Lista curta; o resto fica em "Ver todos"
const FIRST = 5;

interface Handoff { id: string; created_at: string; lead_id: string | null; reason: string; name: string | null }

/**
 * Por que a IA passou clientes para a equipe (últimos 30 dias), lido do
 * histórico do lead que a IA já grava ("Transferido para a equipe"). Quando
 * era uma dúvida que a IA não sabia, o dono ensina pelo "Ensinar a IA" (a IA
 * organiza, ele revisa e confirma). Fechamento, pagamento, degustação etc.
 * são assunto da equipe: sem "Ensinar".
 */
export function AiHandoffReasons({ companyId }: { companyId: string }) {
  const [items, setItems] = useState<Handoff[] | null>(null);
  const [taught, setTaught] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [teaching, setTeaching] = useState<Handoff | null>(null);

  const load = useCallback(async () => {
    const since = new Date(Date.now() - DAYS * 86400000).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    const [{ data }, { data: notes }] = await Promise.all([
      sb.from("lead_history").select("id, created_at, lead_id, new_value")
        .eq("company_id", companyId).eq("user_name", "IA (beta)").eq("action", "Transferido para a equipe")
        .gte("created_at", since).order("created_at", { ascending: false }).limit(50),
      // Ensinado a partir de uma passagem: vale em qualquer aparelho
      sb.from("ai_owner_notes").select("source").eq("company_id", companyId).like("source", "passagem:%"),
    ]);
    const rows = (data || []) as Array<{ id: string; created_at: string; lead_id: string | null; new_value: string | null }>;
    const ids = [...new Set(rows.map((r) => r.lead_id).filter(Boolean))] as string[];
    const names: Record<string, string> = {};
    if (ids.length) {
      const { data: leads } = await sb.from("campaign_leads").select("id, name").in("id", ids);
      for (const l of (leads || []) as Array<{ id: string; name: string | null }>) if (l.name) names[l.id] = l.name;
    }
    setTaught(new Set(((notes || []) as Array<{ source: string }>).map((n) => n.source)));
    setItems(rows.map((r) => ({
      id: r.id, created_at: r.created_at, lead_id: r.lead_id,
      reason: (r.new_value || "").replace(/^Motivo:\s*/i, "").trim() || "sem motivo informado",
      name: r.lead_id ? names[r.lead_id] || null : null,
    })));
  }, [companyId]);
  useEffect(() => { load(); }, [load]);

  // Mesmo objeto enquanto o diálogo está aberto (o diálogo limpa o texto quando o contexto muda)
  const context = useMemo<TeachContext | null>(
    () => (teaching ? { motivo: teaching.reason, source: handoffTeachSource(teaching.id) } : null),
    [teaching],
  );

  if (!items) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;

  const visible = showAll ? items : items.slice(0, FIRST);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Toda vez que a IA passa um cliente para a equipe, ela anota o motivo. Se foi uma dúvida que ela não sabia,
        toque em "Ensinar" e explique: da próxima vez ela mesma responde. Fechamento, pagamento, degustação e afins
        são assunto da equipe: a IA passou certo.
      </p>
      {items.length === 0 ? (
        <p className="rounded-md bg-muted/60 p-3 text-sm text-muted-foreground">Nos últimos {DAYS} dias a IA não passou nenhum cliente para a equipe.</p>
      ) : (
        <>
          <ul className="space-y-2">
            {visible.map((it) => {
              const done = taught.has(handoffTeachSource(it.id));
              const team = isTeamTopic(it.reason);
              return (
                <li key={it.id} className="flex items-start justify-between gap-2 rounded-lg border p-3">
                  <div className="min-w-0">
                    <p className="text-sm">{it.reason}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(it.created_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}
                      {it.name ? ` · ${it.name}` : ""}
                    </p>
                  </div>
                  {done ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-green-700"><CheckCircle2 className="h-3.5 w-3.5" /> Ensinado</span>
                  ) : team ? (
                    <span className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      <Users className="h-3 w-3" /> assunto da equipe
                    </span>
                  ) : (
                    <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={() => setTeaching(it)}>
                      <GraduationCap className="mr-1.5 h-3.5 w-3.5" /> Ensinar
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {items.length > FIRST && (
            <Button type="button" variant="ghost" size="sm" className="w-full" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Mostrar menos" : `Ver todos (${items.length})`}
            </Button>
          )}
        </>
      )}
      <AiTeachDialog
        open={!!teaching}
        onOpenChange={(v) => { if (!v) setTeaching(null); }}
        companyId={companyId}
        context={context}
        onSaved={load}
      />
    </div>
  );
}
