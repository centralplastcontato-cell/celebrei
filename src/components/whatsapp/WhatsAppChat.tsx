import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { getBrazilianPhoneVariants } from "@/lib/whatsappConversationHelper";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { formatMessageContent } from "@/lib/format-message";
import { LEAD_STATUS_COLORS, type LeadStatus } from "@/types/crm";
import { supabase } from "@/integrations/supabase/client";
import { deleteLeads } from "@/lib/leadDelete";
import { isAwaitingRead } from "@/lib/conversationUnread";
import { SilentInstanceBanner } from "@/components/whatsapp/SilentInstanceBanner";

// Resposta do envio de mídia: "skipped" = número em pausa; success false = o WhatsApp recusou
function assertMediaSent(response: { data?: unknown }) {
  const data = response.data as { success?: boolean; skipped?: boolean; error?: string } | null | undefined;
  if (data?.skipped) throw new Error('O número de WhatsApp está em pausa. Tente de novo mais tarde.');
  if (data && data.success === false) throw new Error(data.error || 'O WhatsApp não aceitou o arquivo.');
}

// Helper: retry automático para chamadas à Edge Function wapi-send
async function invokeWithRetry(
  body: Record<string, unknown>,
  maxRetries = 2,
  delayMs = 1500
) {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await supabase.functions.invoke("wapi-send", { body });

    if (!response.error) {
      return response;
    }

    // A função respondeu com erro (pode já ter entregue ao WhatsApp): não repete,
    // senão o cliente recebe a mensagem duas vezes. Repete só falha de rede.
    const errName = (response.error as { name?: string }).name || '';
    if (errName !== 'FunctionsFetchError' && errName !== 'FunctionsRelayError') {
      return response;
    }

    lastError = new Error(response.error.message || 'Falha ao chamar wapi-send');
    console.warn(`[invokeWithRetry] Attempt ${attempt + 1}/${maxRetries + 1} failed:`, lastError.message);

    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  throw lastError ?? new Error('Falha ao chamar wapi-send');
}

function writeWavString(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function convertAudioBufferToWavBlob(audioBuffer: AudioBuffer): Blob {
  const channelCount = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;
  const monoChannel = new Float32Array(length);

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channelData = audioBuffer.getChannelData(channelIndex);
    for (let sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
      monoChannel[sampleIndex] += channelData[sampleIndex] / channelCount;
    }
  }

  const bytesPerSample = 2;
  const dataSize = monoChannel.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeWavString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeWavString(view, 8, 'WAVE');
  writeWavString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeWavString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < monoChannel.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, monoChannel[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

async function prepareAudioBlobForWhatsApp(blob: Blob): Promise<Blob> {
  // Never re-label WebM as OGG: WhatsApp may accept the send but later mark the media as unavailable.
  // Convert browser-recorded WebM/Opus to a real WAV file so the container and MIME type match.
  const mimeBase = (blob.type || '').split(';')[0].trim().toLowerCase();

  if (mimeBase === 'audio/webm' || mimeBase === '') {
    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return blob;

    const audioContext = new AudioContextCtor();
    try {
      const audioBuffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
      return convertAudioBufferToWavBlob(audioBuffer);
    } finally {
      void audioContext.close().catch(() => undefined);
    }
  }

  return blob;
}

import { insertWithCompany, insertSingleWithCompany, getCurrentCompanyId } from "@/lib/supabase-helpers";
import { signupStatus } from "@/lib/selfSetup";
import { WhatsAppConnect } from "@/components/setup/WhatsAppConnect";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AnimatedBadge } from "@/components/ui/animated-badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { 
  Send, Search, MessageSquare, Check, CheckCheck, Clock, WifiOff, RefreshCw, AlertCircle, 
  ArrowLeft, Building2, Star, StarOff, Link2, FileText, Smile,
  Image as ImageIcon, Mic, Paperclip, Loader2, X,
  Users, ArrowRightLeft, Trash2, Eraser,
  CalendarCheck, Briefcase, FileCheck, ArrowDown, Video,
  Pencil, Copy, ChevronDown, ChevronUp, Download, Pin, PinOff, Reply,
  CheckSquare, MoreVertical, MoreHorizontal, DollarSign, Bot, PlayCircle, Info, BellOff, BellRing
} from "lucide-react";
import JSZip from "jszip";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import { LinkPreviewCard, extractFirstUrl } from "@/components/whatsapp/LinkPreviewCard";
import { useNotifications } from "@/hooks/useNotifications";
import { useChatNotificationToggle } from "@/hooks/useChatNotificationToggle";
import { useLeadPermissions } from "@/hooks/useLeadPermissions";
import { useMessagesRealtime } from "@/hooks/useMessagesRealtime";
import { useWhatsAppConnection, ConnectableInstance } from "@/hooks/useWhatsAppConnection";
import { ConnectionDialog } from "@/components/whatsapp/ConnectionDialog";
import { Plug } from "lucide-react";
// Latency monitoring removed - was causing flickering
import { format, isToday, isYesterday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EventFinancialTab } from "@/components/financial/EventFinancialTab";
import { useFinancialPermissions } from "@/hooks/useFinancialPermissions";
import { useFinancialConsent } from "@/hooks/useFinancialConsent";

interface WapiInstance {
  id: string;
  instance_id: string;
  status: string;
  unit: string | null;
  provider?: string | null;
  is_active?: boolean | null;
}

interface Conversation {
  id: string;
  instance_id: string;
  lead_id: string | null;
  remote_jid: string;
  contact_name: string | null;
  contact_phone: string;
  contact_picture: string | null;
  last_message_at: string | null;
  unread_count: number;
  is_favorite: boolean;
  is_closed: boolean;
  has_scheduled_visit: boolean;
  is_freelancer: boolean;
  is_equipe: boolean;
  last_message_content: string | null;
  last_message_from_me: boolean;
  created_at: string;
  bot_enabled: boolean | null;
  bot_step: string | null;
  bot_paused_until?: string | null;
  bot_paused_reason?: string | null;
  pinned_message_id: string | null;
  bot_data?: Record<string, unknown> | null;
}

const isConnectedStatus = (status: string | null | undefined) => status === 'connected' || status === 'degraded';

const ACTIVE_CONVERSATION_STORAGE_PREFIX = 'whatsapp:last-active-conversation';
const CONVERSATION_SCROLL_STORAGE_PREFIX = 'whatsapp:conversation-scroll';

type StoredActiveConversation = {
  conversationId: string;
  instanceId: string;
  unit: string | null;
  savedAt: number;
};

type StoredConversationScroll = {
  conversationId: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  isAtBottom: boolean;
  anchorMessageId: string | null;
  anchorOffsetTop: number;
  savedAt: number;
};

// Helper: check if a contact_name is a valid display name (not a placeholder)
const isValidContactName = (name: string | null | undefined): name is string => {
  if (!name) return false;
  const trimmed = name.trim();
  const digits = trimmed.replace(/\D/g, '');
  return (
    trimmed.length > 0 &&
    trimmed !== '.' &&
    trimmed !== '-' &&
    trimmed !== '...' &&
    trimmed !== '--' &&
    !/^[\d\s+()\-]+$/.test(trimmed) &&
    !(digits.length >= 8 && digits === trimmed.replace(/\D/g, ''))
  );
};

const isValidLeadDisplayName = (name: string | null | undefined): name is string => {
  if (!name) return false;
  const trimmed = name.trim();
  return (
    isValidContactName(trimmed) &&
    /[a-zà-úA-ZÀ-Ú]/.test(trimmed) &&
    !/\d/.test(trimmed) &&
    !/(anivers[áa]rio|\banos?\b|\bmes(es)?\b|festa|convidad)/i.test(trimmed)
  );
};

// Helper: detecta @lid não resolvido (Linked ID anônimo do WhatsApp).
// @lid = identificador interno de 13-16 dígitos SEM prefixo 55 (Brasil) ou 54 (Argentina).
// Aparece quando é a 1ª mensagem do contato ou ele usa privacidade avançada.
const isUnresolvedLidIdentifier = (
  remoteJid: string | null | undefined,
  phone: string | null | undefined,
): boolean => {
  if (remoteJid && remoteJid.includes('@lid')) return true;
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length >= 13 && !digits.startsWith('55') && !digits.startsWith('54')) return true;
  return false;
};

// Inicial da bolinha: primeira letra/número (nome começando com emoji ou símbolo
// mostrava "�", porque charAt(0) corta o emoji pela metade)
const avatarInitial = (name: string | null | undefined): string => {
  const chars = Array.from(String(name || ''));
  const letter = chars.find((c) => /[\p{L}\p{N}]/u.test(c));
  return (letter || chars[0] || '?').toUpperCase();
};

// Helper: resolve the best display name for a conversation
const getConversationDisplayName = (
  conv: { contact_name: string | null; contact_phone: string; id: string; remote_jid?: string | null },
  leadsMap: Record<string, Lead | null | undefined>
): string => {
  // 1. Prefer the real WhatsApp/contact name when it is usable.
  if (isValidContactName(conv.contact_name)) return conv.contact_name;

  // 2. Use linked lead name only when the contact name is empty/numeric/placeholder.
  const leadName = leadsMap[conv.id]?.name;
  if (isValidLeadDisplayName(leadName)) return leadName.trim();

  // 3. Grupo cujo nome ainda não veio (Evolution: o monitor busca em até 1 h)
  if (conv.remote_jid?.endsWith('@g.us')) return 'Grupo';

  // 4. @lid não resolvido → rótulo amigável em vez do ID anônimo.
  if (isUnresolvedLidIdentifier(conv.remote_jid, conv.contact_phone)) {
    return 'Contato sem identificação';
  }

  // 5. Fallback to phone
  return conv.contact_phone;
};

// Helper: normalize phone for reliable lead matching
const normalizePhoneDigits = (value: string | null | undefined): string => (value || '').replace(/\D/g, '');

const getPhoneVariants = (value: string | null | undefined): string[] => {
  const digits = normalizePhoneDigits(value);
  if (!digits) return [];

  const withoutCountryCode = digits.startsWith('55') ? digits.slice(2) : digits;
  const withCountryCode = digits.startsWith('55') ? digits : `55${digits}`;
  const variants = new Set([digits, withoutCountryCode, withCountryCode].filter(Boolean));

  if (withoutCountryCode.length === 10) {
    const withNine = `${withoutCountryCode.slice(0, 2)}9${withoutCountryCode.slice(2)}`;
    variants.add(withNine);
    variants.add(`55${withNine}`);
  }

  if (withoutCountryCode.length === 11 && withoutCountryCode[2] === '9') {
    const withoutNine = `${withoutCountryCode.slice(0, 2)}${withoutCountryCode.slice(3)}`;
    variants.add(withoutNine);
    variants.add(`55${withoutNine}`);
  }

  return Array.from(variants);
};

const getConversationDedupKey = (conv: Conversation): string => {
  if (conv.remote_jid?.endsWith('@g.us')) return `group:${conv.instance_id}:${conv.remote_jid}`;

  const digits = normalizePhoneDigits(conv.contact_phone);
  const local = digits.startsWith('55') ? digits.slice(2) : digits;
  const phoneKey = local.length === 11 && local[2] === '9'
    ? `${local.slice(0, 2)}${local.slice(3)}`
    : local;

  return `phone:${conv.instance_id}:${phoneKey || conv.remote_jid || conv.id}`;
};

const dedupeConversations = (rows: Conversation[]): Conversation[] => {
  const byKey = new Map<string, Conversation>();

  rows.forEach((conv) => {
    const key = getConversationDedupKey(conv);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, conv);
      return;
    }

    const convIsRealJid = !conv.remote_jid?.includes('@lid');
    const currentIsRealJid = !current.remote_jid?.includes('@lid');
    const convScore = (conv.lead_id ? 4 : 0) + (convIsRealJid ? 2 : 0) + (conv.contact_picture ? 1 : 0);
    const currentScore = (current.lead_id ? 4 : 0) + (currentIsRealJid ? 2 : 0) + (current.contact_picture ? 1 : 0);
    const convTime = new Date(conv.last_message_at || conv.created_at || 0).getTime();
    const currentTime = new Date(current.last_message_at || current.created_at || 0).getTime();

    if (convScore > currentScore || (convScore === currentScore && convTime > currentTime)) {
      byKey.set(key, conv);
    }
  });

  return Array.from(byKey.values()).sort((a, b) =>
    new Date(b.last_message_at || 0).getTime() - new Date(a.last_message_at || 0).getTime()
  );
};

// Helper: resolve the correct phone/JID for sending messages
// Groups use remote_jid (ends with @g.us), individuals use contact_phone
const getConversationPhone = (conv: Conversation): string => {
  if (conv.remote_jid?.endsWith('@g.us')) {
    return conv.remote_jid;
  }
  return conv.contact_phone;
};

interface Lead {
  id: string;
  name: string;
  whatsapp: string;
  unit: string | null;
  status: string;
  month: string | null;
  day_of_month: number | null;
  day_preference: string | null;
  guests: string | null;
  observacoes: string | null;
  created_at: string;
  responsavel_id: string | null;
  campaign_name: string | null;
  origem?: string | null;
  return_count?: number | null;
  last_return_at?: string | null;
}

interface MessageTemplate {
  id: string;
  name: string;
  template: string;
  is_active: boolean;
}

interface Message {
  id: string;
  conversation_id: string;
  message_id: string | null;
  from_me: boolean;
  message_type: string;
  content: string | null;
  media_url: string | null;
  status: string;
  timestamp: string;
  metadata?: Record<string, unknown> | null;
  quoted_message_id?: string | null;
  is_starred?: boolean;
}

interface WhatsAppChatProps {
  userId: string;
  allowedUnits: string[];
  initialPhone?: string | null;
  /** Conversa já conhecida (aviso que abriu o chat): abre por ela, sem procurar pelo telefone */
  initialConversationId?: string | null;
  initialDraft?: string | null;
  onPhoneHandled?: () => void;
  externalSelectedUnit?: string | null;
  onInstancesLoaded?: (instances: { id: string; unit: string | null; status: string | null; is_active: boolean }[]) => void;
  onLeadClosedMobile?: (lead: Lead) => void | Promise<void>;
  onUnreadCountChange?: () => void;
  /** false enquanto a Central mostra a aba Leads (o chat fica carregado por trás) */
  isVisible?: boolean;
  /** Celular: avisa quando uma conversa está aberta (a Central esconde o topo do app) */
  onConversationOpenChange?: (open: boolean) => void;
  /** Avisa a unidade que está aberta de verdade (o chat pode reabrir a última conversa de outra unidade) */
  onActiveUnitChange?: (unit: string) => void;
}

const isLeadCompatibleWithInstance = (lead: Lead, instanceUnit: string | null | undefined) => {
  if (!instanceUnit || !lead.unit) return true;
  return lead.unit === instanceUnit || lead.unit === "As duas";
};

const scoreLeadForConversation = (
  lead: Lead,
  conversation: Conversation,
  instanceUnit: string | null | undefined
) => {
  let score = 0;
  const normalizedConversationPhone = normalizePhoneDigits(conversation.contact_phone);
  const normalizedLeadPhone = normalizePhoneDigits(lead.whatsapp);

  if (normalizedConversationPhone && normalizedLeadPhone) {
    if (normalizedConversationPhone === normalizedLeadPhone) {
      score += 20;
    } else if (
      normalizedConversationPhone.endsWith(normalizedLeadPhone) ||
      normalizedLeadPhone.endsWith(normalizedConversationPhone)
    ) {
      score += 10;
    }
  }

  if (lead.unit === instanceUnit) score += 6;
  else if (lead.unit === "As duas") score += 4;
  else if (lead.unit) score -= 4;

  if (conversation.lead_id && lead.id === conversation.lead_id) score += 4;
  if (lead.status === "transferido") score -= 3;

  return score;
};

const resolveBestLeadForConversation = (
  conversation: Conversation,
  candidates: Lead[],
  instanceUnit: string | null | undefined
): Lead | null => {
  const uniqueCandidates = candidates.filter(
    (lead, index, array) => array.findIndex((item) => item.id === lead.id) === index
  );

  if (uniqueCandidates.length === 0) return null;

  // If conversation has a direct lead_id link, always honor it regardless of unit
  const directLinked = uniqueCandidates.find(l => l.id === conversation.lead_id);
  if (directLinked) return directLinked;

  // Use all candidates but prioritize unit-compatible ones via scoring
  // Lead status (fechado, visita, etc.) is universal across all units
  return (
    uniqueCandidates.sort((a, b) => {
      const scoreDiff = scoreLeadForConversation(b, conversation, instanceUnit) - scoreLeadForConversation(a, conversation, instanceUnit);
      if (scoreDiff !== 0) return scoreDiff;

      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    })[0] || null
  );
};

// Component for displaying media with auto-download capability
import { MediaMessage } from "@/components/whatsapp/MediaMessage";
import { ConversationStatusActions } from "@/components/whatsapp/ConversationStatusActions";
import { ConversationFilters, FilterType } from "@/components/whatsapp/ConversationFilters";
import { AiConversationBadge, NeedsReplyTag } from "@/components/whatsapp/AiConversationBadge";
import { useAwaitingTeamReply } from "@/hooks/useAwaitingTeamReply";
import { MessageReactions } from "@/components/whatsapp/MessageReactions";
import { groupReactions } from "@/lib/messageReactions";
import { aiConversationState, dismissAiHandoff, friendlyLastMessage } from "@/lib/aiConversation";
import { LeadInfoPopover } from "@/components/whatsapp/LeadInfoPopover";
import { LeadDetailSheet } from "@/components/admin/LeadDetailSheet";
import { ContactInfoSheet } from "@/components/whatsapp/ContactInfoSheet";
import { SalesMaterialsMenu } from "@/components/whatsapp/SalesMaterialsMenu";
import { ShareToGroupDialog } from "@/components/whatsapp/ShareToGroupDialog";
import { QuickVisitDialog } from "@/components/whatsapp/QuickVisitDialog";
import { VisitFormDialog } from "@/components/visitas/VisitFormDialog";
import { FollowUpChip, isAutomationMessage } from "@/components/whatsapp/FollowUpChip";
import { AutomationTimelineSheet } from "@/components/whatsapp/AutomationTimelineSheet";
import { useFilterOrder } from "@/hooks/useFilterOrder";
import { useDraftMessages } from "@/hooks/useDraftMessages";
import { configureWapiWebhooks } from "@/lib/wapi-webhook-config";
import { useInstancePermissions } from "@/hooks/useInstancePermissions";
import { formatPhoneBR } from "@/lib/mask-utils";
import { senderDot, senderTag } from "@/lib/messageSender";
import { ClientDataBar } from "./ClientDataBar";
import { type ClientDataRequestRow, clientDataLabel, clientDataState, latestClientDataByLead } from "@/lib/clientDataRequest";

