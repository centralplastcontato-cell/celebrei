import { ArrowRight, Check } from "lucide-react";
import { motion } from "framer-motion";
import { CelebreiMark } from "./CelebreiLogo";

interface HubCTAProps {
  onOpenWizard: () => void;
}

const WHY = [
  "Atendimento automático no WhatsApp, de dia e de noite",
  "Funil, agenda, contratos e financeiro num lugar só",
  "Implantação guiada e suporte de quem vive o dia a dia de buffet",
];

export default function HubCTA({ onOpenWizard }: HubCTAProps) {
  return (
    <section id="por-que" className="scroll-mt-16 bg-white px-4 py-14 sm:px-6 sm:py-20">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.7 }}
        className="relative mx-auto max-w-6xl overflow-hidden rounded-[2rem] bg-gradient-to-br from-[#FF8A3D] via-[#F0457A] to-[#8E3FD9] px-6 py-16 text-center shadow-[0_40px_80px_-30px_rgba(240,69,122,0.6)] sm:px-12 sm:py-20"
      >
        {/* confete */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-16 -top-16 h-56 w-56 rounded-full bg-[#FFC93C]/40 blur-3xl" />
          <div className="absolute -bottom-20 -right-10 h-64 w-64 rounded-full bg-[#8E3FD9]/50 blur-3xl" />
          <span className="absolute left-[8%] top-[22%] h-3 w-3 rotate-12 rounded-sm bg-[#FFC93C]" />
          <span className="absolute left-[16%] bottom-[18%] h-2.5 w-2.5 rounded-full bg-white/70" />
          <span className="absolute right-[10%] top-[18%] h-2.5 w-6 -rotate-12 rounded-full bg-white/60" />
          <span className="absolute right-[18%] bottom-[24%] h-3 w-3 rounded-full bg-[#38BDF8]" />
          <span className="absolute left-[40%] top-[10%] h-2 w-2 rounded-full bg-white/50" />
        </div>

        <div className="relative">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-white shadow-[0_12px_30px_-10px_rgba(15,18,34,0.4)]">
            <CelebreiMark className="h-11 w-11" />
          </div>
          <h2 className="mx-auto mt-7 max-w-2xl text-balance font-grotesque text-[2.3rem] font-extrabold leading-[1.05] tracking-[-0.03em] text-white sm:text-[3.4rem]">
            Pronto para fechar mais festas?
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-white/85 sm:text-xl">
            A Celebrei nasceu dentro de um buffet infantil de verdade. Cada recurso foi testado no dia a dia de quem
            atende pais, agenda visitas e faz festa todo fim de semana.
          </p>
          <ul className="mx-auto mt-7 grid max-w-2xl gap-2.5 text-left sm:text-center">
            {WHY.map((item) => (
              <li key={item} className="flex items-start gap-2 text-[15px] font-medium text-white sm:justify-center">
                <Check className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={3} />
                {item}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={onOpenWizard}
            className="mt-9 inline-flex w-full items-center justify-center gap-2 rounded-full bg-white px-8 py-4 text-base font-semibold text-[#0F1222] shadow-[0_18px_40px_-14px_rgba(15,18,34,0.5)] transition-all [@media(hover:hover)]:hover:-translate-y-0.5 sm:w-auto sm:text-lg"
          >
            Agendar uma conversa
            <ArrowRight className="h-5 w-5" />
          </button>
          <ul className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            {["Sem compromisso", "Setup em 48h", "Suporte dedicado"].map((item) => (
              <li key={item} className="flex items-center gap-1.5 text-sm font-medium text-white/90">
                <Check className="h-4 w-4" strokeWidth={3} />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </motion.div>
    </section>
  );
}
