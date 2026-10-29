import { useState, useEffect } from "react";
import { filterCardapioTemplatesByPackage } from "@/lib/cardapioMatch";
import { loadFormsSent, recordFormSent } from "@/lib/formSentHistory";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import {
  Send, Loader2, Copy, ChevronDown, CheckCircle2, Clock,
  FileText, ClipboardList, UtensilsCrossed, ScrollText, ExternalLink, Star,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { buildPublicFormUrl } from "@/lib/publicFormRoutes";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import type { EventFormData } from "./EventFormDialog";

interface FormTemplate {
  id: string;
  name: string;
  slug: string | null;
  questions?: any;
  sections?: any;
}

interface FormResponse {
  id: string;
  answers: any;
  respondent_name: string | null;
  created_at: string;
}

interface FormSection {
  type: "prefesta" | "cardapio" | "contrato" | "avaliacao";
  label: string;
  icon: React.ElementType;
  templates: FormTemplate[];
  responses: Map<string, FormResponse[]>; // template_id -> responses
  publicPath: string;
}

interface WapiInstance {
  instance_id: string;
  unit: string | null;
  status: string | null;
}

interface EventComplementaryTabProps {
  eventId: string;
  companyId: string;
  companySlug: string;
  leadPhone?: string | null;
  form: EventFormData;
  setForm: React.Dispatch<React.SetStateAction<EventFormData>>;
  onSaveFirst?: () => Promise<string | null>;
}

export function EventComplementaryTab({
  eventId,
  companyId,
  companySlug,
  leadPhone,
  form,
  setForm,
  onSaveFirst,
}: EventComplementaryTabProps) {
  const [sections, setSections] = useState<FormSection[]>([]);
  const [loading, setLoading] = useState(!!companyId);
  const [sendingForm, setSendingForm] = useState<string | null>(null);
  const [savingBeforeOpen, setSavingBeforeOpen] = useState(false);
  const [iframeModal, setIframeModal] = useState<{ url: string; title: string } | null>(null);
  const [instances, setInstances] = useState<WapiInstance[]>([]);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>("");
  const [sentForms, setSentForms] = useState<Set<string>>(new Set());

  // Load WhatsApp instances
  useEffect(() => {
    if (!companyId) return;
    supabase
      .from("wapi_instances")
      .select("instance_id, unit, status")
      .eq("company_id", companyId)
      .then(({ data }) => {
        const list = (data || []) as WapiInstance[];
        setInstances(list);
        // Auto-select: prefer unit match, then first connected
        const unitMatch = form.unit ? list.find(i => i.unit === form.unit && i.status === "connected") : null;
        const firstConnected = list.find(i => i.status === "connected");
        setSelectedInstanceId((unitMatch || firstConnected)?.instance_id || list[0]?.instance_id || "");
      });
  }, [companyId, form.unit]);

  // Formulários já enviados para esta festa (histórico do lead)
  useEffect(() => {
    if (!eventId || !companyId) return;
    loadFormsSent(eventId).then((records) => {
      if (records.length > 0) setSentForms(new Set(records.map((r) => `${r.form_type}-${r.template_id}`)));
    });
  }, [eventId, companyId]);

  useEffect(() => {
    if (!companyId) {
      setLoading(false);
      return;
    }
    loadData();
  }, [eventId, companyId, form.package_name]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [
        { data: prefestaTemplates },
        { data: cardapioTemplates },
        { data: contratoTemplates },
        { data: evaluationTemplates },
      ] = await Promise.all([
        supabase.from("prefesta_templates").select("id, name, slug, questions").eq("company_id", companyId).eq("is_active", true),
        supabase.from("cardapio_templates").select("id, name, slug, sections").eq("company_id", companyId).eq("is_active", true),
        supabase.from("contrato_templates").select("id, name, slug, questions").eq("company_id", companyId).eq("is_active", true),
        supabase.from("evaluation_templates").select("id, name, slug, questions").eq("company_id", companyId).eq("is_active", true),
      ]);

      let prefestaResponses: any[] | null = null;
      let cardapioResponses: any[] | null = null;
      let contratoResponses: any[] | null = null;
      let evaluationResponses: any[] | null = null;

      if (eventId) {
        const [r1, r2, r3, r4] = await Promise.all([
          supabase.from("prefesta_responses").select("id, template_id, answers, respondent_name, created_at").eq("event_id", eventId),
          supabase.from("cardapio_responses").select("id, template_id, answers, respondent_name, created_at").eq("event_id", eventId),
          supabase.from("contrato_responses").select("id, template_id, answers, respondent_name, created_at").eq("event_id", eventId),
          supabase.from("evaluation_responses").select("id, template_id, answers, respondent_name, created_at").eq("event_id", eventId),
        ]);
        prefestaResponses = r1.data;
        cardapioResponses = r2.data;
        contratoResponses = r3.data;
        evaluationResponses = r4.data;
      }

      const mapResponses = (responses: any[] | null) => {
        const map = new Map<string, FormResponse[]>();
        (responses || []).forEach((r: any) => {
          const list = map.get(r.template_id) || [];
          list.push(r);
          map.set(r.template_id, list);
        });
        return map;
      };

      setSections([
        {
          type: "prefesta",
          label: "Pré-Festa",
          icon: ClipboardList,
          templates: (prefestaTemplates || []) as FormTemplate[],
          responses: mapResponses(prefestaResponses),
          publicPath: "pre-festa",
        },
        {
          type: "cardapio",
          label: "Cardápio",
          icon: UtensilsCrossed,
          templates: filterCardapioTemplatesByPackage((cardapioTemplates || []) as FormTemplate[], form.package_name, companySlug),
          responses: mapResponses(cardapioResponses),
          publicPath: "cardapio",
        },
        {
          type: "contrato",
          label: "Dados Complementares",
          icon: ScrollText,
          templates: (contratoTemplates || []) as FormTemplate[],
          responses: mapResponses(contratoResponses),
          publicPath: "contrato",
        },
        {
          type: "avaliacao",
          label: "Avaliação",
          icon: Star,
          templates: (evaluationTemplates || []) as FormTemplate[],
          responses: mapResponses(evaluationResponses),
          publicPath: "avaliacao",
        },
      ]);
    } catch (err) {
      console.error("Error loading complementary data:", err);
    } finally {
      setLoading(false);
    }
  };

  const getFormLink = (section: FormSection, template: FormTemplate, overrideEventId?: string) => {
    const eid = overrideEventId || eventId;
    return buildPublicFormUrl({
      type: section.type,
      templateId: template.id,
      templateSlug: template.slug,
      companySlug,
      baseUrl: window.location.origin,
      eventId: eid,
    });
  };

  const openFormModal = async (section: FormSection, template: FormTemplate) => {
    let currentEventId = eventId;

    // If no eventId yet (new event), save first
    if (!currentEventId && onSaveFirst) {
      setSavingBeforeOpen(true);
      try {
        const savedId = await onSaveFirst();
        if (!savedId) {
          setSavingBeforeOpen(false);
          return; // save failed or validation error
        }
        currentEventId = savedId;
      } catch {
        setSavingBeforeOpen(false);
        return;
      }
      setSavingBeforeOpen(false);
    }

    if (!currentEventId) {
      toast({ title: "Salve a festa primeiro", variant: "destructive" });
      return;
    }

    const url = getFormLink(section, template, currentEventId);
    setIframeModal({ url, title: `${section.label} — ${template.name}` });
  };

  const copyFormLink = (section: FormSection, template: FormTemplate) => {
    const link = getFormLink(section, template);
    navigator.clipboard.writeText(link);
    toast({ title: "Link copiado!" });
  };

  const FORM_TYPE_DEFAULT_MESSAGES: Record<string, string> = {
    prefesta: "Olá {{nome}}! 🎉\n\nSua festa está chegando! Para garantir que tudo saia perfeito, precisamos de algumas informações.\n\nPreencha o formulário abaixo:\n{{link}}",
    cardapio: "Olá {{nome}}! 🍽️\n\nVamos definir o cardápio da sua festa? Acesse o link abaixo e escolha as opções:\n\n{{link}}",
    contrato: "Olá {{nome}}! 😊\n\nEstamos finalizando os detalhes da sua festa no {{empresa}} no dia {{data_evento}}.\n\nPara seguirmos, preencha seus dados pessoais e as informações do aniversariante no link abaixo. Assim o buffet consegue finalizar o contrato com essas informações. 🎉\n\n{{link}}",
    avaliacao: "Olá {{nome}}! ⭐\n\nEsperamos que a festa tenha sido incrível! 🎊\n\nNos ajude a melhorar cada vez mais respondendo nossa avaliação:\n{{link}}",
  };

  const sendFormToHost = async (section: FormSection, template: FormTemplate) => {
    if (!leadPhone) {
      toast({ title: "Lead sem WhatsApp vinculado", variant: "destructive" });
      return;
    }

    if (!selectedInstanceId) {
      toast({ title: "Selecione uma instância WhatsApp", variant: "destructive" });
      return;
    }

    const key = `${section.type}-${template.id}`;
    setSendingForm(key);

    try {
      const selectedInstance = instances.find(i => i.instance_id === selectedInstanceId);
      const link = getFormLink(section, template);

      // Fetch configured template from form_automation_settings
      const { data: automationSettings } = await supabase
        .from("form_automation_settings")
        .select("message_template")
        .eq("company_id", companyId)
        .eq("form_type", section.type)
        .maybeSingle();

      const rawTemplate = automationSettings?.message_template || FORM_TYPE_DEFAULT_MESSAGES[section.type] || "";

      // Get lead name (contratante), NOT event title (aniversariante)
      // A festa aberta por alguns caminhos não traz o nome do lead: busca antes de cair em "Cliente"
      let linkedLeadName = form.lead_name || null;
      if (!linkedLeadName && form.lead_id) {
        const { data: leadRow } = await supabase.from("campaign_leads").select("name").eq("id", form.lead_id).maybeSingle();
        linkedLeadName = leadRow?.name || null;
      }
      const leadName = linkedLeadName || form.parent_names || "Cliente";
      const firstName = leadName.split(" ")[0];
      const eventDate = form.event_date ? format(new Date(form.event_date + "T12:00:00"), "dd/MM/yyyy") : "";

      // Fetch company name
      const { data: companyData } = await supabase
        .from("companies")
        .select("name")
        .eq("id", companyId)
        .single();

      const message = rawTemplate
        .replace(/\{\{\s*nome\s*\}\}/gi, firstName)
        .replace(/\{\{\s*link\s*\}\}/gi, link)
        .replace(/\{\{\s*data_evento\s*\}\}/gi, eventDate)
        .replace(/\{\{\s*empresa\s*\}\}/gi, companyData?.name || "");

      toast({ title: `Enviando via ${selectedInstance?.unit || 'WhatsApp'}...` });

      // Reuse a conversa existente apenas se ela pertencer à instância atualmente selecionada.
      // Isso evita tentar enviar por uma instância antiga/desconectada e disparar erro na Edge Function.
      const { findExistingConversation, toCanonicalBrazilianPhone } = await import("@/lib/whatsappConversationHelper");
      const existingConv = await findExistingConversation(form.lead_id, leadPhone, companyId);
      const matchingConversation = existingConv?.instanceId === selectedInstanceId ? existingConv : null;

      // Sempre envia o telefone no formato canônico (com 55) para que a edge
      // não crie um chat duplicado caso o lead esteja salvo sem código do país.
      const canonicalPhone = toCanonicalBrazilianPhone(leadPhone);

      const { data: sendData, error } = await supabase.functions.invoke("wapi-send", {
        body: {
          action: "send-text",
          phone: canonicalPhone,
          message,
          instanceId: selectedInstanceId,
          ...(matchingConversation && {
            conversationId: matchingConversation.conversationId,
            companyId: matchingConversation.companyId,
          }),
        },
      });

      if (error) {
        console.error("[sendForm] wapi-send error:", error, "response data:", sendData);
        const errMsg = typeof sendData === "object" && sendData?.error ? sendData.error : error.message;
        throw new Error(errMsg);
      }

      // Persist sent status
      setSentForms(prev => new Set(prev).add(key));
      if (form.lead_id) {
        await recordFormSent(form.lead_id, companyId, { form_type: section.type, template_id: template.id, event_id: eventId, template_name: template.name });
      }

      toast({ title: `Formulário de ${section.label} enviado via WhatsApp!` });
    } catch (err: any) {
      toast({ title: "Erro ao enviar", description: err.message, variant: "destructive" });
    } finally {
      setSendingForm(null);
    }
  };

  const renderAnswers = (answers: any, template: FormTemplate, type: string) => {
    if (!answers) return null;

    // For cardapio, answers is structured differently (sections-based)
    if (type === "cardapio" && template.sections) {
      const sections = Array.isArray(template.sections) ? template.sections : [];
      return (
        <div className="space-y-3">
          {sections.map((section: any, sIdx: number) => {
            const sectionAnswers = answers[section.title || `section_${sIdx}`];
            if (!sectionAnswers) return null;
            return (
              <div key={sIdx} className="space-y-1">
                <p className="text-xs font-semibold text-foreground/80">{section.title}</p>
                {Array.isArray(sectionAnswers) ? (
                  <ul className="text-xs text-muted-foreground space-y-0.5 pl-3">
                    {sectionAnswers.map((item: string, i: number) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <span className="text-primary mt-0.5">•</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">{String(sectionAnswers)}</p>
                )}
              </div>
            );
          })}
          {/* Render any top-level answers not in sections */}
          {Object.entries(answers).filter(([key]) => !sections.some((s: any) => (s.title || `section_${sections.indexOf(s)}`) === key)).map(([key, value]) => (
            <div key={key} className="space-y-0.5">
              <p className="text-xs font-medium text-foreground/70 capitalize">{key.replace(/_/g, " ")}</p>
              <p className="text-xs text-muted-foreground">{String(value)}</p>
            </div>
          ))}
        </div>
      );
    }

    // For prefesta and contrato (questions-based)
    const questions = Array.isArray(template.questions) ? template.questions : [];

    const formatAnswerValue = (val: any): string => {
      if (val === true) return "👍 Sim";
      if (val === false) return "👎 Não";
      if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}T/.test(val)) {
        try { return format(new Date(val), "dd/MM/yyyy", { locale: ptBR }); } catch { return val; }
      }
      if (typeof val === "object" && val !== null) return JSON.stringify(val);
      return String(val ?? "—");
    };

    if (Array.isArray(answers)) {
      return (
        <div className="space-y-2">
          {answers.map((answer: any, i: number) => {
            // Support {questionId, value} format
            const isObj = answer && typeof answer === "object" && "questionId" in answer;
            const qId = isObj ? answer.questionId : null;
            const val = isObj ? answer.value : answer;

            // Match by exact id, prefix, or index fallback
            const question = qId
              ? (questions.find((q: any) => q.id === qId) || questions.find((q: any) => qId.startsWith(q.id)))
              : questions[i];

            const label = question?.text || question?.label || question?.title || `Pergunta ${i + 1}`;

            return (
              <div key={i} className="space-y-0.5">
                <p className="text-xs font-medium text-foreground/70">{label}</p>
                <p className="text-xs text-muted-foreground">{formatAnswerValue(val)}</p>
              </div>
            );
          })}
        </div>
      );
    }

    // Object-based answers
    return (
      <div className="space-y-2">
        {Object.entries(answers).map(([key, value]) => {
          const question = questions.find((q: any) => q.id === key || q.label === key)
            || questions.find((q: any) => key.startsWith(q.id));
          return (
            <div key={key} className="space-y-0.5">
              <p className="text-xs font-medium text-foreground/70">
                {question?.text || question?.label || question?.title || key.replace(/_/g, " ")}
              </p>
              <p className="text-xs text-muted-foreground">{formatAnswerValue(value)}</p>
            </div>
          );
        })}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Carregando informações complementares...
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Observações Internas */}
      <div className="rounded-xl border border-border/40 bg-card p-5 shadow-sm">
        <div className="flex items-center gap-2.5 text-[11px] uppercase tracking-[0.18em] font-semibold text-muted-foreground mb-4 pb-2.5 border-b border-border/40">
          <div className="p-1.5 rounded-md bg-primary/8 ring-1 ring-primary/15">
            <FileText className="h-3.5 w-3.5 text-primary" />
          </div>
          Observações Internas
        </div>
        <div className="space-y-2.5">
          <Textarea
            value={form.internal_notes || ""}
            onChange={(e) => setForm((prev) => ({ ...prev, internal_notes: e.target.value }))}
            rows={3}
            placeholder="Anotações internas do buffet (não aparece no contrato)..."
          />
          <p className="text-[10px] text-muted-foreground">
            Este campo é exclusivo para uso interno e não será incluído em contratos.
            Após o cliente preencher o Pré-Festa, estas anotações também aparecem dentro do card de respostas do Pré-Festa, onde você pode continuar editando.
          </p>
        </div>
      </div>

      {/* WhatsApp Instance Selector */}
      {instances.length > 1 && (
        <div className="rounded-xl border border-border/40 bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2.5 text-[11px] uppercase tracking-[0.18em] font-semibold text-muted-foreground mb-4 pb-2.5 border-b border-border/40">
            <div className="p-1.5 rounded-md bg-primary/8 ring-1 ring-primary/15">
              <Send className="h-3.5 w-3.5 text-primary" />
            </div>
            Enviar via WhatsApp
          </div>
          <Select value={selectedInstanceId} onValueChange={setSelectedInstanceId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Selecione a instância" />
            </SelectTrigger>
            <SelectContent>
              {instances.map((inst) => (
                <SelectItem key={inst.instance_id} value={inst.instance_id}>
                  <span className="flex items-center gap-2">
                    {inst.unit || inst.instance_id}
                    {inst.status === "connected" ? (
                      <Badge variant="outline" className="text-[9px] bg-green-500/15 text-green-700 border-green-200">Online</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[9px] bg-muted text-muted-foreground">Offline</Badge>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground mt-2">
            Os formulários serão enviados pela instância selecionada.
          </p>
        </div>
      )}

      {/* Form Sections */}
      {sections.map((section) => {
        if (section.templates.length === 0) return null;

        return (
          <div key={section.type} className="rounded-xl border border-border/40 bg-card p-5 shadow-sm">
            <div className="flex items-center gap-2.5 text-[11px] uppercase tracking-[0.18em] font-semibold text-muted-foreground mb-4 pb-2.5 border-b border-border/40">
              <div className="p-1.5 rounded-md bg-primary/8 ring-1 ring-primary/15">
                <section.icon className="h-3.5 w-3.5 text-primary" />
              </div>
              {section.label}
            </div>

            <div className="space-y-3">
              {section.templates.map((template) => {
                const responses = section.responses.get(template.id) || [];
                const hasResponse = responses.length > 0;
                const sendKey = `${section.type}-${template.id}`;

                return (
                  <div
                    key={template.id}
                    className="rounded-lg border border-border/40 bg-muted/20 overflow-hidden"
                  >
                    <div className="px-4 py-3 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium truncate">{template.name}</span>
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px] gap-1 shrink-0",
                            hasResponse
                              ? "bg-green-500/15 text-green-700 border-green-200"
                              : "bg-muted text-muted-foreground"
                          )}
                        >
                          {hasResponse ? (
                            <>
                              <CheckCircle2 className="h-3 w-3" />
                              Respondido
                            </>
                          ) : (
                            <>
                              <Clock className="h-3 w-3" />
                              Pendente
                            </>
                          )}
                        </Badge>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => copyFormLink(section, template)}
                          title="Copiar link"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          disabled={savingBeforeOpen}
                          onClick={() => openFormModal(section, template)}
                          title="Preencher formulário"
                        >
                          {savingBeforeOpen ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                        </Button>
                        <Button
                          type="button"
                          variant={sentForms.has(sendKey) ? "outline" : "default"}
                          size="sm"
                          className={cn(
                            "gap-1.5 text-xs h-7",
                            sentForms.has(sendKey) && "bg-emerald-500/15 text-emerald-700 border-emerald-300 hover:bg-emerald-100"
                          )}
                          disabled={sendingForm === sendKey}
                          onClick={() => sendFormToHost(section, template)}
                        >
                          {sendingForm === sendKey ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : sentForms.has(sendKey) ? (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          ) : (
                            <Send className="h-3.5 w-3.5" />
                          )}
                          {sentForms.has(sendKey) ? "Enviado ✅" : "Enviar"}
                        </Button>
                      </div>
                    </div>

                    {/* Responses */}
                    {hasResponse && (
                      <div className="border-t border-border/40">
                        {responses.map((response) => (
                          <Collapsible key={response.id}>
                            <CollapsibleTrigger className="w-full px-4 py-2.5 flex items-center justify-between text-xs text-muted-foreground hover:bg-muted/40 transition-colors">
                              <span>
                                {response.respondent_name || "Anfitrião"} — {format(new Date(response.created_at), "dd/MM/yyyy 'às' HH:mm")}
                              </span>
                              <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200 [&[data-state=open]]:rotate-180" />
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                              <div className="px-4 py-3 bg-background/50">
                                {renderAnswers(response.answers, template, section.type)}
                              </div>
                            </CollapsibleContent>
                          </Collapsible>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {sections.every((s) => s.templates.length === 0) && (
        <div className="text-center py-8 text-muted-foreground text-sm">
          Nenhum formulário cadastrado. Crie templates em <span className="font-medium">Formulários</span>.
        </div>
      )}

      {/* Modal iframe para preencher formulário internamente */}
      <Dialog open={!!iframeModal} onOpenChange={(open) => { if (!open) { setIframeModal(null); loadData(); } }}>
        <DialogContent className="max-w-2xl w-[95vw] h-[85vh] p-0 flex flex-col">
          <DialogHeader className="px-4 py-3 border-b border-border/40 shrink-0">
            <DialogTitle className="text-sm font-medium">{iframeModal?.title}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0">
            {iframeModal && (
              <iframe
                src={iframeModal.url}
                className="w-full h-full border-0 rounded-b-lg"
                title={iframeModal.title}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
