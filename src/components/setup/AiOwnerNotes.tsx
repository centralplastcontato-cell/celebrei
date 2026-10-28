import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { GraduationCap, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AiTeachDialog } from "./AiTeachDialog";

interface OwnerNote {
  id: string;
  text: string;
  kind: string;
  is_active: boolean;
  created_at: string;
}

/** "O que você ensinou à IA": lista para ligar/desligar ou apagar, e o botão de ensinar */
export function AiOwnerNotes({ companyId, refreshKey = 0 }: { companyId: string; refreshKey?: number }) {
  const [notes, setNotes] = useState<OwnerNote[] | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await (supabase as any).from("ai_owner_notes")
      .select("id, text, kind, is_active, created_at").eq("company_id", companyId).order("created_at", { ascending: false });
    setNotes(error ? [] : ((data || []) as OwnerNote[]));
  }, [companyId]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const toggle = async (n: OwnerNote, on: boolean) => {
    setNotes((l) => l && l.map((x) => (x.id === n.id ? { ...x, is_active: on } : x)));
    const { error } = await (supabase as any).from("ai_owner_notes").update({ is_active: on, updated_at: new Date().toISOString() }).eq("id", n.id);
    if (error) { toast.error("Não consegui salvar"); load(); }
  };

  const remove = async (n: OwnerNote) => {
    if (!window.confirm("Apagar este ensinamento? A IA deixa de seguir.")) return;
    const { error } = await (supabase as any).from("ai_owner_notes").delete().eq("id", n.id);
    if (error) toast.error("Não consegui apagar");
    load();
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Escreva ou fale o que a IA deve saber ou fazer diferente no seu buffet. Ela passa a seguir na hora, no teste e com os clientes.
      </p>
      <Button onClick={() => setOpen(true)} className="w-full gap-2 sm:w-auto"><GraduationCap className="h-4 w-4" /> Ensinar a IA</Button>
      {notes === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : notes.length > 0 && (
        <div className="space-y-2 pt-1">
          <p className="text-xs font-medium text-muted-foreground">O que você já ensinou ({notes.length})</p>
          {notes.map((n) => (
            <div key={n.id} className={`flex items-start gap-2 rounded-lg border p-2.5 ${n.is_active ? "" : "opacity-60"}`}>
              <p className="flex-1 text-sm">{n.text}</p>
              <Switch checked={n.is_active} onCheckedChange={(v) => toggle(n, v)} aria-label={n.is_active ? "Desligar" : "Ligar"} />
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label="Apagar" onClick={() => remove(n)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <AiTeachDialog open={open} onOpenChange={setOpen} companyId={companyId} onSaved={load} />
    </div>
  );
}
