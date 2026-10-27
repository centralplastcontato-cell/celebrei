import { supabase } from "@/integrations/supabase/client";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { getFormAutomationTemplate, resolveFormAutomationMessage } from "@/lib/formAutomationMessages";
import { toCanonicalBrazilianPhone } from "@/lib/whatsappConversationHelper";

/**
 * Verify that a WhatsApp instance is actually connected (live check via W-API).
 * Returns { healthy: true } or { healthy: false, error: string }.
 */
async function verifyInstanceHealth(
  instanceId: string,
  instanceToken: string,
): Promise<{ healthy: boolean; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke("wapi-send", {
      body: { action: "get-status", instanceId, instanceToken },
    });
    if (error) return { healthy: false, error: "Erro ao verificar instância." };
    const payload = data as { connected?: boolean; status?: string } | null;
    if (payload?.connected === true) return { healthy: true };
    return {
      healthy: false,
      error: `Instância WhatsApp está desconectada (${payload?.status || "offline"}). Reconecte antes de enviar.`,
    };
  } catch {
    return { healthy: false, error: "Não foi possível verificar a instância WhatsApp." };
  }
}

/**
 * Log a contract-related action to the audit trail.
 */
export async function logContractAction(
  companyId: string,
  contractId: string | null | undefined,
  templateId: string | null | undefined,
  action: string,
  performedBy: string,
  details: Record<string, any> = {},
) {
  try {
    await (supabase as any).from("contract_audit_logs").insert({
      company_id: companyId,
      contract_id: contractId || null,
      template_id: templateId || null,
      action,
      details,
      performed_by: performedBy,
    });
  } catch (e) {
    console.warn("[contract-audit] Failed to log action:", action, e);
  }
}

/**
 * Strip HTML tags and clean up contract content for WhatsApp plain-text sending.
 */
