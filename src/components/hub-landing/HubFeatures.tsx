import { useState } from "react";
import { motion } from "framer-motion";
import {
  Bot,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  FileSignature,
  FileText,
  KanbanSquare,
  MessageCircle,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { GRADIENT_TEXT } from "./lp-theme";
import { SectionHeading } from "./LpSection";

/**
 * Recursos principais da plataforma (4 cartões; o resto fica na lista recolhida). A lista completa (59 funcionalidades para
 * o buffet, fora as do Portal Hub) está em src/lib/generateFeaturesPDF.ts.
 * Nomes e números nas mini-telas são ilustrativos.
 */
const MORE = [
  "IA que aponta quem vai fechar",
  "Campanhas e reativação de leads",
  "Painel da festa no celular",
  "Landing page do buffet",
  "Várias unidades num só painel",
  "Confirmação automática de visita",
  "Pré-reservas com prazo",
  "Checklist de cada festa",
  "Lista de presença digital",
  "Cardápio digital",
  "Escala de freelancers",
  "Avaliação pós-festa",
  "Resumo diário com IA",
  "Tempo de resposta por vendedor",
  "Exportação para planilha",
];

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

const item = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" as const } },
};

export default function HubFeatures() {
  const [showAll, setShowAll] = useState(false);
  return (
    <section id="recursos" className="relative scroll-mt-16 bg-white py-14 sm:py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="Recursos"
          title={
            <>
              Tudo que seu buffet precisa, <span className={GRADIENT_TEXT}>num lugar só</span>
            </>
          }
          description="Do primeiro contato no WhatsApp até a festa. Sem planilha, sem caderno, sem lead esquecido."
        />

        {/* No celular os cartões passam de lado (carrossel); no computador, grade 2 × 2 */}
        <motion.div
          variants={container}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-60px" }}
          className="-mx-4 mt-10 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 [scrollbar-width:none] md:mx-0 md:grid md:grid-cols-2 md:gap-5 md:overflow-visible md:px-0 md:pb-0 [&::-webkit-scrollbar]:hidden"
        >
          <Card
            icon={Bot}
            title="Atendente com IA no WhatsApp"
            description="Conversa como gente, 24 horas: tira dúvidas, passa valores, envia fotos e pacotes do buffet e agenda a visita."
          >
            <FlowVisual />
          </Card>

          <Card
            icon={KanbanSquare}
            title="Funil de vendas visual"
            description="Cada lead entra sozinho no funil, com o histórico completo da conversa."
          >
            <KanbanVisual />
          </Card>

          <Card
            icon={CalendarDays}
            title="Agenda de visitas e festas"
            description="Calendário por unidade, pré-reservas com prazo e checklist de cada evento."
          >
            <CalendarVisual />
          </Card>

          <Card
            icon={FileSignature}
            title="Contratos e financeiro"
            description="Contrato gerado com os dados da festa, aceite digital pelo link e controle das parcelas."
          >
            <ContractVisual />
          </Card>
        </motion.div>
        <p className="mt-3 text-center text-xs text-slate-400 md:hidden">Arraste para o lado para ver mais →</p>

        <div className="mt-8 text-center">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
            className="inline-flex items-center gap-1.5 rounded-full border border-[#0F1222]/10 bg-[#FFF9F3] px-5 py-2.5 text-sm font-semibold text-[#0F1222] transition-colors [@media(hover:hover)]:hover:bg-[#FFF3EA]"
          >
            {showAll ? "Ver menos" : `Ver todas as funcionalidades (+${MORE.length})`}
            <ChevronDown className={cn("h-4 w-4 transition-transform", showAll && "rotate-180")} />
          </button>
          {showAll && (
            <ul className="mt-5 flex flex-wrap justify-center gap-2">
              {MORE.map((label) => (
                <li
                  key={label}
                  className="rounded-full border border-[#0F1222]/[0.07] bg-white px-3.5 py-1.5 text-sm text-slate-600"
                >
                  {label}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

interface CardProps {
  icon: React.ElementType;
  title: string;
  description: string;
  className?: string;
  children: React.ReactNode;
}

function Card({ icon: Icon, title, description, className, children }: CardProps) {
  return (
    <motion.div
      variants={item}
      className={cn(
        "group flex w-[85%] shrink-0 snap-center flex-col overflow-hidden rounded-3xl border border-[#0F1222]/[0.07] bg-[#FCFAF8] transition-shadow duration-300 [@media(hover:hover)]:hover:shadow-[0_24px_50px_-30px_rgba(15,18,34,0.35)] md:w-auto",
        className,
      )}
    >
      <div className="p-6 pb-0 sm:p-7 sm:pb-0">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white shadow-sm ring-1 ring-[#0F1222]/[0.06]">
          <Icon className="h-5 w-5 text-[#E0457A]" />
        </div>
        <h3 className="mt-4 font-grotesque text-xl font-bold tracking-tight text-[#0F1222]">{title}</h3>
        <p className="mt-2 text-[15px] leading-relaxed text-slate-600">{description}</p>
      </div>
      <div className="mt-auto px-6 pb-6 pt-6 sm:px-7 sm:pb-7">{children}</div>
    </motion.div>
  );
}

const panel = "rounded-2xl border border-[#0F1222]/[0.06] bg-white p-3 shadow-[0_10px_30px_-20px_rgba(15,18,34,0.35)]";

function FlowVisual() {
  const nodes = [
    { icon: MessageCircle, label: "Chega a mensagem", tone: "bg-[#10B981]/[0.12] text-[#0E9F6E]" },
    { icon: Bot, label: "Pergunta a data da festa", tone: "bg-[#FFC93C]/25 text-[#B7791F]" },
    { icon: FileText, label: "Envia os pacotes", tone: "bg-[#F0457A]/[0.12] text-[#D23468]" },
    { icon: CalendarDays, label: "Agenda a visita", tone: "bg-[#8E3FD9]/[0.12] text-[#7B33C4]" },
  ];
  return (
    <div className={cn(panel, "p-4")}>
      <div className="grid gap-2 sm:grid-cols-4 sm:gap-3">
        {nodes.map((n, i) => (
          <div
            key={n.label}
            className="relative flex items-center gap-3 rounded-xl border border-[#0F1222]/[0.06] bg-[#FCFAF8] px-3 py-2.5 sm:flex-col sm:items-start sm:gap-3 sm:p-3.5"
          >
            <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg sm:h-9 sm:w-9", n.tone)}>
              <n.icon className="h-4 w-4" />
            </span>
            <span className="text-[13px] font-medium leading-snug text-slate-700">
              <span className="mr-1 text-slate-400">{i + 1}.</span>
              {n.label}
            </span>
            {i < nodes.length - 1 && (
              <ChevronRight className="absolute -right-[13px] top-1/2 z-10 hidden h-4 w-4 -translate-y-1/2 rounded-full bg-white text-slate-400 shadow-sm ring-1 ring-[#0F1222]/[0.06] sm:block" />
            )}
          </div>
        ))}
      </div>
      <p className="mt-3 flex items-center gap-1.5 border-t border-slate-100 pt-3 text-[12px] text-slate-500">
        <Sparkles className="h-3.5 w-3.5 text-[#F0457A]" />
        Tudo em segundos, inclusive de madrugada e no fim de semana
      </p>
    </div>
  );
}

function KanbanVisual() {
  const cols = [
    { title: "Novos", color: "bg-[#38BDF8]", cards: [["Mariana", "14/12"], ["Paulo", "21/12"]] },
    { title: "Visita", color: "bg-[#FFC93C]", cards: [["Carla", "07/12"]] },
    { title: "Fechado", color: "bg-[#10B981]", cards: [["Bruna", "30/11"]] },
  ];
  return (
    <div className={cn(panel, "grid grid-cols-3 gap-2")}>
      {cols.map((c) => (
        <div key={c.title} className="rounded-xl bg-[#FCFAF8] p-2">
          <div className="mb-2 flex items-center gap-1.5">
            <span className={cn("h-1.5 w-1.5 rounded-full", c.color)} />
            <span className="text-[11px] font-semibold text-slate-500">{c.title}</span>
          </div>
          <div className="space-y-1.5">
            {c.cards.map(([name, date]) => (
              <div key={name} className="rounded-lg border border-[#0F1222]/[0.06] bg-white px-2 py-1.5">
                <p className="truncate text-[11px] font-semibold text-slate-700">{name}</p>
                <p className="text-[10px] text-slate-400">Festa {date}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function CalendarVisual() {
  const marks: Record<number, string> = { 3: "bg-[#F0457A]", 7: "bg-[#FFC93C]", 13: "bg-[#8E3FD9]", 14: "bg-[#F0457A]", 20: "bg-[#38BDF8]", 21: "bg-[#FFC93C]", 27: "bg-[#F0457A]", 28: "bg-[#8E3FD9]" };
  return (
    <div className={panel}>
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-[12px] font-semibold text-slate-700">Dezembro</span>
        <span className="text-[11px] text-slate-400">8 festas</span>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
          <div
            key={d}
            className={cn(
              "relative flex aspect-square items-center justify-center rounded-md text-[10.5px]",
              marks[d] ? "bg-[#FFF3EA] font-semibold text-slate-700" : "text-slate-400",
            )}
          >
            {d}
            {marks[d] && <span className={cn("absolute bottom-0.5 h-1 w-1 rounded-full", marks[d])} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function ContractVisual() {
  return (
    <div className={cn(panel, "space-y-3")}>
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-8 items-center justify-center rounded-md bg-[#0F1222] text-white">
          <FileSignature className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold text-slate-700">Contrato · Festa da Alice</p>
          <p className="text-[11px] text-slate-400">Enviado pelo WhatsApp</p>
        </div>
        <span className="rounded-full bg-[#10B981]/[0.12] px-2 py-0.5 text-[10.5px] font-semibold text-[#0E9F6E]">Assinado</span>
      </div>
      <div>
        <div className="mb-1.5 flex justify-between text-[11px] text-slate-500">
          <span>Parcelas pagas</span>
          <span className="font-semibold text-slate-700">2 de 3</span>
        </div>
        <div className="grid grid-cols-3 gap-1">
          <span className="h-2 rounded-full bg-[#10B981]" />
          <span className="h-2 rounded-full bg-[#10B981]" />
          <span className="h-2 rounded-full bg-slate-100" />
        </div>
      </div>
    </div>
  );
}
