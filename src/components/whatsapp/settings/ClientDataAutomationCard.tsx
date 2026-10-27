import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileSignature, Loader2, Save } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

// Textos padrão das cobranças (iguais aos do servidor, follow-up-check)
export const DEFAULT_CLIENT_DATA_REMINDERS = [
  "Oi, {{primeiro_nome}}! 😊 Passando pra lembrar do cadastro pro contrato da festa 🎉 Leva só 2 minutinhos: {{link}}",
  "{{primeiro_nome}}, tudo bem? 💜 Pra gente garantir a data da festa, só falta o seu cadastro. É com ele que fazemos o contrato 📝 {{link}}",
  "{{primeiro_nome}}, a data da festa só fica garantida depois do contrato, e ele depende do seu cadastro 🙏 Ficou alguma dúvida ou teve dificuldade com o formulário? Me responde aqui que eu te ajudo 😊 {{link}}",
];

const HOUR_OPTIONS = [12, 24, 36, 48, 72, 96];

interface Settings {
  auto_on_closed: boolean;
  reminders_enabled: boolean;
  reminder_hours: number[];
  reminder_messages: string[];
  // Foto do documento no formulário: não pedir / opcional / obrigatório (null = banco sem a coluna)
  document_upload: "off" | "optional" | "required" | null;
}

/**
 * Dados do Contratante: envio sozinho ao marcar "Fechado" e cobranças até o
 * cliente preencher (só no horário de atendimento). Desligado por padrão.
 */
