import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

const LAUNCH_KEY = "celebrei-app-launched";

export const isStandaloneApp = () =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true);

/**
 * Onde o app instalado abre. No iPhone o ícone guarda a página em que a pessoa
 * estava ao "Adicionar à Tela de Início" — e a tela de Notificações pede para
 * fazer isso ali. Ao abrir o app (1ª página da sessão), essa tela e a página
 * inicial do site vão para a Central de Atendimento. Links de aviso (outras
 * páginas) abrem onde apontam.
 */
export function appStartTarget(pathname: string, search: string): string | null {
  if (pathname === "/") return "/atendimento";
  if (pathname === "/configuracoes" && /(item|secao|tab)=(notifications|notificacoes)/.test(search)) return "/atendimento";
  return null;
}

export function AppStartRedirect() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (!isStandaloneApp()) return;
    try {
      if (sessionStorage.getItem(LAUNCH_KEY)) return;
      sessionStorage.setItem(LAUNCH_KEY, "1");
    } catch {
      return;
    }
    const target = appStartTarget(location.pathname, location.search);
    if (target) navigate(target, { replace: true });
    // Só a 1ª página da sessão
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
