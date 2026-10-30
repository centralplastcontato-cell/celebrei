// ============= MATERIAIS DE QUALIFICAÇÃO (fotos + vídeo + PDF) =============
// Rotina única de envio automático dos materiais depois da qualificação, usada
// pelo bot fixo (index.ts) e pela IA (ai-agent.ts) — mesma ordem, legendas,
// intervalos e opções de "envio automático" do número (wapi_bot_settings).
// Quem chama passa a função de envio (cada lado tem o seu wrapper do wapi-send).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { sandboxSleep } from "./ai-sandbox.ts";

export type MaterialSender = (
  action: 'send-text' | 'send-image' | 'send-video' | 'send-document',
  payload: { message?: string; mediaUrl?: string; caption?: string; fileName?: string; delayTyping?: number },
  options?: { timeoutMs?: number; logLabel?: string },
) => Promise<string | null>;

// Ritmo do envio. O bot fixo usa o intervalo do número (message_delay_seconds);
// a IA manda com calma, "digitando..." antes de cada texto, para não parecer
// uma rajada de arquivos.
export interface MaterialPacing {
  startMs: number; // antes do primeiro envio
  photoGapMs: number; // entre uma foto e outra
  afterPhotosMs: number; // depois das fotos, antes do vídeo
  afterVideoMs: number; // depois do vídeo, antes do PDF
  typingSeconds: number; // "digitando..." antes de cada texto
}

function delay(ms: number): Promise<void> {
  return sandboxSleep(ms);
}

// Palavras que não são nome de verdade (a IA às vezes registra "cliente")
const NOT_A_NAME = new Set(['cliente', 'você', 'voce', 'senhor', 'senhora', 'sr', 'sra', 'amigo', 'amiga', 'mãe', 'mae', 'pai', 'contato', 'lead', 'usuario', 'usuário']);

