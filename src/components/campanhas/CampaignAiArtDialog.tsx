// "Criar arte com IA": a pessoa descreve o tema (como pediria no ChatGPT) e a
// IA devolve a arte pronta, com o texto e o logo. Depois dá para pedir
// ajustes ("deixa o fundo azul") ou voltar para uma versão anterior.

import { useEffect, useState } from "react";
import { Check, ImagePlus, Loader2, PenLine, RefreshCw, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

const IDEAS = [
  "Festa neon com luzes coloridas",
  "Princesas e castelo encantado",
  "Super-heróis em ação",
  "Fundo do mar",
  "Natal mágico",
  "Halloween divertido",
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  companyName: string;
  logoUrl?: string | null;
  defaultIdea: string;
  defaultText: string;
  onUse: (url: string) => void;
  onManual: () => void;
}

export function CampaignAiArtDialog({ open, onOpenChange, companyId, companyName, logoUrl, defaultIdea, defaultText, onUse, onManual }: Props) {
  const [idea, setIdea] = useState(defaultIdea);
  const [artText, setArtText] = useState(defaultText);
  const [useLogo, setUseLogo] = useState(!!logoUrl);
  const [photo, setPhoto] = useState<string | null>(null);
  const [photos, setPhotos] = useState<string[] | null>(null);
  const [showPhotos, setShowPhotos] = useState(false);
  const [versions, setVersions] = useState<string[]>([]);
  const [current, setCurrent] = useState(0);
  const [adjust, setAdjust] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!open) return;
    setIdea((v) => v || defaultIdea);
    setArtText((v) => v || defaultText);
  }, [open, defaultIdea, defaultText]);

  useEffect(() => {
    if (!busy) return;
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => { clearInterval(t); setElapsed(0); };
  }, [busy]);

  const loadPhotos = async () => {
    setShowPhotos((v) => !v);
    if (photos) return;
    const { data } = await supabase
      .from("sales_materials")
      .select("photo_urls")
      .eq("company_id", companyId)
      .eq("is_active", true);
    setPhotos(((data || []) as Array<{ photo_urls: string[] | null }>).flatMap((m) => m.photo_urls || []).filter(Boolean));
  };

  const uploadPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const path = `campaigns/${Date.now()}.${file.name.split(".").pop()}`;
    const { error } = await supabase.storage.from("sales-materials").upload(path, file);
    if (error) return toast.error("Não consegui enviar a foto");
    setPhoto(supabase.storage.from("sales-materials").getPublicUrl(path).data.publicUrl);
  };

  const run = async (mode: "new" | "adjust") => {
    if (mode === "new" && !idea.trim()) return toast.error("Descreva a arte que você quer");
    if (mode === "adjust" && !adjust.trim()) return toast.error("Escreva o que quer mudar");
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("campaign-image", {
        body: {
          generation_mode: "gpt",
          company_id: companyId,
          company_name: companyName,
          idea,
          art_text: artText,
          logo_url: useLogo ? logoUrl : null,
          photo_url: mode === "new" ? photo : null,
          ...(mode === "adjust" ? { adjust, previous_url: versions[current] } : {}),
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (!data?.url) throw new Error("A IA não devolveu a arte");
      setVersions((v) => [...v, data.url]);
      setCurrent(versions.length);
      setAdjust("");
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : "Não consegui criar a arte");
    } finally {
      setBusy(false);
    }
  };

  const shown = versions[current];

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-lg max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="w-5 h-5 text-primary" /> Criar arte com IA
          </DialogTitle>
        </DialogHeader>

        {busy && (
          <div className="rounded-xl border bg-muted/30 p-6 text-center space-y-2">
            <Loader2 className="w-6 h-6 animate-spin mx-auto text-primary" />
            <p className="text-sm font-medium">A IA está desenhando sua arte... {elapsed}s</p>
            <p className="text-xs text-muted-foreground">Leva por volta de 1 minuto. Não feche esta janela.</p>
          </div>
        )}

        {!busy && shown && (
          <div className="space-y-3">
            <img src={shown} alt="Arte criada" className="w-full rounded-xl border shadow-sm" />
            {versions.length > 1 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {versions.map((v, i) => (
                  <button key={v} type="button" onClick={() => setCurrent(i)} className={`shrink-0 rounded-md border-2 ${i === current ? "border-primary" : "border-transparent opacity-70"}`}>
                    <img src={v} alt={`Versão ${i + 1}`} className="h-14 w-14 rounded object-cover" />
                  </button>
                ))}
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">Quer mudar algo?</Label>
              <div className="flex gap-2">
                <Input
                  value={adjust}
                  onChange={(e) => setAdjust(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && run("adjust")}
                  placeholder='Ex.: "fundo azul", "letras maiores", "mais balões"'
                />
                <Button variant="outline" onClick={() => run("adjust")} disabled={!adjust.trim()} className="shrink-0 gap-1.5">
                  <RefreshCw className="w-3.5 h-3.5" /> Ajustar
                </Button>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Button className="flex-1 gap-1.5" onClick={() => { onUse(shown); onOpenChange(false); }}>
                <Check className="w-4 h-4" /> Usar esta arte
              </Button>
              <Button variant="ghost" className="flex-1 gap-1.5" onClick={() => run("new")}>
                <Sparkles className="w-4 h-4" /> Criar outra
              </Button>
            </div>
          </div>
        )}

        {!busy && (
          <div className={`space-y-4 ${shown ? "border-t pt-4" : ""}`}>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Como você imagina a arte?</Label>
              <Textarea
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                rows={3}
                className="resize-none"
                placeholder="Ex.: Arte alegre de festa infantil com balões coloridos, avisando que ainda temos datas em novembro"
              />
              <div className="flex flex-wrap gap-1.5">
                {IDEAS.map((i) => (
                  <button key={i} type="button" onClick={() => setIdea(i)} className="rounded-full border px-2.5 py-1 text-[11px] hover:border-primary hover:bg-primary/5">
                    {i}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Texto que aparece na arte</Label>
              <Input value={artText} onChange={(e) => setArtText(e.target.value)} placeholder="Ex.: Datas livres em Novembro" />
              <p className="text-[11px] text-muted-foreground">Curto funciona melhor (até umas 6 palavras). Deixe vazio para arte sem texto.</p>
            </div>

            {logoUrl && (
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox checked={useLogo} onCheckedChange={(v) => setUseLogo(!!v)} />
                Colocar o logo do buffet
                <img src={logoUrl} alt="" className="h-6 w-6 rounded object-contain" />
              </label>
            )}

            <div className="space-y-2">
              <button type="button" onClick={loadPhotos} className="text-xs font-medium text-primary hover:underline">
                {photo ? "✓ Usando uma foto do buffet (trocar)" : "+ Usar uma foto real do buffet (opcional)"}
              </button>
              {showPhotos && (
                <div className="space-y-2">
                  {photos === null ? (
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                  ) : (
                    <div className="grid grid-cols-4 gap-1.5">
                      {photos.map((p) => (
                        <button key={p} type="button" onClick={() => setPhoto(photo === p ? null : p)} className={`rounded-md border-2 overflow-hidden ${photo === p ? "border-primary" : "border-transparent"}`}>
                          <img src={p} alt="" className="h-16 w-full object-cover" />
                        </button>
                      ))}
                    </div>
                  )}
                  <label className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed p-2 text-xs text-muted-foreground cursor-pointer hover:bg-muted/50">
                    <ImagePlus className="w-3.5 h-3.5" /> Enviar outra foto
                    <input type="file" accept="image/*" className="hidden" onChange={uploadPhoto} />
                  </label>
                </div>
              )}
            </div>

            {!shown && (
              <Button className="w-full h-11 gap-2" onClick={() => run("new")} disabled={!idea.trim()}>
                <Sparkles className="w-4 h-4" /> Criar arte
              </Button>
            )}
            <button type="button" onClick={() => { onOpenChange(false); onManual(); }} className="w-full text-center text-[11px] text-muted-foreground hover:underline flex items-center justify-center gap-1">
              <PenLine className="w-3 h-3" /> Prefiro montar à mão em cima de uma foto
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
