import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  DollarSign, 
  CheckCircle2, 
  Target, 
  MessageSquare,
  BarChart3,
  Users,
  Zap,
  Shield,
  Smartphone,
  Clock,
  TrendingUp,
  FileText,
  Copy,
  Check,
  Phone,
  Monitor
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { ProposalGenerator } from "@/components/admin/ProposalGenerator";
import { B2BLeadsManager } from "@/components/admin/B2BLeadsManager";

import { HubLayout } from "@/components/hub/HubLayout";

const ComercialB2B = () => {
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [lpViewMode, setLpViewMode] = useState<'desktop' | 'mobile'>('desktop');

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(label);
    toast.success("Copiado para a área de transferência!");
    setTimeout(() => setCopiedText(null), 2000);
  };
 
   const pitchText = `🎯 Transforme visitantes em contratos fechados — sem perder nenhum lead no WhatsApp.
 
 Sua equipe comercial perde leads no WhatsApp? Cada vendedor usa o próprio celular? Você não sabe quantos orçamentos viraram contratos?
 
 Nossa plataforma resolve isso:
 ✅ Central de WhatsApp unificada
 ✅ CRM visual com Kanban
 ✅ Landing pages de campanha prontas
 ✅ Atendente com IA no WhatsApp, 24 horas: passa valores, consulta a agenda e marca visita
 ✅ Notificações em tempo real
 ✅ Relatórios e métricas
 
 Feito especialmente para buffets infantis. Agende uma demonstração!`;
 
  const header = (
    <div>
      <h1 className="text-xl font-display font-bold text-foreground">Comercial B2B</h1>
    </div>
  );

  return (
    <HubLayout currentPage="comercial-b2b" header={header}>
      {() => (
        <div className="max-w-6xl mx-auto px-1 sm:px-0">
 
             {/* Tabs */}
              <Tabs defaultValue="leads" className="space-y-4 sm:space-y-6">
                <div className="w-full overflow-x-auto pb-1">
                  <TabsList className="inline-flex h-auto w-max min-w-full p-1 gap-1">
                    <TabsTrigger value="leads" className="flex items-center gap-2 py-3 px-3 shrink-0">
                      <Users className="h-4 w-4" />
                      <span>Leads</span>
                    </TabsTrigger>
                    <TabsTrigger value="pitch" className="flex items-center gap-2 py-3 px-3 shrink-0">
                      <Target className="h-4 w-4" />
                      <span className="hidden sm:inline">Pitch de Vendas</span>
                      <span className="sm:hidden">Pitch</span>
                    </TabsTrigger>
                    <TabsTrigger value="features" className="flex items-center gap-2 py-3 px-3 shrink-0">
                      <Zap className="h-4 w-4" />
                      <span className="hidden sm:inline">Funcionalidades</span>
                      <span className="sm:hidden">Features</span>
                    </TabsTrigger>
                    <TabsTrigger value="pricing" className="flex items-center gap-2 py-3 px-3 shrink-0">
                      <DollarSign className="h-4 w-4" />
                      <span className="hidden sm:inline">Precificação</span>
                      <span className="sm:hidden">Preços</span>
                    </TabsTrigger>
                    <TabsTrigger value="scripts" className="flex items-center gap-2 py-3 px-3 shrink-0">
                      <Phone className="h-4 w-4" />
                      <span>Scripts</span>
                    </TabsTrigger>
                    <TabsTrigger value="proposals" className="flex items-center gap-2 py-3 px-3 shrink-0">
                      <FileText className="h-4 w-4" />
                      <span className="hidden sm:inline">Propostas</span>
                      <span className="sm:hidden">PDF</span>
                    </TabsTrigger>
                    <TabsTrigger value="objections" className="flex items-center gap-2 py-3 px-3 shrink-0">
                      <MessageSquare className="h-4 w-4" />
                      <span className="hidden sm:inline">Objeções</span>
                      <span className="sm:hidden">FAQ</span>
                    </TabsTrigger>
                    <TabsTrigger value="landing" className="flex items-center gap-2 py-3 px-3 shrink-0">
                      <Smartphone className="h-4 w-4" />
                      <span className="hidden sm:inline">Landing Page</span>
                      <span className="sm:hidden">LP</span>
                    </TabsTrigger>
                  </TabsList>
                </div>
 
               {/* Leads Tab */}
               <TabsContent value="leads" className="space-y-4 sm:space-y-6">
                 <B2BLeadsManager />
               </TabsContent>

               {/* Pitch Tab */}
               <TabsContent value="pitch" className="space-y-6">
                 {/* Headline */}
                 <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
                   <CardHeader>
                     <CardTitle className="text-2xl">🎯 Headline Principal</CardTitle>
                   </CardHeader>
                   <CardContent>
                     <blockquote className="text-xl md:text-2xl font-bold text-foreground border-l-4 border-primary pl-4">
                       "Transforme visitantes em contratos fechados — sem perder nenhum lead no WhatsApp."
                     </blockquote>
                   </CardContent>
                 </Card>
 
                 {/* Problem */}
                 <Card>
                   <CardHeader>
                     <CardTitle className="flex items-center gap-2">
                       <Target className="h-5 w-5 text-destructive" />
                       O Problema (Dor do Cliente)
                     </CardTitle>
                   </CardHeader>
                   <CardContent>
                     <ul className="space-y-3">
                       {[
                         "Leads chegam pelo WhatsApp e se perdem na bagunça de mensagens",
                         "Não sabe quais clientes estão quentes ou frios",
                         "Equipe comercial sem controle — cada um usa o próprio celular",
                         "Promoções divulgadas de forma amadora, sem landing page profissional",
                         "Zero visibilidade de métricas: quantos leads chegaram? Quantos fecharam?",
                       ].map((item, index) => (
                         <li key={index} className="flex items-start gap-3">
                           <span className="text-destructive font-bold">✗</span>
                           <span className="text-muted-foreground">{item}</span>
                         </li>
                       ))}
                     </ul>
                   </CardContent>
                 </Card>
 
                 {/* Solution */}
                 <Card>
                   <CardHeader>
                     <CardTitle className="flex items-center gap-2">
                       <CheckCircle2 className="h-5 w-5 text-accent" />
                       A Solução (Nossa Plataforma)
                     </CardTitle>
                   </CardHeader>
                   <CardContent>
                     <div className="grid md:grid-cols-2 gap-4">
                       {[
                         { icon: "🎪", title: "Landing Pages de Campanha", desc: "Páginas profissionais prontas em minutos. Troque a promoção, os textos e pronto — nova campanha no ar." },
                         { icon: "💬", title: "Central de WhatsApp", desc: "Todas as conversas em um só lugar. Sua equipe responde do computador, com histórico completo." },
                         { icon: "🤖", title: "Atendente com IA", desc: "Conversa como uma pessoa, 24 horas: tira dúvidas, passa valores, consulta a agenda e marca a visita — e chama de volta quem parou de responder." },
                         { icon: "📊", title: "CRM Kanban", desc: "Visualize cada lead em colunas: Novo → Em Contato → Orçamento → Fechado. Arraste e solte." },
                         { icon: "👥", title: "Multi-usuário", desc: "Admin, comercial, visualização. Cada um vê só o que precisa." },
                         { icon: "🔔", title: "Notificações em Tempo Real", desc: "Novo lead? Você é avisado na hora. Nunca mais perca oportunidade." },
                       ].map((item, index) => (
                         <div key={index} className="flex gap-3 p-4 rounded-lg bg-muted/50">
                           <span className="text-2xl">{item.icon}</span>
                           <div>
                             <h4 className="font-semibold text-foreground">{item.title}</h4>
                             <p className="text-sm text-muted-foreground">{item.desc}</p>
                           </div>
                         </div>
                       ))}
                     </div>
                   </CardContent>
                 </Card>
 
                 {/* Copy Pitch */}
                 <Card>
                   <CardHeader>
                     <div className="flex items-center justify-between">
                       <CardTitle className="flex items-center gap-2">
                         <FileText className="h-5 w-5" />
                         Texto para Copiar
                       </CardTitle>
                       <Button 
                         variant="outline" 
                         size="sm"
                         onClick={() => copyToClipboard(pitchText, "pitch")}
                       >
                         {copiedText === "pitch" ? (
                           <Check className="h-4 w-4 mr-2" />
                         ) : (
                           <Copy className="h-4 w-4 mr-2" />
                         )}
                         Copiar
                       </Button>
                     </div>
                   </CardHeader>
                   <CardContent>
                     <pre className="whitespace-pre-wrap text-sm text-muted-foreground bg-muted p-4 rounded-lg">
                       {pitchText}
                     </pre>
                   </CardContent>
                 </Card>
               </TabsContent>
 
               {/* Features Tab */}
               <TabsContent value="features" className="space-y-6">
                 <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                   {[
                     { icon: MessageSquare, title: "WhatsApp Integrado", desc: "Envie texto, áudio, imagem, vídeo e documentos direto da plataforma", badge: "Core" },
                     { icon: BarChart3, title: "CRM Visual", desc: "Kanban drag-and-drop para gestão de leads com status personalizados", badge: "Core" },
                     { icon: Zap, title: "Landing Pages", desc: "Páginas de campanha profissionais com gatilhos de urgência", badge: "Core" },
                     { icon: Users, title: "Multi-usuário", desc: "Controle de acesso por função: admin, comercial, visualização", badge: "Core" },
                     { icon: Shield, title: "Atendente com IA", desc: "Atende 24h no WhatsApp: dúvidas, valores, datas livres e agendamento de visita", badge: "IA" },
                     { icon: Smartphone, title: "100% Responsivo", desc: "Funciona perfeitamente em desktop, tablet e celular", badge: "UX" },
                     { icon: Clock, title: "Tempo Real", desc: "Notificações instantâneas de novos leads e mensagens", badge: "Core" },
                     { icon: TrendingUp, title: "Métricas", desc: "Dashboard com KPIs: leads, conversões, tempo de resposta", badge: "Analytics" },
                     { icon: FileText, title: "Exportação", desc: "Exporte leads para CSV a qualquer momento", badge: "Utilitário" },
                   ].map((feature, index) => (
                     <Card key={index} className="hover:border-primary/30 transition-colors">
                       <CardHeader className="pb-2">
                         <div className="flex items-start justify-between">
                           <div className="p-2 rounded-lg bg-primary/10">
                             <feature.icon className="h-5 w-5 text-primary" />
                           </div>
                           <Badge variant="secondary" className="text-xs">
                             {feature.badge}
                           </Badge>
                         </div>
                         <CardTitle className="text-lg">{feature.title}</CardTitle>
                       </CardHeader>
                       <CardContent>
                         <p className="text-sm text-muted-foreground">{feature.desc}</p>
                       </CardContent>
                     </Card>
                   ))}
                 </div>
 
                 {/* Differentiators */}
                 <Card className="border-secondary/30 bg-gradient-to-br from-secondary/5 to-transparent">
                   <CardHeader>
                     <CardTitle>🏆 Diferenciais Competitivos</CardTitle>
                   </CardHeader>
                   <CardContent>
                     <div className="grid md:grid-cols-2 gap-4">
                       {[
                         { title: "Feito para Buffets", desc: "Não é um CRM genérico. Campos como 'unidade', 'mês da festa', 'dia da semana' já vêm prontos." },
                         { title: "WhatsApp Nativo", desc: "Integração real com WhatsApp Business — não é apenas um redirecionador de links." },
                         { title: "Landing Pages que Convertem", desc: "Design profissional, responsivo, com gatilhos de urgência e contagem regressiva." },
                         { title: "Sem Instalação", desc: "100% na nuvem. Acesse de qualquer dispositivo, a qualquer hora." },
                       ].map((item, index) => (
                         <div key={index} className="flex items-start gap-3">
                           <CheckCircle2 className="h-5 w-5 text-secondary shrink-0 mt-0.5" />
                           <div>
                             <h4 className="font-semibold text-foreground">{item.title}</h4>
                             <p className="text-sm text-muted-foreground">{item.desc}</p>
                           </div>
                         </div>
                       ))}
                     </div>
                   </CardContent>
                 </Card>
               </TabsContent>
 
               {/* Pricing Tab */}
               <TabsContent value="pricing" className="space-y-6">
                 <Card>
                   <CardHeader>
                     <CardTitle>💰 Modelo de Precificação Sugerido</CardTitle>
                     <CardDescription>
                       Plano único com IA — o plano só com chatbot não é mais vendido
                     </CardDescription>
                   </CardHeader>
                   <CardContent>
                    {/* Plano único com IA (out/2026): o plano só com chatbot não é mais vendido */}
                    <div className="grid lg:grid-cols-2 gap-6">
                      <Card className="border-2 border-primary relative">
                        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                          <Badge className="bg-primary">Plano único</Badge>
                        </div>
                        <CardHeader className="text-center pb-2 pt-6">
                          <Badge variant="outline" className="w-fit mx-auto mb-2">Celebrei com IA</Badge>
                          <CardTitle className="text-3xl">R$ 1.299</CardTitle>
                          <CardDescription>/mês por buffet (valor de tabela)</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          {[
                            "Atendente com IA no WhatsApp, 24 horas",
                            "Até 500 conversas com a IA por mês",
                            "Passa valores, consulta a agenda e marca visita",
                            "Lembretes automáticos para quem parou de responder",
                            "CRM completo com funil de vendas",
                            "Agenda de visitas e festas",
                            "Contratos com assinatura digital e financeiro",
                            "Formulários, cardápio e avaliação pós-festa",
                            "Campanhas com mensagens e artes feitas pela IA",
                            "Implantação e treinamento por vídeo chamada",
                          ].map((item, index) => (
                            <div key={index} className="flex items-center gap-2 text-sm">
                              <CheckCircle2 className="h-4 w-4 text-primary" />
                              <span>{item}</span>
                            </div>
                          ))}
                          <p className="text-xs text-muted-foreground pt-2">
                            No site aparece "a partir de R$ 999/mês". As 500 conversas são referência de uso, não bloqueio:
                            se o buffet passar disso todo mês, converse sobre reajuste.
                          </p>
                        </CardContent>
                      </Card>

                      <Card className="border-2">
                        <CardHeader>
                          <CardTitle className="text-xl">🤝 Como negociar</CardTitle>
                          <CardDescription>Tabela de R$ 1.299; o mínimo é por volta de R$ 999</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3 text-sm">
                          <p>Dê o desconto sempre com um motivo, para a tabela continuar valendo para os próximos clientes:</p>
                          {[
                            "Contrato de 12 meses",
                            "Mais de um buffet (ex.: 2 buffets por R$ 1.999 no total)",
                            "Condição de lançamento para os primeiros clientes",
                            "Buffet pequeno (poucos leads por mês): pode chegar ao mínimo",
                          ].map((item, index) => (
                            <div key={index} className="flex items-center gap-2">
                              <CheckCircle2 className="h-4 w-4 text-accent" />
                              <span>{item}</span>
                            </div>
                          ))}
                          <div className="bg-muted p-3 rounded-lg text-xs text-muted-foreground">
                            <strong className="text-foreground">Custo da IA para a Celebrei:</strong> por volta de R$ 0,30 a R$ 0,60 por
                            conversa — até 500 conversas, no máximo uns R$ 300 por buffet/mês. Mesmo no valor mínimo sobra margem.
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                   </CardContent>
                 </Card>
 
                 {/* ROI Calculator */}
                 <Card>
                   <CardHeader>
                     <CardTitle>📊 Argumento de ROI</CardTitle>
                   </CardHeader>
                   <CardContent>
                     <div className="bg-muted p-4 rounded-lg space-y-3">
                       <p className="text-sm text-muted-foreground">
                         <strong className="text-foreground">Cenário:</strong> Buffet fecha em média 10 festas/mês a R$ 3.000 cada = R$ 30.000/mês
                       </p>
                       <p className="text-sm text-muted-foreground">
                         <strong className="text-foreground">Problema:</strong> Perdem ~20% dos leads por falta de follow-up = R$ 6.000 perdidos
                       </p>
                       <p className="text-sm text-muted-foreground">
                         <strong className="text-foreground">Com a IA:</strong> atende na hora, 24h, e chama de volta quem sumiu — recuperar metade = +R$ 3.000/mês
                       </p>
                       <div className="pt-2 border-t border-border">
                         <p className="font-bold text-foreground">
                           ROI: Investimento de R$ 1.299 → Retorno de R$ 3.000 = <span className="text-accent">mais de 2x de retorno</span> — uma festa a mais por mês já paga a plataforma
                         </p>
                       </div>
                     </div>
                   </CardContent>
                 </Card>
               </TabsContent>
 
               {/* Objections Tab */}
               {/* Scripts Tab */}
               <TabsContent value="scripts" className="space-y-6">
                 {/* Cold Call */}
                 <Card>
                   <CardHeader>
                     <div className="flex items-center justify-between">
                       <div>
                         <Badge className="mb-2 bg-blue-500">Primeiro Contato</Badge>
                         <CardTitle className="flex items-center gap-2">
                           <Phone className="h-5 w-5" />
                           Script de Ligação Fria
                         </CardTitle>
                         <CardDescription>Para prospecção ativa de novos buffets</CardDescription>
                       </div>
                       <Button 
                         variant="outline" 
                         size="sm"
                         onClick={() => copyToClipboard(`SCRIPT: LIGAÇÃO FRIA

[ABERTURA - 10 segundos]
"Oi, [NOME]? Aqui é o [SEU NOME]. Tudo bem? Consegue falar 2 minutinhos?"

[CONTEXTO - 15 segundos]
"Ótimo! Eu trabalho com uma plataforma de gestão comercial feita especialmente para buffets infantis. Estou ligando porque vi que vocês têm um espaço muito bonito e queria entender como vocês gerenciam os leads que chegam pelo WhatsApp."

[PERGUNTA DE DOR - aguarde resposta]
"Hoje vocês usam o WhatsApp no celular mesmo? Cada vendedor no seu?"

[APROFUNDAR A DOR]
Se SIM: "Entendi. E você consegue saber quantos leads chegaram no mês e quantos viraram contrato?"
Se NÃO: "Interessante! E como vocês controlam o funil de vendas?"

[PONTE PARA SOLUÇÃO]
"Faz sentido. A gente desenvolveu uma plataforma que centraliza todas as conversas de WhatsApp, cria um CRM visual tipo Kanban, e ainda gera landing pages de campanha prontas. Tudo pensado para buffet."

[CTA]
"Posso te mostrar em 15 minutos como funciona? Sem compromisso, só pra você ver se faz sentido pro seu negócio."

[OBJEÇÕES COMUNS]
• "Não tenho tempo agora" → "Sem problema! Qual o melhor dia e horário essa semana?"
• "Já uso outras ferramentas" → "Perfeito! A demo serve justamente pra você comparar. 15 minutos vale a pena?"
• "Manda por email" → "Claro! Mas o sistema é visual, funciona muito melhor ver ao vivo. Posso marcar 15 min amanhã?"`, "cold-call")}
                       >
                         {copiedText === "cold-call" ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
                         Copiar
                       </Button>
                     </div>
                   </CardHeader>
                   <CardContent className="space-y-4">
                     <div className="bg-blue-50 dark:bg-blue-950/30 p-4 rounded-lg border border-blue-200 dark:border-blue-800">
                       <h4 className="font-semibold text-foreground mb-2">📞 ABERTURA (10 segundos)</h4>
                       <p className="text-muted-foreground italic">"Oi, [NOME]? Aqui é o [SEU NOME]. Tudo bem? Consegue falar 2 minutinhos?"</p>
                     </div>
                     
                     <div className="bg-muted/50 p-4 rounded-lg">
                       <h4 className="font-semibold text-foreground mb-2">🎯 CONTEXTO (15 segundos)</h4>
                       <p className="text-muted-foreground italic">"Ótimo! Eu trabalho com uma plataforma de gestão comercial feita especialmente para buffets infantis. Estou ligando porque vi que vocês têm um espaço muito bonito e queria entender como vocês gerenciam os leads que chegam pelo WhatsApp."</p>
                     </div>
                     
                     <div className="bg-destructive/10 p-4 rounded-lg border border-destructive/20">
                       <h4 className="font-semibold text-foreground mb-2">❓ PERGUNTA DE DOR</h4>
                       <p className="text-muted-foreground italic">"Hoje vocês usam o WhatsApp no celular mesmo? Cada vendedor no seu?"</p>
                       <div className="mt-3 space-y-2 text-sm">
                         <p><strong>Se SIM:</strong> "Entendi. E você consegue saber quantos leads chegaram no mês e quantos viraram contrato?"</p>
                         <p><strong>Se NÃO:</strong> "Interessante! E como vocês controlam o funil de vendas?"</p>
                       </div>
                     </div>
                     
                     <div className="bg-accent/10 p-4 rounded-lg border border-accent/20">
                       <h4 className="font-semibold text-foreground mb-2">🌉 PONTE PARA SOLUÇÃO</h4>
                       <p className="text-muted-foreground italic">"Faz sentido. A gente desenvolveu uma plataforma que centraliza todas as conversas de WhatsApp, cria um CRM visual tipo Kanban, e ainda gera landing pages de campanha prontas. Tudo pensado para buffet."</p>
                     </div>
                     
                     <div className="bg-primary/10 p-4 rounded-lg border border-primary/20">
                       <h4 className="font-semibold text-foreground mb-2">🎯 CALL-TO-ACTION</h4>
                       <p className="text-muted-foreground italic">"Posso te mostrar em 15 minutos como funciona? Sem compromisso, só pra você ver se faz sentido pro seu negócio."</p>
                     </div>
                   </CardContent>
                 </Card>

                 {/* Follow-up Call */}
                 <Card>
                   <CardHeader>
                     <div className="flex items-center justify-between">
                       <div>
                         <Badge className="mb-2 bg-amber-500">Seguimento</Badge>
                         <CardTitle className="flex items-center gap-2">
                           <Phone className="h-5 w-5" />
                           Script de Follow-up
                         </CardTitle>
                         <CardDescription>Para retomar contato após demo ou proposta</CardDescription>
                       </div>
                       <Button 
                         variant="outline" 
                         size="sm"
                         onClick={() => copyToClipboard(`SCRIPT: FOLLOW-UP PÓS-DEMO

[ABERTURA]
"Oi [NOME], tudo bem? Aqui é o [SEU NOME]. Estou ligando pra saber o que você achou da demonstração que fizemos [DIA]."

[ESCUTA ATIVA - deixe falar]

[SE POSITIVO]
"Que bom que gostou! Você teve alguma dúvida depois? Conversou com alguém da equipe sobre?"

[SE NEUTRO/INDECISO]
"Entendo. O que ficou faltando pra você sentir que faz sentido? Posso esclarecer algum ponto?"

[SE NEGATIVO]
"Agradeço a sinceridade. Posso perguntar o que pesou na decisão? Isso me ajuda a melhorar."

[CRIAR URGÊNCIA]
"Olha, [NOME], essa semana ainda consigo manter as condições que te passei. Você consegue dar uma resposta até [DATA]?"

[FECHAMENTO]
"Perfeito! Então fico no aguardo. Qualquer dúvida, pode me chamar no WhatsApp. Até mais!"`, "follow-up")}
                       >
                         {copiedText === "follow-up" ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
                         Copiar
                       </Button>
                     </div>
                   </CardHeader>
                   <CardContent className="space-y-4">
                     <div className="bg-amber-50 dark:bg-amber-950/30 p-4 rounded-lg border border-amber-200 dark:border-amber-800">
                       <h4 className="font-semibold text-foreground mb-2">📞 ABERTURA</h4>
                       <p className="text-muted-foreground italic">"Oi [NOME], tudo bem? Aqui é o [SEU NOME]. Estou ligando pra saber o que você achou da demonstração que fizemos [DIA]."</p>
                     </div>
                     
                     <div className="grid md:grid-cols-3 gap-4">
                       <div className="bg-accent/10 p-4 rounded-lg">
                         <h4 className="font-semibold text-accent text-sm mb-2">✅ SE POSITIVO</h4>
                         <p className="text-sm text-muted-foreground italic">"Que bom que gostou! Você teve alguma dúvida depois? Conversou com alguém da equipe sobre?"</p>
                       </div>
                       <div className="bg-amber-100 dark:bg-amber-900/30 p-4 rounded-lg">
                         <h4 className="font-semibold text-amber-600 dark:text-amber-400 text-sm mb-2">🤔 SE NEUTRO</h4>
                         <p className="text-sm text-muted-foreground italic">"Entendo. O que ficou faltando pra você sentir que faz sentido? Posso esclarecer algum ponto?"</p>
                       </div>
                       <div className="bg-destructive/10 p-4 rounded-lg">
                         <h4 className="font-semibold text-destructive text-sm mb-2">❌ SE NEGATIVO</h4>
                         <p className="text-sm text-muted-foreground italic">"Agradeço a sinceridade. Posso perguntar o que pesou na decisão? Isso me ajuda a melhorar."</p>
                       </div>
                     </div>
                     
                     <div className="bg-primary/10 p-4 rounded-lg border border-primary/20">
                       <h4 className="font-semibold text-foreground mb-2">⏰ CRIAR URGÊNCIA</h4>
                       <p className="text-muted-foreground italic">"Olha, [NOME], essa semana ainda consigo manter as condições que te passei. Você consegue dar uma resposta até [DATA]?"</p>
                     </div>
                   </CardContent>
                 </Card>

                 {/* Demo Scheduling */}
                 <Card>
                   <CardHeader>
                     <div className="flex items-center justify-between">
                       <div>
                         <Badge className="mb-2 bg-green-500">Agendamento</Badge>
                         <CardTitle className="flex items-center gap-2">
                           <Phone className="h-5 w-5" />
                           Script para Agendar Demo
                         </CardTitle>
                         <CardDescription>Para converter interesse em reunião agendada</CardDescription>
                       </div>
                       <Button 
                         variant="outline" 
                         size="sm"
                         onClick={() => copyToClipboard(`SCRIPT: AGENDAR DEMONSTRAÇÃO

[ABERTURA - após qualificação inicial]
"[NOME], pelo que você me contou, acho que nossa plataforma pode resolver exatamente esse problema de [PROBLEMA IDENTIFICADO]. Que tal marcarmos 15 minutos pra eu te mostrar na prática?"

[VENCER RESISTÊNCIA]
• "Não precisa instalar nada" → "É tudo pelo navegador, compartilho minha tela"
• "Não tenho tempo" → "São só 15 minutos, você vê o sistema real funcionando"
• "Manda um vídeo" → "Tenho vídeo sim, mas ao vivo você pode tirar dúvidas na hora"

[OFERECER OPÇÕES]
"Você prefere amanhã de manhã ou à tarde? Tenho horário às [HORA 1] e às [HORA 2]."

[CONFIRMAR]
"Perfeito! Vou te mandar um convite por WhatsApp com o link da reunião. Seu número é esse mesmo que está aqui?"

[REFORÇAR]
"Ótimo, [NOME]! Amanhã às [HORA] então. Te mando o link agora. Qualquer coisa me avisa por WhatsApp. Até amanhã!"

[PÓS-LIGAÇÃO]
→ Enviar link da reunião por WhatsApp
→ Enviar lembrete no dia (manhã)
→ Preparar demo personalizada`, "demo-scheduling")}
                       >
                         {copiedText === "demo-scheduling" ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
                         Copiar
                       </Button>
                     </div>
                   </CardHeader>
                   <CardContent className="space-y-4">
                     <div className="bg-green-50 dark:bg-green-950/30 p-4 rounded-lg border border-green-200 dark:border-green-800">
                       <h4 className="font-semibold text-foreground mb-2">📞 ABERTURA</h4>
                       <p className="text-muted-foreground italic">"[NOME], pelo que você me contou, acho que nossa plataforma pode resolver exatamente esse problema de [PROBLEMA]. Que tal marcarmos 15 minutos pra eu te mostrar na prática?"</p>
                     </div>
                     
                     <div className="bg-muted/50 p-4 rounded-lg">
                       <h4 className="font-semibold text-foreground mb-3">🛡️ VENCER RESISTÊNCIA</h4>
                       <div className="space-y-2 text-sm">
                         <p><strong>"Não precisa instalar nada"</strong> → "É tudo pelo navegador, compartilho minha tela"</p>
                         <p><strong>"Não tenho tempo"</strong> → "São só 15 minutos, você vê o sistema real funcionando"</p>
                         <p><strong>"Manda um vídeo"</strong> → "Tenho vídeo sim, mas ao vivo você pode tirar dúvidas na hora"</p>
                       </div>
                     </div>
                     
                     <div className="bg-primary/10 p-4 rounded-lg border border-primary/20">
                       <h4 className="font-semibold text-foreground mb-2">📅 OFERECER OPÇÕES</h4>
                       <p className="text-muted-foreground italic">"Você prefere amanhã de manhã ou à tarde? Tenho horário às [HORA 1] e às [HORA 2]."</p>
                     </div>
                     
                     <div className="bg-accent/10 p-4 rounded-lg">
                       <h4 className="font-semibold text-foreground mb-2">✅ PÓS-LIGAÇÃO</h4>
                       <ul className="text-sm text-muted-foreground space-y-1">
                         <li>→ Enviar link da reunião por WhatsApp</li>
                         <li>→ Enviar lembrete no dia (manhã)</li>
                         <li>→ Preparar demo personalizada</li>
                       </ul>
                     </div>
                   </CardContent>
                 </Card>

                 {/* Closing Call */}
                 <Card>
                   <CardHeader>
                     <div className="flex items-center justify-between">
                       <div>
                         <Badge className="mb-2 bg-purple-500">Fechamento</Badge>
                         <CardTitle className="flex items-center gap-2">
                           <Phone className="h-5 w-5" />
                           Script de Fechamento
                         </CardTitle>
                         <CardDescription>Para converter proposta em contrato assinado</CardDescription>
                       </div>
                       <Button 
                         variant="outline" 
                         size="sm"
                         onClick={() => copyToClipboard(`SCRIPT: FECHAMENTO

[ABERTURA]
"Oi [NOME]! Tudo bem? Estou ligando porque vi que você já teve a demonstração e recebeu a proposta. Queria saber se ficou alguma dúvida?"

[ESCUTA ATIVA]
Deixe o prospect falar. Anote objeções.

[RESUMO DE VALOR]
"Só pra recapitular: com a plataforma você vai ter [BENEFÍCIO 1], [BENEFÍCIO 2] e [BENEFÍCIO 3]. Tudo isso por [VALOR]/mês."

[PERGUNTA DE FECHAMENTO]
"O que você precisa pra gente começar essa semana?"

[TÉCNICAS DE FECHAMENTO]

1. ALTERNATIVA:
"Você prefere começar com o plano mensal ou já aproveitar o desconto do anual?"

2. URGÊNCIA:
"Essa condição especial é válida até [DATA]. Depois volta ao preço cheio."

3. REVERSÃO DE RISCO:
"Lembra que não tem fidelidade? Se não gostar, cancela no mês seguinte. Zero risco."

4. PRÓXIMO PASSO:
"Posso te mandar o contrato agora pra você assinar digitalmente? Leva 2 minutos."

[SE FECHAR]
"Perfeito, [NOME]! Parabéns pela decisão! Vou te mandar o contrato agora e já agendo seu onboarding pra [DATA]. Bem-vindo!"

[SE NÃO FECHAR]
"Entendo. Posso te ligar [DIA] pra fecharmos? Assim você tem tempo de pensar."`, "closing")}
                       >
                         {copiedText === "closing" ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
                         Copiar
                       </Button>
                     </div>
                   </CardHeader>
                   <CardContent className="space-y-4">
                     <div className="bg-purple-50 dark:bg-purple-950/30 p-4 rounded-lg border border-purple-200 dark:border-purple-800">
                       <h4 className="font-semibold text-foreground mb-2">📞 ABERTURA</h4>
                       <p className="text-muted-foreground italic">"Oi [NOME]! Tudo bem? Estou ligando porque vi que você já teve a demonstração e recebeu a proposta. Queria saber se ficou alguma dúvida?"</p>
                     </div>
                     
                     <div className="bg-muted/50 p-4 rounded-lg">
                       <h4 className="font-semibold text-foreground mb-2">💎 RESUMO DE VALOR</h4>
                       <p className="text-muted-foreground italic">"Só pra recapitular: com a plataforma você vai ter [BENEFÍCIO 1], [BENEFÍCIO 2] e [BENEFÍCIO 3]. Tudo isso por [VALOR]/mês."</p>
                     </div>
                     
                     <div className="bg-primary/10 p-4 rounded-lg border border-primary/20">
                       <h4 className="font-semibold text-foreground mb-2">🎯 PERGUNTA DE FECHAMENTO</h4>
                       <p className="text-muted-foreground italic">"O que você precisa pra gente começar essa semana?"</p>
                     </div>
                     
                     <div className="grid md:grid-cols-2 gap-4">
                       <div className="bg-secondary/10 p-4 rounded-lg">
                         <h4 className="font-semibold text-foreground text-sm mb-2">🔄 Alternativa</h4>
                         <p className="text-sm text-muted-foreground italic">"Você prefere começar com o plano mensal ou já aproveitar o desconto do anual?"</p>
                       </div>
                       <div className="bg-destructive/10 p-4 rounded-lg">
                         <h4 className="font-semibold text-foreground text-sm mb-2">⏰ Urgência</h4>
                         <p className="text-sm text-muted-foreground italic">"Essa condição especial é válida até [DATA]. Depois volta ao preço cheio."</p>
                       </div>
                       <div className="bg-accent/10 p-4 rounded-lg">
                         <h4 className="font-semibold text-foreground text-sm mb-2">🛡️ Reversão de Risco</h4>
                         <p className="text-sm text-muted-foreground italic">"Lembra que não tem fidelidade? Se não gostar, cancela no mês seguinte. Zero risco."</p>
                       </div>
                       <div className="bg-primary/10 p-4 rounded-lg">
                         <h4 className="font-semibold text-foreground text-sm mb-2">➡️ Próximo Passo</h4>
                         <p className="text-sm text-muted-foreground italic">"Posso te mandar o contrato agora pra você assinar digitalmente?"</p>
                       </div>
                     </div>
                   </CardContent>
                 </Card>

                 {/* Tips Card */}
                 <Card className="border-secondary/30 bg-gradient-to-br from-secondary/5 to-transparent">
                   <CardHeader>
                     <CardTitle>💡 Dicas de Ouro para Ligações</CardTitle>
                   </CardHeader>
                   <CardContent>
                     <div className="grid md:grid-cols-2 gap-4">
                       {[
                         { title: "Sorria ao telefone", desc: "O sorriso muda o tom da voz. O prospect sente." },
                         { title: "Fale devagar", desc: "Quem fala rápido parece desesperado. Respire." },
                         { title: "Use o nome", desc: "Chame pelo nome 3x durante a ligação. Cria conexão." },
                         { title: "Escute mais", desc: "Regra 70/30: deixe o prospect falar 70% do tempo." },
                         { title: "Anote tudo", desc: "Registre objeções e pontos importantes no CRM." },
                         { title: "Próximo passo sempre", desc: "Nunca termine sem agendar o próximo contato." },
                       ].map((tip, index) => (
                         <div key={index} className="flex items-start gap-3">
                           <CheckCircle2 className="h-5 w-5 text-secondary shrink-0 mt-0.5" />
                           <div>
                             <h4 className="font-semibold text-foreground">{tip.title}</h4>
                             <p className="text-sm text-muted-foreground">{tip.desc}</p>
                           </div>
                         </div>
                       ))}
                     </div>
                   </CardContent>
                 </Card>
               </TabsContent>

                {/* Proposals Tab */}
                <TabsContent value="proposals">
                  <ProposalGenerator />
                </TabsContent>

                {/* Objections Tab */}
                <TabsContent value="objections" className="space-y-6">
                 <Card>
                   <CardHeader>
                     <CardTitle>🛡️ Quebrando Objeções</CardTitle>
                     <CardDescription>
                       Respostas prontas para as objeções mais comuns
                     </CardDescription>
                   </CardHeader>
                   <CardContent className="space-y-6">
                     {[
                       {
                         objection: "\"Já uso WhatsApp no celular, funciona bem\"",
                         response: "Funciona até você ter 3 vendedores e não saber quem respondeu quem. Com nossa plataforma, todo histórico fica centralizado, você vê quem atendeu cada lead e nunca perde uma oportunidade."
                       },
                       {
                         objection: "\"É caro demais\"",
                         response: "Uma festa perdida por falta de follow-up custa quanto? R$ 3.000? R$ 5.000? A plataforma custa menos que UMA festa não fechada por mês. E você recupera várias."
                       },
                       {
                         objection: "\"Minha equipe não vai usar\"",
                         response: "É mais fácil que WhatsApp! Interface limpa, tudo no navegador. Oferecemos treinamento incluso e suporte para garantir a adoção."
                       },
                       {
                         objection: "\"Preciso ver funcionando primeiro\"",
                         response: "Perfeito! Oferecemos demonstração gratuita de 15 minutos. Você vê o sistema real, com dados de exemplo, e pode fazer perguntas ao vivo."
                       },
                       {
                         objection: "\"E se eu quiser cancelar?\"",
                         response: "Sem fidelidade. Cancele quando quiser. Seus dados podem ser exportados a qualquer momento. Zero risco."
                       },
                       {
                         objection: "\"Vocês têm experiência com buffets?\"",
                         response: "A plataforma foi desenvolvida dentro de um buffet real (Castelo da Diversão) com +5.000 festas realizadas. Conhecemos as dores porque vivemos elas."
                       },
                     ].map((item, index) => (
                       <div key={index} className="space-y-2">
                         <h4 className="font-semibold text-destructive">{item.objection}</h4>
                         <p className="text-muted-foreground pl-4 border-l-2 border-accent">
                           {item.response}
                         </p>
                       </div>
                     ))}
                   </CardContent>
                 </Card>
 
                 {/* Social Proof */}
                 <Card className="border-accent/30 bg-gradient-to-br from-accent/5 to-transparent">
                   <CardHeader>
                     <CardTitle>⭐ Prova Social</CardTitle>
                   </CardHeader>
                   <CardContent>
                     <div className="grid md:grid-cols-3 gap-4 text-center">
                       <div className="p-4">
                         <p className="text-3xl font-bold text-foreground">4.9/5</p>
                         <p className="text-sm text-muted-foreground">Avaliação no Google</p>
                       </div>
                       <div className="p-4">
                         <p className="text-3xl font-bold text-foreground">+5.000</p>
                         <p className="text-sm text-muted-foreground">Festas realizadas</p>
                       </div>
                       <div className="p-4">
                         <p className="text-3xl font-bold text-foreground">98%</p>
                         <p className="text-sm text-muted-foreground">Taxa de satisfação</p>
                       </div>
                     </div>
                   </CardContent>
                 </Card>
 
                 {/* CTA */}
                 <Card className="bg-primary text-primary-foreground">
                   <CardContent className="py-8 text-center">
                     <h3 className="text-2xl font-bold mb-2">📞 Call-to-Action Sugerido</h3>
                     <blockquote className="text-lg opacity-90">
                       "Agende uma demonstração gratuita de 15 minutos. Veja como automatizar seu comercial e nunca mais perder um lead."
                     </blockquote>
                   </CardContent>
                 </Card>
               </TabsContent>

                {/* Landing Page Tab */}
                <TabsContent value="landing" className="space-y-4">
                  <Card>
                    <CardHeader className="pb-3">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div>
                          <CardTitle className="flex items-center gap-2">
                            {lpViewMode === 'desktop' ? <Monitor className="h-5 w-5" /> : <Smartphone className="h-5 w-5" />}
                            Preview da Landing Page B2B
                          </CardTitle>
                          <CardDescription>
                            Visualize a página que seus clientes B2B vão ver
                          </CardDescription>
                        </div>
                        <div className="flex items-center gap-2">
                          {/* Toggle Desktop/Mobile */}
                          <div className="flex items-center border rounded-lg p-1 bg-muted/50">
                            <Button
                              variant={lpViewMode === 'desktop' ? 'default' : 'ghost'}
                              size="sm"
                              className="gap-2"
                              onClick={() => setLpViewMode('desktop')}
                            >
                              <Monitor className="h-4 w-4" />
                              <span className="hidden sm:inline">Desktop</span>
                            </Button>
                            <Button
                              variant={lpViewMode === 'mobile' ? 'default' : 'ghost'}
                              size="sm"
                              className="gap-2"
                              onClick={() => setLpViewMode('mobile')}
                            >
                              <Smartphone className="h-4 w-4" />
                              <span className="hidden sm:inline">Mobile</span>
                            </Button>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => window.open('/hub-landing', '_blank')}
                          >
                            Abrir em Nova Aba
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="p-4">
                      <div 
                        className={`mx-auto transition-all duration-300 border rounded-lg overflow-hidden bg-muted shadow-lg w-full ${
                          lpViewMode === 'mobile' 
                            ? 'max-w-[375px] h-[620px] sm:h-[700px]' 
                            : 'h-[520px] sm:h-[700px]'
                        }`}
                      >
                        <iframe
                          src="/hub-landing"
                          className="w-full h-full border-0"
                          title="Landing Page B2B"
                        />
                      </div>
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>
        </div>
      )}
    </HubLayout>
  );
};

export default ComercialB2B;