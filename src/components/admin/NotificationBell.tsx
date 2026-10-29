import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bell, Check, Trash2, UserPlus, ArrowRightLeft, Crown, CalendarCheck,
  ExternalLink, MessageCircle, Search, Send, UserX, Clock, AlertTriangle, Headset,
  WifiOff, Hand, Sparkles, BellOff, PartyPopper, FileSignature,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useAppNotifications, AppNotification } from "@/hooks/useAppNotifications";
import { cn } from "@/lib/utils";

/* ── tab definitions ─────────────────────────────────── */

const TAB_GROUPS = [
  { key: "todos", label: "Todos", types: null },
  { key: "visitas", label: "Visitas", types: ["visit_scheduled"] },
  { key: "clientes", label: "Clientes", types: ["existing_client", "party_soon", "client_data", "vamu_order"] },
  { key: "transferencias", label: "Transf.", types: ["lead_transfer", "lead_assigned"] },
  { key: "outros", label: "Outros", types: ["lead_questions", "lead_analyzing", "follow_up_sent", "lead_lost", "stale_reminded", "lead_risk", "message_stuck", "lead_needs_human", "new_candidate", "delivery_stall", "contact_stop_request"] },
] as const;

/* ── icon map ────────────────────────────────────────── */

const ICON_MAP: Record<string, { icon: React.ElementType; className: string }> = {
  lead_transfer:   { icon: ArrowRightLeft, className: "text-primary" },
  lead_assigned:   { icon: UserPlus,       className: "text-green-500" },
  existing_client: { icon: Crown,          className: "text-amber-500" },
  visit_scheduled: { icon: CalendarCheck,  className: "text-blue-500" },
  lead_questions:  { icon: MessageCircle,  className: "text-orange-500" },
  lead_analyzing:  { icon: Search,         className: "text-purple-500" },
  follow_up_sent:  { icon: Send,           className: "text-teal-500" },
  lead_lost:       { icon: UserX,          className: "text-red-500" },
  stale_reminded:  { icon: Clock,          className: "text-gray-500" },
  lead_risk:       { icon: AlertTriangle,  className: "text-red-500" },
  message_stuck:   { icon: WifiOff,        className: "text-amber-500" },
  delivery_stall:  { icon: WifiOff,        className: "text-red-500" },
  lead_needs_human: { icon: Hand,          className: "text-red-500" },
  new_support_ticket: { icon: Headset,    className: "text-purple-500" },
  new_candidate:   { icon: UserPlus,       className: "text-violet-500" },
  contact_stop_request: { icon: BellOff,   className: "text-red-500" },
  party_soon:      { icon: PartyPopper,    className: "text-pink-500" },
  client_data:     { icon: FileSignature,  className: "text-blue-500" },
};

// Avisos da Bia (IA): passagem para a equipe e cliente sem resposta — na cor dela
const isBiaNotification = (n: AppNotification) =>
  !!n.data && typeof n.data === "object" && (
    (n.type === "lead_needs_human" && ["ai_handoff", "ai_handoff_unanswered"].includes(String((n.data as Record<string, unknown>).reason || ""))) ||
    // Visita marcada pela IA
    (n.type === "visit_scheduled" && (n.data as Record<string, unknown>).reason === "ai_visit")
  );

function NotificationIcon({ type, bia = false }: { type: string; bia?: boolean }) {
  if (bia) return <Sparkles className="w-4 h-4 text-violet-600 dark:text-violet-300" />;
  const mapping = ICON_MAP[type];
  if (!mapping) return <Bell className="w-4 h-4 text-muted-foreground" />;
  const Icon = mapping.icon;
  return <Icon className={cn("w-4 h-4", mapping.className)} />;
}

/* ── notification item ───────────────────────────────── */

