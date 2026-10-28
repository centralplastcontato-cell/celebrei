import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCompany } from "@/contexts/CompanyContext";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Loader2, Sparkles, RefreshCw, Pencil, ImagePlus, ZoomIn, Trash2, Building2, Image, Wand2, Type, Palette, PenLine, X, ChevronLeft, ChevronRight } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CampaignTextOverlayEditor } from "./CampaignTextOverlayEditor";
import { CampaignAiArtDialog } from "./CampaignAiArtDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import type { CampaignDraft } from "./CampaignWizard";
import { MANUAL_TONE, mergeGenerated } from "@/lib/campaignMessages";
import { getPreset } from "@/lib/campaignPresets";

interface Props {
  draft: CampaignDraft;
  setDraft: React.Dispatch<React.SetStateAction<CampaignDraft>>;
  companyName: string;
}

const CAMPAIGN_TYPE_OPTIONS = [
  { group: "Datas Comemorativas", items: [
    { value: "Esquenta de Carnaval", description: "Promoção pré-carnaval com descontos e convidados extras para festas realizadas no período." },
    { value: "Volta às Aulas", description: "Aproveitar o período de volta às aulas para promover festas de aniversário com condições facilitadas." },
    { value: "Dia das Mães", description: "Homenagem ao Dia das Mães com condições especiais para mamães que querem celebrar com os filhos." },
    { value: "Dia dos Pais", description: "Promoção especial de Dia dos Pais com pacotes família e descontos para festas no período." },
    { value: "Férias de Julho", description: "Promoção especial para festas nas férias de julho, com pacotes temáticos e preços promocionais." },
    { value: "Mês das Crianças", description: "Campanha especial de Dia das Crianças com pacotes promocionais e brindes para aniversariantes do período." },
    { value: "Black Friday", description: "Descontos imperdíveis de Black Friday em todos os pacotes de festa infantil por tempo limitado." },
    { value: "Natal Mágico", description: "Pacotes especiais de Natal com decoração temática e condições exclusivas para festas no período natalino." },
    { value: "Promoção de Natal", description: "Promoção de fim de ano com descontos progressivos e brindes para quem fechar festa em dezembro." },
  ]},
  { group: "Sazonais", items: [
    { value: "Liquidação de Verão", description: "Liquidação de verão com os melhores preços do ano em pacotes de festa infantil." },
    { value: "Especial Primavera", description: "Promoção de primavera com pacotes floridos, decoração temática e preços especiais." },
    { value: "Feriado Prolongado", description: "Aproveite o feriado prolongado para garantir sua festa com desconto especial e vagas limitadas." },
  ]},
  { group: "Promoções Genéricas", items: [
    { value: "Mês do Consumidor", description: "Aproveitar o mês do consumidor para oferecer condições especiais em pacotes de festa infantil com descontos exclusivos." },
    { value: "Semana do Cliente", description: "Semana exclusiva para clientes com ofertas especiais, upgrades de pacote e brindes." },
    { value: "Promo Aniversário", description: "Comemore o aniversário do buffet com descontos exclusivos e brindes para os primeiros contratos." },
    { value: "Super Promoção", description: "Super promoção com desconto especial, convidados extras e condições imperdíveis por tempo limitado." },
    { value: "Festival de Descontos", description: "Festival de descontos com até 15% off em pacotes selecionados para festas nos próximos meses." },
  ]},
  { group: "Urgência e Escassez", items: [
    { value: "Oportunidade Relâmpago", description: "Promoção relâmpago com vagas limitadas e desconto agressivo para fechar contratos esta semana." },
    { value: "Últimos Contratos", description: "Últimas vagas disponíveis no mês, urgência para fechar os contratos restantes com condições diferenciadas." },
    { value: "Última Chance", description: "Última oportunidade de garantir sua festa com as condições promocionais antes do reajuste." },
    { value: "Queima de Estoque", description: "Queima de datas disponíveis com descontos agressivos para fechar o calendário do mês." },
    { value: "Fecha em 25", description: "Condição exclusiva para quem fechar contrato com entrada de apenas R$25 por convidado." },
    { value: "Lote Promocional", description: "Lote promocional com quantidade limitada de vagas com desconto especial para os primeiros." },
  ]},
  { group: "Reengajamento", items: [
    { value: "Convite Especial", description: "Convite personalizado para leads selecionados com oferta exclusiva e prazo curto." },
    { value: "Reativação de Leads", description: "Reativar leads antigos com uma oferta irresistível para quem já demonstrou interesse anteriormente." },
  ]},
];

