import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Activity, BadgePercent, Bell, Bot, Building2, Clock, Cpu, Database, FileText, FolderOpen, Globe,
  MessageCircleHeart, MessageSquare, MessagesSquare, Palette, PartyPopper, Send, Settings, Sparkles, Store, Upload, UserCircle, Users, Wifi, Wand2,
} from "lucide-react";
import { HubLayout, type HubGroup, type HubTone } from "./HubLayout";
import { Skeleton } from "@/components/ui/skeleton";
import { useCompany } from "@/contexts/CompanyContext";
import { useCompanyModules } from "@/hooks/useCompanyModules";
import { useConfigPermissions } from "@/hooks/useConfigPermissions";
import { signupStatus } from "@/lib/selfSetup";
import { ProfileContent } from "@/components/admin/ProfileContent";
import { PartyControlConfig } from "@/components/admin/PartyControlConfig";
import { UsersManagementPanel } from "@/components/admin/UsersManagementPanel";
import { CompanyBackupPanel } from "@/components/admin/CompanyBackupPanel";
import { ActivityLogPanel } from "@/components/admin/ActivityLogPanel";
import { CompanyDataSection } from "@/components/whatsapp/settings/CompanyDataSection";
import { SiteSection } from "@/components/whatsapp/settings/SiteSection";
import { ConnectionSection } from "@/components/whatsapp/settings/ConnectionSection";
import { NotificationsSection } from "@/components/whatsapp/settings/NotificationsSection";
import { MessagesSection } from "@/components/whatsapp/settings/MessagesSection";
import { SalesMaterialsSection } from "@/components/whatsapp/settings/SalesMaterialsSection";
import { AiOverviewSection } from "@/components/whatsapp/settings/ai/AiOverviewSection";
import { AiScheduleSection } from "@/components/whatsapp/settings/ai/AiScheduleSection";
import { AiBuffetInfoSection } from "@/components/whatsapp/settings/ai/AiBuffetInfoSection";
import { AiPromotionSection } from "@/components/whatsapp/settings/ai/AiPromotionSection";
import { AiFollowUpSection } from "@/components/whatsapp/settings/ai/AiFollowUpSection";
import { AiTechSection } from "@/components/whatsapp/settings/ai/AiTechSection";
import { confirmLeaveUnsaved } from "@/lib/unsavedChanges";
import { AiTestSection } from "@/components/whatsapp/settings/AiTestSection";
import { AutomationsSection } from "@/components/whatsapp/settings/AutomationsSection";
import { DataImportSection } from "@/components/admin/DataImportSection";
import { UnitColorManager } from "@/components/admin/UnitColorManager";

// Configurações organizadas pelo que o dono quer fazer (22/10): um menu só,
// em 6 grupos, no lugar das três fileiras de abas (Configurações → Empresa e
// WhatsApp → Automações). Nenhuma função mudou de comportamento, só de lugar;
// as permissões de cada item são as mesmas de antes.

// Saíram (22/10): Campanhas (nada lia), VIP (ninguém usava; "Não enviar mais nada"
// por contato já faz isso) e Fluxos (sem uso). Bot Festa e Gatilhos são mensagens
// enviadas por botões da Agenda e de Freelancers: ficam em "Modelos de mensagem".
const MESSAGE_TABS = ["visitas", "followups", "reativacao", "prereserva", "formularios"];
const ROBOT_TABS = ["geral", "perguntas", "bot-lp"];
const TEMPLATE_TABS = ["festa", "gatilhos"];

type Group = HubGroup;

