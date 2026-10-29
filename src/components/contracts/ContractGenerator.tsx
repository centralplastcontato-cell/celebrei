import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCompany } from "@/contexts/CompanyContext";
import { getCompanyLogoOverride } from "@/lib/companyAssetOverrides";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, AlertTriangle, Check, ChevronRight, ShieldAlert, AlertCircle, Eye } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { resolveSystemVariables, findUnresolvedVariables, appendExtensoToValues, type VariableContext } from "@/lib/template-resolver";
import { ContractPreviewPrint } from "./ContractPreviewPrint";
import { ContractDocumentViewer } from "./ContractDocumentViewer";
import { format } from "date-fns";
import { logContractAction, autoSendContractOnGenerate } from "./contractAuditHelpers";
import { formatCPF, isValidCPF } from "@/lib/mask-utils";

interface Props { userId: string; onClose: () => void; }

interface ContractModel {
  id: string; nome_modelo: string; tipo_evento: string; conteudo_template: string; versao: number; company_id: string;
}

export function ContractGenerator({ userId, onClose }: Props) {
  const { currentCompany } = useCompany();
  const [step, setStep] = useState(1);
  const [models, setModels] = useState<ContractModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [events, setEvents] = useState<any[]>([]);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [leadData, setLeadData] = useState<any>(null);
  const [eventData, setEventData] = useState<any>(null);
  const [contractData, setContractData] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [existingContracts, setExistingContracts] = useState<any[]>([]);
  const [firstContractDate, setFirstContractDate] = useState<string | null>(null);
  const [clientReqData, setClientReqData] = useState<Record<string, any> | null>(null);
  const [fullPreviewOpen, setFullPreviewOpen] = useState(false);
  const [cpfError, setCpfError] = useState<string | null>(null);

  // Load models + events
  useEffect(() => {
    if (!currentCompany?.id) return;
    (async () => {
      const [modelsRes, eventsRes] = await Promise.all([
        (supabase as any).from("contract_models").select("id, nome_modelo, tipo_evento, conteudo_template, versao, company_id").eq("company_id", currentCompany.id).eq("is_active", true).order("nome_modelo"),
        (supabase as any).from("company_events").select("id, title, event_date, start_time, end_time, event_type, package_name, guest_count, total_value, unit, lead_id, status, child_name, child_age, child_birthdate, parent_names, gifts, extra_guest_value, payment_details, event_optionals").eq("company_id", currentCompany.id).neq("status", "cancelado").order("event_date", { ascending: false }).limit(200),
      ]);
      setModels(modelsRes.data || []);
      setEvents(eventsRes.data || []);
    })();
  }, [currentCompany?.id]);

  // Load lead data + check existing contracts when event selected
  useEffect(() => {
    if (!selectedEventId) return;
    const ev = events.find(e => e.id === selectedEventId);
    setEventData(ev);

    (async () => {
      setLoading(true);
      // Check for existing contracts for this event
      const { data: existing } = await (supabase as any)
        .from("generated_contracts")
        .select("id, nome_documento, status, created_at")
        .eq("event_id", selectedEventId)
        .order("created_at", { ascending: true });
      const allContracts = existing || [];
      setExistingContracts(allContracts.filter((c: any) => c.status !== "cancelado"));
      // Data de fechamento: preservada do primeiro contrato gerado desta festa
      setFirstContractDate(allContracts[0]?.created_at ? new Date(allContracts[0].created_at).toLocaleDateString("pt-BR") : null);

      if (!ev?.lead_id) { setLoading(false); return; }

      const [leadRes, contractDataRes, clientDataReqRes, leadContractsRes] = await Promise.all([
        supabase.from("campaign_leads").select("id, name, whatsapp, month, guests, unit").eq("id", ev.lead_id).single(),
        (supabase as any).from("lead_contract_data").select("*").eq("lead_id", ev.lead_id).maybeSingle(),
        supabase.from("client_data_requests").select("client_data").eq("event_id", selectedEventId).eq("status", "completed").order("created_at", { ascending: false }).limit(1),
        (supabase as any).from("generated_contracts").select("event_id").eq("lead_id", ev.lead_id).neq("status", "cancelado"),
      ]);
      setLeadData(leadRes.data);
      const reqData = (clientDataReqRes.data as any)?.[0]?.client_data as Record<string, any> | null;
      setClientReqData(reqData);
      // Cliente que voltou: os dados salvos são do contrato da festa anterior.
      // Reaproveita só os dados pessoais; valores, brindes e aniversariante vêm da festa nova.
      const fromOtherParty = ((leadContractsRes.data || []) as Array<{ event_id: string | null }>).some((c) => c.event_id && c.event_id !== selectedEventId);
      if (contractDataRes.data) {
        const cd = fromOtherParty
          ? { ...contractDataRes.data, nome_aniversariante: null, idade_aniversariante: null, valor_sinal: null, valor_restante: null, forma_pagamento: null, brindes: null }
          : contractDataRes.data;
        setContractData({
          nome: reqData?.nome || "",
          cpf: cd.cpf || "", rg: cd.rg || "", email: cd.email || "",
          endereco: cd.endereco || "", numero: cd.numero || "", complemento: cd.complemento || "",
          bairro: cd.bairro || "", cidade: cd.cidade || "", cep: cd.cep || "",
          nome_aniversariante: cd.nome_aniversariante || "", idade_aniversariante: cd.idade_aniversariante || "",
          data_nascimento: cd.data_nascimento ? (() => { const v = cd.data_nascimento; if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d2] = v.split("-"); return `${d2}/${m}/${y}`; } return v; })() : "", nomes_pais: cd.nomes_pais || "",
          valor_sinal: cd.valor_sinal?.toString() || "", valor_restante: cd.valor_restante?.toString() || "",
          forma_pagamento: cd.forma_pagamento || "", brindes: cd.brindes || "",
        });
      } else if (reqData?.nome) {
        setContractData(prev => ({ ...prev, nome: reqData.nome }));
      }
      setLoading(false);
    })();
  }, [selectedEventId]);

  const selectedModel = models.find(m => m.id === selectedModelId);

  // Build context
  const variableContext: VariableContext = useMemo(() => ({
    lead: leadData ? {
      name: leadData.name, whatsapp: leadData.whatsapp, guests: leadData.guests, unit: leadData.unit, month: leadData.month,
    } : undefined,
    company: { name: currentCompany?.name },
    event: eventData ? {
      date: eventData.event_date ? format(new Date(eventData.event_date + "T12:00:00"), "dd/MM/yyyy") : "",
      time: (eventData.start_time || "").substring(0, 5), end_time: (eventData.end_time || "").substring(0, 5),
      package_name: eventData.package_name || "", value: eventData.total_value,
      guest_count: eventData.guest_count, unit: eventData.unit || "", event_type: eventData.event_type || "",
    } : undefined,
    contract: {
      responsible_name: contractData.nome || leadData?.name || "",
      cpf: contractData.cpf, rg: contractData.rg, email: contractData.email,
      address: contractData.endereco, numero: contractData.numero, complemento: contractData.complemento,
      bairro: contractData.bairro, cidade: contractData.cidade, cep: contractData.cep,
      nome_aniversariante: (() => {
        const clientChildren = Array.isArray(clientReqData?.birthday_children) ? clientReqData.birthday_children.filter((c: any) => c.name) : [];
        if (clientChildren.length > 0) return clientChildren[0].name;
        return contractData.nome_aniversariante || eventData?.child_name || "";
      })(),
      idade_aniversariante: (() => {
        const clientChildren = Array.isArray(clientReqData?.birthday_children) ? clientReqData.birthday_children.filter((c: any) => c.name) : [];
        if (clientChildren.length > 0 && clientChildren[0].age) return clientChildren[0].age;
        return contractData.idade_aniversariante || eventData?.child_age || "";
      })(),
      data_nascimento: contractData.data_nascimento || "",
      data_nascimento_aniversariante: (() => {
        const clientChildren = Array.isArray(clientReqData?.birthday_children) ? clientReqData.birthday_children.filter((c: any) => c.name) : [];
        if (clientChildren.length > 0 && clientChildren[0].birthdate && /^\d{4}-\d{2}-\d{2}$/.test(clientChildren[0].birthdate)) {
          const [y, m, d] = clientChildren[0].birthdate.split("-");
          return `${d}/${m}/${y}`;
        }
        return eventData?.child_birthdate ? (() => { const [y, m, d] = eventData.child_birthdate.split("-"); return `${d}/${m}/${y}`; })() : "";
      })(),
      aniversariantes: (() => {
        const clientChildren = Array.isArray(clientReqData?.birthday_children) ? clientReqData.birthday_children.filter((c: any) => c.name) : [];
        const eventChildren = Array.isArray(eventData?.birthday_children) ? eventData.birthday_children.filter((c: any) => c.name) : [];
        const children = clientChildren.length > 0 ? clientChildren : eventChildren;
        if (children.length > 0) {
          return children.map((c: any) => {
            const parts = [c.name];
            if (c.age) parts.push(c.age);
            if (c.birthdate && /^\d{4}-\d{2}-\d{2}$/.test(c.birthdate)) {
              const [y, m, d] = c.birthdate.split("-");
              parts.push(`nasc. ${d}/${m}/${y}`);
            }
            return parts.join(", ");
          }).join("; ");
        }
        const fallbackName = contractData.nome_aniversariante || eventData?.child_name;
        if (!fallbackName) return "";
        const fp = [fallbackName];
        if (contractData.idade_aniversariante || eventData?.child_age) fp.push(contractData.idade_aniversariante || eventData.child_age);
        return fp.join(", ");
      })(),
      nomes_pais: (() => {
        const responsaveis = Array.isArray(clientReqData?.responsaveis) ? clientReqData.responsaveis.filter((r: any) => r.name) : [];
        if (responsaveis.length > 0) return responsaveis.map((r: any) => `${r.name}${r.relation ? ` (${r.relation})` : ""}`).join(" e ");
        if (contractData.nomes_pais) return contractData.nomes_pais;
        try {
          const parsed = JSON.parse(eventData?.parent_names || "[]");
          if (Array.isArray(parsed)) {
            const LABELS: Record<string, string> = { pai: "Pai", mae: "Mãe", avo: "Avó", avo_m: "Avô", tio: "Tio", tia: "Tia", padrasto: "Padrasto", madrasta: "Madrasta", outros: "Outros" };
            return parsed.filter((r: any) => r.name).map((r: any) => `${r.name}${r.relation ? ` (${LABELS[r.relation] || r.relation})` : ""}`).join(" e ");
          }
        } catch { /* plain text fallback */ }
        return eventData?.parent_names || "";
      })(),
      telefone_pais: (() => {
        const responsaveis = Array.isArray(clientReqData?.responsaveis) ? clientReqData.responsaveis.filter((r: any) => r.phone) : [];
        if (responsaveis.length > 0) return responsaveis.map((r: any) => r.phone).join(" / ");
        if (contractData.telefone_pais) return contractData.telefone_pais;
        try {
          const parsed = JSON.parse(eventData?.parent_names || "[]");
          if (Array.isArray(parsed)) return parsed.filter((r: any) => r.phone).map((r: any) => r.phone).join(" / ");
        } catch { /* ignore */ }
        return "";
      })(),
      value: eventData?.total_value ? `R$ ${Number(eventData.total_value).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "",
      valor_sinal: contractData.valor_sinal ? `R$ ${Number(contractData.valor_sinal).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "",
      valor_restante: contractData.valor_restante ? `R$ ${Number(contractData.valor_restante).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "",
      forma_pagamento: contractData.forma_pagamento,
      data_entrada: eventData?.payment_details?.entrada_data || "",
      data_saldo: eventData?.payment_details?.saldo_data || "",
      brindes: contractData.brindes || eventData?.gifts || "",
      valor_convidado_adicional: eventData?.extra_guest_value ? `R$ ${Number(eventData.extra_guest_value).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "",
      opcionais: (() => {
        const opts = Array.isArray(eventData?.event_optionals) ? eventData.event_optionals.filter((o: any) => o.name) : [];
        if (opts.length === 0) return "Nenhum opcional contratado";
        return opts.map((o: any) => {
          const val = o.value != null && o.value > 0 ? ` — R$ ${Number(o.value).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "";
          const qty = o.quantity != null && o.quantity > 1 ? ` (${o.quantity}x)` : "";
          return `• ${o.name}${qty}${val}`;
        }).join("\n");
      })(),
      date: firstContractDate || new Date().toLocaleDateString("pt-BR"),
    },
  }), [leadData, eventData, contractData, currentCompany?.name, clientReqData, firstContractDate]);

  const renderedContent = useMemo(() => {
    if (!selectedModel) return "";
    const resolved = resolveSystemVariables(selectedModel.conteudo_template, variableContext);
    return appendExtensoToValues(resolved);
  }, [selectedModel, variableContext]);

  // Detect unresolved variables in rendered content
  const unresolvedVars = useMemo(() => {
    if (!selectedModel) return [];
    return findUnresolvedVariables(selectedModel.conteudo_template, variableContext);
  }, [selectedModel, variableContext]);

  // Required fields validation
  const missingRequired = useMemo(() => {
    const missing: string[] = [];
    if (!leadData?.name) missing.push("Nome do contratante");
    if (!contractData.cpf) missing.push("CPF");
    else if (!isValidCPF(contractData.cpf)) missing.push("CPF válido");
    if (!leadData?.whatsapp) missing.push("Telefone");
    if (!eventData?.event_date) missing.push("Data do evento");
    if (!eventData?.start_time) missing.push("Horário do evento");
    if (!eventData?.guest_count) missing.push("Quantidade de convidados");
    if (!eventData?.package_name) missing.push("Pacote");
    if (!eventData?.total_value) missing.push("Valor total");
    return missing;
  }, [leadData, contractData, eventData]);

  const canGenerate = missingRequired.length === 0 && unresolvedVars.length === 0;

  const handleGenerate = async () => {
    if (!currentCompany?.id || !selectedModel || !canGenerate) return;
    setSaving(true);

    // Save/update lead_contract_data
    if (leadData?.id) {
      const payload = {
        lead_id: leadData.id, company_id: currentCompany.id,
        cpf: contractData.cpf || null, rg: contractData.rg || null, email: contractData.email || null,
        endereco: contractData.endereco || null, numero: contractData.numero || null,
        complemento: contractData.complemento || null, bairro: contractData.bairro || null,
        cidade: contractData.cidade || null, cep: contractData.cep || null,
        nome_aniversariante: contractData.nome_aniversariante || null,
        idade_aniversariante: contractData.idade_aniversariante || null,
        data_nascimento: contractData.data_nascimento || null,
        nomes_pais: contractData.nomes_pais || null,
        valor_sinal: contractData.valor_sinal ? Number(contractData.valor_sinal) : null,
        valor_restante: contractData.valor_restante ? Number(contractData.valor_restante) : null,
        forma_pagamento: contractData.forma_pagamento || null,
        brindes: contractData.brindes || null,
      };
      await (supabase as any).from("lead_contract_data").upsert(payload, { onConflict: "lead_id" });
    }

    // Save version snapshot
    const { data: versionData } = await (supabase as any).from("contract_model_versions").insert({
      model_id: selectedModel.id, company_id: currentCompany.id,
      versao: selectedModel.versao, conteudo_template: selectedModel.conteudo_template,
      tipo_evento: selectedModel.tipo_evento, nome_modelo: selectedModel.nome_modelo,
      changed_by: userId,
    }).select("id").single();

    // Create frozen contract
    const { data: contractResult, error } = await (supabase as any).from("generated_contracts").insert({
      company_id: currentCompany.id,
      lead_id: leadData?.id || null,
      event_id: selectedEventId || null,
      template_id: selectedModel.id,
      template_version_id: versionData?.id || null,
      nome_documento: `Contrato — ${leadData?.name || "Lead"} — ${eventData?.event_date ? format(new Date(eventData.event_date + "T12:00:00"), "dd/MM/yyyy") : ""}`,
      tipo_evento: selectedModel.tipo_evento,
      conteudo_renderizado: renderedContent,
      dados_utilizados: { lead: leadData, event: eventData, contract: contractData, company: { name: currentCompany.name } },
      status: "gerado",
      created_by: userId,
    }).select("id").single();

    if (error) {
      toast({ title: "Erro ao gerar contrato", description: error.message, variant: "destructive" });
      // Log failure
      await logContractAction(currentCompany.id, null, selectedModel.id, "generation_failed", userId, { error: error.message });
    } else {
      toast({ title: "Contrato gerado com sucesso! ✅" });
      // Envio automático ligado: manda o PDF pelo WhatsApp (o cardápio sai depois, pelo servidor)
      if (contractResult?.id) {
        autoSendContractOnGenerate(currentCompany.id, {
          id: contractResult.id, lead_id: leadData?.id || null, event_id: selectedEventId || null, content: renderedContent,
          name: `Contrato — ${leadData?.name || "Lead"} — ${eventData?.event_date ? format(new Date(eventData.event_date + "T12:00:00"), "dd/MM/yyyy") : ""}`,
          template_id: selectedModel.id,
        }, userId).then((r) => {
          if (r.sent) toast({ title: "Contrato enviado ao cliente pelo WhatsApp ✅" });
          else if (r.error) toast({ title: "Contrato gerado, mas não foi enviado pelo WhatsApp", description: r.error, variant: "destructive" });
        });
      }
      // Log success
      await logContractAction(currentCompany.id, contractResult?.id, selectedModel.id, "contract_generated", userId, {
        event_id: selectedEventId,
        lead_name: leadData?.name,
        template_version: selectedModel.versao,
      });
    }
    setSaving(false);
    onClose();
  };

  const updateField = (key: string, val: string) => setContractData(prev => ({ ...prev, [key]: val }));

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border/40 bg-gradient-to-r from-primary/5 to-transparent">
        <h2 className="text-lg font-bold">Gerar Contrato</h2>
        <div className="flex items-center gap-2 mt-2">
          {[1, 2, 3].map(s => (
            <div key={s} className="flex items-center gap-1">
              <div className={`h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold ${step >= s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                {step > s ? <Check className="h-3.5 w-3.5" /> : s}
              </div>
              {s < 3 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
            </div>
          ))}
          <span className="text-xs text-muted-foreground ml-2">
            {step === 1 ? "Selecionar modelo e evento" : step === 2 ? "Preencher dados" : "Revisar e gerar"}
          </span>
        </div>
      </div>

      <div className="p-6">
        {/* Step 1: Select model + event */}
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <Label className="text-xs font-semibold">Modelo de Contrato</Label>
              <Select value={selectedModelId} onValueChange={setSelectedModelId}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione um modelo..." /></SelectTrigger>
                <SelectContent>
                  {models.map(m => <SelectItem key={m.id} value={m.id}>{m.nome_modelo} ({m.tipo_evento})</SelectItem>)}
                </SelectContent>
              </Select>
              {models.length === 0 && <p className="text-xs text-destructive mt-1">Nenhum modelo ativo. Crie um modelo na aba "Modelos".</p>}
            </div>
            <div>
              <Label className="text-xs font-semibold">Evento / Festa</Label>
              <Select value={selectedEventId} onValueChange={setSelectedEventId}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione um evento..." /></SelectTrigger>
                <SelectContent>
                  {events.map(e => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.title} — {e.event_date ? format(new Date(e.event_date + "T12:00:00"), "dd/MM/yyyy") : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Existing contract warning */}
            {existingContracts.length > 0 && (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-300/30">
                <div className="flex items-center gap-2 text-amber-700 mb-1">
                  <AlertCircle className="h-4 w-4" />
                  <span className="text-sm font-semibold">Este evento já possui {existingContracts.length} contrato(s)</span>
                </div>
                <p className="text-xs text-amber-600">
                  Ao gerar um novo contrato, os anteriores serão mantidos no histórico. O novo contrato será tratado como uma nova versão.
                </p>
              </div>
            )}

            <div className="flex justify-end pt-4">
              <Button disabled={!selectedModelId || !selectedEventId} onClick={() => setStep(2)}>
                {existingContracts.length > 0 ? "Gerar Nova Versão" : "Próximo"} <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: Fill contract data */}
        {step === 2 && (
          <div className="space-y-5">
            {loading ? (
              <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
            ) : (
              <>
                <SectionHeader label="Dados do Contratante" />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <FieldInput label="Nome" value={leadData?.name || ""} disabled />
                  <FieldInput label="Telefone" value={leadData?.whatsapp || ""} disabled />
                  <div>
                    <Label className="text-xs text-muted-foreground">CPF *</Label>
                    <Input
                      value={contractData.cpf || ""}
                      onChange={e => {
                        const formatted = formatCPF(e.target.value);
                        updateField("cpf", formatted);
                        setCpfError(null);
                      }}
                      onBlur={() => {
                        const d = (contractData.cpf || "").replace(/\D/g, "");
                        if (d.length === 11 && !isValidCPF(contractData.cpf)) {
                          setCpfError("CPF inválido");
                        } else if (d.length > 0 && d.length < 11) {
                          setCpfError("CPF incompleto");
                        } else {
                          setCpfError(null);
                        }
                      }}
                      placeholder="000.000.000-00"
                      maxLength={14}
                      className={`mt-0.5 h-9 text-sm ${cpfError ? "border-destructive ring-1 ring-destructive/30" : ""}`}
                    />
                    {cpfError && <p className="text-[11px] text-destructive font-medium mt-1">{cpfError}</p>}
                  </div>
                  <FieldInput label="RG" value={contractData.rg} onChange={v => updateField("rg", v)} />
                  <FieldInput label="E-mail" value={contractData.email} onChange={v => updateField("email", v)} />
                  <FieldInput label="CEP" value={contractData.cep} onChange={v => updateField("cep", v)} />
                  <FieldInput label="Endereço" value={contractData.endereco} onChange={v => updateField("endereco", v)} />
                  <FieldInput label="Número" value={contractData.numero} onChange={v => updateField("numero", v)} />
                  <FieldInput label="Complemento" value={contractData.complemento} onChange={v => updateField("complemento", v)} />
                  <FieldInput label="Bairro" value={contractData.bairro} onChange={v => updateField("bairro", v)} />
                  <FieldInput label="Cidade" value={contractData.cidade} onChange={v => updateField("cidade", v)} />
                </div>

                <SectionHeader label="Aniversariante / Homenageado" />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <FieldInput label="Nome do aniversariante" value={contractData.nome_aniversariante} onChange={v => updateField("nome_aniversariante", v)} />
                  <FieldInput label="Idade" value={contractData.idade_aniversariante} onChange={v => updateField("idade_aniversariante", v)} />
                  <FieldInput label="Data de nascimento" value={contractData.data_nascimento} onChange={v => updateField("data_nascimento", v)} />
                  <FieldInput label="Nomes dos pais" value={contractData.nomes_pais} onChange={v => updateField("nomes_pais", v)} />
                </div>

                <SectionHeader label="Financeiro" />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <FieldInput label="Valor total *" value={eventData?.total_value?.toString() || ""} disabled />
                  <FieldInput label="Valor do sinal" value={contractData.valor_sinal} onChange={v => updateField("valor_sinal", v)} />
                  <FieldInput label="Valor restante" value={contractData.valor_restante} onChange={v => updateField("valor_restante", v)} />
                  <FieldInput label="Forma de pagamento" value={contractData.forma_pagamento} onChange={v => updateField("forma_pagamento", v)} />
                  <FieldInput label="Brindes / Opcionais" value={contractData.brindes} onChange={v => updateField("brindes", v)} />
                </div>

                <div className="flex justify-between pt-4 border-t border-border/40">
                  <Button variant="outline" onClick={() => setStep(1)}>Voltar</Button>
                  <Button onClick={() => setStep(3)}>Revisar <ChevronRight className="h-4 w-4 ml-1" /></Button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Step 3: Preview + Generate */}
        {step === 3 && (
          <div className="space-y-4">
            {/* Required fields alert */}
            {missingRequired.length > 0 && (
              <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/30">
                <div className="flex items-center gap-2 text-destructive mb-1">
                  <ShieldAlert className="h-4 w-4" />
                  <span className="text-sm font-semibold">Dados obrigatórios faltando</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {missingRequired.map(f => <Badge key={f} variant="outline" className="text-xs border-destructive/40 text-destructive">{f}</Badge>)}
                </div>
                <p className="text-xs text-destructive/70 mt-2">Volte ao passo anterior e preencha os campos obrigatórios para gerar o contrato.</p>
              </div>
            )}

            {/* Unresolved variables alert */}
            {unresolvedVars.length > 0 && (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-300/30">
                <div className="flex items-center gap-2 text-amber-700 mb-1">
                  <AlertTriangle className="h-4 w-4" />
                  <span className="text-sm font-semibold">Variáveis não resolvidas no contrato</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {unresolvedVars.map(v => (
                    <Badge key={v} variant="outline" className="text-xs border-amber-400 text-amber-700 font-mono">{`{{${v}}}`}</Badge>
                  ))}
                </div>
                <p className="text-xs text-amber-600 mt-2">O contrato será gerado com placeholders visíveis. Preencha os dados ou corrija o modelo.</p>
              </div>
            )}

            <ContractPreviewPrint
              content={renderedContent}
              companyName={currentCompany?.name || ""}
              companyLogo={getCompanyLogoOverride(currentCompany?.slug, currentCompany?.logo_url) || undefined}
              packageName={eventData?.package_name || ""}
            />

            <div className="flex justify-between pt-4 border-t border-border/40">
              <Button variant="outline" onClick={() => setStep(2)}>Voltar</Button>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => setFullPreviewOpen(true)} className="gap-2">
                  <Eye className="h-4 w-4" /> Visualizar
                </Button>
                <Button onClick={handleGenerate} disabled={saving || missingRequired.length > 0} className="gap-2">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  {existingContracts.length > 0 ? "Gerar Nova Versão" : "Gerar Contrato"}
                </Button>
              </div>
            </div>

            <ContractDocumentViewer
              open={fullPreviewOpen}
              onOpenChange={setFullPreviewOpen}
              content={renderedContent}
              companyName={currentCompany?.name || ""}
              companyLogo={getCompanyLogoOverride(currentCompany?.slug, currentCompany?.logo_url) || undefined}
              mode="preview"
              unresolvedVars={unresolvedVars}
              missingRequired={missingRequired}
              onGenerate={handleGenerate}
              generating={saving}
              canGenerate={canGenerate}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <p className="text-[11px] uppercase tracking-[0.18em] font-semibold text-muted-foreground pb-2 border-b border-border/40">{label}</p>
  );
}

function FieldInput({ label, value, onChange, disabled }: { label: string; value: string; onChange?: (v: string) => void; disabled?: boolean }) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input value={value || ""} onChange={e => onChange?.(e.target.value)} disabled={disabled} className="mt-0.5 h-9 text-sm" />
    </div>
  );
}
