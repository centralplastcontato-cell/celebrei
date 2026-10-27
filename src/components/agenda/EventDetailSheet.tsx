import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { sendContractForSignature } from "@/lib/contractSignature";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, Clock, Users, MapPin, Package, DollarSign, Pencil, Trash2, AlertTriangle, UserCheck, Gamepad2, Copy, Check, ExternalLink, Briefcase, CalendarIcon, Loader2, CreditCard, MessageCircle, FileSignature, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ContractReadinessPanel } from "@/components/contracts/ContractReadinessPanel";
import { EventContractDialog } from "@/components/contracts/EventContractDialog";
import { logContractAction, sendContractViaWhatsApp, getContractSendTemplate, resolveContractSendMessage } from "@/components/contracts/contractAuditHelpers";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

import { EventSummaryPanel } from "./EventSummaryPanel";
import { EventTasksSection } from "./EventTasksSection";
import { EventFormsStatusPanel } from "./EventFormsStatusPanel";
import { EventFinancialTab } from "@/components/financial/EventFinancialTab";
import { useFinancialPermissions } from "@/hooks/useFinancialPermissions";
import { useFinancialConsent } from "@/hooks/useFinancialConsent";

import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";

interface TeamMember {
  user_id: string;
  full_name: string;
}

export interface EventData {
  id: string;
  title: string;
  event_date: string;
  start_time: string | null;
  end_time: string | null;
  event_type: string | null;
  guest_count: number | null;
  unit: string | null;
  status: string;
  package_name: string | null;
  total_value: number | null;
  notes: string | null;
  lead_id?: string | null;
  company_id?: string;
  data_fechamento_venda?: string | null;
  vendedor_responsavel_id?: string | null;
  payment_method?: string | null;
  child_name?: string | null;
  child_age?: string | null;
  birthday_children?: any[] | null;
  parent_names?: string | null;
  event_optionals?: any[] | null;
  internal_notes?: string | null;
  gifts?: string | null;
}

interface EventDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  event: EventData | null;
  onEdit: (event: EventData) => void;
  onDelete: (id: string) => void;
  conflicts?: EventData[];
  userId?: string;
  onEventPatch?: (eventId: string, updates: Partial<EventData>) => void;
  /** mostra o valor da festa (permissão de ver faturamento) */
  showRevenue?: boolean;
}

const STATUS_MAP: Record<string, { label: string; variant: "default" | "secondary" | "destructive" }> = {
  confirmado: { label: "Confirmado", variant: "default" },
  pendente: { label: "Pendente", variant: "secondary" },
  cancelado: { label: "Cancelado", variant: "destructive" },
};

