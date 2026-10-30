// Configurações → IA → Visão geral: liga/desliga, números atendidos, vídeo de
// ajuda e a lista do que falta para a IA ficar pronta (cada item leva para
// onde se preenche).

/* eslint-disable @typescript-eslint/no-explicit-any -- tabelas fora dos tipos gerados */
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Check, ChevronRight, Loader2, PlayCircle, Smartphone, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { buffetInfoProgress } from "@/lib/aiBuffetFields";
import { firstLessonOf } from "@/lib/lessons";
import { confirmLeaveUnsaved } from "@/lib/unsavedChanges";
import { cn } from "@/lib/utils";
import { AiCard } from "./AiFormBits";
import { useAiAgentSettings } from "./useAiAgentSettings";

interface CatalogCounts {
  packages: number;
  tiers: number;
  photos: boolean;
  video: boolean;
  pdf: boolean;
}

interface ChecklistItem {
  label: string;
  detail?: string;
  done: boolean;
  /** item de Configurações (?item=) ou caminho de outra tela */
  item?: string;
  path?: string;
}

export function AiOverviewSection() {
  const { companyId, settings, units, usageRows, loading, saving, persist } = useAiAgentSettings();
  const [, setSearchParams] = useSearchParams();
  const [catalog, setCatalog] = useState<CatalogCounts | null>(null);
  const [howToLessonId, setHowToLessonId] = useState<string | null>(null);

  useEffect(() => { firstLessonOf("Inteligência Artificial").then(setHowToLessonId); }, []);

  useEffect(() => {
    if (!companyId) return;
    const db = supabase as any;
    Promise.all([
      db.from("company_packages").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("is_active", true),
      db.from("package_price_tiers").select("id", { count: "exact", head: true }).eq("company_id", companyId),
      db.from("sales_materials").select("type").eq("company_id", companyId).eq("is_active", true),
    ]).then(([pk, pr, mat]: Array<{ count?: number | null; data?: Array<{ type: string }> | null }>) => {
      const types = new Set((mat.data || []).map((m) => m.type));
      setCatalog({
        packages: pk.count || 0,
        tiers: pr.count || 0,
        photos: types.has("photo_collection") || types.has("photo"),
        video: types.has("video"),
        pdf: types.has("pdf_package"),
      });
    });
  }, [companyId]);

  if (loading || !settings) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground p-4"><Loader2 className="w-4 h-4 animate-spin" /> Carregando IA...</div>;
  }

  const openItem = (id: string) => {
    if (!confirmLeaveUnsaved()) return;
    setSearchParams(new URLSearchParams({ item: id }));
  };

  const info = buffetInfoProgress(settings.extra_instructions);
  const tested = settings.enabled || usageRows.some((r) => r.is_test);
  const checklist: ChecklistItem[] = [
    { label: "Número que a IA atende", done: !!settings.unit, detail: settings.unit || "Escolha abaixo" },
    { label: "Nome da assistente", done: !!(settings.assistant_name || "").trim(), item: "ia-apresentacao" },
    { label: "Horário da equipe e WhatsApp do alerta", done: !!settings.team_hours && !!(settings.handoff_alert_phone || "").trim(), item: "ia-apresentacao" },
    {
      label: "Sobre o buffet",
      done: info.filled === info.total,
      // Poucos faltando: diz quais ("falta: Faixa etária"), em vez de só "16 de 17"
      detail: info.missing.length > 0 && info.missing.length <= 3 ? `Falta: ${info.missing.join(", ")}` : `${info.filled} de ${info.total}`,
      item: "ia-buffet",
    },
    {
      label: "Pacotes com preços",
      done: !!catalog && catalog.packages > 0 && catalog.tiers > 0,
      detail: catalog ? `${catalog.packages} pacote(s), ${catalog.tiers} preço(s)` : undefined,
      path: "/formularios?item=pacotes",
    },
    {
      label: "Fotos, vídeo e PDF",
      done: !!catalog && catalog.photos && catalog.video && catalog.pdf,
      detail: catalog ? [catalog.photos ? null : "fotos", catalog.video ? null : "vídeo", catalog.pdf ? null : "PDF"].filter(Boolean).map((x) => `falta ${x}`).join(", ") || undefined : undefined,
      item: "materials",
    },
    { label: "Testar a IA como cliente", done: tested, item: "ia-teste" },
  ];
  const doneCount = checklist.filter((c) => c.done).length;
  const percent = Math.round((doneCount / checklist.length) * 100);

  const handleToggle = async (checked: boolean) => {
    if (checked && !settings.unit) {
      toast({ title: "Escolha o número primeiro", description: "Em \"Números\", escolha o WhatsApp que a IA vai atender.", variant: "destructive" });
      return;
    }
    if (checked && !(settings.extra_instructions || "").trim()) {
      toast({ title: "Preencha \"Sobre o buffet\"", description: "Sem essas informações, a IA passa quase tudo para a equipe.", variant: "destructive" });
      return;
    }
    // Cada nova ativação marca "a partir de agora": conversas anteriores ficam de fora
    const saved = await persist({ enabled: checked, activated_at: checked ? new Date().toISOString() : settings.activated_at });
    if (saved) {
      toast({
        title: checked ? "IA ligada" : "IA desligada",
        description: checked ? `A IA vai atender os clientes novos no ${saved.unit}.` : "As conversas voltam para a equipe e o robô padrão.",
      });
    }
  };

  // Liga/desliga a IA em outro número: só os clientes novos desse número dali em diante
  const toggleExtraUnit = async (unit: string, on: boolean) => {
    if (settings.extra_units === undefined) {
      toast({ title: "Falta atualizar o banco", description: "Rode o SQL dos outros números da IA e tente de novo.", variant: "destructive" });
      return;
    }
    const others = (settings.extra_units || []).filter((e) => e.unit !== unit);
    const saved = await persist({ extra_units: on ? [...others, { unit, activated_at: new Date().toISOString() }] : others });
    if (saved) {
      toast({
        title: on ? `IA ligada no ${unit}` : `IA desligada no ${unit}`,
        description: on ? "Ela atende os clientes novos desse número a partir de agora." : "As conversas novas desse número voltam para o robô e a equipe.",
      });
    }
  };

  const changeMainUnit = async (unit: string) => {
    const saved = await persist({ unit });
    if (saved) toast({ title: "Número salvo", description: `A IA vai atender o ${unit}.` });
  };

  const activeUnits = [settings.unit, ...(settings.extra_units || []).map((e) => e.unit)].filter(Boolean).join(" + ");

  return (
    <div className="space-y-4">
      {/* Liga/desliga */}
      <section className={cn("rounded-2xl bg-card p-4 sm:p-5 space-y-3 transition-all", settings.enabled ? "border-2 border-violet-500 shadow-md shadow-violet-500/10" : "border border-border/60 shadow-sm")}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-11 w-11 shrink-0 rounded-xl bg-violet-500/10 flex items-center justify-center"><Sparkles className="h-6 w-6 text-violet-600" /></div>
            <div className="min-w-0">
              <h3 className="font-display font-semibold text-base flex items-center gap-2">
                {settings.assistant_name || "IA de atendimento"}
                <Badge variant="outline" className="text-violet-600 border-violet-400 text-[10px]">BETA</Badge>
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">Conversa, tira dúvidas, envia materiais e agenda visitas, só com clientes novos.</p>
            </div>
          </div>
          <Switch checked={settings.enabled} onCheckedChange={handleToggle} disabled={saving} aria-label="Ligar a IA" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {settings.enabled ? (
            <span className="text-[11px] font-extrabold tracking-wide text-green-700 bg-green-500/15 rounded-full px-3 py-1">EM USO · {activeUnits}</span>
          ) : (
            <span className="text-[11px] font-extrabold tracking-wide text-muted-foreground bg-muted rounded-full px-3 py-1">DESLIGADA</span>
          )}
          {howToLessonId && (
            <Button asChild size="sm" variant="ghost" className="h-8 text-xs gap-1 text-muted-foreground">
              <Link to={`/aprenda?aula=${howToLessonId}`}><PlayCircle className="w-3.5 h-3.5" /> Ver vídeo de como configurar</Link>
            </Button>
          )}
        </div>
      </section>

      {/* O que falta */}
      <AiCard
        title={percent === 100 ? "Sua IA está pronta 🎉" : `Sua IA está ${percent}% pronta`}
        description={percent === 100 ? "Está tudo preenchido. Continue testando de vez em quando e ensinando o que ela não souber." : "Toque em cada item para preencher. Quanto mais completo, melhor ela atende."}
      >
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-pink-500 transition-all" style={{ width: `${percent}%` }} />
        </div>
        <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
          {checklist.map((c) => {
            const content = (
              <>
                <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full", c.done ? "bg-green-500 text-white" : "border-2 border-border")}>
                  {c.done && <Check className="h-3.5 w-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-sm font-medium", c.done && "text-muted-foreground")}>{c.label}</span>
                  {c.detail && <span className="block text-[11px] text-muted-foreground">{c.detail}</span>}
                </span>
                {(c.item || c.path) && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
              </>
            );
            const cls = "flex w-full items-center gap-3 px-3 py-2.5 text-left bg-card hover:bg-muted/40 transition-colors";
            if (c.path) return <Link key={c.label} to={c.path} className={cls}>{content}</Link>;
            if (c.item) return <button key={c.label} type="button" onClick={() => openItem(c.item!)} className={cls}>{content}</button>;
            return <div key={c.label} className={cls}>{content}</div>;
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Lembrete: a IA confere a <Link to="/agenda" className="font-semibold text-primary underline-offset-2 hover:underline">Agenda</Link> antes de falar de data. Todas as festas fechadas precisam estar lá.
        </p>
      </AiCard>

      {/* Números */}
      <AiCard icon={<Smartphone className="h-4 w-4 text-green-600" />} title="Números" description="O WhatsApp que a IA atende. Ela só pega os clientes novos; conversas em andamento continuam com a equipe.">
        <div className="space-y-1.5">
          <Label className="text-xs font-bold">Número principal</Label>
          <Select value={settings.unit || ""} onValueChange={changeMainUnit} disabled={settings.enabled || saving}>
            <SelectTrigger className="h-10" aria-label="Número principal"><SelectValue placeholder="Escolha o número" /></SelectTrigger>
            <SelectContent>{units.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
          </Select>
          {settings.enabled && <p className="text-[11px] text-muted-foreground">Desligue a IA para trocar o número principal.</p>}
          {units.length === 0 && <p className="text-[11px] text-muted-foreground">Nenhum número conectado. Conecte em WhatsApp → Conexão dos números.</p>}
        </div>
        {settings.unit && units.some((u) => u !== settings.unit) && (
          <div className="space-y-1.5">
            <Label className="text-xs font-bold">Outros números</Label>
            {units.filter((u) => u !== settings.unit).map((u) => {
              const extra = (settings.extra_units || []).find((e) => e.unit === u);
              return (
                <div key={u} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold">{u}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {extra
                        ? `IA atendendo clientes novos desde ${new Date(extra.activated_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`
                        : "Só robô e equipe"}
                    </p>
                  </div>
                  <Switch checked={!!extra} onCheckedChange={(on) => toggleExtraUnit(u, on)} disabled={saving} aria-label={`IA no ${u}`} />
                </div>
              );
            })}
          </div>
        )}
      </AiCard>
    </div>
  );
}
