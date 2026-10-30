import { supabase } from "@/integrations/supabase/client";

// Foto do documento (RG/CNH) no formulário público de dados do contratante.
// Celular manda foto de 5–12 MB, às vezes HEIC ou sem tipo — o armazenamento
// aceita só JPG/PNG/WEBP/HEIC/PDF até 10 MB. Por isso a foto é reduzida e
// convertida para JPG antes de subir, e o envio vai como visitante (sem a
// sessão de quem estiver logado no navegador, que pode estar vencida).

const MAX_SIDE = 1800;

export interface PreparedDocument {
  blob: Blob;
  contentType: string;
  ext: string;
}

async function decodeImage(file: File): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch { /* tenta pelo <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export async function prepareDocument(file: File): Promise<PreparedDocument> {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (isPdf) return { blob: file, contentType: "application/pdf", ext: "pdf" };
  try {
    const img = await decodeImage(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (blob && blob.size > 0) return { blob, contentType: "image/jpeg", ext: "jpg" };
  } catch { /* manda o original */ }
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "jpg";
  const type = file.type || (ext === "png" ? "image/png" : ext === "heic" || ext === "heif" ? `image/${ext}` : "image/jpeg");
  return { blob: file, contentType: type, ext };
}

/** Sobe o arquivo como visitante. null = ok; texto = motivo do erro (para mostrar e investigar) */
export async function uploadClientDocument(path: string, doc: PreparedDocument): Promise<string | null> {
  const client = supabase as unknown as { supabaseUrl: string; supabaseKey: string };
  try {
    const res = await fetch(`${client.supabaseUrl}/storage/v1/object/client-documents/${path}`, {
      method: "POST",
      headers: {
        apikey: client.supabaseKey,
        Authorization: `Bearer ${client.supabaseKey}`,
        "Content-Type": doc.contentType,
        "x-upsert": "false",
      },
      body: doc.blob,
    });
    if (res.ok) return null;
    const body = await res.json().catch(() => null) as { message?: string; error?: string } | null;
    return body?.message || body?.error || `erro ${res.status}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