function NotificationItem({
  notification,
  onRead: _onRead,
  onDelete,
  onClick,
}: {
  notification: AppNotification;
  onRead: (id: string) => void;
  onDelete: (id: string) => void;
  onClick: (n: AppNotification) => void;
}) {
  const isClientAlert = notification.type === "existing_client";
  const isVisitAlert = notification.type === "visit_scheduled";
  const isBia = isBiaNotification(notification);
  const isPriority = isClientAlert || isVisitAlert;

  return (
    <div
      className={cn(
        "p-3 sm:p-4 cursor-pointer transition-all duration-200 group relative overflow-hidden",
        isBia && !notification.read
          ? "bg-gradient-to-r from-violet-500/10 via-fuchsia-500/5 to-transparent border-l-4 border-l-violet-500 hover:from-violet-500/15"
          : isVisitAlert && !notification.read
          ? "bg-gradient-to-r from-blue-500/10 via-blue-500/5 to-transparent border-l-4 border-l-blue-500 hover:from-blue-500/15"
          : isClientAlert && !notification.read
            ? "bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent border-l-4 border-l-amber-500 hover:from-amber-500/15"
            : !notification.read
              ? "bg-primary/5 border-l-4 border-l-primary/50 hover:bg-primary/10"
              : "hover:bg-muted/50 border-l-4 border-l-transparent"
      )}
      onClick={() => onClick(notification)}
    >
      {isPriority && !notification.read && (
        <div className={cn(
          "absolute inset-0 opacity-20 pointer-events-none",
          isVisitAlert ? "bg-gradient-to-r from-blue-400/20 to-transparent" : "bg-gradient-to-r from-amber-400/20 to-transparent"
        )} />
      )}

      <div className="flex items-start gap-3 relative z-10">
        <div className={cn(
          "flex-shrink-0 p-2 rounded-xl shadow-sm transition-transform group-hover:scale-105",
          isBia
            ? "bg-gradient-to-br from-violet-100 to-fuchsia-50 dark:from-violet-900/60 dark:to-fuchsia-900/40 ring-1 ring-violet-200/50 dark:ring-violet-700/50"
            : isVisitAlert
            ? "bg-gradient-to-br from-blue-100 to-blue-50 dark:from-blue-900/60 dark:to-blue-800/40 ring-1 ring-blue-200/50 dark:ring-blue-700/50"
            : isClientAlert
              ? "bg-gradient-to-br from-amber-100 to-amber-50 dark:from-amber-900/60 dark:to-amber-800/40 ring-1 ring-amber-200/50 dark:ring-amber-700/50"
              : notification.type === "lead_transfer"
                ? "bg-gradient-to-br from-primary/20 to-primary/10 ring-1 ring-primary/20"
                : "bg-muted ring-1 ring-border/50"
        )}>
          <NotificationIcon type={notification.type} bia={isBia} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <p className={cn(
              "text-sm leading-tight break-words",
              !notification.read && "font-semibold",
              isVisitAlert && !notification.read && "text-blue-800 dark:text-blue-200",
              isClientAlert && !notification.read && "text-amber-800 dark:text-amber-200"
            )}>
              {notification.title}
            </p>
            {!notification.read && (
              <div className={cn(
                "w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ring-2 ring-background",
                isVisitAlert ? "bg-blue-500 shadow-blue-500/50 shadow-sm"
                  : isClientAlert ? "bg-amber-500 shadow-amber-500/50 shadow-sm"
                  : "bg-primary"
              )} />
            )}
          </div>

          {notification.message && (
            <p className={cn(
              "text-xs mt-1 line-clamp-2 leading-relaxed break-words",
              isVisitAlert && !notification.read
                ? "text-blue-700/80 dark:text-blue-300/80"
                : isClientAlert && !notification.read
                  ? "text-amber-700/80 dark:text-amber-300/80"
                  : "text-muted-foreground"
            )}>
              {notification.message}
            </p>
          )}

          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <p className="text-[10px] sm:text-xs text-muted-foreground/70">
              {format(new Date(notification.created_at), "dd/MM 'às' HH:mm", { locale: ptBR })}
            </p>
            {isVisitAlert && !notification.read && (
              <span className="inline-flex items-center gap-1 text-[9px] sm:text-[10px] font-bold uppercase tracking-wide text-white bg-gradient-to-r from-blue-600 to-blue-500 px-2 py-0.5 rounded-full shadow-sm">
                Visita agendada
              </span>
            )}
            {isClientAlert && !notification.read && (
              <span className="inline-flex items-center gap-1 text-[9px] sm:text-[10px] font-bold uppercase tracking-wide text-white bg-gradient-to-r from-amber-600 to-amber-500 px-2 py-0.5 rounded-full shadow-sm">
                Cliente
              </span>
            )}
            {isBia && (
              <span className="inline-flex items-center gap-1 text-[9px] sm:text-[10px] font-bold uppercase tracking-wide text-white bg-gradient-to-r from-violet-600 to-fuchsia-500 px-2 py-0.5 rounded-full shadow-sm">
                IA
              </span>
            )}
          </div>

          {notification.data && typeof notification.data === "object" && "contact_phone" in notification.data && notification.data.contact_phone && (
            <div className="flex items-center gap-1.5 mt-2">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onClick(notification); }}
                className="inline-flex items-center gap-1 text-[10px] sm:text-xs font-medium text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-900/40 hover:bg-green-200 dark:hover:bg-green-900/60 px-2 py-1 rounded-md transition-colors border border-green-200/50 dark:border-green-700/50"
              >
                <ExternalLink className="w-3 h-3" />
                Abrir Chat
              </button>
            </div>
          )}
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-all hover:bg-destructive/10 hover:text-destructive"
          onClick={(e) => { e.stopPropagation(); onDelete(notification.id); }}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

