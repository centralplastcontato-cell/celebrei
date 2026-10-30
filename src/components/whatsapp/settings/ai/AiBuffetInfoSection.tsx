// Configurações → IA → Sobre o buffet: o que a IA pode afirmar (endereço,
// estrutura, diferenciais, respostas rápidas e regras). Tudo vira o texto
// "INFORMAÇÕES DO BUFFET" que a IA lê (src/lib/aiBuffetFields.ts).

import { useEffect, useMemo, useState } from "react";
import { SelectOrCustom } from "./SelectOrCustom";
import { Check, ListChecks, Loader2, MapPin, ShieldCheck, Sparkles } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import { BUFFET_FIELDS, OPTIONAL_BUFFET_FIELDS, parseBuffetInfo, serializeBuffetInfo, toggleSuggestion } from "@/lib/aiBuffetFields";
import { AiCard, SaveBar } from "./AiFormBits";
import { useAiAgentSettings } from "./useAiAgentSettings";

const SECTIONS = [
  { group: "basico", title: "O básico", icon: <MapPin className="h-4 w-4 text-violet-600" />, description: "Onde fica e como é a festa." },
  { group: "estrutura", title: "Estrutura e diferenciais", icon: <Sparkles className="h-4 w-4 text-pink-600" />, description: "O que o espaço tem e por que escolher vocês." },
  { group: "perguntas", title: "Respostas rápidas", icon: <ListChecks className="h-4 w-4 text-sky-600" />, description: "As perguntas que todo cliente faz. É só escolher a resposta certa." },
  { group: "regras", title: "Regras", icon: <ShieldCheck className="h-4 w-4 text-amber-600" />, description: "Limites claros evitam que a IA prometa o que vocês não fazem." },
] as const;

export function AiBuffetInfoSection() {
  const { settings, loading, saving, persist } = useAiAgentSettings();
  const [saved, setSaved] = useState<Record<string, string> | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!settings || saved) return;
    const initial = parseBuffetInfo(settings.extra_instructions);
    setSaved(initial);
    setValues(initial);
  }, [settings, saved]);

  const dirty = useMemo(() => !!saved && serializeBuffetInfo(values) !== serializeBuffetInfo(saved), [values, saved]);

  if (loading || !settings || !saved) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground p-4"><Loader2 className="w-4 h-4 animate-spin" /> Carregando...</div>;
  }

  const setField = (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    const ok = await persist({ extra_instructions: serializeBuffetInfo(values) });
    if (ok) {
      const fresh = parseBuffetInfo(ok.extra_instructions);
      setSaved(fresh);
      setValues(fresh);
      toast({ title: "Salvo", description: "A IA passa a usar essas informações na hora." });
    }
  };

  return (
    <div className="space-y-4">
      <p className="px-1 text-xs leading-relaxed text-muted-foreground">
        Só coloque o que é verdade: a IA usa essas informações com os clientes. O que não estiver aqui, ela passa para a equipe.
      </p>
      {SECTIONS.map((sec) => {
        const fields = BUFFET_FIELDS.filter((f) => f.group === sec.group);
        const required = fields.filter((f) => !OPTIONAL_BUFFET_FIELDS.has(f.key));
        const filled = required.filter((f) => (values[f.key] || "").trim()).length;
        const complete = filled === required.length;
        return (
          <AiCard
            key={sec.group}
            icon={sec.icon}
            title={sec.title}
            description={sec.description}
            action={
              <span className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${complete ? "bg-green-500/15 text-green-700 dark:text-green-400" : "bg-muted text-muted-foreground"}`}>
                {complete ? <><Check className="h-3 w-3" /> Completo</> : `${filled} de ${required.length}`}
              </span>
            }
          >
            <div className="space-y-4">
              {fields.map((f) => {
                // Campo importante em branco: destacado para a pessoa achar o que falta
                const missing = !OPTIONAL_BUFFET_FIELDS.has(f.key) && !(values[f.key] || "").trim();
                return (
                <div key={f.key} className={`space-y-1.5 ${missing ? "rounded-xl ring-2 ring-amber-400/70 bg-amber-500/5 p-2 -m-2" : ""}`}>
                  <Label className="text-xs font-bold flex items-center gap-2" htmlFor={`ai-f-${f.key}`}>
                    {f.label}
                    {missing && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300">Falta preencher</span>}
                  </Label>
                  {f.hint && <p className="text-[11px] text-muted-foreground">{f.hint}</p>}
                  {f.type === "select" ? (
                    <SelectOrCustom id={`ai-f-${f.key}`} value={values[f.key] || ""} options={f.options || []} onChange={(v) => setField(f.key, v)}
                      triggerClassName="h-auto min-h-10 py-2 text-left bg-card border-border shadow-sm" />
                  ) : f.type === "textarea" ? (
                    <>
                      <Textarea id={`ai-f-${f.key}`} value={values[f.key] || ""} onChange={(e) => setField(f.key, e.target.value)} rows={4}
                        className="text-base sm:text-sm resize-none" placeholder={`Ex.: ${f.placeholder}`} />
                      {f.suggestions && (
                        <div className="space-y-1.5">
                          <p className="text-[11px] text-muted-foreground">💡 Sugestões: toque para acrescentar (toque de novo para tirar). Depois ajuste do jeito do seu buffet.</p>
                          <div className="flex flex-wrap gap-1.5">
                            {f.suggestions.map((sug) => {
                              const on = (values[f.key] || "").includes(sug);
                              return (
                                <button key={sug} type="button" onClick={() => setField(f.key, toggleSuggestion(values[f.key] || "", sug, f.joiner))}
                                  className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${on ? "border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300" : "border-border bg-card text-foreground hover:border-violet-400"}`}>
                                  {on ? "✓ " : "+ "}{sug}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <Input id={`ai-f-${f.key}`} value={values[f.key] || ""} onChange={(e) => setField(f.key, e.target.value)}
                      className="h-10 text-base sm:text-sm" placeholder={`Ex.: ${f.placeholder}`} />
                  )}
                </div>
                );
              })}
            </div>
          </AiCard>
        );
      })}
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={() => setValues(saved)} />
    </div>
  );
}