// Cor de cada grupo: o grupo (tópico) tem ícone colorido e título forte; as
// funções ficam recuadas embaixo, na mesma cor quando abertas
const TONES: Record<string, HubTone> = {
  buffet: { chip: "bg-amber-500/15 text-amber-600", line: "border-amber-500/30", active: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  whatsapp: { chip: "bg-emerald-500/15 text-emerald-600", line: "border-emerald-500/30", active: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  ia: { chip: "bg-violet-500/15 text-violet-600", line: "border-violet-500/30", active: "bg-violet-500/10 text-violet-700 dark:text-violet-400" },
  auto: { chip: "bg-sky-500/15 text-sky-600", line: "border-sky-500/30", active: "bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  robot: { chip: "bg-slate-500/15 text-slate-600", line: "border-slate-500/30", active: "bg-slate-500/10 text-slate-700 dark:text-slate-300" },
  sistema: { chip: "bg-zinc-500/15 text-zinc-600", line: "border-zinc-500/30", active: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-300" },
};
const toneOf = (id: string) => TONES[id] || TONES.sistema;

// Links antigos (?tab= / ?secao=) continuam abrindo o lugar certo
const LEGACY: Record<string, string> = {
  perfil: "perfil",
  usuarios: "usuarios",
  whatsapp: "company",
  festa: "festa",
  backup: "backup",
  auditoria: "auditoria",
  company: "company",
  site: "site",
  "ia-teste": "ia-teste",
  connection: "connection",
  content: "materials",
  notifications: "notifications",
  automations: "automations",
  advanced: "import",
};

interface Props {
  userId: string;
  userEmail: string;
  isAdmin: boolean;
  isGestor: boolean;
  canManageUsers: boolean;
  showOperacoes: boolean;
  isMobile: boolean;
}

export function SettingsHub({ userId, userEmail, isAdmin, isGestor, canManageUsers, showOperacoes, isMobile }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const modules = useCompanyModules();
  const { currentRole, currentCompany } = useCompany();
  const { permissions, isLoading } = useConfigPermissions(userId, isAdmin, currentRole === "owner");
  const companyAdmin = currentRole === "admin" || currentRole === "owner" || isAdmin || isGestor;
  const hasAi = !!modules.ia_conversacional || !!signupStatus(currentCompany?.settings);
  const automationsOn = !!permissions.automations && (isAdmin || !!modules.automations);
  const messagesOn = !!permissions.messages && (isAdmin || !!modules.messages);
  const systemOn = isGestor || isAdmin || canManageUsers;
  const aiOn = !!modules.ia_conversacional && automationsOn;

  const groups: Group[] = useMemo(() => [
    {
      id: "buffet", title: "Meu buffet", icon: Building2, items: [
        { id: "company", title: "Dados da empresa", description: "Logo, nome e dados do buffet", icon: Building2, visible: companyAdmin, render: () => <CompanyDataSection /> },
        { id: "site", title: "Meu site", description: "Página do buffet e botões do WhatsApp", icon: Globe, visible: companyAdmin, render: () => <SiteSection /> },
        { id: "festa", title: "Página do dia da festa", description: "O que aparece no link da festa para a equipe", icon: PartyPopper, visible: showOperacoes, render: () => <PartyControlConfig /> },
        { id: "usuarios", title: "Usuários", description: "Equipe, senhas e permissões", icon: Users, visible: canManageUsers, render: () => <UsersManagementPanel userId={userId} isAdmin={isAdmin} /> },
        { id: "unit-colors", title: "Cores dos números", description: "Cor de cada número (VENDAS 1, 2, 3) nas etiquetas", icon: Palette, visible: isAdmin, render: () => <UnitColorManager /> },
      ],
    },
    {
      id: "whatsapp", title: "WhatsApp", icon: MessageSquare, items: [
        { id: "connection", title: "Conexão dos números", description: "Status, QR Code e números conectados", icon: Wifi, visible: !!permissions.connection, render: () => <ConnectionSection userId={userId} isAdmin={isAdmin} /> },
        { id: "templates", title: "Respostas prontas", description: "Mensagens rápidas da equipe no chat", icon: FileText, visible: messagesOn, render: () => <MessagesSection userId={userId} isAdmin={isAdmin} /> },
        { id: "notifications", title: "Notificações e alertas", description: "Som e avisos para a equipe", icon: Bell, visible: !!permissions.notifications, render: () => <NotificationsSection /> },
      ],
    },
    {
      id: "ia", title: "Inteligência Artificial", icon: Sparkles, items: [
        { id: "ia-config", title: "Visão geral", description: "Ligar a IA, números e o que falta preencher", icon: Wand2, visible: aiOn, render: () => <AiOverviewSection /> },
        { id: "ia-apresentacao", title: "Apresentação e horários", description: "Nome, visitas, equipe, festas e alertas", icon: Clock, visible: aiOn, render: () => <AiScheduleSection /> },
        { id: "ia-buffet", title: "Sobre o buffet", description: "Estrutura, diferenciais, respostas rápidas e regras", icon: Store, visible: aiOn, render: () => <AiBuffetInfoSection /> },
        { id: "ia-promocao", title: "Promoção", description: "A promoção do momento que a IA oferece", icon: BadgePercent, visible: aiOn, render: () => <AiPromotionSection /> },
        { id: "ia-followup", title: "Acompanhamento", description: "Lembretes para quem parou de responder", icon: MessageCircleHeart, visible: aiOn, render: () => <AiFollowUpSection /> },
        { id: "materials", title: "Materiais", description: "Fotos, vídeo, PDF e avaliações que a IA envia", icon: FolderOpen, visible: messagesOn, render: () => <SalesMaterialsSection userId={userId} isAdmin={isAdmin} /> },
        { id: "ia-teste", title: companyAdmin ? "Testar e ensinar" : "Testar a IA", description: companyAdmin ? "Conversar com a IA e ver o que ela passou para a equipe" : "Conversar com a IA como se fosse um cliente", icon: Sparkles, visible: hasAi, render: () => <AiTestSection canManage={companyAdmin} /> },
        { id: "ia-tecnico", title: "Técnico (Celebrei)", description: "Modelo, consumo, número de teste e testes automáticos", icon: Cpu, visible: aiOn && isAdmin, render: () => <AiTechSection /> },
      ],
    },
    {
      // Robô, envios automáticos e modelos num grupo só: tudo é mensagem que sai sozinha
      id: "auto", title: "Mensagens e robô", icon: Send, items: [
        { id: "robot", title: "Robô de atendimento", description: "Responde o cliente: atendimento, perguntas e robô do site", icon: Bot, visible: automationsOn, render: () => <AutomationsSection tabs={ROBOT_TABS} hideAi /> },
        { id: "automations", title: "Mensagens automáticas", description: "Visitas e pós-visita, follow-ups, reativação, pré-reserva e dados do contrato", icon: Send, visible: automationsOn, render: () => <AutomationsSection tabs={MESSAGE_TABS} hideAi /> },
        { id: "modelos", title: "Modelos de mensagem", description: "Convidados das festas (Bot Festa) e freelancers (aprovação e escala)", icon: MessagesSquare, visible: automationsOn, render: () => <AutomationsSection tabs={TEMPLATE_TABS} hideAi /> },
      ],
    },
    {
      id: "sistema", title: "Sistema", icon: Settings, items: [
        { id: "perfil", title: "Meu perfil", description: "Seu nome, foto e senha", icon: UserCircle, visible: true, render: () => <ProfileContent userId={userId} userEmail={userEmail} /> },
        { id: "backup", title: "Backup", description: "Cópia dos dados do buffet", icon: Database, visible: systemOn, render: () => <CompanyBackupPanel /> },
        { id: "auditoria", title: "Auditoria", description: "Quem fez o quê na plataforma", icon: Activity, visible: systemOn, render: () => <ActivityLogPanel /> },
        // Só administrador: importar leads de planilha (o antigo "Avançado" tinha botões que não faziam nada)
        { id: "import", title: "Importar dados", description: "Importar leads de planilha", icon: Upload, visible: isAdmin, render: () => <DataImportSection isAdmin={isAdmin} /> },
      ],
    },
  ].map((g) => ({ ...g, items: g.items.filter((i) => i.visible) })).filter((g) => g.items.length > 0),
  [permissions, companyAdmin, hasAi, aiOn, automationsOn, messagesOn, systemOn, showOperacoes, canManageUsers, userId, userEmail, isAdmin]);

  const allItems = groups.flatMap((g) => g.items);
  const requested = searchParams.get("item") || LEGACY[searchParams.get("secao") || ""] || LEGACY[searchParams.get("tab") || ""] || null;
  const current = allItems.find((i) => i.id === requested) || null;
  // No computador sempre há um item aberto; no celular, sem item = a lista
  const active = current || (isMobile ? null : allItems[0] || null);

  const open = (id: string | null) => {
    if (id !== active?.id && !confirmLeaveUnsaved()) return;
    const next = new URLSearchParams();
    if (id) next.set("item", id);
    setSearchParams(next, { replace: false });
  };

  if (isLoading) {
    return (
      <div className="flex flex-col md:flex-row gap-4">
        <div className="md:w-64 space-y-2">{[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-12 w-full rounded-xl" />)}</div>
        <Skeleton className="h-64 flex-1 rounded-xl" />
      </div>
    );
  }

  return <HubLayout groups={groups} active={active} onOpen={open} isMobile={isMobile} backLabel="Configurações" toneOf={toneOf} />;
}
