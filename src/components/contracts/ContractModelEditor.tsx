import { useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCompany } from "@/contexts/CompanyContext";
import { getCompanyLogoOverride } from "@/lib/companyAssetOverrides";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Save, Eye, Info, Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { getAvailableVariables, resolveSystemVariables } from "@/lib/template-resolver";
import { RichContractEditor } from "./RichContractEditor";

/** Convert **bold** markdown markers into <strong> tags.
 *  Handles bold blocks that span multiple lines by tracking open/close state. */
function parseBoldMarkdown(text: string): string {
  const lines = text.split('\n');
  let inBold = false;
  const result = lines.map(line => {
    // First handle complete **..** pairs within this line
    line = line.replace(/\*\*([^\n]+?)\*\*/g, (_m, inner) => `<strong>${inner}</strong>`);
    // Count remaining unmatched ** markers
    const parts = line.split('**');
    if (parts.length > 1) {
      let rebuilt = '';
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          inBold = !inBold;
          rebuilt += inBold ? '<strong>' : '</strong>';
        }
        rebuilt += parts[i];
      }
      return rebuilt;
    }
    if (inBold) {
      return `<strong>${line}</strong>`;
    }
    return line;
  });
  let output = result.join('\n');
  if (inBold) output += '</strong>';
  output = output.replace(/<strong><\/strong>/g, '');
  return output;
}

const TIPO_OPTIONS = [
  { value: "aniversario", label: "Aniversário" },
  { value: "aniversario_kids", label: "Aniversário Kids" },
  { value: "escolar", label: "Escolar" },
  { value: "formatura", label: "Formatura" },
  { value: "externo", label: "Externo" },
  { value: "personalizado", label: "Personalizado" },
];

interface Props {
  model: {
    id: string;
    nome_modelo: string;
    tipo_evento: string;
    descricao: string | null;
    conteudo_template: string;
    versao: number;
    company_id: string;
  } | null;
  userId: string;
  onClose: () => void;
}

const DOMAIN_LABELS: Record<string, string> = {
  lead: "Lead / Contratante",
  company: "Empresa",
  event: "Evento",
  contract: "Contrato / Dados Extras",
  visit: "Visita",
  schedule: "Escala",
};

