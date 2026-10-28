import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FileText, Globe, GraduationCap, Loader2, MessageCircle, RotateCcw, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { upcomingMonthOptions } from "@/lib/partyDate";
import { AiTeachDialog, type TeachContext } from "./AiTeachDialog";

interface Reply { kind: "text" | "image" | "video" | "document"; text: string; mediaUrl?: string; fileName?: string }
interface Line { who: "cliente" | "ia" | "aviso"; reply: Reply }

const SUGGESTIONS = ["Oi, quanto fica uma festa pra 70 pessoas?", "Vocês têm data livre em dezembro?", "Posso levar o bolo de fora?", "Quero visitar o buffet"];

/**
 * "Testar a minha IA": o dono conversa como se fosse um cliente. A IA responde no
 * modo isolado (ai-simulator, action "chat"): nada vai para o WhatsApp nem fica gravado.
 */
export function AiTestChat({ open, onOpenChange, companyId, canTeach = false, onTaught }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  companyId: string;
  /** mostra "Corrigir" embaixo das respostas da IA (quem gerencia o buffet) */
  canTeach?: boolean;
  onTaught?: () => void;
}) {
  const [teach, setTeach] = useState<TeachContext | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [state, setState] = useState<unknown>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  // Começo do teste: escolher como o cliente chegou
  const [mode, setMode] = useState<"escolher" | "whatsapp" | "site">("escolher");
  const [site, setSite] = useState({ name: "Mariana", month: "", day: "", guests: "70" });
  const months = upcomingMonthOptions();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView?.({ behavior: "smooth" }); }, [lines, busy]);

  const reset = () => { setLines([]); setState(null); setLeft(null); setText(""); setMode("escolher"); };

  // siteLead: começa como o lead do site (a IA abre com a boas-vindas do site)
  const send = async (msg: string, siteLead?: Record<string, unknown>) => {
    const m = msg.trim();
    if ((!m && !siteLead) || busy) return;
    setText("");
    setLines((l) => siteLead
      ? [...l, { who: "aviso", reply: { kind: "text", text: `${siteLead.name} respondeu no site: ${siteLead.month}, dia ${siteLead.day || "?"}, ${siteLead.guests} convidados` } }]
      : [...l, { who: "cliente", reply: { kind: "text", text: m } }]);
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("ai-simulator", { body: { action: "chat", company_id: companyId, message: m, state, site_lead: siteLead } });
      let err: string | undefined = data?.error;
      if (error && !err) {
        try { err = (await (error as { context?: Response }).context?.json())?.error; } catch { /* genérica */ }
        err = err || error.message;
      }
      if (err) throw new Error(err);
      setState(data.state);
      setLeft(typeof data.left === "number" ? data.left : null);
      const replies = (data.replies || []) as Reply[];
      setLines((l) => [
        ...l,
        ...(replies.length ? replies.map((r) => ({ who: "ia" as const, reply: r })) : [{ who: "aviso" as const, reply: { kind: "text" as const, text: "A IA não respondeu essa mensagem." } }]),
        ...(data.handoff ? [{ who: "aviso" as const, reply: { kind: "text" as const, text: "Aqui a IA passaria a conversa para a sua equipe." } }] : []),
      ]);
    } catch (e) {
      setLines((l) => [...l, { who: "aviso", reply: { kind: "text", text: e instanceof Error ? e.message : String(e) } }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* No celular ocupa a tela toda (o teclado não empurra a janela) */}
      <DialogContent className="flex h-[100dvh] max-h-[100dvh] w-full max-w-md flex-col gap-0 rounded-none p-0 sm:h-[85vh] sm:rounded-lg">
        <DialogHeader className="border-b p-4 text-left">
          <DialogTitle>Testar a minha IA</DialogTitle>
          <p className="text-xs text-muted-foreground">Escreva como se fosse um cliente. É só um teste: nada vai para o WhatsApp e nada fica gravado.</p>
        </DialogHeader>

        <div className="flex-1 space-y-2 overflow-y-auto bg-muted/30 p-3">
          {lines.length === 0 && mode === "escolher" && (
            <div className="space-y-2 pt-2">
              <p className="text-center text-xs text-muted-foreground">Como o cliente chegou?</p>
              <button type="button" onClick={() => setMode("site")} className="flex w-full items-start gap-3 rounded-xl border bg-background p-3 text-left hover:border-primary">
                <Globe className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <span><span className="block text-sm font-medium">Veio pelo site</span><span className="text-xs text-muted-foreground">Respondeu mês, dia e convidados no site e a IA começa a conversa</span></span>
              </button>
              <button type="button" onClick={() => setMode("whatsapp")} className="flex w-full items-start gap-3 rounded-xl border bg-background p-3 text-left hover:border-primary">
                <MessageCircle className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
                <span><span className="block text-sm font-medium">Mandou mensagem no WhatsApp</span><span className="text-xs text-muted-foreground">O cliente escreve primeiro (de anúncio, Instagram, indicação)</span></span>
              </button>
            </div>
          )}
          {lines.length === 0 && mode === "site" && (
            <form className="space-y-2 rounded-xl border bg-background p-3" onSubmit={(e) => {
              e.preventDefault();
              send("", { name: site.name.trim() || "Cliente", month: site.month || months[1], day: Number(site.day) || null, guests: site.guests.trim() || "50" });
            }}>
              <p className="text-sm font-medium">O que o cliente respondeu no site</p>
              <input value={site.name} onChange={(e) => setSite({ ...site, name: e.target.value })} placeholder="Nome" aria-label="Nome"
                className="w-full rounded-lg border bg-muted px-3 py-2 text-base" />
              <div className="grid grid-cols-[1fr_72px] gap-2">
                <select value={site.month || months[1]} onChange={(e) => setSite({ ...site, month: e.target.value })} aria-label="Mês"
                  className="w-full rounded-lg border bg-muted px-2 py-2 text-base">
                  {months.map((m) => <option key={m} value={m}>{m.replace("/", " de 20")}</option>)}
                </select>
                <input value={site.day} onChange={(e) => setSite({ ...site, day: e.target.value.replace(/\D/g, "").slice(0, 2) })} inputMode="numeric" placeholder="Dia" aria-label="Dia"
                  className="w-full rounded-lg border bg-muted px-3 py-2 text-base" />
              </div>
              <input value={site.guests} onChange={(e) => setSite({ ...site, guests: e.target.value })} placeholder="Convidados (ex.: 70)" aria-label="Convidados"
                className="w-full rounded-lg border bg-muted px-3 py-2 text-base" />
              <div className="flex gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setMode("escolher")}>Voltar</Button>
                <Button type="submit" size="sm" className="flex-1" disabled={busy}>Enviar pelo site</Button>
              </div>
            </form>
          )}
          {lines.length === 0 && mode === "whatsapp" && (
            <div className="space-y-2 pt-2">
              <p className="text-center text-xs text-muted-foreground">Escreva a primeira mensagem do cliente ou toque numa ideia:</p>
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => send(s)} className="block w-full rounded-xl border bg-background px-3 py-2 text-left text-sm hover:border-primary">
                  {s}
                </button>
              ))}
            </div>
          )}
          {lines.map((l, i) => (
            <div key={i} className={cn("flex", l.who === "cliente" ? "justify-end" : l.who === "aviso" ? "justify-center" : "justify-start")}>
              {l.who === "aviso" ? (
                <p className="rounded-lg bg-amber-500/15 px-3 py-1.5 text-center text-xs text-amber-800 dark:text-amber-300">{l.reply.text}</p>
              ) : (
                <div className={cn("max-w-[85%] whitespace-pre-line rounded-2xl px-3 py-2 text-sm",
                  l.who === "cliente" ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-background shadow-sm")}>
                  {l.reply.kind === "image" && l.reply.mediaUrl && <img src={l.reply.mediaUrl} alt="" className="mb-1 max-h-48 rounded-lg object-cover" />}
                  {l.reply.kind === "video" && <p className="mb-1 text-xs text-muted-foreground">🎬 [vídeo do buffet]</p>}
                  {l.reply.kind === "document" && (
                    <a href={l.reply.mediaUrl} target="_blank" rel="noopener noreferrer" className="mb-1 flex items-center gap-1.5 text-xs underline">
                      <FileText className="h-4 w-4" /> {l.reply.fileName || "PDF"}
                    </a>
                  )}
                  {l.reply.text}
                  {canTeach && l.who === "ia" && l.reply.text.trim() && (
                    <button
                      type="button"
                      onClick={() => setTeach({ cliente: [...lines.slice(0, i)].reverse().find((x) => x.who === "cliente")?.reply.text || null, resposta: l.reply.text })}
                      className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                    >
                      <GraduationCap className="h-3 w-3" /> Corrigir
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {busy && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> A IA está escrevendo…</div>}
          <div ref={endRef} />
        </div>

        <div className="space-y-2 border-t p-3">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); send(text); }}>
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={600} enterKeyHint="send" placeholder="Mensagem do cliente"
              className="min-w-0 flex-1 rounded-full border bg-muted px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-primary" />
            <Button type="submit" size="icon" className="shrink-0 rounded-full" disabled={busy || !text.trim()} aria-label="Enviar"><Send className="h-4 w-4" /></Button>
          </form>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{left !== null ? `${left} mensagem(ns) restante(s) neste teste` : "Até 20 mensagens por teste"}</span>
            {lines.length > 0 && <button type="button" onClick={reset} className="flex items-center gap-1 hover:text-foreground"><RotateCcw className="h-3 w-3" /> Começar de novo</button>}
          </div>
        </div>
      </DialogContent>
      <AiTeachDialog open={!!teach} onOpenChange={(v) => !v && setTeach(null)} companyId={companyId} context={teach} onSaved={onTaught} />
    </Dialog>
  );
}