export function firstNameOrEmpty(raw: string | null | undefined): string {
  const first = String(raw || '').trim().split(/\s+/)[0] || '';
  if (!first || /\d/.test(first) || NOT_A_NAME.has(first.toLowerCase())) return '';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// Preenche o texto de apresentação do PDF. Sem nome real, tira o "Oi {nome}!"
// em vez de escrever "Oi você!" / "Oi cliente!".
export function fillPdfIntro(template: string, vars: { nome: string; convidados: string; empresa: string }): string {
  let text = template;
  if (!vars.nome) {
    text = text
      .replace(/(^|[\s📋✨🎉💜]*)(Oi|Olá|Ola)\s*,?\s*\{nome\}\s*[!,.]?\s*/i, '$1')
      .replace(/,?\s*\{nome\}/gi, '');
  }
  return text
    .replace(/\{nome\}/gi, vars.nome)
    .replace(/\{convidados\}/gi, vars.convidados)
    .replace(/\{unidade\}/gi, vars.empresa)
    .replace(/\{empresa\}/gi, vars.empresa)
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Prova social (Materiais → "Prova social", até 4 imagens): cada cliente
// recebe só 1, sempre a mesma para o mesmo número, em rodízio entre clientes
export function pickSocialProof(urls: string[], phone: string): string | null {
  const list = urls.filter(Boolean);
  if (list.length === 0) return null;
  const digits = phone.replace(/\D/g, '');
  let hash = 0;
  for (const ch of digits) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return list[hash % list.length];
}

export async function sendQualificationMaterials(
  supabase: SupabaseClient,
  instance: { id: string; instance_id: string; instance_token: string; unit: string | null; company_id: string },
  conv: { id: string; remote_jid: string },
  botData: Record<string, string>,
  settings: {
    auto_send_materials?: boolean;
    auto_send_photos?: boolean;
    auto_send_presentation_video?: boolean;
    auto_send_promo_video?: boolean;
    auto_send_pdf?: boolean;
    auto_send_photos_intro?: string | null;
    auto_send_pdf_intro?: string | null;
    message_delay_seconds?: number;
  } | null,
  send: MaterialSender,
  // Textos próprios (a IA escreve personalizados); sem eles, valem as legendas fixas do bot
  texts?: { photosIntro?: string | null; videoCaption?: string | null; pdfIntro?: string | null },
  pacing?: MaterialPacing,
): Promise<{ sentAny: boolean; failedSteps: string[]; pdfGuestCount?: number | null }> {
  const failedSteps: string[] = [];
  let sentAny = false;
  let pdfGuestCount: number | null = null;

  try {
    if (settings?.auto_send_materials === false) {
      console.log('[Bot Materials] Auto-send is disabled in settings');
      return { sentAny: false, failedSteps };
    }

    const unit = instance.unit;
    const month = botData.mes || '';
    const guestsStr = botData.convidados || '';
    const phone = conv.remote_jid.replace('@s.whatsapp.net', '').replace('@c.us', '');

    let companyName = unit || '';
    const { data: companyRow } = await supabase
      .from('companies')
      .select('name')
      .eq('id', instance.company_id)
      .maybeSingle();
    if (companyRow?.name) companyName = companyRow.name;

    console.log(`[Bot Materials] Starting auto-send for ${phone}, unit: ${unit}, companyName: ${companyName}, month: ${month}, guests: ${guestsStr}`);

    if (!unit) {
      console.log('[Bot Materials] No unit configured, skipping');
      return { sentAny: false, failedSteps };
    }

    const sendPhotos = settings?.auto_send_photos !== false;
    const sendPresentationVideo = settings?.auto_send_presentation_video !== false;
    const sendPromoVideo = settings?.auto_send_promo_video !== false;
    const sendPdf = settings?.auto_send_pdf !== false;
    const messageDelay = (settings?.message_delay_seconds || 5) * 1000;
    const photosIntro = settings?.auto_send_photos_intro || '✨ Conheça nosso espaço incrível! 🎈🎉';
    const pdfIntro = settings?.auto_send_pdf_intro || '📋 Oi {nome}! Segue o pacote completo para {convidados} no {empresa}. Qualquer dúvida é só chamar! 💜';

    await delay(pacing ? pacing.startMs : messageDelay);

    const { data: captions } = await supabase
      .from('sales_material_captions')
      .select('caption_type, caption_text')
      .eq('is_active', true);

    const captionMap: Record<string, string> = {};
    captions?.forEach((caption) => {
      captionMap[caption.caption_type] = caption.caption_text;
    });

    let { data: materials, error: matError } = await supabase
      .from('sales_materials')
      .select('*')
      .eq('unit', unit)
      .eq('is_active', true)
      .order('type', { ascending: true })
      .order('sort_order', { ascending: true });

    if ((!materials || materials.length === 0) && instance.company_id) {
      console.log(`[Bot Materials] No materials for unit "${unit}", falling back to company_id`);
      const fallback = await supabase
        .from('sales_materials')
        .select('*')
        .eq('company_id', instance.company_id)
        .eq('is_active', true)
        .order('type', { ascending: true })
        .order('sort_order', { ascending: true });
      materials = fallback.data;
      matError = fallback.error;
    }

    if (matError || !materials?.length) {
      console.log(`[Bot Materials] No materials found for unit ${unit} or company fallback`);
      if (matError) failedSteps.push('materials_query');
      return { sentAny: false, failedSteps };
    }

    console.log(`[Bot Materials] Found ${materials.length} materials for ${unit}`);

    // 🎯 Filter by event_mode (interno/externo) when lead chose a venue type
    // local_festa = '1' → interno; local_festa = '2' → externo
    // Materials with event_mode = NULL are sent in both cases (universal)
    const localFesta = (botData.local_festa || '').trim();
    let chosenMode: 'interno' | 'externo' | null = null;
    if (localFesta === '1' || /interno|nosso\s*espa[çc]o|no\s*espa[çc]o/i.test(localFesta)) {
      chosenMode = 'interno';
    } else if (localFesta === '2' || /externa?|barraca|em\s*casa|condom[ií]nio|ch[áa]cara/i.test(localFesta)) {
      chosenMode = 'externo';
    }

    if (chosenMode) {
      const beforeCount = materials.length;
      materials = materials.filter((m) => !m.event_mode || m.event_mode === chosenMode);
      console.log(`[Bot Materials] Filtered by event_mode="${chosenMode}": ${beforeCount} → ${materials.length}`);
    }

    const photoCollections = materials.filter((material) => material.type === 'photo_collection');
    const allVideos = materials.filter((material) => material.type === 'video');
    const promoVideos = allVideos.filter((material) => material.name?.toLowerCase().includes('promo') || material.name?.toLowerCase().includes('carnaval'));
    const presentationVideos = allVideos.filter((material) => !promoVideos.includes(material));
    const pdfPackages = materials.filter((material) => material.type === 'pdf_package');

    const guestMatch = guestsStr.match(/(\d+)/);
    const guestCount = guestMatch ? parseInt(guestMatch[1], 10) : null;

    const sendText = async (message: string, logLabel: string) => {
      const msgId = await send('send-text', pacing?.typingSeconds ? { message, delayTyping: pacing.typingSeconds } : { message }, { timeoutMs: 30000, logLabel });
      if (!msgId) failedSteps.push(logLabel);
      if (msgId) sentAny = true;
      return msgId;
    };

    const sendImage = async (url: string, caption: string, logLabel: string) => {
      const msgId = await send('send-image', { mediaUrl: url, caption }, { timeoutMs: 30000, logLabel });
      if (!msgId) failedSteps.push(logLabel);
      if (msgId) sentAny = true;
      return msgId;
    };

    const sendVideo = async (url: string, caption: string, logLabel: string) => {
      const msgId = await send('send-video', { mediaUrl: url, caption }, { timeoutMs: 60000, logLabel });
      if (!msgId) failedSteps.push(logLabel);
      if (msgId) sentAny = true;
      return msgId;
    };

    const sendDocument = async (url: string, fileName: string, logLabel: string) => {
      const msgId = await send('send-document', { mediaUrl: url, fileName }, { timeoutMs: 30000, logLabel });
      if (!msgId) failedSteps.push(logLabel);
      if (msgId) sentAny = true;
      return msgId;
    };

    if (sendPhotos && photoCollections.length > 0) {
      const collection = photoCollections[0];
      const photos = collection.photo_urls || [];

      if (photos.length > 0) {
        console.log(`[Bot Materials] Sending ${photos.length} photos from collection`);
        const introText = texts?.photosIntro?.trim() || photosIntro.replace(/\{unidade\}/gi, companyName).replace(/\{empresa\}/gi, companyName);
        await sendText(introText, 'photos_intro');
        await delay(pacing ? pacing.photoGapMs : messageDelay / 2);

        for (let i = 0; i < photos.length; i++) {
          await sendImage(photos[i], '', `photo_${i + 1}`);
          if (i < photos.length - 1) await delay(pacing ? pacing.photoGapMs : 800);
        }

        console.log('[Bot Materials] Photos step complete');
        await delay(pacing ? pacing.afterPhotosMs : messageDelay);
      }
    }

    // Prova social: 1 avaliação por cliente, logo depois das fotos do espaço
    const socialProof = materials.find((material) => material.type === 'social_proof' && material.company_id === instance.company_id);
    const proofUrl = sendPhotos && socialProof ? pickSocialProof(socialProof.photo_urls || [], phone) : null;
    if (proofUrl) {
      console.log('[Bot Materials] Sending social proof');
      // Legenda opcional: o campo "Legenda" da prova social (vazio = só a imagem)
      await sendImage(proofUrl, String(socialProof.name || '').trim(), 'social_proof');
      await delay(pacing ? pacing.afterPhotosMs : messageDelay);
    }

    if (sendPresentationVideo && presentationVideos.length > 0) {
      // When event_mode filter is active, send ALL matching videos (e.g. 3 external videos for Carrossel).
      // Otherwise keep legacy behavior (single video) to avoid changing other clients.
      const videosToSend = chosenMode ? presentationVideos : [presentationVideos[0]];
      const videoCaption = captionMap['video'] || `🎬 Conheça o ${companyName}! ✨`;
      const caption = texts?.videoCaption?.trim() || videoCaption.replace(/\{unidade\}/gi, companyName).replace(/\{empresa\}/gi, companyName);

      for (let i = 0; i < videosToSend.length; i++) {
        const video = videosToSend[i];
        console.log(`[Bot Materials] Sending presentation video ${i + 1}/${videosToSend.length}: ${video.name}`);
        // Caption only on the first video to avoid spam
        await sendVideo(video.file_url, i === 0 ? caption : '', `presentation_video_${i + 1}`);
        if (i < videosToSend.length - 1) await delay(messageDelay / 2);
      }
      await delay(pacing ? pacing.afterVideoMs : messageDelay);
    }

    if (sendPromoVideo && promoVideos.length > 0) {
      const promoVideo = promoVideos[0];
      console.log(`[Bot Materials] Sending promo video: ${promoVideo.name}`);

      const promoCaption = captionMap['video_promo'] || captionMap['video'] || '🎬 Confira nosso vídeo! ✨';
      const caption = promoCaption.replace(/\{unidade\}/gi, companyName).replace(/\{empresa\}/gi, companyName);
      await sendVideo(promoVideo.file_url, caption, 'promo_video');
      await delay(messageDelay * 1.5);
    }

    if (sendPdf && pdfPackages.length > 0) {
      const universalPdfs = pdfPackages.filter((pkg) => pkg.guest_count === null);
      const specificPdfs = pdfPackages.filter((pkg) => pkg.guest_count !== null);

      let pdfsToSend: typeof pdfPackages = [];

      if (universalPdfs.length > 0) {
        pdfsToSend = universalPdfs;
        console.log(`[Bot Materials] Found ${universalPdfs.length} universal PDFs`);
      } else if (guestCount && specificPdfs.length > 0) {
        let matchingPdf = specificPdfs.find((pkg) => pkg.guest_count === guestCount);
        if (!matchingPdf) {
          const sortedPackages = [...specificPdfs].sort((a, b) => (a.guest_count || 0) - (b.guest_count || 0));
          matchingPdf = sortedPackages.find((pkg) => (pkg.guest_count || 0) >= guestCount) || sortedPackages[sortedPackages.length - 1];
        }
        if (matchingPdf) pdfsToSend = [matchingPdf];
      }

      if (pdfsToSend.length > 0) {
        const firstPdf = pdfsToSend[0];
        console.log(`[Bot Materials] Sending ${pdfsToSend.length} PDF(s): ${firstPdf.name}`);

        // Pacote de uma faixa específica (ex.: pediu 30, o menor é de 50):
        // o texto fala da quantidade do pacote enviado, não da pedida.
        pdfGuestCount = typeof firstPdf.guest_count === 'number' ? firstPdf.guest_count : null;
        const guestsText = pdfGuestCount && pdfGuestCount !== guestCount ? `${pdfGuestCount} pessoas` : guestsStr;
        const pdfIntroText = texts?.pdfIntro?.trim() || fillPdfIntro(pdfIntro, {
          nome: firstNameOrEmpty(botData.nome),
          convidados: guestsText,
          empresa: companyName,
        });

        await sendText(pdfIntroText, 'pdf_intro');
        await delay(pacing ? 1500 : messageDelay / 4);

        for (let i = 0; i < pdfsToSend.length; i++) {
          const pdf = pdfsToSend[i];
          const isPkgImage = /\.(png|jpe?g|webp)(\?|$)/i.test(pdf.file_url || '');
          const cleanName = (pdf.name || 'Pacote').trim();
          if (isPkgImage) {
            // "Enviar sem legenda" (Materiais): o nome é só para a equipe — Mega Magic
            // nomeou as imagens "1"…"5" e o cliente recebia "4", "5" embaixo da foto
            await sendImage(pdf.file_url, pdf.send_without_caption ? '' : cleanName, `pdf_image_${i + 1}`);
          } else {
            const sanitizedName = cleanName.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, ' ').trim();
            const fileName = `${sanitizedName || 'Pacote'}.pdf`;
            await sendDocument(pdf.file_url, fileName, `pdf_document_${i + 1}`);
          }

          if (i < pdfsToSend.length - 1) await delay(2000);
        }

        await delay(pacing ? 2000 : messageDelay);
      }
    }

    if (sentAny) {
      await supabase.from('wapi_conversations').update({
        last_message_at: new Date().toISOString(),
        last_message_content: '📄 Materiais enviados',
        last_message_from_me: true,
      }).eq('id', conv.id);
    }

    console.log(`[Bot Materials] Auto-send complete for ${phone}. Failures: ${failedSteps.join(', ') || 'none'}`);
    return { sentAny, failedSteps, pdfGuestCount };
  } catch (err) {
    console.error('[Bot Materials] Fatal error during auto-send:', err);
    failedSteps.push('fatal_materials_error');
    return { sentAny, failedSteps, pdfGuestCount };
  }
}

