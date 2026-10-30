import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, Check, GraduationCap, Loader2, Mic, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";

/** A resposta do teste que o dono quer corrigir (vazio = "Ensinar a IA" livre) */
export interface TeachContext {
  cliente?: string | null;
  resposta?: string | null;
  /** motivo da passagem para a equipe ("O que a IA passou para a equipe") */
  motivo?: string | null;
  /** de onde veio o ensinamento (ai_owner_notes.source); padrão: teste ou ensinar */
  source?: string | null;
}

interface Note {
  text: string;
  kind: "orientacao" | "informacao";
}

async function invokeTeach<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("ai-teach", { body });
  let err: string | undefined = data?.error;
  if (error && !err) {
    try { err = (await (error as { context?: Response }).context?.json())?.error; } catch { /* genérica */ }
    err = err || error.message;
  }
  if (err) throw new Error(err);
  return data as T;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]+,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * "Ensinar a IA": o dono escreve ou grava o que a IA deve fazer diferente; a IA
 * organiza em orientações curtas, ele revisa e confirma. Só então grava
 * (ai_owner_notes) — e a IA passa a seguir, no teste e com os clientes.
 */
export function AiTeachDialog({ open, onOpenChange, companyId, context, onSaved }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  companyId: string;
  context?: TeachContext | null;
  onSaved?: () => void;
}) {
  const [text, setText] = useState("");
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [packageHint, setPackageHint] = useState(false);
  const [visitHint, setVisitHint] = useState(false);
  const [busy, setBusy] = useState<"" | "audio" | "organizar" | "salvar">("");
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  useEffect(() => {
    if (!open) return;
    setText("");
    setNotes(null);
    setBlocked(null);
    setPackageHint(false);
    setVisitHint(false);
  }, [open, context]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ["audio/webm", "audio/mp4", "audio/ogg"].find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(t));
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: rec.mimeType || type || "audio/webm" });
        setBusy("audio");
        try {
          const r = await invokeTeach<{ text: string }>({ action: "transcribe", company_id: companyId, audio_base64: await blobToBase64(blob), mime: blob.type });
          setText((t) => (t.trim() ? `${t.trim()}\n${r.text}` : r.text));
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Não consegui transcrever o áudio");
        } finally {
          setBusy("");
        }
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      toast.error("Não consegui usar o microfone — libere o acesso no navegador ou escreva");
    }
  };

  const stopRecording = () => {
    recorder.current?.stop();
    recorder.current = null;
    setRecording(false);
  };

  const organize = async () => {
    if (text.trim().length < 3) return;
    setBusy("organizar");
    try {
      const p = await invokeTeach<{ notes: Note[]; blocked: string | null; packageHint: boolean; visitHint?: boolean }>({
        action: "propose", company_id: companyId, text, cliente: context?.cliente || null, resposta: context?.resposta || null, motivo: context?.motivo || null,
      });
      setNotes(p.notes);
      setBlocked(p.blocked);
      setPackageHint(p.packageHint);
      setVisitHint(p.visitHint === true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui organizar");
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    const list = (notes || []).map((n) => ({ ...n, text: n.text.trim() })).filter((n) => n.text.length >= 3);
    if (list.length === 0) return;
    setBusy("salvar");
    const { data: auth } = await supabase.auth.getUser();
    const { error } = await (supabase as any).from("ai_owner_notes").insert(list.map((n) => ({
      company_id: companyId, text: n.text, kind: n.kind, source: context?.source || (context ? "teste" : "ensinar"), created_by: auth?.user?.id || null,
    })));
    setBusy("");
    if (error) {
      toast.error("Não consegui salvar — tente de novo");
      return;
    }
    toast.success("Pronto! A IA já aprendeu. Teste de novo para ver 😉");
    onSaved?.();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && !recording && onOpenChange(v)}>
      <DialogContent className="max-h-[92dvh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><GraduationCap className="h-5 w-5 text-primary" /> {context?.resposta ? "Corrigir esta resposta" : "Ensinar a IA"}</DialogTitle>
        </DialogHeader>

        {context?.motivo && (
          <div className="rounded-lg bg-muted/60 p-2.5 text-xs text-muted-foreground">
            <p className="mb-1 font-medium text-foreground">A IA passou para a equipe porque:</p>
            <p className="line-clamp-5 whitespace-pre-line">{context.motivo}</p>
          </div>
        )}

        {context?.resposta && (
          <div className="rounded-lg bg-muted/60 p-2.5 text-xs text-muted-foreground">
            <p className="mb-1 font-medium text-foreground">Resposta da IA:</p>
            <p className="line-clamp-5 whitespace-pre-line">{context.resposta}</p>
          </div>
        )}

        {notes === null ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {context?.resposta ? "Escreva ou grave como ela deveria ter respondido, ou o que estava errado." : context?.motivo ? "Escreva ou grave a resposta para essa dúvida, como você explicaria para o cliente." : "Escreva ou grave o que a IA deve saber ou fazer diferente no seu buffet."}
            </p>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              maxLength={3000}
              placeholder='Ex.: "A decoração não vem no Classic, só no Premium. E não chame para visita em toda mensagem."'
              className="resize-none text-base sm:text-sm"
            />
            <div className="flex gap-2">
              <Button type="button" variant={recording ? "destructive" : "outline"} onClick={recording ? stopRecording : startRecording} disabled={!!busy} className="gap-1.5">
                {busy === "audio" ? <Loader2 className="h-4 w-4 animate-spin" /> : recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                {busy === "audio" ? "Ouvindo…" : recording ? "Parar" : "Falar"}
              </Button>
              <Button type="button" className="flex-1 gap-1.5" onClick={organize} disabled={!!busy || recording || text.trim().length < 3}>
                {busy === "organizar" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Continuar
              </Button>
            </div>
            {recording && <p className="text-xs text-destructive">Gravando… fale e toque em "Parar" quando terminar.</p>}
          </div>
        ) : (
          <div className="space-y-3">
            {blocked && (
              <p className="flex gap-2 rounded-lg bg-amber-500/15 p-2.5 text-xs text-amber-900 dark:text-amber-200">
                <AlertTriangle className="h-4 w-4 shrink-0" /> {blocked}
              </p>
            )}
            {visitHint && (
              <p className="rounded-lg bg-primary/10 p-2.5 text-xs">
                Para a IA não marcar visitas, use a opção certa: <strong>Configurações → Inteligência Artificial → Apresentação e horários → Quem marca as visitas → A equipe marca</strong>. Ela funciona sempre, sem precisar ensinar.
              </p>
            )}
            {notes.length > 0 ? (
              <>
                <p className="text-sm font-medium">A IA vai seguir isto:</p>
                {notes.map((n, i) => (
                  <div key={i} className="flex gap-2">
                    <Textarea
                      value={n.text}
                      onChange={(e) => setNotes((l) => l!.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                      rows={2}
                      className="resize-none text-base sm:text-sm"
                    />
                    <Button type="button" variant="ghost" size="icon" className="shrink-0" aria-label="Tirar" onClick={() => setNotes((l) => l!.filter((_, j) => j !== i))}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                {packageHint && (
                  <p className="text-xs text-muted-foreground">
                    Dica: isso é sobre o que um pacote inclui. Vale também acertar em <strong>Operações → Pacotes</strong>, para o PDF e a equipe ficarem iguais.
                  </p>
                )}
              </>
            ) : (
              !blocked && <p className="text-sm text-muted-foreground">Não encontrei nada novo para ensinar. Tente explicar de outro jeito.</p>
            )}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setNotes(null)} disabled={!!busy}>Voltar</Button>
              <Button type="button" className="flex-1 gap-1.5" onClick={save} disabled={!!busy || notes.every((n) => n.text.trim().length < 3)}>
                {busy === "salvar" ? <Loader2 className="h-4 w-4 animate-spin" /> : <GraduationCap className="h-4 w-4" />} Ensinar a IA
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
