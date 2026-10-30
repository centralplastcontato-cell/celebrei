import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { Copy, Loader2, Send } from "lucide-react";
import {
  type ClientDataRequestRow,
  clientDataLabel,
  clientDataState,
  clientDataMessageLink,
  clientDataUrl,
  createClientDataRequest,
  isPastEventRequest,
  latestClientDataByLead,
} from "@/lib/clientDataRequest";

interface Props {
  companyId: string;
  companyName: string;
  customDomain?: string | null;
  lead: { id: string; name: string; status: string };
  /** Envia o texto pelo WhatsApp desta conversa (mesmo caminho do chat) */
  sendText: (message: string) => Promise<void>;
  compact?: boolean;
}

/**
 * Faixa "Dados do contrato" no topo da conversa: pedir o link com um toque,
 * ver se está pendente/atrasado e abrir os dados quando o cliente preencher.
 * Aparece com o lead Fechado ou quando já existe um pedido.
 */
export function ClientDataBar({ companyId, companyName, customDomain, lead, sendText, compact }: Props) {
  const [request, setRequest] = useState<ClientDataRequestRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setRequest(null);
    latestClientDataByLead([lead.id]).then((map) => {
      if (cancelled) return;
      setRequest(map.get(lead.id) || null);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [lead.id]);

  if (!loaded) return null;
  if (!request && lead.status !== "fechado") return null;

  const askData = async () => {
    setBusy(true);
    try {
      const created = await createClientDataRequest({ companyId, companyName, customDomain, leadId: lead.id, leadName: lead.name, sentVia: "botao" });
      await sendText(created.message);
      setRequest(created.request);
      toast({ title: "Link enviado para o cliente ✅", description: "Se ele não preencher, a plataforma cobra no horário de atendimento (se as cobranças estiverem ligadas)." });
    } catch (e) {
      toast({ title: "Não consegui enviar o link", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!request) return;
    setBusy(true);
    try {
      const link = clientDataMessageLink(request.token, customDomain);
      const first = lead.name.trim().split(/\s+/)[0] || "";
      await sendText(`Oi${first ? `, ${first}` : ""}! 😊 Segue de novo o link pra preencher os dados do contrato da festa:\n\n${link}`);
      toast({ title: "Link reenviado ✅" });
    } catch (e) {
      toast({ title: "Não consegui reenviar", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    if (!request) return;
    navigator.clipboard.writeText(clientDataUrl(request.token, customDomain));
    toast({ title: "Link copiado" });
  };

  const state = request ? clientDataState(request) : null;
  // Cliente que voltou: os dados recebidos são da festa que já aconteceu
  const pastParty = !!request && isPastEventRequest(request.event_date);
  const tone = state === "recebido" ? "bg-green-500/10 text-green-800 border-green-500/20 dark:text-green-300"
    : state === "atrasado" ? "bg-red-500/10 text-red-700 border-red-500/20 dark:text-red-300"
    : state === "pendente" ? "bg-amber-500/10 text-amber-800 border-amber-500/20 dark:text-amber-300"
    : "bg-muted/40 text-muted-foreground border-border";

  return (
    <>
      <div className={cn("flex items-center gap-2 border-b px-3 py-1.5 text-xs font-medium shrink-0", tone)}>
        <span className="truncate">
          {request ? clientDataLabel(request) : "📋 Festa fechada: falta pedir os dados do contrato"}
          {pastParty && request?.event_date && <span className="opacity-80"> · festa de {request.event_date.split("-").reverse().join("/")}</span>}
        </span>
        {request && (request.reminder_count || 0) > 0 && (request.reminder_count || 0) < 99 && state !== "recebido" && (
          <span className="shrink-0 opacity-80">· {request.reminder_count} cobrança{request.reminder_count === 1 ? "" : "s"}</span>
        )}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {(!request || pastParty) && (
            <Button size="sm" className="h-7 px-2 text-xs" onClick={askData} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              <span className={cn("ml-1", compact && "sr-only")}>{pastParty ? "Pedir dados da nova festa" : "Pedir dados"}</span>
            </Button>
          )}
          {request && state === "recebido" && (
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setOpen(true)}>Ver dados</Button>
          )}
          {request && state !== "recebido" && !pastParty && (
            <>
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={resend} disabled={busy}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Reenviar"}
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={copy} aria-label="Copiar link"><Copy className="h-3.5 w-3.5" /></Button>
            </>
          )}
        </div>
      </div>
      {request && <ClientDataDialog open={open} onOpenChange={setOpen} data={request.client_data} />}
    </>
  );
}

type Json = Record<string, any>;

// "1985-03-06" → "06/03/1985"; "15981121710" → "(15) 98112-1710"
const brDate = (v: unknown) => {
  const t = String(v || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : t;
};
const brPhone = (v: unknown) => {
  const d = String(v || "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return String(v || "");
};

function Field({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  const copy = () => {
    navigator.clipboard.writeText(value);
    toast({ title: `${label} copiado` });
  };
  return (
    <button type="button" onClick={copy} className="group flex w-full items-start justify-between gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-muted/60">
      <span className="shrink-0 text-xs text-muted-foreground pt-0.5">{label}</span>
      <span className="flex min-w-0 items-start gap-1.5 text-right text-sm font-medium text-foreground">
        <span className="[overflow-wrap:anywhere]">{value}</span>
        <Copy className="mt-0.5 h-3 w-3 shrink-0 opacity-30 group-hover:opacity-70" />
      </span>
    </button>
  );
}

/**
 * Documento com foto que o cliente mandou (bucket privado: link de 5 min).
 * Aparece aqui mesmo: no iPhone, abrir janela nova depois de buscar o link é
 * bloqueado (o "Ver" não fazia nada). "Abrir em tela cheia" é um link de verdade.
 */
function DocumentField({ path, name }: { path: string; name?: string }) {
  const [opening, setOpening] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const isPdf = /\.pdf$/i.test(path);
  const open = async () => {
    if (url) { setUrl(null); return; }
    setOpening(true);
    const { data, error } = await supabase.storage.from("client-documents").createSignedUrl(path, 300);
    setOpening(false);
    if (error || !data?.signedUrl) {
      toast({ title: "Não consegui abrir o documento", description: error?.message, variant: "destructive" });
      return;
    }
    setUrl(data.signedUrl);
  };
  return (
    <div>
      <button type="button" onClick={open} disabled={opening} className="flex w-full items-center justify-between gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-muted/60">
        <span className="shrink-0 text-xs text-muted-foreground">Documento</span>
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-primary">
          <span className="truncate">{opening ? "Abrindo…" : url ? "Fechar" : `📎 Ver ${name ? `(${name})` : "documento"}`}</span>
        </span>
      </button>
      {url && (
        <div className="space-y-2 px-2 pb-2">
          {isPdf
            ? <p className="text-xs text-muted-foreground">Documento em PDF.</p>
            : <img src={url} alt="Documento do contratante" className="w-full rounded-xl border border-border/60 object-contain" />}
          <a href={url} target="_blank" rel="noopener noreferrer" className="block text-center text-xs font-semibold text-primary underline">
            {isPdf ? "Abrir o PDF" : "Abrir em tela cheia"}
          </a>
        </div>
      )}
    </div>
  );
}

function Section({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border/50 bg-muted/30 p-3">
      <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{icon} {title}</p>
      {children}
    </div>
  );
}

function ClientDataDialog({ open, onOpenChange, data }: { open: boolean; onOpenChange: (v: boolean) => void; data: Record<string, unknown> | null }) {
  const d = (data || {}) as Json;
  const address = [d.endereco && `${d.endereco}${d.numero ? `, ${d.numero}` : ""}`, d.complemento, d.bairro, d.cidade && `${d.cidade}${d.estado ? `/${d.estado}` : ""}`, d.cep && `CEP ${d.cep}`]
    .filter(Boolean).join(" · ");
  const children = Array.isArray(d.birthday_children) ? (d.birthday_children as Json[]).filter((c) => c?.name) : [];
  const people = Array.isArray(d.responsaveis) ? (d.responsaveis as Json[]).filter((r) => r?.name) : [];

  const copyAll = () => {
    const lines = [
      d.nome && `Nome: ${d.nome}`, d.cpf && `CPF: ${d.cpf}`, d.rg && `RG: ${d.rg}`,
      d.nascimento && `Nascimento: ${brDate(d.nascimento)}`, d.email && `E-mail: ${d.email}`, address && `Endereço: ${address}`,
      d.pacote && `Pacote: ${d.pacote}`, d.convidados && `Convidados: ${d.convidados}`,
      ...children.map((c) => `Aniversariante: ${c.name}${c.age ? `, ${c.age} anos` : ""}${c.birthdate ? ` (${brDate(c.birthdate)})` : ""}`),
      ...people.map((r) => `Responsável: ${r.name}${r.relation ? ` (${r.relation})` : ""}${r.phone ? ` · ${brPhone(r.phone)}` : ""}`),
    ].filter(Boolean);
    navigator.clipboard.writeText(lines.join("\n"));
    toast({ title: "Dados copiados" });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex w-[calc(100%-2rem)] max-w-md flex-col gap-0 overflow-hidden rounded-3xl p-0 max-h-[85vh] sm:max-w-3xl sm:rounded-3xl">
        <DialogHeader className="space-y-1 px-5 pb-3 pt-5 pr-12 text-left sm:px-6 sm:pt-6">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-green-500/15 text-base">✅</span>
            Dados do contratante
          </DialogTitle>
          <DialogDescription className="text-xs">Preenchidos pelo cliente. Já vão para a festa e para o contrato. Toque num dado para copiar.</DialogDescription>
        </DialogHeader>
        {/* Rolagem por dentro: a barra não corta os cantos arredondados */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 [scrollbar-width:thin] sm:px-6 sm:pb-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <Section icon="👤" title="Contratante">
              <Field label="Nome" value={String(d.nome || "")} />
              <Field label="CPF" value={String(d.cpf || "")} />
              <Field label="RG" value={String(d.rg || "")} />
              <Field label="Nascimento" value={brDate(d.nascimento)} />
              <Field label="E-mail" value={String(d.email || "")} />
              {d.documento_arquivo && <DocumentField path={String(d.documento_arquivo)} name={d.documento_nome ? String(d.documento_nome) : undefined} />}
            </Section>
            <div className="space-y-3">
              {(d.pacote || d.convidados) && (
                <Section icon="🎉" title="Festa">
                  <Field label="Pacote" value={String(d.pacote || "")} />
                  <Field label="Convidados" value={d.convidados ? String(d.convidados) : ""} />
                </Section>
              )}
              {address && (
                <Section icon="📍" title="Endereço">
                  <Field label="Endereço" value={address} />
                </Section>
              )}
              {children.length > 0 && (
                <Section icon="🎂" title={`Aniversariante${children.length > 1 ? "s" : ""}`}>
                  {children.map((c, i) => (
                    <Field key={i} label={String(c.name)} value={[c.age && `${c.age} anos`, c.birthdate && brDate(c.birthdate)].filter(Boolean).join(" · ") || "—"} />
                  ))}
                </Section>
              )}
              {people.length > 0 && (
                <Section icon="👨‍👩‍👧" title="Responsáveis">
                  {people.map((r, i) => (
                    <Field key={i} label={`${r.name}${r.relation ? ` (${r.relation})` : ""}`} value={brPhone(r.phone) || "—"} />
                  ))}
                </Section>
              )}
            </div>
          </div>
          <Button variant="outline" className="mt-3 w-full rounded-xl" onClick={copyAll}>
            <Copy className="mr-2 h-4 w-4" /> Copiar todos os dados
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
