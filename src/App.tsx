import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { CompanyProvider } from "@/contexts/CompanyContext";
import { CampaignSenderProvider } from "@/contexts/CampaignSenderContext";
import { LoadingScreen } from "@/components/ui/loading-screen";

// Eager: root-level routing (tiny, always needed)
import RootPage from "./pages/RootPage";
import { AppStartRedirect } from "./components/AppStartRedirect";
import { isPreviewDomain, getCanonicalHost } from "@/hooks/useDomainDetection";
import { SetupGate } from "@/components/SetupGate";
import NotFound from "./pages/NotFound";

// Lazy-loaded pages with prefetch support
const lazyImports = {
  "/dashboard": () => import("./pages/Index"),
  "/auth": () => import("./pages/Auth"),
  "/comecar": () => import("./pages/Comecar"),
  "/termos": () => import("./pages/LegalPage"),
  "/redefinir-senha": () => import("./pages/RedefinirSenha"),
  "/setup": () => import("./pages/SetupBuffet"),
  "/atendimento": () => import("./pages/CentralAtendimento"),
  "/configuracoes": () => import("./pages/Configuracoes"),
  "/promo": () => import("./pages/PromoPage"),
  "/hub/comercial-b2b": () => import("./pages/ComercialB2B"),
  "/hub-login": () => import("./pages/HubLogin"),
  "/hub-landing": () => import("./pages/HubLandingPage"),
  "/hub": () => import("./pages/HubDashboard"),
  "/hub/empresas": () => import("./pages/HubEmpresas"),
  "/hub/users": () => import("./pages/HubUsers"),
  "/hub/whatsapp": () => import("./pages/HubWhatsApp"),
  "/hub/onboarding": () => import("./pages/HubOnboarding"),
  "/hub/prospeccao": () => import("./pages/HubProspeccao"),
  "/hub/consumo-ia": () => import("./pages/HubAIUsage"),
  "/hub/treinamento": () => import("./pages/HubTreinamento"),
  "/hub/leads": () => import("./pages/HubLeads"),
  "/hub/suporte": () => import("./pages/HubSuporte"),
  "/hub/materiais": () => import("./pages/HubMateriais"),
  "/hub/recrutamento": () => import("./pages/HubRecruitment"),
  "/hub/funcionalidades": () => import("./pages/HubFuncionalidades"),
  "/hub/backups": () => import("./pages/HubBackups"),
  "/hub/instagram": () => import("./pages/HubInstagram"),
  "/aprenda": () => import("./pages/Treinamento"),
  "/inteligencia": () => import("./pages/Inteligencia"),
  "/agenda": () => import("./pages/Agenda"),
  "/formularios": () => import("./pages/Formularios"),
  "/avaliacoes": () => import("./pages/Avaliacoes"),
  "/pre-festa": () => import("./pages/PreFesta"),
  "/campanhas": () => import("./pages/Campanhas"),
  
  "/contratos": () => import("./pages/ContratosModule"),
  "/contrato": () => import("./pages/Contrato"),
  "/cardapio": () => import("./pages/Cardapio"),
  "/financeiro": () => import("./pages/Financeiro"),
  "/parceiro": () => import("./pages/PartnerDashboard"),
  "/parceiro/catalogo": () => import("./pages/PartnerCatalog"),
  "/parceiro/pedidos": () => import("./pages/PartnerOrders"),
  "/parceiro/config": () => import("./pages/PartnerConfig"),
} as Record<string, () => Promise<any>>;

// Prefetch cache to avoid double-importing
const prefetched = new Set<string>();

export function prefetchRoute(path: string) {
  const normalizedPath = "/" + path.replace(/^\/+/, "");
  if (prefetched.has(normalizedPath)) return;
  const loader = lazyImports[normalizedPath];
  if (loader) {
    prefetched.add(normalizedPath);
    loader();
  }
}

// Lazy-loaded pages
const Index = lazy(lazyImports["/dashboard"]);
const Auth = lazy(lazyImports["/auth"]);
const Comecar = lazy(lazyImports["/comecar"]);
const LegalPage = lazy(lazyImports["/termos"]);
const RedefinirSenha = lazy(lazyImports["/redefinir-senha"]);
const SetupBuffet = lazy(lazyImports["/setup"]);
const CentralAtendimento = lazy(lazyImports["/atendimento"]);
const Configuracoes = lazy(lazyImports["/configuracoes"]);
const PromoPage = lazy(lazyImports["/promo"]);
const ComercialB2B = lazy(lazyImports["/hub/comercial-b2b"]);
const HubLogin = lazy(lazyImports["/hub-login"]);
const HubLandingPage = lazy(lazyImports["/hub-landing"]);
const HubDashboard = lazy(lazyImports["/hub"]);
const HubEmpresas = lazy(lazyImports["/hub/empresas"]);
const EmpresasLandingPage = lazy(() => import("./pages/EmpresasLandingPage"));

