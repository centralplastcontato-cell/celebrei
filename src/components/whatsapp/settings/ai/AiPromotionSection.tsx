// Configurações → IA → Promoção: a promoção do momento em campos simples (nome,
// o que o cliente ganha, prazo, ano da festa, regras). Vira uma linha do campo
// "Promoção" das informações do buffet (src/lib/aiPromotion.ts); a IA oferece
// depois dos valores, com os dias que faltam, e para sozinha no fim do prazo.

import { useEffect, useMemo, useState } from "react";
import { BadgePercent, Lightbulb, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { parseBuffetInfo, serializeBuffetInfo } from "@/lib/aiBuffetFields";
import { EMPTY_PROMOTION, PROMOTION_IDEAS, ideaToForm, parsePromotion, promotionDaysLeft, serializePromotion, type PromotionForm, type PromotionIdea } from "@/lib/aiPromotion";
import { AiCard, SaveBar } from "./AiFormBits";
import { useAiAgentSettings } from "./useAiAgentSettings";

const ANY_YEAR = "qualquer";

export function AiPromotionSection() {
  const { settings, loading, saving, persist } = useAiAgentSettings();
  const [saved, setSaved] = useState<PromotionForm | null>(null);
  const [p, setP] = useState<PromotionForm>(EMPTY_PROMOTION);

  useEffect(() => {
    if (!settings || saved) return;
    const initial = parsePromotion(parseBuffetInfo(settings.extra_instructions).promocao);
    setSaved(initial);
    setP(initial);
  }, [settings, saved]);

  const dirty = useMemo(() => !!saved && JSON.stringify(p) !== JSON.stringify(saved), [p, saved]);

  if (loading || !settings || !saved) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground p-4"><Loader2 className="w-4 h-4 animate-spin" /> Carregando...</div>;
  }

  const set = (k: keyof PromotionForm) => (v: string) => setP((prev) => ({ ...prev, [k]: v }));
  const line = serializePromotion(p);
  const days = promotionDaysLeft(p.ate);
  const thisYear = new Date().getFullYear();
  const years = [thisYear, thisYear + 1, thisYear + 2].map(String);

  const write = async (next: PromotionForm, message: string) => {
    // Junta com o que está salvo agora nas informações do buffet (só troca a promoção)
    const values = parseBuffetInfo(settings.extra_instructions);
    values.promocao = serializePromotion(next);
    const ok = await persist({ extra_instructions: serializeBuffetInfo(values) });
    if (ok) {
      const fresh = parsePromotion(parseBuffetInfo(ok.extra_instructions).promocao);
      setSaved(fresh);
      setP(fresh);
      toast({ title: message });
    }
  };

  const save = () => {
    const empty = !p.nome.trim() && !p.beneficio.trim() && !p.ate;
    if (!empty && !line) {
      toast({ title: "Falta preencher", description: "Nome da promoção, o que o cliente ganha e até quando vale.", variant: "destructive" });
      return;
    }
    if (days !== null && days < 0) {
      toast({ title: "Essa data já passou", description: "Escolha até quando a promoção vale.", variant: "destructive" });
      return;
    }
    write(p, empty ? "Promoção removida" : "Promoção salva — a IA já passa a oferecer");
  };

  const useIdea = (idea: PromotionIdea) => {
    const filled = p.nome.trim() || p.beneficio.trim();
    if (filled && !confirm(`Trocar o que está preenchido pela ideia "${idea.nome}"?`)) return;
    setP((prev) => ideaToForm(idea, prev));
  };

  return (
    <div className="space-y-4">
      <AiCard
        icon={<Lightbulb className="h-4 w-4 text-amber-500" />}
        title="Ideias de promoção"
        description="Toque numa ideia para preencher. Depois ajuste o que o cliente ganha do jeito do seu buffet e escolha até quando vale."
      >
        <div className="flex flex-wrap gap-2">
          {PROMOTION_IDEAS.map((idea) => (
            <button
              key={idea.nome}
              type="button"
              onClick={() => useIdea(idea)}
              title={idea.beneficio}
              className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground shadow-sm transition hover:border-pink-400 hover:bg-pink-500/5"
            >
              {idea.emoji} {idea.nome}
            </button>
          ))}
        </div>
      </AiCard>
      <AiCard
        icon={<BadgePercent className="h-4 w-4 text-pink-600" />}
        title="Promoção do momento"
        description="A IA oferece a promoção depois de passar os valores, conta os dias que faltam, lembra no máximo uma vez e para sozinha no fim do prazo."
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs font-bold" htmlFor="promo-nome">Nome da promoção</Label>
            <Input id="promo-nome" value={p.nome} onChange={(e) => set("nome")(e.target.value)} placeholder="Ex.: Black Friday" className="h-10 text-base sm:text-sm" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-bold" htmlFor="promo-beneficio">O que o cliente ganha</Label>
            <Textarea id="promo-beneficio" value={p.beneficio} onChange={(e) => set("beneficio")(e.target.value)} rows={3} className="text-base sm:text-sm resize-none"
              placeholder="Ex.: 10 convidados a mais no pacote e parcelamento em 10x sem juros." />
            <p className="text-[11px] text-muted-foreground">A IA só promete o que estiver escrito aqui.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-bold" htmlFor="promo-ate">Vale para contratos fechados até</Label>
              <Input id="promo-ate" type="date" value={p.ate} onChange={(e) => set("ate")(e.target.value)} className="h-10 text-base sm:text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-bold">Vale para festas em</Label>
              <Select value={p.anoFesta || ANY_YEAR} onValueChange={(v) => set("anoFesta")(v === ANY_YEAR ? "" : v)}>
                <SelectTrigger className="h-10 bg-card border-border shadow-sm" aria-label="Vale para festas em"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY_YEAR}>Qualquer data</SelectItem>
                  {years.map((y) => <SelectItem key={y} value={y}>Só festas em {y}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-bold" htmlFor="promo-regras">Regras (opcional)</Label>
            <Textarea id="promo-regras" value={p.regras} onChange={(e) => set("regras")(e.target.value)} rows={2} className="text-base sm:text-sm resize-none"
              placeholder="Ex.: só para festas de sexta e domingo; não vale com outras promoções; limitada a 10 datas." />
          </div>

          {line && (
            <div className="rounded-xl border border-pink-500/20 bg-pink-500/5 p-3 text-xs space-y-1">
              <p className="font-bold text-pink-700 dark:text-pink-300">
                {days === null ? "" : days < 0 ? "⚠️ Essa data já passou" : days === 0 ? "Termina hoje" : days === 1 ? "Termina amanhã" : `Faltam ${days} dias`}
              </p>
              <p className="text-muted-foreground">Como a IA vai ler: <span className="text-foreground">{line}</span></p>
            </div>
          )}

          {saved.beneficio && (
            <Button variant="ghost" size="sm" className="text-destructive" disabled={saving} onClick={() => write(EMPTY_PROMOTION, "Promoção removida")}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Encerrar promoção
            </Button>
          )}
        </div>
      </AiCard>
      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
        Para avisar quem já pediu orçamento, use também Campanhas: a IA escreve as mensagens e cria a arte.
      </p>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={() => setP(saved)} />
    </div>
  );
}
