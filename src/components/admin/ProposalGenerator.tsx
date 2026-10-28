 import { useState } from "react";
 import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
 import { Button } from "@/components/ui/button";
 import { Input } from "@/components/ui/input";
 import { Label } from "@/components/ui/label";
 import { Textarea } from "@/components/ui/textarea";
 import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
 import { Checkbox } from "@/components/ui/checkbox";
 import { FileText, Download, Eye } from "lucide-react";
 import { toast } from "sonner";
 import jsPDF from "jspdf";
 import autoTable from "jspdf-autotable";
 import logoPlataforma from "@/assets/logo-plataforma-buffets.png";
 import { supabase } from "@/integrations/supabase/client";
 
 interface ProposalData {
   prospectName: string;
   companyName: string;
   email: string;
   phone: string;
   plan: "ia";
   buffets: number;
   pricePerBuffet: number;
   paymentType: "monthly" | "annual";
   customFeatures: string[];
   notes: string;
   validDays: number;
   discount: number;
 }
 
 // Plano único com IA (out/2026): o plano só com chatbot não é mais vendido.
// Tabela R$ 1.299 por buffet; na negociação, o mínimo fica por volta de R$ 999.
const PLAN_LIST_PRICE = 1299;
const PLAN_MIN_PRICE = 999;

const planDetails = {
  ia: {
    name: "Celebrei com IA",
    price: PLAN_LIST_PRICE,
    features: [
      "Atendente com IA no WhatsApp, 24 horas",
      "Até 500 conversas com a IA por mês, por buffet",
      "Passa valores, consulta a agenda e marca visitas",
      "Lembretes automáticos para quem parou de responder",
      "CRM completo com funil de vendas",
      "Agenda de visitas e festas",
      "Contratos com assinatura digital e financeiro",
      "Formulários, cardápio e avaliação pós-festa",
      "Campanhas com mensagens e artes feitas pela IA",
      "Implantação e treinamento por vídeo chamada",
      "Suporte incluso",
    ],
  },
};

