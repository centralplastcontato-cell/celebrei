import { useEffect, useState } from "react";
import { SelectOrCustom } from "./ai/SelectOrCustom";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Check, ClipboardList, Loader2, Save, Send, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import {
  cleanAnswers,
  prefillFromSettings,
  isAnswered,
  QUESTIONNAIRE,
  questionnaireProgress,
  sectionProgress,
  type QuestionnaireAnswers,
} from "@/lib/aiQuestionnaire";

export interface ChecklistItem {
  label: string;
  done: boolean;
  detail?: string;
}

interface Row {
  answers: QuestionnaireAnswers | null;
  status: string | null;
  submitted_at: string | null;
  updated_at: string | null;
}

/**
 * Questionário da IA — a única coisa que o buffet preenche (aba "Questionário"
 * do Configurar IA, e o card próprio para quem ainda não tem a IA). Enquanto
 * não enviar, a equipe Celebrei não liga a IA para ele. As respostas ficam
 * salvas à parte (ai_questionnaires) e não mudam a IA sozinhas.
 */
export function AiQuestionnaireTab({ companyId }: { companyId: string }) {
  const [answers, setAnswers] = useState<QuestionnaireAnswers>({});
  const [row, setRow] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any;
    Promise.all([
      db.from("ai_questionnaires").select("answers, status, submitted_at, updated_at").eq("company_id", companyId).maybeSingle(),
      // O que já está cadastrado na IA aparece preenchido (só onde não há resposta salva)
      db.from("ai_agent_settings").select("extra_instructions, assistant_name, visit_hours, team_hours, party_slots").eq("company_id", companyId).limit(1).maybeSingle(),
    ]).then(([q, st]: Array<{ data: any; error: { message: string } | null }>) => {
      if (cancelled) return;
      if (q.error) setUnavailable(true);
      setRow(q.data);
      setAnswers({ ...prefillFromSettings(st.data), ...((q.data?.answers as QuestionnaireAnswers) || {}) });
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [companyId]);

  // Pacotes e tabela de preços ficam fora deste modal (cadastro de pacotes)
  const [catalog, setCatalog] = useState<ChecklistItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any;
    Promise.all([
      db.from("company_packages").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("is_active", true),
      db.from("package_price_tiers").select("id", { count: "exact", head: true }).eq("company_id", companyId),
    ]).then(([pk, pr]: Array<{ count: number | null }>) => {
      if (cancelled) return;
      setCatalog([
        { label: "Pacotes com o que cada um inclui (cadastro de pacotes)", done: (pk.count || 0) > 0, detail: `${pk.count || 0} ativo(s)` },
        { label: "Tabela de preços por convidados e dia", done: (pr.count || 0) > 0, detail: (pr.count || 0) > 0 ? `${pr.count} valores` : "vazia" },
      ]);
    });
    return () => { cancelled = true; };
  }, [companyId]);

  const progress = questionnaireProgress(answers);
  const submitted = row?.status === "enviado";
  const set = (key: string, value: string | string[]) => setAnswers((prev) => ({ ...prev, [key]: value }));

  const save = async (submit: boolean) => {
    if (submit && progress.missing.length > 0) {
      toast({ title: "Faltam respostas", description: `Responda: ${progress.missing.slice(0, 2).map((q) => q.label).join("; ")}${progress.missing.length > 2 ? "…" : ""}`, variant: "destructive" });
      return;
    }
    setSaving(true);
    const now = new Date().toISOString();
    const payload = {
      company_id: companyId,
      answers: cleanAnswers(answers),
      status: submit || submitted ? "enviado" : "rascunho",
      submitted_at: submit ? now : row?.submitted_at || null,
      updated_at: now,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from("ai_questionnaires").upsert(payload, { onConflict: "company_id" });
    setSaving(false);
    if (error) {
      toast({ title: "Não foi possível salvar", description: error.message, variant: "destructive" });
      return;
    }
    setRow({ answers: payload.answers, status: payload.status, submitted_at: payload.submitted_at, updated_at: now });
    toast({
      title: submit ? "Questionário enviado" : "Respostas salvas",
      description: submit ? "Obrigado! A equipe Celebrei vai usar suas respostas para preparar a IA do seu buffet." : "Você pode continuar depois.",
    });
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground py-6"><Loader2 className="w-4 h-4 animate-spin" /> Carregando questionário…</div>;
  }
  if (unavailable) {
    return <p className="text-sm text-muted-foreground py-6">O questionário ainda não está disponível.</p>;
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-violet-300/50 bg-violet-500/5 p-3.5 space-y-2">
        <p className="text-sm font-bold flex items-center gap-2"><ClipboardList className="w-4 h-4 text-violet-600" /> Antes de ligar a IA</p>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Responda como a IA deve atender os clientes do seu buffet. Com essas respostas a equipe Celebrei prepara a IA no seu jeito.
          <strong> Enquanto o questionário não for enviado, a IA não é ligada.</strong> Leva uns 20 minutos e dá para salvar e continuar depois.
        </p>
        <div className="flex items-center gap-2 pt-1">
          <div className="h-2 flex-1 rounded-full bg-border/70 overflow-hidden">
            <div className="h-full bg-violet-500 transition-all" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
          </div>
          <span className="text-[11px] font-bold text-muted-foreground whitespace-nowrap">{progress.done}/{progress.total}</span>
        </div>
        {submitted && row?.submitted_at && (
          <p className="text-[11px] font-bold text-green-700 flex items-center gap-1">
            <Check className="w-3.5 h-3.5" /> Enviado em {new Date(row.submitted_at).toLocaleDateString("pt-BR")} — se mudar algo, salve de novo.
          </p>
        )}
      </div>

      {/* O que já tem campo nas outras abas e nos cadastros */}
      <div className="rounded-xl border border-border bg-card p-3.5 space-y-2">
        <p className="text-xs font-bold">Também precisa estar cadastrado na plataforma</p>
        <ul className="space-y-1.5">
          {catalog.map((c) => (
            <li key={c.label} className="flex items-start gap-2 text-xs">
              <span className={`mt-0.5 w-4 h-4 rounded-full flex items-center justify-center shrink-0 ${c.done ? "bg-green-500/15 text-green-700" : "bg-border/70 text-muted-foreground"}`}>
                {c.done ? <Check className="w-3 h-3" /> : <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60" />}
              </span>
              <span className={c.done ? "text-foreground" : "text-muted-foreground"}>
                {c.label}{c.detail ? <span className="text-muted-foreground"> — {c.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {QUESTIONNAIRE.map((section, si) => {
        const sp = sectionProgress(section, answers);
        return (
          <div key={section.id} className="space-y-3">
            <div className="flex items-baseline justify-between gap-2 border-b border-border/40 pb-1.5">
              <div>
                <p className="text-sm font-bold">{si + 1}. {section.title}</p>
                <p className="text-[11px] text-muted-foreground">{section.description}</p>
              </div>
              <span className={`text-[10px] font-extrabold rounded-full px-1.5 py-0.5 shrink-0 ${sp.done === sp.total ? "bg-green-500/15 text-green-700" : "bg-border/70 text-muted-foreground"}`}>
                {sp.done === sp.total ? <Check className="w-3 h-3" /> : `${sp.done}/${sp.total}`}
              </span>
            </div>
            {section.questions.map((q) => (
              <div key={q.key} className="space-y-1.5">
                <Label className="text-xs font-bold">
                  {q.label}
                  {q.optional ? <span className="font-normal text-muted-foreground"> (opcional)</span> : null}
                </Label>
                {q.hint && <p className="text-[11px] text-muted-foreground">{q.hint}</p>}
                {q.type === "select" && (
                  q.allowCustom ? (
                    <SelectOrCustom value={typeof answers[q.key] === "string" ? (answers[q.key] as string) : ""} options={q.options || []} onChange={(v) => set(q.key, v)}
                      triggerClassName="h-auto min-h-10 bg-card border-border shadow-sm text-left whitespace-normal" />
                  ) : (
                  <Select value={typeof answers[q.key] === "string" ? (answers[q.key] as string) : ""} onValueChange={(v) => set(q.key, v)}>
                    <SelectTrigger className="h-auto min-h-10 bg-card border-border shadow-sm text-left whitespace-normal">
                      <SelectValue placeholder="Selecione uma opção" />
                    </SelectTrigger>
                    <SelectContent>
                      {(q.options || []).map((opt) => <SelectItem key={opt} value={opt}>{opt}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  )
                )}
                {q.type === "multi" && (
                  <div className="space-y-2 rounded-xl border border-border bg-card p-3">
                    {(q.options || []).map((opt) => {
                      const list = Array.isArray(answers[q.key]) ? (answers[q.key] as string[]) : [];
                      const checked = list.includes(opt);
                      return (
                        <label key={opt} className="flex items-center gap-2 text-sm cursor-pointer">
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(v) => set(q.key, v ? [...list, opt] : list.filter((o) => o !== opt))}
                          />
                          {opt}
                        </label>
                      );
                    })}
                  </div>
                )}
                {q.type === "text" && (
                  <Input
                    value={typeof answers[q.key] === "string" ? (answers[q.key] as string) : ""}
                    onChange={(e) => set(q.key, e.target.value)}
                    placeholder={q.placeholder}
                    className="h-10 text-base sm:text-sm bg-card border-border shadow-sm"
                  />
                )}
                {q.type === "textarea" && (
                  <Textarea
                    value={typeof answers[q.key] === "string" ? (answers[q.key] as string) : ""}
                    onChange={(e) => set(q.key, e.target.value)}
                    rows={q.key === "conversas" ? 8 : 3}
                    placeholder={q.placeholder}
                    className={`text-base sm:text-sm bg-card border-border shadow-sm ${isAnswered(q, answers[q.key]) ? "" : "border-dashed"}`}
                  />
                )}
              </div>
            ))}
          </div>
        );
      })}

      <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end pt-1">
        <Button variant="outline" onClick={() => void save(false)} disabled={saving} className="w-full sm:w-auto">
          {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          Salvar e continuar depois
        </Button>
        <Button onClick={() => void save(true)} disabled={saving} className="w-full sm:w-auto">
          <Send className="w-4 h-4 mr-2" />
          {submitted ? "Salvar respostas" : "Enviar questionário"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Card na central de automações para o buffet que ainda não tem a IA: abre só
 * o questionário (as configurações técnicas da IA ficam com a equipe Celebrei).
 */
export function AiQuestionnaireCard({ companyId }: { companyId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="relative rounded-2xl bg-card p-5 flex flex-col gap-3 border border-dashed border-violet-400/60 shadow-sm">
        <div className="w-11 h-11 rounded-xl bg-violet-500/10 flex items-center justify-center">
          <Sparkles className="w-6 h-6 text-violet-600" />
        </div>
        <div>
          <h4 className="font-display font-medium text-base">IA Conversacional</h4>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1 leading-relaxed">
            Atende seus leads no WhatsApp a qualquer hora, tira dúvidas e agenda visitas. Para ligar, responda o questionário — é com ele que preparamos a IA no jeito do seu buffet.
          </p>
        </div>
        <div className="mt-auto pt-1">
          <Button size="sm" onClick={() => setOpen(true)} className="gap-1.5">
            <ClipboardList className="w-4 h-4" />
            Responder questionário
          </Button>
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[580px] max-h-[92vh] flex flex-col p-0 gap-0 rounded-2xl">
          <DialogHeader className="px-5 sm:px-6 pt-5 pb-3 border-b border-border/40">
            <DialogTitle className="flex items-center gap-2 text-base">
              <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0">
                <Sparkles className="w-5 h-5 text-violet-600" />
              </div>
              Questionário da IA
            </DialogTitle>
          </DialogHeader>
          <div className="overflow-y-auto px-5 sm:px-6 py-4 flex-1">
            <AiQuestionnaireTab companyId={companyId} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