// /empresas: no site do Castelo é a página de confraternização de empresas
// (campanha de fim de ano); nos outros domínios continua indo para o Hub
const EMPRESAS_LP_DOMAINS = ["castelodadiversao.com.br", "castelodadiversao.online"];
function EmpresasRoute() {
  if (EMPRESAS_LP_DOMAINS.includes(getCanonicalHost()) || isPreviewDomain()) return <EmpresasLandingPage />;
  return <Navigate to="/hub/empresas" replace />;
}
const HubUsers = lazy(lazyImports["/hub/users"]);
const HubWhatsApp = lazy(lazyImports["/hub/whatsapp"]);
const HubOnboarding = lazy(lazyImports["/hub/onboarding"]);
const HubProspeccao = lazy(lazyImports["/hub/prospeccao"]);
const HubAIUsage = lazy(lazyImports["/hub/consumo-ia"]);
const HubTreinamento = lazy(lazyImports["/hub/treinamento"]);
const HubLeads = lazy(lazyImports["/hub/leads"]);
const HubSuporte = lazy(lazyImports["/hub/suporte"]);
const HubMateriais = lazy(lazyImports["/hub/materiais"]);
const HubRecruitment = lazy(lazyImports["/hub/recrutamento"]);
const HubFuncionalidades = lazy(lazyImports["/hub/funcionalidades"]);
const HubBackups = lazy(lazyImports["/hub/backups"]);
const HubInstagram = lazy(lazyImports["/hub/instagram"]);
const Treinamento = lazy(lazyImports["/aprenda"]);
const Onboarding = lazy(() => import("./pages/Onboarding"));
const Inteligencia = lazy(lazyImports["/inteligencia"]);
const Agenda = lazy(lazyImports["/agenda"]);
const Formularios = lazy(lazyImports["/formularios"]);
const Avaliacoes = lazy(lazyImports["/avaliacoes"]);
const PreFesta = lazy(lazyImports["/pre-festa"]);
const Campanhas = lazy(lazyImports["/campanhas"]);

const PublicRecruitmentForm = lazy(() => import("./pages/PublicRecruitmentForm"));
const DynamicLandingPage = lazy(() => import("./pages/DynamicLandingPage"));
const MegaMagicLandingPage = lazy(() => import("./pages/MegaMagicLandingPage"));
const PlanetaDivertidoLandingPage = lazy(() => import("./pages/PlanetaDivertidoLandingPage"));
const PublicEvaluation = lazy(() => import("./pages/PublicEvaluation"));
const PublicPreFesta = lazy(() => import("./pages/PublicPreFesta"));
const PublicContrato = lazy(() => import("./pages/PublicContrato"));
const PublicCardapio = lazy(() => import("./pages/PublicCardapio"));
const PublicStaff = lazy(() => import("./pages/PublicStaff"));
const PublicMaintenance = lazy(() => import("./pages/PublicMaintenance"));
const PublicPartyMonitoring = lazy(() => import("./pages/PublicPartyMonitoring"));
const PublicAttendance = lazy(() => import("./pages/PublicAttendance"));
const PublicAttendanceReview = lazy(() => import("./pages/PublicAttendanceReview"));
const PublicEventInfo = lazy(() => import("./pages/PublicEventInfo"));
const PublicFreelancer = lazy(() => import("./pages/PublicFreelancer"));
const FreelancerInvite = lazy(() => import("./pages/FreelancerInvite"));
const PublicFreelancerSchedule = lazy(() => import("./pages/PublicFreelancerSchedule"));
const Contrato = lazy(lazyImports["/contrato"]);
const ContratosModule = lazy(lazyImports["/contratos"]);
const Cardapio = lazy(lazyImports["/cardapio"]);
const Financeiro = lazy(lazyImports["/financeiro"]);
const PartnerDashboard = lazy(lazyImports["/parceiro"]);
const PartnerCatalog = lazy(lazyImports["/parceiro/catalogo"]);
const PartnerOrders = lazy(lazyImports["/parceiro/pedidos"]);
const PartnerConfig = lazy(lazyImports["/parceiro/config"]);
const PublicPartyControl = lazy(() => import("./pages/PublicPartyControl"));
const PublicClientData = lazy(() => import("./pages/PublicClientData"));
const PublicContractSign = lazy(() => import("./pages/PublicContractSign"));
const AdminMessageTrace = lazy(() => import("./pages/AdminMessageTrace"));