export function ContractModelEditor({ model, userId, onClose }: Props) {
  const { currentCompany } = useCompany();
  const [nome, setNome] = useState(model?.nome_modelo || "");
  const [tipo, setTipo] = useState(model?.tipo_evento || "aniversario");
  const [descricao, setDescricao] = useState(model?.descricao || "");
  const [conteudo, setConteudo] = useState(model?.conteudo_template || DEFAULT_TEMPLATE);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<string>("editor");

  const variables = useMemo(() => getAvailableVariables(), []);
  const groupedVars = useMemo(() => {
    const groups: Record<string, typeof variables> = {};
    variables.forEach(v => {
      const d = v.domain;
      if (!groups[d]) groups[d] = [];
      groups[d].push(v);
    });
    return groups;
  }, [variables]);

  // Detect unrecognized variables
  const unresolvedVars = useMemo(() => {
    const varPattern = /\{\{?\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*\}?\}/g;
    const allKeys = new Set(variables.map(v => v.key));
    const allAliases = new Set(variables.flatMap(v => v.aliases));
    const unresolved: string[] = [];
    let match;
    while ((match = varPattern.exec(conteudo)) !== null) {
      const key = match[1].toLowerCase();
      if (!allKeys.has(key) && !allAliases.has(key)) {
        if (!unresolved.includes(match[1])) unresolved.push(match[1]);
      }
    }
    return unresolved;
  }, [conteudo, variables]);

  // Preview with sample data
  const previewContent = useMemo(() => {
    return resolveSystemVariables(conteudo, {
      lead: { name: "Maria Silva", whatsapp: "(11) 99999-9999", guests: "80", unit: "Unidade Centro" },
      company: { name: currentCompany?.name || "Buffet Exemplo" },
      event: { date: "15/03/2026", time: "14:00", end_time: "18:00", package_name: "Pacote Gold", value: 5000, guest_count: 80, unit: "Unidade Centro", event_type: "Aniversário" },
      contract: {
        responsible_name: "Maria Silva", cpf: "123.456.789-00", rg: "12.345.678-9",
        email: "maria@email.com", address: "Rua das Flores", numero: "123", complemento: "Apto 45",
        bairro: "Centro", cidade: "São Paulo", cep: "01234-567",
        nome_aniversariante: "João", idade_aniversariante: "5", data_nascimento: "15/03/1990", data_nascimento_aniversariante: "15/03/2021",
        nomes_pais: "Maria Silva e Pedro Silva",
        value: "R$ 5.000,00", valor_sinal: "R$ 1.500,00", valor_restante: "R$ 3.500,00",
        forma_pagamento: "3x no cartão", brindes: "Brinquedo surpresa", date: new Date().toLocaleDateString("pt-BR"),
      },
    });
  }, [conteudo, currentCompany?.name]);

  const generateSlug = (name: string) => name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const handleSave = async () => {
    if (!currentCompany?.id || !nome.trim() || !conteudo.trim()) {
      toast({ title: "Preencha o nome e o conteúdo do contrato", variant: "destructive" });
      return;
    }
    setSaving(true);

    if (model) {
      // Save version before updating
      await (supabase as any).from("contract_model_versions").insert({
        model_id: model.id,
        company_id: model.company_id,
        versao: model.versao,
        conteudo_template: model.conteudo_template,
        tipo_evento: model.tipo_evento,
        nome_modelo: model.nome_modelo,
        changed_by: userId,
      });

      const newVersion = model.versao + 1;
      const { error } = await (supabase as any).from("contract_models").update({
        nome_modelo: nome.trim(),
        tipo_evento: tipo,
        descricao: descricao.trim() || null,
        conteudo_template: conteudo,
        versao: newVersion,
        updated_by: userId,
        slug: generateSlug(nome.trim()),
      }).eq("id", model.id);

      if (error) { toast({ title: "Erro ao salvar", description: error.message, variant: "destructive" }); }
      else { toast({ title: `Modelo atualizado (v${newVersion})!` }); }
    } else {
      const { error } = await (supabase as any).from("contract_models").insert({
        company_id: currentCompany.id,
        nome_modelo: nome.trim(),
        slug: generateSlug(nome.trim()),
        tipo_evento: tipo,
        descricao: descricao.trim() || null,
        conteudo_template: conteudo,
        created_by: userId,
      });
      if (error) { toast({ title: "Erro ao criar", description: error.message, variant: "destructive" }); }
      else { toast({ title: "Modelo criado!" }); }
    }
    setSaving(false);
    onClose();
  };

  const insertVariable = (key: string) => {
    setConteudo(prev => prev + `{{${key}}}`);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 md:px-6 py-4 border-b border-border/40 bg-gradient-to-r from-primary/5 to-transparent">
        <h2 className="text-lg font-bold">{model ? "Editar Modelo" : "Novo Modelo de Contrato"}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">Use variáveis como {"{{nome}}"} para preencher automaticamente</p>
      </div>

      <div className="p-4 md:p-6 space-y-4">
        {/* Name + Type */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <Label className="text-xs font-semibold">Nome do Modelo</Label>
            <Input value={nome} onChange={e => setNome(e.target.value)} placeholder="Ex: Contrato Festa Aniversário" className="mt-1" />
          </div>
          <div>
            <Label className="text-xs font-semibold">Tipo de Evento</Label>
            <Select value={tipo} onValueChange={setTipo}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TIPO_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <Label className="text-xs font-semibold">Descrição (opcional)</Label>
          <Input value={descricao} onChange={e => setDescricao(e.target.value)} placeholder="Breve descrição do modelo..." className="mt-1" />
        </div>

        {/* Editor + Preview tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid grid-cols-3 w-full max-w-full md:max-w-sm">
            <TabsTrigger value="editor">Editor</TabsTrigger>
            <TabsTrigger value="preview"><Eye className="h-3.5 w-3.5 mr-1" /> Preview</TabsTrigger>
            <TabsTrigger value="variables"><Info className="h-3.5 w-3.5 mr-1" /> Variáveis</TabsTrigger>
          </TabsList>

          <TabsContent value="editor" className="mt-3">
            <div className="flex items-center gap-2 mb-2 p-2.5 rounded-lg bg-muted/50 border border-border/30">
              {getCompanyLogoOverride(currentCompany?.slug, currentCompany?.logo_url) && <img src={getCompanyLogoOverride(currentCompany?.slug, currentCompany?.logo_url)!} alt="" className="h-6 rounded" />}
              <p className="text-xs text-muted-foreground">
                🏷️ O logotipo e nome de <strong>{currentCompany?.name || "sua empresa"}</strong> serão adicionados automaticamente no topo de todo contrato gerado.
              </p>
            </div>
            <RichContractEditor
              value={conteudo}
              onChange={setConteudo}
              placeholder="Digite o conteúdo do contrato aqui..."
            />
            {unresolvedVars.length > 0 && (
              <div className="mt-2 p-3 rounded-xl bg-amber-500/10 border border-amber-300/30 text-sm">
                <p className="font-semibold text-amber-700 text-xs mb-1">⚠️ Variáveis não reconhecidas:</p>
                <div className="flex flex-wrap gap-1">
                  {unresolvedVars.map(v => <Badge key={v} variant="outline" className="text-xs border-amber-400 text-amber-700">{`{{${v}}}`}</Badge>)}
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="preview" className="mt-3">
            <div className="bg-muted/30 rounded-2xl p-4 md:p-6 max-h-[500px] overflow-y-auto">
              <div className="max-w-[680px] mx-auto bg-white dark:bg-card rounded-xl shadow-sm border border-border/30 p-8 md:p-10">
                {/* Document header — matches print */}
                <div className="text-center mb-6 pb-3 border-b-2 border-foreground/15">
                  {getCompanyLogoOverride(currentCompany?.slug, currentCompany?.logo_url) && (
                    <img src={getCompanyLogoOverride(currentCompany?.slug, currentCompany?.logo_url)!} alt="" className="h-28 mx-auto mb-2" />
                  )}
                  <h2 className="text-sm md:text-base font-bold text-foreground tracking-wide uppercase">
                    Contrato de festa {currentCompany?.name || "Buffet"}
                  </h2>
                </div>

                {/* Document body — matches ContractDocumentViewer */}
                <div
                  className="whitespace-pre-wrap text-sm leading-[1.85] text-foreground/90 font-serif text-justify"
                  dangerouslySetInnerHTML={{
                     __html: parseBoldMarkdown(previewContent),
                  }}
                />

                {/* Document footer */}
                <div className="mt-12 pt-3 border-t border-border/30 text-center">
                  <p className="text-[10px] text-muted-foreground">
                    Documento gerado pela plataforma CELEBREI — {new Date().toLocaleDateString("pt-BR")}
                  </p>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="variables" className="mt-3">
            <div className="rounded-2xl border border-border/40 p-4 max-h-[400px] overflow-y-auto space-y-4">
              {Object.entries(groupedVars).map(([domain, vars]) => (
                <div key={domain}>
                  <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">{DOMAIN_LABELS[domain] || domain}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {vars.map(v => (
                      <button
                        key={v.key}
                        onClick={() => insertVariable(v.key)}
                        className="text-xs px-2.5 py-1 rounded-full border border-primary/20 bg-primary/5 text-primary hover:bg-primary/15 transition-colors cursor-pointer"
                      >
                        {`{{${v.key}}}`}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground mt-2">Clique em uma variável para inserí-la no editor</p>
            </div>
          </TabsContent>
        </Tabs>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-border/40">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving} className="gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {model ? "Salvar Alterações" : "Criar Modelo"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Modelo inicial genérico (29/10): antes vinha o contrato do Castelo, com
// endereço, CNPJ e foro dele — um buffet novo podia mandar com os dados errados.
// O que é do buffet fica entre [colchetes] para ele preencher.
const DEFAULT_TEMPLATE = `CONTRATO DE PRESTAÇÃO DE SERVIÇOS DE BUFFET INFANTIL

CONTRATADO: {{empresa}}, inscrito no CNPJ [CNPJ do buffet], com sede em [endereço do buffet].

CONTRATANTE:
Nome: {{nome_completo}}
Data de Nascimento: {{data_nascimento}}
CPF: {{cpf}}
RG: {{rg}}
Endereço: {{endereco}}, {{numero}}
Complemento: {{complemento}}
Bairro: {{bairro}}
CEP: {{cep}}
Cidade: {{cidade}}
Telefone: {{telefone}}
E-mail: {{email}}

**Aniversariante: {{nome_aniversariante}}, Idade a comemorar: {{idade_aniversariante}}, Data de nascimento: {{data_nascimento_aniversariante}}
Data do evento: {{data_evento}}, das {{hora_inicio}} às {{hora_fim}} · Pacote: {{pacote}} · Tema: {{tema}}**

Cláusula 1ª) O CONTRATADO prestará os serviços de buffet infantil do pacote acima, em seu salão de eventos, na data e no horário combinados.

Cláusula 2ª) O preço contratado é {{valor_total}}, pago da seguinte forma: {{forma_pagamento}}.
Brindes: {{brindes}}

Cláusula 3ª) O número de convidados é de {{convidados}} pessoas. Convidados além desse número serão cobrados à parte, no valor de {{valor_convidado_adicional}} por pessoa. O não comparecimento de convidados não reduz o valor contratado.

Cláusula 4ª) A festa terá a duração prevista no pacote, com [tolerância] de tolerância. Passado esse tempo, poderá ser cobrada hora extra conforme a tabela do CONTRATADO.

Cláusula 5ª) Alteração de data depende de disponibilidade na agenda e deve ser pedida com [prazo] de antecedência. [Regras de remarcação do buffet.]

Cláusula 6ª) Em caso de cancelamento pelo CONTRATANTE, [regras de cancelamento e devolução do buffet].

Cláusula 7ª) Não é permitida a entrada de alimentos e bebidas de fora, exceto o que for combinado por escrito com o CONTRATADO.

Cláusula 8ª) O CONTRATANTE responde por danos causados por ele ou por seus convidados às instalações e aos equipamentos do CONTRATADO.

Cláusula 9ª) As partes elegem o foro da comarca de [cidade do buffet] para resolver qualquer questão sobre este contrato.

[Cidade do buffet], {{data_contrato}}

_______________________________
CONTRATANTE - CPF {{cpf}}
{{nome_completo}}

_______________________________
{{empresa}}`;