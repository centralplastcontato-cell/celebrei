import { ArrowRight, Check } from "lucide-react";
import { motion } from "framer-motion";
import { BTN_PRIMARY, GRADIENT_TEXT } from "./lp-theme";
import { SectionHeading } from "./LpSection";

/**
 * Plano único com IA (out/2026): o plano só com chatbot não é mais vendido.
 * O site mostra "a partir de"; o valor fechado sai na demonstração/proposta.
 */
const INCLUDED = [
  "Atendente com IA no WhatsApp, 24 horas por dia",
  "Passa valores, consulta a agenda e marca visitas sozinha",
  "Lembretes para quem parou de responder",
  "CRM com funil de vendas e histórico das conversas",
  "Agenda de visitas e festas",
  "Contratos com assinatura digital e financeiro",
  "Formulários, cardápio e avaliação pós-festa",
  "Campanhas com mensagens e artes feitas pela IA",
  "Implantação, treinamento e suporte inclusos",
];

export default function HubPricing({ onOpenWizard }: { onOpenWizard: () => void }) {
  return (
    <section id="plano" className="relative scroll-mt-16 bg-[#FAFAFC] py-14 sm:py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="Plano"
          title={
            <>
              Um plano só, <span className={GRADIENT_TEXT}>com IA</span>
            </>
          }
          description="Tudo da Celebrei, com uma atendente de IA treinada com os pacotes, valores e regras do seu buffet."
        />

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="mx-auto mt-10 max-w-xl rounded-3xl border border-[#0F1222]/[0.07] bg-white p-6 shadow-[0_24px_60px_-30px_rgba(15,18,34,0.35)] sm:p-8"
        >
          <p className="text-sm font-semibold uppercase tracking-[0.14em] text-[#D23468]">Celebrei com IA</p>
          <p className="mt-3 text-slate-600">a partir de</p>
          <p className="font-grotesque text-5xl font-extrabold tracking-[-0.03em] text-[#0F1222]">
            R$ 999<span className="text-xl font-semibold text-slate-500">/mês</span>
          </p>
          <p className="mt-1 text-sm text-slate-500">por buffet · até 500 conversas com a IA por mês</p>

          <ul className="mt-6 space-y-2.5">
            {INCLUDED.map((item) => (
              <li key={item} className="flex items-start gap-2.5 text-[15px] text-slate-700">
                <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[#10B981]/15">
                  <Check className="h-3 w-3 text-[#0E9F6E]" strokeWidth={3} />
                </span>
                {item}
              </li>
            ))}
          </ul>

          <button type="button" onClick={onOpenWizard} className={`${BTN_PRIMARY} mt-7 w-full`}>
            Agendar demonstração
            <ArrowRight className="h-5 w-5" />
          </button>
          <p className="mt-3 text-center text-xs text-slate-500">
            O valor final depende do número de buffets e do volume de atendimentos.
          </p>
        </motion.div>
      </div>
    </section>
  );
}
