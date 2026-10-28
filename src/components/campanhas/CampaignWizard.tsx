import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CampaignContextStep } from "./CampaignContextStep";
import { CampaignAudienceStep } from "./CampaignAudienceStep";
import { CampaignConfigStep } from "./CampaignConfigStep";
import { CampaignPresetPicker, type PresetPick } from "./CampaignPresetPicker";
import { presetGoal, presetName, type CampaignPresetId } from "@/lib/campaignPresets";
import { ChevronLeft, ChevronRight, Loader2, Megaphone, Check, Info, ChevronDown, Users } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { toast } from "sonner";
import { phoneTail, uniqueByPhone } from "@/lib/campaignAudience";
import { fetchAllPages } from "@/lib/fetchAllPages";
import { usableVariations } from "@/lib/campaignMessages";
import { clearCampaignDraft, loadCampaignDraft, saveCampaignDraft } from "@/lib/campaignDraft";

interface CampaignWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  companyName: string;
  onCampaignCreated: (campaign: any) => void;
  /** Quando passado, o wizard entra em modo "editar destinatários" focado no passo Audiência. */
  editingCampaign?: {
    id: string;
    name: string;
    total_recipients: number;
  } | null;
}

export interface CampaignDraft {
  name: string;
  campaignType: string;
  description: string;
  variations: { tone: string; text: string }[];
  imageUrl: string | null;
  selectedLeadIds: string[];
  leads: { id: string; name: string; whatsapp: string }[];
  /** Ao editar destinatários: telefones (finais) que já estavam na lista, para marcar de novo */
  preselectTails?: string[];
  pauseBotOnReply: boolean;
  /** por qual número sai (escolhido no Revisar) */
  sendMode: "single" | "smart";
  sendInstanceId: string;
  autoReplyMessage: string;
  /** campanha pronta escolhida (público e objetivo já preparados) */
  presetId?: CampaignPresetId;
  /** mês da campanha "Datas livres" */
  presetMonth?: string;
  /** o público pronto já foi marcado uma vez (depois a pessoa ajusta à mão) */
  presetSelected?: boolean;
  audienceFilters?: {
    statuses: string[];
    month: string;
    unit: string;
    source: string;
    partyType: string;
    search: string;
  };
}

const STEPS = [
  { label: "Mensagem", description: "Mensagem & IA" },
  { label: "Público", description: "Quem vai receber" },
  { label: "Revisar", description: "Revisar & enviar" },
];

const STEP_DESCRIPTIONS = [
  "Escolha um nome para sua campanha, descreva o objetivo e gere as variações de mensagem com a IA. Você também pode anexar uma imagem ou gerar uma arte com IA.",
  "Filtre e selecione os leads que receberão a campanha. Use os filtros de status, unidade e mês para refinar sua lista.",
  "Revise o resumo, escolha por qual número sai e confira a prévia. Ao clicar em Começar envio, a campanha já entra na fila e sai sozinha, até 30 por dia, de segunda a sábado das 9h às 19h.",
];

const EMPTY_DRAFT: CampaignDraft = {
  name: "",
  campaignType: "",
  description: "",
  variations: [],
  imageUrl: null,
  selectedLeadIds: [],
  leads: [],
  pauseBotOnReply: true,
  sendMode: "smart",
  sendInstanceId: "",
  autoReplyMessage: "Oi! Recebemos sua mensagem sobre a promoção 🎉\n\nUm atendente vai te responder em instantes 😊",
};

