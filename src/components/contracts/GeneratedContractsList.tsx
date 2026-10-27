import { useState, useEffect } from "react";
import { sendContractForSignature } from "@/lib/contractSignature";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useCompany } from "@/contexts/CompanyContext";
import { getCompanyLogoOverride } from "@/lib/companyAssetOverrides";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Plus, Loader2, FileText, Eye, Ban, History, MessageCircle, FileSignature, ShieldCheck, Copy, Download } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ContractGenerator } from "./ContractGenerator";
import { ContractDocumentViewer } from "./ContractDocumentViewer";
import { toast } from "@/hooks/use-toast";
import { logContractAction, sendContractViaWhatsApp, getContractSendTemplate, resolveContractSendMessage, renderContractHtmlToPdf } from "./contractAuditHelpers";

interface GeneratedContract {
  id: string;
  nome_documento: string;
  tipo_evento: string | null;
  status: string;
  conteudo_renderizado: string;
  dados_utilizados: any;
  created_at: string;
  lead_id: string | null;
  event_id: string | null;
  template_id: string | null;
  created_by: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  rascunho: "bg-muted text-muted-foreground",
  gerado: "bg-blue-500/15 text-blue-700 border-blue-300",
  enviado: "bg-amber-500/15 text-amber-700 border-amber-300",
  assinado: "bg-emerald-500/15 text-emerald-700 border-emerald-300",
  cancelado: "bg-red-500/15 text-red-700 border-red-300",
  aguardando_assinatura: "bg-purple-500/15 text-purple-700 border-purple-300",
};

const STATUS_LABELS: Record<string, string> = {
  rascunho: "Rascunho", gerado: "Gerado", enviado: "Enviado", assinado: "Assinado ✅", cancelado: "Cancelado",
  aguardando_assinatura: "Aguardando Assinatura",
};

interface Props { userId: string; }