const PageLoader = () => <LoadingScreen message="Carregando..." />;

// Aba "hibernada": o Safari (especialmente no iPad) congela abas em segundo plano
// e, ao voltar, a tela exibe dados de horas/dias atrás (ex.: festa desatualizada).
// Se a aba ficou oculta por mais de 30 minutos, recarrega para buscar tudo fresco.
const STALE_TAB_RELOAD_MS = 30 * 60 * 1000;
let staleTabHiddenSince: number | null = null;
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      staleTabHiddenSince = Date.now();
    } else {
      if (staleTabHiddenSince && Date.now() - staleTabHiddenSince > STALE_TAB_RELOAD_MS) {
        window.location.reload();
      }
      staleTabHiddenSince = null;
    }
  });
}

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <CompanyProvider>
      <CampaignSenderProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <SetupGate />
          <AppStartRedirect />
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/" element={<RootPage />} />
              <Route path="/auth" element={<Auth />} />
              <Route path="/auth/:slug" element={<Auth />} />
              <Route path="/comecar" element={<Comecar />} />
              <Route path="/termos" element={<LegalPage doc="termos" />} />
              <Route path="/redefinir-senha" element={<RedefinirSenha />} />
              <Route path="/privacidade" element={<LegalPage doc="privacidade" />} />
              <Route path="/setup" element={<SetupBuffet />} />
              <Route path="/atendimento" element={<CentralAtendimento />} />
              <Route path="/configuracoes" element={<Configuracoes />} />
              <Route path="/perfil" element={<Navigate to="/configuracoes?tab=perfil" replace />} />
              <Route path="/hub/comercial-b2b" element={<ComercialB2B />} />
              {/* Antiga LP de venda: a LP do Hub é a única (fica na raiz de hubcelebrei.com.br) */}
              <Route path="/para-buffets" element={<Navigate to={isPreviewDomain() ? "/hub-landing" : "/"} replace />} />
              <Route path="/dashboard" element={<Index />} />
              <Route path="/users" element={<Navigate to="/configuracoes?tab=usuarios" replace />} />
              <Route path="/promo" element={<PromoPage />} />
              {/* Hub portal - independent */}
              <Route path="/hub-landing" element={<HubLandingPage />} />
              <Route path="/hub-login" element={<HubLogin />} />
              <Route path="/hub" element={<HubDashboard />} />
              <Route path="/hub/empresas" element={<HubEmpresas />} />
              <Route path="/hub/whatsapp" element={<HubWhatsApp />} />
              <Route path="/hub/users" element={<HubUsers />} />
              <Route path="/hub/onboarding" element={<HubOnboarding />} />
              <Route path="/hub/prospeccao" element={<HubProspeccao />} />
              <Route path="/hub/consumo-ia" element={<HubAIUsage />} />
              <Route path="/hub/treinamento" element={<HubTreinamento />} />
              <Route path="/hub/leads" element={<HubLeads />} />
              <Route path="/hub/suporte" element={<HubSuporte />} />
              <Route path="/hub/materiais" element={<HubMateriais />} />
              <Route path="/hub/recrutamento" element={<HubRecruitment />} />
              <Route path="/hub/funcionalidades" element={<HubFuncionalidades />} />
              <Route path="/hub/backups" element={<HubBackups />} />
              <Route path="/hub/instagram" element={<HubInstagram />} />
              <Route path="/recrutamento-comercial" element={<PublicRecruitmentForm />} />
              <Route path="/aprenda" element={<Treinamento />} />
              <Route path="/treinamento" element={<Navigate to="/aprenda" replace />} />
              <Route path="/inteligencia" element={<Inteligencia />} />
              <Route path="/agenda" element={<Agenda />} />
              <Route path="/formularios" element={<Formularios />} />
              <Route path="/avaliacoes" element={<Avaliacoes />} />
              <Route path="/pre-festa" element={<PreFesta />} />
              <Route path="/campanhas" element={<Campanhas />} />
              <Route path="/visitas" element={<Navigate to="/agenda?tab=visitas" replace />} />
              {/* Party control hub */}
              <Route path="/festa/:eventId" element={<PublicPartyControl />} />
              {/* Public client data form */}
              <Route path="/dados-contratante/:token" element={<PublicClientData />} />
              <Route path="/dados/:token" element={<PublicClientData />} />
              {/* Public contract signing */}
              <Route path="/assinar-contrato/:token" element={<PublicContractSign />} />
              {/* Public dynamic landing page by slug */}
              <Route path="/lp/:slug" element={<DynamicLandingPage />} />
              {/* Preview routes for static LPs */}
              <Route path="/preview/mega-magic" element={<MegaMagicLandingPage />} />
              <Route path="/preview/planeta-divertido" element={<PlanetaDivertidoLandingPage />} />
              {/* Public onboarding form */}
              <Route path="/onboarding/:slug" element={<Onboarding />} />
              {/* Public evaluation form */}
              <Route path="/avaliacao/:companySlug/:templateSlug" element={<PublicEvaluation />} />
              <Route path="/avaliacao/:templateId" element={<PublicEvaluation />} />
              {/* Public pre-festa form */}
              <Route path="/pre-festa/:companySlug/:templateSlug" element={<PublicPreFesta />} />
              <Route path="/pre-festa/:templateId" element={<PublicPreFesta />} />
              <Route path="/prefesta/:companySlug/:templateSlug" element={<PublicPreFesta />} />
              <Route path="/prefesta/:templateId" element={<PublicPreFesta />} />
              {/* Public contrato form */}
              <Route path="/contrato/:companySlug/:templateSlug" element={<PublicContrato />} />
              <Route path="/contrato/:templateId" element={<PublicContrato />} />
              <Route path="/contrato" element={<Contrato />} />
              <Route path="/contratos" element={<ContratosModule />} />
              {/* Public cardapio form */}
              <Route path="/cardapio/:companySlug/:templateSlug" element={<PublicCardapio />} />
              <Route path="/cardapio/:templateId" element={<PublicCardapio />} />
              <Route path="/cardapio" element={<Cardapio />} />
              <Route path="/financeiro" element={<Financeiro />} />
              <Route path="/admin/message-trace" element={<AdminMessageTrace />} />
              {/* Partner (Empresa Parceira) */}
              <Route path="/parceiro" element={<PartnerDashboard />} />
              <Route path="/parceiro/catalogo" element={<PartnerCatalog />} />
              <Route path="/parceiro/pedidos" element={<PartnerOrders />} />
              <Route path="/parceiro/config" element={<PartnerConfig />} />
              {/* Public staff form */}
              <Route path="/equipe/:recordId" element={<PublicStaff />} />
              {/* Public maintenance form */}
              <Route path="/manutencao/:recordId" element={<PublicMaintenance />} />
              {/* Public party monitoring form */}
              <Route path="/acompanhamento/:recordId" element={<PublicPartyMonitoring />} />
              {/* Public attendance list form */}
              <Route path="/lista-presenca/:recordId/conferencia" element={<PublicAttendanceReview />} />
              <Route path="/lista-presenca/:recordId" element={<PublicAttendance />} />
              {/* Public event info */}
              <Route path="/informacoes/:recordId" element={<PublicEventInfo />} />
              {/* Public freelancer form */}
              <Route path="/freelancer/:companySlug/:templateSlug" element={<PublicFreelancer />} />
              <Route path="/freelancer/:templateId" element={<PublicFreelancer />} />
              <Route path="/trabalhe/:code" element={<FreelancerInvite />} />
              {/* Public freelancer schedule */}
              <Route path="/escala/:companySlug/:scheduleSlug" element={<PublicFreelancerSchedule />} />
              <Route path="/escala/:scheduleId" element={<PublicFreelancerSchedule />} />
              {/* Redirects for old routes */}
              <Route path="/admin" element={<Navigate to="/atendimento" replace />} />
              <Route path="/whatsapp" element={<Navigate to="/atendimento" replace />} />
              <Route path="/empresas" element={<EmpresasRoute />} />
              <Route path="/comercial-b2b" element={<Navigate to="/hub/comercial-b2b" replace />} />
              {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
              <Route path="*" element={<NotFound />} />
            </Routes>
            {/* Chat de suporte escondido (out/2026): ninguém usava */}
          </Suspense>
        </BrowserRouter>
      </TooltipProvider>
      </CampaignSenderProvider>
    </CompanyProvider>
  </QueryClientProvider>
);

export default App;