export function CampaignWizard({ open, onOpenChange, companyId, companyName, onCampaignCreated, editingCampaign }: CampaignWizardProps) {
  const isEditingAudience = !!editingCampaign;
  const [step, setStep] = useState(isEditingAudience ? 1 : 0);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<CampaignDraft>(EMPTY_DRAFT);
  // Abriu continuando um rascunho guardado neste aparelho
  const [restored, setRestored] = useState(false);
  // Primeira tela: campanhas prontas ou criar do zero
  const [picking, setPicking] = useState(false);

  // Quando entra em modo edição de audiência, pré-carrega destinatários atuais (status=pending) como pré-selecionados.
  useEffect(() => {
    if (!open) return;
    if (isEditingAudience && editingCampaign) {
      setStep(1);
      (async () => {
        const { data } = await supabase
          .from("campaign_recipients")
          .select("lead_id, phone, lead_name, status")
          .eq("campaign_id", editingCampaign.id)
          .eq("status", "pending");

        // Marca pelo telefone: serve para leads do CRM e da Base
        // Mantém a lista de leads, se ela já carregou antes desta busca terminar
        setDraft((prev) => ({
          ...EMPTY_DRAFT,
          leads: prev.leads,
          name: editingCampaign.name,
          preselectTails: (data || []).map((r) => phoneTail(r.phone)).filter(Boolean),
        }));
      })();
    } else {
      const saved = loadCampaignDraft<CampaignDraft>(companyId);
      if (saved) {
        setDraft({ ...EMPTY_DRAFT, ...saved.draft, leads: [] });
        setStep(Math.min(Math.max(saved.step, 0), 2));
        setRestored(true);
        setPicking(false);
      } else {
        setStep(0);
        setDraft(EMPTY_DRAFT);
        setRestored(false);
        setPicking(true);
      }
    }
  }, [open, isEditingAudience, editingCampaign?.id]);

  // Guarda o rascunho enquanto a pessoa monta a campanha
  useEffect(() => {
    if (!open || isEditingAudience || !companyId) return;
    saveCampaignDraft(companyId, step, draft);
  }, [open, isEditingAudience, companyId, step, draft]);

  const startOver = () => {
    clearCampaignDraft(companyId);
    setDraft(EMPTY_DRAFT);
    setStep(0);
    setRestored(false);
    setPicking(true);
  };

  const pickPreset = ({ preset, month, freeDates, partialDates }: PresetPick) => {
    const ctx = { month, freeDates, partialDates };
    setDraft({
      ...EMPTY_DRAFT,
      name: presetName(preset.id, ctx),
      campaignType: preset.title,
      description: presetGoal(preset.id, ctx),
      presetId: preset.id,
      presetMonth: month,
    });
    setStep(0);
    setPicking(false);
  };

  const canAdvanceStep0 = draft.name.trim() && usableVariations(draft.variations).length >= 1;
  const canAdvanceStep1 = draft.selectedLeadIds.length > 0;

  const handleCreate = async () => {
    if (!companyId) return;
    setSaving(true);

    try {
      const { data: user } = await supabase.auth.getUser();
      if (!user?.user?.id) throw new Error("Não autenticado");
      if (!draft.sendInstanceId) throw new Error("Escolha por qual número a campanha sai (nenhum WhatsApp conectado?)");

      const selectedIds = new Set(draft.selectedLeadIds);
      const selectedLeads = uniqueByPhone(draft.leads.filter((l) => selectedIds.has(l.id)));
      const variations = usableVariations(draft.variations);

      const { data: campaign, error } = await supabase
        .from("campaigns")
        .insert({
          company_id: companyId,
          created_by: user.user.id,
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          message_variations: variations,
          image_url: draft.imageUrl,
          // Criada parada; entra na fila depois que os destinatários estiverem gravados
          status: "draft",
          total_recipients: selectedLeads.length,
          pause_bot_on_reply: draft.pauseBotOnReply,
          auto_reply_message: draft.pauseBotOnReply ? (draft.autoReplyMessage.trim() || null) : null,
          filters: {
            ...(draft.audienceFilters || {}),
            ...(draft.campaignType ? { campaign_type: draft.campaignType } : {}),
            ...(draft.presetId ? { preset: draft.presetId, ...(draft.presetMonth ? { preset_month: draft.presetMonth } : {}) } : {}),
          },
        })
        .select()
        .single();

      if (error) throw error;

      const recipients = selectedLeads.map((lead, i) => {
        const isBase = lead.id.startsWith("base_");
        return {
          campaign_id: campaign.id,
          lead_id: isBase ? null : lead.id,
          phone: lead.whatsapp,
          lead_name: lead.name,
          variation_index: i % variations.length,
          status: "pending",
        };
      });

      const { error: recipErr } = await supabase
        .from("campaign_recipients")
        .insert(recipients);

      if (recipErr) throw recipErr;

      // Já entra na fila: o servidor manda sozinho (campaign-dispatch)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: queueErr } = await (supabase as any)
        .from("campaigns")
        .update({
          status: "sending",
          server_send: true,
          send_mode: draft.sendMode,
          send_instance_id: draft.sendInstanceId,
          started_at: new Date().toISOString(),
          last_error: null,
        })
        .eq("id", campaign.id);
      if (queueErr) throw queueErr;

      // Link image to campaign in gallery
      if (draft.imageUrl && campaign.id) {
        await (supabase as any)
          .from("campaign_images")
          .update({ campaign_id: campaign.id })
          .eq("company_id", companyId)
          .eq("image_url", draft.imageUrl)
          .is("campaign_id", null);
      }

      toast.success("Campanha na fila! Ela sai sozinha, até 30 por dia.");
      clearCampaignDraft(companyId);
      setRestored(false);
      setStep(0);
      setDraft(EMPTY_DRAFT);
      onCampaignCreated(campaign);
    } catch (err: any) {
      console.error("Error creating campaign:", err);
      toast.error(err.message || "Erro ao criar campanha");
    } finally {
      setSaving(false);
    }
  };

  // Atualiza apenas a lista de destinatários (status=pending) preservando enviados/erros.
  const handleSaveAudience = async () => {
    if (!editingCampaign) return;
    setSaving(true);
    try {
      const selectedIds = new Set(draft.selectedLeadIds);
      const selectedLeads = uniqueByPhone(draft.leads.filter((l) => selectedIds.has(l.id)));

      // Carrega quantas variações a campanha tem para distribuir corretamente
      const { data: campData } = await supabase
        .from("campaigns")
        .select("message_variations")
        .eq("id", editingCampaign.id)
        .single();

      const variations = Array.isArray(campData?.message_variations) ? campData!.message_variations : [{}];
      const variationCount = Math.max(1, variations.length);

      // Apaga os pendentes antigos e insere os novos selecionados
      const { error: delErr } = await supabase
        .from("campaign_recipients")
        .delete()
        .eq("campaign_id", editingCampaign.id)
        .eq("status", "pending");
      if (delErr) throw delErr;

      // Quem continua na campanha (já enviado, com erro, ou pendente que não saiu)
      // não entra de novo: assim ninguém recebe a mesma campanha duas vezes
      const remaining = await fetchAllPages<{ phone: string }>((a, b) =>
        supabase
          .from("campaign_recipients")
          .select("phone")
          .eq("campaign_id", editingCampaign.id)
          .order("id")
          .range(a, b),
      );
      const already = new Set(remaining.map((r) => phoneTail(r.phone)));
      const toAdd = selectedLeads.filter((l) => !already.has(phoneTail(l.whatsapp)));

      const recipients = toAdd.map((lead, i) => {
        const isBase = lead.id.startsWith("base_");
        return {
          campaign_id: editingCampaign.id,
          lead_id: isBase ? null : lead.id,
          phone: lead.whatsapp,
          lead_name: lead.name,
          variation_index: i % variationCount,
          status: "pending",
        };
      });

      if (recipients.length > 0) {
        const { error: insErr } = await supabase
          .from("campaign_recipients")
          .insert(recipients);
        if (insErr) throw insErr;
      }

      // Total = todos que estão na campanha agora
      const newTotal = remaining.length + recipients.length;
      await supabase
        .from("campaigns")
        .update({ total_recipients: newTotal })
        .eq("id", editingCampaign.id);

      toast.success(`Lista atualizada: ${recipients.length} destinatário(s)`);
      onOpenChange(false);
      onCampaignCreated({ id: editingCampaign.id });
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Erro ao atualizar destinatários");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90dvh] flex flex-col overflow-hidden p-0">
        {/* Premium header */}
        <div className="px-5 pt-5 pb-0">
          <DialogHeader className="pb-3">
            <DialogTitle className="flex items-center gap-2.5 text-lg">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                {isEditingAudience ? <Users className="w-4 h-4 text-primary" /> : <Megaphone className="w-4 h-4 text-primary" />}
              </div>
              {isEditingAudience ? `Editar destinatários — ${editingCampaign?.name}` : "Nova Campanha"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {isEditingAudience ? "Reabrir filtros e regerar lista de destinatários" : "Criar nova campanha de marketing"}
            </DialogDescription>
          </DialogHeader>

          {/* Step indicators - escondidos no modo edição */}
          {!isEditingAudience && !picking && (
            <div className="flex items-center gap-1.5 sm:gap-2 pb-4">
              {STEPS.map((s, i) => (
                <div key={i} className="flex items-center gap-1.5 sm:gap-2 flex-1 min-w-0">
                  <div className={`flex items-center gap-1.5 sm:gap-2 flex-1 min-w-0 px-2 sm:px-3 py-2 rounded-full transition-all text-xs font-medium ${
                    i === step
                      ? "bg-primary/10 text-primary border border-primary/20"
                      : i < step
                      ? "bg-muted text-muted-foreground"
                      : "bg-muted/40 text-muted-foreground/50"
                  }`}>
                    <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                      i < step
                        ? "bg-primary text-primary-foreground"
                        : i === step
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted-foreground/20 text-muted-foreground/50"
                    }`}>
                      {i < step ? <Check className="w-3 h-3" /> : i + 1}
                    </div>
                    <span className="truncate">{s.label}</span>
                  </div>
                  {i < STEPS.length - 1 && (
                    <div className={`hidden sm:block w-4 h-px shrink-0 ${i < step ? "bg-primary" : "bg-border"}`} />
                  )}
                </div>
              ))}
            </div>
          )}

          {!isEditingAudience && restored && (
            <div className="flex items-center justify-between gap-2 mb-3 px-3 py-2 rounded-xl bg-amber-500/10 text-xs text-amber-800 dark:text-amber-300">
              <span>Continuando a campanha que você não terminou.</span>
              <button type="button" className="font-semibold underline shrink-0" onClick={startOver}>
                Começar do zero
              </button>
            </div>
          )}

          {!isEditingAudience && !picking && (
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors pb-2 cursor-pointer">
                <Info className="w-3.5 h-3.5 shrink-0" />
                <span>Instruções</span>
                <ChevronDown className="w-3 h-3" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <p className="text-xs text-muted-foreground pb-3 pl-5">
                  {STEP_DESCRIPTIONS[step]}
                </p>
              </CollapsibleContent>
            </Collapsible>
          )}

          {isEditingAudience && (
            <p className="text-xs text-muted-foreground pb-3">
              Ajuste os filtros e a seleção. Apenas os <strong>destinatários pendentes</strong> serão substituídos — quem já recebeu ou deu erro permanece intocado.
            </p>
          )}
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto min-h-0 px-5 pb-2">
          {!isEditingAudience && picking && (
            <CampaignPresetPicker companyId={companyId} onPick={pickPreset} onBlank={() => setPicking(false)} />
          )}
          {!isEditingAudience && !picking && step === 0 && (
            <CampaignContextStep draft={draft} setDraft={setDraft} companyName={companyName} />
          )}
          {step === 1 && (
            <CampaignAudienceStep draft={draft} setDraft={setDraft} companyId={companyId} editingCampaignId={editingCampaign?.id} />
          )}
          {!isEditingAudience && step === 2 && (
            <CampaignConfigStep draft={draft} setDraft={setDraft} companyName={companyName} companyId={companyId} />
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center px-5 py-3.5 border-t bg-muted/30 shrink-0">
          <Button variant="ghost" size="sm" onClick={() => {
            if (isEditingAudience || picking) { onOpenChange(false); return; }
            if (step > 0) { setStep(step - 1); return; }
            // Do 1º passo volta para as campanhas prontas ("Criar do zero" segue com o que já foi escrito)
            setPicking(true);
          }}>
            <ChevronLeft className="w-4 h-4 mr-1" />
            {isEditingAudience || picking ? "Cancelar" : "Voltar"}
          </Button>

          {picking ? null : isEditingAudience ? (
            <Button size="sm" onClick={handleSaveAudience} disabled={saving || !canAdvanceStep1}>
              {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              Salvar destinatários ({draft.selectedLeadIds.length})
            </Button>
          ) : step < 2 ? (
            <Button
              size="sm"
              onClick={() => setStep(step + 1)}
              disabled={step === 0 ? !canAdvanceStep0 : !canAdvanceStep1}
            >
              Próximo
              <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          ) : (
            <Button size="sm" onClick={handleCreate} disabled={saving || !draft.sendInstanceId}>
              {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              Começar envio
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