const additionalFeatures = [
   { id: "training", label: "Treinamento presencial", price: 500 },
   { id: "migration", label: "Migração de dados", price: 300 },
   { id: "customization", label: "Customização visual", price: 400 },
   { id: "integration", label: "Integração com sistema existente", price: 800 },
   { id: "support247", label: "Suporte 24/7", price: 200 },
 ];
 
 export function ProposalGenerator() {
   const [formData, setFormData] = useState<ProposalData>({
     prospectName: "",
     companyName: "",
     email: "",
     phone: "",
     plan: "ia",
     buffets: 1,
     pricePerBuffet: PLAN_LIST_PRICE,
     paymentType: "monthly",
     customFeatures: [],
     notes: "",
     validDays: 7,
     discount: 0,
   });
 
   const [isGenerating, setIsGenerating] = useState(false);
   const [isSaving, setIsSaving] = useState(false);
 
   const calculateTotal = () => {
     const planPrice = formData.pricePerBuffet * Math.max(1, formData.buffets);
     const additionalTotal = formData.customFeatures.reduce((sum, featureId) => {
       const feature = additionalFeatures.find(f => f.id === featureId);
       return sum + (feature?.price || 0);
     }, 0);
     
     let subtotal = planPrice;
     if (formData.paymentType === "annual") {
       subtotal = planPrice * 10; // 2 meses grátis
     }
     
     const discountAmount = (subtotal + additionalTotal) * (formData.discount / 100);
     return {
       planPrice,
       additionalTotal,
       subtotal: subtotal + additionalTotal,
       discountAmount,
       total: subtotal + additionalTotal - discountAmount,
     };
   };
 
   const saveProposal = async () => {
     if (!formData.prospectName || !formData.companyName) {
       toast.error("Preencha pelo menos o nome do prospect e da empresa");
       return;
     }
 
     setIsSaving(true);
     const totals = calculateTotal();
 
     try {
       const { data: { user } } = await supabase.auth.getUser();
       if (!user) {
         toast.error("Você precisa estar logado para salvar propostas");
         return;
       }
 
       const { error } = await supabase.from("proposals").insert({
         user_id: user.id,
         prospect_name: formData.prospectName,
         company_name: formData.companyName,
         email: formData.email || null,
         phone: formData.phone || null,
         plan: formData.plan,
         payment_type: formData.paymentType,
         custom_features: formData.customFeatures,
         notes: formData.notes || null,
         valid_days: formData.validDays,
         discount: formData.discount,
         subtotal: totals.subtotal,
         discount_amount: totals.discountAmount,
         total: totals.total,
       });
 
       if (error) throw error;
 
       toast.success("Proposta salva no histórico!");
     } catch (error) {
       console.error("Error saving proposal:", error);
       toast.error("Erro ao salvar proposta. Tente novamente.");
     } finally {
       setIsSaving(false);
     }
   };
 
   const generateAndSave = async () => {
     await saveProposal();
     generatePDF();
   };
 
   const generatePDF = () => {
     if (!formData.prospectName || !formData.companyName) {
       toast.error("Preencha pelo menos o nome do prospect e da empresa");
       return;
     }
 
     setIsGenerating(true);
 
     try {
       const doc = new jsPDF();
       const pageWidth = doc.internal.pageSize.getWidth();
       const totals = calculateTotal();
       const plan = planDetails[formData.plan];
       const today = new Date();
       const validUntil = new Date(today.getTime() + formData.validDays * 24 * 60 * 60 * 1000);
 
       // Header
       doc.setFillColor(37, 99, 235); // Primary blue
       doc.rect(0, 0, pageWidth, 40, "F");
       
       // Add logo
       try {
        doc.addImage(logoPlataforma, "PNG", 15, 8, 25, 25);
       } catch (e) {
         console.log("Could not add logo to PDF");
       }
 
       doc.setTextColor(255, 255, 255);
       doc.setFontSize(24);
       doc.setFont("helvetica", "bold");
       doc.text("PROPOSTA COMERCIAL", pageWidth / 2 + 10, 20, { align: "center" });
       
       doc.setFontSize(12);
       doc.setFont("helvetica", "normal");
      doc.text("Plataforma para Buffets", pageWidth / 2 + 10, 30, { align: "center" });
 
       // Reset text color
       doc.setTextColor(0, 0, 0);
 
       // Proposal info
       let yPos = 55;
       doc.setFontSize(10);
       doc.setTextColor(100, 100, 100);
       doc.text(`Proposta Nº: ${Date.now().toString().slice(-8)}`, 15, yPos);
       doc.text(`Data: ${today.toLocaleDateString("pt-BR")}`, pageWidth - 15, yPos, { align: "right" });
       
       yPos += 8;
       doc.text(`Válida até: ${validUntil.toLocaleDateString("pt-BR")}`, 15, yPos);
 
       // Client info
       yPos += 15;
       doc.setTextColor(0, 0, 0);
       doc.setFontSize(14);
       doc.setFont("helvetica", "bold");
       doc.text("DADOS DO CLIENTE", 15, yPos);
       
       yPos += 10;
       doc.setFontSize(11);
       doc.setFont("helvetica", "normal");
       doc.text(`Empresa: ${formData.companyName}`, 15, yPos);
       yPos += 7;
       doc.text(`Responsável: ${formData.prospectName}`, 15, yPos);
       if (formData.email) {
         yPos += 7;
         doc.text(`Email: ${formData.email}`, 15, yPos);
       }
       if (formData.phone) {
         yPos += 7;
         doc.text(`Telefone: ${formData.phone}`, 15, yPos);
       }
 
       // Plan details
       yPos += 15;
       doc.setFontSize(14);
       doc.setFont("helvetica", "bold");
       doc.text(`PLANO ${plan.name.toUpperCase()}`, 15, yPos);
 
       yPos += 10;
       doc.setFontSize(11);
       doc.setFont("helvetica", "normal");
 
       // Features table
       const featuresData = plan.features.map(f => [f]);
       
       autoTable(doc, {
         startY: yPos,
         head: [["Recursos Inclusos"]],
         body: featuresData,
         theme: "striped",
         headStyles: { fillColor: [37, 99, 235], textColor: 255 },
         styles: { fontSize: 10 },
         margin: { left: 15, right: 15 },
       });
 
       yPos = (doc as any).lastAutoTable.finalY + 10;
 
       // Additional features
       if (formData.customFeatures.length > 0) {
         doc.setFontSize(14);
         doc.setFont("helvetica", "bold");
         doc.text("SERVIÇOS ADICIONAIS", 15, yPos);
         
         yPos += 10;
         const additionalData = formData.customFeatures.map(id => {
           const feature = additionalFeatures.find(f => f.id === id);
           return [feature?.label || "", `R$ ${feature?.price.toFixed(2)}`];
         });
         
         autoTable(doc, {
           startY: yPos,
           head: [["Serviço", "Valor"]],
           body: additionalData,
           theme: "striped",
           headStyles: { fillColor: [37, 99, 235], textColor: 255 },
           styles: { fontSize: 10 },
           margin: { left: 15, right: 15 },
         });
 
         yPos = (doc as any).lastAutoTable.finalY + 10;
       }
 
       // Pricing table
       doc.setFontSize(14);
       doc.setFont("helvetica", "bold");
       doc.text("INVESTIMENTO", 15, yPos);
 
       yPos += 10;
       const paymentLabel = formData.paymentType === "annual" ? "Anual (10x)" : "Mensal";
       const pricingData = [
         [`Plano ${plan.name} — ${formData.buffets} buffet${formData.buffets > 1 ? "s" : ""} × R$ ${formData.pricePerBuffet.toFixed(2)} (${paymentLabel})`, `R$ ${formData.paymentType === "annual" ? (totals.planPrice * 10).toFixed(2) : totals.planPrice.toFixed(2)}`],
       ];
       
       if (totals.additionalTotal > 0) {
         pricingData.push(["Serviços Adicionais (único)", `R$ ${totals.additionalTotal.toFixed(2)}`]);
       }
       
       if (formData.discount > 0) {
         pricingData.push([`Desconto (${formData.discount}%)`, `- R$ ${totals.discountAmount.toFixed(2)}`]);
       }
       
       pricingData.push(["TOTAL", `R$ ${totals.total.toFixed(2)}`]);
 
       autoTable(doc, {
         startY: yPos,
         body: pricingData,
         theme: "plain",
         styles: { fontSize: 11 },
         columnStyles: {
           0: { fontStyle: "normal" },
           1: { halign: "right", fontStyle: "bold" },
         },
         didParseCell: (data) => {
           if (data.row.index === pricingData.length - 1) {
             data.cell.styles.fillColor = [37, 99, 235];
             data.cell.styles.textColor = 255;
             data.cell.styles.fontStyle = "bold";
             data.cell.styles.fontSize = 12;
           }
         },
         margin: { left: 15, right: 15 },
       });
 
       yPos = (doc as any).lastAutoTable.finalY + 15;
 
       // Notes
       if (formData.notes) {
         doc.setFontSize(12);
         doc.setFont("helvetica", "bold");
         doc.text("OBSERVAÇÕES", 15, yPos);
         
         yPos += 8;
         doc.setFontSize(10);
         doc.setFont("helvetica", "normal");
         const splitNotes = doc.splitTextToSize(formData.notes, pageWidth - 30);
         doc.text(splitNotes, 15, yPos);
         yPos += splitNotes.length * 5 + 10;
       }
 
       // Terms
       if (yPos > 240) {
         doc.addPage();
         yPos = 20;
       }
 
       doc.setFontSize(12);
       doc.setFont("helvetica", "bold");
       doc.text("CONDIÇÕES", 15, yPos);
       
       yPos += 8;
       doc.setFontSize(9);
       doc.setFont("helvetica", "normal");
       doc.setTextColor(80, 80, 80);
       
       const terms = [
         "• Proposta válida pelo período indicado acima",
         "• Pagamento via PIX, boleto ou cartão de crédito",
         "• Plano mensal pode ser cancelado a qualquer momento",
         "• Plano anual tem desconto de 2 mensalidades",
         "• Suporte técnico, implantação e treinamento inclusos",
         "• Até 500 conversas com a IA por mês, por buffet (referência de uso)",
       ];
       
       terms.forEach(term => {
         doc.text(term, 15, yPos);
         yPos += 6;
       });
 
       // Footer
       const footerY = doc.internal.pageSize.getHeight() - 20;
       doc.setFillColor(37, 99, 235);
       doc.rect(0, footerY - 5, pageWidth, 25, "F");
       
       // Add logo to footer
       try {
        doc.addImage(logoPlataforma, "PNG", 15, footerY - 2, 18, 18);
       } catch {
         console.log("Could not add logo to footer");
       }
 
       doc.setTextColor(255, 255, 255);
       doc.setFontSize(10);
      doc.text("Plataforma para Buffets", pageWidth / 2 + 10, footerY + 3, { align: "center" });
       doc.setFontSize(8);
      doc.text("contato@plataformabuffets.com.br | plataformabuffets.com.br", pageWidth / 2 + 10, footerY + 10, { align: "center" });
 
       // Save
       const fileName = `proposta-${formData.companyName.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}.pdf`;
       doc.save(fileName);
       
       toast.success("Proposta gerada com sucesso!");
     } catch (error) {
       console.error("Erro ao gerar PDF:", error);
       toast.error("Erro ao gerar proposta. Tente novamente.");
     } finally {
       setIsGenerating(false);
     }
   };
 
   const handleFeatureToggle = (featureId: string) => {
     setFormData(prev => ({
       ...prev,
       customFeatures: prev.customFeatures.includes(featureId)
         ? prev.customFeatures.filter(id => id !== featureId)
         : [...prev.customFeatures, featureId],
     }));
   };
 
   const totals = calculateTotal();
 
   return (
     <div className="space-y-6">
       <div className="grid lg:grid-cols-2 gap-6">
         {/* Form */}
         <Card>
           <CardHeader>
             <CardTitle className="flex items-center gap-2">
               <FileText className="h-5 w-5" />
               Dados da Proposta
             </CardTitle>
             <CardDescription>
               Preencha as informações para gerar a proposta personalizada
             </CardDescription>
           </CardHeader>
           <CardContent className="space-y-4">
             <div className="grid sm:grid-cols-2 gap-4">
               <div className="space-y-2">
                 <Label htmlFor="prospectName">Nome do Responsável *</Label>
                 <Input
                   id="prospectName"
                   placeholder="João Silva"
                   value={formData.prospectName}
                   onChange={(e) => setFormData(prev => ({ ...prev, prospectName: e.target.value }))}
                 />
               </div>
               <div className="space-y-2">
                 <Label htmlFor="companyName">Nome da Empresa *</Label>
                 <Input
                   id="companyName"
                   placeholder="Buffet Alegria"
                   value={formData.companyName}
                   onChange={(e) => setFormData(prev => ({ ...prev, companyName: e.target.value }))}
                 />
               </div>
             </div>
             
             <div className="grid sm:grid-cols-2 gap-4">
               <div className="space-y-2">
                 <Label htmlFor="email">Email</Label>
                 <Input
                   id="email"
                   type="email"
                   placeholder="joao@buffet.com"
                   value={formData.email}
                   onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                 />
               </div>
               <div className="space-y-2">
                 <Label htmlFor="phone">Telefone</Label>
                 <Input
                   id="phone"
                   placeholder="(11) 99999-9999"
                   value={formData.phone}
                   onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                 />
               </div>
             </div>
 
             <div className="grid sm:grid-cols-2 gap-4">
               <div className="grid grid-cols-2 gap-3">
                 <div className="space-y-2">
                   <Label htmlFor="buffets">Buffets</Label>
                   <Input
                     id="buffets"
                     type="number"
                     min={1}
                     max={20}
                     value={formData.buffets}
                     onChange={(e) => setFormData(prev => ({ ...prev, buffets: Math.max(1, parseInt(e.target.value) || 1) }))}
                   />
                 </div>
                 <div className="space-y-2">
                   <Label htmlFor="pricePerBuffet">Valor por buffet (R$)</Label>
                   <Input
                     id="pricePerBuffet"
                     type="number"
                     min={0}
                     value={formData.pricePerBuffet}
                     onChange={(e) => setFormData(prev => ({ ...prev, pricePerBuffet: parseFloat(e.target.value) || 0 }))}
                   />
                   <p className={`text-[11px] ${formData.pricePerBuffet < PLAN_MIN_PRICE ? "text-destructive" : "text-muted-foreground"}`}>
                     Tabela R$ {PLAN_LIST_PRICE} · mínimo ~R$ {PLAN_MIN_PRICE}
                   </p>
                 </div>
               </div>
               <div className="space-y-2">
                 <Label>Tipo de Pagamento</Label>
                 <Select
                   value={formData.paymentType}
                   onValueChange={(value: "monthly" | "annual") => 
                     setFormData(prev => ({ ...prev, paymentType: value }))
                   }
                 >
                   <SelectTrigger>
                     <SelectValue />
                   </SelectTrigger>
                   <SelectContent>
                     <SelectItem value="monthly">Mensal</SelectItem>
                     <SelectItem value="annual">Anual (2 meses grátis)</SelectItem>
                   </SelectContent>
                 </Select>
               </div>
             </div>
 
             <div className="grid sm:grid-cols-2 gap-4">
               <div className="space-y-2">
                 <Label htmlFor="validDays">Validade (dias)</Label>
                 <Input
                   id="validDays"
                   type="number"
                   min={1}
                   max={30}
                   value={formData.validDays}
                   onChange={(e) => setFormData(prev => ({ ...prev, validDays: parseInt(e.target.value) || 7 }))}
                 />
               </div>
               <div className="space-y-2">
                 <Label htmlFor="discount">Desconto (%)</Label>
                 <Input
                   id="discount"
                   type="number"
                   min={0}
                   max={50}
                   value={formData.discount}
                   onChange={(e) => setFormData(prev => ({ ...prev, discount: parseInt(e.target.value) || 0 }))}
                 />
               </div>
             </div>
 
             <div className="space-y-3">
               <Label>Serviços Adicionais</Label>
               <div className="grid sm:grid-cols-2 gap-3">
                 {additionalFeatures.map(feature => (
                   <div key={feature.id} className="flex items-center space-x-2">
                     <Checkbox
                       id={feature.id}
                       checked={formData.customFeatures.includes(feature.id)}
                       onCheckedChange={() => handleFeatureToggle(feature.id)}
                     />
                     <label
                       htmlFor={feature.id}
                       className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                     >
                       {feature.label} <span className="text-muted-foreground">(+R$ {feature.price})</span>
                     </label>
                   </div>
                 ))}
               </div>
             </div>
 
             <div className="space-y-2">
               <Label htmlFor="notes">Observações</Label>
               <Textarea
                 id="notes"
                 placeholder="Condições especiais, informações adicionais..."
                 value={formData.notes}
                 onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                 rows={3}
               />
             </div>
           </CardContent>
         </Card>
 
         {/* Preview */}
         <Card className="bg-gradient-to-br from-primary/5 to-transparent">
           <CardHeader>
             <CardTitle className="flex items-center gap-2">
               <Eye className="h-5 w-5" />
               Resumo da Proposta
             </CardTitle>
           </CardHeader>
           <CardContent className="space-y-6">
             {/* Client Info */}
             <div className="space-y-2">
               <h4 className="font-semibold text-sm text-muted-foreground uppercase">Cliente</h4>
               <p className="font-medium">{formData.companyName || "Nome da Empresa"}</p>
               <p className="text-sm text-muted-foreground">{formData.prospectName || "Responsável"}</p>
             </div>
 
             {/* Plan */}
             <div className="space-y-2">
               <h4 className="font-semibold text-sm text-muted-foreground uppercase">Plano Selecionado</h4>
               <div className="p-4 rounded-lg bg-primary/10 border border-primary/20">
                 <div className="flex justify-between items-center mb-2">
                   <span className="font-bold text-lg">{planDetails[formData.plan].name}</span>
                   <span className="font-bold text-primary">
                     R$ {(formData.pricePerBuffet * formData.buffets).toFixed(2)}/mês{formData.buffets > 1 ? ` (${formData.buffets} buffets)` : ""}
                   </span>
                 </div>
                 <ul className="text-sm text-muted-foreground space-y-1">
                   {planDetails[formData.plan].features.slice(0, 4).map((f, i) => (
                     <li key={i}>✓ {f}</li>
                   ))}
                   {planDetails[formData.plan].features.length > 4 && (
                     <li className="text-primary">+ {planDetails[formData.plan].features.length - 4} mais...</li>
                   )}
                 </ul>
               </div>
             </div>
 
             {/* Additional */}
             {formData.customFeatures.length > 0 && (
               <div className="space-y-2">
                 <h4 className="font-semibold text-sm text-muted-foreground uppercase">Adicionais</h4>
                 <ul className="text-sm space-y-1">
                   {formData.customFeatures.map(id => {
                     const feature = additionalFeatures.find(f => f.id === id);
                     return (
                       <li key={id} className="flex justify-between">
                         <span>{feature?.label}</span>
                         <span className="text-muted-foreground">+ R$ {feature?.price}</span>
                       </li>
                     );
                   })}
                 </ul>
               </div>
             )}
 
             {/* Totals */}
             <div className="border-t pt-4 space-y-2">
               <div className="flex justify-between text-sm">
                 <span>Subtotal ({formData.paymentType === "annual" ? "anual" : "mensal"})</span>
                 <span>R$ {(totals.subtotal).toFixed(2)}</span>
               </div>
               {formData.discount > 0 && (
                 <div className="flex justify-between text-sm text-green-600">
                   <span>Desconto ({formData.discount}%)</span>
                   <span>- R$ {totals.discountAmount.toFixed(2)}</span>
                 </div>
               )}
               <div className="flex justify-between font-bold text-lg pt-2 border-t">
                 <span>Total</span>
                 <span className="text-primary">R$ {totals.total.toFixed(2)}</span>
               </div>
               {formData.paymentType === "annual" && (
                 <p className="text-xs text-muted-foreground text-center">
                   (equivalente a R$ {(totals.total / 12).toFixed(2)}/mês)
                 </p>
               )}
             </div>
 
             {/* Generate Button */}
             <Button
               className="w-full"
               size="lg"
                 onClick={generateAndSave}
                 disabled={isGenerating || isSaving || !formData.prospectName || !formData.companyName}
             >
                 {isGenerating || isSaving ? (
                 <>
                   <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                     {isSaving ? "Salvando..." : "Gerando..."}
                 </>
               ) : (
                 <>
                   <Download className="h-4 w-4 mr-2" />
                     Gerar e Salvar Proposta
                 </>
               )}
             </Button>
               
               <Button
                 variant="outline"
                 className="w-full"
                 size="lg"
                 onClick={generatePDF}
                 disabled={isGenerating || !formData.prospectName || !formData.companyName}
               >
                 <Eye className="h-4 w-4 mr-2" />
                 Apenas Gerar PDF
               </Button>
           </CardContent>
         </Card>
       </div>
 
       {/* Tips */}
       <Card className="border-secondary/30 bg-gradient-to-br from-secondary/5 to-transparent">
         <CardHeader>
           <CardTitle>💡 Dicas para Propostas Efetivas</CardTitle>
         </CardHeader>
         <CardContent>
           <div className="grid md:grid-cols-3 gap-4">
             {[
               { title: "Personalize", desc: "Use o nome do prospect e da empresa. Propostas genéricas convertem menos." },
               { title: "Limite o tempo", desc: "Propostas com prazo curto (5-7 dias) criam senso de urgência." },
               { title: "Destaque o ROI", desc: "Mostre quanto ele perde hoje sem a plataforma. Números convencem." },
             ].map((tip, index) => (
               <div key={index} className="flex items-start gap-3">
                 <div className="w-8 h-8 rounded-full bg-secondary/20 flex items-center justify-center shrink-0">
                   <span className="font-bold text-secondary">{index + 1}</span>
                 </div>
                 <div>
                   <h4 className="font-semibold text-foreground">{tip.title}</h4>
                   <p className="text-sm text-muted-foreground">{tip.desc}</p>
                 </div>
               </div>
             ))}
           </div>
         </CardContent>
       </Card>
     </div>
   );
 }