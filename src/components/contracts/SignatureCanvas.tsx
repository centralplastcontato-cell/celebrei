import { useRef, useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Eraser } from "lucide-react";

interface Props {
  onSignatureChange: (dataUrl: string | null) => void;
  height?: number;
}

// Quadro da assinatura. Antes: o desenho tinha proporção fixa (800×360) esticada
// na largura da tela — o traço saía torto e fino no celular — e o toque podia
// rolar a página no iPhone enquanto o cliente assinava. Agora: eventos de
// "ponteiro" (dedo, caneta ou mouse), touch-action none e a resolução da tela.
export function SignatureCanvas({ onSignatureChange, height = 200 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [hasContent, setHasContent] = useState(false);
  const [penColor, setPenColor] = useState("#1a1a1a");
  const penRef = useRef(penColor);
  penRef.current = penColor;

  // Tamanho real do quadro × densidade da tela (traço nítido)
  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(height * dpr);
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Redimensionar apaga o desenho: pede para assinar de novo
    setHasContent(false);
    onSignatureChange(null);
  }, [height, onSignatureChange]);

  useEffect(() => {
    fit();
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [fit]);

  const pos = (e: PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  // Ouvintes nativos (não passivos): o navegador não rola a página durante o traço
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const down = (e: PointerEvent) => {
      e.preventDefault();
      canvas.setPointerCapture?.(e.pointerId);
      drawing.current = true;
      last.current = pos(e);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        // Um toque sem arrastar vira um ponto
        ctx.fillStyle = penRef.current;
        ctx.beginPath();
        ctx.arc(last.current.x, last.current.y, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    const move = (e: PointerEvent) => {
      if (!drawing.current) return;
      e.preventDefault();
      const ctx = canvas.getContext("2d");
      const p = pos(e);
      if (ctx && last.current) {
        ctx.strokeStyle = penRef.current;
        ctx.lineWidth = e.pointerType === "pen" && e.pressure > 0 ? 1.5 + e.pressure * 2 : 2.6;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(last.current.x, last.current.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      last.current = p;
    };
    const up = () => {
      if (!drawing.current) return;
      drawing.current = false;
      last.current = null;
      setHasContent(true);
      onSignatureChange(canvas.toDataURL("image/png"));
    };
    canvas.addEventListener("pointerdown", down, { passive: false });
    canvas.addEventListener("pointermove", move, { passive: false });
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("pointerleave", up);
    // iOS antigo: bloqueia o arrastar da página também pelo touch
    const stopTouch = (e: TouchEvent) => e.preventDefault();
    canvas.addEventListener("touchstart", stopTouch, { passive: false });
    canvas.addEventListener("touchmove", stopTouch, { passive: false });
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("pointerleave", up);
      canvas.removeEventListener("touchstart", stopTouch);
      canvas.removeEventListener("touchmove", stopTouch);
    };
  }, [onSignatureChange]);

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setHasContent(false);
    onSignatureChange(null);
  };

  return (
    <div className="space-y-2">
      <div className="relative overflow-hidden rounded-lg border-2 border-dashed border-border/60 bg-white">
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: `${height}px`, touchAction: "none", display: "block" }}
          aria-label="Quadro para desenhar a assinatura"
        />
        {/* Linha de base, como num papel */}
        <div className="pointer-events-none absolute bottom-10 left-6 right-6 border-b border-gray-300" />
        {!hasContent && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="text-sm text-gray-400">✍️ Assine aqui com o dedo</p>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={clearCanvas} className="gap-1.5 text-xs">
          <Eraser className="h-3.5 w-3.5" /> Limpar
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            aria-label="Caneta preta"
            onClick={() => setPenColor("#1a1a1a")}
            className={`h-6 w-6 rounded-full border-2 bg-black ${penColor === "#1a1a1a" ? "border-primary ring-2 ring-primary/30" : "border-border"}`}
          />
          <button
            type="button"
            aria-label="Caneta azul"
            onClick={() => setPenColor("#1e40af")}
            className={`h-6 w-6 rounded-full border-2 bg-blue-800 ${penColor === "#1e40af" ? "border-primary ring-2 ring-primary/30" : "border-border"}`}
          />
        </div>
      </div>
    </div>
  );
}
