import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, CheckCircle2, User, CreditCard, MapPin, Mail, Calendar, FileText, Baby, Plus, Trash2, MessageCircle, Instagram, PartyPopper } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { formatCPF, isValidCPF } from "@/lib/mask-utils";
import { prepareDocument, uploadClientDocument } from "@/lib/documentUpload";

interface RequestInfo {
  id: string;
  company_id: string;
  event_id: string;
  status: string;
  company_name: string;
  company_logo: string;
  event_title: string;
  event_date: string;
  // Número em que o cliente estava conversando (sem o SQL novo: undefined)
  reply_phone?: string | null;
}

interface BirthdayChild {
  name: string;
  age: string;
  birthdate: string;
}

interface Responsible {
  name: string;
  phone: string;
  relation: string;
}

interface ClientFormData {
  nome: string;
  cpf: string;
  rg: string;
  nascimento: string;
  email: string;
  cep: string;
  endereco: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  estado: string;
  birthday_children: BirthdayChild[];
  responsaveis: Responsible[];
  // Festa: o pacote que fechou e os convidados (o buffet confere)
  pacote: string;
  convidados: string;
  // Foto do documento (RG/CNH), no bucket privado client-documents
  documento_arquivo?: string;
  documento_nome?: string;
}

const EMPTY_FORM: ClientFormData = {
  nome: "",
  cpf: "",
  rg: "",
  nascimento: "",
  email: "",
  cep: "",
  endereco: "",
  numero: "",
  complemento: "",
  bairro: "",
  cidade: "",
  estado: "",
  birthday_children: [{ name: "", age: "", birthdate: "" }],
  responsaveis: [{ name: "", phone: "", relation: "" }, { name: "", phone: "", relation: "" }],
  pacote: "",
  convidados: "",
};

const RELATIONS = [
  { value: "pai", label: "Pai" },
  { value: "mae", label: "Mãe" },
  { value: "avo", label: "Avó" },
  { value: "avo_m", label: "Avô" },
  { value: "tio", label: "Tio" },
  { value: "tia", label: "Tia" },
  { value: "padrasto", label: "Padrasto" },
  { value: "madrasta", label: "Madrasta" },
  { value: "outros", label: "Outros" },
];

// formatCPF and isValidCPF imported from @/lib/mask-utils

function formatCEP(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 5) return digits;
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

function SectionHeader({ icon: Icon, label }: { icon: React.ElementType; label: string }) {
  return (
    <div className="flex items-center gap-2.5 text-[11px] uppercase tracking-[0.18em] font-semibold text-muted-foreground mb-4 pb-3 border-b border-border/40">
      <div className="p-1.5 rounded-lg bg-primary/10 ring-1 ring-primary/15">
        <Icon className="h-3.5 w-3.5 text-primary" />
      </div>
      {label}
    </div>
  );
}

function whatsappDigits(raw: unknown): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  const local = digits.length >= 12 && digits.startsWith("55") ? digits.slice(2) : digits;
  // Só número brasileiro válido (DDD + 8 ou 9 dígitos)
  return local.length === 10 || local.length === 11 ? `55${local}` : null;
}

