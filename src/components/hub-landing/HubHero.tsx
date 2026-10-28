import { ArrowRight, Check } from "lucide-react";
import { motion } from "framer-motion";
import { DemoPlayer } from "./HubDemoVideo";
import { BTN_PRIMARY, BTN_SECONDARY, GRADIENT_TEXT } from "./lp-theme";

interface HubHeroProps {
  onOpenWizard: () => void;
  video: { youtubeId?: string; localVideoUrl?: string; posterUrl?: string };
}

const TRUST = ["Sem compromisso", "Setup em 48h", "Suporte dedicado"];

export default function HubHero({ onOpenWizard, video }: HubHeroProps) {
  return (
    <section className="relative overflow-hidden bg-[#FFF9F3]">
      {/* Fundo: brilhos quentes + pontilhado */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-[270px] -top-[270px]" style={{ width: 740, height: 740, background: "radial-gradient(closest-side, rgba(255,201,60,0.30) 45%, transparent 100%)" }} />
        <div className="absolute -right-[248px] -top-[24px]" style={{ width: 720, height: 720, background: "radial-gradient(closest-side, rgba(240,69,122,0.20) 45%, transparent 100%)" }} />
        <div className="absolute -bottom-[120px] left-1/3 -ml-[120px]" style={{ width: 800, height: 600, background: "radial-gradient(closest-side, rgba(142,63,217,0.10) 45%, transparent 100%)" }} />
        <div
          className="absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]"
          style={{
            backgroundImage: "radial-gradient(rgba(15,18,34,0.09) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        />
      </div>

      <div className="relative mx-auto max-w-6xl px-4 pb-14 pt-24 sm:px-6 sm:pb-20 sm:pt-32 lg:pt-36">
        <div className="grid items-center gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:gap-10">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: "easeOut" }}
            className="text-center lg:text-left"
          >
            <span className="inline-flex items-center gap-2 rounded-full border border-[#0F1222]/[0.07] bg-white/80 px-3.5 py-1.5 text-[13px] font-medium text-slate-700 shadow-sm backdrop-blur">
              <span className="text-base leading-none">🎈</span>
              Feita dentro de um buffet infantil de verdade
            </span>

            <h1 className="mt-6 font-grotesque text-[2.4rem] font-extrabold leading-[1.02] tracking-[-0.035em] text-[#0F1222] sm:text-6xl lg:text-[3.6rem]">
              Seu buffet perdendo festas por <span className={GRADIENT_TEXT}>demora no atendimento?</span>
            </h1>

            <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-slate-600 sm:text-xl lg:mx-0">
              Enquanto a concorrência demora horas, a atendente com IA da Celebrei responde seus leads em segundos:
              tira dúvidas, passa os pacotes e valores do seu buffet e marca a visita. 24 horas por dia, no seu WhatsApp.
            </p>

            <div className="mt-9 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-center lg:justify-start">
              <button type="button" onClick={onOpenWizard} className={BTN_PRIMARY}>
                Agendar demonstração gratuita
                <ArrowRight className="h-5 w-5" />
              </button>
              <a href="#plano" className={BTN_SECONDARY}>
                Ver o plano
              </a>
            </div>

            <ul className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 lg:justify-start">
              {TRUST.map((item) => (
                <li key={item} className="flex items-center gap-1.5 text-sm font-medium text-slate-600">
                  <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[#10B981]/15">
                    <Check className="h-3 w-3 text-[#0E9F6E]" strokeWidth={3} />
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </motion.div>

          <motion.div
            id="demo"
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, delay: 0.25, ease: "easeOut" }}
            className="relative scroll-mt-24"
          >
            <div className="pointer-events-none absolute left-1/2 top-1/2 h-[420px] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-br from-[#FFC93C]/40 via-[#F0457A]/25 to-[#8E3FD9]/25 blur-3xl" />
            <div className="relative">
              <DemoPlayer {...video} />
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
