/**
 * EventContractDialog — Full-screen preview + generation flow.
 * Opens directly as a ContractDocumentViewer in "preview" mode.
 * On confirm, freezes contract as immutable snapshot.
 */
import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCompany } from "@/contexts/CompanyContext";
import { getCompanyLogoOverride } from "@/lib/companyAssetOverrides";
import { toast } from "@/hooks/use-toast";
import { resolveSystemVariables, findUnresolvedVariables, appendExtensoToValues, type VariableContext } from "@/lib/template-resolver";
import { ContractDocumentViewer } from "./ContractDocumentViewer";
import { logContractAction, autoSendContractOnGenerate } from "./contractAuditHelpers";
import { format } from "date-fns";

interface EventContractDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId: string;
  modelId: string;
  userId: string;
}

export function EventContractDialog({ open, onOpenChange, eventId, modelId, userId }: EventContractDialogProps) {
  const { currentCompany } = useCompany();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [model, setModel] = useState<any>(null);
  const [eventData, setEventData] = useState<any>(null);
  const [leadData, setLeadData] = useState<any>(null);
  const [clientData, setClientData] = useState<Record<string, string>>({});
  const [paymentDetails, setPaymentDetails] = useState<any>(null);
  const [firstContractDate, setFirstContractDate] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !currentCompany?.id) return;
    setLoading(true);

    const fetchAll = async () => {
      const [modelRes, eventRes] = await Promise.all([
        (supabase as any).from("contract_models").select("*").eq("id", modelId).single(),
        supabase.from("company_events").select("*").eq("id", eventId).single(),
      ]);

      const modelData = modelRes.data;
      const evData = eventRes.data;
      setModel(modelData);
      setEventData(evData);
      setPaymentDetails(evData?.payment_details);

      const [leadRes, clientReqRes, firstContractRes] = await Promise.all([
        evData?.lead_id
          ? supabase.from("campaign_leads").select("id, name, whatsapp, month, guests, unit").eq("id", evData.lead_id).single()
          : Promise.resolve({ data: null }),
        supabase
          .from("client_data_requests")
          .select("client_data")
          .eq("event_id", eventId)
          .eq("status", "completed")
          .order("created_at", { ascending: false })
          .limit(1),
        (supabase as any)
          .from("generated_contracts")
          .select("created_at")
          .eq("event_id", eventId)
          .order("created_at", { ascending: true })
          .limit(1),
      ]);

      setLeadData(leadRes.data);
      const firstCreatedAt = firstContractRes.data?.[0]?.created_at;
      setFirstContractDate(firstCreatedAt ? new Date(firstCreatedAt).toLocaleDateString("pt-BR") : null);
      const cd = clientReqRes.data?.[0]?.client_data as Record<string, any> | null;
      setClientData(cd || {});
      setLoading(false);
    };

    fetchAll();
  }, [open, eventId, modelId, currentCompany?.id]);

  const variableContext: VariableContext = useMemo(() => {
    const pd = paymentDetails as any;
    const fmtDate = (d: string | undefined) => {
      if (!d) return "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { const [y, m, day] = d.split("-"); return `${day}/${m}/${y}`; }
      return d;
    };
    // Prefer payment_blocks (new model) when present; fallback to entrada/saldo (legacy)
    const blocks: any[] = Array.isArray((eventData as any)?.payment_blocks)
      ? (eventData as any).payment_blocks
      : Array.isArray(pd?.payment_blocks) ? pd.payment_blocks : [];
    const validBlocks = blocks.filter((b) => Number(b?.valor) > 0);

    const paymentDesc = validBlocks.length > 0
      ? validBlocks.map((b, i) => {
          const valor = `R$ ${Number(b.valor).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;
          const forma = b.forma ? ` (${b.forma})` : "";
          const parc = Number(b.parcelas) > 1 ? ` ${b.parcelas}x` : "";
          return `Bloco ${i + 1}: ${valor}${forma}${parc}`;
        }).join(" | ")
      : pd
        ? [
            pd.entrada_valor ? `Entrada: R$ ${Number(pd.entrada_valor).toLocaleString("pt-BR")}${pd.entrada_forma ? ` (${pd.entrada_forma})` : ""}${pd.entrada_data ? ` em ${fmtDate(pd.entrada_data)}` : ""}` : "",
            pd.saldo_valor ? `Saldo: R$ ${Number(pd.saldo_valor).toLocaleString("pt-BR")}${pd.saldo_forma ? ` (${pd.saldo_forma})` : ""}${pd.saldo_data ? ` em ${fmtDate(pd.saldo_data)}` : ""}` : "",
            pd.parcelas ? `${pd.parcelas}x` : "",
            pd.observacoes_pagamento || "",
          ].filter(Boolean).join(" | ")
        : "";


    return {
      lead: leadData ? {
        name: leadData.name, whatsapp: leadData.whatsapp, guests: leadData.guests,
        unit: leadData.unit, month: leadData.month,
      } : undefined,
      company: { name: currentCompany?.name },
      event: eventData ? {
        date: eventData.event_date ? format(new Date(eventData.event_date + "T12:00:00"), "dd/MM/yyyy") : "",
        time: (eventData.start_time || "").substring(0, 5), end_time: (eventData.end_time || "").substring(0, 5),
        package_name: eventData.package_name || "", value: eventData.total_value,
        guest_count: eventData.guest_count, unit: eventData.unit || "",
        event_type: eventData.event_type || "",
      } : undefined,
      contract: {
        responsible_name: clientData.nome || leadData?.name || "",
        cpf: clientData.cpf || "", rg: clientData.rg || "", email: clientData.email || "",
        address: clientData.endereco || "", numero: clientData.numero || "",
        complemento: clientData.complemento || "", bairro: clientData.bairro || "",
        cidade: clientData.cidade || "", cep: clientData.cep || "",
        nome_aniversariante: (() => {
          const children = Array.isArray(clientData.birthday_children) ? clientData.birthday_children.filter((c: any) => c.name) : [];
          if (children.length > 0) return children[0].name;
          return clientData.nome_aniversariante || eventData?.child_name || "";
        })(),
        idade_aniversariante: (() => {
          const children = Array.isArray(clientData.birthday_children) ? clientData.birthday_children.filter((c: any) => c.name) : [];
          if (children.length > 0 && children[0].age) return children[0].age;
          return clientData.idade_aniversariante || eventData?.child_age || "";
        })(),
        data_nascimento: clientData.nascimento ? (() => { const parts = clientData.nascimento.split("-"); return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : clientData.nascimento; })() : "",
        data_nascimento_aniversariante: (() => {
          const children = Array.isArray(clientData.birthday_children) ? clientData.birthday_children.filter((c: any) => c.name) : [];
          if (children.length > 0 && children[0].birthdate && /^\d{4}-\d{2}-\d{2}$/.test(children[0].birthdate)) {
            const [y, m, d] = children[0].birthdate.split("-");
            return `${d}/${m}/${y}`;
          }
          return eventData?.child_birthdate ? (() => { const [y, m, d] = eventData.child_birthdate.split("-"); return `${d}/${m}/${y}`; })() : "";
        })(),
        aniversariantes: (() => {
          // Priority: birthday_children from client_data, then from event, then legacy fields
          const clientChildren = Array.isArray(clientData.birthday_children) ? clientData.birthday_children.filter((c: any) => c.name) : [];
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
          const fallbackName = clientData.nome_aniversariante || eventData?.child_name;
          if (!fallbackName) return "";
          const fp = [fallbackName];
          if (clientData.idade_aniversariante || eventData?.child_age) fp.push(clientData.idade_aniversariante || eventData.child_age);
          return fp.join(", ");
        })(),
        nomes_pais: (() => {
          // Priority: responsaveis from client_data
          const responsaveis = Array.isArray(clientData.responsaveis) ? clientData.responsaveis.filter((r: any) => r.name) : [];
          if (responsaveis.length > 0) {
            return responsaveis.map((r: any) => `${r.name}${r.relation ? ` (${r.relation})` : ""}`).join(" e ");
          }
          if (clientData.nomes_pais) return clientData.nomes_pais;
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
          const responsaveis = Array.isArray(clientData.responsaveis) ? clientData.responsaveis.filter((r: any) => r.phone) : [];
          if (responsaveis.length > 0) return responsaveis.map((r: any) => r.phone).join(" / ");
          try {
            const parsed = JSON.parse(eventData?.parent_names || "[]");
            if (Array.isArray(parsed)) return parsed.filter((r: any) => r.phone).map((r: any) => r.phone).join(" / ");
          } catch { /* ignore */ }
          return "";
        })(),
        brindes: eventData?.gifts || "",
        tema: clientData.tema || "",
        valor_convidado_adicional: eventData?.extra_guest_value ? `R$ ${Number(eventData.extra_guest_value).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "",
        valor_adicional_antecipado: eventData?.extra_guest_value_antecipado ? `R$ ${Number(eventData.extra_guest_value_antecipado).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "",
        valor_adicional_no_dia: eventData?.extra_guest_value_no_dia ? `R$ ${Number(eventData.extra_guest_value_no_dia).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "",
        quantidade_pessoas: eventData?.guest_count?.toString() || leadData?.guests || "",
        opcionais: (() => {
          const opts = Array.isArray(eventData?.event_optionals) ? eventData.event_optionals.filter((o: any) => o.name) : [];
          if (opts.length === 0) return "Nenhum opcional contratado";
          return opts.map((o: any) => {
            const val = o.value != null && o.value > 0 ? ` — R$ ${Number(o.value).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "";
            return `• ${o.name}${val}`;
          }).join("\n");
        })(),
        estado: clientData.estado || "",
        duracao_festa: (() => {
          const numWords = ["zero","uma","duas","três","quatro","cinco","seis","sete","oito","nove","dez","onze","doze"];
          const minWords = (n: number) => { const w = ["","um","dois","três","quatro","cinco","seis","sete","oito","nove","dez",
            "onze","doze","treze","quatorze","quinze","dezesseis","dezessete","dezoito","dezenove","vinte",
            "vinte e um","vinte e dois","vinte e três","vinte e quatro","vinte e cinco","vinte e seis","vinte e sete","vinte e oito","vinte e nove","trinta",
            "trinta e um","trinta e dois","trinta e três","trinta e quatro","trinta e cinco","trinta e seis","trinta e sete","trinta e oito","trinta e nove","quarenta",
            "quarenta e um","quarenta e dois","quarenta e três","quarenta e quatro","quarenta e cinco","quarenta e seis","quarenta e sete","quarenta e oito","quarenta e nove","cinquenta",
            "cinquenta e um","cinquenta e dois","cinquenta e três","cinquenta e quatro","cinquenta e cinco","cinquenta e seis","cinquenta e sete","cinquenta e oito","cinquenta e nove"]; return w[n] || String(n); };
          if (eventData?.start_time && eventData?.end_time) {
            const [sh, sm] = eventData.start_time.split(":").map(Number);
            const [eh, em] = eventData.end_time.split(":").map(Number);
            const diffMin = (eh * 60 + em) - (sh * 60 + sm);
            if (diffMin > 0) {
              const hours = Math.floor(diffMin / 60);
              const mins = diffMin % 60;
              const timePart = mins > 0 ? `${hours}:${String(mins).padStart(2, "0")}h` : `${hours}:00h`;
              const hWord = numWords[hours] || String(hours);
              const hLabel = hours === 1 ? "hora" : "horas";
              const mExt = mins > 0 ? ` e ${minWords(mins)} minutos` : "";
              return `${timePart} (${hWord} ${hLabel}${mExt})`;
            }
          }
          return "";
        })(),
        cardapio: clientData.cardapio || eventData?.package_name || "",
        valor_total_extenso: clientData.valor_total_extenso || "",
        value: eventData?.total_value ? `R$ ${Number(eventData.total_value).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "",
        valor_sinal: pd?.entrada_valor ? `R$ ${Number(pd.entrada_valor).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "",
        valor_restante: pd?.saldo_valor ? `R$ ${Number(pd.saldo_valor).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "",
        forma_pagamento: paymentDesc || eventData?.payment_method || "",
        data_entrada: pd?.entrada_data || "",
        data_saldo: pd?.saldo_data || "",
        qtd_adultos: pd?.adult_count?.toString() || "",
        qtd_criancas: pd?.child_count?.toString() || "",
        valor_por_adulto: pd?.price_per_adult ? `R$ ${Number(pd.price_per_adult).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "",
        valor_por_crianca: pd?.price_per_child ? `R$ ${Number(pd.price_per_child).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "",
        observacoes_evento: eventData?.notes || "",
        // Data de fechamento: preservada do primeiro contrato gerado desta festa
        date: firstContractDate || new Date().toLocaleDateString("pt-BR"),
      },
    };
  }, [leadData, eventData, clientData, paymentDetails, currentCompany?.name, firstContractDate]);

  const renderedContent = useMemo(() => {
    if (!model) return "";
    const resolved = resolveSystemVariables(model.conteudo_template, variableContext);
    return appendExtensoToValues(resolved);
  }, [model, variableContext]);

  const unresolvedVars = useMemo(() => {
    if (!model) return [];
    return findUnresolvedVariables(model.conteudo_template, variableContext);
  }, [model, variableContext]);

  // Determine required fields that are missing for blocking generation
  const missingRequired = useMemo(() => {
    const missing: string[] = [];
    if (!clientData.nome && !leadData?.name) missing.push("Nome do contratante");
    if (!clientData.cpf) missing.push("CPF");
    if (!eventData?.event_date) missing.push("Data da festa");
    if (!eventData?.total_value) missing.push("Valor total");
    if (!eventData?.package_name) missing.push("Pacote");
    return missing;
  }, [clientData, leadData, eventData]);

  const canGenerate = missingRequired.length === 0;

  const handleGenerate = async () => {
    if (!currentCompany?.id || !model) return;
    setSaving(true);

    try {
      // Save version snapshot
      const { data: versionData } = await (supabase as any).from("contract_model_versions").insert({
        model_id: model.id, company_id: currentCompany.id,
        versao: model.versao, conteudo_template: model.conteudo_template,
        tipo_evento: model.tipo_evento, nome_modelo: model.nome_modelo,
        changed_by: userId,
      }).select("id").single();

      // Create frozen contract
      const docName = `Contrato — ${clientData.nome || leadData?.name || eventData?.title || "Lead"} — ${eventData?.event_date ? format(new Date(eventData.event_date + "T12:00:00"), "dd/MM/yyyy") : ""}`;

      const { data: contractResult, error } = await (supabase as any).from("generated_contracts").insert({
        company_id: currentCompany.id,
        lead_id: leadData?.id || null,
        event_id: eventId,
        template_id: model.id,
        template_version_id: versionData?.id || null,
        nome_documento: docName,
        tipo_evento: model.tipo_evento,
        conteudo_renderizado: renderedContent,
        dados_utilizados: {
          lead: leadData,
          event: eventData,
          client: clientData,
          payment: paymentDetails,
          company: { name: currentCompany.name },
        },
        status: "gerado",
        created_by: userId,
      }).select("id").single();

      if (error) throw error;

      await logContractAction(currentCompany.id, contractResult?.id, model.id, "contract_generated", userId, {
        event_id: eventId,
        lead_name: leadData?.name,
        template_version: model.versao,
        source: "event_detail",
      });

      toast({ title: "Contrato gerado com sucesso! ✅", description: "O contrato foi congelado e está disponível para visualização e impressão." });
      // Envio automático ligado: manda o PDF pelo WhatsApp (o cardápio sai depois, pelo servidor)
      if (contractResult?.id) {
        const companyId = currentCompany.id;
        autoSendContractOnGenerate(companyId, { id: contractResult.id, lead_id: leadData?.id || null, event_id: eventId, content: renderedContent, name: docName, template_id: model.id }, userId)
          .then((r) => {
            if (r.sent) toast({ title: "Contrato enviado ao cliente pelo WhatsApp ✅" });
            else if (r.error) toast({ title: "Contrato gerado, mas não foi enviado pelo WhatsApp", description: r.error, variant: "destructive" });
          });
      }
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: "Erro ao gerar contrato", description: err.message, variant: "destructive" });
      await logContractAction(currentCompany.id, null, model?.id, "generation_failed", userId, { error: err.message });
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;
  if (loading) {
    return (
      <ContractDocumentViewer
        open={open}
        onOpenChange={onOpenChange}
        content=""
        companyName={currentCompany?.name || ""}
        mode="preview"
        meta={{ modelName: "Carregando..." }}
        generating={false}
        canGenerate={false}
      />
    );
  }

  return (
    <ContractDocumentViewer
      open={open}
      onOpenChange={onOpenChange}
      content={renderedContent}
      companyName={currentCompany?.name || ""}
      companyLogo={getCompanyLogoOverride(currentCompany?.slug, currentCompany?.logo_url) || undefined}
      mode="preview"
      meta={{
        modelName: model?.nome_modelo,
        templateVersion: model?.versao,
        leadName: clientData.nome || leadData?.name,
        eventDate: eventData?.event_date ? format(new Date(eventData.event_date + "T12:00:00"), "dd/MM/yyyy") : undefined,
        eventType: eventData?.event_type,
      }}
      unresolvedVars={unresolvedVars}
      missingRequired={missingRequired}
      onGenerate={handleGenerate}
      generating={saving}
      canGenerate={canGenerate}
    />
  );
}
