import { useState, useEffect, useRef } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { SignatureCanvas } from "@/components/contracts/SignatureCanvas";
import { Loader2, FileText, CheckCircle2, ShieldCheck, Send, ArrowRight } from "lucide-react";
import { toast } from "@/hooks/use-toast";

interface ContractData {
  contract_id: string;
  company_id: string;
  company_name: string;
  company_logo: string | null;
  nome_documento: string;
  conteudo_renderizado: string;
  tipo_evento: string | null;
  status: string;
  signer_name: string | null;
  signer_phone: string | null;
  signature_status: string;
  signed_at: string | null;
  signature_image_url: string | null;
  document_hash: string | null;
}

/** Convert **bold** markers to <strong> */
function parseBold(text: string): string {
  return text.replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>");
}

export default function PublicContractSign() {
  const { token } = useParams<{ token: string }>();
  const [loading, setLoading] = useState(true);
  const [contract, setContract] = useState<ContractData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Signing flow
  const [step, setStep] = useState<"read" | "sign" | "otp" | "done">("read");
  const [signatureData, setSignatureData] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState("");
  const [sendingOtp, setSendingOtp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [maskedPhone, setMaskedPhone] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  // Espera para pedir outro código (o servidor também limita)
  const [cooldown, setCooldown] = useState(0);
  const actionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  // Ao mudar de etapa, leva o cliente até o quadro (o contrato é longo)
  useEffect(() => {
    if (step !== "read") actionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [step]);
  useEffect(() => {
    if (!token) return;
    fetchContract();
  }, [token]);
  // Assinou: mostra a confirmação (fica no topo)
  useEffect(() => {
    if (step === "done") window.scrollTo({ top: 0, behavior: "smooth" });
  }, [step]);

  const fetchContract = async (silent = false) => {
    if (!silent) setLoading(true);
    const { data, error: err } = await supabase.rpc("get_contract_for_signing", { _token: token! });
    if (err || !data || (data as any[]).length === 0) {
      setError("Contrato não encontrado ou link inválido.");
      setLoading(false);
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    setContract(row as ContractData);
    if (row.signature_status === "signed") setStep("done");
    setLoading(false);
  };

  const handleRequestOtp = async () => {
    if (!signatureData) {
      toast({ title: "Desenhe sua assinatura primeiro", variant: "destructive" });
      return;
    }
    setSendingOtp(true);
    try {
      const { data, error: err } = await supabase.functions.invoke("contract-otp", {
        body: { token, action: "send-otp" },
      });
      if (err || !data?.success) {
        if (data?.wait) setCooldown(Number(data.wait));
        toast({ title: "Não foi possível enviar o código", description: data?.error || "Tente de novo em instantes.", variant: "destructive" });
      } else {
        setMaskedPhone(data.maskedPhone || "");
        setOtpCode("");
        setCooldown(Number(data.cooldown) || 45);
        setStep("otp");
        toast({ title: "Código enviado no seu WhatsApp ✅" });
      }
    } finally {
      setSendingOtp(false);
    }
  };

  const handleSubmitSignature = async () => {
    if (otpCode.length < 6) {
      toast({ title: "Digite o código completo", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      // Pelo servidor: grava o IP real de quem assinou
      const { data, error: err } = await supabase.functions.invoke("contract-otp", {
        body: { token, action: "submit", otp: otpCode, signature: signatureData },
      });
      const result = (typeof data === "string" ? JSON.parse(data) : data) as any;
      if (err || !result?.success) {
        const left = result?.attempts_left;
        toast({
          title: "Não deu certo",
          description: `${result?.error || "Tente de novo."}${left !== undefined && left > 0 ? ` (${left} tentativa${left === 1 ? "" : "s"})` : ""}`,
          variant: "destructive",
        });
        setOtpCode("");
        if (result?.need_new_code) setCooldown(0);
      } else {
        setStep("done");
        toast({ title: "Contrato assinado com sucesso! ✅" });
        fetchContract(true); // data, hora e código do documento assinado (sem piscar a tela)
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error || !contract) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="p-8 text-center space-y-3">
            <FileText className="h-12 w-12 text-gray-400 mx-auto" />
            <p className="text-gray-600">{error || "Contrato não encontrado."}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          {contract.company_logo && (
            <img src={contract.company_logo} alt="" className="h-10 object-contain" />
          )}
          <div className="min-w-0 flex-1">
            <h1 className="font-bold text-sm truncate">{contract.nome_documento}</h1>
            <p className="text-xs text-gray-500">{contract.company_name}</p>
          </div>
          {step === "done" && (
            <Badge className="bg-emerald-500/15 text-emerald-700 border-emerald-300 shrink-0">
              <CheckCircle2 className="h-3 w-3 mr-1" /> Assinado
            </Badge>
          )}
          </div>
      </div>

      <div className="max-w-3xl mx-auto p-4 space-y-4">
        {step === "done" && (
          <Card className="border-emerald-300">
            <CardContent className="p-6 text-center space-y-3">
              <CheckCircle2 className="h-12 w-12 text-emerald-500 mx-auto" />
              <h3 className="font-bold text-lg text-emerald-700">Contrato Assinado!</h3>
              <p className="text-sm text-gray-600">
                Sua assinatura digital foi registrada com sucesso.
                O estabelecimento será notificado automaticamente.
              </p>
              {contract.signed_at && (
                <p className="text-xs text-gray-400">
                  Assinado em: {new Date(contract.signed_at).toLocaleString("pt-BR")}
                </p>
              )}
              {contract.document_hash && (
                <p className="text-xs text-gray-400 font-mono break-all">
                  Código do documento: {contract.document_hash}
                </p>
              )}
            </CardContent>
          </Card>
        )}
        {/* Contract content */}
        <Card>
          <CardContent className="p-6 md:p-8">
            <div className="text-center mb-6 pb-4 border-b-2 border-gray-200">
              {contract.company_logo && (
                <img src={contract.company_logo} alt="" className="h-28 mx-auto mb-2" />
              )}
              <h2 className="text-base font-bold tracking-wide uppercase text-gray-800">
                {contract.nome_documento}
              </h2>
            </div>
            <div
              className="whitespace-pre-wrap text-sm leading-[1.85] text-gray-800 font-serif text-justify"
              dangerouslySetInnerHTML={{ __html: parseBold(contract.conteudo_renderizado) }}
            />
          </CardContent>
        </Card>

        {/* Signing area */}
        <div ref={actionRef} />
        {step === "read" && contract.signature_status !== "signed" && (
          <div className="sticky bottom-0 z-10 -mx-4 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur">
            <div className="mx-auto flex max-w-3xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <label className="flex cursor-pointer items-start gap-3 text-left">
                <Checkbox
                  checked={acceptedTerms}
                  onCheckedChange={(v) => setAcceptedTerms(v === true)}
                  className="mt-0.5"
                />
                <span className="text-sm text-gray-700">Li e concordo com o contrato acima.</span>
              </label>
              <Button onClick={() => setStep("sign")} className="h-11 gap-2 sm:w-auto" disabled={!acceptedTerms}>
                <ArrowRight className="h-4 w-4" /> Assinar contrato
              </Button>
            </div>
          </div>
        )}

        {step === "sign" && (
          <Card>
            <CardContent className="p-6 space-y-4">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-600" /> Assinatura Digital
              </h3>
              {contract.signer_name && (
                <p className="text-sm text-gray-600">
                  Assinante: <strong>{contract.signer_name}</strong>
                </p>
              )}
              <SignatureCanvas onSignatureChange={setSignatureData} />
              <Button
                onClick={handleRequestOtp}
                disabled={!signatureData || sendingOtp || cooldown > 0}
                className="h-11 w-full gap-2"
              >
                {sendingOtp ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {cooldown > 0 ? `Aguarde ${cooldown}s` : "Receber código no WhatsApp"}
              </Button>
              <p className="text-xs text-gray-500 text-center">
                Para confirmar que é você, mandamos um código de 6 números no seu WhatsApp.
              </p>
            </CardContent>
          </Card>
        )}

        {step === "otp" && (
          <Card>
            <CardContent className="p-6 space-y-4">
              <h3 className="font-semibold text-sm">Código de Verificação</h3>
              <p className="text-sm text-gray-600">
                Digite o código de 6 números que chegou no seu WhatsApp {maskedPhone && `(${maskedPhone})`}:
              </p>
              <div className="flex justify-center">
                <InputOTP maxLength={6} value={otpCode} onChange={setOtpCode} autoFocus inputMode="numeric" autoComplete="one-time-code">
                  <InputOTPGroup>
                    <InputOTPSlot index={0} />
                    <InputOTPSlot index={1} />
                    <InputOTPSlot index={2} />
                    <InputOTPSlot index={3} />
                    <InputOTPSlot index={4} />
                    <InputOTPSlot index={5} />
                  </InputOTPGroup>
                </InputOTP>
              </div>
              <Button
                onClick={handleSubmitSignature}
                disabled={otpCode.length < 6 || submitting}
                className="w-full gap-2"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Confirmar assinatura
              </Button>
              <Button variant="ghost" size="sm" onClick={handleRequestOtp} disabled={sendingOtp || cooldown > 0} className="w-full text-xs">
                {cooldown > 0 ? `Não chegou? Peça outro em ${cooldown}s` : "Não chegou? Reenviar código"}
              </Button>
              <Button variant="link" size="sm" onClick={() => { setStep("sign"); setOtpCode(""); }} className="w-full text-xs text-gray-500">
                Voltar e refazer a assinatura
              </Button>
            </CardContent>
          </Card>
        )}


        {/* Legal footer */}
        <p className="text-[10px] text-gray-400 text-center pb-4">
          Assinatura eletrônica válida conforme MP 2.200-2, Art. 10, §2º.
          Registro com IP, código do documento (SHA-256), data e hora e confirmação por código no WhatsApp.
        </p>
      </div>
    </div>
  );
}
