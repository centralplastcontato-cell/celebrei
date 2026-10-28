// Configurações → IA → Técnico (só administrador da Celebrei): modelo de IA,
// consumo, número de teste, simulador de testes e questionário.

import { useEffect, useMemo, useState } from "react";
import { ClipboardList, Cpu, FlaskConical, Loader2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { AI_MODELS, DEFAULT_AI_MODEL, estimateTypicalConversationUsd, formatBrlFromUsd, getAiModel, summarizeAiUsage } from "@/lib/aiModels";
import { QUESTIONNAIRE_COMPANY_IDS } from "@/lib/aiQuestionnaire";
import { AiSimulatorDialog } from "../AiSimulatorDialog";
import { AiQuestionnaireTab } from "../AiQuestionnaireTab";
import { AiCard, SaveBar } from "./AiFormBits";
import { USAGE_WINDOW_DAYS, useAiAgentSettings, type AiAgentSettings } from "./useAiAgentSettings";

// Valor do Select para "mesmo modelo dos clientes" (o Select não aceita "")
const SAME_MODEL = "__same__";

function modelLabel(id: string): string {
  return getAiModel(id)?.label || id;
}

function ModelOption({ id }: { id: string }) {
  const m = getAiModel(id);
  if (!m) return <span>{id}</span>;
  return (
    <span className="flex flex-col items-start">
      <span className="font-semibold">{m.label}</span>
      <span className="text-[11px] opacity-70">{m.hint} · ≈ {formatBrlFromUsd(estimateTypicalConversationUsd(m.id))}/conversa</span>
    </span>
  );
}

function UsageTable({ title, rows }: { title: string; rows: ReturnType<typeof summarizeAiUsage> }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-bold text-muted-foreground uppercase tracking-wide">{title}</p>
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/60 text-muted-foreground">
            <tr>
              <th className="text-left font-semibold px-2.5 py-1.5">Modelo</th>
              <th className="text-right font-semibold px-2.5 py-1.5">Conversas</th>
              <th className="text-right font-semibold px-2.5 py-1.5">Total</th>
              <th className="text-right font-semibold px-2.5 py-1.5">Média</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.model} className="border-t border-border/60">
                <td className="px-2.5 py-1.5">{getAiModel(u.model)?.label.replace(/ \((OpenAI|Anthropic)\)$/, "") || u.model}</td>
                <td className="px-2.5 py-1.5 text-right tabular-nums">{u.conversations}</td>
                <td className="px-2.5 py-1.5 text-right tabular-nums">{formatBrlFromUsd(u.totalUsd)}</td>
                <td className="px-2.5 py-1.5 text-right tabular-nums font-semibold">{formatBrlFromUsd(u.avgPerConversationUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface Draft {
  model: string;
  testModel: string;
  testNumber: string;
  testOnly: boolean;
}

function draftFrom(s: AiAgentSettings): Draft {
  return {
    model: s.model || DEFAULT_AI_MODEL,
    testModel: s.test_model || SAME_MODEL,
    testNumber: s.test_mode_number || "",
    testOnly: s.test_mode_enabled || false,
  };
}

export function AiTechSection() {
  const { companyId, settings, usageRows, loading, saving, persist } = useAiAgentSettings();
  const [saved, setSaved] = useState<Draft | null>(null);
  const [d, setD] = useState<Draft | null>(null);
  const [simOpen, setSimOpen] = useState(false);

  useEffect(() => {
    if (!settings || saved) return;
    const initial = draftFrom(settings);
    setSaved(initial);
    setD(initial);
  }, [settings, saved]);

  const dirty = useMemo(() => !!d && !!saved && JSON.stringify(d) !== JSON.stringify(saved), [d, saved]);

  if (loading || !settings || !d) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground p-4"><Loader2 className="w-4 h-4 animate-spin" /> Carregando...</div>;
  }

  const set = <K extends keyof Draft>(key: K) => (value: Draft[K]) => setD((prev) => (prev ? { ...prev, [key]: value } : prev));
  const clientUsage = summarizeAiUsage(usageRows.filter((r) => !r.is_test));
  const testUsage = summarizeAiUsage(usageRows.filter((r) => r.is_test));
  const showQuestionnaire = !!companyId && QUESTIONNAIRE_COMPANY_IDS.includes(companyId);

  const save = async () => {
    if (d.testOnly && !d.testNumber.trim()) {
      toast({ title: "Informe o número de teste", description: "Preencha o WhatsApp que vai testar a IA sozinho.", variant: "destructive" });
      return;
    }
    const ok = await persist({
      model: d.model,
      test_mode_enabled: d.testOnly,
      // O número de teste fica guardado mesmo com o teste desligado: ele
      // continua falando sempre com a IA e aceitando #reiniciar
      test_mode_number: d.testNumber.trim() || null,
      test_model: d.testNumber.trim() && d.testModel !== SAME_MODEL && d.testModel !== d.model ? d.testModel : null,
    });
    if (ok) {
      const fresh = draftFrom(ok);
      setSaved(fresh);
      setD(fresh);
      toast({ title: "Salvo" });
    }
  };

  return (
    <div className="space-y-4">
      <p className="px-1 text-xs text-muted-foreground">Só administradores da Celebrei veem esta página.</p>

      <AiCard icon={<Cpu className="h-4 w-4 text-violet-600" />} title="Modelo de IA (clientes)"
        description="Modelos Claude precisam da chave da Anthropic cadastrada no Supabase; sem ela, a IA usa o GPT-5.4.">
        <Select value={d.model} onValueChange={set("model")}>
          <SelectTrigger className="h-auto min-h-10 py-1.5 text-left" aria-label="Modelo de IA"><SelectValue>{modelLabel(d.model)}</SelectValue></SelectTrigger>
          <SelectContent>
            {AI_MODELS.map((m) => <SelectItem key={m.id} value={m.id} className="py-2"><ModelOption id={m.id} /></SelectItem>)}
          </SelectContent>
        </Select>
        {clientUsage.length > 0 || testUsage.length > 0 ? (
          <div className="space-y-3 pt-1">
            <p className="text-xs font-bold flex items-center gap-1.5"><Wallet className="w-3.5 h-3.5 text-green-600" /> Consumo real — últimos {USAGE_WINDOW_DAYS} dias</p>
            <UsageTable title="Clientes" rows={clientUsage} />
            <UsageTable title="Número de teste" rows={testUsage} />
            <p className="text-[10px] text-muted-foreground">Inclui áudios transcritos e fotos. Valores em reais aproximados (cotação fixa).</p>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5"><Wallet className="w-3.5 h-3.5" /> O consumo real aparece aqui depois das primeiras conversas.</p>
        )}
      </AiCard>

      <AiCard icon={<FlaskConical className="h-4 w-4 text-amber-600" />} title="Número de teste"
        description={<>Esse WhatsApp sempre conversa com a IA, mesmo depois de liberada para todos. Mande <span className="font-bold">#reiniciar</span> dele para a IA começar do zero.</>}>
        <Input value={d.testNumber} onChange={(e) => set("testNumber")(e.target.value)} className="h-10 text-base sm:text-sm" placeholder="Ex.: 15 98112-1710" aria-label="Número de teste" />
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs font-bold">Só esse número fala com a IA</Label>
          <Switch checked={d.testOnly} onCheckedChange={set("testOnly")} aria-label="Só esse número fala com a IA" />
        </div>
        <p className="text-[11px] text-muted-foreground">
          {d.testOnly ? "Ligado: os outros clientes continuam com o bot de sempre." : "Desligado: a IA atende os leads novos do número; o seu continua sendo o de teste."}
        </p>
        {d.testNumber.trim() && (
          <div className="space-y-1.5">
            <Label className="text-xs font-bold">Modelo no número de teste</Label>
            <Select value={d.testModel} onValueChange={set("testModel")}>
              <SelectTrigger className="h-auto min-h-10 py-1.5 text-left" aria-label="Modelo no número de teste">
                <SelectValue>{d.testModel === SAME_MODEL ? "O mesmo dos clientes" : modelLabel(d.testModel)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SAME_MODEL} className="py-2">O mesmo dos clientes</SelectItem>
                {AI_MODELS.map((m) => <SelectItem key={m.id} value={m.id} className="py-2"><ModelOption id={m.id} /></SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
      </AiCard>

      <AiCard icon={<FlaskConical className="h-4 w-4 text-violet-600" />} title="Testes automáticos"
        description="Simula umas 30 conversas de clientes (preço, datas, desconto, visita, formatura…) e mostra o que passou e o que falhou. Não envia nada pelo WhatsApp."
        action={<Button size="sm" variant="outline" className="shrink-0" onClick={() => setSimOpen(true)}>Rodar testes</Button>} />

      {showQuestionnaire && companyId && (
        <AiCard icon={<ClipboardList className="h-4 w-4 text-sky-600" />} title="Questionário">
          <AiQuestionnaireTab companyId={companyId} />
        </AiCard>
      )}

      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={() => saved && setD(saved)} />
      <AiSimulatorDialog open={simOpen} onOpenChange={setSimOpen} model={(settings.test_mode_enabled && settings.test_model) || settings.model || DEFAULT_AI_MODEL} />
    </div>
  );
}