export function EventDetailSheet({ open, onOpenChange, event, onEdit, onDelete, conflicts = [], userId, onEventPatch, showRevenue = false }: EventDetailSheetProps) {
  const financialPerms = useFinancialPermissions(userId);
  const consentHook = useFinancialConsent();
  const navigate = useNavigate();

  // Abre as informações do lead vinculado na Central de Atendimento.
  const openLinkedLead = () => {
    if (!event?.lead_id) return;
    onOpenChange(false);
    navigate(`/atendimento?lead=${event.lead_id}`);
  };

  const [leadName, setLeadName] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [localFechamento, setLocalFechamento] = useState<string | null>(null);
  const [localVendedor, setLocalVendedor] = useState<string | null>(null);
  const [contractDialogOpen, setContractDialogOpen] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [generatedContracts, setGeneratedContracts] = useState<Array<{ id: string; nome_documento: string; status: string; conteudo_renderizado: string; lead_id: string | null; event_id: string | null; template_id: string | null; created_at: string }>>([]);
  const [sendingContractWA, setSendingContractWA] = useState<string | null>(null);
  const [sendingContractSign, setSendingContractSign] = useState<string | null>(null);
  const [wapiInstances, setWapiInstances] = useState<Array<{ id: string; instance_id: string; instance_token: string; unit: string | null; status: string }>>([]);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>("");
  const [sentWA, setSentWA] = useState<Set<string>>(new Set());
  const [sentSign, setSentSign] = useState<Set<string>>(new Set());

  const fetchGeneratedContracts = useCallback(async () => {
    if (!event?.id || !event?.company_id) {
      setGeneratedContracts([]);
      setSentWA(new Set());
      setSentSign(new Set());
      return;
    }

    const { data } = await (supabase as any)
      .from("generated_contracts")
      .select("id, nome_documento, status, conteudo_renderizado, lead_id, event_id, template_id, created_at")
      .eq("event_id", event.id)
      .neq("status", "cancelado")
      .order("created_at", { ascending: false })
      .limit(5);

    const contracts = data || [];
    setGeneratedContracts(contracts);

    const contractIds = contracts.map((contract) => contract.id).filter(Boolean);
    if (contractIds.length === 0) {
      setSentWA(new Set());
      setSentSign(new Set());
      return;
    }

    const { data: logs } = await (supabase as any)
      .from("contract_audit_logs")
      .select("contract_id, action")
      .eq("company_id", event.company_id)
      .in("contract_id", contractIds)
      .in("action", ["contract_sent_whatsapp", "contract_sent_for_signature"]);

    const waIds = new Set<string>();
    const signIds = new Set<string>();

    for (const log of logs || []) {
      if (log.action === "contract_sent_whatsapp" && log.contract_id) waIds.add(log.contract_id);
      if (log.action === "contract_sent_for_signature" && log.contract_id) signIds.add(log.contract_id);
    }

    setSentWA(waIds);
    setSentSign(signIds);
  }, [event?.id, event?.company_id]);

  const fetchInstances = useCallback(async () => {
    if (!event?.company_id) return;
    const { data } = await (supabase as any)
      .from("wapi_instances")
      .select("id, instance_id, instance_token, unit, status")
      .eq("company_id", event.company_id)
      .eq("is_active", true)
      .order("unit");
    const list = data || [];
    setWapiInstances(list);
    // Auto-select instance matching event unit, or first available
    if (list.length > 0) {
      const matching = event?.unit ? list.find((i: any) => i.unit === event.unit) : null;
      setSelectedInstanceId(matching?.id || list[0].id);
    }
  }, [event?.company_id, event?.unit]);

  useEffect(() => {
    if (open && event?.id) {
      fetchGeneratedContracts();
      fetchInstances();
    }
  }, [open, event?.id, fetchGeneratedContracts, fetchInstances]);

  const getSelectedInstance = () => wapiInstances.find(i => i.id === selectedInstanceId) || null;

  const handleContractSendWA = async (contract: typeof generatedContracts[0]) => {
    if (!event?.company_id || !userId) return;
    const inst = getSelectedInstance();
    if (!inst) {
      toast({ title: "Nenhuma instância selecionada", description: "Selecione uma instância do WhatsApp.", variant: "destructive" });
      return;
    }
    let leadId = contract.lead_id;
    if (!leadId && contract.event_id) {
      const { data: ev } = await supabase.from("company_events").select("lead_id").eq("id", contract.event_id).single();
      leadId = ev?.lead_id || null;
    }
    if (!leadId) {
      toast({ title: "Lead não vinculado", description: "Este contrato não possui um lead associado.", variant: "destructive" });
      return;
    }
    setSendingContractWA(contract.id);
    try {
      const result = await sendContractViaWhatsApp(event.company_id, leadId, contract.conteudo_renderizado, contract.nome_documento);

      if (!result.success) {
        toast({
          title: "Erro ao enviar",
          description: result.error,
          variant: "destructive",
        });
        return;
      }

      if (!["aguardando_assinatura", "assinado"].includes(contract.status)) {
        await supabase.from("generated_contracts").update({ status: "enviado" }).eq("id", contract.id);
      }
      setSentWA(prev => new Set(prev).add(contract.id));
      toast({ title: `Contrato enviado via ${inst.unit || 'WhatsApp'} ✅` });
      await logContractAction(event.company_id, contract.id, contract.template_id, "contract_sent_whatsapp", userId, { lead_id: leadId, instance_unit: inst.unit });
    } finally {
      setSendingContractWA(null);
    }
  };

  const handleContractSendSign = async (contract: typeof generatedContracts[0]) => {
    if (!event?.company_id || !userId) return;
    const inst = getSelectedInstance();
    if (!inst) {
      toast({ title: "Nenhuma instância selecionada", description: "Selecione uma instância do WhatsApp.", variant: "destructive" });
      return;
    }
    setSendingContractSign(contract.id);
    try {
      const { data: companyInfo } = await supabase.from("companies").select("name").eq("id", event.company_id).maybeSingle();
      const r = await sendContractForSignature({ companyId: event.company_id, companyName: companyInfo?.name || "", contract, userId, instance: inst });
      if (!r.ok) toast({ title: "Não consegui enviar para assinatura", description: r.error, variant: "destructive" });
      else {
        setSentSign(prev => new Set(prev).add(contract.id));
        toast({ title: `Link de assinatura enviado via ${inst.unit || "WhatsApp"} ✅` });
      }
      fetchGeneratedContracts();
    } finally {
      setSendingContractSign(null);
    }
  };

  // Sync local state with event prop
  useEffect(() => {
    setLocalFechamento(event?.data_fechamento_venda || null);
    setLocalVendedor(event?.vendedor_responsavel_id || null);
  }, [event?.data_fechamento_venda, event?.vendedor_responsavel_id, event?.id]);

  const getControlUrl = () => `${window.location.origin}/festa/${event?.id}`;

  const handleCopyControlLink = () => {
    navigator.clipboard.writeText(getControlUrl());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShareWhatsApp = (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = getControlUrl();
    const text = `🎉 Painel de controle da festa *${event?.title}*:\n${url}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
  };

  useEffect(() => {
    if (!event?.lead_id) { setLeadName(null); return; }
    supabase.from("campaign_leads").select("name").eq("id", event.lead_id).single()
      .then(({ data }) => setLeadName(data?.name || null));
  }, [event?.lead_id]);

  // Fetch sellers for vendedor selector
  useEffect(() => {
    if (!event?.company_id) return;
    supabase
      .from("company_sellers")
      .select("id, name")
      .eq("company_id", event.company_id)
      .eq("is_active", true)
      .order("name")
      .then(({ data }) => {
        if (data) {
          setTeamMembers(data.map(d => ({ user_id: d.id, full_name: d.name })));
        }
      });
  }, [event?.company_id]);

  const saveCommercialField = async (field: string, value: string | null) => {
    if (!event) return;
    // Optimistic update
    if (field === 'data_fechamento_venda') setLocalFechamento(value);
    if (field === 'vendedor_responsavel_id') setLocalVendedor(value);

    setSavingField(field);
    console.log('[EventDetail:CommercialUpdate]', { eventId: event.id, field, value });
    const { error } = await supabase
      .from("company_events")
      .update({ [field]: value })
      .eq("id", event.id);
    if (error) {
      toast({ title: "Erro ao salvar", description: error.message, variant: "destructive" });
      // Revert on error
      if (field === 'data_fechamento_venda') setLocalFechamento(event.data_fechamento_venda || null);
      if (field === 'vendedor_responsavel_id') setLocalVendedor(event.vendedor_responsavel_id || null);
    } else {
      toast({ title: "Dados comerciais atualizados!" });
    }
    setSavingField(null);
  };

  if (!event) return null;

  const statusInfo = STATUS_MAP[event.status] || STATUS_MAP.pendente;
  const dateFormatted = format(new Date(event.event_date + "T12:00:00"), "EEEE, dd 'de' MMMM 'de' yyyy", { locale: ptBR });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto p-0 [&>button.absolute]:hidden">
        {/* Premium Header */}
        <div className="sticky top-0 z-10 bg-card border-b border-border/40 px-6 pt-6 pb-4 shadow-sm">
          <div className="absolute inset-0 bg-primary/[0.04] pointer-events-none" />
          <SheetHeader>
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-xl shrink-0"
                onClick={() => onOpenChange(false)}
              >
                <X className="h-5 w-5" />
                <span className="sr-only">Fechar</span>
              </Button>
              <div className="flex-1 min-w-0">
                <SheetTitle className="text-left text-lg truncate">{event.title}</SheetTitle>
                <p className="text-xs text-muted-foreground capitalize mt-0.5">{dateFormatted}</p>
              </div>
              <Badge variant={statusInfo.variant} className="shrink-0">{statusInfo.label}</Badge>
            </div>
          </SheetHeader>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Conflict Alert */}
          {conflicts.length > 0 && (
            <div className="flex items-start gap-2.5 p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold text-xs">Conflito de horário!</p>
                <p className="text-xs mt-0.5 opacity-80">{conflicts.map(c => c.title).join(", ")} no mesmo horário/unidade.</p>
              </div>
            </div>
          )}

          {/* Lead vinculado + Observações */}
          {(event.lead_id && leadName || event.notes) && (
            <div className="rounded-xl border border-border/40 bg-card shadow-sm overflow-hidden">
              <div className="px-4 py-2.5 bg-muted/30 border-b border-border/30">
                <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">Informações Adicionais</p>
              </div>
              <div className="p-4 space-y-4">
                {event.lead_id && leadName && (
                  <button
                    type="button"
                    onClick={openLinkedLead}
                    title="Abrir informações do lead"
                    className="w-full flex items-center gap-3 text-sm text-left rounded-lg -m-1 p-1 hover:bg-primary/5 active:bg-primary/10 transition-colors group"
                  >
                    <div className="p-1.5 rounded-lg bg-primary/10"><UserCheck className="h-4 w-4 text-primary" /></div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] text-muted-foreground font-medium">Lead vinculado</p>
                      <p className="font-medium text-primary group-hover:underline truncate">{leadName}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 group-hover:text-primary transition-colors" />
                  </button>
                )}
                {event.lead_id && leadName && event.notes && <Separator className="opacity-40" />}
                {event.notes && (
                  <div>
                    <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Observações</p>
                    <p className="text-sm whitespace-pre-wrap text-foreground/80 leading-relaxed">{event.notes}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 💰 FINANCIAL — Primary Block */}
          {event.company_id && financialPerms.canView && (
            <div className="rounded-xl border border-primary/20 bg-gradient-to-br from-card to-primary/[0.02] shadow-md overflow-hidden">
              <div className="px-4 py-3 bg-primary/[0.06] border-b border-primary/10 flex items-center gap-2.5">
                <div className="p-1.5 rounded-lg bg-primary/15">
                  <DollarSign className="h-4 w-4 text-primary" />
                </div>
                <p className="text-xs font-bold uppercase tracking-[0.15em] text-foreground">Financeiro</p>
              </div>
              <div className="p-4">
                <EventFinancialTab
                  eventId={event.id}
                  companyId={event.company_id}
                  baseValue={event.total_value || 0}
                  canEdit={financialPerms.canEdit && !financialPerms.isLoading}
                  canPay={financialPerms.canPay}
                  showValues={financialPerms.canViewValues}
                  onAddOptional={() => onEdit(event)}
                  onConsentSubmit={financialPerms.requiresConsent ? consentHook.submitForConsent : undefined}
                />
              </div>
            </div>
          )}

          {/* Detalhes do Evento */}
          <div className="rounded-xl border border-border/40 bg-card shadow-sm overflow-hidden">
            <div className="px-4 py-2.5 bg-muted/30 border-b border-border/30">
              <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">Detalhes do Evento</p>
            </div>
            <div className="p-4 space-y-3 text-sm">
              {(event.start_time || event.end_time) && (
                <div className="flex items-center gap-3 text-foreground">
                  <div className="p-1.5 rounded-lg bg-primary/10"><Clock className="h-4 w-4 text-primary" /></div>
                  <span>{event.start_time?.slice(0, 5) || "–"} até {event.end_time?.slice(0, 5) || "–"}</span>
                </div>
              )}

              {event.event_type && (
                <div className="flex items-center gap-3 text-foreground">
                  <div className="p-1.5 rounded-lg bg-secondary/20"><Package className="h-4 w-4 text-secondary-foreground" /></div>
                  <span className="capitalize">{event.event_type}</span>
                </div>
              )}

              {event.guest_count && (
                <div className="flex items-center gap-3 text-foreground">
                  <div className="p-1.5 rounded-lg bg-primary/10"><Users className="h-4 w-4 text-primary" /></div>
                  <span>{event.guest_count} convidados</span>
                </div>
              )}

              {event.unit && (
                <div className="flex items-center gap-3 text-foreground">
                  <div className="p-1.5 rounded-lg bg-primary/10"><MapPin className="h-4 w-4 text-primary" /></div>
                  <span>{event.unit}</span>
                </div>
              )}

              {showRevenue && event.total_value != null && (
                <div className="flex items-center gap-3 text-foreground">
                  <div className="p-1.5 rounded-lg bg-primary/10"><DollarSign className="h-4 w-4 text-primary" /></div>
                  <span className="font-medium">{event.total_value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</span>
                </div>
              )}

              {event.payment_method && (
                <div className="flex items-center gap-3 text-foreground">
                  <div className="p-1.5 rounded-lg bg-primary/10"><CreditCard className="h-4 w-4 text-primary" /></div>
                  <span>{{ cartao: "Cartão", boleto: "Boleto", pix: "PIX", dinheiro: "Dinheiro", misto: "Misto" }[event.payment_method] || event.payment_method}</span>
                </div>
              )}

              {event.package_name && (
                <div className="flex items-center gap-3 text-foreground">
                  <div className="p-1.5 rounded-lg bg-secondary/20"><Package className="h-4 w-4 text-secondary-foreground" /></div>
                  <span>{event.package_name}</span>
                </div>
              )}
            </div>
          </div>


          {/* Checklist + Resumo da Festa */}
          {event.company_id && (
            <div className="rounded-xl border border-border/40 bg-card shadow-sm overflow-hidden">
              <EventSummaryPanel
                event={event}
                leadName={leadName}
                companyId={event.company_id}
                onInternalNotesChange={(value) => onEventPatch?.(event.id, { internal_notes: value })}
              />
            </div>
          )}

          {/* Formulários Complementares */}
          {event.company_id && (
            <EventFormsStatusPanel
              eventId={event.id}
              companyId={event.company_id}
              leadId={event.lead_id}
              eventDate={event.event_date}
              parentNames={leadName}
            />
          )}

          {/* Dados Comerciais */}
          <div className="rounded-xl border border-border/40 bg-card shadow-sm overflow-hidden">
            <div className="px-4 py-2.5 bg-muted/30 border-b border-border/30 flex items-center gap-2">
              <Briefcase className="h-3.5 w-3.5 text-primary" />
              <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">Dados Comerciais</p>
            </div>
            <div className="p-4 space-y-3">
              {(!localFechamento || !localVendedor) && (
                <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/40">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">Dados comerciais incompletos</p>
                    <ul className="text-[11px] text-amber-600 dark:text-amber-500 mt-0.5 space-y-0.5">
                      {!localFechamento && <li>• Data de fechamento não definida</li>}
                      {!localVendedor && <li>• Vendedor não definido</li>}
                    </ul>
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Data de fechamento</span>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "h-7 text-xs gap-1.5 rounded-lg px-2",
                        localFechamento ? "font-medium" : "text-muted-foreground/60"
                      )}
                      disabled={savingField === 'data_fechamento_venda'}
                    >
                      {savingField === 'data_fechamento_venda' ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <CalendarIcon className="h-3 w-3" />
                      )}
                      {localFechamento
                        ? format(new Date(localFechamento + "T12:00:00"), "dd/MM/yyyy")
                        : "Selecionar"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0 rounded-xl shadow-lg" align="end">
                    <Calendar
                      mode="single"
                      selected={localFechamento ? new Date(localFechamento + "T12:00:00") : undefined}
                      onSelect={(date) => {
                        if (date) {
                          const formatted = format(date, "yyyy-MM-dd");
                          saveCommercialField('data_fechamento_venda', formatted);
                        }
                      }}
                      locale={ptBR}
                      className="p-3 pointer-events-auto"
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Vendedor</span>
                <Select
                  value={localVendedor || "none"}
                  onValueChange={(v) => saveCommercialField('vendedor_responsavel_id', v === "none" ? null : v)}
                  disabled={savingField === 'vendedor_responsavel_id'}
                >
                  <SelectTrigger className={cn(
                    "h-7 w-auto min-w-[120px] max-w-[180px] text-xs rounded-lg border-0 bg-transparent hover:bg-muted/50 gap-1.5 px-2",
                    localVendedor ? "font-medium" : "text-muted-foreground/60"
                  )}>
                    {savingField === 'vendedor_responsavel_id' ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <SelectValue placeholder="Selecionar" />
                    )}
                  </SelectTrigger>
                  <SelectContent className="rounded-xl">
                    <SelectItem value="none">Nenhum</SelectItem>
                    {teamMembers.map((m) => (
                      <SelectItem key={m.user_id} value={m.user_id}>{m.full_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Contract Readiness Panel */}
          {event.company_id && userId && (
            <ContractReadinessPanel
              eventId={event.id}
              eventData={{
                title: event.title,
                event_date: event.event_date,
                start_time: event.start_time,
                end_time: event.end_time,
                event_type: event.event_type,
                guest_count: event.guest_count,
                unit: event.unit,
                package_name: event.package_name,
                total_value: event.total_value,
                lead_id: event.lead_id,
                payment_method: event.payment_method,
              }}
              onGenerateContract={(modelId) => {
                setSelectedModelId(modelId);
                setContractDialogOpen(true);
              }}
            />
          )}

          {/* Generated Contracts Shortcuts */}
          {generatedContracts.length > 0 && (
            <div className="rounded-xl border border-border/40 bg-card shadow-sm overflow-hidden">
              <div className="px-4 py-2.5 bg-muted/30 border-b border-border/30 flex items-center gap-2">
                <FileSignature className="h-3.5 w-3.5 text-primary" />
                <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">Contratos Gerados</p>
              </div>
              {wapiInstances.length > 1 && (
                <div className="px-3 py-2 border-b border-border/30">
                  <Select value={selectedInstanceId} onValueChange={setSelectedInstanceId}>
                    <SelectTrigger className="h-7 text-[11px]">
                      <SelectValue placeholder="Enviar via...">
                        {(() => {
                          const sel = wapiInstances.find(i => i.id === selectedInstanceId);
                          if (!sel) return "Enviar via...";
                          return (
                            <span className="flex items-center gap-2">
                              {sel.unit || sel.instance_id}
                              <Badge variant="outline" className={cn("text-[9px] px-1.5 py-0", sel.status === "connected" ? "bg-green-500/15 text-green-700 border-green-200" : "bg-muted text-muted-foreground")}>
                                {sel.status === "connected" ? "Online" : "Offline"}
                              </Badge>
                            </span>
                          );
                        })()}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {wapiInstances.map((inst) => (
                        <SelectItem key={inst.id} value={inst.id} className="text-xs">
                          <span className="flex items-center gap-2">
                            {inst.unit || inst.instance_id}
                            <Badge variant="outline" className={cn("text-[9px] px-1.5 py-0", inst.status === "connected" ? "bg-green-500/15 text-green-700 border-green-200" : "bg-muted text-muted-foreground")}>
                              {inst.status === "connected" ? "Online" : "Offline"}
                            </Badge>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="p-3 space-y-2">
                {generatedContracts.map((gc) => {
                  const STATUS_COLORS: Record<string, string> = {
                    gerado: "bg-blue-500/15 text-blue-700 border-blue-300",
                    enviado: "bg-amber-500/15 text-amber-700 border-amber-300",
                    assinado: "bg-emerald-500/15 text-emerald-700 border-emerald-300",
                    aguardando_assinatura: "bg-purple-500/15 text-purple-700 border-purple-300",
                  };
                  const STATUS_LABELS: Record<string, string> = {
                    gerado: "Gerado", enviado: "Enviado", assinado: "Assinado ✅", aguardando_assinatura: "Aguardando",
                  };
                  return (
                    <div key={gc.id} className="rounded-lg border border-border/40 bg-muted/30 p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium truncate flex-1">{gc.nome_documento}</span>
                        <Badge variant="outline" className={cn("text-[10px] shrink-0", STATUS_COLORS[gc.status] || "")}>
                          {STATUS_LABELS[gc.status] || gc.status}
                        </Badge>
                      </div>
                    <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className={cn("h-9 text-xs px-3 gap-1.5 rounded-full border-emerald-300/50 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800", (sentWA.has(gc.id) || gc.status === "enviado") && "bg-emerald-500/15 text-emerald-700 border-emerald-300")}
                          disabled={sendingContractWA === gc.id}
                          onClick={() => handleContractSendWA(gc)}
                        >
                          {sendingContractWA === gc.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
                          {sentWA.has(gc.id) || gc.status === "enviado" ? "Reenviar WhatsApp" : "WhatsApp"}
                        </Button>
                        {gc.status !== "assinado" && (
                          <Button
                            variant="outline"
                            size="sm"
                            className={cn("h-9 text-xs px-3 gap-1.5 rounded-full border-emerald-300/50 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800", (sentSign.has(gc.id) || gc.status === "aguardando_assinatura") && "bg-emerald-500/15 text-emerald-700 border-emerald-300")}
                            disabled={sendingContractSign === gc.id}
                            onClick={() => handleContractSendSign(gc)}
                          >
                            {sendingContractSign === gc.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSignature className="h-4 w-4" />}
                            {sentSign.has(gc.id) || gc.status === "aguardando_assinatura" ? "Assinatura ✅" : "Enviar p/ Assinatura"}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div
            className="rounded-xl p-3.5 flex items-center gap-3"
            style={{ background: "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)", border: "1px solid rgba(96,165,250,0.2)" }}
          >
            <div
              className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: "linear-gradient(135deg, #2563eb, #1d4ed8)" }}
            >
              <Gamepad2 className="h-5 w-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold" style={{ color: "#93c5fd" }}>Controle da Festa</p>
              <p className="text-xs" style={{ color: "#64748b" }}>Copiar ou compartilhar link do painel</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => window.open(getControlUrl(), "_blank")}
                className="h-8 w-8 rounded-lg flex items-center justify-center transition-colors"
                style={{ background: "rgba(168,85,247,0.15)" }}
                title="Abrir painel"
              >
                <ExternalLink className="h-4 w-4" style={{ color: "#c084fc" }} />
              </button>
              <button
                onClick={handleShareWhatsApp}
                className="h-8 w-8 rounded-lg flex items-center justify-center transition-colors"
                style={{ background: "rgba(37,211,102,0.15)" }}
                title="Compartilhar no WhatsApp"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" style={{ color: "#25d366" }}>
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                </svg>
              </button>
              <button
                onClick={handleCopyControlLink}
                className="h-8 w-8 rounded-lg flex items-center justify-center transition-colors"
                style={{ background: "rgba(96,165,250,0.15)" }}
                title="Copiar link"
              >
                {copied
                  ? <Check className="h-4 w-4" style={{ color: "#34d399" }} />
                  : <Copy className="h-4 w-4" style={{ color: "#93c5fd" }} />
                }
              </button>
            </div>
          </div>




          {/* Linked Tasks */}
          {userId && event.company_id && (
            <>
              <Separator />
              <EventTasksSection eventId={event.id} userId={userId} companyId={event.company_id} />
            </>
          )}

          {/* Action Buttons */}
          <div className="flex gap-2 pt-1 pb-2">
            <Button variant="outline" className="flex-1 rounded-xl h-10" onClick={() => onEdit(event)}>
              <Pencil className="h-4 w-4 mr-2" /> Editar
            </Button>
            <Button variant="destructive" size="icon" className="rounded-xl h-10 w-10" onClick={() => onDelete(event.id)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Contract Generation Dialog */}
        {userId && selectedModelId && (
          <EventContractDialog
            open={contractDialogOpen}
            onOpenChange={(o) => {
              setContractDialogOpen(o);
              if (!o) {
                setSelectedModelId("");
                fetchGeneratedContracts();
              }
            }}
            eventId={event.id}
            modelId={selectedModelId}
            userId={userId}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