/* ── main component ──────────────────────────────────── */

export function NotificationBell() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("todos");
  const navigate = useNavigate();
  const {
    notifications,
    unreadCount,
    clientAlertCount,
    visitCount,
    markAsRead,
    markAllAsRead,
    deleteNotification,
  } = useAppNotifications();

  // Count unread per tab group
  const tabUnreadCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const tab of TAB_GROUPS) {
      if (!tab.types) {
        counts[tab.key] = unreadCount;
      } else {
        counts[tab.key] = notifications.filter(
          (n) => !n.read && tab.types!.includes(n.type)
        ).length;
      }
    }
    return counts;
  }, [notifications, unreadCount]);

  // Filter notifications by active tab
  const filteredNotifications = useMemo(() => {
    const group = TAB_GROUPS.find((t) => t.key === activeTab);
    if (!group || !group.types) return notifications;
    return notifications.filter((n) => group.types!.includes(n.type));
  }, [notifications, activeTab]);

  const handleNotificationClick = async (notification: AppNotification) => {
    if (!notification.read) {
      await markAsRead(notification.id);
    }
    if (notification.type === "delivery_stall") {
      setIsOpen(false);
      navigate("/configuracoes?secao=connection");
    } else if (notification.type === "new_candidate" && notification.data && typeof notification.data === "object" && "response_id" in notification.data) {
      setIsOpen(false);
      navigate(`/formularios?section=freelancer&sub=candidatos&candidato=${notification.data.response_id}`);
    } else if (notification.type === "existing_client" && notification.data && typeof notification.data === "object") {
      if ("contact_phone" in notification.data) {
        setIsOpen(false);
        navigate(`/atendimento?phone=${notification.data.contact_phone}`);
      }
    } else if ((notification.type === "visit_scheduled" || notification.type === "message_stuck" || notification.type === "lead_needs_human" || notification.type === "contact_stop_request") && notification.data && typeof notification.data === "object") {
      if ("contact_phone" in notification.data && notification.data.contact_phone) {
        setIsOpen(false);
        navigate(`/atendimento?phone=${notification.data.contact_phone}`);
      } else if ("lead_id" in notification.data && notification.data.lead_id) {
        setIsOpen(false);
        navigate(`/atendimento?lead=${notification.data.lead_id}`);
      }
    } else if (notification.type === "tarefa_vencendo" || notification.type === "tarefa_atribuida") {
      setIsOpen(false);
      navigate("/agenda?tab=tarefas");
    } else if (notification.data && typeof notification.data === "object" && "lead_id" in notification.data) {
      setIsOpen(false);
      navigate(`/atendimento?lead=${notification.data.lead_id}`);
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "relative transition-all duration-300 rounded-full",
            unreadCount > 0
              ? "bg-primary/20 text-primary hover:bg-primary/30 shadow-lg shadow-primary/20"
              : "bg-muted/60 text-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          <Bell className={cn("h-5 w-5", unreadCount > 0 && "animate-pulse")} />
          {unreadCount > 0 && (
            <Badge className="absolute -top-1.5 -right-1.5 h-5 min-w-5 px-1 text-xs bg-destructive text-destructive-foreground border-2 border-background shadow-md">
              {unreadCount > 99 ? "99+" : unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[calc(100vw-2rem)] max-w-sm p-0 border-border shadow-2xl bg-background backdrop-blur-xl"
        sideOffset={8}
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-primary/10 via-primary/5 to-transparent backdrop-blur-sm border-b border-border/50 p-3 sm:p-4 rounded-t-lg">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="font-display font-bold text-sm sm:text-base text-foreground">Notificações</h4>
              <div className="flex items-center gap-1.5 flex-wrap">
                {visitCount > 0 && (
                  <span className="inline-flex items-center gap-1 text-[10px] sm:text-xs font-semibold text-blue-700 dark:text-blue-300 bg-gradient-to-r from-blue-100 to-blue-50 dark:from-blue-900/50 dark:to-blue-800/30 px-2 py-1 rounded-full border border-blue-200/50 dark:border-blue-700/50 shadow-sm">
                    <CalendarCheck className="w-3 h-3" />
                    <span>{visitCount}</span>
                    <span className="hidden xs:inline">visita{visitCount !== 1 ? "s" : ""}</span>
                  </span>
                )}
                {clientAlertCount > 0 && (
                  <span className="inline-flex items-center gap-1 text-[10px] sm:text-xs font-semibold text-amber-700 dark:text-amber-300 bg-gradient-to-r from-amber-100 to-amber-50 dark:from-amber-900/50 dark:to-amber-800/30 px-2 py-1 rounded-full border border-amber-200/50 dark:border-amber-700/50 shadow-sm">
                    <Crown className="w-3 h-3" />
                    <span>{clientAlertCount}</span>
                    <span className="hidden xs:inline">cliente{clientAlertCount !== 1 ? "s" : ""}</span>
                  </span>
                )}
              </div>
            </div>
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-7 px-2 text-muted-foreground hover:text-foreground w-full sm:w-auto justify-center sm:justify-start"
                onClick={markAllAsRead}
              >
                <Check className="w-3 h-3 mr-1" />
                Marcar lidas
              </Button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <div className="overflow-x-auto border-b border-border/30">
            <TabsList className="w-full justify-start rounded-none bg-transparent h-9 px-2 gap-0.5">
              {TAB_GROUPS.map((tab) => (
                <TabsTrigger
                  key={tab.key}
                  value={tab.key}
                  className="relative text-xs px-2.5 py-1.5 h-7 data-[state=active]:bg-primary/10 data-[state=active]:text-primary rounded-md data-[state=active]:shadow-none"
                >
                  {tab.label}
                  {tabUnreadCounts[tab.key] > 0 && tab.key !== "todos" && (
                    <span className="ml-1 inline-flex items-center justify-center h-4 min-w-4 px-1 text-[10px] font-bold rounded-full bg-destructive text-destructive-foreground">
                      {tabUnreadCounts[tab.key]}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>

        {/* List */}
        <ScrollArea className="h-72 sm:h-80">
          {filteredNotifications.length === 0 ? (
            <div className="p-8 text-center">
              <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-muted/50 flex items-center justify-center">
                <Bell className="w-6 h-6 text-muted-foreground/50" />
              </div>
              <p className="text-muted-foreground text-sm">Nenhuma notificação</p>
            </div>
          ) : (
            <div className="divide-y divide-border/30">
              {filteredNotifications.map((notification) => (
                <NotificationItem
                  key={notification.id}
                  notification={notification}
                  onRead={markAsRead}
                  onDelete={deleteNotification}
                  onClick={handleNotificationClick}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
