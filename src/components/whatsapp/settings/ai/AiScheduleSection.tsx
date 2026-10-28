// Configurações → IA → Apresentação e horários: nome e arte da assistente,
// visitas, horário da equipe, horários de festa, recesso, alertas e
// confraternização de empresas.

import { useEffect, useMemo, useState } from "react";
import { BellRing, Building2, CalendarDays, CalendarOff, Clock, Loader2, Plus, Sparkles, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { DEFAULT_TEAM_HOURS, parseVisitHours, serializeTeamHours, serializeVisitHours } from "@/lib/businessHours";
import { FollowUpImageUploader } from "../FollowUpImageUploader";
import { AiCard, SaveBar, WeekHoursEditor } from "./AiFormBits";
import { DEFAULT_PARTY_SLOTS, useAiAgentSettings, type AiAgentSettings, type ClosedPeriod } from "./useAiAgentSettings";

const ALERT_MINUTE_OPTIONS = [5, 10, 15, 20, 30];

interface Draft {
  introName: string;
  introImage: string | null;
  visitByTeam: boolean;
  visitDays: number[]; visitStart: string; visitEnd: string; visitHalfHour: boolean;
  visitSatDifferent: boolean; visitSatStart: string; visitSatEnd: string;
  teamDays: number[]; teamStart: string; teamEnd: string;
  teamSatDifferent: boolean; teamSatStart: string; teamSatEnd: string;
  partySlots: string;
  closedPeriods: ClosedPeriod[];
  alertMinutes: number;
  alertPhone: string;
  partySoonAlert: boolean;
  corporateOn: boolean;
  corporateMax: string;
}

function draftFrom(s: AiAgentSettings): Draft {
  const v = parseVisitHours(s.visit_hours);
  const t = parseVisitHours(s.team_hours || DEFAULT_TEAM_HOURS);
  return {
    introName: s.assistant_name || "",
    introImage: s.intro_image_url || null,
    visitByTeam: s.visit_scheduling === "equipe",
    visitDays: v.days, visitStart: v.start, visitEnd: v.end, visitHalfHour: v.halfHour,
    visitSatDifferent: v.satDifferent, visitSatStart: v.satStart, visitSatEnd: v.satEnd,
    teamDays: t.days, teamStart: t.start, teamEnd: t.end,
    teamSatDifferent: t.satDifferent, teamSatStart: t.satStart, teamSatEnd: t.satEnd,
    partySlots: s.party_slots || DEFAULT_PARTY_SLOTS,
    closedPeriods: Array.isArray(s.closed_periods) ? s.closed_periods : [],
    alertMinutes: s.handoff_alert_minutes || 10,
    alertPhone: s.handoff_alert_phone || "",
    partySoonAlert: s.party_soon_alert === true,
    corporateOn: s.corporate_events_enabled === true,
    corporateMax: s.corporate_max_guests ? String(s.corporate_max_guests) : "",
  };
}

export function AiScheduleSection() {
  const { companyId, settings, loading, saving, persist } = useAiAgentSettings();
  const [saved, setSaved] = useState<Draft | null>(null);
  const [d, setD] = useState<Draft | null>(null);
  const [uploadsBusy, setUploadsBusy] = useState(0);

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
  const setFn = <K extends keyof Draft>(key: K) => (fn: (prev: Draft[K]) => Draft[K]) => setD((prev) => (prev ? { ...prev, [key]: fn(prev[key]) } : prev));

  const save = async () => {
    if (!d.visitByTeam && d.visitDays.length === 0) {
      toast({ title: "Escolha os dias de visita", description: "Marque pelo menos um dia da semana.", variant: "destructive" });
      return;
    }
    if (!d.visitByTeam && (d.visitEnd <= d.visitStart || (d.visitSatDifferent && d.visitDays.includes(5) && d.visitSatEnd <= d.visitSatStart))) {
      toast({ title: "Horário de visita inválido", description: "O horário final precisa ser depois do inicial.", variant: "destructive" });
      return;
    }
    if (d.teamDays.length === 0 || d.teamEnd <= d.teamStart) {
      toast({ title: "Horário da equipe inválido", description: "Marque os dias e um horário final depois do inicial.", variant: "destructive" });
      return;
    }
    if (d.alertPhone.trim() && d.alertPhone.replace(/\D/g, "").length < 10) {
      toast({ title: "WhatsApp do alerta inválido", description: "Informe com DDD, ex.: 15 98112-1710.", variant: "destructive" });
      return;
    }
    const periods = d.closedPeriods.filter((p) => p.start || p.end);
    if (periods.some((p) => !p.start || !p.end || p.end < p.start)) {
      toast({ title: "Confira o recesso", description: "Preencha o primeiro e o último dia de cada período (o último não pode ser antes do primeiro).", variant: "destructive" });
      return;
    }
    const max = parseInt(d.corporateMax.replace(/\D/g, ""), 10);
    const ok = await persist({
      assistant_name: d.introName.trim().slice(0, 30) || null,
      intro_image_url: d.introImage || null,
      visit_hours: serializeVisitHours(d.visitDays, d.visitStart, d.visitEnd, d.visitHalfHour, d.visitSatDifferent, d.visitSatStart, d.visitSatEnd),
      team_hours: serializeTeamHours(d.teamDays, d.teamStart, d.teamEnd, d.teamSatDifferent, d.teamSatStart, d.teamSatEnd),
      party_slots: d.partySlots.trim() && d.partySlots.trim() !== DEFAULT_PARTY_SLOTS ? d.partySlots.trim() : null,
      closed_periods: [...periods].sort((a, b) => a.start.localeCompare(b.start)),
      handoff_alert_minutes: d.alertMinutes,
      handoff_alert_phone: d.alertPhone.trim() || null,
      // Só quando o banco já tem a coluna (veio na leitura)
      ...(settings.party_soon_alert !== undefined ? { party_soon_alert: d.partySoonAlert } : {}),
      ...(settings.corporate_events_enabled !== undefined
        ? { corporate_events_enabled: d.corporateOn, corporate_max_guests: max > 0 ? max : null }
        : {}),
      ...(settings.visit_scheduling !== undefined ? { visit_scheduling: d.visitByTeam ? "equipe" as const : "ia" as const } : {}),
    });
    if (ok) {
      const fresh = draftFrom(ok);
      setSaved(fresh);
      setD(fresh);
      toast({ title: "Salvo", description: "A IA passa a usar essas informações na hora." });
    }
  };

  const trackUpload = (busy: boolean) => setUploadsBusy((n) => Math.max(0, n + (busy ? 1 : -1)));

  return (
    <div className="space-y-4">
      <AiCard
        icon={<UserRound className="h-4 w-4 text-violet-600" />}
        title="Apresentação"
        description="A primeira mensagem da IA vai com esta arte e ela se apresenta pelo nome, no WhatsApp e nas boas-vindas do site."
      >
        <div className="space-y-1.5">
          <Label className="text-xs font-bold" htmlFor="ai-name">Nome da assistente</Label>
          <Input id="ai-name" value={d.introName} onChange={(e) => set("introName")(e.target.value)} placeholder="Ex.: Ana" maxLength={30} className="h-10 text-base sm:text-sm" />
        </div>
        <FollowUpImageUploader
          onUploadingChange={trackUpload}
          value={d.introImage}
          onChange={set("introImage")}
          companyId={companyId}
          followUpNumber={1}
          fileTag="bia_apresentacao"
          successText="A arte vai na primeira mensagem da IA (a apresentação vira a legenda). Salve para valer."
          helpText="Opcional: a arte da assistente (ex.: a assistente na recepção). Sem imagem, a primeira mensagem vai só com texto. JPG/PNG/WebP até 10MB."
        />
      </AiCard>

      <AiCard icon={<CalendarDays className="h-4 w-4 text-violet-600" />} title="Visitas ao espaço" description="Quem marca as visitas e, se for a IA, os dias e horários que ela pode oferecer.">
        {settings.visit_scheduling !== undefined && (
          <div className="space-y-1.5">
            <Label className="text-xs font-bold">Quem marca as visitas</Label>
            <Select value={d.visitByTeam ? "equipe" : "ia"} onValueChange={(v) => set("visitByTeam")(v === "equipe")}>
              <SelectTrigger className="h-10 bg-card border-border shadow-sm" aria-label="Quem marca as visitas"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ia">A IA marca (oferece os horários abaixo)</SelectItem>
                <SelectItem value="equipe">A equipe marca (a IA passa o cliente para vocês)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {d.visitByTeam ? (
          <p className="text-xs text-violet-700 bg-violet-500/10 rounded-lg px-3 py-2 dark:text-violet-300">
            A IA não oferece dia nem horário de visita. Quando o cliente quiser conhecer o espaço, ela avisa que a equipe vai combinar e passa a conversa para vocês.
          </p>
        ) : (<>
        <WeekHoursEditor
          days={d.visitDays} setDays={setFn("visitDays")}
          start={d.visitStart} setStart={set("visitStart")}
          end={d.visitEnd} setEnd={set("visitEnd")}
          satDifferent={d.visitSatDifferent} setSatDifferent={set("visitSatDifferent")}
          satStart={d.visitSatStart} setSatStart={set("visitSatStart")}
          satEnd={d.visitSatEnd} setSatEnd={set("visitSatEnd")}
        >
          <div className="space-y-1.5">
            <Label className="text-xs font-bold">Horários oferecidos</Label>
            <Select value={d.visitHalfHour ? "meia" : "hora"} onValueChange={(v) => set("visitHalfHour")(v === "meia")}>
              <SelectTrigger className="h-10 bg-card border-border shadow-sm" aria-label="Horários oferecidos"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="meia">De meia em meia hora</SelectItem>
                <SelectItem value="hora">De hora em hora</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </WeekHoursEditor>
        {d.visitDays.length > 0 && (
          <p className="text-xs text-violet-700 bg-violet-500/10 rounded-lg px-3 py-2 dark:text-violet-300">
            A IA vai oferecer: <span className="font-bold">{serializeVisitHours(d.visitDays, d.visitStart, d.visitEnd, d.visitHalfHour, d.visitSatDifferent, d.visitSatStart, d.visitSatEnd)}</span>
          </p>
        )}
        </>)}
      </AiCard>

      <AiCard icon={<Clock className="h-4 w-4 text-sky-600" />} title="Horário da equipe no WhatsApp" description="Quando a IA passa a conversa, ela avisa o cliente se a equipe responde agora ou no próximo horário.">
        <WeekHoursEditor
          days={d.teamDays} setDays={setFn("teamDays")}
          start={d.teamStart} setStart={set("teamStart")}
          end={d.teamEnd} setEnd={set("teamEnd")}
          satDifferent={d.teamSatDifferent} setSatDifferent={set("teamSatDifferent")}
          satStart={d.teamSatStart} setSatStart={set("teamSatStart")}
          satEnd={d.teamSatEnd} setSatEnd={set("teamSatEnd")}
        />
      </AiCard>

      <AiCard icon={<Sparkles className="h-4 w-4 text-pink-600" />} title="Horários de festa" description={'A IA consulta a agenda (festas e pré-reservas) e diz quais desses horários estão livres "neste momento". Ela só lê a agenda, nunca reserva.'}>
        <Input value={d.partySlots} onChange={(e) => set("partySlots")(e.target.value)} className="h-10 text-base sm:text-sm" placeholder={DEFAULT_PARTY_SLOTS} aria-label="Horários de festa" />
        <p className="text-[11px] text-muted-foreground">Separe com vírgula. Ex.: 12:00-16:00, 18:00-22:00</p>
      </AiCard>

      <AiCard icon={<CalendarOff className="h-4 w-4 text-amber-600" />} title="Recesso / dias fechados" description="Sem festas e sem visitas nesses dias. A IA continua atendendo, só não oferece essas datas. No site, esses dias ficam bloqueados.">
        {d.closedPeriods.map((p, idx) => (
          <div key={idx} className="rounded-xl border border-border/70 bg-muted/30 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold">Período {idx + 1}</span>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" aria-label="Remover período"
                onClick={() => setFn("closedPeriods")((list) => list.filter((_, i) => i !== idx))}>
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="space-y-1 min-w-0">
                <Label className="text-[11px] text-muted-foreground">Primeiro dia</Label>
                <Input type="date" value={p.start} className="h-10 w-full min-w-0 appearance-none text-base sm:text-sm"
                  onChange={(e) => setFn("closedPeriods")((list) => list.map((x, i) => (i === idx ? { ...x, start: e.target.value } : x)))} />
              </div>
              <div className="space-y-1 min-w-0">
                <Label className="text-[11px] text-muted-foreground">Último dia</Label>
                <Input type="date" value={p.end} min={p.start || undefined} className="h-10 w-full min-w-0 appearance-none text-base sm:text-sm"
                  onChange={(e) => setFn("closedPeriods")((list) => list.map((x, i) => (i === idx ? { ...x, end: e.target.value } : x)))} />
              </div>
            </div>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" className="gap-1" onClick={() => setFn("closedPeriods")((list) => [...list, { start: "", end: "" }])}>
          <Plus className="w-3.5 h-3.5" /> Adicionar período
        </Button>
      </AiCard>

      <AiCard icon={<BellRing className="h-4 w-4 text-red-600" />} title="Alerta para a equipe" description="Quando a IA passa um cliente e ninguém responde nesse tempo (contando só o horário da equipe), o WhatsApp abaixo recebe um alerta 🚨 com o nome do cliente e o motivo, além do sininho.">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1.4fr] gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-bold">Alertar se ninguém responder em</Label>
            <Select value={String(d.alertMinutes)} onValueChange={(v) => set("alertMinutes")(Number(v))}>
              <SelectTrigger className="h-10 bg-card border-border shadow-sm" aria-label="Tempo do alerta"><SelectValue /></SelectTrigger>
              <SelectContent>{ALERT_MINUTE_OPTIONS.map((m) => <SelectItem key={m} value={String(m)}>{m} min</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-bold" htmlFor="ai-alert-phone">WhatsApp que recebe o alerta</Label>
            <Input id="ai-alert-phone" value={d.alertPhone} onChange={(e) => set("alertPhone")(e.target.value)} className="h-10 text-base sm:text-sm" placeholder="Ex.: 15 98112-1710" />
          </div>
        </div>
        {settings.party_soon_alert !== undefined && (
          <div className="space-y-1 rounded-xl border border-border bg-muted/30 p-3">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs font-bold">🎉 Avisar quando a festa for nos próximos 60 dias</Label>
              <Switch checked={d.partySoonAlert} onCheckedChange={set("partySoonAlert")} aria-label="Avisar festa nos próximos 60 dias" />
            </div>
            <p className="text-[11px] text-muted-foreground">Vale para todos os clientes (IA, robô e site). Aviso no sininho e no WhatsApp acima, uma vez por cliente.</p>
          </div>
        )}
      </AiCard>

      {settings.corporate_events_enabled !== undefined && (
        <AiCard
          icon={<Building2 className="h-4 w-4 text-sky-600" />}
          title="Confraternização de empresas"
          description='A IA reconhece quando é empresa, não pergunta de aniversariante e usa o mesmo pacote, PDF e agenda. A lista "Como posso te ajudar?" ganha a opção 🏢 Confraternização de empresa e a equipe recebe um aviso.'
          action={<Switch checked={d.corporateOn} onCheckedChange={set("corporateOn")} aria-label="Atender confraternização de empresas" />}
        >
          {d.corporateOn && (
            <div className="flex items-center gap-2">
              <Label className="text-xs whitespace-nowrap" htmlFor="ai-corp-max">Capacidade máxima</Label>
              <Input id="ai-corp-max" inputMode="numeric" value={d.corporateMax} onChange={(e) => set("corporateMax")(e.target.value.replace(/\D/g, "").slice(0, 4))} className="h-9 w-24 text-base sm:text-sm" placeholder="120" />
              <span className="text-xs text-muted-foreground">pessoas</span>
            </div>
          )}
        </AiCard>
      )}

      <SaveBar dirty={dirty} saving={saving} busyText={uploadsBusy > 0 ? "Enviando imagem…" : null} onSave={save} onDiscard={() => saved && setD(saved)} />
    </div>
  );
}