export function GeneratedContractsList({ userId }: Props) {
  const { currentCompany } = useCompany();
  const [contracts, setContracts] = useState<GeneratedContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [viewContract, setViewContract] = useState<GeneratedContract | null>(null);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [showAudit, setShowAudit] = useState<string | null>(null);
  const [expandedSig, setExpandedSig] = useState<string | null>(null);
  const [sigCache, setSigCache] = useState<Record<string, any>>({});

  const fetchContracts = async () => {
    if (!currentCompany?.id) return;
    setLoading(true);
    const { data } = await (supabase as any)
      .from("generated_contracts")
      .select("*")
      .eq("company_id", currentCompany.id)
      .order("created_at", { ascending: false });
    setContracts(data || []);
    setLoading(false);
  };

  const fetchSentStatus = async () => {
    if (!currentCompany?.id) return;
    const { data: logs } = await (supabase as any)
      .from("contract_audit_logs")
      .select("contract_id, action")
      .eq("company_id", currentCompany.id)
      .in("action", ["contract_sent_whatsapp", "contract_sent_for_signature"]);
    if (logs) {
      const waIds = new Set<string>();
      const signIds = new Set<string>();
      for (const log of logs) {
        if (log.action === "contract_sent_whatsapp" && log.contract_id) waIds.add(log.contract_id);
        if (log.action === "contract_sent_for_signature" && log.contract_id) signIds.add(log.contract_id);
      }
      setSentWA(waIds);
      setSentSign(signIds);
    }
  };

  useEffect(() => { fetchContracts(); fetchSentStatus(); }, [currentCompany?.id]);

  const handleCancel = async (contract: GeneratedContract) => {
    if (!currentCompany?.id) return;
    const { error } = await (supabase as any)
      .from("generated_contracts")
      .update({ status: "cancelado" })
      .eq("id", contract.id);
    if (error) {
      toast({ title: "Erro ao cancelar", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Contrato cancelado" });
      await logContractAction(currentCompany.id, contract.id, contract.template_id, "contract_cancelled", userId);
      fetchContracts();
    }
  };

  const handleShowAudit = async (contractId: string) => {
    if (!currentCompany?.id) return;
    setShowAudit(contractId);
    const { data } = await (supabase as any)
      .from("contract_audit_logs")
      .select("*")
      .eq("contract_id", contractId)
      .order("created_at", { ascending: false });
    setAuditLogs(data || []);
  };

  const [sendingWA, setSendingWA] = useState<string | null>(null);
  const [sendingSign, setSendingSign] = useState<string | null>(null);
  const [sentWA, setSentWA] = useState<Set<string>>(new Set());
  const [sentSign, setSentSign] = useState<Set<string>>(new Set());

  const handleSendWhatsApp = async (contract: GeneratedContract) => {
    if (!currentCompany?.id) return;
    let leadId = contract.lead_id;
    if (!leadId && contract.event_id) {
      const { data: ev } = await supabase.from("company_events").select("lead_id").eq("id", contract.event_id).single();
      leadId = ev?.lead_id || null;
    }
    if (!leadId) {
      toast({ title: "Lead não vinculado", description: "Este contrato não possui um lead associado para envio.", variant: "destructive" });
      return;
    }
    setSendingWA(contract.id);
    const result = await sendContractViaWhatsApp(currentCompany.id, leadId, contract.conteudo_renderizado, contract.nome_documento);
    if (result.success) {
      if (!["aguardando_assinatura", "assinado"].includes(contract.status)) {
        await supabase.from("generated_contracts").update({ status: "enviado" }).eq("id", contract.id);
      }
      setSentWA(prev => new Set(prev).add(contract.id));
      toast({ title: "Contrato enviado via WhatsApp ✅" });
      await logContractAction(currentCompany.id, contract.id, contract.template_id, "contract_sent_whatsapp", userId, { lead_id: leadId });
    } else {
      toast({ title: "Erro ao enviar", description: result.error, variant: "destructive" });
    }
    setSendingWA(null);
  };

  const handleSendForSignature = async (contract: GeneratedContract) => {
    if (!currentCompany?.id) return;
    setSendingSign(contract.id);
    try {
      const r = await sendContractForSignature({ companyId: currentCompany.id, companyName: currentCompany.name, contract, userId });
      if (!r.ok) toast({ title: "Não consegui enviar para assinatura", description: r.error, variant: "destructive" });
      else if (r.copied) toast({ title: "Link copiado!", description: "Nenhum WhatsApp conectado agora. Cole o link na conversa com o cliente." });
      else {
        setSentSign(prev => new Set(prev).add(contract.id));
        toast({ title: `Link de assinatura enviado${r.unit ? ` via ${r.unit}` : ""} ✅` });
      }
      fetchContracts();
    } finally {
      setSendingSign(null);
    }
  };

  const handleToggleSignature = async (contractId: string) => {
    if (expandedSig === contractId) {
      setExpandedSig(null);
      return;
    }
    if (!sigCache[contractId]) {
      const { data } = await (supabase as any)
        .from("contract_signatures")
        .select("signature_image_url, signed_at, document_hash, ip_address, user_agent, signer_name, signer_phone, otp_verified_at")
        .eq("contract_id", contractId)
        .eq("status", "signed")
        .limit(1);
      if (data?.[0]) {
        setSigCache(prev => ({ ...prev, [contractId]: data[0] }));
      }
    }
    setExpandedSig(contractId);
  };
  const ACTION_LABELS: Record<string, string> = {
    contract_generated: "Contrato gerado",
    contract_cancelled: "Contrato cancelado",
    contract_downloaded: "Contrato baixado",
    generation_failed: "Falha na geração",
    contract_sent_whatsapp: "Enviado via WhatsApp",
    contract_sent_for_signature: "Enviado para assinatura",
    contract_signed: "Assinado digitalmente",
  };

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground hidden md:block">Contratos gerados a partir dos modelos</p>
          <Button onClick={() => setGeneratorOpen(true)} size="sm" className="gap-2"><Plus className="h-4 w-4" /> Gerar Contrato</Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : contracts.length === 0 ? (
          <Card><CardContent className="p-8 text-center space-y-3">
            <FileText className="h-12 w-12 text-muted-foreground mx-auto" />
            <p className="text-muted-foreground">Nenhum contrato gerado ainda.</p>
            <Button onClick={() => setGeneratorOpen(true)}><Plus className="h-4 w-4 mr-2" /> Gerar Primeiro Contrato</Button>
          </CardContent></Card>
        ) : (
          <div className="grid gap-3">
            {contracts.map(c => {
              const leadName = c.dados_utilizados?.lead?.name || "—";
              const isCancelled = c.status === "cancelado";
              return (
                <Card key={c.id} className={`border-border/40 overflow-hidden ${isCancelled ? "opacity-60" : ""}`}>
                  <CardContent className="p-4 min-w-0">
                    <div className="flex items-center justify-between gap-3 min-w-0">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap mb-1 min-w-0">
                          <h3 className="font-semibold truncate min-w-0 max-w-full text-sm sm:text-base">{c.nome_documento}</h3>
                          <Badge className={`text-xs ${STATUS_COLORS[c.status] || ""}`}>{STATUS_LABELS[c.status] || c.status}</Badge>
                        </div>
                        <p className="text-sm text-muted-foreground truncate">Contratante: {leadName}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Gerado em {format(new Date(c.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 border-t border-border/40 pt-3 mt-3 flex-wrap min-w-0">
                      <Button variant="outline" size="sm" className="h-8 text-xs rounded-full px-3.5 gap-1.5" onClick={() => setViewContract(c)}>
                        <Eye className="h-3.5 w-3.5" /> Visualizar
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs rounded-full px-3.5 gap-1.5"
                        onClick={async () => {
                          try {
                            const tmp = document.createElement("div");
                            tmp.innerHTML = c.conteudo_renderizado || "";
                            const text = tmp.innerText || tmp.textContent || "";
                            await navigator.clipboard.writeText(text);
                            toast({ title: "Contrato copiado! 📋" });
                          } catch (e: any) {
                            toast({ title: "Erro ao copiar", description: e?.message, variant: "destructive" });
                          }
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" /> Copiar
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs rounded-full px-3.5 gap-1.5"
                        onClick={async () => {
                          toast({ title: "Gerando PDF..." });
                          try {
                            const blob = await renderContractHtmlToPdf(c.conteudo_renderizado || "", c.nome_documento, currentCompany?.id);
                            if (!blob) throw new Error("Falha ao gerar PDF");
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `${c.nome_documento.replace(/[^a-zA-Z0-9]+/g, "_")}.pdf`;
                            a.click();
                            URL.revokeObjectURL(url);
                            if (currentCompany?.id) {
                              await logContractAction(currentCompany.id, c.id, c.template_id, "contract_downloaded", userId);
                            }
                            toast({ title: "Contrato baixado ✅" });
                          } catch (e: any) {
                            toast({ title: "Erro ao baixar", description: e?.message, variant: "destructive" });
                          }
                        }}
                      >
                        <Download className="h-3.5 w-3.5" /> Baixar
                      </Button>
                      {!isCancelled && (
                        <Button
                          variant="outline"
                          size="sm"
                          className={cn("h-8 text-xs rounded-full px-3.5 gap-1.5", (sentWA.has(c.id) || c.status === "enviado") ? "bg-emerald-500/15 text-emerald-700 border-emerald-300 hover:bg-emerald-100" : "text-emerald-700 border-emerald-300 hover:bg-emerald-50")}
                          onClick={() => handleSendWhatsApp(c)}
                          disabled={sendingWA === c.id}
                        >
                          {sendingWA === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageCircle className="h-3.5 w-3.5" />}
                          {sentWA.has(c.id) || c.status === "enviado" ? "WhatsApp ✅" : "WhatsApp"}
                        </Button>
                      )}
                      {!isCancelled && c.status !== "assinado" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className={cn("h-8 text-xs rounded-full px-3.5 gap-1.5", (sentSign.has(c.id) || c.status === "aguardando_assinatura") ? "bg-emerald-500/15 text-emerald-700 border-emerald-300 hover:bg-emerald-100" : "text-purple-700 border-purple-300 hover:bg-purple-50")}
                          onClick={() => handleSendForSignature(c)}
                          disabled={sendingSign === c.id}
                        >
                          {sendingSign === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSignature className="h-3.5 w-3.5" />}
                          {sentSign.has(c.id) || c.status === "aguardando_assinatura" ? "Assinatura ✅" : "Enviar p/ Assinatura"}
                        </Button>
                      )}
                      {c.status === "assinado" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-xs rounded-full px-3.5 gap-1.5 bg-emerald-500/15 text-emerald-700 border-emerald-300 hover:bg-emerald-100"
                          onClick={() => handleToggleSignature(c.id)}
                        >
                          <ShieldCheck className="h-3.5 w-3.5" /> Ver Assinatura
                        </Button>
                      )}
                      <Button variant="outline" size="sm" className="h-8 text-xs rounded-full px-3.5 gap-1.5" onClick={() => handleShowAudit(c.id)}>
                        <History className="h-3.5 w-3.5" /> Histórico
                      </Button>
                      {!isCancelled && (
                        <Button variant="outline" size="sm" className="h-8 text-xs rounded-full px-3.5 gap-1.5 text-destructive hover:text-destructive" onClick={() => handleCancel(c)}>
                          <Ban className="h-3.5 w-3.5" /> Cancelar
                        </Button>
                      )}
                    </div>
                    {/* Signature details panel */}
                    {expandedSig === c.id && sigCache[c.id] && (
                      <div className="border-t border-border/40 pt-3 mt-3 bg-emerald-50/50 dark:bg-emerald-900/10 rounded-lg p-4 space-y-3">
                        <div className="flex items-center gap-2">
                          <ShieldCheck className="h-4 w-4 text-emerald-600" />
                          <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Comprovante de Assinatura Digital</span>
                        </div>
                        <div className="flex flex-col md:flex-row gap-4 items-start">
                          {sigCache[c.id].signature_image_url && (
                            <div className="border border-border/30 rounded-lg p-3 bg-white dark:bg-card shrink-0">
                              <img src={sigCache[c.id].signature_image_url} alt="Assinatura do cliente" className="h-16 object-contain" />
                            </div>
                          )}
                          <div className="text-xs text-muted-foreground space-y-1.5 flex-1">
                            {sigCache[c.id].signer_name && (
                              <p><strong className="text-foreground">Assinante:</strong> {sigCache[c.id].signer_name}</p>
                            )}
                            {sigCache[c.id].signer_phone && (
                              <p><strong className="text-foreground">Telefone:</strong> {sigCache[c.id].signer_phone}</p>
                            )}
                            {sigCache[c.id].signed_at && (
                              <p><strong className="text-foreground">Data/Hora:</strong> {new Date(sigCache[c.id].signed_at).toLocaleString("pt-BR")}</p>
                            )}
                            {sigCache[c.id].otp_verified_at && (
                              <p><strong className="text-foreground">OTP Verificado:</strong> {new Date(sigCache[c.id].otp_verified_at).toLocaleString("pt-BR")}</p>
                            )}
                            {sigCache[c.id].ip_address && (
                              <p><strong className="text-foreground">IP:</strong> {sigCache[c.id].ip_address}</p>
                            )}
                            {sigCache[c.id].user_agent && (
                              <p className="truncate max-w-xs"><strong className="text-foreground">Dispositivo:</strong> {sigCache[c.id].user_agent}</p>
                            )}
                            {sigCache[c.id].document_hash && (
                              <p className="font-mono text-[10px] break-all"><strong className="text-foreground">Hash SHA-256:</strong> {sigCache[c.id].document_hash}</p>
                            )}
                          </div>
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                          Assinatura eletrônica válida conforme MP 2.200-2, Art. 10, §2º. Registro com IP, hash SHA-256, timestamp e validação OTP via WhatsApp.
                        </p>
                      </div>
                    )}
                    {expandedSig === c.id && !sigCache[c.id] && (
                      <div className="border-t border-border/40 pt-3 mt-3 flex justify-center py-4">
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Generator Dialog */}
      <Dialog open={generatorOpen} onOpenChange={setGeneratorOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto p-0">
          <ContractGenerator
            userId={userId}
            onClose={() => { setGeneratorOpen(false); fetchContracts(); }}
          />
        </DialogContent>
      </Dialog>

      {/* View Contract - Full Document Viewer */}
      {viewContract && (
        <ContractDocumentViewerWithSignature
          contract={viewContract}
          companyName={currentCompany?.name || ""}
          companyLogo={getCompanyLogoOverride(currentCompany?.slug, currentCompany?.logo_url) || undefined}
          companyId={currentCompany?.id}
          userId={userId}
          onClose={() => setViewContract(null)}
        />
      )}

      {/* Audit Log Sheet */}
      {showAudit && (
        <Sheet open={!!showAudit} onOpenChange={() => setShowAudit(null)}>
          <SheetContent className="w-full sm:max-w-md overflow-y-auto">
            <SheetHeader className="pb-4 border-b border-border/40">
              <SheetTitle className="flex items-center gap-2"><History className="h-5 w-5 text-primary" /> Histórico do Contrato</SheetTitle>
            </SheetHeader>
            <div className="py-4 space-y-3">
              {auditLogs.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">Nenhum registro de atividade encontrado.</p>
              ) : (
                auditLogs.map(log => (
                  <div key={log.id} className="p-3 rounded-lg border border-border/40 bg-card">
                    <p className="text-sm font-medium">{ACTION_LABELS[log.action] || log.action}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {format(new Date(log.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                    </p>
                    {log.details?.error && (
                      <p className="text-xs text-destructive mt-1">{log.details.error}</p>
                    )}
                  </div>
                ))
              )}
            </div>
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}

/** Wrapper that fetches signature data before rendering the viewer */
function ContractDocumentViewerWithSignature({
  contract, companyName, companyLogo, companyId, userId, onClose,
}: {
  contract: GeneratedContract;
  companyName: string;
  companyLogo?: string;
  companyId?: string;
  userId: string;
  onClose: () => void;
}) {
  const [sigInfo, setSigInfo] = useState<any>(null);

  useEffect(() => {
    if (contract.status === "assinado" && companyId) {
      (supabase as any)
        .from("contract_signatures")
        .select("signature_image_url, signed_at, document_hash, ip_address, signer_name")
        .eq("contract_id", contract.id)
        .eq("status", "signed")
        .limit(1)
        .then(({ data }: any) => {
          if (data?.[0]) setSigInfo(data[0]);
        });
    }
  }, [contract.id, contract.status, companyId]);

  return (
    <ContractDocumentViewer
      open={true}
      onOpenChange={() => onClose()}
      content={contract.conteudo_renderizado}
      companyName={companyName}
      companyLogo={companyLogo}
      mode="generated"
      meta={{
        modelName: contract.nome_documento,
        status: contract.status,
        generatedAt: contract.created_at,
        leadName: contract.dados_utilizados?.lead?.name,
        eventDate: contract.dados_utilizados?.event?.date,
        eventType: contract.tipo_evento || undefined,
      }}
      contractId={contract.id}
      leadId={contract.lead_id || contract.dados_utilizados?.lead?.id || undefined}
      companyId={companyId}
      userId={userId}
      signatureInfo={sigInfo ? {
        signatureImageUrl: sigInfo.signature_image_url,
        signedAt: sigInfo.signed_at,
        documentHash: sigInfo.document_hash,
        ipAddress: sigInfo.ip_address,
        signerName: sigInfo.signer_name,
      } : undefined}
    />
  );
}
