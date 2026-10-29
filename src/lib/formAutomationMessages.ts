import { supabase } from "@/integrations/supabase/client";

export type FormAutomationType =
  | "prefesta"
  | "cardapio"
  | "contrato"
  | "contrato_whatsapp"
  | "contrato_envio"
  | "avaliacao";

export const FORM_AUTOMATION_DEFAULT_MESSAGES: Record<FormAutomationType, string> = {
  prefesta:
    "Olá {{nome}}! 🎉\n\nSua festa está chegando! Para garantir que tudo saia perfeito, precisamos de algumas informações.\n\nPreencha o formulário abaixo:\n{{link}}",
  cardapio:
    "Olá {{nome}}! 🍽️\n\nVamos definir o cardápio da sua festa? Acesse o link abaixo e escolha as opções:\n\n{{link}}",
  contrato:
    "Olá {{nome}}! 😊\n\nEstamos finalizando os detalhes da sua festa no {{empresa}} no dia {{data_evento}}.\n\nPara seguirmos, preencha seus dados pessoais e as informações do aniversariante no link abaixo. Assim o buffet consegue finalizar o contrato com essas informações. 🎉\n\n{{link}}",
  contrato_whatsapp:
    "Olá {{nome}}! 📄\n\nSegue em anexo o contrato *{{nome_contrato}}* referente à sua festa.\n\nQualquer dúvida, estamos à disposição!\n\n_{{empresa}}_",
  contrato_envio:
    "📄 *{{nome_contrato}}*\n\nOlá {{nome}}! Seu contrato está pronto para assinatura digital.\n\nAcesse o link abaixo para ler e assinar:\n{{link}}\n\n_{{empresa}}_",
  avaliacao:
    "Olá {{nome}}! ⭐\n\nEsperamos que a festa tenha sido incrível! 🎊\n\nNos ajude a melhorar cada vez mais respondendo nossa avaliação:\n{{link}}",
};

type AutomationVars = {
  nome?: string | null;
  primeiro_nome?: string | null;
  empresa?: string | null;
  buffet?: string | null;
  nome_buffet?: string | null;
  data_evento?: string | null;
  data_festa?: string | null;
  tipo_festa?: string | null;
  pacote?: string | null;
  link?: string | null;
  link_formulario_contrato?: string | null;
  nome_contrato?: string | null;
};

export async function getFormAutomationTemplate(
  companyId: string,
  formType: FormAutomationType,
): Promise<string> {
  try {
    const { data } = await supabase
      .from("form_automation_settings")
      .select("message_template")
      .eq("company_id", companyId)
      .eq("form_type", formType)
      .maybeSingle();

    const savedTemplate = data?.message_template?.trim();
    if (savedTemplate) {
      return savedTemplate;
    }
  } catch (error) {
    console.error(`Erro ao buscar template de automação (${formType}):`, error);
  }

  return FORM_AUTOMATION_DEFAULT_MESSAGES[formType];
}

export function resolveFormAutomationMessage(template: string, vars: AutomationVars): string {
  const normalizedName = vars.nome?.trim() || "Cliente";
  const firstName = vars.primeiro_nome?.trim() || normalizedName.split(" ")[0] || "Cliente";
  const companyName = vars.empresa?.trim() || vars.buffet?.trim() || vars.nome_buffet?.trim() || "";
  const eventDate = vars.data_evento?.trim() || vars.data_festa?.trim() || "";
  const link = vars.link?.trim() || vars.link_formulario_contrato?.trim() || "";

  const replacements: Record<string, string> = {
    nome: normalizedName,
    primeiro_nome: firstName,
    empresa: companyName,
    buffet: companyName,
    nome_buffet: companyName,
    data_evento: eventDate,
    data_festa: eventDate,
    tipo_festa: vars.tipo_festa?.trim() || "",
    pacote: vars.pacote?.trim() || "",
    link,
    link_formulario_contrato: link,
    nome_contrato: vars.nome_contrato?.trim() || "",
  };

  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key: string) => replacements[key.toLowerCase()] || "");
}
