import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import CelebreiLogo from "./CelebreiLogo";
import { scrollToSection } from "./lp-theme";

interface HubHeaderProps {
  onOpenWizard?: () => void;
}

const NAV = [
  { id: "como-funciona", label: "Como funciona" },
  { id: "recursos", label: "Recursos" },
  { id: "demo", label: "Demonstração" },
  { id: "plano", label: "Plano" },
  { id: "por-que", label: "Por que a Celebrei" },
];

export default function HubHeader({ onOpenWizard }: HubHeaderProps) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 border-b transition-all duration-300",
        scrolled ? "border-[#0F1222]/[0.06] bg-white/90 backdrop-blur-xl" : "border-transparent bg-transparent",
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:h-[72px] sm:px-6">
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          aria-label="Celebrei, voltar ao início"
          className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F0457A]"
        >
          <CelebreiLogo markClassName="h-8 w-8 sm:h-9 sm:w-9" />
        </button>

        <nav className="hidden items-center gap-8 lg:flex" aria-label="Seções da página">
          {NAV.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              onClick={(e) => {
                e.preventDefault();
                scrollToSection(item.id);
              }}
              className="text-[15px] font-medium text-slate-600 transition-colors [@media(hover:hover)]:hover:text-[#0F1222]"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
        <a href="/hub-login" className="text-[15px] font-semibold text-slate-600 transition-colors [@media(hover:hover)]:hover:text-[#0F1222]">
          Entrar
        </a>
        <button
          type="button"
          onClick={onOpenWizard}
          className="inline-flex items-center rounded-full bg-[#0F1222] px-3.5 py-2 text-[13px] font-semibold text-white sm:hidden"
        >
          Demonstração
        </button>
        <button
          type="button"
          onClick={onOpenWizard}
          className="hidden items-center gap-1.5 rounded-full bg-[#0F1222] px-5 py-2.5 text-sm font-semibold text-white transition-all [@media(hover:hover)]:hover:bg-[#1B2036] sm:inline-flex"
        >
          Agendar demonstração
          <ArrowRight className="h-4 w-4" />
        </button>
        </div>
      </div>
    </header>
  );
}