function instagramUrl(raw: unknown): string | null {
  const v = String(raw || "").trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  const handle = v.replace(/^@/, "").replace(/^(www\.)?instagram\.com\//i, "").replace(/\/.*$/, "");
  return handle ? `https://instagram.com/${handle}` : null;
}

export default function PublicClientData() {
  const { token } = useParams<{ token: string }>();
  const [loading, setLoading] = useState(true);
  const [requestInfo, setRequestInfo] = useState<RequestInfo | null>(null);
  const [form, setForm] = useState<ClientFormData>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchingCep, setFetchingCep] = useState(false);
  const [cpfError, setCpfError] = useState<string | null>(null);
  // Pacotes ativos do buffet (sem a função no banco: o pacote vira campo de texto)
  const [packages, setPackages] = useState<string[]>([]);
  // WhatsApp e Instagram do buffet (os mesmos do site) para a tela final
  const [contacts, setContacts] = useState<{ whatsapp: string | null; instagram: string | null }>({ whatsapp: null, instagram: null });
  // Documento com foto: o buffet escolhe se pede (off / optional / required)
  const [documentMode, setDocumentMode] = useState<"off" | "optional" | "required">("off");
  const [uploadingDoc, setUploadingDoc] = useState(false);

  useEffect(() => {
    if (!token) return;
    const fetchRequest = async () => {
      const { data, error } = await supabase.rpc("get_client_data_request_by_token", { _token: token });
      if (error || !data || (data as any[]).length === 0) {
        setError("Link inválido ou expirado.");
        setLoading(false);
        return;
      }
      const info = (data as any[])[0] as RequestInfo;
      if (info.status === "completed" || info.status === "reviewed") {
        setSubmitted(true);
      }
      supabase.rpc("get_client_data_packages" as any, { _token: token }).then(({ data: pk }) => {
        if (Array.isArray(pk)) setPackages((pk as Array<{ name: string }>).map((p) => p.name).filter(Boolean));
      });
      supabase.rpc("get_client_data_document_mode" as any, { _token: token }).then(({ data: mode, error: modeErr }) => {
        if (!modeErr && (mode === "optional" || mode === "required")) setDocumentMode(mode);
      });
      setRequestInfo(info);
      setLoading(false);
      const { data: fields } = await supabase.rpc("get_onboarding_public_fields", { _company_id: info.company_id });
      const row = ((fields as any[]) || [])[0];
      setContacts({
        whatsapp: whatsappDigits(info.reply_phone) || whatsappDigits(row?.whatsapp_numbers?.[0]),
        instagram: instagramUrl(row?.instagram),
      });
    };
    fetchRequest();
  }, [token]);

  const handleCepBlur = async () => {
    const cepDigits = form.cep.replace(/\D/g, "");
    if (cepDigits.length !== 8) return;
    setFetchingCep(true);
    try {
      const res = await fetch(`https://viacep.com.br/ws/${cepDigits}/json/`);
      const data = await res.json();
      if (!data.erro) {
        setForm((prev) => ({
          ...prev,
          endereco: data.logradouro || prev.endereco,
          bairro: data.bairro || prev.bairro,
          cidade: data.localidade || prev.cidade,
          estado: data.uf || prev.estado,
        }));
      }
    } catch {
      // silently fail
    } finally {
      setFetchingCep(false);
    }
  };

  const handleDocument = async (file: File | undefined) => {
    if (!file || !requestInfo || !token) return;
    setUploadingDoc(true);
    // Foto reduzida e convertida para JPG no próprio celular (fotos de 5–12 MB / HEIC eram recusadas)
    const doc = await prepareDocument(file);
    if (doc.blob.size > 10 * 1024 * 1024) {
      setUploadingDoc(false);
      toast({ title: "Arquivo muito grande", description: "Envie uma foto ou PDF de até 10 MB.", variant: "destructive" });
      return;
    }
    const path = `${requestInfo.company_id}/${token}/${crypto.randomUUID()}.${doc.ext}`;
    const upErr = await uploadClientDocument(path, doc);
    setUploadingDoc(false);
    if (upErr) {
      console.error("[dados] envio do documento:", upErr, file.type, file.size);
      toast({ title: "Não consegui enviar o documento", description: `Tente de novo ou mande outra foto. (${upErr.slice(0, 80)})`, variant: "destructive" });
      return;
    }
    setForm((prev) => ({ ...prev, documento_arquivo: path, documento_nome: file.name }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.nome.trim()) {
      toast({ title: "Preencha o nome completo", variant: "destructive" });
      return;
    }
    if (form.cpf.replace(/\D/g, "").length < 11) {
      toast({ title: "Preencha o CPF completo", variant: "destructive" });
      setCpfError("CPF incompleto");
      return;
    }
    if (!isValidCPF(form.cpf)) {
      toast({ title: "CPF inválido", description: "Verifique os números digitados.", variant: "destructive" });
      setCpfError("CPF inválido");
      return;
    }
    setCpfError(null);
    if (documentMode === "required" && !form.documento_arquivo) {
      toast({ title: "Envie a foto do documento", description: "RG ou CNH, frente com a foto.", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase.rpc("submit_client_data_public", {
        _token: token!,
        _client_data: form as any,
      });
      if (error) throw error;
      setSubmitted(true);
    } catch (err: any) {
      toast({ title: "Erro ao enviar", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-muted/40 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-muted/40 flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-md">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-destructive/10 flex items-center justify-center">
            <FileText className="w-8 h-8 text-destructive" />
          </div>
          <h1 className="text-xl font-bold text-foreground">Link inválido</h1>
          <p className="text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  if (submitted) {
    const firstName = form.nome.trim().split(/\s+/)[0] || "";
    const child = form.birthday_children.find((c) => c.name.trim())?.name.trim().split(/\s+/)[0] || "";
    const partyDate = requestInfo?.event_date
      ? new Date(`${requestInfo.event_date}T12:00:00`).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" })
      : "";
    const steps = [
      { done: true, text: "Recebemos seus dados" },
      { done: false, text: "Nossa equipe prepara o contrato" },
      { done: false, text: "Você recebe o contrato para assinar pelo WhatsApp" },
    ];
    return (
      <div className="min-h-screen bg-muted/40 px-5 py-10 sm:py-14">
        <Helmet>
          <title>Dados enviados | {requestInfo?.company_name}</title>
        </Helmet>
        <div className="mx-auto max-w-md space-y-6 text-center">
          {requestInfo?.company_logo && (
            <img src={requestInfo.company_logo} alt={requestInfo.company_name} className="mx-auto h-28 w-auto max-w-[260px] object-contain sm:h-32" />
          )}
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-green-500/10">
            <CheckCircle2 className="h-9 w-9 text-green-600" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-bold text-foreground">{firstName ? `Obrigado, ${firstName}! 🎉` : "Obrigado! 🎉"}</h1>
            <p className="text-muted-foreground">Recebemos seus dados. Nossa equipe já está com tudo para preparar o contrato.</p>
          </div>

          {(child || partyDate) && (
            <div className="rounded-2xl border border-border/40 bg-card px-5 py-4 shadow-sm">
              <p className="text-base font-semibold text-foreground">🎂 {child ? `Aniversário de ${child}` : "Sua festa"}</p>
              {partyDate && <p className="mt-0.5 text-sm capitalize text-muted-foreground">{partyDate}</p>}
            </div>
          )}

          <div className="rounded-2xl border border-border/40 bg-card p-5 text-left shadow-sm">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">O que acontece agora</p>
            <ol className="space-y-3">
              {steps.map((st, i) => (
                <li key={i} className="flex items-center gap-3 text-sm">
                  <span className={st.done ? "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-green-600 text-white" : "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground"}>
                    {st.done ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
                  </span>
                  <span className={st.done ? "font-medium text-foreground" : "text-foreground"}>{st.text}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="space-y-3">
            {contacts.whatsapp && (
              <a href={`https://wa.me/${contacts.whatsapp}`} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#25D366] font-semibold text-white shadow-sm hover:opacity-95">
                <MessageCircle className="h-5 w-5" /> Voltar para o WhatsApp
              </a>
            )}
            {contacts.instagram && (
              <a href={contacts.instagram} target="_blank" rel="noreferrer" className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-border bg-card font-semibold text-foreground shadow-sm hover:bg-muted/50">
                <Instagram className="h-5 w-5 text-pink-600" /> Siga a gente no Instagram
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/40">
      <Helmet>
        <title>Dados do Contratante | {requestInfo?.company_name}</title>
      </Helmet>

      {/* Premium Header */}
      <header className="border-b border-border/40 bg-card shadow-sm">
        <div className="max-w-2xl mx-auto flex items-center gap-4 px-6 py-4">
          {requestInfo?.company_logo && (
            <img src={requestInfo.company_logo} alt={requestInfo?.company_name} className="h-14 w-auto max-w-[140px] object-contain" />
          )}
          <div>
            <h1 className="text-base font-bold text-foreground tracking-tight">{requestInfo?.company_name}</h1>
            <p className="text-xs text-muted-foreground">Dados do contratante</p>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-5">
        {/* Intro card */}
        <div className="rounded-2xl border border-border/40 bg-card p-5 sm:p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-primary/10 text-primary shrink-0 mt-0.5">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-foreground tracking-tight">Preencha seus dados</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Esses dados serão utilizados para a elaboração do contrato da festa.
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Section: Dados Pessoais */}
          <div className="rounded-2xl border border-border/40 bg-card p-5 sm:p-6 shadow-sm">
            <SectionHeader icon={User} label="Dados Pessoais" />
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-xs font-semibold text-foreground">Nome completo <span className="text-destructive">*</span></Label>
                <Input
                  value={form.nome}
                  onChange={(e) => setForm({ ...form, nome: e.target.value })}
                  placeholder="Nome do contratante"
                  className="bg-muted/30 border-border/50 focus:bg-background"
                  required
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-xs font-semibold text-foreground">CPF <span className="text-destructive">*</span></Label>
                  <Input
                    value={form.cpf}
                    onChange={(e) => {
                      setForm({ ...form, cpf: formatCPF(e.target.value) });
                      setCpfError(null);
                    }}
                    onBlur={() => {
                      const d = form.cpf.replace(/\D/g, "");
                      if (d.length === 11 && !isValidCPF(form.cpf)) {
                        setCpfError("CPF inválido");
                      } else if (d.length > 0 && d.length < 11) {
                        setCpfError("CPF incompleto");
                      } else {
                        setCpfError(null);
                      }
                    }}
                    placeholder="000.000.000-00"
                    maxLength={14}
                    className={`bg-muted/30 border-border/50 focus:bg-background ${cpfError ? "border-destructive ring-1 ring-destructive/30" : ""}`}
                    required
                  />
                  {cpfError && (
                    <p className="text-[11px] text-destructive font-medium mt-1">{cpfError}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-semibold text-foreground">RG</Label>
                  <Input
                    value={form.rg}
                    onChange={(e) => setForm({ ...form, rg: e.target.value })}
                    className="bg-muted/30 border-border/50 focus:bg-background"
                  />
                </div>
              </div>

              {documentMode !== "off" && (
                <div className="space-y-2">
                  <Label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                    Foto do documento (RG ou CNH){documentMode === "required" ? " *" : " (opcional)"}
                  </Label>
                  <label className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-dashed px-3 py-3 text-sm ${form.documento_arquivo ? "border-green-500/50 bg-green-500/5" : "border-border bg-muted/30"}`}>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {uploadingDoc ? "Enviando…" : form.documento_arquivo ? `✅ ${form.documento_nome || "Documento enviado"}` : "Toque para tirar uma foto ou escolher o arquivo"}
                    </span>
                    {uploadingDoc ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" /> : <span className="shrink-0 text-xs font-semibold text-primary">{form.documento_arquivo ? "Trocar" : "Enviar"}</span>}
                    <input
                      type="file"
                      accept="image/*,application/pdf"
                      className="hidden"
                      disabled={uploadingDoc}
                      onChange={(e) => { handleDocument(e.target.files?.[0]); e.target.value = ""; }}
                    />
                  </label>
                  <p className="text-[11px] text-muted-foreground">A frente do documento, com a foto. Só o buffet vê.</p>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
                    Data de nascimento
                  </Label>
                  <Input
                    type="date"
                    value={form.nascimento}
                    onChange={(e) => setForm({ ...form, nascimento: e.target.value })}
                    className="bg-muted/30 border-border/50 focus:bg-background h-10 text-sm text-left appearance-none [&::-webkit-date-and-time-value]:text-left [&::-webkit-date-and-time-value]:min-h-[1.25rem]"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5 text-muted-foreground" />
                    E-mail
                  </Label>
                  <Input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className="bg-muted/30 border-border/50 focus:bg-background"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Section: Endereço */}
          <div className="rounded-2xl border border-border/40 bg-card p-5 sm:p-6 shadow-sm">
            <SectionHeader icon={MapPin} label="Endereço" />
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-xs font-semibold text-foreground">CEP</Label>
                <div className="relative max-w-[200px]">
                  <Input
                    value={form.cep}
                    onChange={(e) => setForm({ ...form, cep: formatCEP(e.target.value) })}
                    onBlur={handleCepBlur}
                    placeholder="00000-000"
                    maxLength={9}
                    className="bg-muted/30 border-border/50 focus:bg-background"
                  />
                  {fetchingCep && <Loader2 className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="sm:col-span-2 space-y-2">
                  <Label className="text-xs font-semibold text-foreground">Endereço</Label>
                  <Input
                    value={form.endereco}
                    onChange={(e) => setForm({ ...form, endereco: e.target.value })}
                    className="bg-muted/30 border-border/50 focus:bg-background"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-semibold text-foreground">Número</Label>
                  <Input
                    value={form.numero}
                    onChange={(e) => setForm({ ...form, numero: e.target.value })}
                    className="bg-muted/30 border-border/50 focus:bg-background"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs font-semibold text-foreground">Complemento</Label>
                <Input
                  value={form.complemento}
                  onChange={(e) => setForm({ ...form, complemento: e.target.value })}
                  className="bg-muted/30 border-border/50 focus:bg-background"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label className="text-xs font-semibold text-foreground">Bairro</Label>
                  <Input
                    value={form.bairro}
                    onChange={(e) => setForm({ ...form, bairro: e.target.value })}
                    className="bg-muted/30 border-border/50 focus:bg-background"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-semibold text-foreground">Cidade</Label>
                  <Input
                    value={form.cidade}
                    onChange={(e) => setForm({ ...form, cidade: e.target.value })}
                    className="bg-muted/30 border-border/50 focus:bg-background"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-semibold text-foreground">Estado</Label>
                  <Input
                    value={form.estado}
                    onChange={(e) => setForm({ ...form, estado: e.target.value })}
                    maxLength={2}
                    placeholder="UF"
                    className="bg-muted/30 border-border/50 focus:bg-background"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Section: Festa (pacote e convidados que a cliente fechou; o buffet confere) */}
          <div className="rounded-2xl border border-border/40 bg-card p-5 sm:p-6 shadow-sm">
            <SectionHeader icon={PartyPopper} label="Sua Festa" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-foreground">Pacote escolhido</Label>
                {packages.length > 0 ? (
                  <Select value={form.pacote} onValueChange={(v) => setForm({ ...form, pacote: v })}>
                    <SelectTrigger className="bg-muted/30 border-border/50 focus:bg-background">
                      <SelectValue placeholder="Selecione o pacote" />
                    </SelectTrigger>
                    <SelectContent>
                      {packages.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                      <SelectItem value="Ainda não sei">Ainda não sei</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={form.pacote}
                    onChange={(e) => setForm({ ...form, pacote: e.target.value })}
                    placeholder="Ex.: Festa Premium"
                    className="bg-muted/30 border-border/50 focus:bg-background"
                  />
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-foreground">Quantidade de convidados</Label>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={form.convidados}
                  onChange={(e) => setForm({ ...form, convidados: e.target.value.replace(/\D/g, "").slice(0, 4) })}
                  placeholder="Ex.: 60"
                  className="bg-muted/30 border-border/50 focus:bg-background"
                />
              </div>
            </div>
          </div>

          {/* Section: Aniversariante */}
          <div className="rounded-2xl border border-border/40 bg-card p-5 sm:p-6 shadow-sm">
            <SectionHeader icon={Baby} label="Aniversariante & Responsáveis" />
            <div className="space-y-4">
              {form.birthday_children.map((child, idx) => {
                const updateChild = (field: keyof BirthdayChild, value: string) => {
                  const updated = [...form.birthday_children];
                  updated[idx] = { ...updated[idx], [field]: value };
                  setForm({ ...form, birthday_children: updated });
                };
                return (
                  <div key={idx} className="rounded-xl border border-border/40 bg-muted/20 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                        Aniversariante {form.birthday_children.length > 1 ? idx + 1 : ""}
                      </span>
                      {form.birthday_children.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => {
                            const updated = [...form.birthday_children];
                            updated.splice(idx, 1);
                            setForm({ ...form, birthday_children: updated });
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold text-foreground">Nome</Label>
                        <Input value={child.name} onChange={(e) => updateChild("name", e.target.value)} placeholder="Nome do aniversariante" className="bg-muted/30 border-border/50 focus:bg-background" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold text-foreground">Idade a comemorar</Label>
                        <div className="relative">
                          <Input value={child.age} onChange={(e) => updateChild("age", e.target.value.replace(/\D/g, ''))} placeholder="Ex: 5" className="bg-muted/30 border-border/50 focus:bg-background pr-14" />
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">anos</span>
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold text-foreground">Data de nascimento</Label>
                        <Input type="date" value={child.birthdate} onChange={(e) => updateChild("birthdate", e.target.value)} className="bg-muted/30 border-border/50 focus:bg-background" />
                      </div>
                    </div>
                  </div>
                );
              })}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full text-xs gap-1.5"
                onClick={() => {
                  setForm({ ...form, birthday_children: [...form.birthday_children, { name: "", age: "", birthdate: "" }] });
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                Adicionar aniversariante
              </Button>

              {/* Responsáveis */}
              <div className="space-y-3 mt-5 pt-5 border-t border-border/40">
                <Label className="text-xs font-semibold text-foreground">Responsáveis</Label>
                {form.responsaveis.map((r, idx) => (
                  <div key={idx} className="rounded-xl border border-border/40 bg-muted/20 p-3 space-y-2">
                    <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{idx + 1}º Responsável</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <Input
                        placeholder="Nome"
                        value={r.name}
                        onChange={(e) => {
                          const updated = [...form.responsaveis];
                          updated[idx] = { ...updated[idx], name: e.target.value };
                          setForm({ ...form, responsaveis: updated });
                        }}
                        className="bg-muted/30 border-border/50 focus:bg-background"
                      />
                      <Input
                        placeholder="Telefone"
                        value={r.phone}
                        onChange={(e) => {
                          const updated = [...form.responsaveis];
                          updated[idx] = { ...updated[idx], phone: e.target.value };
                          setForm({ ...form, responsaveis: updated });
                        }}
                        className="bg-muted/30 border-border/50 focus:bg-background"
                      />
                      <Select
                        value={r.relation || "none"}
                        onValueChange={(v) => {
                          const updated = [...form.responsaveis];
                          updated[idx] = { ...updated[idx], relation: v === "none" ? "" : v };
                          setForm({ ...form, responsaveis: updated });
                        }}
                      >
                        <SelectTrigger className="bg-muted/30 border-border/50">
                          <SelectValue placeholder="Parentesco" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Selecione</SelectItem>
                          {RELATIONS.map((rel) => <SelectItem key={rel.value} value={rel.value}>{rel.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Submit */}
          <div className="rounded-2xl border border-border/40 bg-card p-5 shadow-sm">
            <Button type="submit" className="w-full h-12 rounded-xl text-base font-semibold gap-2 shadow-sm" disabled={submitting || uploadingDoc}>
              {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <CreditCard className="h-5 w-5" />}
              Enviar dados
            </Button>
            <p className="text-[11px] text-muted-foreground text-center mt-3">
              Seus dados serão utilizados exclusivamente para a elaboração do contrato.
            </p>
          </div>
        </form>
      </main>
    </div>
  );
}