/** Figurinha; endereço expirado (figurinhas antigas) vira 🎭 em vez da imagem quebrada */
function StickerImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className="text-2xl">🎭</div>;
  return (
    <img
      src={src}
      alt="Figurinha"
      className="w-32 h-32 object-contain bg-transparent"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export function WhatsAppChat({ userId, allowedUnits, initialPhone, initialConversationId, initialDraft, onPhoneHandled, externalSelectedUnit, onInstancesLoaded, onLeadClosedMobile, onUnreadCountChange, isVisible = true, onConversationOpenChange, onActiveUnitChange }: WhatsAppChatProps) {
  const { currentCompany } = useCompany();
  const { canViewAllInstances, allowedInstanceIds, isLoading: isLoadingInstancePerms } = useInstancePermissions(userId);
  const [instances, setInstances] = useState<WapiInstance[]>([]);
  const [selectedInstance, setSelectedInstance] = useState<WapiInstance | null>(null);
  const [instanceConversationCounts, setInstanceConversationCounts] = useState<Record<string, number>>({});
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // Lista já carregada (e de qual unidade): abrir uma conversa por telefone
  // na mesma unidade não precisa apagar e recarregar a lista inteira
  const conversationsCountRef = useRef(0);
  conversationsCountRef.current = conversations.length;
  const loadedListKeyRef = useRef<string | null>(null);
  // Versao da busca de conversas: invalida respostas atrasadas de uma instancia
  // anterior (trocar VENDAS 1 -> 2 nao pode deixar a lista antiga sobrescrever a nova).
  const conversationsFetchSeqRef = useRef(0);
  // Seq da busca por telefone mais recente (abertura de conversa via "phone")
  const phoneFetchSeqRef = useRef(0);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  // Reações aparecem embaixo da mensagem que receberam, não como balão separado
  const { reactionsByMessage, hiddenIds: hiddenReactionIds } = useMemo(() => groupReactions(messages), [messages]);
  const displayMessages = useMemo(
    () => (hiddenReactionIds.size ? messages.filter((m) => !hiddenReactionIds.has(m.id)) : messages),
    [messages, hiddenReactionIds],
  );
  const [newMessage, setNewMessageRaw] = useState("");
  const { getDraft, saveDraft, clearDraft } = useDraftMessages();
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevConversationIdRef = useRef<string | null>(null);
  // Dedicated ref for active conversation ID — used to guard async callbacks (fetch, send, realtime)
  const activeConversationIdRef = useRef<string | null>(null);
  // Wrapper that also saves draft with debounce
  const setNewMessage = useCallback((valueOrFn: string | ((prev: string) => string)) => {
    setNewMessageRaw((prev) => {
      const next = typeof valueOrFn === 'function' ? valueOrFn(prev) : valueOrFn;
      return next;
    });
  }, []);
  // Renderiza SO o layout em uso (mobile OU desktop). Antes os dois eram
  // montados juntos (escondidos por CSS), dobrando o custo de cada render —
  // no iPad isso deixava a digitacao visivelmente lenta.
  const [isNarrowLayout, setIsNarrowLayout] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < 768 : false
  );
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const onChange = () => setIsNarrowLayout(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  const [isLoading, setIsLoading] = useState(true);
  const [hasAttemptedLoad, setHasAttemptedLoad] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(true); // Assume there are more until proven otherwise
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [oldestMessageTimestamp, setOldestMessageTimestamp] = useState<string | null>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const oldestMessageTimestampRef = useRef<string | null>(null);
  const externalSelectedUnitRef = useRef(externalSelectedUnit);
  externalSelectedUnitRef.current = externalSelectedUnit;
  const previousExternalSelectedUnitRef = useRef<string | null | undefined>(externalSelectedUnit);
  // Unidade para onde a abertura por telefone trocou sozinha (o topo acompanha depois)
  const phoneUnitSwitchRef = useRef<string | null>(null);

  const activeConversationStorageKey = useMemo(() => {
    const companyId = currentCompany?.id || getCurrentCompanyId();
    return `${ACTIVE_CONVERSATION_STORAGE_PREFIX}:${companyId}:${userId}`;
  }, [currentCompany?.id, userId]);

  const conversationScrollStoragePrefix = useMemo(() => {
    const companyId = currentCompany?.id || getCurrentCompanyId();
    return `${CONVERSATION_SCROLL_STORAGE_PREFIX}:${companyId}:${userId}`;
  }, [currentCompany?.id, userId]);

  const readLastActiveConversation = useCallback((): StoredActiveConversation | null => {
    try {
      const raw = localStorage.getItem(activeConversationStorageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<StoredActiveConversation>;
      if (!parsed.conversationId || !parsed.instanceId) return null;
      // Avoid reopening very old conversations after a new work session.
      if (parsed.savedAt && Date.now() - parsed.savedAt > 24 * 60 * 60 * 1000) return null;
      return {
        conversationId: parsed.conversationId,
        instanceId: parsed.instanceId,
        unit: parsed.unit ?? null,
        savedAt: parsed.savedAt ?? 0,
      };
    } catch {
      return null;
    }
  }, [activeConversationStorageKey]);

  const clearLastActiveConversation = useCallback(() => {
    try {
      localStorage.removeItem(activeConversationStorageKey);
    } catch {
      // ignore storage errors
    }
  }, [activeConversationStorageKey]);

  const persistActiveConversation = useCallback((conversation: Conversation) => {
    try {
      const unit = selectedInstance?.id === conversation.instance_id
        ? selectedInstance.unit
        : instances.find((instance) => instance.id === conversation.instance_id)?.unit ?? selectedInstance?.unit ?? null;

      localStorage.setItem(activeConversationStorageKey, JSON.stringify({
        conversationId: conversation.id,
        instanceId: conversation.instance_id,
        unit,
        savedAt: Date.now(),
      } satisfies StoredActiveConversation));
    } catch {
      // ignore storage errors
    }
  }, [activeConversationStorageKey, instances, selectedInstance?.id, selectedInstance?.unit]);

  const pickBestInstance = useCallback((list: WapiInstance[], countsMap = instanceConversationCounts) => {
    return [...list].sort((a, b) => {
      // Active instances first (is_active !== false)
      const activeScore = (i: WapiInstance) => (i as any).is_active === false ? 0 : 1;
      const activeDiff = activeScore(b) - activeScore(a);
      if (activeDiff !== 0) return activeDiff;

      const statusScore = (instance: WapiInstance) => instance.status === 'connected' ? 2 : instance.status === 'degraded' ? 1 : 0;
      const statusDiff = statusScore(b) - statusScore(a);
      if (statusDiff !== 0) return statusDiff;

      // Prefer Z-API over W-API before conversation volume (newer provider, usually the active sending connection)
      if (a.provider === 'zapi' && b.provider !== 'zapi') return -1;
      if (b.provider === 'zapi' && a.provider !== 'zapi') return 1;

      const countDiff = (countsMap[b.id] || 0) - (countsMap[a.id] || 0);
      if (countDiff !== 0) return countDiff;
      return 0;
    })[0] || null;
  }, [instanceConversationCounts]);

  // Deduplicate instances by unit, keeping the best one per unit (for header/selector display).
  // Inactive instances and W-API duplicates of the same unit are hidden, but the raw `instances`
  // list still contains them so historical conversations remain accessible.
  const visibleInstances = useMemo(() => {
    const byUnit = new Map<string, WapiInstance[]>();
    instances.forEach((inst) => {
      const key = inst.unit || '__no_unit__';
      if (!byUnit.has(key)) byUnit.set(key, []);
      byUnit.get(key)!.push(inst);
    });
    const result: WapiInstance[] = [];
    byUnit.forEach((list) => {
      const best = pickBestInstance(list);
      if (best) result.push(best);
    });
    return result.sort((a, b) => (a.unit || '').localeCompare(b.unit || ''));
  }, [instances, pickBestInstance]);

  // Sync with external unit selection from header
  useEffect(() => {
    if (!externalSelectedUnit || instances.length === 0) {
      previousExternalSelectedUnitRef.current = externalSelectedUnit;
      return;
    }

    // Abertura de conversa por telefone em andamento: esta sincronizacao nao
    // pode invalidar a busca nem fechar a conversa que esta sendo aberta
    if (initialPhone) {
      previousExternalSelectedUnitRef.current = externalSelectedUnit;
      return;
    }

    const previousExternalSelectedUnit = previousExternalSelectedUnitRef.current;
    const didExternalUnitChange = previousExternalSelectedUnit !== externalSelectedUnit;
    previousExternalSelectedUnitRef.current = externalSelectedUnit;

    // O topo só passou a mostrar a unidade que já está aberta: nada a trocar
    if (selectedInstance?.unit === externalSelectedUnit) {
      phoneUnitSwitchRef.current = null;
      return;
    }

    // Abriu por telefone uma conversa de outra unidade (aviso do sino) e o topo
    // ainda não acompanhou: não volta para a unidade antiga (Patrícia, 27/10:
    // a conversa do VENDAS 2 abria e fechava com o topo em VENDAS 3)
    if (!didExternalUnitChange && phoneUnitSwitchRef.current && selectedInstance?.unit === phoneUnitSwitchRef.current) return;
    phoneUnitSwitchRef.current = null;

    const storedConversation = readLastActiveConversation();
    // On remount/focus return, restore the last open chat before honoring
    // a possibly stale header unit selection. Only a real unit change should
    // intentionally close the current conversation.
    if (storedConversation && (!selectedConversation || !didExternalUnitChange)) return;

    const match = pickBestInstance(instances.filter(i => i.unit === externalSelectedUnit));
    if (match && match.id !== selectedInstance?.id) {
      const shouldClearStoredConversation = !!selectedConversation;
      conversationsFetchSeqRef.current++; // invalida buscas em andamento da instancia anterior
      setSelectedInstance(match);
      if (shouldClearStoredConversation) clearLastActiveConversation();
      setSelectedConversation(null);
      setMessages([]);
      setConversations([]);
    }
  }, [externalSelectedUnit, instances, selectedInstance?.id, selectedInstance?.unit, selectedConversation, initialPhone, pickBestInstance, clearLastActiveConversation, readLastActiveConversation]);

  const [hasUserScrolledToTop, setHasUserScrolledToTop] = useState(false); // Track if user manually scrolled to top
  const [isAtBottom, setIsAtBottom] = useState(true); // Track if scroll is at bottom (for scroll-to-bottom button visibility)
  const [unreadNewMessagesCount, setUnreadNewMessagesCount] = useState(0); // Count of new messages while scrolled up
  const [isSending, setIsSending] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<FilterType>('all');
  const [monthFilter, setMonthFilter] = useState<string>('all');
  const [isSearchBarCollapsed, setIsSearchBarCollapsed] = useState(true);
  const { filterOrder, setFilterOrder: saveFilterOrder } = useFilterOrder(userId);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [pendingSendAudio, setPendingSendAudio] = useState(false);
  const [mediaPreview, setMediaPreview] = useState<{
    type: 'image' | 'audio' | 'document' | 'video';
    file: File;
    preview?: string;
  } | null>(null);
  const [mediaCaption, setMediaCaption] = useState("");
  const [linkedLead, setLinkedLead] = useState<Lead | null>(null);
  const [isCreatingLead, setIsCreatingLead] = useState(false);
  const [showTransferDialog, setShowTransferDialog] = useState(false);
  const [responsaveis, setResponsaveis] = useState<{user_id: string; full_name: string}[]>([]);
  const [selectedTransferUserId, setSelectedTransferUserId] = useState<string>("");
  const [isTransferring, setIsTransferring] = useState(false);
  const [currentUserName, setCurrentUserName] = useState<string>("");
  const [showDeleteConfirmDialog, setShowDeleteConfirmDialog] = useState(false);
  const [showLeadDetailSheet, setShowLeadDetailSheet] = useState(false);
  const [showContactInfoSheet, setShowContactInfoSheet] = useState(false);
  const [showAutomationTimeline, setShowAutomationTimeline] = useState(false);
  const [showShareToGroupDialog, setShowShareToGroupDialog] = useState(false);
  const [showQuickVisitDialog, setShowQuickVisitDialog] = useState(false);
  const [quickVisitType, setQuickVisitType] = useState<"visita" | "atendimento">("visita");
  const [visitRefreshKey, setVisitRefreshKey] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [leadEventId, setLeadEventId] = useState<string | null>(null);
  const [leadEventValue, setLeadEventValue] = useState<number>(0);
  const [showFinancialSheet, setShowFinancialSheet] = useState(false);
  
  // Contact sharing state
  const [showContactDialog, setShowContactDialog] = useState(false);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [isSendingContact, setIsSendingContact] = useState(false);
  
  // Create new contact state
  const [showCreateContactDialog, setShowCreateContactDialog] = useState(false);
  const [newContactName, setNewContactName] = useState("");
  const [newContactPhone, setNewContactPhone] = useState("");
  const [isCreatingContact, setIsCreatingContact] = useState(false);
  
  // Edit message state
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  
  // Reply (quote) state
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);

  // Quick connect shortcut from banners
  const connection = useWhatsAppConnection(() => {
    fetchInstances();
  });

  const handleQuickConnect = useCallback(async () => {
    if (!selectedInstance) return;
    const companyId = localStorage.getItem('selected_company_id') || 'a0000000-0000-0000-0000-000000000001';
    const { data } = await supabase
      .from('wapi_instances')
      .select('id, instance_id, instance_token, status, phone_number, unit, provider')
      .eq('id', selectedInstance.id)
      .eq('company_id', companyId)
      .single();
    if (data) {
      connection.openDialog(data as ConnectableInstance);
    }
  }, [selectedInstance, connection]);
  
  // Multi-select image download state
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedMediaIds, setSelectedMediaIds] = useState<Set<string>>(new Set());
  const [isBatchDownloading, setIsBatchDownloading] = useState(false);
  
  // Message search state
  const [messageSearchActive, setMessageSearchActive] = useState(false);
  const [messageSearchQuery, setMessageSearchQuery] = useState("");
  const [currentSearchIndex, setCurrentSearchIndex] = useState(0);
  const messageSearchInputRef = useRef<HTMLInputElement>(null);
  
  const messageSearchResults = messageSearchQuery.length >= 2
    ? messages.filter(m => m.content && m.content.toLowerCase().includes(messageSearchQuery.toLowerCase())).map(m => m.id)
    : [];
  
  // Clear message search and select mode when conversation changes
  useEffect(() => {
    setMessageSearchActive(false);
    setMessageSearchQuery("");
    setCurrentSearchIndex(0);
    setIsSelectMode(false);
    setSelectedMediaIds(new Set());
  }, [selectedConversation?.id]);

  // Toggle media selection
  const toggleMediaSelection = useCallback((msgId: string) => {
    setSelectedMediaIds(prev => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
  }, []);

  // Select all images in current conversation
  const selectAllImages = useCallback(() => {
    const imageIds = messages
      .filter(m => m.message_type === 'image' && m.media_url && !m.media_url.includes('.enc'))
      .map(m => m.id);
    setSelectedMediaIds(new Set(imageIds));
  }, [messages]);

  // Batch download selected images as ZIP
  const handleBatchDownload = useCallback(async () => {
    if (selectedMediaIds.size === 0) return;
    setIsBatchDownloading(true);

    try {
      const zip = new JSZip();
      const selectedMessages = messages.filter(m => selectedMediaIds.has(m.id) && m.media_url);
      let index = 0;

      for (const msg of selectedMessages) {
        try {
          const response = await fetch(msg.media_url!);
          if (!response.ok) continue;
          const blob = await response.blob();
          const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
          const timestamp = format(new Date(msg.timestamp), 'yyyyMMdd_HHmmss');
          zip.file(`imagem_${timestamp}_${index + 1}.${ext}`, blob);
          index++;
        } catch {
          console.warn(`Failed to fetch image ${msg.id}`);
        }
      }

      if (index === 0) {
        toast({ title: "Nenhuma imagem disponível", description: "As imagens selecionadas não puderam ser baixadas.", variant: "destructive" });
        return;
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const convName = selectedConversation?.contact_name || 'imagens';
      const safeName = convName.replace(/[^a-zA-Z0-9À-ú]/g, '_').slice(0, 30);
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName}_${format(new Date(), 'yyyyMMdd')}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast({ title: "Download concluído", description: `${index} imagem(ns) baixada(s) com sucesso.` });
      setIsSelectMode(false);
      setSelectedMediaIds(new Set());
    } catch (err) {
      console.error('Batch download error:', err);
      toast({ title: "Erro no download", description: "Ocorreu um erro ao baixar as imagens.", variant: "destructive" });
    } finally {
      setIsBatchDownloading(false);
    }
  }, [selectedMediaIds, messages, selectedConversation, toast]);

  // Batch download selected images individually (one file per image)
  const handleBatchDownloadIndividual = useCallback(async () => {
    if (selectedMediaIds.size === 0) return;
    setIsBatchDownloading(true);

    try {
      const selectedMessages = messages.filter(m => selectedMediaIds.has(m.id) && m.media_url);
      let downloaded = 0;

      for (const msg of selectedMessages) {
        try {
          const response = await fetch(msg.media_url!);
          if (!response.ok) continue;
          const blob = await response.blob();
          const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
          const timestamp = format(new Date(msg.timestamp), 'yyyyMMdd_HHmmss');
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `imagem_${timestamp}_${downloaded + 1}.${ext}`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          downloaded++;
          // Small delay between downloads to avoid browser blocking
          if (downloaded < selectedMessages.length) {
            await new Promise(r => setTimeout(r, 300));
          }
        } catch {
          console.warn(`Failed to fetch image ${msg.id}`);
        }
      }

      if (downloaded === 0) {
        toast({ title: "Nenhuma imagem disponível", description: "As imagens selecionadas não puderam ser baixadas.", variant: "destructive" });
        return;
      }

      toast({ title: "Download concluído", description: `${downloaded} imagem(ns) salva(s) individualmente.` });
      setIsSelectMode(false);
      setSelectedMediaIds(new Set());
    } catch (err) {
      console.error('Individual download error:', err);
      toast({ title: "Erro no download", description: "Ocorreu um erro ao baixar as imagens.", variant: "destructive" });
    } finally {
      setIsBatchDownloading(false);
    }
  }, [selectedMediaIds, messages, toast]);

  // Navigate search results
  const navigateSearchResult = useCallback((direction: 'prev' | 'next') => {
    if (messageSearchResults.length === 0) return;
    const newIndex = direction === 'next'
      ? (currentSearchIndex + 1) % messageSearchResults.length
      : (currentSearchIndex - 1 + messageSearchResults.length) % messageSearchResults.length;
    setCurrentSearchIndex(newIndex);
    const el = document.getElementById(`msg-${messageSearchResults[newIndex]}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [messageSearchResults, currentSearchIndex]);

  // Auto-scroll to first result when query changes
  useEffect(() => {
    if (messageSearchResults.length > 0) {
      setCurrentSearchIndex(0);
      const el = document.getElementById(`msg-${messageSearchResults[0]}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [messageSearchQuery]);

  const openMessageSearch = useCallback(() => {
    setMessageSearchActive(true);
    setTimeout(() => messageSearchInputRef.current?.focus(), 100);
  }, []);

  const closeMessageSearch = useCallback(() => {
    setMessageSearchActive(false);
    setMessageSearchQuery("");
    setCurrentSearchIndex(0);
  }, []);

  const [mobileStatusExpanded, setMobileStatusExpanded] = useState(false);
  
  // Undo send state
  
  const [conversationLeadsMap, setConversationLeadsMap] = useState<Record<string, Lead | null>>({});
  // Dados do contrato pendentes/atrasados: etiqueta na lista de conversas
  const [clientDataByLead, setClientDataByLead] = useState<Map<string, ClientDataRequestRow>>(new Map());
  const clientDataLeadKey = useMemo(
    () => Object.values(conversationLeadsMap).filter((l): l is Lead => !!l && l.status === "fechado").map((l) => l.id).sort().join(","),
    [conversationLeadsMap],
  );
  useEffect(() => {
    if (!clientDataLeadKey) { setClientDataByLead(new Map()); return; }
    let cancelled = false;
    latestClientDataByLead(clientDataLeadKey.split(",")).then((m) => { if (!cancelled) setClientDataByLead(m); });
    return () => { cancelled = true; };
  }, [clientDataLeadKey]);
  const leadStatusConversationIds = useMemo(() => {
    const statusMap = {
      fechado: new Set<string>(),
      orcamento_enviado: new Set<string>(),
      em_contato: new Set<string>(),
    };

    conversations.forEach((conv) => {
      const lead = conversationLeadsMap[conv.id];
      if (!lead) return;

      if (lead.status === 'fechado') statusMap.fechado.add(conv.id);
      if (lead.status === 'orcamento_enviado') statusMap.orcamento_enviado.add(conv.id);
      if (lead.status === 'em_contato') statusMap.em_contato.add(conv.id);
    });

    return statusMap;
  }, [conversations, conversationLeadsMap]);
  const instanceUnitMap = useMemo(() => {
    const map: Record<string, string> = {};
    instances.forEach(inst => { if (inst.unit) map[inst.id] = inst.unit; });
    return map;
  }, [instances]);
  const scrollAreaDesktopRef = useRef<HTMLDivElement>(null);
  const scrollAreaMobileRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const messageTextareaRef = useRef<HTMLTextAreaElement>(null);
  // Celular: a caixa de texto cresce com a mensagem (até metade da tela), como no WhatsApp.
  // Antes ficava com uma linha e cortava o começo do texto.
  useEffect(() => {
    const el = messageTextareaRef.current;
    if (!el || !isNarrowLayout) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [newMessage, isNarrowLayout, selectedConversation?.id]);
  const isLoadingMoreRef = useRef(false);
  const scrollSaveRafRef = useRef<number | null>(null);
  const skipNextMessageAutoScrollRef = useRef<string | null>(null);
  const scrollRestoreLoadingRef = useRef(false);
  const scrollRestoreAttemptsRef = useRef(0);

  const getActiveMessagesViewport = useCallback((): HTMLElement | null => {
    const desktopViewport = scrollAreaDesktopRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null;
    const mobileViewport = scrollAreaMobileRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null;
    if (desktopViewport && desktopViewport.clientHeight > 0) return desktopViewport;
    if (mobileViewport && mobileViewport.clientHeight > 0) return mobileViewport;
    return desktopViewport || mobileViewport;
  }, []);

  const getConversationScrollStorageKey = useCallback((conversationId: string) => {
    return `${conversationScrollStoragePrefix}:${conversationId}`;
  }, [conversationScrollStoragePrefix]);

  const readConversationScroll = useCallback((conversationId: string): StoredConversationScroll | null => {
    try {
      const key = getConversationScrollStorageKey(conversationId);
      const raw = localStorage.getItem(key) || sessionStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<StoredConversationScroll>;
      if (!parsed.conversationId || parsed.conversationId !== conversationId) return null;
      if (parsed.savedAt && Date.now() - parsed.savedAt > 12 * 60 * 60 * 1000) return null;
      return {
        conversationId,
        scrollTop: Number(parsed.scrollTop) || 0,
        scrollHeight: Number(parsed.scrollHeight) || 0,
        clientHeight: Number(parsed.clientHeight) || 0,
        isAtBottom: Boolean(parsed.isAtBottom),
        anchorMessageId: parsed.anchorMessageId ?? null,
        anchorOffsetTop: Number(parsed.anchorOffsetTop) || 0,
        savedAt: parsed.savedAt ?? 0,
      };
    } catch {
      return null;
    }
  }, [getConversationScrollStorageKey]);

  const saveConversationScroll = useCallback((conversationId: string | null = activeConversationIdRef.current) => {
    if (!conversationId) return;
    const viewport = getActiveMessagesViewport();
    if (!viewport || viewport.clientHeight === 0) return;

    const { scrollTop, scrollHeight, clientHeight } = viewport;
    const isNearBottom = scrollHeight - scrollTop - clientHeight <= 120;
    const viewportRect = viewport.getBoundingClientRect();
    const messageElements = Array.from(viewport.querySelectorAll<HTMLElement>('[id^="msg-"]'));
    const anchorElement = messageElements.find((element) => element.getBoundingClientRect().bottom >= viewportRect.top + 8) || null;
    const anchorMessageId = anchorElement?.id.replace(/^msg-/, '') || null;
    const anchorOffsetTop = anchorElement ? anchorElement.getBoundingClientRect().top - viewportRect.top : 0;

    try {
      localStorage.setItem(getConversationScrollStorageKey(conversationId), JSON.stringify({
        conversationId,
        scrollTop,
        scrollHeight,
        clientHeight,
        isAtBottom: isNearBottom,
        anchorMessageId,
        anchorOffsetTop,
        savedAt: Date.now(),
      } satisfies StoredConversationScroll));
    } catch {
      // ignore storage errors
    }
  }, [getActiveMessagesViewport, getConversationScrollStorageKey]);

  const restoreConversationScroll = useCallback((conversationId: string): boolean => {
    const savedScroll = readConversationScroll(conversationId);
    if (!savedScroll || savedScroll.isAtBottom) return false;

    const restore = () => {
      const viewport = getActiveMessagesViewport();
      if (!viewport) return;

      const anchorElement = savedScroll.anchorMessageId
        ? document.getElementById(`msg-${savedScroll.anchorMessageId}`)
        : null;

      if (anchorElement) {
        anchorElement.scrollIntoView({ behavior: 'auto', block: 'start' });
        viewport.scrollTop += savedScroll.anchorOffsetTop;
      } else {
        const maxScrollTop = Math.max(viewport.scrollHeight - viewport.clientHeight, 0);
        const proportionalTop = savedScroll.scrollHeight > savedScroll.clientHeight
          ? (savedScroll.scrollTop / (savedScroll.scrollHeight - savedScroll.clientHeight)) * maxScrollTop
          : savedScroll.scrollTop;
        viewport.scrollTop = Math.max(0, Math.min(proportionalTop, maxScrollTop));
      }

      const nearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 120;
      setIsAtBottom(nearBottom);
      if (nearBottom) setUnreadNewMessagesCount(0);
    };

    restore();
    requestAnimationFrame(restore);
    [80, 250, 600].forEach((delay) => setTimeout(restore, delay));
    return true;
  }, [getActiveMessagesViewport, readConversationScroll]);

  // Audio recording hook
  const {
    isRecording,
    recordingTime,
    audioBlob,
    startRecording,
    stopRecording,
    cancelRecording,
    error: recordingError,
  } = useAudioRecorder({ maxDuration: 120 });

  // Permissões (regras em src/lib/leadPermissions.ts): nada fica liberado enquanto carregam
  const leadPerms = useLeadPermissions(userId);
  const financialPerms = useFinancialPermissions(userId);
  const consentHookChat = useFinancialConsent();
  const canTransferLeads = leadPerms.canTransferLeads;
  const canDeleteFromChat = leadPerms.canDeleteFromChat;
  const canSendMessages = leadPerms.allow('whatsapp.send');
  const canSendMaterials = leadPerms.allow('whatsapp.materials');
  const canSendAudio = leadPerms.allow('whatsapp.audio');
  const canCloseConversations = leadPerms.allow('whatsapp.close');
  const canFavoriteConversations = leadPerms.allow('whatsapp.favorite');
  const canToggleBot = leadPerms.allow('whatsapp.bot.toggle');
  const canShareToGroup = leadPerms.allow('whatsapp.share.group');
  const selectedUnitInstances = useMemo(() => {
    if (!selectedInstance) return [];
    return instances.filter((instance) => instance.unit === selectedInstance.unit);
  }, [instances, selectedInstance?.unit]);
  const selectedSendInstance = useMemo(() => {
    if (!selectedInstance) return null;
    const connectedSameUnit = selectedUnitInstances.filter((instance) => instance.is_active !== false && isConnectedStatus(instance.status));
    return pickBestInstance(connectedSameUnit) || (selectedInstance.is_active !== false && isConnectedStatus(selectedInstance.status) ? selectedInstance : null);
  }, [selectedInstance, selectedUnitInstances, pickBestInstance]);
  // Números (instâncias) da unidade aberta. A lista só muda quando mudam os números,
  // não quando muda o status de um deles: antes cada conferência de conexão apagava
  // e recarregava todas as conversas.
  const selectedUnitInstanceIdsKey = useMemo(() => {
    if (!selectedInstance) return "";
    const ids = selectedUnitInstances.map((instance) => instance.id);
    return (ids.length > 0 ? ids : [selectedInstance.id]).join(",");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- de propósito pelo id: o status do número não importa aqui
  }, [selectedInstance?.id, selectedUnitInstances]);
  const selectedUnitInstanceIds = useMemo(
    () => (selectedUnitInstanceIdsKey ? selectedUnitInstanceIdsKey.split(",") : []),
    [selectedUnitInstanceIdsKey],
  );
  const webhookConfiguredInstanceIdsRef = useRef<Set<string>>(new Set());
  const canUseSelectedInstanceForSending = !!selectedSendInstance;

  useEffect(() => {
    const connectedZapiInstances = instances.filter(
      (instance) => instance.provider === 'zapi' && instance.is_active !== false && isConnectedStatus(instance.status)
    );

    connectedZapiInstances.forEach((instance) => {
      const key = instance.id;
      if (webhookConfiguredInstanceIdsRef.current.has(key)) return;
      webhookConfiguredInstanceIdsRef.current.add(key);

      void configureWapiWebhooks(instance.instance_id, null, `chat-open-${instance.unit || instance.id}`).then((ok) => {
        if (!ok) webhookConfiguredInstanceIdsRef.current.delete(key);
      });
    });
  }, [instances]);

  // Notifications hook - uses shared toggle state
  const { notificationsEnabled } = useChatNotificationToggle();
  
  const { notify: notifyFn, requestPermission, hasPermission: hasBrowserPermission } = useNotifications({
    soundEnabled: notificationsEnabled,
    browserNotificationsEnabled: notificationsEnabled,
  });
  const notifyRef = useRef(notifyFn);
  notifyRef.current = notifyFn;

  // Request notification permission on mount if enabled
  useEffect(() => {
    if (notificationsEnabled && 'Notification' in window && Notification.permission === 'default') {
      requestPermission();
    }
  }, [notificationsEnabled, requestPermission]);

  // Format recording time as MM:SS
  const formatRecordingTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Refs for bottom markers
  const bottomRefDesktop = useRef<HTMLDivElement>(null);
  const bottomRefMobile = useRef<HTMLDivElement>(null);

  // Scroll to bottom using bottomRef (most reliable for Safari/iOS)
  const scrollToBottomDesktop = useCallback((smooth = true) => {
    if (bottomRefDesktop.current) {
      bottomRefDesktop.current.scrollIntoView({ 
        behavior: smooth ? 'smooth' : 'auto',
        block: 'end' 
      });
    } else {
      // Fallback to direct viewport manipulation
      const viewport = scrollAreaDesktopRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    }
    setUnreadNewMessagesCount(0);
    setIsAtBottom(true);
  }, []);

  const scrollToBottomMobile = useCallback((smooth = true) => {
    if (bottomRefMobile.current) {
      bottomRefMobile.current.scrollIntoView({ 
        behavior: smooth ? 'smooth' : 'auto',
        block: 'end' 
      });
    } else {
      // Fallback to direct viewport manipulation
      const viewport = scrollAreaMobileRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    }
    setUnreadNewMessagesCount(0);
    setIsAtBottom(true);
  }, []);

  // Voltou da aba Leads para a aba Chat: o navegador pode perder a rolagem da conversa
  // enquanto ela fica escondida; volta para onde estava (ou para a última mensagem)
  useEffect(() => {
    const id = activeConversationIdRef.current;
    if (!isVisible || !id) return;
    requestAnimationFrame(() => {
      if (activeConversationIdRef.current !== id || restoreConversationScroll(id)) return;
      if (isNarrowLayout) scrollToBottomMobile(false);
      else scrollToBottomDesktop(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só quando a aba muda
  }, [isVisible]);

  useEffect(() => {
    fetchTemplates();
    fetchResponsaveis();
    fetchCurrentUserName();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch instances whenever allowedUnits OR instance permissions change
  useEffect(() => {
    if (isLoadingInstancePerms) return;
    fetchInstances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedUnits.join(','), canViewAllInstances, allowedInstanceIds.join(','), isLoadingInstancePerms]);

  const fetchCurrentUserName = async () => {
    const { data } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("user_id", userId)
      .single();
    if (data) {
      setCurrentUserName(data.full_name);
    }
  };

  const fetchResponsaveis = async () => {
    // Use the security definer function to get profiles (bypasses RLS restrictions)
    const { data, error } = await supabase.rpc('get_profiles_for_transfer');
    if (data && !error) {
      setResponsaveis(data);
    }
  };

  const handleTransferLead = async () => {
    if (!linkedLead || !selectedTransferUserId) return;

    setIsTransferring(true);

    try {
      const targetUser = responsaveis.find((r) => r.user_id === selectedTransferUserId);
      const previousResponsavel = responsaveis.find(
        (r) => r.user_id === linkedLead.responsavel_id
      );

      // Update the lead's responsavel and status
      const { error: updateError } = await supabase
        .from("campaign_leads")
        .update({ 
          responsavel_id: selectedTransferUserId,
          status: "transferido" as const
        })
        .eq("id", linkedLead.id);

      if (updateError) throw updateError;

      // --- Conversation migration: move conversation to target user's instance ---
      if (selectedConversation && selectedInstance) {
        const currentInstanceId = selectedConversation.instance_id;
        const companyId = localStorage.getItem('selected_company_id') || 'a0000000-0000-0000-0000-000000000001';

        // Step 1: Get target user's unit permissions
        const { data: targetPerms } = await supabase
          .from("user_permissions")
          .select("permission, granted")
          .eq("user_id", selectedTransferUserId)
          .like("permission", "leads.unit.%");

        const hasAll = targetPerms?.some(p => p.permission === "leads.unit.all" && p.granted);
        // If no permissions set at all, default is "all"
        const defaultAll = !targetPerms || targetPerms.length === 0;

        if (!hasAll && !defaultAll) {
          // Extract allowed unit slugs
          const allowedSlugs = targetPerms
            .filter(p => p.granted && p.permission !== "leads.unit.all")
            .map(p => p.permission.replace("leads.unit.", ""));

          // Step 2: Check if target user has access to current instance
          const { data: currentInstance } = await supabase
            .from("wapi_instances")
            .select("unit")
            .eq("id", currentInstanceId)
            .single();

          const currentUnitSlug = currentInstance?.unit?.toLowerCase() || "";
          const hasAccessToCurrent = allowedSlugs.some(s => s === currentUnitSlug);

          if (!hasAccessToCurrent && allowedSlugs.length > 0) {
            // Step 3: Find an instance the target user can access
            const { data: targetInstances } = await supabase
              .from("wapi_instances")
              .select("id, unit")
              .eq("company_id", companyId)
              .in("unit", allowedSlugs);

            if (targetInstances && targetInstances.length > 0) {
              const newInstance = targetInstances[0];

              // Move conversation to new instance
              await supabase
                .from("wapi_conversations")
                .update({ instance_id: newInstance.id })
                .eq("id", selectedConversation.id);

              // Update lead unit to match new instance
              if (newInstance.unit) {
                // Find the unit name from company_units by slug
                const { data: unitData } = await supabase
                  .from("company_units")
                  .select("name")
                  .eq("company_id", companyId)
                  .eq("slug", newInstance.unit)
                  .single();

                await supabase
                  .from("campaign_leads")
                  .update({ unit: unitData?.name || newInstance.unit })
                  .eq("id", linkedLead.id);
              }

              console.log(`[Transfer] Moved conversation ${selectedConversation.id} to instance ${newInstance.id} (unit: ${newInstance.unit})`);
            }
          }
        }
      }
      // --- End conversation migration ---

      // Add history entry
      await supabase.from("lead_history").insert({
        lead_id: linkedLead.id,
        user_id: userId,
        user_name: currentUserName,
        action: "Transferência de lead",
        old_value: previousResponsavel?.full_name || "Não atribuído",
        new_value: targetUser?.full_name || "Desconhecido",
      });

      // Create notification for the receiving user
      const statusLabels: Record<string, string> = {
        novo: 'Novo',
        em_contato: 'Visita',
        orcamento_enviado: 'Orçamento Enviado',
        aguardando_resposta: 'Negociando',
        fechado: 'Fechado',
        perdido: 'Perdido',
        fornecedor: 'Fornecedor',
        cliente_retorno: 'Cliente Retorno',
      };

      await supabase.from("notifications").insert({
        user_id: selectedTransferUserId,
        company_id: getCurrentCompanyId(),
        type: "lead_transfer",
        title: "Novo lead transferido para você",
        message: `${currentUserName} transferiu o lead "${linkedLead.name}" (${statusLabels[linkedLead.status] || linkedLead.status}) para você.`,
        data: {
          lead_id: linkedLead.id,
          lead_name: linkedLead.name,
          lead_status: linkedLead.status,
          transferred_by: currentUserName,
          transferred_by_id: userId,
        },
      });

      toast({
        title: "Lead transferido",
        description: `O lead foi transferido para ${targetUser?.full_name}.`,
      });

      setSelectedTransferUserId("");
      setShowTransferDialog(false);
    } catch (error: unknown) {
      console.error("Error transferring lead:", error);
      toast({
        title: "Erro ao transferir",
        description: error instanceof Error ? error.message : "Tente novamente.",
        variant: "destructive",
      });
    } finally {
      setIsTransferring(false);
    }
  };

  // Delete lead and its associated conversation and messages
  const handleDeleteLeadFromChat = async () => {
    if (!selectedConversation) return;
    
    setIsDeleting(true);
    
    try {
      // Find the lead to delete - use linkedLead state, or look it up
      let leadToDelete = linkedLead;

      if (!leadToDelete) {
        // Try by lead_id on the conversation
        if (selectedConversation.lead_id) {
          const { data: leadById } = await supabase
            .from('campaign_leads')
            .select('id')
            .eq('id', selectedConversation.lead_id)
            .maybeSingle();
          if (leadById) {
            leadToDelete = { id: leadById.id } as typeof linkedLead;
          }
        }

        // If still not found, try by phone number
        if (!leadToDelete && selectedConversation.contact_phone) {
          const phone = selectedConversation.contact_phone.replace(/\D/g, '');
          const { data: leadByPhone } = await supabase
            .from('campaign_leads')
            .select('id')
            .eq('company_id', getCurrentCompanyId())
            .or(`whatsapp.eq.${phone},whatsapp.eq.+${phone}`)
            .maybeSingle();
          if (leadByPhone) {
            leadToDelete = { id: leadByPhone.id } as typeof linkedLead;
          }
        }
      }

      // Exclui o lead primeiro: o histórico sai junto e a conversa fica sem lead (o banco
      // faz os dois). Sem permissão o banco não apaga: aí para aqui, sem apagar a conversa
      // nem o histórico (antes o histórico sumia e o lead continuava).
      if (leadToDelete) {
        const result = await deleteLeads([leadToDelete.id]);
        if (!result.ok) throw new Error(result.message || "Não foi possível excluir o lead.");
      }
      
      // Use SECURITY DEFINER RPC with extended timeout (60s) to delete cascade
      // (evita "canceling statement due to statement timeout" em conversas grandes)
      const { data: rpcData, error: rpcError } = await (supabase as any).rpc('delete_conversation_cascade', {
        _conversation_id: selectedConversation.id,
        _delete_lead: !!leadToDelete,
      });

      if (rpcError) {
        console.error("[Delete] RPC error:", rpcError);
        throw new Error(`Erro ao excluir conversa: ${rpcError.message}`);
      }

      const result = rpcData as { ok?: boolean; error?: string } | null;
      if (!result?.ok) {
        const errMsg = result?.error === 'forbidden'
          ? 'Você não tem permissão para excluir esta conversa.'
          : result?.error === 'conversation_not_found'
          ? 'Conversa não encontrada.'
          : `Erro ao excluir: ${result?.error || 'desconhecido'}`;
        throw new Error(errMsg);
      }
      
      // Update local state - remove conversation from list
      setConversations(prev => prev.filter(c => c.id !== selectedConversation.id));
      
      // Clear selection
      clearLastActiveConversation();
      setSelectedConversation(null);
      setMessages([]);
      setLinkedLead(null);
      
      toast({
        title: leadToDelete ? "✅ Lead excluído" : "✅ Conversa excluída",
        description: leadToDelete 
          ? "O lead, suas mensagens e a conversa foram removidos permanentemente."
          : "A conversa e suas mensagens foram removidas permanentemente.",
        className: "border-l-4",
        style: { borderLeftColor: '#ef4444' },
      });
    } catch (error: unknown) {
      console.error("[Delete] Full error:", error);
      const errorMessage = error instanceof Error ? error.message : "Não foi possível excluir. Tente novamente.";
      toast({
        title: "Erro ao excluir",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirmDialog(false);
    }
  };

  const fetchTemplates = async () => {
    const companyId = getCurrentCompanyId();
    const { data } = await supabase
      .from("message_templates")
      .select("*")
      .eq("is_active", true)
      .eq("company_id", companyId)
      .order("sort_order", { ascending: true });

    if (data) {
      setTemplates(data as MessageTemplate[]);
    }
  };

  // Track if initialPhone has been processed
  const [initialPhoneProcessed, setInitialPhoneProcessed] = useState(false);
  const initialPhoneRef = useRef(initialPhone);
  initialPhoneRef.current = initialPhone;
  const initialConversationIdRef = useRef(initialConversationId);
  initialConversationIdRef.current = initialConversationId;

  // Cada novo pedido de "abrir conversa por telefone" re-arma o processamento.
  // Sem isso, so o PRIMEIRO clique da sessao abria a conversa — os seguintes
  // disparavam a busca sem telefone e nada era selecionado.
  useEffect(() => {
    if (initialPhone) setInitialPhoneProcessed(false);
  }, [initialPhone]);
  const [draftApplied, setDraftApplied] = useState(false);

  // Ref to track selected conversation ID inside realtime callbacks without re-triggering the effect
  const selectedConversationRef = useRef<string | null>(null);
  selectedConversationRef.current = selectedConversation?.id ?? null;

  // Celular: conversa aberta ocupa a tela toda (a Central esconde o topo do app)
  const onConversationOpenChangeRef = useRef(onConversationOpenChange);
  onConversationOpenChangeRef.current = onConversationOpenChange;
  const conversationOpenOnPhone = isNarrowLayout && !!selectedConversation?.id;
  useEffect(() => {
    onConversationOpenChangeRef.current?.(conversationOpenOnPhone);
  }, [conversationOpenOnPhone]);
  useEffect(() => () => onConversationOpenChangeRef.current?.(false), []);

  // O topo da Central mostra a unidade aberta de verdade. Antes, ao reabrir a última
  // conversa (de outra unidade), o topo continuava marcando a unidade antiga.
  const onActiveUnitChangeRef = useRef(onActiveUnitChange);
  onActiveUnitChangeRef.current = onActiveUnitChange;
  useEffect(() => {
    if (selectedInstance?.unit) onActiveUnitChangeRef.current?.(selectedInstance.unit);
  }, [selectedInstance?.unit]);

  // Zera as não lidas da conversa aberta quando chega mensagem nova (com uma pausa
  // curta para juntar várias mensagens seguidas num só aviso ao banco)
  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleMarkReadRef = useRef<(convId: string) => void>(() => {});
  scheduleMarkReadRef.current = (convId: string) => {
    if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
    markReadTimerRef.current = setTimeout(() => {
      if (selectedConversationRef.current !== convId) return;
      supabase
        .from('wapi_conversations')
        .update({ unread_count: 0 })
        .eq('id', convId)
        .then(() => onUnreadCountChange?.());
    }, 800);
  };
  useEffect(() => () => {
    if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
  }, []);
  // A conversa aberta só conta como lida com o chat na tela: aba do navegador visível
  // e a Central na aba Chat (na aba Leads o chat continua carregado, mas escondido)
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;
  const chatOnScreen = () => document.visibilityState === 'visible' && isVisibleRef.current;
  // Voltou para a aba do navegador (ou para a aba Chat) com a conversa aberta: o que
  // chegou nesse tempo passa a contar como lido
  const selectedUnreadRef = useRef(0);
  selectedUnreadRef.current = selectedConversation?.unread_count || 0;
  const markOpenConversationReadRef = useRef(() => {});
  markOpenConversationReadRef.current = () => {
    const id = selectedConversationRef.current;
    if (!chatOnScreen() || !id || selectedUnreadRef.current <= 0) return;
    setConversations(prev => prev.map(c => (c.id === id ? { ...c, unread_count: 0 } : c)));
    setSelectedConversation(prev => (prev && prev.id === id ? { ...prev, unread_count: 0 } : prev));
    scheduleMarkReadRef.current(id);
  };
  useEffect(() => {
    const onVisible = () => markOpenConversationReadRef.current();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  useEffect(() => {
    if (isVisible) markOpenConversationReadRef.current();
  }, [isVisible]);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  // Keep activeConversationIdRef in sync (used by async guards)
  activeConversationIdRef.current = selectedConversation?.id ?? null;

  useEffect(() => {
    if (selectedConversation) {
      persistActiveConversation(selectedConversation);
    }
  }, [selectedConversation, persistActiveConversation]);

  useEffect(() => {
    if (selectedConversation || conversations.length === 0 || initialPhone) return;

    const storedConversation = readLastActiveConversation();
    if (!storedConversation) return;

    const restoredConversation = conversations.find((conv) => conv.id === storedConversation.conversationId);
    if (restoredConversation) {
      setSelectedConversation(restoredConversation);
    }
  }, [selectedConversation, conversations, initialPhone, readLastActiveConversation]);

  // Save/restore drafts when switching conversations (uses its own ref to avoid conflicting with fetch effect)
  const draftPrevConvIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prevId = draftPrevConvIdRef.current;
    const newId = selectedConversation?.id ?? null;

    // Save draft for previous conversation
    if (prevId && prevId !== newId) {
      setNewMessageRaw(prev => {
        saveDraft(prevId, prev);
        return prev;
      });
    }

    // Load draft for new conversation
    if (newId && newId !== prevId) {
      if (initialDraft && !draftApplied) {
        setNewMessageRaw(initialDraft);
        setDraftApplied(true);
      } else {
        const draft = getDraft(newId);
        setNewMessageRaw(draft);
      }
    }

    draftPrevConvIdRef.current = newId;
  }, [selectedConversation?.id]);

  // Debounced save on every keystroke
  useEffect(() => {
    if (!selectedConversation?.id) return;
    const convId = selectedConversation.id;

    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      saveDraft(convId, newMessage);
    }, 500);

    return () => {
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    };
  }, [newMessage, selectedConversation?.id, saveDraft]);

  // Apply initialDraft to message input when conversation is selected
  useEffect(() => {
    if (initialDraft && selectedConversation && !draftApplied) {
      setNewMessageRaw(initialDraft);
      setDraftApplied(true);
    }
  }, [initialDraft, selectedConversation, draftApplied]);

  // Reset processed flag when initialPhone changes (e.g. notification click)
  useEffect(() => {
    if (initialPhone) {
      setInitialPhoneProcessed(false);
      setDraftApplied(false);
    }
  }, [initialPhone]);

  const prevInitialPhoneRef = useRef<string | null | undefined>(initialPhone);

  useEffect(() => {
    if (selectedInstance) {
      // Skip full re-fetch when initialPhone was just cleared after being handled
      const wasPhoneJustHandled = prevInitialPhoneRef.current && !initialPhone && initialPhoneProcessed;
      prevInitialPhoneRef.current = initialPhone;

      if (wasPhoneJustHandled) {
        // Phone was handled successfully - don't clear conversations or re-fetch
      } else if (initialPhone && initialPhoneProcessed) {
        // Abertura por telefone em andamento — nao dispara uma busca concorrente
        // sem telefone, que invalidaria (isStale) a busca que vai abrir a conversa.
      } else if (initialPhone && !initialPhoneProcessed && conversationsCountRef.current > 0 && loadedListKeyRef.current === selectedUnitInstanceIds.join(",")) {
        // Lista desta unidade já está na tela: só acha e abre a conversa
        fetchConversations(initialPhone, false, true);
        setInitialPhoneProcessed(true);
      } else {
        conversationsFetchSeqRef.current++; // invalida buscas da instancia anterior
        setConversations([]);
        // Pass initialPhone only on first load if not yet processed
        if (initialPhone && !initialPhoneProcessed) {
          fetchConversations(initialPhone);
          setInitialPhoneProcessed(true);
        } else {
          fetchConversations();
        }
      }

      // Realtime channel for conversation updates
      
      const channelName = `wapi_conversations_unit_${selectedUnitInstanceIds.slice().sort().join('_')}`;
      const conversationsChannel = supabase.channel(channelName);
      selectedUnitInstanceIds.forEach((instanceId) => {
        conversationsChannel.on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'wapi_conversations',
            filter: `instance_id=eq.${instanceId}`,
          },
          (payload) => {
            console.log('[Realtime] Conversation event:', payload.eventType, payload.new);
            
            // Handle notifications immediately (no debounce for UX)
            if (payload.eventType === 'UPDATE') {
              const newData = payload.new as Conversation;
              const oldData = payload.old as Partial<Conversation>;
              
              if (
                newData.unread_count > (oldData.unread_count || 0) && 
                !newData.last_message_from_me &&
                (newData.id !== selectedConversationRef.current || !isVisibleRef.current)
              ) {
                notifyRef.current({
                  title: newData.contact_name || newData.contact_phone,
                  body: newData.last_message_content || 'Nova mensagem',
                  tag: `whatsapp-${newData.id}`,
                });
              }
            }
            
            // Update conversation locally for instant feedback
            if (payload.eventType === 'UPDATE' || payload.eventType === 'INSERT') {
              const updatedConv = { ...(payload.new as Conversation) };

              // Conversa aberta na tela: a mensagem nova já está sendo vista. Antes o
              // contador crescia com a conversa aberta e só zerava ao sair e voltar.
              if (
                updatedConv.id === selectedConversationRef.current &&
                (updatedConv.unread_count || 0) > 0 &&
                chatOnScreen()
              ) {
                updatedConv.unread_count = 0;
                scheduleMarkReadRef.current(updatedConv.id);
              }
              
              // Force immediate state update with all fields
              setConversations(prev => {
                const exists = prev.some(c => c.id === updatedConv.id);
                
                if (exists) {
                  // Update existing conversation - merge with existing data to preserve any missing fields
                  const updated = prev.map(c => {
                    if (c.id === updatedConv.id) {
                      return { 
                        ...c, 
                        ...updatedConv,
                        // Ensure critical fields are updated
                        last_message_content: updatedConv.last_message_content ?? c.last_message_content,
                        last_message_at: updatedConv.last_message_at ?? c.last_message_at,
                        unread_count: updatedConv.unread_count ?? c.unread_count,
                      };
                    }
                    return c;
                  });
                  // Re-sort by last message time
                  return dedupeConversations(updated).sort((a, b) => 
                    new Date(b.last_message_at || 0).getTime() - new Date(a.last_message_at || 0).getTime()
                  );
                } else {
                  // New conversation - add to list and sort
                  console.log('[Realtime] Adding new conversation to list');
                  return dedupeConversations([updatedConv, ...prev]).sort((a, b) => 
                    new Date(b.last_message_at || 0).getTime() - new Date(a.last_message_at || 0).getTime()
                  );
                }
              });
              
              // Also update selected conversation if it matches
              if (updatedConv.id === selectedConversationRef.current) {
                setSelectedConversation(prev => prev ? { ...prev, ...updatedConv } : null);
              }
            }
            
            // Handle DELETE events - only remove if user explicitly deleted
            // This prevents accidental removal caused by realtime race conditions
            if (payload.eventType === 'DELETE') {
              const deletedId = (payload.old as { id?: string })?.id;
              if (deletedId) {
                console.log('[Realtime] DELETE event for conversation:', deletedId, '- verifying before removing from UI');
                // Verify the conversation was actually deleted by re-checking the database
                supabase
                  .from('wapi_conversations')
                  .select('id')
                  .eq('id', deletedId)
                  .maybeSingle()
                  .then(({ data: stillExists }) => {
                    if (!stillExists) {
                      // Confirmed deleted - safe to remove from UI
                      console.log('[Realtime] Confirmed deletion of conversation:', deletedId);
                      setConversations(prev => prev.filter(c => c.id !== deletedId));
                    } else {
                      console.warn('[Realtime] DELETE event received but conversation still exists in DB - ignoring:', deletedId);
                    }
                  });
              }
            }
            
            // Safety net: no full refresh on every realtime event.
            // Inline updates above handle all cases. Full refresh removed
            // to prevent race conditions that switch the active conversation.
          }
        );
      });
      conversationsChannel.subscribe();

      return () => {
        supabase.removeChannel(conversationsChannel);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recarrega ao trocar de número, não quando muda o status dele
  }, [selectedInstance?.id, selectedUnitInstanceIds, initialPhone, initialPhoneProcessed]);

  // Track if at bottom using ref for realtime callback access
  const isAtBottomRef = useRef(true);
  isAtBottomRef.current = isAtBottom;

  // Stable callback for handling new messages from realtime - OPTIMIZED for low latency
  const handleNewRealtimeMessage = useCallback((newMessage: Message & { _realtimeReceivedAt?: number }) => {
    // Guard: ignore messages from a different conversation (race condition on fast switching)
    if (newMessage.conversation_id !== selectedConversationRef.current) {
      return;
    }

    // Minimal processing - append directly without expensive operations
    setMessages((prev) => {
      // Fast duplicate check by ID only
      if (prev.some(m => m.id === newMessage.id)) {
        return prev;
      }
      
      // Fast optimistic message replacement (check last few messages only)
      const recentStartIndex = Math.max(prev.length - 10, 0);
      const recentMessages = prev.slice(recentStartIndex);
      const optimisticIdx = recentMessages.findIndex(m => 
        m.id.startsWith('optimistic-') && 
        m.from_me && 
        newMessage.from_me &&
        m.message_type === newMessage.message_type &&
        (m.message_type !== 'text' || m.content === newMessage.content)
      );
      
      if (optimisticIdx >= 0) {
        const actualIdx = recentStartIndex + optimisticIdx;
        if (actualIdx >= 0) {
          const updated = [...prev];
          const optimisticMessage = updated[actualIdx];
          updated[actualIdx] = {
            ...newMessage,
            quoted_message_id: newMessage.quoted_message_id || optimisticMessage.quoted_message_id || null,
          };
          return updated;
        }
      }
      
      // Simply append - no sorting (messages arrive in order from webhook)
      return [...prev, newMessage];
    });

    // Increment unread counter if not at bottom and message is from contact
    if (!isAtBottomRef.current && !newMessage.from_me) {
      setUnreadNewMessagesCount(prev => prev + 1);
    }
  }, []);

  // Handle realtime UPDATE events (e.g. media_url updated after async download)
  const handleRealtimeMessageUpdate = useCallback((updatedMessage: Message & { media_url?: string | null; conversation_id?: string }) => {
    // Guard: ignore updates from a different conversation
    if (updatedMessage.conversation_id && updatedMessage.conversation_id !== selectedConversationRef.current) {
      return;
    }

    setMessages((prev) => {
      const idx = prev.findIndex(m => m.id === updatedMessage.id);
      if (idx === -1) return prev;
      const existing = prev[idx];
      // Only update when relevant fields actually changed
      if (
        existing.media_url === updatedMessage.media_url &&
        existing.status === updatedMessage.status &&
        existing.quoted_message_id === updatedMessage.quoted_message_id
      ) return prev;
      const updated = [...prev];
      updated[idx] = { ...existing, ...updatedMessage };
      return updated;
    });
  }, []);

  // Use the robust realtime hook for messages
  useMessagesRealtime({
    conversationId: selectedConversation?.id || null,
    onNewMessage: handleNewRealtimeMessage,
    onMessageUpdate: handleRealtimeMessageUpdate,
    enabled: true,
  });
  
  // Reuse prevConversationIdRef declared above for conversation change tracking
  
  // Effect for fetching data when conversation changes
  useEffect(() => {
    if (selectedConversation) {
      // If switching to a different conversation, clear messages immediately
      if (prevConversationIdRef.current !== selectedConversation.id) {
        setMessages([]);
        setLinkedLead(null);
        setReplyingTo(null);
        setIsLoadingMessages(true);
        setHasMoreMessages(true);
        setOldestMessageTimestamp(null);
        oldestMessageTimestampRef.current = null;
        setIsInitialLoad(true);
        setHasUserScrolledToTop(false);
        setIsAtBottom(true);
        setUnreadNewMessagesCount(0); // Reset unread counter on conversation change
      }
      
      // Use cached lead data if available
      const cachedLead = conversationLeadsMap[selectedConversation.id];
      
      // Start fetching messages
      fetchMessages(selectedConversation.id);
      
      // Use cached lead if available, otherwise fetch
      if (cachedLead) {
        setLinkedLead(cachedLead);
      } else if (selectedConversation.lead_id) {
        fetchLinkedLead(selectedConversation.lead_id, selectedConversation);
      } else {
        fetchLinkedLead(null, selectedConversation);
      }

      // Mark as read immediately
      if (selectedConversation.unread_count > 0) {
        setConversations(prev => 
          prev.map(c => c.id === selectedConversation.id ? { ...c, unread_count: 0 } : c)
        );
        setSelectedConversation(prev => prev ? { ...prev, unread_count: 0 } : null);
        
        supabase
          .from('wapi_conversations')
          .update({ unread_count: 0 })
          .eq('id', selectedConversation.id)
          .then(() => {
            onUnreadCountChange?.();
          });
      }
    } else {
      setLinkedLead(null);
    }
    // Track current conversation ID to prevent unnecessary resets
    prevConversationIdRef.current = selectedConversation?.id || null;
  }, [selectedConversation?.id]);

  // Fetch linked event for financial icon
  useEffect(() => {
    if (!linkedLead?.id) {
      setLeadEventId(null);
      setLeadEventValue(0);
      return;
    }
    supabase
      .from('company_events')
      .select('id, total_value')
      .eq('lead_id', linkedLead.id)
      .limit(1)
      .then(({ data }) => {
        if (data && data.length > 0) {
          setLeadEventId(data[0].id);
          setLeadEventValue(data[0].total_value || 0);
        } else {
          setLeadEventId(null);
          setLeadEventValue(0);
        }
      });
  }, [linkedLead?.id]);

  // Scroll to bottom - only on initial load or new messages from me
  const prevMessagesLengthRef = useRef(0);
  const lastMessageFromMeRef = useRef(false);
  
  // Track the conversation ID that needs initial scroll
  const pendingScrollConversationRef = useRef<string | null>(null);
  
  // Force scroll to bottom - primary method uses scrollIntoView on bottomRef
  const forceScrollToBottom = useCallback((smooth = false) => {
    const scrollViaRef = () => {
      // Try bottomRefs first (most reliable for iOS Safari)
      if (bottomRefDesktop.current) {
        bottomRefDesktop.current.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' });
        return true;
      }
      if (bottomRefMobile.current) {
        bottomRefMobile.current.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' });
        return true;
      }
      return false;
    };

    const scrollViaViewport = () => {
      // Fallback to direct viewport manipulation
      const desktopViewport = scrollAreaDesktopRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null;
      const mobileViewport = scrollAreaMobileRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null;
      const viewport = desktopViewport || mobileViewport;
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
        return true;
      }
      return false;
    };

    // Execute immediately with both strategies
    if (!scrollViaRef()) {
      scrollViaViewport();
    }
    
    // RAF for after React render
    requestAnimationFrame(() => {
      if (!scrollViaRef()) {
        scrollViaViewport();
      }
    });
    
    // Delayed attempts for slow mobile renders
    const delays = [50, 150, 300];
    delays.forEach(delay => {
      setTimeout(() => {
        if (!scrollViaRef()) {
          scrollViaViewport();
        }
      }, delay);
    });

    // Reset states
    setIsAtBottom(true);
    setUnreadNewMessagesCount(0);
  }, []);
  
  // Effect for initial scroll when messages load for a conversation
  useEffect(() => {
    const conversationId = selectedConversation?.id;
    const messagesLength = messages.length;
    
    // When messages load for a NEW conversation, restore the operator's last reading
    // position first. Only fall back to bottom for chats without a saved position.
    if (conversationId && messagesLength > 0 && pendingScrollConversationRef.current !== conversationId) {
      pendingScrollConversationRef.current = conversationId;
      if (restoreConversationScroll(conversationId)) {
        skipNextMessageAutoScrollRef.current = conversationId;
        return;
      }
      forceScrollToBottom(false); // behavior: 'auto' for instant scroll on open
    }
  }, [selectedConversation?.id, messages.length, forceScrollToBottom, restoreConversationScroll]);
  
  // Effect for new incoming/outgoing messages (WhatsApp-style behavior)
  useEffect(() => {
    const messagesLength = messages.length;
    const lastMessage = messages[messagesLength - 1];
    const isNewMessage = messagesLength > prevMessagesLengthRef.current;
    const isFromMe = lastMessage?.from_me;
    
    if (isNewMessage && messagesLength > 0 && !isLoadingMoreRef.current) {
      if (selectedConversation?.id && skipNextMessageAutoScrollRef.current === selectedConversation.id) {
        skipNextMessageAutoScrollRef.current = null;
        prevMessagesLengthRef.current = messagesLength;
        lastMessageFromMeRef.current = isFromMe || false;
        return;
      }
      // Always scroll for my sent messages
      // For incoming messages, only scroll if user is near bottom
      if (isFromMe || isAtBottomRef.current) {
        forceScrollToBottom(true); // smooth scroll for new messages
      }
      // Counter increment is handled in handleNewRealtimeMessage
    }
    
    prevMessagesLengthRef.current = messagesLength;
    lastMessageFromMeRef.current = isFromMe || false;
  }, [messages, forceScrollToBottom, selectedConversation?.id]);
  
  // Reset pending scroll conversation when changing conversations
  useEffect(() => {
    if (!selectedConversation) {
      pendingScrollConversationRef.current = null;
    }
  }, [selectedConversation]);
  
  // Track if user has manually scrolled (to prevent auto-loading on initial load)
  const canLoadMoreRef = useRef(false);
  
  // Reset canLoadMore when conversation changes
  useEffect(() => {
    if (isInitialLoad) {
      canLoadMoreRef.current = false;
      // Enable loading more after shorter delay
      const timer = setTimeout(() => {
        canLoadMoreRef.current = true;
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [isInitialLoad]);
  
  // Scroll listener - track position and handle infinite scroll
  useEffect(() => {
    const desktopViewport = scrollAreaDesktopRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null;
    const mobileViewport = scrollAreaMobileRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null;
    
    const handleScroll = (e: Event) => {
      const target = e.target as HTMLDivElement;
      const { scrollTop, scrollHeight, clientHeight } = target;
      
      // WhatsApp-style: near bottom means within 120px
      const nearBottom = scrollHeight - scrollTop - clientHeight <= 120;
      setIsAtBottom(nearBottom);
      
      // Reset unread counter when user scrolls to bottom manually
      if (nearBottom) {
        setUnreadNewMessagesCount(0);
      }
      
      // Track when user reaches top (within 50px)
      if (scrollTop < 50 && !isInitialLoad && messages.length > 0) {
        setHasUserScrolledToTop(true);
      }
      
      // Load more when scrolled near top (within 80px)
      if (scrollTop < 80 && hasMoreMessages && !isLoadingMoreRef.current && !isInitialLoad && messages.length > 0 && canLoadMoreRef.current) {
        loadMoreMessages();
      }

      if (scrollSaveRafRef.current !== null) {
        cancelAnimationFrame(scrollSaveRafRef.current);
      }
      scrollSaveRafRef.current = requestAnimationFrame(() => {
        saveConversationScroll();
        scrollSaveRafRef.current = null;
      });
    };
    
    // Add listeners with passive flag for performance
    desktopViewport?.addEventListener('scroll', handleScroll, { passive: true });
    mobileViewport?.addEventListener('scroll', handleScroll, { passive: true });
    
    return () => {
      desktopViewport?.removeEventListener('scroll', handleScroll);
      mobileViewport?.removeEventListener('scroll', handleScroll);
      if (scrollSaveRafRef.current !== null) {
        cancelAnimationFrame(scrollSaveRafRef.current);
        scrollSaveRafRef.current = null;
      }
    };
  }, [hasMoreMessages, isInitialLoad, messages.length, saveConversationScroll]);

  useEffect(() => {
    const persistCurrentScroll = () => saveConversationScroll();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        persistCurrentScroll();
      } else if (selectedConversationRef.current) {
        requestAnimationFrame(() => restoreConversationScroll(selectedConversationRef.current!));
      }
    };
    const handleWindowFocus = () => {
      if (selectedConversationRef.current) {
        requestAnimationFrame(() => restoreConversationScroll(selectedConversationRef.current!));
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', persistCurrentScroll);
    window.addEventListener('pagehide', persistCurrentScroll);
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      persistCurrentScroll();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', persistCurrentScroll);
      window.removeEventListener('pagehide', persistCurrentScroll);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [restoreConversationScroll, saveConversationScroll]);

  const fetchInstances = async (retryCount = 0) => {
    setIsLoading(true);
    
    // Ensure we have an active session before querying (RLS depends on auth.uid())
    const { data: sessionData } = await supabase.auth.getSession();
    console.log('[WhatsAppChat] fetchInstances attempt', retryCount, 'session:', !!sessionData?.session, 'allowedUnits:', allowedUnits);
    
    if (!sessionData?.session && retryCount < 3) {
      // Session not ready yet, retry after a short delay
      setTimeout(() => fetchInstances(retryCount + 1), 800);
      return;
    }
    
    if (!sessionData?.session) {
      console.error('[WhatsAppChat] No session after retries');
      setIsLoading(false);
      setHasAttemptedLoad(true);
      return;
    }
    
    // Build query based on allowed units
    const companyId = localStorage.getItem('selected_company_id') || 'a0000000-0000-0000-0000-000000000001';
    let query = supabase
      .from("wapi_instances")
      .select("id, instance_id, status, unit, is_active, provider, managed_by_celebrei, connected_at")
      .eq("company_id", companyId);

    // Filter by allowed units - if empty, show nothing (user has no unit access)
    // EXCEÇÃO: se há restrição explícita por instância (whatsapp.instance.*),
    // ela é a fonte de verdade — bypass do filtro por nome de unidade, pois
    // wapi_instances.unit é texto livre e nem sempre casa com company_units.name.
    if (!canViewAllInstances && allowedInstanceIds.length > 0) {
      // skip unit filter — instance-level filter abaixo é autoritativo
    } else if (!allowedUnits.includes('all')) {
      if (allowedUnits.length === 0) {
        console.log('[WhatsAppChat] No allowed units, showing empty');
        setInstances([]);
        setIsLoading(false);
        setHasAttemptedLoad(true);
        return;
      }
      query = query.in("unit", allowedUnits);
    }

    const { data, error } = await query.order("unit", { ascending: true });
    console.log('[WhatsAppChat] Instances query result:', { companyId, count: data?.length, error: error?.message });
    console.log('[WhatsAppChat] Instances query result:', { count: data?.length, error: error?.message, data });

    if (error) {
      console.error('[WhatsAppChat] Error fetching instances:', error);
      if (retryCount < 3) {
        setTimeout(() => fetchInstances(retryCount + 1), 1000);
        return;
      }
    }

    // Número do cadastro que nunca conectou (esperando QR ou desistiu) não é um
    // WhatsApp de verdade. O que já conectou e foi desconectado continua, para
    // as conversas antigas seguirem aparecendo
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let accessibleData = ((data || []) as any[]).filter((i) => !(i.managed_by_celebrei && i.is_active === false && !i.connected_at));

    // Per-user WhatsApp instance restriction (whatsapp.instance.* permissions)
    if (!canViewAllInstances) {
      const allowedSet = new Set(allowedInstanceIds);
      const before = accessibleData.length;
      accessibleData = accessibleData.filter((i: any) => allowedSet.has(i.id));
      console.log('[WhatsAppChat] Filtered by instance permissions:', { before, after: accessibleData.length, allowedInstanceIds });
    }

    // Unidade só com número desativado some da Central (as conversas dele deixam
    // de abrir aqui). Número antigo da mesma unidade de um ativo continua, para o
    // histórico de quem trocou de número. Se tudo estiver desativado, nada some
    const activeUnits = new Set(accessibleData.filter((i) => i.is_active !== false).map((i) => i.unit));
    if (activeUnits.size > 0) {
      accessibleData = accessibleData.filter((i) => i.is_active !== false || activeUnits.has(i.unit));
    }

    if (accessibleData.length > 0) {
      const activeInstances = accessibleData as WapiInstance[];
      const counts: Record<string, number> = {};

      await Promise.all(activeInstances.map(async (instance) => {
        const { count } = await supabase
          .from("wapi_conversations")
          .select("id", { count: "exact", head: true })
          .eq("instance_id", instance.id);
        counts[instance.id] = count || 0;
      }));

      setInstanceConversationCounts(counts);
      setInstances(activeInstances);
      // Deduplicate by unit before notifying parent (header should show 1 button per unit)
      const dedupByUnit = new Map<string, any>();
      activeInstances.forEach((inst) => {
        const key = inst.unit || '__no_unit__';
        const existing = dedupByUnit.get(key);
        if (!existing) { dedupByUnit.set(key, inst); return; }
        const score = (i: any) => (i.is_active === false ? 0 : 100) + (i.status === 'connected' ? 10 : i.status === 'degraded' ? 5 : 0) + (i.provider === 'zapi' ? 1 : 0);
        if (score(inst) > score(existing)) dedupByUnit.set(key, inst);
      });
      // Números desativados vão para o fim da lista (só para abrir o histórico)
      const dedupedForParent = Array.from(dedupByUnit.values())
        .map((d: any) => ({ id: d.id, unit: d.unit, status: d.status, is_active: d.is_active !== false }))
        .sort((a, b) => Number(b.is_active) - Number(a.is_active));
      onInstancesLoaded?.(dedupedForParent);
      setSelectedInstance(prev => {
        if (prev) {
          const stillExists = accessibleData.some((inst: any) => inst.id === prev.id);
          const betterSameUnit = pickBestInstance(activeInstances.filter(inst => inst.unit === prev.unit), counts);
          if (stillExists && (!betterSameUnit || betterSameUnit.id === prev.id)) return prev;
          if (betterSameUnit) return betterSameUnit;
        }
        // Prefer the instance/unit from the last open chat when the user returns
        // to this browser tab. This prevents Atendimento from coming back blank.
        const storedConversation = readLastActiveConversation();
        if (storedConversation) {
          const storedInstance = activeInstances.find((inst) => inst.id === storedConversation.instanceId);
          if (storedInstance) return storedInstance;

          if (storedConversation.unit) {
            const storedUnitMatches = activeInstances.filter((inst) => inst.unit === storedConversation.unit);
            const bestStoredUnit = pickBestInstance(storedUnitMatches, counts);
            if (bestStoredUnit) return bestStoredUnit;
          }
        }
        // Prefer the instance matching externalSelectedUnit (from localStorage persistence)
        const extUnit = externalSelectedUnitRef.current;
        if (extUnit) {
          const extMatches = activeInstances.filter((inst) => inst.unit === extUnit);
          const bestExternal = pickBestInstance(extMatches, counts);
          if (bestExternal) return bestExternal;
        }
        return pickBestInstance(activeInstances, counts);
      });

      // Background sync: check real status for instances that appear disconnected
      const disconnected = accessibleData.filter((i: any) => i.is_active !== false && i.status !== 'connected');
      if (disconnected.length > 0) {
        syncInstanceStatuses(disconnected as WapiInstance[]);
      }
    } else if (!error && retryCount < 2) {
      // No instances found but no error - might be a timing/RLS issue, retry once
      console.warn('[WhatsAppChat] No instances returned, retrying...', { retryCount });
      setTimeout(() => fetchInstances(retryCount + 1), 1500);
      return;
    } else {
      console.warn('[WhatsAppChat] No instances returned from query after retries');
    }
    setIsLoading(false);
    setHasAttemptedLoad(true);
  };

  // Background check of real connection status via W-API
  const syncInstanceStatuses = async (instancesToCheck: WapiInstance[]) => {
    for (const instance of instancesToCheck) {
      try {
        const response = await supabase.functions.invoke("wapi-send", {
          body: {
            action: "get-status",
            instanceId: instance.instance_id,
          },
        });

        if (response.data?.status === "connected" || response.data?.connected === true) {
          // Update DB
          await supabase
            .from("wapi_instances")
            .update({ status: "connected", connected_at: new Date().toISOString() })
            .eq("id", instance.id);

          // Update local state
          setInstances(prev =>
            prev.map(i => i.id === instance.id ? { ...i, status: "connected" } : i)
          );
          // If this was the selected instance, update it too
          setSelectedInstance(prev =>
            prev?.id === instance.id ? { ...prev, status: "connected" } : prev
          );
        }
      } catch (error) {
        console.error(`[SyncStatus] Error checking ${instance.unit}:`, error);
      }
    }
  };

  const fetchConversations = async (selectPhone?: string, skipLeadRefresh?: boolean, keepLoadedList?: boolean) => {
    if (!selectedInstance) return;

    // Marca esta busca; qualquer troca de instancia (ou nova busca) a invalida.
    const fetchSeq = ++conversationsFetchSeqRef.current;
    if (selectPhone) phoneFetchSeqRef.current = fetchSeq;
    const isStale = () => {
      if (fetchSeq === conversationsFetchSeqRef.current) return false;
      // Busca de "abrir por telefone" invalidada no meio: rearma o processamento
      // para que o proximo ciclo tente abrir de novo — senao a abertura morre
      // em silencio e o chat fica em "Selecione uma conversa". So a busca por
      // telefone mais recente rearma, para nao derrubar uma tentativa nova.
      if (selectPhone && initialPhoneRef.current === selectPhone && phoneFetchSeqRef.current === fetchSeq) {
        setInitialPhoneProcessed(false);
      }
      return true;
    };

    const conversationColumns = "id, instance_id, lead_id, remote_jid, contact_name, contact_phone, contact_picture, last_message_at, unread_count, is_favorite, is_closed, has_scheduled_visit, is_freelancer, is_equipe, last_message_content, last_message_from_me, bot_enabled, bot_step, bot_paused_until, bot_paused_reason, pinned_message_id, created_at, bot_data";

    // Abertura por telefone: acha e abre a conversa JA, com uma consulta
    // direta e pequena — sem esperar a lista inteira (que pode levar varios
    // segundos em buffets grandes). A lista continua carregando em seguida.
    let effectiveInstanceIds = selectedUnitInstanceIds;
    if (selectPhone) {
      // Com e sem o 9 do celular: o WhatsApp guarda muitos números sem ele
      const phoneVariants = getBrazilianPhoneVariants(selectPhone);
      const phoneFilter = phoneVariants.map(p => `contact_phone.ilike.%${p}%`).join(',');

      // Aviso que já sabe a conversa: busca direta pelo id (instantânea); o
      // telefone fica de reserva
      const knownId = initialConversationIdRef.current;
      const { data: byId } = knownId
        ? await supabase.from("wapi_conversations").select(conversationColumns).eq("id", knownId).maybeSingle()
        : { data: null };
      if (isStale()) return;
      const byIdInstance = byId ? (byId as { instance_id: string }).instance_id : null;
      const byIdHere = !!byIdInstance && selectedUnitInstanceIds.includes(byIdInstance);
      const byIdVisible = !!byIdInstance && instances.some(i => i.id === byIdInstance);

      const { data: quickMatch } = byIdHere
        ? { data: byId }
        : byIdVisible
        ? { data: null }
        : await supabase
          .from("wapi_conversations")
          .select(conversationColumns)
          .in("instance_id", selectedUnitInstanceIds)
          .or(phoneFilter)
          .order("last_message_at", { ascending: false })
          .limit(1)
          .maybeSingle();

      if (isStale()) return;

      if (quickMatch) {
        setSelectedConversation(quickMatch as unknown as Conversation);
        onPhoneHandled?.();
        if (keepLoadedList) return;
      } else {
        // Nao esta na unidade atual — procura nos outros numeros da Central
        const { data: crossInstanceConv } = byIdVisible
          ? { data: byId }
          : await supabase
            .from("wapi_conversations")
            .select(conversationColumns)
            .in("instance_id", instances.map((i) => i.id))
            .or(phoneFilter)
            .order("last_message_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (isStale()) return;

        const targetInstance = crossInstanceConv
          ? instances.find(i => i.id === crossInstanceConv.instance_id)
          : null;

        if (crossInstanceConv && targetInstance) {
          // Troca para a instancia da conversa e ja carrega a lista dela abaixo
          phoneUnitSwitchRef.current = targetInstance.unit || null;
          setSelectedInstance(targetInstance);
          setSelectedConversation(crossInstanceConv as unknown as Conversation);
          onPhoneHandled?.();
          effectiveInstanceIds = instances
            .filter(i => (i.unit || null) === (targetInstance.unit || null))
            .map(i => i.id);
        } else if (selectedInstance) {
          // Nenhuma conversa em lugar nenhum — cria uma nova
          await createNewConversation(selectPhone);
          if (isStale()) return;
          onPhoneHandled?.();
        } else {
          toast({
            title: "Conversa não encontrada",
            description: "Não há histórico de conversa com este número na plataforma.",
            variant: "destructive",
          });
          onPhoneHandled?.();
        }
      }
    }

    // Load all conversations in batches to avoid Supabase default row limits in large buffets
    const allConversationRows: Conversation[] = [];
    const batchSize = 1000;
    let from = 0;

    while (true) {
      const { data: batch, error } = await supabase
        .from("wapi_conversations")
        .select(conversationColumns)
        .in("instance_id", effectiveInstanceIds)
        .order("last_message_at", { ascending: false, nullsFirst: true })
        .range(from, from + batchSize - 1);

      if (isStale()) return; // instancia trocou no meio da busca — descarta

      if (error) {
        console.error("[WhatsAppChat] Error loading conversations:", error);
        break;
      }

      if (!batch || batch.length === 0) break;

      allConversationRows.push(...(batch as Conversation[]));

      if (batch.length < batchSize) break;
      from += batchSize;
    }

    const data = allConversationRows;

    if (data) {
      // Sort: conversations without last_message_at (new leads) first, then by most recent
      const sortedConversations = [...data].sort((a, b) => {
        // If both have no last_message_at, sort by created_at desc
        if (!a.last_message_at && !b.last_message_at) {
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        }
        // Conversations without last_message_at come first
        if (!a.last_message_at) return -1;
        if (!b.last_message_at) return 1;
        // Otherwise sort by last_message_at desc
        return new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime();
      });
      
      setConversations(dedupeConversations(sortedConversations as Conversation[]));
      loadedListKeyRef.current = effectiveInstanceIds.join(",");

      // If the component was remounted/refreshed after the operator changed
      // browser tabs, reopen the exact chat they were viewing.
      if (!selectPhone && !selectedConversationRef.current) {
        const storedConversation = readLastActiveConversation();
        const restoredConversation = storedConversation
          ? sortedConversations.find((conv: Conversation) => conv.id === storedConversation.conversationId)
          : null;

        if (restoredConversation) {
          setSelectedConversation(restoredConversation as Conversation);
        }
      }
      
      const leadIds = Array.from(new Set(
        sortedConversations
          .map((conv: Conversation) => conv.lead_id)
          .filter((id): id is string => id !== null)
      ));

      const unresolvedPhones = Array.from(new Set(
        sortedConversations
          .filter((conv) => !conv.remote_jid?.endsWith('@g.us'))
          .flatMap((conv) => getPhoneVariants(conv.contact_phone))
      ));

      const allLeads: Lead[] = [];
      const seenLeadIds = new Set<string>();
      const appendLeads = (leads?: Lead[]) => {
        leads?.forEach((lead) => {
          if (!seenLeadIds.has(lead.id)) {
            seenLeadIds.add(lead.id);
            allLeads.push(lead);
          }
        });
      };

      const leadIdChunks = Array.from({ length: Math.ceil(leadIds.length / 1000) }, (_, index) =>
        leadIds.slice(index * 1000, (index + 1) * 1000)
      ).filter((chunk) => chunk.length > 0);

      for (const chunk of leadIdChunks) {
        const { data: freshLeads } = await supabase
          .from("campaign_leads")
          .select("id, name, whatsapp, unit, status, month, day_of_month, day_preference, guests, observacoes, created_at, responsavel_id, campaign_name, origem, return_count, last_return_at")
          .in("id", chunk);

        if (isStale()) return;
        appendLeads(freshLeads as Lead[] | undefined);
      }

      const phoneChunks = Array.from({ length: Math.ceil(unresolvedPhones.length / 1000) }, (_, index) =>
        unresolvedPhones.slice(index * 1000, (index + 1) * 1000)
      ).filter((chunk) => chunk.length > 0);

      for (const chunk of phoneChunks) {
        const { data: phoneMatchedLeads } = await supabase
          .from("campaign_leads")
          .select("id, name, whatsapp, unit, status, month, day_of_month, day_preference, guests, observacoes, created_at, responsavel_id, campaign_name, origem, return_count, last_return_at")
          .eq("company_id", getCurrentCompanyId())
          .in("whatsapp", chunk);

        if (isStale()) return;
        appendLeads(phoneMatchedLeads as Lead[] | undefined);
      }

      if (skipLeadRefresh) {
        appendLeads(Object.values(conversationLeadsMap).filter((lead): lead is Lead => lead !== null));
      }

      const leadsById = new Map(allLeads.map((lead) => [lead.id, lead]));
      const leadsByPhone = new Map<string, Lead[]>();

      allLeads.forEach((lead) => {
        getPhoneVariants(lead.whatsapp).forEach((phone) => {
          const existing = leadsByPhone.get(phone) || [];
          existing.push(lead);
          leadsByPhone.set(phone, existing);
        });
      });

      const pickBestLeadForConversation = (conv: Conversation): Lead | null => {
        const candidates = [
          ...(conv.lead_id && leadsById.has(conv.lead_id) ? [leadsById.get(conv.lead_id)!] : []),
          ...getPhoneVariants(conv.contact_phone)
            .flatMap((phone) => leadsByPhone.get(phone) || []),
        ].filter((lead, index, array) => array.findIndex((item) => item.id === lead.id) === index);

        return resolveBestLeadForConversation(conv, candidates, selectedInstance.unit);
      };

      const leadsMap: Record<string, Lead | null> = {};
      sortedConversations.forEach((conv: Conversation) => {
        leadsMap[conv.id] = pickBestLeadForConversation(conv);
      });

      setConversationLeadsMap(leadsMap);
    }
  };

  // Create a new conversation for a phone number that has no history
  const createNewConversation = async (phone: string) => {
    if (!selectedInstance) return;

    const cleanPhone = phone.replace(/\D/g, '');
    const phoneWithCountry = cleanPhone.startsWith('55') ? cleanPhone : `55${cleanPhone}`;
    const remoteJid = `${phoneWithCountry}@s.whatsapp.net`;

    // Try to find lead info for this phone
    const phoneVariants = [
      cleanPhone,
      cleanPhone.replace(/^55/, ''),
      `55${cleanPhone}`,
    ];

    const { data: leadData } = await supabase
      .from("campaign_leads")
      .select("id, name, whatsapp")
      .eq("company_id", getCurrentCompanyId())
      .or(phoneVariants.map(p => `whatsapp.ilike.%${p}%`).join(','))
      .limit(1)
      .single();

    // Create the conversation (e devolve a conversa criada: antes não devolvia, e a
    // conversa nova nunca era aberta na tela)
    const { data: newConv, error } = await insertSingleWithCompany('wapi_conversations', {
      instance_id: selectedInstance.id,
      remote_jid: remoteJid,
      contact_phone: phoneWithCountry,
      contact_name: leadData?.name || null,
      lead_id: leadData?.id || null,
      bot_enabled: false,
      unread_count: 0,
      is_favorite: false,
      is_closed: false,
    }) as { data: Conversation | null; error: { message?: string } | null };

    if (error) {
      console.error("Error creating conversation:", error);
      toast({
        title: "Erro ao criar conversa",
        description: error.message || "Não foi possível iniciar a conversa.",
        variant: "destructive",
      });
      return;
    }

    if (newConv) {
      // Add to conversations list
      setConversations(prev => [newConv, ...prev.filter(c => c.id !== newConv.id)]);
      // Select the new conversation
      setSelectedConversation(newConv);
      
      toast({
        title: "Conversa iniciada",
        description: `Agora você pode enviar mensagens para ${leadData?.name || phoneWithCountry}`,
      });
    }
  };

  const MESSAGES_LIMIT = 20;
  
  const fetchMessages = async (conversationId: string, loadMore: boolean = false) => {
    // Prevent concurrent loads
    if (isLoadingMoreRef.current && loadMore) return;
    
    if (loadMore) {
      isLoadingMoreRef.current = true;
      setIsLoadingMoreMessages(true);
    }
    // Note: For initial load, states are already set in the useEffect before calling this function
    
    try {
      // Build query with cursor-based pagination - select only necessary columns
      let query = supabase
        .from("wapi_messages")
        .select("id, conversation_id, message_id, from_me, message_type, content, media_url, status, timestamp, metadata, quoted_message_id, is_starred")
        .eq("conversation_id", conversationId)
        .order("timestamp", { ascending: false })
        .limit(MESSAGES_LIMIT);
      
      // For loadMore, use cursor (timestamp of oldest message we have)
      if (loadMore && oldestMessageTimestamp) {
        query = query.lt("timestamp", oldestMessageTimestamp);
      }
      
      const { data, error } = await query;

      // Guard: if user switched to a different conversation while we were fetching, discard results
      if (activeConversationIdRef.current !== conversationId) {
        console.log('[fetchMessages] Discarding stale response for', conversationId);
        return;
      }

      if (error) {
        console.error("[fetchMessages] Error:", error);
        return;
      }

      if (data && data.length > 0) {
        // Reverse to display oldest first within the batch
        const orderedMessages = data.reverse() as Message[];
        
        // Update cursor with oldest message timestamp
        const oldestMsg = orderedMessages[0];
        setOldestMessageTimestamp(oldestMsg.timestamp);
        oldestMessageTimestampRef.current = oldestMsg.timestamp;
        
        // Check if there are more messages
        const moreAvailable = data.length >= MESSAGES_LIMIT;
        setHasMoreMessages(moreAvailable);
        
        if (loadMore) {
          // Prepend older messages with deduplication
          setMessages(prev => {
            const existingIds = new Set(prev.map(m => m.id));
            const newMsgs = orderedMessages.filter(m => !existingIds.has(m.id));
            return [...newMsgs, ...prev];
          });
        } else {
          // Initial load - merge with any realtime messages that arrived during fetch
          // IMPORTANT: only keep prev messages that belong to the SAME conversation
          setMessages(prev => {
            if (prev.length === 0) return orderedMessages;
            const fetchedIds = new Set(orderedMessages.map(m => m.id));
            const realtimeOnly = prev.filter(m => 
              !fetchedIds.has(m.id) && 
              !m.id.startsWith('optimistic-') &&
              m.conversation_id === conversationId
            );
            if (realtimeOnly.length === 0) return orderedMessages;
            return [...orderedMessages, ...realtimeOnly].sort(
              (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            );
          });
        }
      } else if (!loadMore) {
        // No messages found — only clear if still on same conversation
        if (activeConversationIdRef.current === conversationId) {
          setMessages([]);
          setHasMoreMessages(false);
        }
      } else {
        // No more older messages
        setHasMoreMessages(false);
      }
    } finally {
      setIsLoadingMessages(false);
      setIsLoadingMoreMessages(false);
      
      // IMPORTANT: Only reset isLoadingMoreRef here for non-loadMore calls.
      // For loadMore, the caller (loadMoreMessages) resets it AFTER scroll restoration
      // to prevent the auto-scroll effect from snapping to bottom.
      if (!loadMore) {
        isLoadingMoreRef.current = false;
        // Mark initial load complete after a brief delay for scroll (handled by useEffect)
        setTimeout(() => setIsInitialLoad(false), 400);
      }
    }
  };
  
  const loadMoreMessages = async (preserveScrollPosition = true) => {
    if (selectedConversation && !isLoadingMoreRef.current && hasMoreMessages) {
      // Get viewport and save scroll position before loading
      const viewport = scrollAreaDesktopRef.current?.querySelector('[data-radix-scroll-area-viewport]') 
        || scrollAreaMobileRef.current?.querySelector('[data-radix-scroll-area-viewport]');
      
      const previousScrollHeight = viewport?.scrollHeight || 0;
      const previousScrollTop = viewport?.scrollTop || 0;
      
      await fetchMessages(selectedConversation.id, true);
      
      // Restore scroll position after messages are prepended - use double rAF for Safari
      if (viewport && preserveScrollPosition) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const newScrollHeight = viewport.scrollHeight;
            const scrollDiff = newScrollHeight - previousScrollHeight;
            viewport.scrollTop = previousScrollTop + scrollDiff;
            // Reset flag AFTER scroll restoration so auto-scroll effect doesn't fire in between
            isLoadingMoreRef.current = false;
          });
        });
      } else {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            isLoadingMoreRef.current = false;
          });
        });
      }
    }
  };

  // Zera o estado de restauração ao trocar de conversa — sem isso, o contador
  // de tentativas vazava de uma conversa para outra.
  useEffect(() => {
    scrollRestoreAttemptsRef.current = 0;
    scrollRestoreLoadingRef.current = false;
  }, [selectedConversation?.id]);

  useEffect(() => {
    const conversationId = selectedConversation?.id;
    if (!conversationId || messages.length === 0) return;

    const savedScroll = readConversationScroll(conversationId);
    if (!savedScroll || savedScroll.isAtBottom || !savedScroll.anchorMessageId) return;

    const anchorElement = document.getElementById(`msg-${savedScroll.anchorMessageId}`);
    if (anchorElement) {
      scrollRestoreLoadingRef.current = false;
      scrollRestoreAttemptsRef.current = 0;
      restoreConversationScroll(conversationId);
      return;
    }

    // Máximo de 3 cargas extras atrás da mensagem-âncora. Rajadas maiores (12+)
    // renderizavam centenas de mensagens de uma vez e congelavam Safari/iPad.
    if (scrollRestoreAttemptsRef.current >= 3) {
      // Âncora inalcançável (mensagem antiga demais ou removida): descarta a
      // marcação salva para não travar de novo nas próximas aberturas.
      try {
        const key = getConversationScrollStorageKey(conversationId);
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      } catch { /* ignore storage errors */ }
      return;
    }

    if (!hasMoreMessages || isLoadingMoreRef.current || scrollRestoreLoadingRef.current) {
      return;
    }

    scrollRestoreLoadingRef.current = true;
    scrollRestoreAttemptsRef.current += 1;
    void loadMoreMessages(false).finally(() => {
      setTimeout(() => {
        scrollRestoreLoadingRef.current = false;
      }, 80);
    });
  }, [selectedConversation?.id, messages.length, hasMoreMessages, readConversationScroll, restoreConversationScroll, getConversationScrollStorageKey]);

  const fetchLinkedLead = async (leadId: string | null, conversation?: Conversation | null) => {
    // Trocou de conversa enquanto buscava: não mostra o lead da anterior
    const isStillOpen = () => !conversation || activeConversationIdRef.current === conversation.id;
    if (leadId) {
      // Lead already linked, just fetch it
      const { data } = await supabase
        .from("campaign_leads")
        .select("id, name, whatsapp, unit, status, month, day_of_month, day_preference, guests, observacoes, created_at, responsavel_id, campaign_name, origem, return_count, last_return_at")
        .eq("id", leadId)
        .single();

      if (data) {
        if (isStillOpen()) setLinkedLead(data as Lead);
        if (conversation) {
          setConversationLeadsMap(prev => ({ ...prev, [conversation.id]: data as Lead }));
        }
      } else {
        if (isStillOpen()) setLinkedLead(null);
        if (conversation) {
          setConversationLeadsMap(prev => ({ ...prev, [conversation.id]: null }));
        }
      }
      return;
    }

    // No lead linked - try to auto-link by phone number
    if (conversation && selectedInstance) {
      const phoneVariants = getPhoneVariants(conversation.contact_phone);

      const { data: matchingLeads } = await supabase
        .from("campaign_leads")
        .select("id, name, whatsapp, unit, status, month, day_of_month, day_preference, guests, observacoes, created_at, responsavel_id, campaign_name, origem, return_count, last_return_at")
        .eq("company_id", getCurrentCompanyId())
        .in("whatsapp", phoneVariants)
        .order("created_at", { ascending: false });

      const matchingLead = resolveBestLeadForConversation(
        conversation,
        (matchingLeads as Lead[] | null) || [],
        selectedInstance.unit
      );

      if (matchingLead) {
        // Auto-link the conversation to the lead
        const { error } = await supabase
          .from('wapi_conversations')
          .update({ lead_id: matchingLead.id })
          .eq('id', conversation.id);

        if (!error) {
          if (isStillOpen()) setLinkedLead(matchingLead as Lead);
          setConversationLeadsMap(prev => ({ ...prev, [conversation.id]: matchingLead as Lead }));
          // Update local state
          setConversations(prev => 
            prev.map(c => c.id === conversation.id ? { ...c, lead_id: matchingLead.id } : c)
          );
          // Só mexe na conversa aberta se ainda for ela (senão trazia a anterior de volta)
          setSelectedConversation(prev => (prev && prev.id === conversation.id ? { ...prev, lead_id: matchingLead.id } : prev));
          
          toast({
            title: "Lead vinculado automaticamente",
            description: `Conversa vinculada a ${matchingLead.name}`,
          });
        }
        return;
      }
    }

    if (isStillOpen()) setLinkedLead(null);
    if (conversation) {
      setConversationLeadsMap(prev => ({ ...prev, [conversation.id]: null }));
    }
  };

  // Create a new lead and classify it directly
  const createAndClassifyLead = async (status: string, triggerFestaOnClose = false) => {
    if (!selectedConversation || !selectedInstance || isCreatingLead) return;

    setIsCreatingLead(true);

    try {
      const contactName = getConversationDisplayName(selectedConversation, conversationLeadsMap);
      const cleanPhone = selectedConversation.contact_phone.replace(/\D/g, '');

      // Check if a lead already exists for this whatsapp number to prevent duplicates.
      // Busca por TODAS as variações do número (com/sem 55, com/sem 9º dígito) —
      // comparação exata deixava passar duplicatas quando o lead antigo foi salvo
      // em outro formato (ex.: lead da LP sem o 55).
      const { data: existingLead } = await supabase
        .from('campaign_leads')
        .select('id, name, whatsapp, unit, status')
        .eq('company_id', getCurrentCompanyId())
        .in('whatsapp', getPhoneVariants(cleanPhone))
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let leadToLink = existingLead;

      if (existingLead) {
        // Lead already exists - just update its status instead of creating a new one
        const validStatus = status as "novo" | "em_contato" | "orcamento_enviado" | "aguardando_resposta" | "fechado" | "perdido" | "transferido";
        await supabase
          .from('campaign_leads')
          .update({ status: validStatus })
          .eq('id', existingLead.id);
        leadToLink = { ...existingLead, status: validStatus };
      } else {
        // No existing lead - create a new one using insertSingleWithCompany (returns created record)
        const { data: newLead, error: createError } = await insertSingleWithCompany('campaign_leads', {
          name: contactName,
          whatsapp: cleanPhone,
          unit: selectedInstance.unit,
          status: status as "novo" | "em_contato" | "orcamento_enviado" | "aguardando_resposta" | "fechado" | "perdido",
          campaign_id: 'whatsapp-chat',
          campaign_name: 'WhatsApp Chat',
        }) as { data: any; error: any };

        if (createError) throw createError;
        leadToLink = newLead;
      }

      if (!leadToLink?.id) {
        throw new Error('Não foi possível obter o lead criado.');
      }

      // Link the conversation to the lead
      const { error: linkError } = await supabase
        .from('wapi_conversations')
        .update({ lead_id: leadToLink.id })
        .eq('id', selectedConversation.id);

      if (linkError) throw linkError;

      // Add history entry (non-blocking)
      const statusLabels: Record<string, string> = {
        novo: 'Novo',
        em_contato: 'Visita',
        orcamento_enviado: 'Orçamento Enviado',
        aguardando_resposta: 'Negociando',
        fechado: 'Fechado',
        perdido: 'Perdido',
        fornecedor: 'Fornecedor',
        cliente_retorno: 'Cliente Retorno',
      };

      supabase.from('lead_history').insert({
        lead_id: leadToLink.id,
        company_id: getCurrentCompanyId(), // sem isso o registro ficava invisivel no historico do lead
        action: existingLead ? 'status_update' : 'lead_created',
        new_value: existingLead
          ? `Status atualizado para: ${statusLabels[status]}`
          : `Lead criado via WhatsApp com status: ${statusLabels[status]}`,
        user_id: userId,
      }).then(({ error }) => {
        if (error) console.error('Error saving lead history:', error);
      });

      // Update local state (a conversa aberta só se ainda for a mesma)
      const classifiedConvId = selectedConversation.id;
      if (activeConversationIdRef.current === classifiedConvId) setLinkedLead(leadToLink as Lead);
      setConversationLeadsMap(prev => ({ ...prev, [classifiedConvId]: leadToLink as Lead }));
      setConversations(prev =>
        prev.map(c => c.id === classifiedConvId ? { ...c, lead_id: leadToLink.id } : c)
      );
      setSelectedConversation(prev => (prev && prev.id === classifiedConvId ? { ...prev, lead_id: leadToLink.id } : prev));

      // Sync has_scheduled_visit when creating/classifying as em_contato
      if (status === 'em_contato') {
        await supabase.from('wapi_conversations').update({ has_scheduled_visit: true }).eq('id', selectedConversation.id);
        setConversations(prev => prev.map(c => c.id === selectedConversation.id ? { ...c, has_scheduled_visit: true } : c));
        setSelectedConversation(prev => (prev && prev.id === classifiedConvId ? { ...prev, has_scheduled_visit: true } : prev));
      }

      if (triggerFestaOnClose && status === 'fechado') {
        console.log('[Lead:Fechado->NovaFesta:mobile]', {
          leadId: leadToLink.id,
          leadName: leadToLink.name,
          source: 'whatsapp-mobile-create',
        });
        void onLeadClosedMobile?.(leadToLink as Lead);
      }

      if (status === 'em_contato') {
        setQuickVisitType("visita");
        setShowQuickVisitDialog(true);
      }

      toast({
        title: existingLead ? "Lead vinculado e atualizado" : "Lead criado e classificado",
        description: `${contactName} classificado como "${statusLabels[status]}"`,
      });
    } catch (error: any) {
      toast({
        title: "Erro ao criar lead",
        description: error.message || "Não foi possível criar o lead.",
        variant: "destructive",
      });
    } finally {
      setIsCreatingLead(false);
    }
  };

  // Auto-disable bot when human sends ANY message (text, media, audio, contact)
  const autoDisableBotOnHumanSend = (conv: Conversation | null) => {
    if (!conv || !conv.bot_enabled) return;
    // Conversa da IA: ela sai agora; lembra a equipe de devolver (ou ela volta sozinha em 24 h)
    if (aiConversationState(conv) === 'atendendo') {
      toast({
        title: "Você assumiu a conversa da IA",
        description: "Ela parou de responder e de mandar follow-ups. Terminou? Devolva para ela. Se ficar 24 h sem mensagem da equipe, ela volta sozinha (menos em negociação, visita ou fechado).",
        duration: 12000,
        action: <ToastAction altText="Devolver para a IA" onClick={() => void returnToBia(conv)}>Devolver para a IA</ToastAction>,
      });
    }
    supabase
      .from("wapi_conversations")
      .update({ bot_enabled: false, bot_step: 'human_takeover' })
      .eq("id", conv.id)
      .then(() => {
        setSelectedConversation(prev => prev && prev.id === conv.id ? { ...prev, bot_enabled: false, bot_step: 'human_takeover' } : prev);
        setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, bot_enabled: false, bot_step: 'human_takeover' } : c));
        console.log('[Bot] Auto-desativado por envio humano');
      });
  };

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !selectedConversation || !selectedInstance || isSending) return;

    if (!selectedSendInstance) {
      toast({ title: "Unidade desconectada", description: "Não há uma conexão ativa liberada para envio nesta unidade.", variant: "destructive" });
      return;
    }

    if (!canSendMessages) {
      toast({ title: "Sem permissão", description: "Você não tem permissão para enviar mensagens.", variant: "destructive" });
      return;
    }
    const messageToSend = newMessage.trim();
    const quotedMsg = replyingTo;
    setNewMessageRaw(""); // Clear immediately for UX
    if (selectedConversation?.id) clearDraft(selectedConversation.id);
    setReplyingTo(null);
    setIsSending(true);

    autoDisableBotOnHumanSend(selectedConversation);

    // Optimistic update - show message immediately with pending status
    const optimisticId = `optimistic-${Date.now()}`;
    const optimisticMessage: Message = {
      id: optimisticId,
      conversation_id: selectedConversation.id,
      message_id: null,
      from_me: true,
      message_type: 'text',
      content: messageToSend,
      media_url: null,
      status: 'pending',
      timestamp: new Date().toISOString(),
      quoted_message_id: quotedMsg?.id || null,
      metadata: { source: 'platform' },
    };
    
    setMessages(prev => [...prev, optimisticMessage]);

    // Re-enable send button immediately after optimistic update
    setIsSending(false);
    setTimeout(() => messageTextareaRef.current?.focus(), 50);

    // Undo Send: delay actual sending by 5 seconds
    const convId = selectedConversation.id;
    const convPhone = getConversationPhone(selectedConversation);
    const instId = selectedSendInstance.instance_id;

    // Send message immediately (no undo delay)
    try {
      const response = await invokeWithRetry({
          action: "send-text",
          phone: convPhone,
          message: messageToSend,
          conversationId: convId,
          instanceId: instId,
          quotedDbMessageId: quotedMsg?.id || null,
          quotedProviderMessageId: quotedMsg?.message_id || null,
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      // === PHASE 3: Check for provider/app-level graceful errors ===
      if (response.data?.errorType === 'LID_UNRESOLVED') {
        if (selectedConversationRef.current !== convId) return;
        setMessages(prev => prev.map(m =>
          m.id === optimisticId ? { ...m, status: 'failed' } : m
        ));
        toast({
          title: "⚠️ Número não identificado",
          description: "Este contato usa um ID interno do WhatsApp (LID). Peça para ele te enviar uma mensagem primeiro — depois o número sincroniza automaticamente.",
          variant: "destructive",
        });
        return;
      }

      if (response.data?.errorType === 'SESSION_INCOMPLETE' || response.data?.blocked) {
        if (selectedConversationRef.current !== convId) return;
        setMessages(prev => prev.map(m =>
          m.id === optimisticId ? { ...m, status: 'failed' } : m
        ));
        toast({
          title: "⚠️ Sessão incompleta",
          description: "A instância está conectada sem sessão válida. Vá em Configurações > Conexão e reconecte.",
          variant: "destructive",
        });
        return;
      }

      if (response.data?.success === false || response.data?.error) {
        throw new Error(response.data?.error || "Não foi possível enviar a mensagem.");
      }

      if (selectedConversationRef.current === convId) {
        setMessages(prev => prev.map(m => 
          m.id === optimisticId ? { ...m, status: 'sent' } : m
        ));
      }

      // Limpa badge de "respondeu campanha" — humano respondeu manualmente
      void clearCampaignReplyFlag(selectedConversation);
    } catch (error: unknown) {
      // Remove optimistic message on error
      if (selectedConversationRef.current === convId) {
        setMessages(prev => prev.filter(m => m.id !== optimisticId));
        setNewMessage(messageToSend);
      }
      
      toast({
        title: "Erro ao enviar",
        description: error instanceof Error ? error.message : "Não foi possível enviar a mensagem.",
        variant: "destructive",
      });
    }

    // isSending already reset after optimistic update above
  };

  // Send contact (vCard) handler
  const handleSendContact = async () => {
    if (!contactName.trim() || !contactPhone.trim() || !selectedConversation || !selectedInstance) return;
    if (!canSendMessages) {
      toast({ title: "Sem permissão", description: "Você não tem permissão para enviar mensagens.", variant: "destructive" });
      return;
    }
    if (!selectedSendInstance) {
      toast({ title: "Unidade desconectada", description: "Não há uma conexão ativa liberada para envio nesta unidade.", variant: "destructive" });
      return;
    }
    
    setIsSendingContact(true);
    const convId = selectedConversation.id;
    
    const contactContent = `[Contato] ${contactName.trim()} - ${contactPhone.trim()}`;
    const optimisticId = `optimistic-${Date.now()}`;
    const optimisticMessage: Message = {
      id: optimisticId,
      conversation_id: convId,
      message_id: null,
      from_me: true,
      message_type: 'contact',
      content: contactContent,
      media_url: null,
      status: 'pending',
      timestamp: new Date().toISOString(),
      metadata: { source: 'platform' },
    };
    
    setMessages(prev => [...prev, optimisticMessage]);
    autoDisableBotOnHumanSend(selectedConversation);
    setShowContactDialog(false);
    
    try {
      const response = await invokeWithRetry({
          action: "send-contact",
          phone: getConversationPhone(selectedConversation),
          contactName: contactName.trim(),
          contactPhone: contactPhone.trim(),
          conversationId: convId,
          instanceId: selectedSendInstance.instance_id,
      });

      if (response.error) throw new Error(response.error.message);
      const responseData = response.data as { success?: boolean; error?: string } | undefined;
      if (responseData && responseData.success === false) throw new Error(responseData.error || "Falha ao enviar contato");

      if (activeConversationIdRef.current === convId) {
        setMessages(prev => prev.map(m => 
          m.id === optimisticId ? { ...m, status: 'sent' } : m
        ));
      }
      
      setContactName("");
      setContactPhone("");
    } catch (error: unknown) {
      if (activeConversationIdRef.current === convId) {
        setMessages(prev => prev.filter(m => m.id !== optimisticId));
      }
      toast({
        title: "Erro ao enviar contato",
        description: error instanceof Error ? error.message : "Não foi possível enviar o contato.",
        variant: "destructive",
      });
    } finally {
      setIsSendingContact(false);
    }
  };

  // Edit message handler
  const handleSaveEdit = async (msgId: string, messageId: string | null) => {
    if (!editingContent.trim() || !selectedConversation || !selectedInstance) return;
    setIsSavingEdit(true);

    try {
      const trimmedContent = editingContent.trim();

      if (messageId) {
        // Has W-API message ID - try to edit via W-API
        const response = await supabase.functions.invoke("wapi-send", {
          body: {
            action: "edit-text",
            phone: getConversationPhone(selectedConversation),
            messageId: messageId,
            newContent: trimmedContent,
            conversationId: selectedConversation.id,
            instanceId: selectedInstance.instance_id,
          },
        });

        if (response.error) throw new Error(response.error.message);
        
        const responseData = response.data;
        if (responseData?.error) throw new Error(responseData.error);
      }

      // Always update locally in DB
      await supabase.from('wapi_messages')
        .update({ content: trimmedContent })
        .eq('id', msgId);

      // Update local message
      setMessages(prev => prev.map(m => 
        m.id === msgId ? { ...m, content: trimmedContent } : m
      ));

      toast({ title: "Mensagem editada" });
    } catch (error: unknown) {
      toast({
        title: "Erro ao editar",
        description: error instanceof Error ? error.message : "Não foi possível editar a mensagem.",
        variant: "destructive",
      });
    }

    setEditingMessageId(null);
    setEditingContent("");
    setIsSavingEdit(false);
  };

  // Emoji reaction handler
  const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

  // Menu da mensagem (reagir, responder, copiar…): abre pela setinha, por
  // clique com o botão direito ou segurando o dedo na mensagem, como no WhatsApp
  const [messageMenuId, setMessageMenuId] = useState<string | null>(null);
  // Tela de toque (celular/iPad): segurar não pode selecionar o texto. O Safari
  // do iPhone ignora a regra só em CSS — vai também direto no estilo da mensagem
  const isTouchUi = useMemo(() => typeof window !== 'undefined' && !!window.matchMedia?.('(hover: none)').matches, []);
  const messageTouchStyle: React.CSSProperties = isTouchUi
    ? { WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }
    : { WebkitTouchCallout: 'none' };
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelLongPress = () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };
  const messagePressHandlers = (msgId: string) => ({
    onTouchStart: () => {
      cancelLongPress();
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        try { window.getSelection()?.removeAllRanges(); } catch { /* nada selecionado */ }
        try { navigator.vibrate?.(15); } catch { /* sem vibração */ }
        setMessageMenuId(msgId);
      }, 400);
    },
    onTouchMove: cancelLongPress,
    onTouchEnd: cancelLongPress,
    onTouchCancel: cancelLongPress,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      setMessageMenuId(msgId);
    },
  });
  
  const handleReaction = async (msg: Message, emoji: string) => {
    if (!selectedInstance || !msg.message_id) return;
    try {
      const response = await supabase.functions.invoke("wapi-send", {
        body: {
          action: "send-reaction",
          instanceId: selectedInstance.instance_id,
          conversationId: msg.conversation_id,
          phone: selectedConversation?.remote_jid,
          messageId: msg.message_id,
          emoji,
        },
      });
      if (response.error) throw new Error(response.error.message);
      if (response.data?.success === false || response.data?.error) {
        toast({ title: "Reações indisponíveis", description: response.data?.error || "Reações não disponíveis neste plano" });
        return;
      }
    } catch (err: any) {
      toast({ title: "😊 Reações indisponíveis", description: "Este recurso não está disponível no momento." });
    }
  };

  // Pin message handler
  const handlePinMessage = async (msg: Message) => {
    if (!selectedConversation) return;
    const isPinned = selectedConversation.pinned_message_id === msg.id;
    const newPinnedId = isPinned ? null : msg.id;
    
    try {
      const { error } = await supabase
        .from('wapi_conversations')
        .update({ pinned_message_id: newPinnedId })
        .eq('id', selectedConversation.id);
      
      if (error) throw error;
      
      setSelectedConversation(prev => prev ? { ...prev, pinned_message_id: newPinnedId } : null);
      setConversations(prev => prev.map(c => c.id === selectedConversation.id ? { ...c, pinned_message_id: newPinnedId } : c));
      toast({ title: isPinned ? "Mensagem desafixada" : "Mensagem fixada 📌" });
    } catch (err: any) {
      toast({ title: "Erro ao fixar", description: err.message, variant: "destructive" });
    }
  };

  // Star message handler
  const handleStarMessage = async (msg: Message) => {
    const newStarred = !msg.is_starred;
    try {
      const { error } = await supabase
        .from('wapi_messages')
        .update({ is_starred: newStarred })
        .eq('id', msg.id);
      if (error) throw error;
      setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, is_starred: newStarred } : m));
      toast({ title: newStarred ? "Mensagem favoritada ⭐" : "Favorito removido" });
    } catch (err: any) {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    }
  };

  // Check if message is editable (from_me, text, less than 15 min)
  const isMessageEditable = (msg: Message) => {
    if (!msg.from_me || msg.message_type !== 'text') return false;
    const msgTime = new Date(msg.timestamp).getTime();
    const now = Date.now();
    return (now - msgTime) < 15 * 60 * 1000; // 15 minutes
  };

  // Delete message state
  const [deleteMessageId, setDeleteMessageId] = useState<string | null>(null);

  // Delete message handler
  const handleDeleteMessage = async (msgId: string) => {
    try {
      const { error } = await supabase
        .from('wapi_messages')
        .delete()
        .eq('id', msgId);
      
      if (error) throw error;
      
      setMessages(prev => prev.filter(m => m.id !== msgId));
      toast({ title: "Mensagem apagada" });
    } catch (err: any) {
      toast({ title: "Erro ao apagar", description: err.message, variant: "destructive" });
    } finally {
      setDeleteMessageId(null);
    }
  };

  // Direct text message sender for SalesMaterialsMenu
  const sendTextMessageDirect = async (message: string): Promise<void> => {
    if (!message.trim() || !selectedConversation || !selectedInstance) return;

    if (!canUseSelectedInstanceForSending) {
      throw new Error("Unidade desconectada.");
    }

    const response = await invokeWithRetry({
        action: "send-text",
        phone: getConversationPhone(selectedConversation),
        message: message,
        conversationId: selectedConversation.id,
        instanceId: selectedSendInstance!.instance_id,
    });

    if (response.error) {
      throw new Error(response.error.message);
    }
  };

  const getSenderColor = (participant: string | undefined) => {
    if (!participant) return 'hsl(200, 60%, 45%)';
    let hash = 0;
    for (let i = 0; i < participant.length; i++) {
      hash = participant.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 65%, 40%)`;
  };

  const formatMessageTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return format(date, "HH:mm");
  };

  const formatDateSeparator = (timestamp: string) => {
    const date = new Date(timestamp);
    if (isToday(date)) return "Hoje";
    if (isYesterday(date)) return "Ontem";
    return format(date, "EEE., d 'de' MMM.", { locale: ptBR });
  };

  // Dia no horário local (o mesmo do rótulo "Hoje/Ontem"). Antes usava o dia em UTC,
  // e mensagens depois das 21h caíam no separador do dia seguinte.
  const getDateKey = (timestamp: string) => {
    return format(new Date(timestamp), "yyyy-MM-dd");
  };

  const formatConversationDate = (timestamp: string | null) => {
    if (!timestamp) return "";
    const date = new Date(timestamp);
    if (isToday(date)) return format(date, "HH:mm");
    if (isYesterday(date)) return "Ontem";
    return format(date, "dd/MM", { locale: ptBR });
  };

  const getStatusIcon = (status: string, message?: Message) => {
    // Use cores adaptadas ao balão azul de mensagens enviadas (from_me).
    // Cinza claro = enviado/entregue (não lido); Ciano vivo = lido (visível sobre o azul).
    const baseColor = "text-primary-foreground/60"; // cinza/claro sobre balão azul
    const readColor = "text-green-400"; // verde vivo para confirmação de leitura
    switch (status) {
      case "sent":
        return <Check className={cn("w-7 h-7", baseColor)} />;
      case "delivered":
        return <CheckCheck className={cn("w-7 h-7", baseColor)} />;
      case "read":
        return <CheckCheck className={cn("w-7 h-7", readColor)} />;
      case "error":
      case "failed":
        return (
          <span title="Não chegou no WhatsApp" className="inline-flex items-center gap-0.5 text-destructive">
            <AlertCircle className="w-5 h-5" />
            <span className="text-[10px] font-medium">não enviada</span>
          </span>
        );
      default: {
        // Mídia esperando o WhatsApp confirmar (ela pode falhar depois de aceita):
        // relógio até confirmar — o follow-up-check reenvia ou marca erro.
        const awaitingAck = message?.metadata && (message.metadata as Record<string, unknown>).ack === "awaiting";
        if (awaitingAck) return <Clock className={cn("w-6 h-6", baseColor)} />;
        // Fallback: se a mensagem não tem rastreio de ACK (Z-API sem messageId),
        // ou se já passou de 30s sem status, mostra ✓ simples para evitar relógio eterno.
        const noTracking = message?.metadata && (message.metadata as Record<string, unknown>).no_ack_tracking === true;
        const olderThan30s = message?.timestamp && (Date.now() - new Date(message.timestamp).getTime()) > 30_000;
        if (noTracking || olderThan30s) {
          return <Check className={cn("w-7 h-7", baseColor)} />;
        }
        return <Clock className={cn("w-6 h-6", baseColor)} />;
      }
    }
  };

  const toggleFavorite = async (conv: Conversation) => {
    if (!canFavoriteConversations) {
      toast({ title: "Sem permissão", description: "Você não tem permissão para favoritar conversas.", variant: "destructive" });
      return;
    }
    const newValue = !conv.is_favorite;
    
    await supabase
      .from('wapi_conversations')
      .update({ is_favorite: newValue })
      .eq('id', conv.id);

    setConversations(prev => 
      prev.map(c => c.id === conv.id ? { ...c, is_favorite: newValue } : c)
    );

    toast({
      title: newValue ? "Adicionado aos favoritos ⭐" : "Removido dos favoritos",
      description: conv.contact_name || conv.contact_phone,
      className: "border-l-4",
      style: { borderLeftColor: newValue ? '#eab308' : '#6b7280' },
    });
  };

  const toggleConversationBot = async (conv: Conversation) => {
    if (!canToggleBot) {
      toast({ title: "Sem permissão", description: "Você não tem permissão para ativar/desativar o bot.", variant: "destructive" });
      return;
    }
    const newValue = conv.bot_enabled === false ? true : false;
    
    await supabase
      .from('wapi_conversations')
      .update({ bot_enabled: newValue })
      .eq('id', conv.id);

    setConversations(prev => 
      prev.map(c => c.id === conv.id ? { ...c, bot_enabled: newValue } : c)
    );

    // Só mexe na conversa aberta se ainda for ela (trocar no meio não traz a anterior de volta)
    setSelectedConversation(prev => (prev && prev.id === conv.id ? { ...prev, bot_enabled: newValue } : prev));

    toast({
      title: newValue ? "Bot ativado" : "Bot desativado",
      description: `Mensagens automáticas ${newValue ? 'ativadas' : 'desativadas'} para esta conversa.`,
    });
  };

  // Conversa da Bia (IA): a equipe assume (Bia para de responder e de mandar
  // follow-ups) ou devolve para a Bia, que responde a próxima mensagem do
  // cliente já sabendo o que a equipe conversou — sem mandar nada sozinha.
  const takeOverFromBia = async (conv: Conversation) => {
    if (!canToggleBot) {
      toast({ title: "Sem permissão", description: "Você não tem permissão para ativar/desativar o bot.", variant: "destructive" });
      return;
    }
    const { error } = await supabase.from('wapi_conversations').update({ bot_enabled: false, bot_step: 'human_takeover' }).eq('id', conv.id);
    if (error) {
      toast({ title: "Erro ao assumir a conversa", description: error.message, variant: "destructive" });
      return;
    }
    setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, bot_enabled: false, bot_step: 'human_takeover' } : c));
    setSelectedConversation(prev => prev && prev.id === conv.id ? { ...prev, bot_enabled: false, bot_step: 'human_takeover' } : prev);
    toast({ title: "Você assumiu a conversa", description: "A IA parou de responder e de mandar follow-ups para este cliente. Se ficar 24 h sem mensagem da equipe, ela volta sozinha (menos em negociação, visita ou fechado)." });
  };

  // "Não precisa responder": some a etiqueta Responder sem mandar nada ao cliente
  const dismissAiReply = async (conv: Conversation) => {
    const patch = { bot_data: dismissAiHandoff(conv.bot_data) };
    const { error } = await supabase.from('wapi_conversations').update(patch as never).eq('id', conv.id);
    if (error) {
      toast({ title: "Não consegui salvar", description: error.message, variant: "destructive" });
      return;
    }
    setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, ...patch } as Conversation : c));
    setSelectedConversation(prev => prev && prev.id === conv.id ? { ...prev, ...patch } as Conversation : prev);
    toast({ title: "Pronto", description: "A etiqueta Responder saiu desta conversa." });
  };

  // "Retomar com a IA agora": a IA volta e escreve já, continuando de onde parou
  const resumeWithAi = async (conv: Conversation) => {
    if (!canToggleBot) {
      toast({ title: "Sem permissão", description: "Você não tem permissão para ativar/desativar o bot.", variant: "destructive" });
      return;
    }
    const { data, error } = await supabase.functions.invoke('ai-resume', { body: { conversation_id: conv.id } });
    let msg: string | null = (data as { error?: string } | null)?.error ?? null;
    if (error && !msg) {
      try { msg = (await (error as { context?: Response }).context?.json())?.error || error.message; } catch { msg = error.message; }
    }
    if (msg) {
      toast({ title: "A IA não retomou", description: msg, variant: "destructive" });
      return;
    }
    const patch = { bot_enabled: true, bot_step: 'ai_agent' };
    setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, ...patch } : c));
    setSelectedConversation(prev => prev && prev.id === conv.id ? { ...prev, ...patch } : prev);
    toast({ title: "A IA está retomando a conversa", description: "Ela escreve em instantes, continuando de onde parou." });
  };

  const returnToBia = async (conv: Conversation) => {
    if (!canToggleBot) {
      toast({ title: "Sem permissão", description: "Você não tem permissão para ativar/desativar o bot.", variant: "destructive" });
      return;
    }
    const botData: Record<string, unknown> = { ...(conv.bot_data || {}), ai_agent: 'on', ai_returned_at: new Date().toISOString() };
    delete botData.ai_handoff; // a passagem anterior está resolvida: sem alerta de "cliente sem resposta"
    const patch = { bot_enabled: true, bot_step: 'ai_agent', bot_data: botData, bot_paused_until: null, bot_paused_reason: null };
    const { error } = await supabase.from('wapi_conversations').update(patch as never).eq('id', conv.id);
    if (error) {
      toast({ title: "Erro ao devolver para a IA", description: error.message, variant: "destructive" });
      return;
    }
    setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, ...patch } : c));
    setSelectedConversation(prev => prev && prev.id === conv.id ? { ...prev, ...patch } : prev);
    toast({ title: "Conversa devolvida para a IA", description: "Ela responde a próxima mensagem do cliente, já sabendo o que a equipe conversou." });
  };

  const reactivateBot = async (conv: Conversation) => {
    if (!canToggleBot) {
      toast({ title: "Sem permissão", description: "Você não tem permissão para reativar o bot.", variant: "destructive" });
      return;
    }

    try {
      // Reset bot state: enable bot and set step to 'welcome' so the webhook picks up LP data
      const newStep = (conv.bot_step === 'lp_sent' || !conv.bot_step) ? 'welcome' : conv.bot_step;
      
      // Also clear flow_lead_state if using flow builder, so it can restart
      if (selectedInstance) {
        const { data: botSettings } = await supabase
          .from('wapi_bot_settings')
          .select('use_flow_builder')
          .eq('instance_id', selectedInstance.id)
          .single();
        
        if (botSettings?.use_flow_builder) {
          // Delete flow state so it restarts
          await supabase
            .from('flow_lead_state')
            .delete()
            .eq('conversation_id', conv.id);
        }
      }

      await supabase
        .from('wapi_conversations')
        .update({ bot_enabled: true, bot_step: newStep })
        .eq('id', conv.id);

      // Update local state
      setConversations(prev => 
        prev.map(c => c.id === conv.id ? { ...c, bot_enabled: true, bot_step: newStep } : c)
      );
      if (selectedConversation?.id === conv.id) {
        setSelectedConversation(prev => prev ? { ...prev, bot_enabled: true, bot_step: newStep } : null);
      }

      // Send a prompt message to the lead so the webhook processes the response
      const promptMsg = 'Oi! Desculpe, tive um probleminha técnico 😅\nPodemos continuar de onde paramos?\n\nResponda *1* para continuar';

      // Pick the best instance to send from: the one selected for sending,
      // falling back to the conversation's own instance, then the unit-selected one.
      const sendInstanceId =
        selectedSendInstance?.instance_id ||
        instances.find(i => i.id === conv.instance_id)?.instance_id ||
        selectedInstance?.instance_id;

      if (!sendInstanceId) {
        toast({
          title: 'Sem instância disponível',
          description: 'Nenhuma instância conectada para enviar a mensagem de reativação.',
          variant: 'destructive',
        });
        return;
      }

      const { data: sendData, error } = await supabase.functions.invoke('wapi-send', {
        body: {
          action: 'send-text',
          phone: getConversationPhone(conv),
          message: promptMsg,
          instanceId: sendInstanceId,
          conversationId: conv.id,
        },
      });

      const sendPayload = (sendData ?? (error as { context?: { body?: unknown } })?.context?.body) as
        | { error?: string; success?: boolean; skipped?: boolean }
        | undefined;

      if (error || sendPayload?.error) {
        console.error('Erro ao enviar mensagem de reativação:', error, sendPayload);
        toast({
          title: 'Bot reativado, mas a mensagem falhou',
          description: sendPayload?.error || error?.message || 'Não foi possível enviar a mensagem de reativação. Tente enviar manualmente.',
          variant: 'destructive',
        });
        return;
      }

      toast({
        title: "Bot reativado ✅",
        description: "Uma mensagem foi enviada ao lead. Quando ele responder, o bot continuará o fluxo.",
      });
    } catch (error) {
      console.error("Erro ao reativar bot:", error);
      toast({
        title: "Erro ao reativar",
        description: "Tente novamente.",
        variant: "destructive",
      });
    }
  };

  const applyTemplate = (template: MessageTemplate) => {
    let message = template.template;
    
    // Replace placeholders with conversation/lead data
    if (selectedConversation) {
      const leadName = getConversationDisplayName(selectedConversation, conversationLeadsMap);
      const leadMonth = conversationLeadsMap[selectedConversation.id]?.month || '';
      const leadGuests = conversationLeadsMap[selectedConversation.id]?.guests || '';
      const leadCampaign = conversationLeadsMap[selectedConversation.id]?.campaign_name || '';
      const leadUnit = conversationLeadsMap[selectedConversation.id]?.unit || '';
      
      // Support both single braces {nome} and double braces {{nome}}
      message = message
        .replace(/\{\{?nome\}?\}/gi, leadName)
        .replace(/\{\{?telefone\}?\}/gi, selectedConversation.contact_phone || '')
        .replace(/\{\{?mes\}?\}/gi, leadMonth)
        .replace(/\{\{?convidados\}?\}/gi, leadGuests)
        .replace(/\{\{?campanha\}?\}/gi, leadCampaign)
        .replace(/\{\{?unidade\}?\}/gi, leadUnit);
    }

    // Replace company/brand variables
    const companyName = currentCompany?.name || '';
    message = message
      .replace(/\{\{?empresa\}?\}/gi, companyName)
      .replace(/\{\{?buffet\}?\}/gi, companyName)
      .replace(/\{\{?nome[_-]?empresa\}?\}/gi, companyName);
    
    setNewMessage(message);
  };

  const insertEmoji = (emoji: string) => {
    setNewMessage(prev => prev + emoji);
    setShowEmojiPicker(false);
  };

  // Handle file selection for media
  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>, type: 'image' | 'audio' | 'document' | 'video') => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file size (max 16MB for video, 10MB for others)
    const maxSize = type === 'video' ? 16 * 1024 * 1024 : 10 * 1024 * 1024;
    if (file.size > maxSize) {
      toast({
        title: "Arquivo muito grande",
        description: type === 'video' ? "O tamanho máximo para vídeos é 16MB." : "O tamanho máximo é 10MB.",
        variant: "destructive",
      });
      return;
    }

    // Create preview for images and videos
    let preview: string | undefined;
    if (type === 'image' || type === 'video') {
      preview = URL.createObjectURL(file);
    }

    setMediaPreview({ type, file, preview });
    setMediaCaption("");
    
    // Reset input
    event.target.value = '';
  };

  const cancelMediaUpload = () => {
    if (mediaPreview?.preview) {
      URL.revokeObjectURL(mediaPreview.preview);
    }
    setMediaPreview(null);
    setMediaCaption("");
  };

  // Safe chunked base64 conversion (avoids stack overflow)
  function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 8192;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      for (let j = 0; j < chunk.length; j++) {
        binary += String.fromCharCode(chunk[j]);
      }
    }
    return btoa(binary);
  }

  // Send recorded audio
  const sendRecordedAudio = async () => {
    if (!audioBlob || !selectedConversation || !selectedInstance || isUploading) return;

    if (!canUseSelectedInstanceForSending) {
      toast({ title: "Envio indisponível", description: "A unidade está desconectada.", variant: "destructive" });
      return;
    }

    setIsUploading(true);
    const convId = selectedConversation.id;
    
    // Optimistic update - show audio message immediately
    const optimisticId = `optimistic-${Date.now()}`;
    const optimisticMessage: Message = {
      id: optimisticId,
      conversation_id: selectedConversation.id,
      message_id: null,
      from_me: true,
      message_type: 'audio',
      content: '[Áudio]',
      media_url: null,
      status: 'pending',
      timestamp: new Date().toISOString(),
      metadata: { source: 'platform' },
    };
    
    setMessages(prev => [...prev, optimisticMessage]);
    autoDisableBotOnHumanSend(selectedConversation);
    
    // Capture blob before clearing recording UI
    const capturedBlob = audioBlob;
    
    // Clear the recording UI immediately for better UX
    cancelRecording();

    try {
      console.log('[sendRecordedAudio] Original blob:', { type: capturedBlob.type, size: capturedBlob.size });

      let preparedBlob = capturedBlob;
      try {
        preparedBlob = await prepareAudioBlobForWhatsApp(capturedBlob);
      } catch (conversionError) {
        console.warn('[sendRecordedAudio] Falha ao preparar áudio:', conversionError);
        throw new Error('Falha ao preparar áudio para o WhatsApp. Tente gravar novamente.');
      }

      console.log('[sendRecordedAudio] Prepared blob:', { type: preparedBlob.type, size: preparedBlob.size });

      const mimeType = preparedBlob.type || 'audio/ogg; codecs=opus';
      const mimeBase = mimeType.split(';')[0].trim().toLowerCase();
      const storageExtension = mimeBase === 'audio/ogg'
        ? 'ogg'
        : mimeBase === 'audio/webm'
          ? 'webm'
          : mimeBase === 'audio/mp4' || mimeBase === 'audio/aac'
          ? 'm4a'
          : mimeBase === 'audio/mpeg'
            ? 'mp3'
            : mimeBase === 'audio/wav' || mimeBase === 'audio/x-wav'
              ? 'wav'
              : 'ogg';

      // Upload to Storage FIRST so W-API can fetch via public URL.
      const fileName = `${selectedConversation.id}/${Date.now()}.${storageExtension}`;
      const { error: uploadError } = await supabase.storage
        .from('whatsapp-media')
        .upload(fileName, preparedBlob, { contentType: mimeType });

      if (uploadError) {
        throw new Error('Falha ao subir áudio: ' + uploadError.message);
      }

      const { data: signedData, error: signErr } = await supabase.storage
        .from('whatsapp-media')
        .createSignedUrl(fileName, 31536000);

      if (signErr || !signedData?.signedUrl) {
        throw new Error('Falha ao gerar URL do áudio');
      }

      const mediaUrl = signedData.signedUrl;

      // Send via mediaUrl (W-API fetches and converts server-side)
      const response = await invokeWithRetry({
          action: 'send-audio',
          phone: getConversationPhone(selectedConversation),
          conversationId: selectedConversation.id,
          instanceId: selectedSendInstance!.instance_id,
          mediaUrl,
          mimeType,
      });

      if (response.error) {
        throw new Error(response.error.message);
      }
      
      if (response.data?.success === false) {
        throw new Error(response.data?.error || 'Falha ao enviar áudio');
      }

      // Update optimistic message to sent status
      if (activeConversationIdRef.current === convId) {
        setMessages(prev => prev.map(m => 
          m.id === optimisticId ? { ...m, status: 'sent', media_url: mediaUrl } : m
        ));
      }

      // Update media_url in database if not set
      if (response.data?.messageId) {
        supabase.from('wapi_messages')
          .update({ media_url: mediaUrl })
          .eq('message_id', response.data.messageId)
          .then(() => {});
      }

      toast({
        title: "Áudio enviado",
        description: "Mensagem de voz enviada com sucesso.",
      });
    } catch (error: any) {
      // Remove optimistic message on error
      if (activeConversationIdRef.current === convId) {
        setMessages(prev => prev.filter(m => m.id !== optimisticId));
      }
      
      toast({
        title: "Erro ao enviar áudio",
        description: error.message || "Não foi possível enviar o áudio.",
        variant: "destructive",
      });
    }

    setIsUploading(false);
  };

  // Auto-send audio when blob is ready after stop+send
  useEffect(() => {
    if (audioBlob && pendingSendAudio) {
      setPendingSendAudio(false);
      sendRecordedAudio();
    }
  }, [audioBlob, pendingSendAudio]);

  // Handle stop and send in one action (WhatsApp-style)
  const handleStopAndSend = () => {
    setPendingSendAudio(true);
    stopRecording();
  };

  // Effect to show error from recording
  useEffect(() => {
    if (recordingError) {
      toast({
        title: "Erro na gravação",
        description: recordingError,
        variant: "destructive",
      });
    }
  }, [recordingError]);

  // Helper function to convert file to base64 with optional compression for images
  const fileToBase64 = async (file: File, compress: boolean = false): Promise<string> => {
    return new Promise((resolve, reject) => {
      if (compress && file.type.startsWith('image/')) {
        // Compress image using canvas
        const img = new Image();
        const reader = new FileReader();
        
        reader.onload = (e) => {
          img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            // Calculate new dimensions (max 1200px on longest side)
            const maxSize = 1200;
            let { width, height } = img;
            
            if (width > maxSize || height > maxSize) {
              if (width > height) {
                height = (height / width) * maxSize;
                width = maxSize;
              } else {
                width = (width / height) * maxSize;
                height = maxSize;
              }
            }
            
            canvas.width = width;
            canvas.height = height;
            ctx?.drawImage(img, 0, 0, width, height);
            
            // Convert to base64 with quality compression
            const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
            resolve(dataUrl);
          };
          img.onerror = reject;
          img.src = e.target?.result as string;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      } else {
        // Just convert to base64 without compression
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      }
    });
  };

  const sendMedia = async () => {
    if (!mediaPreview || !selectedConversation || !selectedInstance || isUploading) return;
    if (!canSendMessages) {
      toast({ title: "Sem permissão", description: "Você não tem permissão para enviar mensagens.", variant: "destructive" });
      return;
    }

    if (!canUseSelectedInstanceForSending) {
      toast({ title: "Envio indisponível", description: "A unidade está desconectada.", variant: "destructive" });
      return;
    }

    setIsUploading(true);
    const convId = selectedConversation.id;
    
    // Optimistic update - show media message immediately
    const { type, file, preview } = mediaPreview;
    const optimisticId = `optimistic-${Date.now()}`;
    const captionToSend = mediaCaption;
    
    const optimisticMessage: Message = {
      id: optimisticId,
      conversation_id: selectedConversation.id,
      message_id: null,
      from_me: true,
      message_type: type === 'document' ? 'document' : type,
      content: captionToSend || (type === 'image' ? '[Imagem]' : type === 'video' ? '[Vídeo]' : type === 'audio' ? '[Áudio]' : `[Documento] ${file.name}`),
      // Prévia própria do balão (a da janela de envio é apagada logo abaixo)
      media_url: preview ? URL.createObjectURL(file) : null,
      status: 'pending',
      timestamp: new Date().toISOString(),
    };
    
    setMessages(prev => [...prev, optimisticMessage]);
    autoDisableBotOnHumanSend(selectedConversation);
    
    // Clear preview immediately for better UX
    cancelMediaUpload();

    try {
      const fileExt = file.name.split('.').pop();
      const fileName = `${selectedConversation.id}/${Date.now()}.${fileExt}`;

      // For images: convert to base64 directly (faster - avoids double transfer)
      // For documents: upload to storage first (W-API requires URL)
      // For audio: upload to storage
      
      if (type === 'image') {
        // Convert image to base64 (compressed as JPEG) for W-API
        const base64Data = await fileToBase64(file, true);
        
        // Extract the compressed image data to upload to storage
        // Since fileToBase64 compresses to JPEG, we'll save as .jpg
        const storageFileName = `${selectedConversation.id}/${Date.now()}.jpg`;
        
        // Convert base64 back to blob for storage upload
        const base64Response = await fetch(base64Data);
        const imageBlob = await base64Response.blob();
        
        // Upload compressed image to storage
        const { error: uploadError } = await supabase.storage
          .from('whatsapp-media')
          .upload(storageFileName, imageBlob, {
            contentType: 'image/jpeg',
          });
        
        let mediaUrl: string | null = null;
        if (!uploadError) {
          // Use signed URL since bucket is private
          const { data: signedData, error: signedError } = await supabase.storage
            .from('whatsapp-media')
            .createSignedUrl(storageFileName, 31536000); // 1 year expiry
          if (!signedError && signedData?.signedUrl) {
            mediaUrl = signedData.signedUrl;
          }
          console.log('Image uploaded to storage:', mediaUrl);
        } else {
          console.error('Error uploading image to storage:', uploadError);
          // Continue anyway - we'll still send via W-API, just won't have a local copy
        }

        // Send to W-API with base64 (fast) and include mediaUrl for display in chat
        const response = await invokeWithRetry({
            action: 'send-image',
            phone: getConversationPhone(selectedConversation),
            conversationId: selectedConversation.id,
            instanceId: selectedSendInstance!.instance_id,
            base64: base64Data,
            caption: captionToSend,
            mediaUrl: mediaUrl,
        });

        if (response.error) {
          throw new Error(response.error.message);
        }
        // O WhatsApp não aceitou ou o número está em pausa: não é "enviado"
        assertMediaSent(response);
        
        // Update optimistic message with final URL
        if (activeConversationIdRef.current === convId) {
          setMessages(prev => prev.map(m => 
            m.id === optimisticId ? { ...m, status: 'sent', media_url: mediaUrl || m.media_url } : m
          ));
        }
      } else if (type === 'document') {
        // For documents: upload to storage first (W-API needs URL)
        const { error: uploadError } = await supabase.storage
          .from('whatsapp-media')
          .upload(fileName, file);

        if (uploadError) {
          throw new Error(uploadError.message);
        }

        // Use signed URL since bucket is private
        const { data: signedData, error: signedError } = await supabase.storage
          .from('whatsapp-media')
          .createSignedUrl(fileName, 31536000); // 1 year expiry

        if (signedError || !signedData?.signedUrl) {
          throw new Error('Falha ao gerar URL do documento');
        }

        const mediaUrl = signedData.signedUrl;

        const response = await invokeWithRetry({
            action: 'send-document',
            phone: getConversationPhone(selectedConversation),
            conversationId: selectedConversation.id,
            instanceId: selectedSendInstance!.instance_id,
            mediaUrl,
            fileName: file.name,
        });

        if (response.error) {
          throw new Error(response.error.message);
        }
        // O WhatsApp não aceitou ou o número está em pausa: não é "enviado"
        assertMediaSent(response);
        
        // Update optimistic message with final URL
        if (activeConversationIdRef.current === convId) {
          setMessages(prev => prev.map(m => 
            m.id === optimisticId ? { ...m, status: 'sent', media_url: mediaUrl } : m
          ));
        }
      } else if (type === 'video') {
        // For videos: upload to storage first (W-API needs URL)
        const { error: uploadError } = await supabase.storage
          .from('whatsapp-media')
          .upload(fileName, file, {
            contentType: file.type || 'video/mp4',
          });

        if (uploadError) {
          throw new Error(uploadError.message);
        }

        // Use signed URL since bucket is private
        const { data: signedData, error: signedError } = await supabase.storage
          .from('whatsapp-media')
          .createSignedUrl(fileName, 31536000); // 1 year expiry

        if (signedError || !signedData?.signedUrl) {
          throw new Error('Falha ao gerar URL do vídeo');
        }

        const mediaUrl = signedData.signedUrl;

        const response = await invokeWithRetry({
            action: 'send-video',
            phone: getConversationPhone(selectedConversation),
            conversationId: selectedConversation.id,
            instanceId: selectedSendInstance!.instance_id,
            mediaUrl,
            caption: captionToSend,
        });

        if (response.error) {
          throw new Error(response.error.message);
        }
        // O WhatsApp não aceitou ou o número está em pausa: não é "enviado"
        assertMediaSent(response);
        
        // Update optimistic message with final URL
        if (activeConversationIdRef.current === convId) {
          setMessages(prev => prev.map(m => 
            m.id === optimisticId ? { ...m, status: 'sent', media_url: mediaUrl } : m
          ));
        }
      } else if (type === 'audio') {
        // Arquivo de áudio: sobe e manda como áudio (o servidor converte para o WhatsApp)
        const { error: uploadError } = await supabase.storage
          .from('whatsapp-media')
          .upload(fileName, file, { contentType: file.type || 'audio/mpeg' });
        if (uploadError) {
          throw new Error(uploadError.message);
        }
        const { data: signedData, error: signedError } = await supabase.storage
          .from('whatsapp-media')
          .createSignedUrl(fileName, 31536000); // 1 year expiry
        if (signedError || !signedData?.signedUrl) {
          throw new Error('Falha ao gerar URL do áudio');
        }
        const mediaUrl = signedData.signedUrl;
        const response = await invokeWithRetry({
            action: 'send-audio',
            phone: getConversationPhone(selectedConversation),
            conversationId: selectedConversation.id,
            instanceId: selectedSendInstance!.instance_id,
            mediaUrl,
            mimeType: file.type || 'audio/mpeg',
        });
        if (response.error) {
          throw new Error(response.error.message);
        }
        assertMediaSent(response);
        if (activeConversationIdRef.current === convId) {
          setMessages(prev => prev.map(m =>
            m.id === optimisticId ? { ...m, status: 'sent', media_url: mediaUrl } : m
          ));
        }
      } else {
        throw new Error('Tipo de arquivo não suportado.');
      }

      toast({
        title: "Mídia enviada",
        description: `${type === 'image' ? 'Imagem' : type === 'audio' ? 'Áudio' : type === 'video' ? 'Vídeo' : 'Arquivo'} enviado com sucesso.`,
      });
    } catch (error: any) {
      // Remove optimistic message on error
      if (activeConversationIdRef.current === convId) {
        setMessages(prev => prev.filter(m => m.id !== optimisticId));
      }
      
      toast({
        title: "Erro ao enviar mídia",
        description: error.message || "Não foi possível enviar a mídia.",
        variant: "destructive",
      });
    }

    setIsUploading(false);
  };

  // Send material by URL (for sales materials menu)
  const sendMaterialByUrl = async (url: string, type: "document" | "image" | "video", caption?: string, fileName?: string) => {
    if (!selectedConversation || !selectedInstance) {
      throw new Error("Nenhuma conversa selecionada");
    }

    if (!canUseSelectedInstanceForSending) {
      throw new Error("Unidade desconectada.");
    }

    let action = 'send-document';
    if (type === 'image') action = 'send-image';
    if (type === 'video') action = 'send-video';

    try {
      // For documents, use the provided fileName or extract from URL
      const finalFileName = type === 'document' 
        ? (fileName || url.split('/').pop()?.split('?')[0] || 'documento.pdf')
        : undefined;

      const response = await invokeWithRetry({
          action,
          phone: getConversationPhone(selectedConversation),
          conversationId: selectedConversation.id,
          instanceId: selectedSendInstance!.instance_id,
          mediaUrl: url,
          caption: caption || undefined,
          fileName: finalFileName,
      });

      if (response.error) {
        console.error("[sendMaterialByUrl] Error:", response.error);
        const errorMessage = response.error.message || 
          (type === 'video' ? 'Erro ao enviar vídeo. Tente novamente.' : 'Erro ao enviar material.');
        throw new Error(errorMessage);
      }

      // Check if the response data indicates an error
      if (response.data?.error) {
        throw new Error(response.data.error);
      }
    } catch (error: any) {
      console.error("[sendMaterialByUrl] Catch error:", error);
      // Handle network errors and timeouts
      if (error.message?.includes('Load failed') || error.message?.includes('Failed to fetch')) {
        throw new Error('Erro de conexão. Verifique sua internet e tente novamente.');
      }
      if (error.message?.includes('timeout') || error.message?.includes('Timeout')) {
        throw new Error('Tempo esgotado. Tente novamente ou envie um arquivo menor.');
      }
      throw error;
    }
  };

  // Expanded emojis organized by category
  const emojiCategories = {
    '😀 Rostos': ['😊', '😄', '😁', '😆', '🤣', '😂', '🙂', '😉', '😍', '🥰', '😘', '😗', '😜', '🤪', '😎', '🤩', '🥳', '😇', '🤗', '🤔', '😏', '😢', '😭', '😤', '😡', '🥺', '😳', '🫣', '🤭', '😬'],
    '👋 Gestos': ['👋', '👍', '👎', '👏', '🙏', '🤝', '✌️', '🤞', '🤙', '💪', '👊', '✋', '👌', '🫶', '❤️‍🔥', '💅'],
    '❤️ Símbolos': ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💕', '💖', '💗', '💓', '💘', '💝', '⭐', '✨', '🔥', '💯', '✅', '❌'],
    '🎉 Festa': ['🎉', '🎊', '🎂', '🎈', '🎁', '🎀', '🪅', '🥂', '🍰', '🧁', '🎵', '🎶', '🏰', '👑', '🎠', '🎡'],
    '📦 Objetos': ['📋', '📅', '🗓️', '📞', '💬', '📷', '🎥', '📍', '🏠', '💰', '💳', '📄', '✍️', '📌', '🔗', '⏰'],
};

// Helper: detecta se a conversa tem uma resposta de campanha pendente de atendimento
const hasCampaignReply = (conv: { bot_data?: Record<string, unknown> | null } | null | undefined): boolean => {
  return !!(conv?.bot_data && (conv.bot_data as Record<string, unknown>).campaign_replied_at);
};

  // Abrir a conversa NÃO limpa mais o badge de campanha; apenas o envio manual do humano limpa.
  const handleSelectConversation = (conv: Conversation) => {
    setSelectedConversation(conv);
  };

  // Limpa o badge de "respondeu campanha" após o humano enviar uma mensagem manual (best-effort)
  const clearCampaignReplyFlag = async (conv: Conversation) => {
    if (!hasCampaignReply(conv)) return;
    const cleaned: Record<string, unknown> = { ...(conv.bot_data || {}) };
    delete cleaned.campaign_replied_at;
    delete cleaned.campaign_replied_id;
    delete cleaned.campaign_replied_name;
    setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, bot_data: cleaned } : c));
    setSelectedConversation(prev => prev && prev.id === conv.id ? { ...prev, bot_data: cleaned } : prev);
    try {
      await supabase.from('wapi_conversations').update({ bot_data: cleaned as never }).eq('id', conv.id);
    } catch (e) {
      console.error('Failed to clear campaign_replied flag:', e);
    }
  };


  // useMemo: filtrar/ordenar centenas de conversas a cada tecla digitada
  // (qualquer re-render) pesava na digitacao em tablets
  // A IA passou e ninguém da equipe respondeu: etiqueta "Responder" e sobe para o topo
  const awaitingTeam = useAwaitingTeamReply(conversations);
  const filteredConversations = useMemo(() => conversations
    .filter((conv) => {
      // Apply text search (normalize phone digits for matching)
      const searchLower = searchQuery.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const displayName = getConversationDisplayName(conv, conversationLeadsMap);
      const nameMatch = (displayName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(searchLower);
      const contactNameMatch = (conv.contact_name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(searchLower);
      const phoneMatch = conv.contact_phone.toLowerCase().includes(searchLower);
      const digitsOnly = searchQuery.replace(/\D/g, '');
      const convDigits = conv.contact_phone.replace(/\D/g, '');
      const digitMatch = digitsOnly.length >= 4 && (convDigits.includes(digitsOnly) || digitsOnly.includes(convDigits));
      // Also search in last_message_content for broader results
      const contentMatch = (conv.last_message_content || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(searchLower);
      const matchesSearch = nameMatch || contactNameMatch || phoneMatch || digitMatch || contentMatch;
      
      // When searching, bypass filters to find leads across all conversations
      if (searchQuery.trim().length > 0) return matchesSearch;
      
      // Apply month filter (mês desejado da festa pelo lead)
      if (monthFilter && monthFilter !== 'all') {
        const leadMonth = (conversationLeadsMap[conv.id]?.month || '').trim();
        if (monthFilter === '__none__') {
          if (leadMonth) return false;
        } else {
          if (leadMonth.toLowerCase() !== monthFilter.toLowerCase()) return false;
        }
      }
      
      // Apply filter
      if (filter === 'unread') return isAwaitingRead(conv);
      if (filter === 'closed') return conv.is_closed;
      if (filter === 'fechados') return leadStatusConversationIds.fechado.has(conv.id);
      if (filter === 'oe') return leadStatusConversationIds.orcamento_enviado.has(conv.id);
      if (filter === 'visitas') return leadStatusConversationIds.em_contato.has(conv.id);
      if (filter === 'freelancer') return conv.is_freelancer;
      if (filter === 'equipe') return conv.is_equipe;
      if (filter === 'favorites') return conv.is_favorite;
      if (filter === 'ia') return aiConversationState(conv) !== null;
      if (filter === 'ia_equipe') return aiConversationState(conv) === 'equipe';
      if (filter === 'grupos') return conv.remote_jid?.endsWith('@g.us');
      // 'all' filter: hide closed by default, but include them when filtering by month
      // (so the totals match between "Tudo" and "Encerradas" within the same month)
      if (monthFilter && monthFilter !== 'all') return true;
      return !conv.is_closed;
    })
    .sort((a, b) => {
      // Esperando resposta da equipe primeiro, depois favoritos, depois a mais recente
      const waitA = awaitingTeam.has(a.id);
      const waitB = awaitingTeam.has(b.id);
      if (waitA !== waitB) return waitA ? -1 : 1;
      if (a.is_favorite && !b.is_favorite) return -1;
      if (!a.is_favorite && b.is_favorite) return 1;
      const timeA = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const timeB = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return timeB - timeA;
    }), [conversations, searchQuery, monthFilter, filter, conversationLeadsMap, leadStatusConversationIds, awaitingTeam]);

  const toggleConversationClosed = async (conv: Conversation) => {
    if (!canCloseConversations) {
      toast({ title: "Sem permissão", description: "Você não tem permissão para encerrar conversas.", variant: "destructive" });
      return;
    }
    const newValue = !conv.is_closed;
    
    await supabase
      .from('wapi_conversations')
      .update({ is_closed: newValue })
      .eq('id', conv.id);

    setConversations(prev => 
      prev.map(c => c.id === conv.id ? { ...c, is_closed: newValue } : c)
    );

    // Só mexe na conversa aberta se ainda for ela (trocar no meio não traz a anterior de volta)
    setSelectedConversation(prev => (prev && prev.id === conv.id ? { ...prev, is_closed: newValue } : prev));

    toast({
      title: newValue ? "Conversa encerrada" : "Conversa reaberta",
      description: newValue 
        ? "A conversa foi movida para Encerradas." 
        : "A conversa foi movida de volta para a lista principal.",
      className: "border-l-4",
      style: { borderLeftColor: newValue ? '#ef4444' : '#22c55e' },
    });
  };

  // ── Manual qualification trigger ──
  const [startQualConfirm, setStartQualConfirm] = useState<{ step: string } | null>(null);
  const [startQualLoading, setStartQualLoading] = useState(false);

  const handleStartQualification = async (force: boolean) => {
    if (!selectedConversation) return;
    setStartQualLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('start-bot-qualification', {
        body: { conversation_id: selectedConversation.id, force },
      });

      // supabase.functions.invoke returns error for non-2xx; try to read the JSON body
      let payload: { error?: string; current_step?: string; success?: boolean; message?: string; details?: unknown } | undefined = data ?? undefined;
      if (error) {
        const ctx = (error as { context?: { body?: unknown; response?: Response } }).context;
        try {
          if (ctx?.response && typeof ctx.response.clone === 'function') {
            payload = await ctx.response.clone().json();
          } else if (ctx?.body && typeof ctx.body === 'object') {
            payload = ctx.body as typeof payload;
          } else if (typeof ctx?.body === 'string') {
            payload = JSON.parse(ctx.body);
          }
        } catch {
          // keep payload as-is
        }
      }

      if (payload?.error === 'flow_in_progress' && !force) {
        setStartQualConfirm({ step: payload.current_step || 'desconhecido' });
        return;
      }
      if (error || payload?.error) {
        const friendly =
          payload?.error === 'send_failed' ? 'Falha ao enviar mensagem pelo WhatsApp. Verifique a conexão da instância.' :
          payload?.error === 'instance not found' ? 'Instância de WhatsApp não encontrada.' :
          payload?.error === 'conversation not found' ? 'Conversa não encontrada.' :
          payload?.error === 'invalid_phone' ? 'Número de telefone inválido nesta conversa.' :
          payload?.message || payload?.error || error?.message || 'Tente novamente.';
        toast({
          title: 'Erro ao iniciar qualificação',
          description: friendly,
          variant: 'destructive',
        });
        return;
      }
      toast({
        title: 'Qualificação iniciada',
        description: 'A primeira pergunta foi enviada para o lead.',
      });
      setStartQualConfirm(null);
    } catch (e) {
      toast({
        title: 'Erro ao iniciar qualificação',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setStartQualLoading(false);
    }
  };

  // "Não enviar mais nada": número na lista de bloqueio da empresa
  // (campaign_optouts). Nada automático sai para ele; a equipe ainda escreve à mão.
  const [contactBlocked, setContactBlocked] = useState(false);
  const [contactBlockSaving, setContactBlockSaving] = useState(false);
  const blockCompanyId = currentCompany?.id || getCurrentCompanyId();
  const blockDigits = (selectedConversation?.remote_jid || '').split('@')[0].replace(/\D/g, '');
  const blockTail = selectedConversation?.remote_jid?.endsWith('@g.us') || blockDigits.length < 8 ? '' : blockDigits.slice(-8);
  useEffect(() => {
    setContactBlocked(false);
    if (!blockCompanyId || !blockTail) return;
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).from('campaign_optouts').select('id').eq('company_id', blockCompanyId).eq('phone_tail', blockTail).limit(1)
      .then(({ data }: { data: unknown[] | null }) => { if (!cancelled) setContactBlocked((data || []).length > 0); });
    return () => { cancelled = true; };
  }, [blockCompanyId, blockTail]);

  const toggleContactBlock = async () => {
    if (!selectedConversation || !blockCompanyId || !blockTail || contactBlockSaving) return;
    const name = selectedConversation.contact_name || selectedConversation.contact_phone;
    if (!contactBlocked && !window.confirm(`Não enviar mais nada para ${name}?\n\nNenhuma mensagem automática vai sair para este número (follow-ups, IA, bot, campanhas, confirmações). A equipe ainda pode escrever à mão.`)) return;
    setContactBlockSaving(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const table = (supabase as any).from('campaign_optouts');
    const { error } = contactBlocked
      ? await table.delete().eq('company_id', blockCompanyId).eq('phone_tail', blockTail)
      : await table.insert({ company_id: blockCompanyId, phone: blockDigits, phone_tail: blockTail, source: 'manual' });
    setContactBlockSaving(false);
    if (error && !String(error.message || '').includes('duplicate')) {
      toast({ title: 'Não foi possível salvar', description: error.message, variant: 'destructive' });
      return;
    }
    setContactBlocked(!contactBlocked);
    toast({
      title: contactBlocked ? 'Mensagens automáticas liberadas' : 'Não enviar mais nada: ligado',
      description: contactBlocked ? `${name} volta a receber mensagens automáticas.` : `Nada automático sai para ${name}.`,
    });
  };

  const handleResumeQualification = async () => {
    if (!selectedConversation) return;
    setStartQualLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('resume-bot-qualification', {
        body: { conversation_id: selectedConversation.id },
      });
      const payload = (data ?? (error as { context?: { body?: unknown } })?.context?.body) as
        | { error?: string; success?: boolean; step?: string }
        | undefined;
      if (error || payload?.error) {
        toast({
          title: 'Erro ao retomar bot',
          description: payload?.error || error?.message || 'Tente novamente.',
          variant: 'destructive',
        });
        return;
      }
      toast({
        title: 'Bot retomado',
        description: `Pergunta do passo "${payload?.step}" enviada ao lead.`,
      });
    } catch (e) {
      toast({
        title: 'Erro ao retomar bot',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setStartQualLoading(false);
    }
  };

  // Marca/desmarca "orçamento enviado" no lead da conversa aberta (menu do topo no celular)
  const toggleOrcamentoEnviado = async () => {
    if (!linkedLead) return;
    const isCurrentlyOE = linkedLead.status === 'orcamento_enviado';
    const newStatus = isCurrentlyOE ? 'em_contato' : 'orcamento_enviado';
    const statusLabels: Record<string, string> = {
      novo: 'Novo',
      em_contato: 'Visita',
      orcamento_enviado: 'Orçamento Enviado',
      aguardando_resposta: 'Negociando',
      fechado: 'Fechado',
      perdido: 'Perdido',
    };
    const { error } = await supabase
      .from('campaign_leads')
      .update({ status: newStatus })
      .eq('id', linkedLead.id);
    if (error) {
      toast({ title: "Erro ao atualizar status", description: error.message, variant: "destructive" });
      return;
    }
    await supabase.from('lead_history').insert({
      lead_id: linkedLead.id,
      user_id: userId,
      user_name: currentUserName || 'Usuário',
      action: 'Alteração de status',
      old_value: statusLabels[linkedLead.status] || linkedLead.status,
      new_value: statusLabels[newStatus],
    });
    setLinkedLead(prev => (prev && prev.id === linkedLead.id ? { ...prev, status: newStatus as Lead['status'] } : prev));
    toast({
      title: isCurrentlyOE ? "Orçamento desmarcado" : "Orçamento marcado",
      description: isCurrentlyOE ? "Status alterado para 'Em Contato'" : "Status alterado para 'Orçamento Enviado'",
    });
  };

  const toggleScheduledVisit = async (conv: Conversation) => {
    const newValue = !conv.has_scheduled_visit;
    
    await supabase
      .from('wapi_conversations')
      .update({ has_scheduled_visit: newValue })
      .eq('id', conv.id);

    setConversations(prev => 
      prev.map(c => c.id === conv.id ? { ...c, has_scheduled_visit: newValue } : c)
    );

    // Só mexe na conversa aberta se ainda for ela (trocar no meio não traz a anterior de volta)
    setSelectedConversation(prev => (prev && prev.id === conv.id ? { ...prev, has_scheduled_visit: newValue } : prev));

    toast({
      title: newValue ? "Visita agendada" : "Visita desmarcada",
      description: newValue 
        ? "A conversa foi marcada como tendo visita agendada." 
        : "A marcação de visita foi removida.",
    });
  };

  const toggleFreelancer = async (conv: Conversation) => {
    const newValue = !conv.is_freelancer;
    
    await supabase
      .from('wapi_conversations')
      .update({ is_freelancer: newValue })
      .eq('id', conv.id);

    setConversations(prev => 
      prev.map(c => c.id === conv.id ? { ...c, is_freelancer: newValue } : c)
    );

    // Só mexe na conversa aberta se ainda for ela (trocar no meio não traz a anterior de volta)
    setSelectedConversation(prev => (prev && prev.id === conv.id ? { ...prev, is_freelancer: newValue } : prev));

    toast({
      title: newValue ? "Marcado como Freelancer" : "Desmarcado como Freelancer",
      description: newValue 
        ? "O contato foi classificado como freelancer." 
        : "A classificação de freelancer foi removida.",
    });
  };

  const toggleEquipe = async (conv: Conversation) => {
    const newValue = !conv.is_equipe;
    
    await supabase
      .from('wapi_conversations')
      .update({ is_equipe: newValue })
      .eq('id', conv.id);

    setConversations(prev => 
      prev.map(c => c.id === conv.id ? { ...c, is_equipe: newValue } : c)
    );

    // Só mexe na conversa aberta se ainda for ela (trocar no meio não traz a anterior de volta)
    setSelectedConversation(prev => (prev && prev.id === conv.id ? { ...prev, is_equipe: newValue } : prev));

    toast({
      title: newValue ? "Marcado como Equipe" : "Desmarcado como Equipe",
      description: newValue 
        ? "O contato foi classificado como membro da equipe." 
        : "A classificação de equipe foi removida.",
    });
  };

  // Handle status change from quick actions
  const handleConversationLeadStatusChange = (leadId: string, newStatus: string) => {
    // Update the conversationLeadsMap
    setConversationLeadsMap(prev => {
      const updated = { ...prev };
      Object.keys(updated).forEach(convId => {
        const lead = updated[convId];
        if (lead && lead.id === leadId) {
          updated[convId] = { ...lead, status: newStatus };
        }
      });
      return updated;
    });


    // Update linkedLead if it's the same lead - use functional update to avoid stale closure
    setLinkedLead(prevLead => {
      if (prevLead?.id === leadId) {
        return { ...prevLead, status: newStatus };
      }
      return prevLead;
    });

    // Mudou para "Visita" pelo menu da lista de conversas: abre o registro de
    // data da visita (o diálogo é vinculado ao lead da conversa aberta, por
    // isso só abre quando é ele)
    if (newStatus === 'em_contato' && linkedLead?.id === leadId) {
      setQuickVisitType("visita");
      setShowQuickVisitDialog(true);
    }
  };

  // Handle creating a new contact manually
  const handleCreateContact = async () => {
    if (!selectedInstance || !currentCompany) return;
    if (newContactName.trim().length < 2) {
      toast({ title: "Nome inválido", description: "O nome deve ter pelo menos 2 caracteres.", variant: "destructive" });
      return;
    }
    const digits = newContactPhone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 13) {
      toast({ title: "Telefone inválido", description: "Informe um telefone válido com DDD.", variant: "destructive" });
      return;
    }
    // Ensure country code
    const phone = digits.startsWith('55') ? digits : `55${digits}`;

    setIsCreatingContact(true);
    try {
      // Check if conversation already exists for this phone on this instance
      const { data: existing } = await supabase
        .from('wapi_conversations')
        .select('id, contact_name, contact_phone')
        .eq('instance_id', selectedInstance.id)
        .eq('contact_phone', phone)
        .limit(1)
        .maybeSingle();

      if (existing) {
        // Select existing conversation
        const conv = conversations.find(c => c.id === existing.id);
        if (conv) setSelectedConversation(conv);
        toast({ title: "Contato já existe", description: `Já existe uma conversa com ${phone}.` });
        setShowCreateContactDialog(false);
        setNewContactName("");
        setNewContactPhone("");
        setIsCreatingContact(false);
        return;
      }

      // Reuse existing lead with same whatsapp+company (unique constraint), otherwise create
      let leadId: string | null = null;
      const { data: existingLead } = await supabase
        .from('campaign_leads')
        .select('id')
        .eq('company_id', currentCompany.id)
        .eq('whatsapp', phone)
        .maybeSingle();

      if (existingLead?.id) {
        leadId = existingLead.id;
        toast({ title: "Lead existente reutilizado", description: `Já existia um lead com o telefone ${phone}. Vinculando à nova conversa.` });
      } else {
        const { data: leadData, error: leadError } = await insertSingleWithCompany('campaign_leads', {
          name: newContactName.trim(),
          whatsapp: phone,
          unit: selectedInstance.unit || null,
          status: 'novo',
          campaign_id: 'manual',
          campaign_name: 'Criado Manualmente',
        }) as { data: any; error: any };

        if (leadError) throw leadError;
        leadId = leadData?.id ?? null;
      }

      // Create conversation
      const remoteJid = `${phone}@s.whatsapp.net`;
      const { data: convData, error: convError } = await supabase
        .from('wapi_conversations')
        .insert({
          instance_id: selectedInstance.id,
          remote_jid: remoteJid,
          contact_phone: phone,
          contact_name: newContactName.trim(),
          lead_id: leadId || null,
          company_id: currentCompany.id,
          bot_enabled: false,
          unread_count: 0,
          is_favorite: false,
          is_closed: false,
          has_scheduled_visit: false,
          is_freelancer: false,
          is_equipe: false,
        } as any)
        .select()
        .single();

      if (convError) throw convError;

      // Log in lead_history
      if (leadId) {
        // Colunas certas do histórico (antes usava colunas que não existem e não gravava)
        await insertWithCompany('lead_history', {
          lead_id: leadId,
          action: 'Lead criado manualmente',
          new_value: `Contato ${newContactName.trim()} (${phone}) criado manualmente via chat`,
          user_id: userId,
          user_name: currentUserName || null,
        });
      }

      // Add to local state and select
      if (convData) {
        const newConv: Conversation = {
          id: convData.id,
          instance_id: convData.instance_id,
          lead_id: convData.lead_id,
          remote_jid: convData.remote_jid,
          contact_name: convData.contact_name,
          contact_phone: convData.contact_phone,
          contact_picture: null,
          last_message_at: convData.created_at || new Date().toISOString(),
          unread_count: 0,
          is_favorite: false,
          is_closed: false,
          has_scheduled_visit: false,
          is_freelancer: false,
          is_equipe: false,
          last_message_content: null,
          last_message_from_me: false,
          created_at: convData.created_at || new Date().toISOString(),
          bot_enabled: false,
          bot_step: null,
          pinned_message_id: null,
        };
        setConversations(prev => [newConv, ...prev]);
        setSelectedConversation(newConv);
        setMessages([]);
      }

      toast({ title: "Contato criado", description: `${newContactName.trim()} foi adicionado à lista de conversas.` });
      setShowCreateContactDialog(false);
      setNewContactName("");
      setNewContactPhone("");
    } catch (error: any) {
      console.error('Error creating contact:', error);
      toast({ title: "Erro ao criar contato", description: error.message || "Tente novamente.", variant: "destructive" });
    } finally {
      setIsCreatingContact(false);
    }
  };

  const handleInstanceChange = (instanceId: string) => {
    const instance = instances.find(i => i.id === instanceId);
    if (instance) {
      setSelectedInstance(instance);
      clearLastActiveConversation();
      setSelectedConversation(null);
      setMessages([]);
      setConversations([]);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (instances.length === 0 && hasAttemptedLoad && signupStatus(currentCompany?.settings) && currentCompany) {
    return (
      <Card>
        <CardContent className="mx-auto max-w-md space-y-3 py-10">
          <p className="text-center font-semibold">Conecte o WhatsApp do buffet</p>
          <p className="text-center text-sm text-muted-foreground">As conversas aparecem aqui assim que o número estiver conectado.</p>
          <WhatsAppConnect companyId={currentCompany.id} onConnected={() => fetchInstances()} />
        </CardContent>
      </Card>
    );
  }

  if (instances.length === 0 && hasAttemptedLoad) {
    return (
      <Card className="h-96">
        <CardContent className="flex flex-col items-center justify-center h-full text-center">
          <WifiOff className="w-12 h-12 text-muted-foreground mb-4" />
          <h3 className="font-semibold mb-2">Nenhuma instância disponível</h3>
          <p className="text-sm text-muted-foreground mb-4">
            {allowedUnits.length === 0 
              ? "Você não tem permissão para acessar nenhuma unidade."
              : "O administrador ainda não configurou as instâncias para suas unidades."}
          </p>
          <Button 
            variant="outline" 
            size="sm"
            onClick={() => fetchInstances()}
          >
            Tentar novamente
          </Button>
        </CardContent>
      </Card>
    );
  }

  const connectedInstances = visibleInstances.filter(i => i.is_active !== false && isConnectedStatus(i.status));
  const allDisconnected = connectedInstances.length === 0;

  // Consider the unit connected if ANY instance of the same unit is connected
  // (a single unit can have both W-API and Z-API instances representing the same WhatsApp)
  const selectedUnitHasConnection = !!selectedSendInstance;
  const showDisconnectedBanner = allDisconnected || !selectedUnitHasConnection;

  return (
    <div className="flex flex-col h-full w-full max-w-full min-w-0 overflow-hidden">
      {/* Header with Unit Tabs - only show if multiple instances AND no external control */}
      {!externalSelectedUnit && (
        <div className="flex items-center justify-between gap-2 mt-3 mb-3 px-1 shrink-0">
          {visibleInstances.length > 1 ? (
            <Tabs 
              value={selectedInstance?.id || ""} 
              onValueChange={handleInstanceChange}
              className="flex-1"
            >
              <TabsList className="bg-card/80 backdrop-blur-sm border border-border/60 shadow-sm w-full overflow-x-auto flex justify-start">
                {visibleInstances.map((instance) => (
                  <TabsTrigger 
                    key={instance.id} 
                    value={instance.id}
                    disabled={false}
                    className="flex items-center gap-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                  >
                    <Building2 className="w-4 h-4" />
                    {instance.unit}
                    {instance.status === 'degraded' && (
                      <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                    )}
                    {instance.status !== 'connected' && instance.status !== 'degraded' && (
                      <WifiOff className="w-3 h-3 text-destructive" />
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          ) : (
            <div className="flex-1" />
          )}
        </div>
      )}

      {/* Número que parou de receber mensagens (alerta do follow-up-check) */}
      <SilentInstanceBanner />

      {/* Disconnected warning - Premium styled */}
      {showDisconnectedBanner && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-xl p-3 mb-3 text-sm text-center shrink-0 shadow-sm backdrop-blur-sm flex items-center justify-center gap-3 flex-wrap">
          <span>
            <WifiOff className="w-4 h-4 inline mr-2" />
            {allDisconnected 
              ? 'Todas as unidades estão desconectadas. Você pode visualizar as mensagens já registradas, mas não poderá enviar novas mensagens.'
              : 'Esta unidade está desconectada. Selecione outra ou aguarde o administrador.'}
          </span>
          {selectedInstance && (
            <Button
              size="sm"
              variant="outline"
              className="text-emerald-700 border-emerald-400 hover:bg-emerald-100 dark:text-emerald-300 dark:border-emerald-600 dark:hover:bg-emerald-900/30"
              onClick={handleQuickConnect}
            >
              <Plug className="w-3 h-3 mr-1" />
              Conectar
            </Button>
          )}
        </div>
      )}

      {/* Degraded session banner */}
      {selectedInstance?.status === 'degraded' && (
        <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-300 dark:border-amber-700 rounded-xl p-3 mb-3 text-sm text-center shrink-0 shadow-sm backdrop-blur-sm flex items-center justify-center gap-3 flex-wrap">
          <span className="text-amber-800 dark:text-amber-200">
            ⚠️ Sessão incompleta — mensagens não serão entregues
          </span>
          <Button
            size="sm"
            variant="outline"
            className="text-blue-700 border-blue-400 hover:bg-blue-100 dark:text-blue-300 dark:border-blue-600 dark:hover:bg-blue-900/30"
            onClick={async () => {
              if (!selectedInstance) return;
              try {
                const response = await supabase.functions.invoke("wapi-send", {
                  body: {
                    action: "restart-instance",
                    instanceId: selectedInstance.instance_id,
                  },
                });
                if (response.data?.restarted) {
                  toast({
                    title: response.data.connected ? "✅ Instância reiniciada!" : "🔄 Restart enviado",
                    description: response.data.connected 
                      ? "Sessão restaurada. Mensagens devem ser entregues agora."
                      : "Restart aceito. Aguarde alguns segundos e atualize.",
                  });
                  fetchInstances();
                } else {
                  toast({
                    title: "⚠️ Restart não disponível",
                    description: response.data?.reason || "Tente desconectar e reconectar.",
                    variant: "destructive",
                  });
                }
              } catch {
                toast({
                  title: "Erro",
                  description: "Não foi possível reiniciar. Tente em Configurações > Conexão.",
                  variant: "destructive",
                });
              }
            }}
          >
            <RefreshCw className="w-3 h-3 mr-1" />
            Reiniciar
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-amber-700 border-amber-400 hover:bg-amber-100 dark:text-amber-300 dark:border-amber-600 dark:hover:bg-amber-900/30"
            onClick={async () => {
              if (!selectedInstance) return;
              try {
                const response = await supabase.functions.invoke("wapi-send", {
                  body: {
                    action: "repair-session",
                    instanceId: selectedInstance.instance_id,
                  },
                });
                if (response.data?.repaired) {
                  toast({
                    title: "✅ Sessão reparada!",
                    description: `Número ${response.data.phoneNumber} vinculado. Envios desbloqueados.`,
                  });
                  fetchInstances();
                } else {
                  toast({
                    title: "⚠️ Reparo manual necessário",
                    description: response.data?.reason || "Vá em Configurações > Conexão e use 'Reparar Sessão'.",
                    variant: "destructive",
                  });
                }
              } catch {
                toast({
                  title: "Erro",
                  description: "Não foi possível reparar. Tente em Configurações > Conexão.",
                  variant: "destructive",
                });
              }
            }}
          >
            <Eraser className="w-3 h-3 mr-1" />
            Reparar
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-emerald-700 border-emerald-400 hover:bg-emerald-100 dark:text-emerald-300 dark:border-emerald-600 dark:hover:bg-emerald-900/30"
            onClick={handleQuickConnect}
          >
            <Plug className="w-3 h-3 mr-1" />
            Conectar
          </Button>
        </div>
      )}

      {/* Chat Area - Premium Container */}
      {selectedInstance && (
        <div className="flex flex-1 w-full max-w-full min-w-0 border-0 md:border border-border/60 rounded-none md:rounded-xl overflow-hidden bg-gradient-to-br from-card via-card to-muted/20 min-h-0 md:shadow-lg">
          {/* Mobile: Show full width list or chat */}
          {isNarrowLayout && (
          <div className={cn(
            "w-full min-w-0 flex flex-col overflow-hidden md:hidden",
            selectedConversation && "hidden"
          )}>
            <Collapsible open={!isSearchBarCollapsed} onOpenChange={(open) => setIsSearchBarCollapsed(!open)}>
              <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down">
                <div className="p-3 pb-0 border-b-0 space-y-2 bg-card/80 backdrop-blur-sm">
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        placeholder="Buscar conversa..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-9 bg-background/80 border-border/60 focus:border-primary/50 focus:ring-primary/20"
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0 h-10 w-10"
                      onClick={() => setShowCreateContactDialog(true)}
                      title="Novo Contato"
                    >
                      <Users className="w-4 h-4" />
                    </Button>
                  </div>
                  <ConversationFilters
                    filter={filter}
                    onFilterChange={setFilter}
                    conversations={conversations}
                    closedLeadCount={leadStatusConversationIds.fechado.size}
                    orcamentoEnviadoCount={leadStatusConversationIds.orcamento_enviado.size}
                    visitasCount={leadStatusConversationIds.em_contato.size}
                    // Celular: os filtros já aparecem ao abrir "Busca e Filtros" (antes eram dois toques)
                    collapsible={false}
                    filterOrder={filterOrder}
                    onFilterOrderChange={saveFilterOrder}
                    monthFilter={monthFilter}
                    onMonthFilterChange={setMonthFilter}
                  />
                </div>
              </CollapsibleContent>
              <button
                onClick={() => setIsSearchBarCollapsed(!isSearchBarCollapsed)}
                className="w-full flex items-center justify-center gap-2 py-2.5 border-b border-border/60 text-sm text-muted-foreground hover:text-foreground transition-colors bg-card/80"
              >
                {isSearchBarCollapsed ? (
                  <>
                    <Search className="w-4 h-4" />
                    <span className="font-medium">Busca e Filtros</span>
                    {/* Fechado, mostra que tem filtro ligado */}
                    {(filter !== 'all' || monthFilter !== 'all' || !!searchQuery) && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-semibold leading-none">filtro ativo</span>
                    )}
                    <ChevronDown className="w-4 h-4" />
                  </>
                ) : (
                  <ChevronUp className="w-4 h-4" />
                )}
              </button>
            </Collapsible>
            
            <ScrollArea className="flex-1 w-full [&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!w-full [&_[data-radix-scroll-area-viewport]>div]:!min-w-0">
              {filteredConversations.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 text-center p-4">
                  <MessageSquare className="w-8 h-8 text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">
                    {searchQuery ? "Nenhuma conversa encontrada" : "Nenhuma conversa ainda"}
                  </p>
                </div>
              ) : (
                 filteredConversations.map((conv) => (
                  <button
                    key={conv.id}
                    onClick={() => handleSelectConversation(conv)}
                    className={cn(
                      "w-full px-3 py-2.5 flex items-center gap-2.5 hover:bg-primary/5 transition-all text-left border-b border-border/40 group",
                      selectedConversation?.id === conv.id && "bg-primary/10 border-l-2 border-l-primary",
                      isAwaitingRead(conv) && "bg-gradient-to-r from-primary/10 to-transparent",
                      hasCampaignReply(conv) && "bg-gradient-to-r from-orange-100 to-transparent dark:from-orange-950/40"
                    )}
                  >
                    <div className="relative shrink-0">
                      <Avatar className="h-10 w-10 ring-2 ring-border/50 shadow-sm">
                        <AvatarImage 
                          src={conv.contact_picture || undefined} 
                          alt={getConversationDisplayName(conv, conversationLeadsMap)}
                          referrerPolicy="no-referrer"
                        />
                        <AvatarFallback className={cn(
                          "text-primary text-sm font-semibold bg-gradient-to-br",
                          isAwaitingRead(conv) ? "from-primary/30 to-primary/10" : "from-primary/15 to-primary/5"
                        )}>
                          {avatarInitial(getConversationDisplayName(conv, conversationLeadsMap))}
                        </AvatarFallback>
                      </Avatar>
                      {conv.is_favorite && (
                        <Star className="absolute -top-1 -right-1 w-3 h-3 text-secondary fill-secondary drop-shadow-sm" />
                      )}
                      {conv.has_scheduled_visit && (
                        <CalendarCheck className="absolute -top-1 -left-1 w-3 h-3 text-blue-600 bg-background rounded-full" />
                      )}
                      {conv.is_freelancer && (
                        <Briefcase className="absolute -bottom-1 -left-1 w-3 h-3 text-orange-600 bg-background rounded-full" />
                      )}
                      {conv.is_closed && (
                        <X className="absolute -bottom-1 -right-1 w-3 h-3 text-destructive bg-background rounded-full" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 items-center">
                      {/* Row 1, Col 1: Name */}
                      <div className="flex items-center gap-1 min-w-0 overflow-hidden">
                        <p className={cn(
                          "truncate text-sm",
                          isAwaitingRead(conv) ? "font-bold" : "font-medium"
                        )}>
                          {getConversationDisplayName(conv, conversationLeadsMap)}
                        </p>
                        <AiConversationBadge conv={conv} />
                        {awaitingTeam.has(conv.id) && <NeedsReplyTag late={awaitingTeam.get(conv.id) === true} />}
                        {conv.lead_id && clientDataByLead.get(conv.lead_id) && clientDataState(clientDataByLead.get(conv.lead_id)!) !== "recebido" && (
                          <span className={cn("text-[9px] px-1.5 py-0.5 rounded font-semibold shrink-0 leading-none", clientDataState(clientDataByLead.get(conv.lead_id)!) === "atrasado" ? "bg-red-500/15 text-red-700" : "bg-amber-500/15 text-amber-700")} title={clientDataLabel(clientDataByLead.get(conv.lead_id)!)}>
                            {clientDataState(clientDataByLead.get(conv.lead_id)!) === "atrasado" ? "⚠️ Dados" : "📋 Dados"}
                          </span>
                        )}
                        {conv.lead_id && (
                          <Link2 className="w-3 h-3 text-primary shrink-0" />
                        )}
                        {instances.length > 1 && instanceUnitMap[conv.instance_id] && instanceUnitMap[conv.instance_id] !== selectedInstance?.unit && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium shrink-0 leading-none">
                            {instanceUnitMap[conv.instance_id]}
                          </span>
                        )}
                        {hasCampaignReply(conv) && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-orange-500 text-white font-semibold shrink-0 leading-none">
                            📣 Campanha
                          </span>
                        )}
                      </div>
                      {/* Row 1, Col 2: Timestamp */}
                      <span className="text-[11px] text-muted-foreground whitespace-nowrap text-right">
                        {formatConversationDate(conv.last_message_at)}
                      </span>
                      {/* Row 2, Col 1: Preview */}
                      <span className={cn(
                        "text-xs truncate block mt-0.5",
                        isAwaitingRead(conv) ? "text-foreground font-medium" : "text-muted-foreground"
                      )}>
                        {conv.last_message_from_me && (
                          <CheckCheck className="w-3 h-3 shrink-0 text-primary inline mr-1 align-text-bottom" />
                        )}
                        {friendlyLastMessage(conv.last_message_content, conv.last_message_from_me) || formatPhoneBR(conv.contact_phone)}
                      </span>
                      {/* Row 2, Col 2: Badge */}
                      <div className="flex justify-end items-center mt-0.5">
                        {isAwaitingRead(conv) && (
                          <AnimatedBadge 
                            value={conv.unread_count > 99 ? "99+" : conv.unread_count}
                            className="h-5 min-w-6 px-1.5 flex items-center justify-center text-[11px] font-bold rounded-full bg-primary text-primary-foreground"
                          />
                        )}
                      </div>
                    </div>
                  </button>
                ))
              )}
            </ScrollArea>
          </div>
          )}

          {/* Desktop: Resizable Panels */}
          {!isNarrowLayout && (
          <ResizablePanelGroup direction="horizontal" className="hidden md:flex flex-1">
            {/* Conversations Panel - Resizable */}
            <ResizablePanel 
              defaultSize={35} 
              minSize={20} 
              maxSize={50}
              className="flex flex-col min-h-0"
            >
              <div className="flex flex-col h-full bg-card rounded-2xl shadow-premium border border-border/50 m-1.5 mr-0 overflow-hidden ring-1 ring-primary/5">
                <div className="p-4 border-b border-border/40 space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        placeholder="Buscar conversa..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-9 bg-muted/50 border-border/40 rounded-xl focus:border-primary/50 focus:ring-primary/20"
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0 h-10 w-10 rounded-xl"
                      onClick={() => setShowCreateContactDialog(true)}
                      title="Novo Contato"
                    >
                      <Users className="w-4 h-4" />
                    </Button>
                  </div>
                  <ConversationFilters
                    filter={filter}
                    onFilterChange={setFilter}
                    conversations={conversations}
                    closedLeadCount={leadStatusConversationIds.fechado.size}
                    orcamentoEnviadoCount={leadStatusConversationIds.orcamento_enviado.size}
                    visitasCount={leadStatusConversationIds.em_contato.size}
                    collapsible={true}
                    defaultOpen={false}
                    filterOrder={filterOrder}
                    onFilterOrderChange={saveFilterOrder}
                    monthFilter={monthFilter}
                    onMonthFilterChange={setMonthFilter}
                  />
                </div>
                
                {/* A lista encolhe com o painel: hora e nº de mensagens novas sempre à vista */}
                <ScrollArea className="flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!w-full [&_[data-radix-scroll-area-viewport]>div]:!min-w-0">
                  {filteredConversations.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-48 text-center p-4">
                      <MessageSquare className="w-8 h-8 text-muted-foreground mb-2" />
                      <p className="text-sm text-muted-foreground">
                        {searchQuery ? "Nenhuma conversa encontrada" : "Nenhuma conversa ainda"}
                      </p>
                    </div>
                  ) : (
                    filteredConversations.map((conv) => (
                      <button
                        key={conv.id}
                        onClick={() => handleSelectConversation(conv)}
                    className={cn(
                      "w-full px-4 py-3 flex items-center gap-3 hover:bg-muted/60 transition-all duration-200 text-left border-b border-border/30 group",
                      selectedConversation?.id === conv.id && "bg-primary/8 border-l-[3px] border-l-primary",
                      isAwaitingRead(conv) && "bg-primary/5",
                      hasCampaignReply(conv) && "bg-gradient-to-r from-orange-100 to-transparent dark:from-orange-950/40 border-l-[3px] border-l-orange-500"
                    )}
                      >
                        <div className="relative shrink-0">
                        <Avatar className="h-10 w-10 ring-2 ring-border/50 shadow-sm">
                          <AvatarImage 
                            src={conv.contact_picture || undefined} 
                            alt={getConversationDisplayName(conv, conversationLeadsMap)}
                            referrerPolicy="no-referrer"
                          />
                          <AvatarFallback className={cn(
                            "text-primary text-sm font-semibold bg-gradient-to-br",
                            isAwaitingRead(conv) ? "from-primary/30 to-primary/10" : "from-primary/15 to-primary/5"
                          )}>
                            {avatarInitial(getConversationDisplayName(conv, conversationLeadsMap))}
                          </AvatarFallback>
                        </Avatar>
                          {conv.is_favorite && (
                            <Star className="absolute -top-1 -right-1 w-3 h-3 text-secondary fill-secondary drop-shadow-sm" />
                          )}
                          {conv.has_scheduled_visit && (
                            <CalendarCheck className="absolute -top-1 -left-1 w-3.5 h-3.5 text-blue-600 bg-background rounded-full shadow-sm" />
                          )}
                          {conv.is_freelancer && (
                            <Briefcase className="absolute -bottom-1 -left-1 w-3.5 h-3.5 text-orange-600 bg-background rounded-full shadow-sm" />
                          )}
                          {conv.is_closed && (
                            <X className="absolute -bottom-1 -right-1 w-3.5 h-3.5 text-destructive bg-background rounded-full shadow-sm" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0 overflow-hidden">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1 min-w-0 flex-1 overflow-hidden">
                              <p className={cn(
                                "truncate text-sm",
                                isAwaitingRead(conv) ? "font-bold" : "font-medium"
                              )}>
                                {getConversationDisplayName(conv, conversationLeadsMap)}
                              </p>
                              <AiConversationBadge conv={conv} />
                              {awaitingTeam.has(conv.id) && <NeedsReplyTag late={awaitingTeam.get(conv.id) === true} />}
                              {conv.lead_id && clientDataByLead.get(conv.lead_id) && clientDataState(clientDataByLead.get(conv.lead_id)!) !== "recebido" && (
                          <span className={cn("text-[9px] px-1.5 py-0.5 rounded font-semibold shrink-0 leading-none", clientDataState(clientDataByLead.get(conv.lead_id)!) === "atrasado" ? "bg-red-500/15 text-red-700" : "bg-amber-500/15 text-amber-700")} title={clientDataLabel(clientDataByLead.get(conv.lead_id)!)}>
                            {clientDataState(clientDataByLead.get(conv.lead_id)!) === "atrasado" ? "⚠️ Dados" : "📋 Dados"}
                          </span>
                        )}
                              {conv.lead_id && (
                                <Link2 className="w-3 h-3 text-primary shrink-0" />
                              )}
                              {instances.length > 1 && instanceUnitMap[conv.instance_id] && instanceUnitMap[conv.instance_id] !== selectedInstance?.unit && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium shrink-0 leading-none">
                                  {instanceUnitMap[conv.instance_id]}
                                </span>
                              )}
                              {hasCampaignReply(conv) && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-orange-500 text-white font-semibold shrink-0 leading-none">
                                  📣 Campanha
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleConversationClosed(conv);
                                }}
                                className="hidden group-hover:inline-flex p-1 hover:bg-muted rounded"
                                title={conv.is_closed ? "Reabrir conversa" : "Encerrar conversa"}
                              >
                                <X className={cn(
                                  "w-3 h-3",
                                  conv.is_closed ? "text-destructive" : "text-muted-foreground"
                                )} />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleScheduledVisit(conv);
                                }}
                                className="hidden group-hover:inline-flex p-1 hover:bg-muted rounded"
                                title={conv.has_scheduled_visit ? "Desmarcar visita" : "Marcar visita agendada"}
                              >
                                <CalendarCheck className={cn(
                                  "w-3 h-3",
                                  conv.has_scheduled_visit ? "text-blue-600" : "text-muted-foreground"
                                )} />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleFreelancer(conv);
                                }}
                                className="hidden group-hover:inline-flex p-1 hover:bg-muted rounded"
                                title={conv.is_freelancer ? "Desmarcar como Freelancer" : "Marcar como Freelancer"}
                              >
                                <Briefcase className={cn(
                                  "w-3 h-3",
                                  conv.is_freelancer ? "text-orange-600" : "text-muted-foreground"
                                )} />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleEquipe(conv);
                                }}
                                className="hidden group-hover:inline-flex p-1 hover:bg-muted rounded"
                                title={conv.is_equipe ? "Desmarcar como Equipe" : "Marcar como Equipe"}
                              >
                                <Users className={cn(
                                  "w-3 h-3",
                                  conv.is_equipe ? "text-cyan-600" : "text-muted-foreground"
                                )} />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleFavorite(conv);
                                }}
                                className="hidden group-hover:inline-flex p-1 hover:bg-muted rounded"
                              >
                                {conv.is_favorite ? (
                                  <StarOff className="w-3 h-3 text-muted-foreground" />
                                ) : (
                                  <Star className="w-3 h-3 text-muted-foreground" />
                                )}
                              </button>
                              {/* Tablet (toque): as ações acima só aparecem com o mouse; aqui ficam num menu */}
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <button
                                    onClick={(e) => e.stopPropagation()}
                                    className="hidden [@media(hover:none)]:inline-flex p-1.5 -my-1 hover:bg-muted rounded"
                                    title="Ações da conversa"
                                  >
                                    <MoreHorizontal className="w-4 h-4 text-muted-foreground" />
                                  </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-52" onClick={(e) => e.stopPropagation()}>
                                  <DropdownMenuItem onClick={() => toggleConversationClosed(conv)}>
                                    <X className="w-4 h-4 mr-2" />
                                    {conv.is_closed ? "Reabrir conversa" : "Encerrar conversa"}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => toggleScheduledVisit(conv)}>
                                    <CalendarCheck className="w-4 h-4 mr-2" />
                                    {conv.has_scheduled_visit ? "Desmarcar visita" : "Marcar visita agendada"}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => toggleFreelancer(conv)}>
                                    <Briefcase className="w-4 h-4 mr-2" />
                                    {conv.is_freelancer ? "Desmarcar freelancer" : "Marcar como freelancer"}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => toggleEquipe(conv)}>
                                    <Users className="w-4 h-4 mr-2" />
                                    {conv.is_equipe ? "Desmarcar equipe" : "Marcar como equipe"}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => toggleFavorite(conv)}>
                                    {conv.is_favorite ? <StarOff className="w-4 h-4 mr-2" /> : <Star className="w-4 h-4 mr-2" />}
                                    {conv.is_favorite ? "Tirar dos favoritos" : "Favoritar"}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                              <ConversationStatusActions
                                conversation={conv}
                                linkedLead={conversationLeadsMap[conv.id] || null}
                                userId={userId}
                                currentUserName={currentUserName}
                                onStatusChange={handleConversationLeadStatusChange}
                              />
                              <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                                {formatConversationDate(conv.last_message_at)}
                              </span>
                            </div>
                          </div>
                          <div className={cn(
                            "grid mt-0.5 items-center gap-2",
                            isAwaitingRead(conv) ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-1"
                          )}>
                            <span className={cn(
                              "text-xs truncate block",
                              isAwaitingRead(conv) ? "text-foreground font-medium" : "text-muted-foreground"
                            )}>
                              {conv.last_message_from_me && (
                                <CheckCheck className="w-3 h-3 shrink-0 text-primary inline mr-1 align-text-bottom" />
                              )}
                              {friendlyLastMessage(conv.last_message_content, conv.last_message_from_me) || formatPhoneBR(conv.contact_phone)}
                            </span>
                            {isAwaitingRead(conv) && (
                              <AnimatedBadge 
                                value={conv.unread_count > 99 ? "99+" : conv.unread_count}
                               className="h-5 min-w-6 px-1.5 flex items-center justify-center text-[11px] font-bold rounded-full bg-primary text-primary-foreground"
                              />
                            )}
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </ScrollArea>
              </div>
            </ResizablePanel>

            {/* Resize Handle */}
            <ResizableHandle withHandle className="mx-1 bg-transparent hover:bg-primary/10 transition-colors data-[state=dragging]:bg-primary/20" />

            {/* Messages Panel */}
            <ResizablePanel defaultSize={65} minSize={40} className="flex flex-col min-h-0 min-w-0">
              <div className="flex flex-col h-full bg-card rounded-2xl shadow-premium border border-border/50 m-1.5 ml-0 overflow-hidden ring-1 ring-primary/5">
              {selectedConversation ? (
                <>
                  {/* Chat Header - Premium Glassmorphism */}
                  <div className="px-4 py-3 border-b border-border/40 flex items-center gap-3 shrink-0 bg-card">
                    <Avatar className="h-9 w-9 shrink-0 ring-2 ring-primary/20 shadow-md">
                      <AvatarImage 
                        src={selectedConversation.contact_picture || undefined} 
                        alt={getConversationDisplayName(selectedConversation, conversationLeadsMap)}
                        referrerPolicy="no-referrer"
                      />
                      <AvatarFallback className="bg-gradient-to-br from-primary/20 to-primary/5 text-primary text-sm font-semibold">
                        {avatarInitial(getConversationDisplayName(selectedConversation, conversationLeadsMap))}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1">
                        <p className="font-medium truncate text-sm sm:text-base">
                          {getConversationDisplayName(selectedConversation, conversationLeadsMap)}
                        </p>
                        {instances.length > 1 && instanceUnitMap[selectedConversation.instance_id] && instanceUnitMap[selectedConversation.instance_id] !== selectedInstance?.unit && (
                          <Badge variant="outline" className="text-[10px] h-4 px-1.5 shrink-0">
                            {instanceUnitMap[selectedConversation.instance_id]}
                          </Badge>
                        )}
                        {linkedLead && (
                          <div className="flex items-center gap-1">
                            <Badge 
                              variant="secondary" 
                              className="text-[10px] h-4 px-1"
                            >
                              <Link2 className="w-2.5 h-2.5 mr-0.5" />
                              {linkedLead.name.split(' ')[0]}
                            </Badge>
                            <Badge 
                              className={cn(
                                "text-[10px] h-4 px-1.5",
                                LEAD_STATUS_COLORS[linkedLead.status as LeadStatus],
                                linkedLead.status === 'em_contato' && "text-yellow-950"
                              )}
                            >
                              {({
                                novo: 'Novo',
                                em_contato: 'Visita',
                                orcamento_enviado: 'Orçamento',
                                aguardando_resposta: 'Negociando',
                                fechado: 'Fechado',
                                perdido: 'Perdido',
                                transferido: 'Transf.',
                                trabalhe_conosco: 'Trab.',
                                fornecedor: 'Fornec.',
                                cliente_retorno: 'Retorno',
                              } as Record<string, string>)[linkedLead.status] ?? linkedLead.status}
                            </Badge>
                          </div>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {formatPhoneBR(selectedConversation.contact_phone)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {/* Info Popover - show for all individual chats */}
                      <LeadInfoPopover
                        linkedLead={linkedLead}
                        selectedConversation={selectedConversation}
                        selectedInstance={selectedInstance}
                        canTransferLeads={canTransferLeads}
                        canDeleteFromChat={canDeleteFromChat}
                        canEditLead={leadPerms.canEditLeads}
                        canViewContact={leadPerms.canViewContact}
                        isCreatingLead={isCreatingLead}
                        userId={userId}
                        currentUserName={currentUserName}
                        onShowTransferDialog={() => setShowTransferDialog(true)}
                        onShowDeleteDialog={() => setShowDeleteConfirmDialog(true)}
                        onShowShareToGroupDialog={() => canShareToGroup && linkedLead && setShowShareToGroupDialog(true)}
                        onCreateAndClassifyLead={(status) => createAndClassifyLead(status, true)}
                        onToggleConversationBot={toggleConversationBot}
                        onReactivateBot={reactivateBot}
                        onTakeOverFromBia={takeOverFromBia}
                        onReturnToBia={returnToBia}
                        onDismissAiReply={dismissAiReply}
                        onResumeWithAi={resumeWithAi}
                        onToggleFavorite={toggleFavorite}
                        onLeadNameChange={(newName) => {
                          setLinkedLead(prev => prev ? { ...prev, name: newName } : null);
                          setSelectedConversation(prev => prev ? { ...prev, contact_name: newName } : null);
                          setConversations(prevConvs => prevConvs.map(c => 
                            c.id === selectedConversation.id ? { ...c, contact_name: newName } : c
                          ));
                        }}
                        onLeadObsChange={(newObs) => {
                          setLinkedLead(prev => prev ? { ...prev, observacoes: newObs || null } : null);
                        }}
                        onShowVisitDialog={(type) => { if (linkedLead) { setQuickVisitType(type || "visita"); setShowQuickVisitDialog(true); } }}
                        visitRefreshKey={visitRefreshKey}
                      />
                      {/* O.E. (Orçamento Enviado) button - always visible, disabled without lead */}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        disabled={!linkedLead}
                        onClick={async () => {
                          if (!linkedLead) return;
                          const isCurrentlyOE = linkedLead.status === 'orcamento_enviado';
                          const newStatus = isCurrentlyOE ? 'em_contato' : 'orcamento_enviado';
                          const statusLabels: Record<string, string> = {
                            novo: 'Novo',
                            em_contato: 'Visita',
                            orcamento_enviado: 'Orçamento Enviado',
                            aguardando_resposta: 'Negociando',
                            fechado: 'Fechado',
            perdido: 'Perdido',
            fornecedor: 'Fornecedor',
            cliente_retorno: 'Cliente Retorno',
          };
                          
                          const { error } = await supabase
                            .from('campaign_leads')
                            .update({ status: newStatus })
                            .eq('id', linkedLead.id);
                          
                          if (error) {
                            toast({
                              title: "Erro ao atualizar status",
                              description: error.message,
                              variant: "destructive",
                            });
                            return;
                          }
                          
                          // Add history entry
                          await supabase.from('lead_history').insert({
                            lead_id: linkedLead.id,
                            user_id: userId,
                            user_name: currentUserName || 'Usuário',
                            action: 'Alteração de status',
                            old_value: statusLabels[linkedLead.status] || linkedLead.status,
                            new_value: statusLabels[newStatus],
                          });
                          
                          // Update local state
                          setLinkedLead(prev => (prev && prev.id === linkedLead.id ? { ...prev, status: newStatus as any } : prev));
                          
                          toast({
                            title: isCurrentlyOE ? "Orçamento desmarcado" : "Orçamento marcado",
                            description: isCurrentlyOE ? "Status alterado para 'Visita'" : "Status alterado para 'Orçamento Enviado'",
                          });
                        }}
                        title={!linkedLead ? "Vincule um lead primeiro" : (linkedLead.status === 'orcamento_enviado' ? "Desmarcar Orçamento Enviado" : "Marcar como Orçamento Enviado")}
                      >
                        <FileCheck className={cn(
                          "w-4 h-4",
                          !linkedLead ? "text-muted-foreground/50" : (linkedLead.status === 'orcamento_enviado' ? "text-purple-600" : "text-muted-foreground")
                        )} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => toggleScheduledVisit(selectedConversation)}
                        title={selectedConversation.has_scheduled_visit ? "Desmarcar visita" : "Marcar visita agendada"}
                      >
                        <CalendarCheck className={cn(
                          "w-4 h-4",
                          selectedConversation.has_scheduled_visit ? "text-blue-600" : "text-muted-foreground"
                        )} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => toggleFreelancer(selectedConversation)}
                        title={selectedConversation.is_freelancer ? "Desmarcar como Freelancer" : "Marcar como Freelancer"}
                      >
                        <Briefcase className={cn(
                          "w-4 h-4",
                          selectedConversation.is_freelancer ? "text-orange-600" : "text-muted-foreground"
                        )} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => toggleEquipe(selectedConversation)}
                        title={selectedConversation.is_equipe ? "Desmarcar como Equipe" : "Marcar como Equipe"}
                      >
                        <Users className={cn(
                          "w-4 h-4",
                          selectedConversation.is_equipe ? "text-cyan-600" : "text-muted-foreground"
                        )} />
                      </Button>
                      {leadEventId && financialPerms.canView && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => setShowFinancialSheet(true)}
                          title="Financeiro do evento"
                        >
                          <DollarSign className="w-4 h-4 text-emerald-500" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => toggleFavorite(selectedConversation)}
                      >
                        {selectedConversation.is_favorite ? (
                          <Star className="w-4 h-4 text-secondary fill-secondary" />
                        ) : (
                          <Star className="w-4 h-4 text-muted-foreground" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn("h-8 w-8", isSelectMode && "bg-primary/10 text-primary")}
                        onClick={() => { setIsSelectMode(prev => !prev); setSelectedMediaIds(new Set()); }}
                        title="Selecionar imagens para download"
                      >
                        <CheckSquare className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={openMessageSearch}
                        title="Buscar nas mensagens"
                      >
                        <Search className="w-4 h-4 text-muted-foreground" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => toggleConversationClosed(selectedConversation)}
                        title={selectedConversation.is_closed ? "Reabrir conversa" : "Encerrar conversa"}
                      >
                        <X className={cn(
                          "w-4 h-4",
                          selectedConversation.is_closed 
                            ? "text-destructive" 
                            : "text-muted-foreground"
                        )} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 relative"
                        onClick={() => setShowAutomationTimeline(true)}
                        title="Automações enviadas"
                      >
                        <Bot className="w-4 h-4 text-muted-foreground" />
                        {messages.filter(m => isAutomationMessage(m.metadata as Record<string, string> | null)).length > 0 && (
                          <span className="absolute -top-0.5 -right-0.5 bg-primary text-primary-foreground text-[9px] font-bold rounded-full h-4 min-w-4 flex items-center justify-center px-0.5">
                            {messages.filter(m => isAutomationMessage(m.metadata as Record<string, string> | null)).length}
                          </span>
                        )}
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            title="Mais ações"
                          >
                            <MoreVertical className="w-4 h-4 text-muted-foreground" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                          <DropdownMenuItem onClick={() => setShowContactInfoSheet(true)}>
                            <Info className="w-4 h-4 mr-2" />
                            Dados do contato
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => handleStartQualification(false)}
                          >
                            <PlayCircle className="w-4 h-4 mr-2 text-primary" />
                            Iniciar qualificação
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleResumeQualification()}
                          >
                            <Bot className="w-4 h-4 mr-2 text-primary" />
                            Retomar bot do passo atual
                          </DropdownMenuItem>
                          {blockTail && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => void toggleContactBlock()} disabled={contactBlockSaving}>
                                {contactBlocked
                                  ? <><BellRing className="w-4 h-4 mr-2 text-primary" />Voltar a enviar mensagens automáticas</>
                                  : <><BellOff className="w-4 h-4 mr-2 text-destructive" />Não enviar mais nada</>}
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  {/* Message Search Bar - Desktop */}
                  {messageSearchActive && (
                    <div className="px-3 py-2 border-b border-border/40 bg-muted/30 flex items-center gap-2 shrink-0">
                      <Search className="w-4 h-4 text-muted-foreground shrink-0" />
                      <Input
                        ref={messageSearchInputRef}
                        placeholder="Buscar nas mensagens..."
                        value={messageSearchQuery}
                        onChange={(e) => setMessageSearchQuery(e.target.value)}
                        className="h-8 text-sm bg-background/80 border-border/60"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') navigateSearchResult(e.shiftKey ? 'prev' : 'next');
                          if (e.key === 'Escape') closeMessageSearch();
                        }}
                      />
                      {messageSearchResults.length > 0 && (
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {currentSearchIndex + 1}/{messageSearchResults.length}
                        </span>
                      )}
                      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => navigateSearchResult('prev')} disabled={messageSearchResults.length === 0}>
                        <ChevronUp className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => navigateSearchResult('next')} disabled={messageSearchResults.length === 0}>
                        <ChevronDown className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={closeMessageSearch}>
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
      )}

                  {linkedLead && currentCompany && (
                    <ClientDataBar
                      companyId={currentCompany.id}
                      companyName={currentCompany.name}
                      customDomain={currentCompany.custom_domain}
                      lead={linkedLead}
                      sendText={sendTextMessageDirect}
                    />
                  )}
                  {contactBlocked && (
                    <div className="px-3 py-1.5 border-b border-destructive/20 bg-destructive/10 text-destructive text-xs font-medium flex items-center gap-2 shrink-0">
                      <BellOff className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">Não recebe mensagens automáticas</span>
                      <button type="button" className="ml-auto underline shrink-0" onClick={() => void toggleContactBlock()} disabled={contactBlockSaving}>Liberar</button>
                    </div>
                  )}

                  {/* Lead Classification Panel - Always visible */}
                  <div className="border-b border-border/40 bg-muted/30 px-3 py-2 shrink-0 overflow-hidden">
                    {linkedLead ? (
                      // Show classification stepper when lead is linked
                      <div className="flex items-center gap-1 overflow-x-auto scrollbar-thin py-1.5">
                        {[
                          { value: 'novo', label: 'Novo', color: 'bg-blue-500', textColor: 'text-blue-700', bgActive: 'bg-blue-500/15' },
                          { value: 'trabalhe_conosco', label: 'Trab. Conosco', color: 'bg-teal-500', textColor: 'text-teal-700', bgActive: 'bg-teal-500/15' },
                          { value: 'em_contato', label: 'Visita', color: 'bg-yellow-500', textColor: 'text-yellow-700', bgActive: 'bg-yellow-500/15' },
                          { value: 'orcamento_enviado', label: 'Orçamento', color: 'bg-purple-500', textColor: 'text-purple-700', bgActive: 'bg-purple-500/15' },
                          { value: 'aguardando_resposta', label: 'Negociando', color: 'bg-orange-500', textColor: 'text-orange-700', bgActive: 'bg-orange-500/15' },
                          { value: 'fechado', label: 'Fechado', color: 'bg-green-500', textColor: 'text-green-700', bgActive: 'bg-green-500/15' },
                          { value: 'perdido', label: 'Perdido', color: 'bg-red-500', textColor: 'text-red-700', bgActive: 'bg-red-500/15' },
                          { value: 'transferido', label: 'Transf.', color: 'bg-cyan-500', textColor: 'text-cyan-700', bgActive: 'bg-cyan-500/15' },
                          { value: 'fornecedor', label: 'Fornec.', color: 'bg-indigo-500', textColor: 'text-indigo-700', bgActive: 'bg-indigo-500/15' },
                          { value: 'cliente_retorno', label: 'Retorno', color: 'bg-pink-500', textColor: 'text-pink-700', bgActive: 'bg-pink-500/15' },
                          { value: 'outros', label: 'Outros', color: 'bg-gray-500', textColor: 'text-gray-700', bgActive: 'bg-gray-500/15' },
                        ].map((statusOption, index, arr) => {
                          const isActive = linkedLead.status === statusOption.value;
                          return (
                            <div key={statusOption.value} className="flex items-center shrink-0">
                              <button
                                className={cn(
                                  "flex items-center gap-1 px-2 py-1.5 rounded-full text-[11px] font-medium transition-all duration-200",
                                  isActive
                                    ? cn(statusOption.bgActive, statusOption.textColor, "ring-1 ring-current/30 shadow-sm")
                                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                                )}
                                onClick={async () => {
                                  const oldStatus = linkedLead.status;
                  const newStatus = statusOption.value as "novo" | "em_contato" | "orcamento_enviado" | "aguardando_resposta" | "fechado" | "perdido" | "trabalhe_conosco" | "transferido" | "fornecedor" | "cliente_retorno" | "outros";

                                  if (oldStatus === newStatus) return;
                                  
                                  const { error } = await supabase
                                    .from('campaign_leads')
                                    .update({ status: newStatus })
                                    .eq('id', linkedLead.id);
                                  
                                  if (error) {
                                    toast({
                                      title: "Erro ao atualizar",
                                      description: error.message,
                                      variant: "destructive",
                                    });
                                    return;
                                  }
                                  
                                  const statusLabels: Record<string, string> = {
                                    novo: 'Novo',
                                    em_contato: 'Visita',
                                    orcamento_enviado: 'Orçamento Enviado',
                                    aguardando_resposta: 'Negociando',
                                    fechado: 'Fechado',
                                    perdido: 'Perdido',
                                    transferido: 'Transferência',
                                    fornecedor: 'Fornecedor',
                                    cliente_retorno: 'Cliente Retorno',
                                    outros: 'Outros',
                                  };
                                  
                                  await supabase.from('lead_history').insert({
                                    lead_id: linkedLead.id,
                                    company_id: getCurrentCompanyId(),
                                    action: 'status_change',
                                    old_value: statusLabels[oldStatus] || oldStatus,
                                    new_value: statusLabels[newStatus] || newStatus,
                                    user_id: userId,
                                  });
                                  
                                  const updatedLead = { ...linkedLead, status: statusOption.value };
                                  // Só troca o lead da tela se ainda for o mesmo (trocou de conversa no meio)
                                  setLinkedLead(prev => (prev && prev.id === updatedLead.id ? updatedLead : prev));
                                  // Sync conversationLeadsMap so sidebar badge updates simultaneously
                                  if (selectedConversation) {
                                    setConversationLeadsMap(prev => ({ ...prev, [selectedConversation.id]: updatedLead }));
                                  }

                                  // Sync has_scheduled_visit with em_contato status
                                  if (newStatus === 'em_contato' || oldStatus === 'em_contato') {
                                    const shouldHaveVisit = newStatus === 'em_contato';
                                    if (selectedConversation) {
                                      await supabase.from('wapi_conversations').update({ has_scheduled_visit: shouldHaveVisit }).eq('id', selectedConversation.id);
                                      setConversations(prev => prev.map(c => c.id === selectedConversation.id ? { ...c, has_scheduled_visit: shouldHaveVisit } : c));
                                      setSelectedConversation(prev => (prev && prev.id === selectedConversation.id ? { ...prev, has_scheduled_visit: shouldHaveVisit } : prev));
                                    }
                                  }

                                  if (newStatus === 'fechado') {
                                    void onLeadClosedMobile?.(updatedLead);
                                  }

                                   if (newStatus === 'em_contato') {
                                     setQuickVisitType("visita");
                                     setShowQuickVisitDialog(true);
                                   }

                                  const statusBorderColors: Record<string, string> = {
                                    'bg-blue-500': '#3b82f6', 'bg-teal-500': '#14b8a6', 'bg-yellow-500': '#eab308',
                                    'bg-purple-500': '#a855f7', 'bg-orange-500': '#f97316', 'bg-green-500': '#22c55e',
                                    'bg-red-500': '#ef4444', 'bg-cyan-500': '#06b6d4', 'bg-indigo-500': '#6366f1',
                                    'bg-pink-500': '#ec4899', 'bg-gray-500': '#6b7280',
                                  };
                                  toast({
                                    title: "Status atualizado",
                                    description: `Lead classificado como "${statusOption.label}"`,
                                    className: "border-l-4",
                                    style: { borderLeftColor: statusBorderColors[statusOption.color] || '#6b7280' },
                                  });
                                }}
                              >
                                <div className={cn(
                                  "w-2 h-2 rounded-full transition-all",
                                  isActive ? statusOption.color : "bg-muted-foreground/30"
                                )} />
                                {statusOption.label}
                              </button>
                              {index < arr.length - 1 && (
                                <div className="w-2 h-px bg-border mx-0.5" />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      // Show classification buttons directly - no lead linked yet
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-destructive shrink-0">⚠ Não qualificado:</span>
                        {[
                          { value: 'novo', label: 'Novo', color: 'bg-blue-500' },
                          { value: 'trabalhe_conosco', label: 'Trab. Conosco', color: 'bg-teal-500' },
                          { value: 'em_contato', label: 'Visita', color: 'bg-yellow-500' },
                          { value: 'orcamento_enviado', label: 'Orçamento', color: 'bg-purple-500' },
                          { value: 'aguardando_resposta', label: 'Negociando', color: 'bg-orange-500' },
                          { value: 'fechado', label: 'Fechado', color: 'bg-green-500' },
                          { value: 'perdido', label: 'Perdido', color: 'bg-red-500' },
                          { value: 'transferido', label: 'Transferência', color: 'bg-cyan-500' },
                          { value: 'fornecedor', label: 'Fornecedor', color: 'bg-indigo-500' },
                          { value: 'cliente_retorno', label: 'Cliente Retorno', color: 'bg-pink-500' },
                          { value: 'outros', label: 'Outros', color: 'bg-gray-500' },
                        ].map((statusOption) => (
                          <Button
                            key={statusOption.value}
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs gap-1.5"
                            disabled={isCreatingLead}
                            onClick={() => createAndClassifyLead(statusOption.value, true)}
                          >
                            {isCreatingLead ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <div className={cn("w-2 h-2 rounded-full", statusOption.color)} />
                            )}
                            {statusOption.label}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Unresolved @lid banner - desktop */}
                  {isUnresolvedLidIdentifier(selectedConversation?.remote_jid, selectedConversation?.contact_phone) && (
                    <div className="flex items-start gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-900">
                      <Clock className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
                      <div className="flex-1">
                        <p className="font-medium">Aguardando o WhatsApp revelar o número real deste contato.</p>
                        <p className="text-amber-800/80 mt-0.5">
                          Este lead chegou com identificador anônimo (@lid). Será atualizado automaticamente na próxima mensagem dele — evite enviar manualmente até lá, pois a entrega pode falhar.
                        </p>
                      </div>
                    </div>
                  )}
                  {/* Pinned message banner - desktop */}
                  {selectedConversation?.pinned_message_id && (() => {
                    const pinnedMsg = messages.find(m => m.id === selectedConversation.pinned_message_id);
                    if (!pinnedMsg) return null;
                    return (
                      <div className="flex items-center gap-2 px-4 py-2 bg-accent/50 border-b text-sm cursor-pointer hover:bg-accent/70 transition-colors" onClick={() => {
                        const el = document.getElementById(`msg-${pinnedMsg.id}`);
                        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }}>
                        <Pin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        <span className="truncate text-muted-foreground">{pinnedMsg.content || `[${pinnedMsg.message_type}]`}</span>
                        <Button variant="ghost" size="icon" className="h-5 w-5 ml-auto shrink-0" onClick={(e) => { e.stopPropagation(); handlePinMessage(pinnedMsg); }}>
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    );
                  })()}
                  {/* Messages */}
                  <div className="flex-1 relative min-h-0">
                    <ScrollArea ref={scrollAreaDesktopRef} className="h-full whatsapp-chat-bg [&_[data-radix-scroll-area-viewport]]:!overflow-x-hidden [&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!w-full [&_[data-radix-scroll-area-viewport]>div]:!min-w-0">
                      <div className="space-y-2 sm:space-y-3 p-3 sm:p-4">
                        {/* Loading indicator at top */}
                        {isLoadingMoreMessages && (
                          <div className="flex justify-center py-2">
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Loader2 className="w-3 h-3 animate-spin" />
                              Carregando mensagens...
                            </div>
                          </div>
                        )}
                        
                        {/* Start of conversation indicator - only show when user has scrolled to top and there are no more messages */}
                        {!hasMoreMessages && messages.length > 0 && !isLoadingMessages && hasUserScrolledToTop && (
                          <div className="flex justify-center py-2">
                            <span className="text-xs text-muted-foreground bg-muted/50 px-3 py-1 rounded-full">
                              📬 Início da conversa
                            </span>
                          </div>
                        )}
                        
                        {isLoadingMessages ? (
                          <div className="flex flex-col items-center justify-center py-12 text-center">
                            <Loader2 className="w-8 h-8 text-muted-foreground mb-3 animate-spin" />
                            <p className="text-sm text-muted-foreground">
                              Carregando mensagens...
                            </p>
                          </div>
                        ) : messages.length === 0 ? (
                          <div className="flex flex-col items-center justify-center py-12 text-center">
                            <MessageSquare className="w-10 h-10 text-muted-foreground mb-3" />
                            <p className="text-sm text-muted-foreground">
                              Nenhuma mensagem ainda
                            </p>
                          </div>
                        ) : (
                          displayMessages.map((msg, idx) => {
                            const showDateSep = idx === 0 || getDateKey(msg.timestamp) !== getDateKey(displayMessages[idx - 1].timestamp);
                            return (
                            <div key={msg.id} id={`msg-${msg.id}`} className={cn(
                              messageSearchResults.includes(msg.id) && "ring-2 ring-primary/50 rounded-xl",
                              messageSearchResults[currentSearchIndex] === msg.id && "ring-2 ring-primary bg-primary/5 rounded-xl"
                            )}>
                            {showDateSep && (
                              <div className="flex justify-center my-3">
                                <span className="bg-muted text-muted-foreground text-xs px-3 py-1 rounded-md shadow-sm font-medium">
                                  {formatDateSeparator(msg.timestamp)}
                                </span>
                              </div>
                            )}
                            {/* Follow-up/reactivation chip instead of full bubble */}
                            {isAutomationMessage(msg.metadata as Record<string, string> | null) ? (
                              <FollowUpChip
                                content={msg.content}
                                timestamp={msg.timestamp}
                                metadataType={(msg.metadata as Record<string, string> | null)?.type}
                                metadataSource={(msg.metadata as Record<string, string> | null)?.source}
                              />
                            ) : (
                            <div
                              className={cn(
                                "flex group w-full max-w-full min-w-0 overflow-hidden",
                                msg.from_me ? "justify-end" : "justify-start"
                              )}
                            >
                              <div className={cn("relative w-full min-w-0 overflow-hidden", msg.from_me ? "flex flex-row-reverse items-start gap-1" : "flex items-start gap-1")}>
                                 <div
                                   {...(editingMessageId !== msg.id ? messagePressHandlers(msg.id) : {})}
                                   style={messageTouchStyle}
                                   className={cn(
                                     // No celular, segurar abre o menu (sem selecionar o texto); "Copiar" fica no menu
                                     "rounded-2xl text-sm [@media(hover:none)]:select-none",
                                      (msg.message_type === 'image' || msg.message_type === 'video' || msg.message_type === 'sticker')
                                        ? "max-w-[60%] sm:max-w-[45%] bg-transparent p-0 overflow-hidden shadow-none"
                                       : cn(
                                           "max-w-[85%] sm:max-w-[75%] px-3.5 py-2.5",
                                           msg.from_me
                                             ? "bg-primary text-primary-foreground shadow-sm"
                                             : "bg-card border border-border/50 shadow-subtle"
                                         )
                                   )}
                                 >
{/* Group sender name */}
{selectedConversation?.remote_jid?.includes('@g.us') && !msg.from_me && (
  <p className="text-xs font-semibold mb-0.5" style={{ color: getSenderColor((msg.metadata as Record<string, string> | null)?.participant) }}>
    {(msg.metadata as Record<string, string> | null)?.sender_name || (msg.metadata as Record<string, string> | null)?.participant || 'Desconhecido'}
  </p>
)}
{(msg.message_type === 'image' || msg.message_type === 'video' || msg.message_type === 'audio' || msg.message_type === 'document') && (
                                  <div className={cn(
                                    "relative",
                                    (msg.message_type === 'image' || msg.message_type === 'video') ? "" : "mb-2"
                                  )}>
                                    {isSelectMode && msg.message_type === 'image' && (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); toggleMediaSelection(msg.id); }}
                                        className="absolute top-2 left-2 z-10 w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all bg-background/80 backdrop-blur-sm hover:bg-background"
                                        style={{ borderColor: selectedMediaIds.has(msg.id) ? 'hsl(var(--primary))' : 'hsl(var(--border))' }}
                                      >
                                        {selectedMediaIds.has(msg.id) && <Check className="w-4 h-4 text-primary" />}
                                      </button>
                                    )}
                                    <MediaMessage
                                      messageId={msg.message_id}
                                      mediaType={msg.message_type as 'image' | 'video' | 'audio' | 'document'}
                                      mediaUrl={msg.media_url}
                                      content={msg.content}
                                      fromMe={msg.from_me}
                                      instanceId={selectedInstance?.instance_id}
                                      onMediaUrlUpdate={(url) => {
                                        setMessages(prev => prev.map(m => 
                                          m.id === msg.id ? { ...m, media_url: url } : m
                                        ));
                                      }}
                                    />
                                  </div>
                                 )}
                                 {msg.message_type === 'sticker' && (
                                   msg.media_url && !msg.media_url.includes('.enc') ? (
                                     <StickerImage src={msg.media_url} />
                                   ) : (
                                     <div className="text-2xl">🎭</div>
                                   )
                                 )}
                                {msg.message_type === 'contact' && (() => {
                                  const raw = msg.content?.replace(/^\[Contato\]\s*/, '').replace(/^👤\s*/, '') || 'Contato';
                                  const parts = raw.split(' - ');
                                  const contactDisplayName = parts[0]?.trim() || 'Contato';
                                  const contactPhoneNum = parts.slice(1).join(' - ')?.trim() || '';
                                  return (
                                    <div className={cn(
                                      "rounded-xl overflow-hidden min-w-[220px] max-w-[280px]",
                                      msg.from_me
                                        ? "border border-primary-foreground/15"
                                        : "border border-border shadow-sm"
                                    )}>
                                      {/* Header */}
                                      <div className={cn(
                                        "flex items-center gap-3 px-3 py-2.5",
                                        msg.from_me ? "bg-primary-foreground/10" : "bg-muted/50"
                                      )}>
                                        <div className={cn(
                                          "w-9 h-9 rounded-full flex items-center justify-center shrink-0",
                                          msg.from_me
                                            ? "bg-primary-foreground/20"
                                            : "bg-gradient-to-br from-primary/20 to-primary/5"
                                        )}>
                                          <Users className={cn("w-4 h-4", msg.from_me ? "text-primary-foreground" : "text-primary")} />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                          <p className={cn("text-sm font-semibold truncate leading-tight", msg.from_me ? "text-primary-foreground" : "text-foreground")}>
                                            {contactDisplayName}
                                          </p>
                                          {contactPhoneNum && (
                                            <p className={cn("text-xs truncate mt-0.5", msg.from_me ? "text-primary-foreground/60" : "text-muted-foreground")}>
                                              {contactPhoneNum}
                                            </p>
                                          )}
                                        </div>
                                      </div>
                                      {/* Action footer */}
                                      {contactPhoneNum && (
                                        <div className={cn(
                                          "flex divide-x border-t",
                                          msg.from_me ? "border-primary-foreground/15 divide-primary-foreground/15" : "border-border divide-border"
                                        )}>
                                          <button
                                            className={cn(
                                              "flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors",
                                              msg.from_me
                                                ? "text-primary-foreground/80 hover:bg-primary-foreground/10"
                                                : "text-primary hover:bg-primary/5"
                                            )}
                                            onClick={() => { navigator.clipboard.writeText(contactPhoneNum); toast({ title: "Telefone copiado!", description: contactPhoneNum }); }}
                                          >
                                            <Copy className="w-3 h-3" />
                                            Copiar
                                          </button>
                                          <button
                                            className={cn(
                                              "flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors",
                                              msg.from_me
                                                ? "text-primary-foreground/80 hover:bg-primary-foreground/10"
                                                : "text-primary hover:bg-primary/5"
                                            )}
                                            onClick={() => {
                                              const cleanPhone = contactPhoneNum.replace(/\D/g, '');
                                              // Try to find existing conversation by phone digits
                                              const match = conversations.find(c => {
                                                const cDigits = c.contact_phone.replace(/\D/g, '');
                                                return cDigits.includes(cleanPhone) || cleanPhone.includes(cDigits);
                                              });
                                              if (match) {
                                                setSelectedConversation(match);
                                                setSearchQuery('');
                                              } else {
                                                setSearchQuery(cleanPhone);
                                                clearLastActiveConversation();
                                                setSelectedConversation(null);
                                              }
                                            }}
                                          >
                                            <MessageSquare className="w-3 h-3" />
                                            Conversar
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()}
                                {/* Quoted message reference */}
                                {msg.quoted_message_id && (() => {
                                  const quoted = messages.find(m => m.id === msg.quoted_message_id);
                                  if (!quoted) return null;
                                  return (
                                    <div 
                                      className={cn(
                                        "px-3 py-1.5 mb-1 rounded border-l-2 cursor-pointer text-xs",
                                        msg.from_me ? "bg-primary/20 border-primary-foreground/40" : "bg-muted border-primary"
                                      )}
                                      onClick={() => {
                                        const el = document.getElementById(`msg-${quoted.id}`);
                                        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                      }}
                                    >
                                      <p className={cn("font-medium", msg.from_me ? "text-primary-foreground/80" : "text-primary")}>
                                        {quoted.from_me ? 'Você' : (selectedConversation?.contact_name || 'Contato')}
                                      </p>
                                      <p className={cn("truncate", msg.from_me ? "text-primary-foreground/60" : "text-muted-foreground")}>
                                        {quoted.content || `[${quoted.message_type}]`}
                                      </p>
                                    </div>
                                  );
                                })()}
                                {/* Star indicator */}
                                {msg.is_starred && (
                                  <Star className={cn("w-3 h-3 mb-0.5", msg.from_me ? "text-primary-foreground/60" : "text-yellow-500")} />
                                )}
                                {msg.message_type === 'text' && editingMessageId === msg.id ? (
                                  <div className="space-y-2">
                                    <Textarea
                                      value={editingContent}
                                      onChange={(e) => setEditingContent(e.target.value)}
                                      className="min-h-[40px] text-sm bg-background text-foreground"
                                      rows={2}
                                      autoFocus
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                          e.preventDefault();
                                          handleSaveEdit(msg.id, msg.message_id);
                                        }
                                        if (e.key === 'Escape') {
                                          setEditingMessageId(null);
                                          setEditingContent("");
                                        }
                                      }}
                                    />
                                    <div className="flex gap-1 justify-end">
                                      <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => { setEditingMessageId(null); setEditingContent(""); }}>
                                        Cancelar
                                      </Button>
                                      <Button size="sm" className="h-6 text-xs" onClick={() => handleSaveEdit(msg.id, msg.message_id)} disabled={isSavingEdit}>
                                        {isSavingEdit ? <Loader2 className="w-3 h-3 animate-spin" /> : "Salvar"}
                                      </Button>
                                    </div>
                                  </div>
                                ) : msg.message_type === 'text' ? (
                                  <>
                                    <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{formatMessageContent(msg.content)}</p>
                                    {extractFirstUrl(msg.content) && (
                                      <LinkPreviewCard url={extractFirstUrl(msg.content)!} fromMe={msg.from_me} />
                                    )}
                                  </>
                                ) : null}
                                {msg.message_type !== 'text' && msg.message_type !== 'contact' && msg.content && msg.content !== '[Imagem]' && msg.content !== '[Áudio]' && (
                                  <p className={cn(
                                    "whitespace-pre-wrap break-words [overflow-wrap:anywhere] mt-1",
                                    (msg.message_type === 'image' || msg.message_type === 'video') && "px-3 py-2 rounded-b-2xl bg-card text-foreground border border-t-0 border-border/50"
                                  )}>{formatMessageContent(msg.content)}</p>
                                )}
                                <div className={cn(
                                  "flex items-center gap-1 mt-1",
                                  msg.from_me ? "justify-end" : "justify-start",
                                  (msg.message_type === 'image' || msg.message_type === 'video') && "px-2 pb-1"
                                )}>
                                  {(() => {
                                    const tag = senderTag(msg);
                                    if (tag) return <span className="text-[10px] font-medium px-1.5 rounded-full bg-black/10 whitespace-nowrap">{tag}</span>;
                                    const dot = senderDot(msg);
                                    return dot && <span className={cn("w-2 h-2 rounded-full inline-block shrink-0", dot.className)} title={dot.title} />;
                                  })()}
                                  <span className={cn(
                                    "text-[10px]",
                                    (msg.message_type === 'image' || msg.message_type === 'video')
                                      ? "text-muted-foreground"
                                      : (msg.from_me ? "text-primary-foreground/70" : "text-muted-foreground")
                                  )}>
                                    {formatMessageTime(msg.timestamp)}
                                  </span>
                                  {msg.from_me && getStatusIcon(msg.status, msg)}
                                </div>
                                </div>
                                {/* Context menu for all messages */}
                                {editingMessageId !== msg.id && (
                                  <DropdownMenu open={messageMenuId === msg.id} onOpenChange={(open) => setMessageMenuId(open ? msg.id : null)}>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        // Tela de toque (tablet) não tem "passar o mouse": a setinha fica sempre à vista
                                        className="h-6 w-6 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-60 transition-opacity shrink-0"
                                      >
                                        <ChevronDown className="w-3 h-3" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align={msg.from_me ? "end" : "start"}>
                                      {/* Emoji reaction row */}
                                      {msg.message_id && (
                                        <>
                                          <div className="flex items-center gap-1 px-2 py-1.5">
                                            {REACTION_EMOJIS.map(emoji => (
                                              <button
                                                key={emoji}
                                                className="text-lg hover:scale-125 transition-transform p-0.5 rounded hover:bg-accent"
                                                onClick={() => handleReaction(msg, emoji)}
                                              >
                                                {emoji}
                                              </button>
                                            ))}
                                          </div>
                                          <DropdownMenuSeparator />
                                        </>
                                      )}
                                      <DropdownMenuItem onClick={() => {
                                        setReplyingTo(msg);
                                        messageTextareaRef.current?.focus();
                                      }}>
                                        <Reply className="w-4 h-4 mr-2" />
                                        Responder
                                      </DropdownMenuItem>
                                      {msg.content && (
                                        <DropdownMenuItem onClick={() => {
                                          navigator.clipboard.writeText(msg.content!);
                                          toast({ title: "Copiado!" });
                                        }}>
                                          <Copy className="w-4 h-4 mr-2" />
                                          Copiar
                                        </DropdownMenuItem>
                                      )}
                                      {isMessageEditable(msg) && (
                                        <DropdownMenuItem onClick={() => {
                                          setEditingMessageId(msg.id);
                                          setEditingContent(msg.content || "");
                                        }}>
                                          <Pencil className="w-4 h-4 mr-2" />
                                          Editar
                                        </DropdownMenuItem>
                                      )}
                                      {msg.media_url && (
                                        <DropdownMenuItem onClick={() => window.open(msg.media_url!, '_blank')}>
                                          <Download className="w-4 h-4 mr-2" />
                                          Baixar
                                        </DropdownMenuItem>
                                      )}
                                      <DropdownMenuItem onClick={() => handlePinMessage(msg)}>
                                        {selectedConversation?.pinned_message_id === msg.id ? (
                                          <><PinOff className="w-4 h-4 mr-2" />Desafixar</>
                                        ) : (
                                          <><Pin className="w-4 h-4 mr-2" />Fixar</>
                                        )}
                                      </DropdownMenuItem>
                                      <DropdownMenuItem onClick={() => handleStarMessage(msg)}>
                                        {msg.is_starred ? (
                                          <><StarOff className="w-4 h-4 mr-2" />Desfavoritar</>
                                        ) : (
                                          <><Star className="w-4 h-4 mr-2" />Favoritar</>
                                        )}
                                      </DropdownMenuItem>
                                      {msg.from_me && (
                                        <>
                                          <DropdownMenuSeparator />
                                          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleteMessageId(msg.id)}>
                                            <Trash2 className="w-4 h-4 mr-2" />
                                            Apagar
                                          </DropdownMenuItem>
                                        </>
                                      )}
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                )}
                              </div>
                               {isAutomationMessage(msg.metadata as Record<string, string> | null) && (
                                <div className={cn(
                                  "flex items-center gap-1 mt-0.5 text-[10px] text-muted-foreground/70",
                                  msg.from_me ? "justify-end mr-1" : "justify-start ml-1"
                                )}>
                                  <Clock className="w-2.5 h-2.5" />
                                  <span>
                                    {msg.metadata.type === 'next_step_reminder' ? 'Lembrete automático' :
                                     msg.metadata.type === 'follow_up_1' ? 'Follow-up automático' :
                                     msg.metadata.type === 'follow_up_2' ? '2º follow-up automático' :
                                     msg.metadata.type === 'bot_inactive' ? 'Reenvio por inatividade' :
                                     'Enviado automaticamente'}
                                  </span>
                                </div>
                              )}
                            </div>
                            )}
                            <MessageReactions reactions={reactionsByMessage.get(msg.id)} fromMe={msg.from_me} contactName={selectedConversation?.contact_name} />
                            </div>
                            );
                          })

                        )}
                        <div ref={bottomRefDesktop} style={{ height: 1 }} />
                      </div>
                    </ScrollArea>
                    {/* Scroll to bottom button - only show when not at bottom */}
                    {!isAtBottom && (
                      <Button
                        variant="secondary"
                        size="icon"
                        className="absolute bottom-4 right-4 h-10 w-10 rounded-full shadow-lg opacity-90 hover:opacity-100 z-10"
                        onClick={() => scrollToBottomDesktop()}
                        title="Ir para última mensagem"
                      >
                        <ArrowDown className="w-5 h-5" />
                        {unreadNewMessagesCount > 0 && (
                          <span className="absolute -top-1 -right-1 bg-primary text-primary-foreground text-xs font-bold rounded-full h-5 min-w-5 flex items-center justify-center px-1">
                            {unreadNewMessagesCount > 99 ? '99+' : unreadNewMessagesCount}
                          </span>
                        )}
                      </Button>
                    )}
                  </div>

                  {/* Batch download floating bar - Desktop */}
                  {isSelectMode && (
                    <div className="px-4 py-2 border-t border-border/40 bg-primary/5 flex items-center justify-between gap-2 shrink-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {selectedMediaIds.size} imagem(ns) selecionada(s)
                        </span>
                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={selectAllImages}>
                          Selecionar todas
                        </Button>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => { setIsSelectMode(false); setSelectedMediaIds(new Set()); }}
                        >
                          Cancelar
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={selectedMediaIds.size === 0 || isBatchDownloading}
                          onClick={handleBatchDownloadIndividual}
                          title="Salvar cada imagem separadamente no PC"
                        >
                          {isBatchDownloading ? (
                            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                          ) : (
                            <><Download className="w-3 h-3 mr-1" /> Salvar no PC</>
                          )}
                        </Button>
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          disabled={selectedMediaIds.size === 0 || isBatchDownloading}
                          onClick={handleBatchDownload}
                        >
                          {isBatchDownloading ? (
                            <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Baixando...</>
                          ) : (
                            <><Download className="w-3 h-3 mr-1" /> Baixar ZIP</>
                          )}
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Message Input */}
                  <div className="px-4 py-3 border-t border-border/40 shrink-0 bg-card">
                    {/* Reply preview bar */}
                    {replyingTo && (
                      <div className="flex items-center gap-2 mb-2 p-2 bg-muted rounded-lg border-l-4 border-primary">
                        <Reply className="w-4 h-4 text-primary shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-primary">{replyingTo.from_me ? 'Você' : (selectedConversation?.contact_name || 'Contato')}</p>
                          <p className="text-xs text-muted-foreground truncate">{replyingTo.content || `[${replyingTo.message_type}]`}</p>
                        </div>
                        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => setReplyingTo(null)}>
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    )}
                    {isRecording ? (
                      <div className="flex items-center gap-2">
                        <div className="flex-1 flex items-center gap-3 bg-muted rounded-lg px-4 py-2">
                          <div className="w-3 h-3 rounded-full bg-destructive animate-pulse" />
                          <span className="font-mono text-lg">
                            {formatRecordingTime(recordingTime)}
                          </span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="shrink-0"
                          onClick={cancelRecording}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          className="shrink-0"
                          onClick={handleStopAndSend}
                        >
                          <Send className="w-4 h-4" />
                        </Button>
                      </div>
                    ) : (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          handleSendMessage();
                        }}
                        className="flex gap-2 items-end"
                      >
                        {templates.length > 0 && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button 
                                type="button" 
                                variant="ghost" 
                                size="icon"
                                className="shrink-0 h-9 w-9"
                              >
                                <FileText className="w-4 h-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="w-64">
                              <DropdownMenuLabel>Templates Rápidos</DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              {templates.map((template) => (
                                <DropdownMenuItem 
                                  key={template.id}
                                  onClick={() => applyTemplate(template)}
                                >
                                  <span className="truncate">{template.name}</span>
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                        {canSendMaterials && selectedInstance?.unit && (
                          <SalesMaterialsMenu
                            unit={selectedInstance.unit}
                            lead={linkedLead}
                            onSendMedia={sendMaterialByUrl}
                            onSendTextMessage={sendTextMessageDirect}
                            disabled={isSending}
                          />
                        )}
                        <Popover open={showEmojiPicker} onOpenChange={setShowEmojiPicker}>
                          <PopoverTrigger asChild>
                            <Button 
                              type="button" 
                              variant="ghost" 
                              size="icon"
                              className="shrink-0 h-9 w-9"
                            >
                              <Smile className="w-4 h-4" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-72 p-2 max-h-64 overflow-y-auto" align="start">
                            <div className="space-y-2">
                              {Object.entries(emojiCategories).map(([category, emojis]) => (
                                <div key={category}>
                                  <p className="text-xs font-medium text-muted-foreground mb-1 px-1">{category}</p>
                                  <div className="grid grid-cols-8 gap-0.5">
                                    {emojis.map((emoji, idx) => (
                                      <button
                                        key={`${emoji}-${idx}`}
                                        type="button"
                                        onClick={() => insertEmoji(emoji)}
                                        className="text-lg p-1 hover:bg-muted rounded transition-colors"
                                      >
                                        {emoji}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </PopoverContent>
                        </Popover>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button 
                              type="button" 
                              variant="ghost" 
                              size="icon"
                              className="shrink-0 h-9 w-9"
                              disabled={!canSendMessages}
                            >
                              <Paperclip className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start">
                            <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
                              <ImageIcon className="w-4 h-4 mr-2" />
                              Imagem
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => videoInputRef.current?.click()}>
                              <Video className="w-4 h-4 mr-2" />
                              Vídeo
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => audioInputRef.current?.click()}>
                              <Mic className="w-4 h-4 mr-2" />
                              Arquivo de Áudio
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
                              <FileText className="w-4 h-4 mr-2" />
                              Arquivo
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => setShowContactDialog(true)}>
                              <Users className="w-4 h-4 mr-2" />
                              Contato
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <Textarea
                          ref={messageTextareaRef}
                          placeholder="Digite uma mensagem..."
                          value={newMessage}
                          onChange={(e) => setNewMessage(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              handleSendMessage();
                            }
                          }}
                          disabled={!canSendMessages || !canUseSelectedInstanceForSending}
                          className="text-base sm:text-sm flex-1 min-h-[40px] max-h-32 resize-y py-2.5 rounded-xl border-border/50 bg-muted/30 focus:bg-background"
                          rows={1}
                          spellCheck={true}
                        />
                        <Button 
                          type="submit" 
                          size="icon" 
                          disabled={!newMessage.trim() || isSending || !canSendMessages || !canUseSelectedInstanceForSending}
                          className="shrink-0"
                        >
                          <Send className="w-4 h-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="icon"
                          className="shrink-0"
                          onClick={canSendAudio && canUseSelectedInstanceForSending ? startRecording : undefined}
                          disabled={!canSendAudio || !canUseSelectedInstanceForSending || !!newMessage.trim()}
                        >
                          <Mic className="w-4 h-4" />
                        </Button>
                      </form>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-4 bg-gradient-to-br from-muted/30 via-background/50 to-primary/5">
                  <div className="bg-gradient-to-br from-primary/10 to-primary/5 rounded-2xl p-5 mb-5 shadow-subtle border border-primary/10">
                    <MessageSquare className="w-12 h-12 text-primary/40" />
                  </div>
                  <h3 className="font-display font-semibold text-lg mb-2 text-foreground/80">Selecione uma conversa</h3>
                  <p className="text-sm text-muted-foreground max-w-xs leading-relaxed">
                    Escolha uma conversa na lista ao lado para começar a enviar mensagens.
                  </p>
                </div>
              )}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
          )}

          {/* Mobile: Show chat when conversation is selected */}
          {isNarrowLayout && (
          <div className={cn(
            "w-full max-w-full min-w-0 flex flex-col overflow-hidden md:hidden",
            !selectedConversation && "hidden"
          )}>
            {selectedConversation && (
              <>
                <div className="border-b shrink-0">
                  {/* Row 1: Back + Avatar + Name + Info + Close + Toggle */}
                  <div className="p-3 pb-1 flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0"
                      onClick={() => {
                        clearLastActiveConversation();
                        setSelectedConversation(null);
                      }}
                    >
                      <ArrowLeft className="w-5 h-5" />
                    </Button>
                    <Avatar className="h-9 w-9 shrink-0">
                      <AvatarImage 
                        src={selectedConversation.contact_picture || undefined} 
                        alt={selectedConversation.contact_name || selectedConversation.contact_phone}
                        referrerPolicy="no-referrer"
                      />
                      <AvatarFallback className="bg-primary/10 text-primary text-sm">
                        {avatarInitial(selectedConversation.contact_name || selectedConversation.contact_phone)}
                      </AvatarFallback>
                    </Avatar>
                    {/* Tocar no nome abre os dados do contato (como no WhatsApp) */}
                    <div 
                      className="flex-1 min-w-0 cursor-pointer" 
                      onClick={() => setShowContactInfoSheet(true)}
                    >
                      <p className="font-medium text-sm leading-tight flex items-center gap-2 flex-wrap">
                        <span className="truncate">{selectedConversation.contact_name || selectedConversation.contact_phone}</span>
                        {selectedConversation.bot_paused_until && new Date(selectedConversation.bot_paused_until).getTime() > Date.now() && (
                          <button
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              await supabase
                                .from('wapi_conversations')
                                .update({ bot_paused_until: null, bot_paused_reason: null, bot_paused_at: null })
                                .eq('id', selectedConversation.id);
                              setSelectedConversation(prev => prev ? { ...prev, bot_paused_until: null, bot_paused_reason: null } : null);
                              setConversations(prev => prev.map(c => c.id === selectedConversation.id ? { ...c, bot_paused_until: null, bot_paused_reason: null } : c));
                              toast({ title: 'Automação retomada', description: 'O bot voltará a responder esta conversa.' });
                            }}
                            title={`Pausa: ${selectedConversation.bot_paused_reason || 'manual'} — clique para retomar`}
                            className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 hover:bg-amber-200 font-medium leading-none border border-amber-200"
                          >
                            ⏸ Bot pausado · retomar
                          </button>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                        <span className="truncate">{formatPhoneBR(selectedConversation.contact_phone)}</span>
                        {instances.length > 1 && instanceUnitMap[selectedConversation.instance_id] && instanceUnitMap[selectedConversation.instance_id] !== selectedInstance?.unit && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-muted font-medium leading-none">
                            {instanceUnitMap[selectedConversation.instance_id]}
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center shrink-0">
                      <LeadInfoPopover
                        linkedLead={linkedLead}
                        selectedConversation={selectedConversation}
                        selectedInstance={selectedInstance}
                        canTransferLeads={canTransferLeads}
                        canDeleteFromChat={canDeleteFromChat}
                        canEditLead={leadPerms.canEditLeads}
                        canViewContact={leadPerms.canViewContact}
                        isCreatingLead={isCreatingLead}
                        userId={userId}
                        currentUserName={currentUserName}
                        onShowTransferDialog={() => setShowTransferDialog(true)}
                        onShowDeleteDialog={() => setShowDeleteConfirmDialog(true)}
                        onShowShareToGroupDialog={() => canShareToGroup && linkedLead && setShowShareToGroupDialog(true)}
                        onCreateAndClassifyLead={(status) => createAndClassifyLead(status, true)}
                        onToggleConversationBot={toggleConversationBot}
                        onReactivateBot={reactivateBot}
                        onTakeOverFromBia={takeOverFromBia}
                        onReturnToBia={returnToBia}
                        onDismissAiReply={dismissAiReply}
                        onResumeWithAi={resumeWithAi}
                        onToggleFavorite={toggleFavorite}
                        onLeadNameChange={(newName) => {
                          setLinkedLead(prev => prev ? { ...prev, name: newName } : null);
                          setSelectedConversation(prev => prev ? { ...prev, contact_name: newName } : null);
                          setConversations(prevConvs => prevConvs.map(c => 
                            c.id === selectedConversation.id ? { ...c, contact_name: newName } : c
                          ));
                        }}
                        onLeadObsChange={(newObs) => {
                          setLinkedLead(prev => prev ? { ...prev, observacoes: newObs || null } : null);
                        }}
                        onShowVisitDialog={(type) => { if (linkedLead) { setQuickVisitType(type || "visita"); setShowQuickVisitDialog(true); } }}
                        visitRefreshKey={visitRefreshKey}
                        mobile
                      />
                      {leadEventId && financialPerms.canView && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9"
                          onClick={() => setShowFinancialSheet(true)}
                          title="Financeiro do evento"
                        >
                          <DollarSign className="w-4 h-4 text-emerald-500" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9"
                        onClick={() => toggleConversationClosed(selectedConversation)}
                        title={selectedConversation.is_closed ? "Reabrir conversa" : "Encerrar conversa"}
                      >
                        <X className={cn(
                          "w-4 h-4",
                          selectedConversation.is_closed 
                            ? "text-destructive" 
                            : "text-muted-foreground"
                        )} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 relative"
                        onClick={() => setShowAutomationTimeline(true)}
                        title="Automações enviadas"
                      >
                        <Bot className="w-4 h-4 text-muted-foreground" />
                        {messages.filter(m => isAutomationMessage(m.metadata as Record<string, string> | null)).length > 0 && (
                          <span className="absolute -top-0.5 -right-0.5 bg-primary text-primary-foreground text-[9px] font-bold rounded-full h-4 min-w-4 flex items-center justify-center px-0.5">
                            {messages.filter(m => isAutomationMessage(m.metadata as Record<string, string> | null)).length}
                          </span>
                        )}
                      </Button>
                      {/* Antes era uma 2ª linha só de ícones; agora fica tudo aqui, com nome */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-9 w-9" title="Mais opções">
                            <MoreVertical className="w-4 h-4 text-muted-foreground" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-64" onCloseAutoFocus={(e) => e.preventDefault()}>
                          <DropdownMenuItem onClick={() => setShowContactInfoSheet(true)}>
                            <Info className="w-4 h-4 mr-2" />
                            Dados do contato
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem disabled={!linkedLead} onClick={toggleOrcamentoEnviado}>
                            <FileCheck className={cn("w-4 h-4 mr-2", linkedLead?.status === 'orcamento_enviado' && "text-purple-600")} />
                            {!linkedLead ? "Orçamento enviado (vincule um lead)" : linkedLead.status === 'orcamento_enviado' ? "Desmarcar orçamento enviado" : "Marcar orçamento enviado"}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => toggleScheduledVisit(selectedConversation)}>
                            <CalendarCheck className={cn("w-4 h-4 mr-2", selectedConversation.has_scheduled_visit && "text-blue-600")} />
                            {selectedConversation.has_scheduled_visit ? "Desmarcar visita agendada" : "Marcar visita agendada"}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => toggleFreelancer(selectedConversation)}>
                            <Briefcase className={cn("w-4 h-4 mr-2", selectedConversation.is_freelancer && "text-orange-600")} />
                            {selectedConversation.is_freelancer ? "Desmarcar freelancer" : "Marcar como freelancer"}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => toggleEquipe(selectedConversation)}>
                            <Users className={cn("w-4 h-4 mr-2", selectedConversation.is_equipe && "text-cyan-600")} />
                            {selectedConversation.is_equipe ? "Desmarcar equipe" : "Marcar como equipe"}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => toggleFavorite(selectedConversation)}>
                            <Star className={cn("w-4 h-4 mr-2", selectedConversation.is_favorite && "text-secondary fill-secondary")} />
                            {selectedConversation.is_favorite ? "Tirar dos favoritos" : "Favoritar"}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={openMessageSearch}>
                            <Search className="w-4 h-4 mr-2" />
                            Buscar nas mensagens
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => { setIsSelectMode(prev => !prev); setSelectedMediaIds(new Set()); }}>
                            <CheckSquare className="w-4 h-4 mr-2" />
                            {isSelectMode ? "Parar de selecionar imagens" : "Selecionar imagens"}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </div>

                {/* Message Search Bar - Mobile */}
                {messageSearchActive && (
                  <div className="px-3 py-2 border-b bg-muted/30 flex items-center gap-2 shrink-0">
                    <Search className="w-4 h-4 text-muted-foreground shrink-0" />
                    <Input
                      ref={messageSearchInputRef}
                      placeholder="Buscar nas mensagens..."
                      value={messageSearchQuery}
                      onChange={(e) => setMessageSearchQuery(e.target.value)}
                      className="h-8 text-sm bg-background/80 border-border/60"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') navigateSearchResult(e.shiftKey ? 'prev' : 'next');
                        if (e.key === 'Escape') closeMessageSearch();
                      }}
                    />
                    {messageSearchResults.length > 0 && (
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {currentSearchIndex + 1}/{messageSearchResults.length}
                      </span>
                    )}
                    <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => navigateSearchResult('prev')} disabled={messageSearchResults.length === 0}>
                      <ChevronUp className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => navigateSearchResult('next')} disabled={messageSearchResults.length === 0}>
                      <ChevronDown className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={closeMessageSearch}>
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                )}

                {linkedLead && currentCompany && (
                  <ClientDataBar
                    companyId={currentCompany.id}
                    companyName={currentCompany.name}
                    customDomain={currentCompany.custom_domain}
                    lead={linkedLead}
                    sendText={sendTextMessageDirect}
                    compact
                  />
                )}
                {/* Mobile Lead Classification Panel - collapsible */}
                <div className="border-b bg-card/50 shrink-0">
                  <button
                    className="w-full flex items-center justify-between px-2 py-1.5 text-xs font-medium text-muted-foreground"
                    onClick={() => setMobileStatusExpanded(prev => !prev)}
                  >
                    <span className="flex items-center gap-1.5">
                      Status:
                      {linkedLead && (
                        <span className={cn(
                          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium",
                          linkedLead.status === 'novo' ? 'bg-blue-500/20 text-blue-700' :
                          linkedLead.status === 'trabalhe_conosco' ? 'bg-teal-500/20 text-teal-700' :
                          linkedLead.status === 'em_contato' ? 'bg-yellow-500/20 text-yellow-700' :
                          linkedLead.status === 'orcamento_enviado' ? 'bg-purple-500/20 text-purple-700' :
                          linkedLead.status === 'aguardando_resposta' ? 'bg-orange-500/20 text-orange-700' :
                          linkedLead.status === 'fechado' ? 'bg-green-500/20 text-green-700' :
                          linkedLead.status === 'perdido' ? 'bg-red-500/20 text-red-700' :
                          linkedLead.status === 'transferido' ? 'bg-cyan-500/20 text-cyan-700' :
                          linkedLead.status === 'fornecedor' ? 'bg-indigo-500/20 text-indigo-700' :
                          linkedLead.status === 'cliente_retorno' ? 'bg-pink-500/20 text-pink-700' :
                          'bg-muted text-muted-foreground'
                        )}>
                          {({
                            novo: 'Novo', trabalhe_conosco: 'Trab.', em_contato: 'Visita',
                            orcamento_enviado: 'Orçamento', aguardando_resposta: 'Negoc.',
                            fechado: 'Fechado', perdido: 'Perdido', transferido: 'Transf.', fornecedor: 'Fornec.', cliente_retorno: 'Retorno', outros: 'Outros'
                          } as Record<string, string>)[linkedLead.status] || linkedLead.status}
                        </span>
                      )}
                      {!linkedLead && <span className="text-[10px] text-destructive">⚠ Não qualificado</span>}
                    </span>
                    <span className="flex items-center gap-2">
                      {selectedConversation.has_scheduled_visit && <CalendarCheck className="w-3.5 h-3.5 text-blue-600" />}
                      {selectedConversation.is_freelancer && <Briefcase className="w-3.5 h-3.5 text-orange-600" />}
                      {selectedConversation.is_equipe && <Users className="w-3.5 h-3.5 text-cyan-600" />}
                      {selectedConversation.is_favorite && <Star className="w-3.5 h-3.5 text-secondary fill-secondary" />}
                      <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", mobileStatusExpanded && "rotate-180")} />
                    </span>
                  </button>
                  {mobileStatusExpanded && (
                    <div className="px-2 pb-2">
                      {linkedLead ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {[
                            { value: 'novo', label: 'Novo', color: 'bg-blue-500' },
                            { value: 'trabalhe_conosco', label: 'Trab.', color: 'bg-teal-500' },
                            { value: 'em_contato', label: 'Visita', color: 'bg-yellow-500' },
                            { value: 'orcamento_enviado', label: 'Orçamento', color: 'bg-purple-500' },
                            { value: 'aguardando_resposta', label: 'Negoc.', color: 'bg-orange-500' },
                            { value: 'fechado', label: 'Fechado', color: 'bg-green-500' },
                            { value: 'perdido', label: 'Perdido', color: 'bg-red-500' },
                            { value: 'transferido', label: 'Transf.', color: 'bg-cyan-500' },
                            { value: 'fornecedor', label: 'Fornec.', color: 'bg-indigo-500' },
                            { value: 'cliente_retorno', label: 'Retorno', color: 'bg-pink-500' },
                            { value: 'outros', label: 'Outros', color: 'bg-gray-500' },
                          ].map((statusOption) => (
                            <Button
                              key={statusOption.value}
                              variant={linkedLead.status === statusOption.value ? "default" : "outline"}
                              size="sm"
                              className={cn(
                                "h-6 text-[10px] gap-1 px-1.5",
                                linkedLead.status === statusOption.value && "ring-2 ring-offset-1"
                              )}
                              onClick={async () => {
                                const oldStatus = linkedLead.status;
                                const newStatus = statusOption.value as "novo" | "em_contato" | "orcamento_enviado" | "aguardando_resposta" | "fechado" | "perdido" | "trabalhe_conosco" | "transferido" | "fornecedor" | "cliente_retorno" | "outros";
                                
                                if (oldStatus === newStatus) return;
                                
                                const { error } = await supabase
                                  .from('campaign_leads')
                                  .update({ status: newStatus })
                                  .eq('id', linkedLead.id);
                                
                                if (error) {
                                  toast({
                                    title: "Erro ao atualizar",
                                    description: error.message,
                                    variant: "destructive",
                                  });
                                  return;
                                }
                                
                                const statusLabels: Record<string, string> = {
                                  novo: 'Novo',
                                  trabalhe_conosco: 'Trabalhe Conosco',
                                  em_contato: 'Visita',
                                  orcamento_enviado: 'Orçamento Enviado',
                                  aguardando_resposta: 'Negociando',
                                  fechado: 'Fechado',
                                  perdido: 'Perdido',
                                  transferido: 'Transferência',
                                  fornecedor: 'Fornecedor',
                                  cliente_retorno: 'Cliente Retorno',
                                  outros: 'Outros',
                                };
                                
                                await supabase.from('lead_history').insert({
                                  lead_id: linkedLead.id,
                                  company_id: getCurrentCompanyId(),
                                  action: 'status_change',
                                  old_value: statusLabels[oldStatus] || oldStatus,
                                  new_value: statusLabels[newStatus] || newStatus,
                                  user_id: userId,
                                });

                                const updatedLead = { ...linkedLead, status: statusOption.value };
                                setLinkedLead(prev => (prev && prev.id === updatedLead.id ? updatedLead : prev));
                                // Sync conversationLeadsMap so sidebar badge updates simultaneously
                                if (selectedConversation) {
                                  setConversationLeadsMap(prev => ({ ...prev, [selectedConversation.id]: updatedLead }));
                                }
                                setMobileStatusExpanded(false);

                                // Sync has_scheduled_visit with em_contato status
                                if (newStatus === 'em_contato' || oldStatus === 'em_contato') {
                                  const shouldHaveVisit = newStatus === 'em_contato';
                                  if (selectedConversation) {
                                    await supabase.from('wapi_conversations').update({ has_scheduled_visit: shouldHaveVisit }).eq('id', selectedConversation.id);
                                    setConversations(prev => prev.map(c => c.id === selectedConversation.id ? { ...c, has_scheduled_visit: shouldHaveVisit } : c));
                                    setSelectedConversation(prev => (prev && prev.id === selectedConversation.id ? { ...prev, has_scheduled_visit: shouldHaveVisit } : prev));
                                  }
                                }

                                if (newStatus === 'fechado') {
                                  console.log('[Lead:Fechado->NovaFesta:mobile]', {
                                    leadId: updatedLead.id,
                                    leadName: updatedLead.name,
                                    source: 'whatsapp-mobile-status',
                                  });
                                  void onLeadClosedMobile?.(updatedLead);
                                }

                                 if (newStatus === 'em_contato') {
                                   setQuickVisitType("visita");
                                   setShowQuickVisitDialog(true);
                                 }

                                const statusBorderColors: Record<string, string> = {
                                  'bg-blue-500': '#3b82f6', 'bg-teal-500': '#14b8a6', 'bg-yellow-500': '#eab308',
                                  'bg-purple-500': '#a855f7', 'bg-orange-500': '#f97316', 'bg-green-500': '#22c55e',
                                  'bg-red-500': '#ef4444', 'bg-cyan-500': '#06b6d4', 'bg-indigo-500': '#6366f1',
                                  'bg-pink-500': '#ec4899', 'bg-gray-500': '#6b7280',
                                };
                                toast({
                                  title: "Status atualizado",
                                  description: `Lead classificado como "${statusOption.label}"`,
                                  className: "border-l-4",
                                  style: { borderLeftColor: statusBorderColors[statusOption.color] || '#6b7280' },
                                });
                              }}
                            >
                              <div className={cn("w-1.5 h-1.5 rounded-full", statusOption.color)} />
                              {statusOption.label}
                            </Button>
                          ))}
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {[
                            { value: 'novo', label: 'Novo', color: 'bg-blue-500' },
                            { value: 'trabalhe_conosco', label: 'Trab.', color: 'bg-teal-500' },
                            { value: 'em_contato', label: 'Visita', color: 'bg-yellow-500' },
                            { value: 'orcamento_enviado', label: 'Orçam.', color: 'bg-purple-500' },
                            { value: 'aguardando_resposta', label: 'Negoc.', color: 'bg-orange-500' },
                            { value: 'fechado', label: 'Fechado', color: 'bg-green-500' },
                            { value: 'perdido', label: 'Perdido', color: 'bg-red-500' },
                            { value: 'transferido', label: 'Transf.', color: 'bg-cyan-500' },
                            { value: 'fornecedor', label: 'Fornec.', color: 'bg-indigo-500' },
                            { value: 'cliente_retorno', label: 'Retorno', color: 'bg-pink-500' },
                            { value: 'outros', label: 'Outros', color: 'bg-gray-500' },
                          ].map((statusOption) => (
                            <Button
                              key={statusOption.value}
                              variant="outline"
                              size="sm"
                              className="h-6 text-[10px] gap-1 px-1.5"
                              disabled={isCreatingLead}
                              onClick={() => createAndClassifyLead(statusOption.value, true)}
                            >
                              {isCreatingLead ? (
                                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                              ) : (
                                <div className={cn("w-1.5 h-1.5 rounded-full", statusOption.color)} />
                              )}
                              {statusOption.label}
                            </Button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Unresolved @lid banner - mobile */}
                {isUnresolvedLidIdentifier(selectedConversation?.remote_jid, selectedConversation?.contact_phone) && (
                  <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-900">
                    <Clock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600" />
                    <div className="flex-1">
                      <p className="font-medium">Aguardando número real deste contato.</p>
                      <p className="text-amber-800/80 mt-0.5">Chegou com ID anônimo (@lid). Será atualizado na próxima resposta — evite envio manual.</p>
                    </div>
                  </div>
                )}

                <div className="flex-1 relative min-h-0">
                  <ScrollArea ref={scrollAreaMobileRef} className="h-full whatsapp-chat-bg [&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!w-full [&_[data-radix-scroll-area-viewport]>div]:!min-w-0">
                    <div className="space-y-2 p-3 overflow-hidden">
                      {/* Loading indicator at top - mobile */}
                      {isLoadingMoreMessages && (
                        <div className="flex justify-center py-2">
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Carregando mensagens...
                          </div>
                        </div>
                      )}
                      
                      {/* Start of conversation indicator - mobile - only show when user has scrolled to top and there are no more messages */}
                      {!hasMoreMessages && messages.length > 0 && !isLoadingMessages && hasUserScrolledToTop && (
                        <div className="flex justify-center py-2">
                          <span className="text-xs text-muted-foreground bg-muted/50 px-3 py-1 rounded-full">
                            📬 Início da conversa
                          </span>
                        </div>
                      )}
                      
                      {isLoadingMessages ? (
                        <div className="flex flex-col items-center justify-center py-12 text-center">
                          <Loader2 className="w-8 h-8 text-muted-foreground mb-3 animate-spin" />
                          <p className="text-sm text-muted-foreground">
                            Carregando mensagens...
                          </p>
                        </div>
                      ) : messages.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-center">
                          <MessageSquare className="w-8 h-8 text-muted-foreground mb-2" />
                          <p className="text-sm text-muted-foreground">
                            Nenhuma mensagem ainda
                          </p>
                        </div>
                      ) : (
                      displayMessages.map((msg, idx) => {
                        const showDateSep = idx === 0 || getDateKey(msg.timestamp) !== getDateKey(displayMessages[idx - 1].timestamp);
                        return (
                        <div key={msg.id} id={`msg-${msg.id}`} className={cn(
                          messageSearchResults.includes(msg.id) && "ring-2 ring-primary/50 rounded-lg",
                          messageSearchResults[currentSearchIndex] === msg.id && "ring-2 ring-primary bg-primary/5 rounded-lg"
                        )}>
                        {showDateSep && (
                          <div className="flex justify-center my-3">
                            <span className="bg-muted text-muted-foreground text-xs px-3 py-1 rounded-md shadow-sm font-medium">
                              {formatDateSeparator(msg.timestamp)}
                            </span>
                          </div>
                        )}
                        {/* Follow-up/reactivation chip instead of full bubble */}
                        {isAutomationMessage(msg.metadata as Record<string, string> | null) ? (
                          <FollowUpChip
                            content={msg.content}
                            timestamp={msg.timestamp}
                            metadataType={(msg.metadata as Record<string, string> | null)?.type}
                            metadataSource={(msg.metadata as Record<string, string> | null)?.source}
                          />
                        ) : (
                        <div
                          className={cn(
                            "flex group w-full max-w-full min-w-0 overflow-hidden",
                            msg.from_me ? "justify-end" : "justify-start"
                          )}
                        >
                          <div className={cn("relative w-full max-w-full min-w-0", msg.from_me ? "flex flex-row-reverse items-start gap-1" : "flex items-start gap-1")}>
                            <div
                              {...(editingMessageId !== msg.id ? messagePressHandlers(msg.id) : {})}
                              style={messageTouchStyle}
                              className={cn(
                                // Segurar o dedo abre o menu, como no layout do tablet
                                "max-w-[85%] min-w-0 rounded-lg text-sm shadow-sm [@media(hover:none)]:select-none",
                                msg.from_me
                                  ? "bg-primary text-primary-foreground"
                                  : "bg-card border",
                                (msg.message_type === 'image' || msg.message_type === 'video' || msg.message_type === 'sticker')
                                  ? "p-0 overflow-hidden max-w-[82%] bg-transparent shadow-none border-0"
                                  : "px-3 py-2"
                              )}
                            >
{(msg.message_type === 'image' || msg.message_type === 'video' || msg.message_type === 'audio' || msg.message_type === 'document') && (
                              <div className={cn(
                                "relative max-w-full min-w-0 overflow-hidden",
                                (msg.message_type === 'image' || msg.message_type === 'video') ? "" : "mb-2"
                              )}>
                                {isSelectMode && msg.message_type === 'image' && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); toggleMediaSelection(msg.id); }}
                                    className="absolute top-2 left-2 z-10 w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all bg-background/80 backdrop-blur-sm hover:bg-background"
                                    style={{ borderColor: selectedMediaIds.has(msg.id) ? 'hsl(var(--primary))' : 'hsl(var(--border))' }}
                                  >
                                    {selectedMediaIds.has(msg.id) && <Check className="w-4 h-4 text-primary" />}
                                  </button>
                                )}
                                <MediaMessage
                                  messageId={msg.message_id}
                                  mediaType={msg.message_type as 'image' | 'video' | 'audio' | 'document'}
                                  mediaUrl={msg.media_url}
                                  content={msg.content}
                                  fromMe={msg.from_me}
                                  instanceId={selectedInstance?.instance_id}
                                  onMediaUrlUpdate={(url) => {
                                    setMessages(prev => prev.map(m => 
                                      m.id === msg.id ? { ...m, media_url: url } : m
                                    ));
                                  }}
                                />
                              </div>
                            )}
                            {msg.message_type === 'sticker' && (
                              msg.media_url && !msg.media_url.includes('.enc') ? (
                                <StickerImage src={msg.media_url} />
                              ) : (
                                <div className="text-2xl">🎭</div>
                              )
                            )}
                            {msg.message_type === 'contact' && (() => {
                              const raw = msg.content?.replace(/^\[Contato\]\s*/, '').replace(/^👤\s*/, '') || 'Contato';
                              const parts = raw.split(' - ');
                              const contactDisplayName = parts[0]?.trim() || 'Contato';
                              const contactPhoneNum = parts.slice(1).join(' - ')?.trim() || '';
                              return (
                                <div className={cn(
                                  "rounded-xl overflow-hidden min-w-[200px] max-w-[260px]",
                                  msg.from_me
                                    ? "border border-primary-foreground/15"
                                    : "border border-border shadow-sm"
                                )}>
                                  <div className={cn(
                                    "flex items-center gap-3 px-3 py-2.5",
                                    msg.from_me ? "bg-primary-foreground/10" : "bg-muted/50"
                                  )}>
                                    <div className={cn(
                                      "w-8 h-8 rounded-full flex items-center justify-center shrink-0",
                                      msg.from_me
                                        ? "bg-primary-foreground/20"
                                        : "bg-gradient-to-br from-primary/20 to-primary/5"
                                    )}>
                                      <Users className={cn("w-3.5 h-3.5", msg.from_me ? "text-primary-foreground" : "text-primary")} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <p className={cn("text-sm font-semibold truncate leading-tight", msg.from_me ? "text-primary-foreground" : "text-foreground")}>
                                        {contactDisplayName}
                                      </p>
                                      {contactPhoneNum && (
                                        <p className={cn("text-xs truncate mt-0.5", msg.from_me ? "text-primary-foreground/60" : "text-muted-foreground")}>
                                          {contactPhoneNum}
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                  {contactPhoneNum && (
                                    <div className={cn(
                                      "flex divide-x border-t",
                                      msg.from_me ? "border-primary-foreground/15 divide-primary-foreground/15" : "border-border divide-border"
                                    )}>
                                      <button
                                        className={cn(
                                          "flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors",
                                          msg.from_me
                                            ? "text-primary-foreground/80 hover:bg-primary-foreground/10"
                                            : "text-primary hover:bg-primary/5"
                                        )}
                                        onClick={() => { navigator.clipboard.writeText(contactPhoneNum); toast({ title: "Telefone copiado!", description: contactPhoneNum }); }}
                                      >
                                        <Copy className="w-3 h-3" />
                                        Copiar
                                      </button>
                                      <button
                                        className={cn(
                                          "flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors",
                                          msg.from_me
                                            ? "text-primary-foreground/80 hover:bg-primary-foreground/10"
                                            : "text-primary hover:bg-primary/5"
                                        )}
                                        onClick={() => {
                                          const cleanPhone = contactPhoneNum.replace(/\D/g, '');
                                          const match = conversations.find(c => {
                                            const cDigits = c.contact_phone.replace(/\D/g, '');
                                            return cDigits.includes(cleanPhone) || cleanPhone.includes(cDigits);
                                          });
                                          if (match) {
                                            setSelectedConversation(match);
                                            setSearchQuery('');
                                          } else {
                                            setSearchQuery(cleanPhone);
                                            clearLastActiveConversation();
                                            setSelectedConversation(null);
                                          }
                                        }}
                                      >
                                        <MessageSquare className="w-3 h-3" />
                                        Conversar
                                      </button>
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                            {/* Quoted message reference - mobile */}
                            {msg.quoted_message_id && (() => {
                              const quoted = messages.find(m => m.id === msg.quoted_message_id);
                              if (!quoted) return null;
                              return (
                                <div 
                                  className={cn(
                                    "px-3 py-1.5 mb-1 rounded border-l-2 cursor-pointer text-xs",
                                    msg.from_me ? "bg-primary/20 border-primary-foreground/40" : "bg-muted border-primary"
                                  )}
                                  onClick={() => {
                                    const el = document.getElementById(`msg-${quoted.id}`);
                                    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                  }}
                                >
                                  <p className={cn("font-medium", msg.from_me ? "text-primary-foreground/80" : "text-primary")}>
                                    {quoted.from_me ? 'Você' : (selectedConversation?.contact_name || 'Contato')}
                                  </p>
                                  <p className={cn("truncate", msg.from_me ? "text-primary-foreground/60" : "text-muted-foreground")}>
                                    {quoted.content || `[${quoted.message_type}]`}
                                  </p>
                                </div>
                              );
                            })()}
                            {/* Star indicator - mobile */}
                            {msg.is_starred && (
                              <Star className={cn("w-3 h-3 mb-0.5", msg.from_me ? "text-primary-foreground/60" : "text-yellow-500")} />
                            )}
                            {msg.message_type === 'text' && editingMessageId === msg.id ? (
                              <div className="space-y-2">
                                <Textarea
                                  value={editingContent}
                                  onChange={(e) => setEditingContent(e.target.value)}
                                  className="min-h-[40px] text-sm bg-background text-foreground"
                                  rows={2}
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.shiftKey) {
                                      e.preventDefault();
                                      handleSaveEdit(msg.id, msg.message_id);
                                    }
                                    if (e.key === 'Escape') {
                                      setEditingMessageId(null);
                                      setEditingContent("");
                                    }
                                  }}
                                />
                                <div className="flex gap-1 justify-end">
                                  <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => { setEditingMessageId(null); setEditingContent(""); }}>
                                    Cancelar
                                  </Button>
                                  <Button size="sm" className="h-6 text-xs" onClick={() => handleSaveEdit(msg.id, msg.message_id)} disabled={isSavingEdit}>
                                    {isSavingEdit ? <Loader2 className="w-3 h-3 animate-spin" /> : "Salvar"}
                                  </Button>
                                </div>
                              </div>
                            ) : msg.message_type === 'text' ? (
                              <>
                                <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{formatMessageContent(msg.content)}</p>
                                {extractFirstUrl(msg.content) && (
                                  <LinkPreviewCard url={extractFirstUrl(msg.content)!} fromMe={msg.from_me} />
                                )}
                              </>
                            ) : null}
                            {msg.message_type !== 'text' && msg.message_type !== 'contact' && msg.content && msg.content !== '[Imagem]' && msg.content !== '[Áudio]' && (
                              // Foto/vídeo ficam sem o balão colorido: a legenda vai num cartão claro (igual ao computador)
                              <p className={cn("whitespace-pre-wrap break-words [overflow-wrap:anywhere] mt-1", (msg.message_type === 'image' || msg.message_type === 'video') && "px-3 py-2 rounded-b-2xl bg-card text-foreground border border-t-0 border-border/50")}>{formatMessageContent(msg.content)}</p>
                            )}
                            <div className={cn(
                              "flex items-center gap-1 mt-1",
                              msg.from_me ? "justify-end" : "justify-start",
                              (msg.message_type === 'image' || msg.message_type === 'video') && "px-2 pb-1"
                            )}>
                              {(() => {
                                const tag = senderTag(msg);
                                if (tag) return <span className="text-[10px] font-medium px-1.5 rounded-full bg-black/10 whitespace-nowrap">{tag}</span>;
                                const dot = senderDot(msg);
                                return dot && <span className={cn("w-2 h-2 rounded-full inline-block shrink-0", dot.className)} title={dot.title} />;
                              })()}
                              <span className={cn(
                                "text-[10px]",
                                (msg.message_type === 'image' || msg.message_type === 'video')
                                  ? "text-muted-foreground"
                                  : (msg.from_me ? "text-primary-foreground/70" : "text-muted-foreground")
                              )}>
                                {formatMessageTime(msg.timestamp)}
                              </span>
                              {msg.from_me && getStatusIcon(msg.status, msg)}
                            </div>
                            </div>
                            {/* Context menu for all messages - mobile */}
                            {editingMessageId !== msg.id && (
                              <DropdownMenu open={messageMenuId === msg.id} onOpenChange={(open) => setMessageMenuId(open ? msg.id : null)}>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    // Celular: segurar o dedo na mensagem abre o menu; a setinha fica invisível
                                    // mas no lugar (o menu abre ao lado dela)
                                    className="h-6 w-6 opacity-0 group-hover:opacity-100 active:opacity-100 transition-opacity shrink-0"
                                  >
                                    <ChevronDown className="w-3 h-3" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align={msg.from_me ? "end" : "start"}>
                                  {/* Emoji reaction row */}
                                  {msg.message_id && (
                                    <>
                                      <div className="flex items-center gap-1 px-2 py-1.5">
                                        {REACTION_EMOJIS.map(emoji => (
                                          <button
                                            key={emoji}
                                            className="text-lg hover:scale-125 transition-transform p-0.5 rounded hover:bg-accent"
                                            onClick={() => handleReaction(msg, emoji)}
                                          >
                                            {emoji}
                                          </button>
                                        ))}
                                      </div>
                                      <DropdownMenuSeparator />
                                    </>
                                  )}
                                  <DropdownMenuItem onClick={() => {
                                    setReplyingTo(msg);
                                    messageTextareaRef.current?.focus();
                                  }}>
                                    <Reply className="w-4 h-4 mr-2" />
                                    Responder
                                  </DropdownMenuItem>
                                  {msg.content && (
                                    <DropdownMenuItem onClick={() => {
                                      navigator.clipboard.writeText(msg.content!);
                                      toast({ title: "Copiado!" });
                                    }}>
                                      <Copy className="w-4 h-4 mr-2" />
                                      Copiar
                                    </DropdownMenuItem>
                                  )}
                                  {isMessageEditable(msg) && (
                                    <DropdownMenuItem onClick={() => {
                                      setEditingMessageId(msg.id);
                                      setEditingContent(msg.content || "");
                                    }}>
                                      <Pencil className="w-4 h-4 mr-2" />
                                      Editar
                                    </DropdownMenuItem>
                                  )}
                                  {msg.media_url && (
                                    <DropdownMenuItem onClick={() => window.open(msg.media_url!, '_blank')}>
                                      <Download className="w-4 h-4 mr-2" />
                                      Baixar
                                    </DropdownMenuItem>
                                  )}
                                  <DropdownMenuItem onClick={() => handlePinMessage(msg)}>
                                    {selectedConversation?.pinned_message_id === msg.id ? (
                                      <><PinOff className="w-4 h-4 mr-2" />Desafixar</>
                                    ) : (
                                      <><Pin className="w-4 h-4 mr-2" />Fixar</>
                                    )}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => handleStarMessage(msg)}>
                                    {msg.is_starred ? (
                                      <><StarOff className="w-4 h-4 mr-2" />Desfavoritar</>
                                    ) : (
                                      <><Star className="w-4 h-4 mr-2" />Favoritar</>
                                    )}
                                  </DropdownMenuItem>
                                  {msg.from_me && (
                                    <>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleteMessageId(msg.id)}>
                                        <Trash2 className="w-4 h-4 mr-2" />
                                        Apagar
                                      </DropdownMenuItem>
                                    </>
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
                          </div>
                          {isAutomationMessage(msg.metadata as Record<string, string> | null) && (
                            <div className={cn(
                              "flex items-center gap-1 mt-0.5 text-[10px] text-muted-foreground/70",
                              msg.from_me ? "justify-end mr-1" : "justify-start ml-1"
                            )}>
                              <Clock className="w-2.5 h-2.5" />
                              <span>
                                {msg.metadata.type === 'next_step_reminder' ? 'Lembrete automático' :
                                 msg.metadata.type === 'follow_up_1' ? 'Follow-up automático' :
                                 msg.metadata.type === 'follow_up_2' ? '2º follow-up automático' :
                                 msg.metadata.type === 'bot_inactive' ? 'Reenvio por inatividade' :
                                 'Enviado automaticamente'}
                              </span>
                            </div>
                          )}
                        </div>
                        )}
                        <MessageReactions reactions={reactionsByMessage.get(msg.id)} fromMe={msg.from_me} contactName={selectedConversation?.contact_name} />
                        </div>
                        );
                      })
                      )}
                      <div ref={bottomRefMobile} style={{ height: 1 }} />
                    </div>
                  </ScrollArea>
                  {/* Scroll to bottom button - only show when not at bottom */}
                  {!isAtBottom && (
                    <Button
                      variant="secondary"
                      size="icon"
                      className="absolute bottom-4 right-4 h-10 w-10 rounded-full shadow-lg opacity-90 hover:opacity-100 z-10"
                      onClick={() => scrollToBottomMobile()}
                      title="Ir para última mensagem"
                    >
                      <ArrowDown className="w-5 h-5" />
                      {unreadNewMessagesCount > 0 && (
                        <span className="absolute -top-1 -right-1 bg-primary text-primary-foreground text-xs font-bold rounded-full h-5 min-w-5 flex items-center justify-center px-1">
                          {unreadNewMessagesCount > 99 ? '99+' : unreadNewMessagesCount}
                        </span>
                      )}
                    </Button>
                  )}
                </div>

                {/* Batch download floating bar - Mobile */}
                {isSelectMode && (
                  <div className="px-3 py-2 border-t bg-primary/5 flex items-center justify-between gap-2 shrink-0">
                    <span className="text-xs font-medium text-foreground">
                      {selectedMediaIds.size} selecionada(s)
                    </span>
                    <div className="flex items-center gap-1.5">
                      <Button variant="ghost" size="sm" className="h-7 text-xs px-2" onClick={selectAllImages}>
                        Todas
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs px-2"
                        onClick={() => { setIsSelectMode(false); setSelectedMediaIds(new Set()); }}
                      >
                        Cancelar
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs px-2"
                        disabled={selectedMediaIds.size === 0 || isBatchDownloading}
                        onClick={handleBatchDownloadIndividual}
                      >
                        {isBatchDownloading ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <><Download className="w-3 h-3 mr-0.5" /> Salvar</>
                        )}
                      </Button>
                      <Button
                        size="sm"
                        className="h-7 text-xs px-2"
                        disabled={selectedMediaIds.size === 0 || isBatchDownloading}
                        onClick={handleBatchDownload}
                      >
                        {isBatchDownloading ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <><Download className="w-3 h-3 mr-0.5" /> ZIP</>
                        )}
                      </Button>
                    </div>
                  </div>
                )}

                <div className="p-3 border-t shrink-0">
                  {/* Reply preview bar - mobile */}
                  {replyingTo && (
                    <div className="flex items-center gap-2 mb-2 p-2 bg-muted rounded-lg border-l-4 border-primary">
                      <Reply className="w-4 h-4 text-primary shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-primary">{replyingTo.from_me ? 'Você' : (selectedConversation?.contact_name || 'Contato')}</p>
                        <p className="text-xs text-muted-foreground truncate">{replyingTo.content || `[${replyingTo.message_type}]`}</p>
                      </div>
                      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setReplyingTo(null)}>
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  )}
                  {isRecording ? (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 flex items-center gap-3 bg-muted rounded-lg px-4 py-2">
                        <div className="w-3 h-3 rounded-full bg-destructive animate-pulse" />
                        <span className="font-mono text-lg">
                          {formatRecordingTime(recordingTime)}
                        </span>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="shrink-0"
                        onClick={cancelRecording}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        className="shrink-0"
                        onClick={handleStopAndSend}
                      >
                        <Send className="w-4 h-4" />
                      </Button>
                    </div>
                  ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleSendMessage();
                    }}
                    className="flex w-full min-w-0 gap-1.5 items-end overflow-hidden"
                  >
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" size="icon" className="shrink-0 h-9 w-9" disabled={!canSendMessages}>
                          <Paperclip className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
                          <ImageIcon className="w-4 h-4 mr-2" />
                          Imagem
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => videoInputRef.current?.click()}>
                          <Video className="w-4 h-4 mr-2" />
                          Vídeo
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
                          <FileText className="w-4 h-4 mr-2" />
                          Arquivo
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => setShowContactDialog(true)}>
                          <Users className="w-4 h-4 mr-2" />
                          Contato
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {/* Digitando: some o que não é usado agora e o texto ganha espaço (como no WhatsApp) */}
                    {templates.length > 0 && !newMessage.trim() && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button 
                            type="button" 
                            variant="ghost" 
                            size="icon"
                            className="shrink-0 h-9 w-9"
                          >
                            <MessageSquare className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-64">
                          <DropdownMenuLabel>Templates Rápidos</DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          {templates.map((template) => (
                            <DropdownMenuItem 
                              key={template.id}
                              onClick={() => applyTemplate(template)}
                            >
                              <span className="truncate">{template.name}</span>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                    {canSendMaterials && selectedInstance?.unit && !newMessage.trim() && (
                      <SalesMaterialsMenu
                        unit={selectedInstance.unit}
                        lead={linkedLead}
                        onSendMedia={sendMaterialByUrl}
                        onSendTextMessage={sendTextMessageDirect}
                        disabled={isSending}
                      />
                    )}
                    <Textarea
                      placeholder="Mensagem"
                      value={newMessage}
                      ref={messageTextareaRef}
                      onChange={(e) => setNewMessage(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSendMessage();
                        }
                      }}
                      disabled={!canSendMessages || !canUseSelectedInstanceForSending}
                      className="text-base flex-1 min-w-0 min-h-[40px] max-h-[50vh] resize-y py-2"
                      rows={1}
                      spellCheck={true}
                    />
                    {/* Com texto: enviar; sem texto: gravar áudio */}
                    {newMessage.trim() ? (
                      <Button type="submit" size="icon" disabled={isSending || !canSendMessages || !canUseSelectedInstanceForSending} className="shrink-0">
                        <Send className="w-4 h-4" />
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="secondary"
                        size="icon"
                        className="shrink-0"
                        onClick={canSendAudio && canUseSelectedInstanceForSending ? startRecording : undefined}
                        disabled={!canSendAudio || !canUseSelectedInstanceForSending}
                      >
                        <Mic className="w-4 h-4" />
                      </Button>
                    )}
                  </form>
                  )}
                </div>
              </>
            )}
          </div>
          )}
        </div>
      )}

      {/* Quick Visit Dialog — fora dos blocos de layout (portal): precisa
          existir tanto no layout mobile quanto no desktop */}
      {linkedLead && quickVisitType === "visita" && (
        <QuickVisitDialog
          open={showQuickVisitDialog}
          onOpenChange={(v) => { setShowQuickVisitDialog(v); if (!v) setQuickVisitType("visita"); }}
          leadId={linkedLead.id}
          currentUserId={userId}
          leadUnit={linkedLead.unit}
          onVisitRegistered={(moved) => {
            setVisitRefreshKey(k => k + 1);
            if (moved) setLinkedLead(prev => prev ? { ...prev, status: 'em_contato' } as Lead : prev);
          }}
          initialVisitType="visita"
        />
      )}
      {linkedLead && quickVisitType === "atendimento" && (
        <VisitFormDialog
          open={showQuickVisitDialog}
          onOpenChange={(v) => { setShowQuickVisitDialog(v); if (!v) setQuickVisitType("visita"); }}
          visitType="atendimento"
          currentUserId={userId}
          fixedLead={{ id: linkedLead.id, name: linkedLead.name, unit: linkedLead.unit }}
          onCreated={() => setVisitRefreshKey(k => k + 1)}
        />
      )}

      {/* Hidden file inputs */}
      <input
        type="file"
        ref={imageInputRef}
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFileSelect(e, 'image')}
      />
      <input
        type="file"
        ref={audioInputRef}
        accept="audio/*"
        className="hidden"
        onChange={(e) => handleFileSelect(e, 'audio')}
      />
      <input
        type="file"
        ref={fileInputRef}
        accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv"
        className="hidden"
        onChange={(e) => handleFileSelect(e, 'document')}
      />
      <input
        type="file"
        ref={videoInputRef}
        accept="video/mp4,video/3gpp,video/quicktime,video/*"
        className="hidden"
        onChange={(e) => handleFileSelect(e, 'video')}
      />

      {/* Media Preview Dialog */}
      <Dialog open={!!mediaPreview} onOpenChange={(open) => !open && cancelMediaUpload()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {mediaPreview?.type === 'image' && 'Enviar imagem'}
              {mediaPreview?.type === 'audio' && 'Enviar áudio'}
              {mediaPreview?.type === 'document' && 'Enviar arquivo'}
              {mediaPreview?.type === 'video' && 'Enviar vídeo'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Preview */}
            {mediaPreview?.type === 'image' && mediaPreview.preview && (
              <div className="flex justify-center">
                <img 
                  src={mediaPreview.preview} 
                  alt="Preview" 
                  className="max-h-64 rounded-lg object-contain"
                />
              </div>
            )}
            {mediaPreview?.type === 'audio' && (
              <div className="flex items-center gap-3 p-4 bg-muted rounded-lg">
                <Mic className="w-8 h-8 text-primary" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{mediaPreview.file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {(mediaPreview.file.size / 1024).toFixed(1)} KB
                  </p>
                </div>
              </div>
            )}
            {mediaPreview?.type === 'document' && (
              <div className="flex items-center gap-3 p-4 bg-muted rounded-lg">
                <Paperclip className="w-8 h-8 text-primary" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{mediaPreview.file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {(mediaPreview.file.size / 1024).toFixed(1)} KB
                  </p>
                </div>
              </div>
            )}
            {mediaPreview?.type === 'video' && mediaPreview.preview && (
              <div className="flex justify-center">
                <video 
                  src={mediaPreview.preview} 
                  className="max-h-64 rounded-lg object-contain"
                  controls
                />
              </div>
            )}

            {/* Caption for images and videos */}
            {(mediaPreview?.type === 'image' || mediaPreview?.type === 'video') && (
              <Input
                placeholder="Adicionar legenda (opcional)..."
                value={mediaCaption}
                onChange={(e) => setMediaCaption(e.target.value)}
              />
            )}

            {/* Actions */}
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={cancelMediaUpload} disabled={isUploading}>
                Cancelar
              </Button>
              <Button onClick={sendMedia} disabled={isUploading}>
                {isUploading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Enviando...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4 mr-2" />
                    Enviar
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Transfer Lead Dialog */}
      <AlertDialog open={showTransferDialog} onOpenChange={(open) => {
        setShowTransferDialog(open);
        if (!open) {
          setSelectedTransferUserId("");
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="w-5 h-5" />
              Transferir Lead
            </AlertDialogTitle>
            <AlertDialogDescription>
              Selecione o usuário que receberá o lead "{linkedLead?.name}". O usuário será notificado sobre a transferência.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="py-4 space-y-3">
            <Label>Transferir para:</Label>
            <Select value={selectedTransferUserId} onValueChange={setSelectedTransferUserId}>
              <SelectTrigger>
                <SelectValue placeholder="Selecione um usuário..." />
              </SelectTrigger>
              <SelectContent>
                {responsaveis
                  .filter(r => r.user_id !== userId && r.user_id !== linkedLead?.responsavel_id)
                  .length === 0 ? (
                  <SelectItem value="none" disabled>
                    Nenhum usuário disponível
                  </SelectItem>
                ) : (
                  responsaveis
                    .filter(r => r.user_id !== userId && r.user_id !== linkedLead?.responsavel_id)
                    .map((user) => (
                      <SelectItem key={user.user_id} value={user.user_id}>
                        {user.full_name}
                      </SelectItem>
                    ))
                )}
              </SelectContent>
            </Select>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isTransferring}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleTransferLead}
              disabled={!selectedTransferUserId || isTransferring}
            >
              {isTransferring ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Transferindo...
                </>
              ) : (
                "Transferir"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteConfirmDialog} onOpenChange={setShowDeleteConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive">
              {linkedLead ? "Excluir Lead e Conversa" : "Excluir Conversa"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {linkedLead ? (
                <>
                  Esta ação é <strong>permanente e irreversível</strong>. Serão excluídos:
                  <ul className="list-disc list-inside mt-2 space-y-1">
                    <li>O lead <strong>{linkedLead.name}</strong></li>
                    <li>Todo o histórico de alterações do lead</li>
                    <li>Todas as mensagens da conversa</li>
                    <li>A conversa do WhatsApp</li>
                  </ul>
                </>
              ) : (
                <>
                  Esta ação é <strong>permanente e irreversível</strong>. Serão excluídos:
                  <ul className="list-disc list-inside mt-2 space-y-1">
                    <li>Todas as mensagens da conversa</li>
                    <li>A conversa do WhatsApp</li>
                  </ul>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteLeadFromChat}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Excluindo...
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4 mr-2" />
                  Excluir Permanentemente
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Share to Group Dialog */}
      {linkedLead && (
        <ShareToGroupDialog
          open={showShareToGroupDialog}
          onOpenChange={setShowShareToGroupDialog}
          lead={linkedLead}
          groups={conversations.filter(c => c.remote_jid?.endsWith('@g.us')).map(c => ({
            id: c.id,
            remote_jid: c.remote_jid,
            contact_name: c.contact_name,
            instance_id: c.instance_id,
          }))}
          instances={instances}
        />
      )}

      {/* Send Contact Dialog */}
      <Dialog open={showContactDialog} onOpenChange={(open) => {
        setShowContactDialog(open);
        if (!open) { setContactName(""); setContactPhone(""); }
      }}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              Enviar Contato
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="contact-name">Nome</Label>
              <Input
                id="contact-name"
                placeholder="Nome do contato"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contact-phone">Telefone</Label>
              <Input
                id="contact-phone"
                placeholder="5511999999999"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
              />
            </div>
            <Button 
              className="w-full" 
              onClick={handleSendContact}
              disabled={!contactName.trim() || !contactPhone.trim() || isSendingContact}
            >
              {isSendingContact ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Enviando...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 mr-2" />
                  Enviar Contato
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete message confirmation */}
      <AlertDialog open={!!deleteMessageId} onOpenChange={(open) => !open && setDeleteMessageId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar mensagem</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja apagar esta mensagem? Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteMessageId && handleDeleteMessage(deleteMessageId)}
            >
              Apagar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm restart qualification flow */}
      <AlertDialog open={!!startQualConfirm} onOpenChange={(o) => !o && setStartQualConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reiniciar qualificação?</AlertDialogTitle>
            <AlertDialogDescription>
              Este lead já está em um fluxo ativo (passo: <strong>{startQualConfirm?.step}</strong>).
              Reiniciar vai zerar o progresso e enviar a primeira pergunta novamente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={startQualLoading}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={startQualLoading}
              onClick={(e) => { e.preventDefault(); handleStartQualification(true); }}
            >
              {startQualLoading ? 'Enviando...' : 'Reiniciar mesmo assim'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create New Contact Dialog */}
      <Dialog open={showCreateContactDialog} onOpenChange={(open) => {
        setShowCreateContactDialog(open);
        if (!open) { setNewContactName(""); setNewContactPhone(""); }
      }}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              Novo Contato
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="new-contact-name">Nome *</Label>
              <Input
                id="new-contact-name"
                placeholder="Nome do contato"
                value={newContactName}
                onChange={(e) => setNewContactName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-contact-phone">Telefone (WhatsApp) *</Label>
              <Input
                id="new-contact-phone"
                placeholder="11999999999"
                value={newContactPhone}
                onChange={(e) => setNewContactPhone(e.target.value.replace(/[^\d]/g, ''))}
                inputMode="tel"
              />
              <p className="text-xs text-muted-foreground">Apenas números. O código 55 será adicionado automaticamente.</p>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowCreateContactDialog(false)} disabled={isCreatingContact}>
                Cancelar
              </Button>
              <Button
                onClick={handleCreateContact}
                disabled={newContactName.trim().length < 2 || newContactPhone.replace(/\D/g, '').length < 10 || isCreatingContact}
              >
                {isCreatingContact ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Criando...
                  </>
                ) : (
                  <>
                    <Users className="w-4 h-4 mr-2" />
                    Criar Contato
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {/* Contact Info Sheet */}
      {selectedConversation && (
        <ContactInfoSheet
          isOpen={showContactInfoSheet}
          onClose={() => setShowContactInfoSheet(false)}
          contactName={selectedConversation.contact_name}
          contactPhone={selectedConversation.contact_phone}
          contactPicture={selectedConversation.contact_picture}
          conversationId={selectedConversation.id}
          linkedLead={linkedLead}
          onOpenLeadDetail={linkedLead ? () => setShowLeadDetailSheet(true) : undefined}
          instanceId={selectedInstance?.instance_id}
        />
      )}
      {/* Lead Detail Sheet */}
      <LeadDetailSheet
        lead={linkedLead as any}
        isOpen={showLeadDetailSheet}
        onClose={() => setShowLeadDetailSheet(false)}
        onUpdate={() => {
          if (linkedLead) {
            fetchLinkedLead(linkedLead.id, selectedConversation);
          }
        }}
        responsaveis={responsaveis as any}
        currentUserId={userId}
        currentUserName={currentUserName}
        canEdit={leadPerms.canEditLeads}
        canViewContact={leadPerms.canViewContact}
      />
      {/* Financial Sheet */}
      {leadEventId && currentCompany && (
        <Sheet open={showFinancialSheet} onOpenChange={setShowFinancialSheet}>
          <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto p-0">
            <SheetHeader className="px-4 pt-4 pb-2 sticky top-0 bg-background z-10 border-b flex flex-row items-center justify-between">
              <SheetTitle className="text-base font-bold">
                {linkedLead?.name || selectedConversation?.contact_name || 'Financeiro'}
              </SheetTitle>
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setShowFinancialSheet(false)}>
                <X className="h-4 w-4" />
              </Button>
            </SheetHeader>
            <div className="p-4">
              <EventFinancialTab
                eventId={leadEventId}
                companyId={currentCompany.id}
                baseValue={leadEventValue}
                canEdit={financialPerms.canEdit && !financialPerms.isLoading}
                canPay={financialPerms.canPay}
                showValues={financialPerms.canViewValues}
                onConsentSubmit={financialPerms.requiresConsent ? consentHookChat.submitForConsent : undefined}
              />
            </div>
          </SheetContent>
        </Sheet>
      )}
      {/* Automation Timeline Sheet */}
      {selectedConversation && (
        <AutomationTimelineSheet
          isOpen={showAutomationTimeline}
          onClose={() => setShowAutomationTimeline(false)}
          messages={messages as any}
          contactName={selectedConversation.contact_name}
        />
      )}

      {/* Quick Connect Dialog */}
      <ConnectionDialog
        open={connection.qrDialogOpen}
        onOpenChange={() => {}}
        instance={connection.qrInstance}
        qrCode={connection.qrCode}
        qrLoading={connection.qrLoading}
        connectionMode={connection.connectionMode}
        phoneNumber={connection.phoneNumber}
        pairingCode={connection.pairingCode}
        isPairingLoading={connection.isPairingLoading}
        retryCount={connection.retryCount}
        isRetrying={connection.isRetrying}
        isWapiUnstable={connection.isWapiUnstable}
        connectionStage={connection.connectionStage}
        onClose={connection.closeDialog}
        onSetConnectionMode={connection.setConnectionMode}
        onSetPhoneNumber={connection.setPhoneNumber}
        onRequestPairingCode={() => connection.requestPairingCode()}
        onRetryQr={() => connection.qrInstance && connection.fetchQrCode(connection.qrInstance)}
      />
    </div>
  );
}