const ART_THEME_PRESETS = [
  { value: "Festa Neon", emoji: "🌈" },
  { value: "Princesas", emoji: "👑" },
  { value: "Super-heróis", emoji: "🦸" },
  { value: "Safari / Animais", emoji: "🦁" },
  { value: "Fundo do Mar", emoji: "🐠" },
  { value: "Circo", emoji: "🎪" },
  { value: "Unicórnio", emoji: "🦄" },
  { value: "Espaço / Astronauta", emoji: "🚀" },
  { value: "Dinossauros", emoji: "🦕" },
  { value: "Festa Junina", emoji: "🌽" },
  { value: "Fazendinha", emoji: "🐔" },
  { value: "Doces / Candy", emoji: "🍭" },
  { value: "Futebol", emoji: "⚽" },
  { value: "Balada Teen", emoji: "🎧" },
  { value: "Tropical / Havaí", emoji: "🌺" },
];

const TONE_LABELS: Record<string, string> = {
  profissional: "🏢 Profissional",
  "amigável": "😊 Amigável",
  urgente: "⏰ Urgente",
  curta: "⚡ Curta",
  detalhada: "📝 Detalhada",
  [MANUAL_TONE]: "✍️ Escrita por você",
};

export function CampaignContextStep({ draft, setDraft, companyName }: Props) {
  const { currentCompanyId, currentCompany } = useCompany();
  const [generating, setGenerating] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [viewIndex, setViewIndex] = useState(0);
  const [showGoal, setShowGoal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [composing, setComposing] = useState(false);
  const [composeElapsed, setComposeElapsed] = useState(0);
  const [includeLogo, setIncludeLogo] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [artDialogOpen, setArtDialogOpen] = useState(false);
  const [aiArtOpen, setAiArtOpen] = useState(false);
  const [buffetPhotos, setBuffetPhotos] = useState<string[]>([]);
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  const [logoPosition, setLogoPosition] = useState<string>("bottom-right");
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);
  const [textEditorOpen, setTextEditorOpen] = useState(false);
  const [pendingArtUrl, setPendingArtUrl] = useState<string | null>(null);
  const [showArtReadyBanner, setShowArtReadyBanner] = useState(false);
  const [artMode, setArtMode] = useState<"photo" | "theme">("photo");
  const [themeText, setThemeText] = useState("");

  // Timer for composing elapsed
  useEffect(() => {
    if (!composing) {
      setComposeElapsed(0);
      return;
    }
    const start = Date.now();
    const interval = setInterval(() => {
      setComposeElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [composing]);

  // Campanha pronta: a IA já escreve as mensagens ao abrir (uma vez)
  const preset = getPreset(draft.presetId);
  const autoGenerated = useRef(false);
  useEffect(() => {
    if (!preset || autoGenerated.current || draft.variations.length > 0 || !draft.description.trim()) return;
    autoGenerated.current = true;
    handleGenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  const handleGenerate = async () => {
    if (!draft.description.trim()) {
      toast.error("Descreva o objetivo da campanha");
      return;
    }
    setGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke("campaign-ai", {
        body: { context: draft.description, companyName, company_id: currentCompanyId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      // As mensagens escritas à mão continuam; só as da IA são trocadas
      setDraft((prev) => ({ ...prev, variations: mergeGenerated(prev.variations, data.variations || []) }));
      setEditingIndex(null);
      setViewIndex(0);
      toast.success("5 mensagens escritas pela IA!");
    } catch (err: any) {
      console.error("campaign-ai error:", err);
      toast.error(err.message || "Erro ao gerar variações");
    } finally {
      setGenerating(false);
    }
  };

  const saveImageToGallery = async (imageUrl: string, source: string) => {
    try {
      const { data: user } = await supabase.auth.getUser();
      if (!user?.user?.id || !currentCompanyId) return;
      const { data: insertedRow } = await (supabase as any).from("campaign_images").insert({
        company_id: currentCompanyId,
        image_url: imageUrl,
        source,
        campaign_name: draft.campaignType || draft.name || null,
        created_by: user.user.id,
      }).select("id").single();

      // Generate thumbnail in background
      if (insertedRow?.id) {
        supabase.functions.invoke("resize-image", {
          body: { image_url: imageUrl, company_id: currentCompanyId },
        }).then(({ data: thumbData }) => {
          if (thumbData?.thumbnail_url) {
            (supabase as any).from("campaign_images")
              .update({ thumbnail_url: thumbData.thumbnail_url })
              .eq("id", insertedRow.id);
          }
        }).catch((err: any) => console.error("Thumbnail generation failed:", err));
      }
    } catch (err) {
      console.error("Error saving image to gallery:", err);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const ext = file.name.split(".").pop();
      const path = `campaigns/${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from("sales-materials").upload(path, file);
      if (error) throw error;
      const { data: urlData } = supabase.storage.from("sales-materials").getPublicUrl(path);
      setDraft((prev) => ({ ...prev, imageUrl: urlData.publicUrl }));
      await saveImageToGallery(urlData.publicUrl, "upload");
      toast.success("Imagem carregada!");
    } catch (err: any) {
      toast.error("Erro no upload: " + err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleUploadForArt = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const ext = file.name.split(".").pop();
      const path = `campaigns/${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from("sales-materials").upload(path, file);
      if (error) throw error;
      const { data: urlData } = supabase.storage.from("sales-materials").getPublicUrl(path);
      setSelectedPhoto(urlData.publicUrl);
      toast.success("Foto carregada!");
    } catch (err: any) {
      toast.error("Erro no upload: " + err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleUseLogo = async () => {
    if (currentCompany?.logo_url) {
      setDraft((prev) => ({ ...prev, imageUrl: currentCompany.logo_url }));
      await saveImageToGallery(currentCompany.logo_url, "logo");
      toast.success("Logotipo aplicado!");
    }
  };

  const handleOpenArtDialog = async () => {
    setArtDialogOpen(true);
    setSelectedPhoto(null);
    setLoadingPhotos(true);
    try {
      const { data, error } = await supabase
        .from("sales_materials")
        .select("id, name, photo_urls")
        .eq("company_id", currentCompanyId!)
        .eq("is_active", true);
      if (error) throw error;

      const allPhotos: string[] = [];
      (data || []).forEach((m: any) => {
        if (Array.isArray(m.photo_urls)) {
          m.photo_urls.forEach((url: string) => {
            if (url) allPhotos.push(url);
          });
        }
      });
      setBuffetPhotos(allPhotos);
    } catch (err: any) {
      toast.error("Erro ao carregar fotos");
    } finally {
      setLoadingPhotos(false);
    }
  };

  const handleComposeArt = async () => {
    const isThemeMode = artMode === "theme";
    
    if (!isThemeMode && !selectedPhoto) {
      toast.error("Selecione uma foto base primeiro");
      return;
    }
    // Com foto: a foto do buffet é a base e a pessoa põe texto e logo no editor.
    // (Antes ia para a IA, que ignorava a foto e inventava outra imagem.)
    if (!isThemeMode && selectedPhoto) {
      setPendingArtUrl(selectedPhoto);
      setArtDialogOpen(false);
      setTextEditorOpen(true);
      return;
    }
    if (isThemeMode && !themeText.trim() && !draft.campaignType) {
      toast.error("Selecione ou descreva um tema");
      return;
    }

    setComposing(true);
    try {
      const { data, error } = await supabase.functions.invoke("campaign-image", {
        body: {
          base_image_url: isThemeMode ? null : selectedPhoto,
          logo_url: includeLogo && currentCompany?.logo_url ? currentCompany.logo_url : null,
          company_id: currentCompanyId,
          position: logoPosition,
          campaign_theme: themeText.trim() || draft.campaignType || draft.name || null,
          context: draft.description || null,
          generation_mode: "theme_only",
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (!data?.url) throw new Error("Nenhuma imagem retornada");

      // Open text overlay editor instead of saving directly
      setPendingArtUrl(data.url);
      setArtDialogOpen(false);
      setShowArtReadyBanner(true);
      setTimeout(() => {
        setShowArtReadyBanner(false);
        setTextEditorOpen(true);
      }, 5000);
    } catch (err: any) {
      console.error("campaign-image error:", err);
      toast.error(err.message || "Erro ao criar arte");
    } finally {
      setComposing(false);
    }
  };

  const handleTextEditorSave = async (finalUrl: string) => {
    setDraft((prev) => ({ ...prev, imageUrl: finalUrl }));
    const fromPhoto = pendingArtUrl !== null && buffetPhotos.includes(pendingArtUrl);
    const source = fromPhoto ? "photo_text" : finalUrl === pendingArtUrl ? "ai_compose" : "ai_compose_text";
    await saveImageToGallery(finalUrl, source);
    setPendingArtUrl(null);
    toast.success("Arte salva com sucesso! 🎨");
  };

  const saveEdit = (index: number) => {
    if (!editText.trim()) {
      removeVariation(index);
      return;
    }
    setDraft((prev) => {
      const v = [...prev.variations];
      v[index] = { ...v[index], text: editText };
      return { ...prev, variations: v };
    });
    setEditingIndex(null);
  };

  // Mensagem escrita pela própria pessoa, sem IA
  const addManualVariation = () => {
    setDraft((prev) => ({ ...prev, variations: [...prev.variations, { tone: MANUAL_TONE, text: "" }] }));
    setEditingIndex(draft.variations.length);
    setViewIndex(draft.variations.length);
    setEditText("");
  };

  const removeVariation = (index: number) => {
    setDraft((prev) => ({ ...prev, variations: prev.variations.filter((_, i) => i !== index) }));
    setEditingIndex(null);
  };

  const cancelEdit = (index: number) => {
    // Mensagem nova que ficou vazia: some
    if (!draft.variations[index]?.text.trim()) removeVariation(index);
    else setEditingIndex(null);
  };

  const aiCount = draft.variations.filter((v) => v.tone !== MANUAL_TONE).length;
  const total = draft.variations.length;
  const current = Math.min(viewIndex, Math.max(total - 1, 0));
  const shown = draft.variations[current];
  const previewText = (text: string) =>
    text.replace(/\{nome\}/gi, "Maria").replace(/\{empresa\}/gi, companyName || "seu buffet");

  // Tela em 3 passos: o que avisar → mensagens (prévia como no WhatsApp,
  // uma por vez) → imagem. Antes: o pedido técnico para a IA aparecia
  // aberto, as mensagens ficavam numa caixa com rolagem dentro da rolagem e
  // havia dois botões "Regenerar".
  return (
    <div className="space-y-6">
      {/* Título da campanha */}
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Título da campanha
        </Label>
        <Input
          placeholder="Ex: Promoção Abril 2026"
          value={draft.name}
          onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
          className="h-10"
        />
      </div>

      {/* 1. O que avisar */}
      <section className="space-y-2.5">
        <StepTitle n={1} title={preset ? "O que a campanha vai avisar" : "O que você quer avisar"} />
        {preset ? (
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 space-y-2">
            <p className="text-sm">
              <span className="mr-1.5">{preset.emoji}</span>
              <strong>{preset.title}</strong>{draft.presetMonth ? ` — ${draft.presetMonth}` : ""}
            </p>
            <p className="text-xs text-muted-foreground leading-snug">{preset.subtitle} A IA já sabe o que escrever.</p>
            <button
              type="button"
              onClick={() => setShowGoal((v) => !v)}
              className="text-xs font-medium text-primary hover:underline"
            >
              {showGoal ? "Esconder o pedido para a IA" : "Ver ou ajustar o pedido para a IA"}
            </button>
            {showGoal && (
              <Textarea
                value={draft.description}
                onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
                rows={6}
                className="resize-none bg-background text-sm"
              />
            )}
          </div>
        ) : (
          <>
            <Select
              value={draft.campaignType}
              onValueChange={(value) => {
                const allItems = CAMPAIGN_TYPE_OPTIONS.flatMap((g) => g.items);
                const match = allItems.find((item) => item.value === value);
                setDraft((prev) => ({
                  ...prev,
                  campaignType: value,
                  description: match?.description || prev.description,
                }));
              }}
            >
              <SelectTrigger className="h-10">
                <SelectValue placeholder="Escolha um tipo (opcional)..." />
              </SelectTrigger>
              <SelectContent>
                {CAMPAIGN_TYPE_OPTIONS.map((group) => (
                  <SelectGroup key={group.group}>
                    <SelectLabel>{group.group}</SelectLabel>
                    {group.items.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.value}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            <Textarea
              placeholder="Ex: Avisar que ainda temos sábados livres em abril e convidar para conhecer o espaço..."
              value={draft.description}
              onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
              rows={3}
              className="resize-none"
            />
          </>
        )}
      </section>

      {/* 2. Mensagens */}
      <section className="space-y-2.5">
        <StepTitle n={2} title="Mensagens" hint={total > 0 ? `Cada cliente recebe uma destas ${total}, em rodízio.` : undefined} />

        {total === 0 && generating && (
          <div className="rounded-xl border border-dashed p-6 text-center space-y-2">
            <Loader2 className="w-5 h-5 animate-spin mx-auto text-primary" />
            <p className="text-sm text-muted-foreground">A IA está escrevendo 5 mensagens...</p>
          </div>
        )}

        {total === 0 && !generating && (
          <div className="rounded-xl border border-dashed p-4 space-y-2">
            <Button onClick={handleGenerate} disabled={!draft.description.trim()} className="w-full h-10 gap-2">
              <Sparkles className="w-4 h-4" /> Escrever 5 mensagens com a IA
            </Button>
            <Button onClick={addManualVariation} variant="ghost" className="w-full h-9 gap-2 text-muted-foreground">
              <PenLine className="w-4 h-4" /> Prefiro escrever a minha
            </Button>
          </div>
        )}

        {total > 0 && shown && (
          <div className="rounded-xl border bg-muted/20 p-3 space-y-3">
            {/* Navegação */}
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" disabled={current === 0 || editingIndex !== null} onClick={() => setViewIndex(current - 1)} aria-label="Mensagem anterior">
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <div className="flex-1 text-center">
                <p className="text-sm font-semibold">Mensagem {current + 1} de {total}</p>
                <p className="text-[11px] text-muted-foreground">{TONE_LABELS[shown.tone] || shown.tone}</p>
              </div>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" disabled={current >= total - 1 || editingIndex !== null} onClick={() => setViewIndex(current + 1)} aria-label="Próxima mensagem">
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>

            {editingIndex === current ? (
              <div className="space-y-2">
                <Textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  rows={7}
                  autoFocus
                  placeholder="Oi {nome}! Aqui é da {empresa}..."
                  className="text-sm resize-none bg-background"
                />
                <p className="text-[11px] text-muted-foreground">
                  Use <strong>{"{nome}"}</strong> para o nome do cliente e <strong>{"{empresa}"}</strong> para o nome do buffet.
                </p>
                <div className="flex gap-1.5 justify-end">
                  <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => cancelEdit(current)}>Cancelar</Button>
                  <Button size="sm" className="h-8 text-xs" onClick={() => saveEdit(current)}>Salvar</Button>
                </div>
              </div>
            ) : (
              <>
                {/* Prévia como chega no WhatsApp */}
                <div className="rounded-lg bg-[#efeae2] dark:bg-zinc-900 p-3">
                  <div className="ml-auto max-w-[92%] rounded-lg rounded-tr-none bg-[#d9fdd3] dark:bg-emerald-900/60 p-1.5 shadow-sm">
                    {draft.imageUrl && (
                      <img src={draft.imageUrl} alt="" className="mb-1.5 max-h-48 w-full rounded-md object-cover" />
                    )}
                    <p className="whitespace-pre-wrap px-1.5 pb-1 text-sm leading-relaxed text-zinc-900 dark:text-zinc-100">{previewText(shown.text)}</p>
                  </div>
                </div>
                <div className="flex items-center justify-center gap-2">
                  <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => { setEditingIndex(current); setEditText(shown.text); }}>
                    <Pencil className="w-3 h-3" /> Editar
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs hover:text-destructive" onClick={() => removeVariation(current)}>
                    <X className="w-3.5 h-3.5" /> Não usar esta
                  </Button>
                </div>
              </>
            )}

            {/* Bolinhas */}
            {total > 1 && (
              <div className="flex justify-center gap-1.5">
                {draft.variations.map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    aria-label={`Ver mensagem ${i + 1}`}
                    disabled={editingIndex !== null}
                    onClick={() => setViewIndex(i)}
                    className={`h-2 rounded-full transition-all ${i === current ? "w-5 bg-primary" : "w-2 bg-muted-foreground/30"}`}
                  />
                ))}
              </div>
            )}
            <p className="text-[11px] text-center text-muted-foreground">Prévia com o nome de exemplo "Maria".</p>
          </div>
        )}

        {total > 0 && (
          <div className="flex flex-col sm:flex-row gap-2">
            <Button onClick={handleGenerate} disabled={generating || !draft.description.trim()} variant="outline" className="flex-1 h-9 gap-2 text-xs">
              {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              {aiCount > 0 ? "Pedir outras para a IA" : "Escrever 5 com a IA"}
            </Button>
            <Button
              onClick={addManualVariation}
              disabled={editingIndex !== null}
              variant="outline"
              className="flex-1 h-9 gap-2 text-xs"
            >
              <PenLine className="w-3.5 h-3.5" /> Escrever uma minha
            </Button>
          </div>
        )}
      </section>

      {/* 3. Imagem */}
      <section className="space-y-2.5">
        <StepTitle n={3} title="Imagem (opcional)" hint="Vai junto com a mensagem." />
        {draft.imageUrl ? (
          <div className="rounded-xl border border-border/60 bg-muted/10 shadow-sm overflow-hidden">
            {/* Preview row */}
            <div className="flex items-center gap-3 p-3">
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                className="relative group shrink-0 rounded-lg overflow-hidden border border-border/40 shadow-sm hover:shadow-md transition-all"
              >
                <img src={draft.imageUrl} alt="Campaign" className="h-16 w-24 object-contain bg-white" />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                  <ZoomIn className="w-4 h-4 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </button>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-foreground truncate">Imagem da campanha</p>
                <p className="text-[11px] text-muted-foreground">Clique para visualizar</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive shrink-0"
                onClick={() => setDraft((prev) => ({ ...prev, imageUrl: null }))}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
            {/* Action bar */}
            <div className="flex items-center border-t border-border/40 divide-x divide-border/40">
              <button
                type="button"
                className="flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                onClick={() => setAiArtOpen(true)}
              >
                <Wand2 className="w-3 h-3" />
                Criar Arte
              </button>
              <label className="flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer">
                <ImagePlus className="w-3 h-3" />
                Trocar
                <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} disabled={uploading} />
              </label>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Primary CTA: Criar Arte Profissional */}
            <Button
              type="button"
              className="w-full h-12 gap-2.5 text-sm font-semibold"
              onClick={() => setAiArtOpen(true)}
            >
              <Wand2 className="w-4.5 h-4.5" />
              Criar arte com IA
            </Button>

            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <div className="flex-1 h-px bg-border" />
              ou
              <div className="flex-1 h-px bg-border" />
            </div>

            <div className="flex gap-2">
              <label className="flex-1 flex items-center justify-center gap-2 p-2.5 border border-dashed rounded-lg cursor-pointer hover:bg-muted/50 hover:border-primary/30 transition-all text-xs text-muted-foreground hover:text-foreground">
                {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />}
                Upload manual
                <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} disabled={uploading} />
              </label>
              {currentCompany?.logo_url && (
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1 h-auto py-2.5 gap-2 border-dashed text-xs"
                  onClick={handleUseLogo}
                >
                  <Building2 className="w-3.5 h-3.5" />
                  Usar Logotipo
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Dialog de preview da imagem */}
        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="max-w-lg p-2 bg-black/90 border-none">
            {draft.imageUrl && (
              <img src={draft.imageUrl} alt="Preview" className="w-full h-auto rounded-lg" />
            )}
          </DialogContent>
        </Dialog>

        <CampaignAiArtDialog
          open={aiArtOpen}
          onOpenChange={setAiArtOpen}
          companyId={currentCompanyId || ""}
          companyName={companyName}
          logoUrl={currentCompany?.logo_url}
          defaultIdea={draft.name ? `Arte alegre de festa infantil para a campanha "${draft.name}"` : ""}
          defaultText={draft.name}
          onUse={(url) => {
            setDraft((prev) => ({ ...prev, imageUrl: url }));
            saveImageToGallery(url, "ai_gpt");
            toast.success("Arte aplicada! 🎨");
          }}
          onManual={handleOpenArtDialog}
        />

        {/* Dialog de Criar Arte Profissional (montar à mão em cima de uma foto) */}
        <Dialog open={artDialogOpen} onOpenChange={setArtDialogOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Wand2 className="w-5 h-5 text-primary" />
                Criar Arte Profissional
              </DialogTitle>
            </DialogHeader>

            <Tabs value={artMode} onValueChange={(v) => setArtMode(v as "photo" | "theme")} className="w-full">
              <TabsList className="grid w-full grid-cols-2 mb-3">
                <TabsTrigger value="photo" className="gap-1.5 text-xs">
                  <Image className="w-3.5 h-3.5" />
                  Com Foto
                </TabsTrigger>
                <TabsTrigger value="theme" className="gap-1.5 text-xs">
                  <Palette className="w-3.5 h-3.5" />
                  Só pelo Tema
                </TabsTrigger>
              </TabsList>

              {/* Tab: Com Foto */}
              <TabsContent value="photo" className="space-y-4 mt-0">
                <div className="space-y-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    1. Escolha a foto base
                  </Label>

                  {selectedPhoto ? (
                    <div className="relative rounded-xl overflow-hidden border-2 border-primary shadow-md">
                      <img src={selectedPhoto} alt="Foto selecionada" className="w-full h-48 object-contain bg-white" />
                      <Button
                        variant="secondary"
                        size="sm"
                        className="absolute top-2 right-2 h-7 text-xs gap-1"
                        onClick={() => setSelectedPhoto(null)}
                      >
                        <RefreshCw className="w-3 h-3" />
                        Trocar
                      </Button>
                    </div>
                  ) : (
                    <>
                      {loadingPhotos ? (
                        <div className="flex items-center justify-center py-8">
                          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                        </div>
                      ) : buffetPhotos.length > 0 ? (
                        <ScrollArea className="h-52">
                          <div className="grid grid-cols-3 gap-2 p-1">
                            {buffetPhotos.map((url, i) => (
                              <button
                                key={i}
                                type="button"
                                className="relative group rounded-lg overflow-hidden border-2 border-border/40 hover:border-primary hover:shadow-md transition-all bg-white dark:bg-muted/30"
                                onClick={() => setSelectedPhoto(url)}
                              >
                                <div className="w-full pt-[100%] relative">
                                  <img
                                    src={url}
                                    alt={`Foto ${i + 1}`}
                                    className="absolute inset-0 w-full h-full object-contain p-0.5"
                                    loading="lazy"
                                  />
                                </div>
                                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                                  <Image className="w-5 h-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                                </div>
                              </button>
                            ))}
                          </div>
                        </ScrollArea>
                      ) : (
                        <p className="text-sm text-muted-foreground text-center py-4">
                          Nenhuma foto encontrada nos materiais de venda.
                        </p>
                      )}

                      <label className="flex items-center justify-center gap-2 p-3 border border-dashed rounded-lg cursor-pointer hover:bg-muted/50 hover:border-primary/30 transition-all text-sm text-muted-foreground hover:text-foreground">
                        {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImagePlus className="w-4 h-4" />}
                        {uploading ? "Enviando..." : "Fazer upload de outra foto"}
                        <input type="file" accept="image/*" className="hidden" onChange={handleUploadForArt} disabled={uploading} />
                      </label>
                    </>
                  )}
                </div>
              </TabsContent>

              {/* Tab: Só pelo Tema */}
              <TabsContent value="theme" className="space-y-4 mt-0">
                <div className="space-y-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    1. Escolha um tema
                  </Label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {ART_THEME_PRESETS.map((t) => (
                      <button
                        key={t.value}
                        type="button"
                        className={`p-2 text-xs rounded-lg border transition-all text-left ${
                          themeText === t.value
                            ? "bg-primary text-primary-foreground border-primary shadow-sm"
                            : "bg-muted/30 hover:bg-muted border-border hover:border-primary/40"
                        }`}
                        onClick={() => setThemeText(themeText === t.value ? "" : t.value)}
                      >
                        <span className="mr-1">{t.emoji}</span> {t.value}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Ou descreva o tema
                  </Label>
                  <Input
                    placeholder="Ex: Festa tropical com flamingos e coqueiros..."
                    value={themeText}
                    onChange={(e) => setThemeText(e.target.value)}
                    className="h-9 text-sm"
                  />
                </div>
              </TabsContent>
            </Tabs>

            <div className="space-y-4">
              {/* Logo options */}
              {currentCompany?.logo_url && (
                <div className="space-y-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {artMode === "photo" ? "2. Logotipo" : "2. Logotipo"}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="include-logo-art"
                      checked={includeLogo}
                      onCheckedChange={(v) => setIncludeLogo(!!v)}
                    />
                    <label htmlFor="include-logo-art" className="text-sm cursor-pointer">
                      Incluir logotipo na arte
                    </label>
                  </div>
                  {includeLogo && (
                    <div className="space-y-1.5">
                      <p className="text-[11px] text-muted-foreground">Posição do logo</p>
                      <div className="grid grid-cols-5 gap-1.5">
                        {[
                          { value: "top-left", label: "↖" },
                          { value: "top-right", label: "↗" },
                          { value: "center", label: "⊕" },
                          { value: "bottom-left", label: "↙" },
                          { value: "bottom-right", label: "↘" },
                        ].map((pos) => (
                          <button
                            key={pos.value}
                            type="button"
                            className={`p-2 text-sm rounded-md border transition-colors ${
                              logoPosition === pos.value
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-muted/30 hover:bg-muted border-border"
                            }`}
                            onClick={() => setLogoPosition(pos.value)}
                          >
                            {pos.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Generate button */}
              <Button
                className="w-full h-11 gap-2 text-sm font-semibold"
                onClick={handleComposeArt}
                disabled={composing || (artMode === "photo" ? !selectedPhoto : (!themeText.trim() && !draft.campaignType))}
              >
                {composing ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Criando arte profissional...
                    <span className="tabular-nums text-xs opacity-80">({composeElapsed}s)</span>
                  </span>
                ) : artMode === "photo" ? (
                  <>
                    <Type className="w-4 h-4" />
                    Montar arte com esta foto
                  </>
                ) : (
                  <>
                    <Wand2 className="w-4 h-4" />
                    Gerar Arte com IA
                  </>
                )}
              </Button>

              {artMode === "photo" && (
                <p className="text-[11px] text-muted-foreground text-center">
                  {selectedPhoto
                    ? "A sua foto vira a base da arte: no próximo passo você coloca o texto e o logo por cima."
                    : "Escolha uma foto do buffet. Ela vira a base da arte, e você coloca o texto e o logo por cima."}
                </p>
              )}
              {artMode === "theme" && !themeText.trim() && (
                <p className="text-[11px] text-muted-foreground text-center">
                  Escolha um tema ou descreva o que deseja para a IA criar a arte do zero
                </p>
              )}
            </div>
          </DialogContent>
        </Dialog>
        {/* Art Ready Banner */}
        {showArtReadyBanner && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 animate-in fade-in duration-300">
            <div
              className="w-80 h-80 rounded-2xl bg-gradient-to-br from-primary to-primary/70 flex flex-col items-center justify-center gap-6 shadow-2xl text-primary-foreground p-8 text-center animate-in zoom-in-90 duration-500 cursor-pointer"
              onClick={() => {
                setShowArtReadyBanner(false);
                setTextEditorOpen(true);
              }}
            >
              <span className="text-6xl">🎨</span>
              <h2 className="text-2xl font-bold leading-tight">Sua imagem ficou pronta!</h2>
              <p className="text-lg opacity-90">✨ Personalize ela com a sua preferência!</p>
              <span className="text-xs opacity-60 mt-2">Clique para personalizar ou aguarde...</span>
            </div>
          </div>
        )}
        {/* Text Overlay Editor */}
        {pendingArtUrl && (
          <CampaignTextOverlayEditor
            open={textEditorOpen}
            onOpenChange={setTextEditorOpen}
            imageUrl={pendingArtUrl}
            onSave={handleTextEditorSave}
            companyId={currentCompanyId || ""}
            campaignType={draft.campaignType}
            initialLogoPosition={includeLogo && currentCompany?.logo_url ? logoPosition : null}
          />
        )}
      </section>
    </div>
  );
}

function StepTitle({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">{n}</span>
      <div className="min-w-0">
        <p className="text-sm font-semibold leading-tight">{title}</p>
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}