function stripHtmlForWhatsApp(html: string): string {
  let text = html;
  // Convert <strong> to *bold* for WhatsApp formatting
  text = text.replace(/<strong>(.*?)<\/strong>/gi, "*$1*");
  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  // Normalize whitespace but keep newlines
  text = text.replace(/[ \t]+/g, " ");
  // Remove excessive blank lines (max 2)
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function escapeHtml(content: string): string {
  return content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatContractHtmlForPdf(content: string): string {
  return escapeHtml(content)
    .replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br />");
}

function isCanvasRowMostlyWhite(
  context: CanvasRenderingContext2D,
  width: number,
  y: number,
  threshold = 245,
  tolerance = 0.998,
): boolean {
  const safeY = Math.max(0, Math.floor(y));
  const row = context.getImageData(0, safeY, width, 1).data;
  let lightPixels = 0;
  let sampledPixels = 0;

  for (let pixel = 0; pixel < width; pixel += 4) {
    const index = pixel * 4;
    const alpha = row[index + 3];

    if (
      alpha < 16 ||
      (row[index] >= threshold && row[index + 1] >= threshold && row[index + 2] >= threshold)
    ) {
      lightPixels += 1;
    }

    sampledPixels += 1;
  }

  return sampledPixels > 0 && lightPixels / sampledPixels >= tolerance;
}

function isWhitespaceBand(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  y: number,
  bandSize = 4,
): boolean {
  const start = Math.max(0, Math.floor(y - bandSize / 2));
  const end = Math.min(height - 1, Math.floor(y + bandSize / 2));

  for (let row = start; row <= end; row++) {
    if (!isCanvasRowMostlyWhite(context, width, row)) {
      return false;
    }
  }

  return true;
}

function findSafePageBreak(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  startY: number,
  idealEndY: number,
  minSliceHeightPx: number,
): number {
  const minY = Math.min(height - 1, Math.max(startY + minSliceHeightPx, startY + 1));
  const maxY = Math.min(height - 1, idealEndY);

  for (let y = maxY; y >= minY; y--) {
    if (isWhitespaceBand(context, width, height, y)) {
      return y;
    }
  }

  return maxY;
}

function skipLeadingWhitespace(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  startY: number,
): number {
  let y = Math.max(0, Math.floor(startY));

  while (y < height - 1 && isCanvasRowMostlyWhite(context, width, y, 250, 0.999)) {
    y += 1;
  }

  return y;
}

/**
 * Render contract HTML to a multi-page PDF using a single html2canvas call
 * and whitespace-aware page breaks to avoid cutting text lines.
 */
export async function renderContractHtmlToPdf(
  htmlContent: string,
  contractName: string,
  companyId?: string,
): Promise<Blob | null> {
  try {
    // Fetch company logo if companyId provided
    let logoUrl: string | null = null;
    if (companyId) {
      try {
        const { data } = await supabase
          .from("companies")
          .select("logo_url")
          .eq("id", companyId)
          .single();
        logoUrl = data?.logo_url || null;
      } catch { /* ignore */ }
    }

    // Format content: convert markdown bold and newlines
    const formattedContent = formatContractHtmlForPdf(htmlContent);

    // Build full HTML with header
    const fullHtml = `
      <div style="text-align:center; margin-bottom:24px; padding-bottom:16px; border-bottom:2px solid #e5e7eb;">
        ${logoUrl ? `<img src="${logoUrl}" style="height:112px; max-width:280px; object-fit:contain; margin:0 auto 8px; display:block;" crossorigin="anonymous" />` : ""}
        <h1 style="font-size:16px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; margin:0; color:#1f2937; font-family:Georgia,'Times New Roman',serif;">
          ${contractName || "Contrato"}
        </h1>
      </div>
      <div style="white-space:pre-wrap; word-break:break-word; text-align:justify; line-height:1.85; font-family:Georgia,'Times New Roman',serif; font-size:13px; color:#1f2937;">
        ${formattedContent}
      </div>
    `;

    // Create off-screen container with A4-like width
    const container = document.createElement("div");
    container.style.cssText = `
      position: fixed; left: -9999px; top: 0;
      width: 794px;
      background: white; color: black;
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 13px; line-height: 1.85;
      padding: 40px 50px 48px;
    `;
    container.innerHTML = fullHtml;
    document.body.appendChild(container);

    // Wait for images to load
    const images = container.querySelectorAll("img");
    await Promise.all(
      Array.from(images).map(
        (img) =>
          new Promise<void>((resolve) => {
            if (img.complete) return resolve();
            img.onload = () => resolve();
            img.onerror = () => resolve();
          }),
      ),
    );

    await new Promise((r) => setTimeout(r, 200));

    // Single html2canvas call for the entire content
    const fullCanvas = await html2canvas(container, {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      backgroundColor: "#ffffff",
      logging: false,
    });

    document.body.removeChild(container);

    const canvasContext = fullCanvas.getContext("2d", { willReadFrequently: true });
    if (!canvasContext) {
      return null;
    }

    // Slice the single canvas into A4 pages without cutting text lines
    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = pdf.internal.pageSize.getHeight();
    const marginX = 10;
    const marginTop = 12;
    const footerReserve = 14;
    const contentWidth = pdfWidth - marginX * 2;
    const usableHeight = pdfHeight - marginTop - footerReserve;

    const scale = contentWidth / fullCanvas.width;
    const pixelsPerPage = Math.max(1, Math.floor(usableHeight / scale));
    const minSliceHeightPx = Math.max(1, Math.floor(pixelsPerPage * 0.72));
    const pageSlices: Array<{ startY: number; heightPx: number }> = [];

    let startY = 0;
    while (startY < fullCanvas.height) {
      const remainingPx = fullCanvas.height - startY;

      if (remainingPx <= pixelsPerPage) {
        pageSlices.push({ startY, heightPx: remainingPx });
        break;
      }

      const safeBreakY = findSafePageBreak(
        canvasContext,
        fullCanvas.width,
        fullCanvas.height,
        startY,
        startY + pixelsPerPage,
        minSliceHeightPx,
      );

      const heightPx = Math.max(1, safeBreakY - startY);
      pageSlices.push({ startY, heightPx });
      startY = Math.max(
        safeBreakY + 1,
        skipLeadingWhitespace(canvasContext, fullCanvas.width, fullCanvas.height, safeBreakY + 1),
      );
    }

    for (const [pageIndex, slice] of pageSlices.entries()) {
      if (pageIndex > 0) pdf.addPage();

      const sliceCanvas = document.createElement("canvas");
      sliceCanvas.width = fullCanvas.width;
      sliceCanvas.height = slice.heightPx;

      const ctx = sliceCanvas.getContext("2d");
      if (!ctx) continue;

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
      ctx.drawImage(
        fullCanvas,
        0, slice.startY, fullCanvas.width, slice.heightPx,
        0, 0, fullCanvas.width, slice.heightPx,
      );

      const sliceHeightMm = Math.min(usableHeight, slice.heightPx * scale);
      pdf.addImage(
        sliceCanvas.toDataURL("image/jpeg", 0.95),
        "JPEG",
        marginX,
        marginTop,
        contentWidth,
        sliceHeightMm,
      );
    }

    // Add page numbers
    const pageCount = pdf.getNumberOfPages();
    for (let p = 1; p <= pageCount; p++) {
      pdf.setPage(p);
      pdf.setFontSize(8);
      pdf.setTextColor(150, 150, 150);
      pdf.text(`Página ${p} de ${pageCount}`, pdfWidth / 2, pdfHeight - 5, { align: "center" });
    }

    return pdf.output("blob");
  } catch (e) {
    console.error("[contract-pdf] Error rendering HTML to PDF:", e);
    return null;
  }
}


export async function sendContractViaWhatsApp(
  companyId: string,
  leadId: string,
  contractContent: string,
  contractName: string,
  options?: { instanceId?: string; instanceToken?: string },
): Promise<{ success: boolean; error?: string; fileUrl?: string }> {
  try {
    // 1. Get lead phone
    const { data: lead, error: leadErr } = await supabase
      .from("campaign_leads")
      .select("whatsapp, name")
      .eq("id", leadId)
      .single();

    if (leadErr || !lead?.whatsapp) {
      return { success: false, error: "Lead não encontrado ou sem WhatsApp cadastrado." };
    }

    // 2. Find connected instance for this company
    let instance = null as { id?: string; instance_id: string; instance_token: string; status?: string } | null;

    if (options?.instanceId && options?.instanceToken) {
      instance = {
        instance_id: options.instanceId,
        instance_token: options.instanceToken,
      };
    } else {
      const { data: instances } = await (supabase as any)
        .from("wapi_instances")
        .select("id, instance_id, instance_token, status")
        .eq("company_id", companyId)
        .eq("status", "connected")
        .limit(1);

      instance = instances?.[0] ?? null;
    }

    if (!instance) {
      return { success: false, error: "Nenhuma instância do WhatsApp conectada." };
    }

    // 2b. Verify instance is actually connected (live check)
    const health = await verifyInstanceHealth(instance.instance_id, instance.instance_token);
    if (!health.healthy) {
      return { success: false, error: health.error || "Instância desconectada." };
    }

    // 3. Find existing conversation
    const rawPhone = lead.whatsapp.replace(/\D/g, "");
    const phone = toCanonicalBrazilianPhone(rawPhone);
    if (!phone || phone.length < 12) {
      return { success: false, error: "Número de WhatsApp do lead inválido (sem DDI/DDD)." };
    }
    const { data: convs } = await (supabase as any)
      .from("wapi_conversations")
      .select("id, jid")
      .eq("company_id", companyId)
      .eq("instance_id", instance.id)
      .or(`jid.ilike.%${phone}%,lead_id.eq.${leadId}`)
      .limit(1);

    const conv = convs?.[0];

    // 4. Generate PDF from contract HTML content (preserving full formatting & logo)
    const pdfBlob = await renderContractHtmlToPdf(contractContent, contractName, companyId);
    if (!pdfBlob) {
      return { success: false, error: "Erro ao gerar PDF do contrato." };
    }

    const safeFileName = contractName.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 60);
    const storagePath = `contracts/${companyId}/${safeFileName}_${Date.now()}.pdf`;

    // 5. Upload PDF to storage
    const { error: uploadErr } = await supabase.storage
      .from("whatsapp-media")
      .upload(storagePath, pdfBlob, { contentType: "application/pdf", upsert: true });

    if (uploadErr) {
      return { success: false, error: "Erro ao gerar PDF do contrato: " + uploadErr.message };
    }

    // Get signed URL (1 hour)
    const { data: urlData, error: urlErr } = await supabase.storage
      .from("whatsapp-media")
      .createSignedUrl(storagePath, 3600);

    if (urlErr || !urlData?.signedUrl) {
      return { success: false, error: "Erro ao gerar URL do PDF." };
    }

    // 6. Send customizable text message before the PDF
    const waTemplate = await getContractWhatsAppTemplate(companyId);
    const textMsg = resolveContractSendMessage(waTemplate, {
      nome: lead.name,
      nome_contrato: contractName,
      empresa: "", // Will be filled below
    });
    // Fetch company name for the template
    const { data: companyInfo } = await supabase.from("companies").select("name").eq("id", companyId).single();
    const finalMsg = textMsg.replace(/\{\{empresa\}\}/gi, companyInfo?.name || "");

    if (finalMsg.trim()) {
      await supabase.functions.invoke("wapi-send", {
        body: {
          action: "send-text",
          instanceId: instance.instance_id,
          instanceToken: instance.instance_token,
          phone,
          message: finalMsg,
          conversationId: conv?.id || undefined,
        },
      });
    }

    // 7. Send PDF as document
    const { data: sendResult, error: sendErr } = await supabase.functions.invoke("wapi-send", {
      body: {
        action: "send-document",
        instanceId: instance.instance_id,
        instanceToken: instance.instance_token,
        phone: phone,
        mediaUrl: urlData.signedUrl,
        fileName: `${safeFileName}.pdf`,
        conversationId: conv?.id || undefined,
      },
    });

    const sendPayload = sendResult as { success?: boolean; error?: string } | null;

    if (sendErr) {
      return { success: false, error: sendErr.message || "Erro ao enviar documento." };
    }

    if (sendPayload?.success === false) {
      return { success: false, error: sendPayload.error || "Falha no envio pelo WhatsApp." };
    }

    return { success: true, fileUrl: urlData.signedUrl };
  } catch (e: any) {
    return { success: false, error: e.message || "Erro inesperado ao enviar contrato." };
  }
}


export async function getContractSendTemplate(companyId: string): Promise<string> {
  return getFormAutomationTemplate(companyId, "contrato_envio");
}

export async function getContractWhatsAppTemplate(companyId: string): Promise<string> {
  return getFormAutomationTemplate(companyId, "contrato_whatsapp");
}

export function resolveContractSendMessage(
  template: string,
  vars: { nome?: string; link?: string; nome_contrato?: string; empresa?: string },
): string {
  return resolveFormAutomationMessage(template, vars);
}

/**
 * "Contrato via WhatsApp" com envio automático ligado (Mensagens automáticas →
 * Formulários): manda o PDF assim que a equipe gera o contrato. O PDF é montado
 * no navegador, por isso sai daqui e não do servidor. Desligado: não faz nada.
 */
export async function autoSendContractOnGenerate(
  companyId: string,
  contract: { id: string; lead_id: string | null; event_id: string | null; content: string; name: string; template_id: string | null },
  userId: string,
): Promise<{ sent: boolean; error?: string }> {
  const { data: cfg, error: cfgErr } = await (supabase as any)
    .from("form_automation_settings")
    .select("is_enabled, auto_send")
    .eq("company_id", companyId)
    .eq("form_type", "contrato_whatsapp")
    .maybeSingle();
  if (cfgErr || !cfg?.auto_send || cfg.is_enabled === false) return { sent: false };

  let leadId = contract.lead_id;
  if (!leadId && contract.event_id) {
    const { data: ev } = await supabase.from("company_events").select("lead_id").eq("id", contract.event_id).maybeSingle();
    leadId = ev?.lead_id || null;
  }
  if (!leadId) return { sent: false, error: "Contrato sem cliente vinculado" };

  const result = await sendContractViaWhatsApp(companyId, leadId, contract.content, contract.name);
  if (!result.success) return { sent: false, error: result.error };
  await supabase.from("generated_contracts").update({ status: "enviado" }).eq("id", contract.id).eq("status", "gerado");
  await logContractAction(companyId, contract.id, contract.template_id, "contract_sent_whatsapp", userId, { lead_id: leadId, auto: true });
  return { sent: true };
}