export function ClientDataAutomationCard() {
  const { currentCompanyId } = useCompany();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [available, setAvailable] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!currentCompanyId) return;
    (async () => {
      const { data, error } = await (supabase as any)
        .from("form_automation_settings")
        .select("auto_on_closed, reminders_enabled, reminder_hours, reminder_messages")
        .eq("company_id", currentCompanyId)
        .eq("form_type", "contrato")
        .maybeSingle();
      if (error) { setAvailable(false); return; } // banco sem as colunas (SQL não rodado)
      const { data: docRow, error: docErr } = await (supabase as any).from("form_automation_settings").select("document_upload")
        .eq("company_id", currentCompanyId).eq("form_type", "contrato").maybeSingle();
      const hours = Array.isArray(data?.reminder_hours) && data.reminder_hours.length === 3 ? data.reminder_hours : [24, 48, 72];
      const msgs = Array.isArray(data?.reminder_messages) ? data.reminder_messages : [];
      setSettings({
        auto_on_closed: data?.auto_on_closed === true,
        reminders_enabled: data?.reminders_enabled === true,
        reminder_hours: hours,
        reminder_messages: DEFAULT_CLIENT_DATA_REMINDERS.map((d, i) => (msgs[i] || "").trim() || d),
        document_upload: docErr ? null : (["optional", "required"].includes(docRow?.document_upload) ? docRow.document_upload : "off"),
      });
    })();
  }, [currentCompanyId]);

  if (!available || !settings) return null;

  const save = async () => {
    if (!currentCompanyId) return;
    setSaving(true);
    const payload: Record<string, unknown> = {
      auto_on_closed: settings.auto_on_closed,
      reminders_enabled: settings.reminders_enabled,
      reminder_hours: settings.reminder_hours,
      // Texto igual ao padrão não é gravado: segue o padrão se ele mudar
      reminder_messages: settings.reminder_messages.map((m, i) => (m.trim() === DEFAULT_CLIENT_DATA_REMINDERS[i] ? "" : m.trim())),
      updated_at: new Date().toISOString(),
    };
    if (settings.document_upload) payload.document_upload = settings.document_upload;
    const { data: existing } = await supabase.from("form_automation_settings").select("id")
      .eq("company_id", currentCompanyId).eq("form_type", "contrato").maybeSingle();
    const { error } = existing
      ? await (supabase as any).from("form_automation_settings").update(payload).eq("id", existing.id)
      : await (supabase as any).from("form_automation_settings").insert({ ...payload, company_id: currentCompanyId, form_type: "contrato", is_enabled: false, send_days_before: 5, send_hour: 10, send_minute: 0 });
    setSaving(false);
    if (error) toast({ title: "Não consegui salvar", description: error.message, variant: "destructive" });
    else toast({ title: "Dados do contratante salvos ✅" });
  };

  const setHour = (i: number, v: number) => setSettings({ ...settings, reminder_hours: settings.reminder_hours.map((h, j) => (j === i ? v : h)) });
  const setMsg = (i: number, v: string) => setSettings({ ...settings, reminder_messages: settings.reminder_messages.map((m, j) => (j === i ? v : m)) });

  return (
    <Card className="border-blue-500/30">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileSignature className="h-4 w-4 text-blue-500" /> Dados do Contratante: envio e cobranças
        </CardTitle>
        <CardDescription>
          O link dos dados do contrato pode sair sozinho quando o lead vira "Fechado" (na conversa também tem o botão "Pedir dados"). Se o cliente não preencher, a plataforma cobra só no horário de atendimento (Configurar IA), e avisa a equipe quando ele preencher ou se as cobranças acabarem sem resposta.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <div>
            <Label className="text-sm font-medium">Enviar sozinho ao marcar "Fechado"</Label>
            <p className="text-xs text-muted-foreground">Usa a mensagem do card "Dados do Contratante" abaixo, pelo WhatsApp da conversa do cliente.</p>
          </div>
          <Switch checked={settings.auto_on_closed} onCheckedChange={(v) => setSettings({ ...settings, auto_on_closed: v })} />
        </div>

        <div className="space-y-3 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label className="text-sm font-medium">Cobrar quem não preencheu</Label>
              <p className="text-xs text-muted-foreground">Para sozinha quando o cliente preenche ou está conversando com a equipe.</p>
            </div>
            <Switch checked={settings.reminders_enabled} onCheckedChange={(v) => setSettings({ ...settings, reminders_enabled: v })} />
          </div>
          {settings.reminders_enabled && settings.reminder_messages.map((msg, i) => (
            <div key={i} className="space-y-1.5 rounded-md bg-muted/40 p-2.5">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-semibold">{i + 1}ª cobrança</span>
                <span className="text-muted-foreground">depois de</span>
                <Select value={String(settings.reminder_hours[i])} onValueChange={(v) => setHour(i, Number(v))}>
                  <SelectTrigger className="h-7 w-24 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>{HOUR_OPTIONS.map((h) => <SelectItem key={h} value={String(h)}>{h} horas</SelectItem>)}</SelectContent>
                </Select>
                <span className="text-muted-foreground">do envio</span>
              </div>
              <Textarea value={msg} onChange={(e) => setMsg(i, e.target.value)} rows={3} className="text-sm" />
            </div>
          ))}
          {settings.reminders_enabled && (
            <p className="text-[11px] text-muted-foreground">
              Use {"{{primeiro_nome}}"}, {"{{nome}}"}, {"{{empresa}}"}, {"{{data_evento}}"} e {"{{link}}"}. Depois da última cobrança sem resposta, a equipe recebe um alerta e a etiqueta fica "⚠️ Dados atrasados".
            </p>
          )}
        </div>

        {settings.document_upload && (
          <div className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <Label className="text-sm font-medium">Foto do documento (RG ou CNH)</Label>
              <p className="text-xs text-muted-foreground">O cliente manda a foto no próprio formulário. Fica guardada só para a equipe ("Ver dados" na conversa).</p>
            </div>
            <Select value={settings.document_upload} onValueChange={(v) => setSettings({ ...settings, document_upload: v as Settings["document_upload"] })}>
              <SelectTrigger className="h-9 w-full sm:w-[170px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Não pedir</SelectItem>
                <SelectItem value="optional">Pedir (opcional)</SelectItem>
                <SelectItem value="required">Obrigatório</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex justify-end">
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />} Salvar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
