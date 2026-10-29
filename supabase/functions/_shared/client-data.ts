// Dados do contratante (formulário /dados/:token): link curto no domínio do
// buffet, envio automático ao marcar "Fechado" e cobranças até o cliente
// preencher. Regras puras — quem envia é o follow-up-check.

// Mesmo alfabeto da tela (src/lib/clientDataRequest.ts): sem 0/O, 1/I/l
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function shortClientToken(length = 7): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/**
 * www.castelodadiversao.com.br/dados/K7M2QX9 — sem domínio próprio, o
 * endereço da Celebrei. Sem "https://": o WhatsApp continua deixando clicável
 * e não quebra o link em 3 linhas.
 */
export function clientDataLink(token: string, customDomain: string | null | undefined): string {
  const domain = (customDomain || "").trim().replace(/\/$/, "");
  const base = domain ? domain.replace(/^https?:\/\//i, "") : "hubcelebrei.com.br";
  return `${base}/dados/${token}`;
}

// Iguais aos da tela (ClientDataAutomationCard)
export const DEFAULT_CLIENT_DATA_REMINDERS = [
  "Oi, {{primeiro_nome}}! 😊 Passando pra lembrar do cadastro pro contrato da festa 🎉 Leva só 2 minutinhos: {{link}}",
  "{{primeiro_nome}}, tudo bem? 💜 Pra gente garantir a data da festa, só falta o seu cadastro. É com ele que fazemos o contrato 📝 {{link}}",
  "{{primeiro_nome}}, a data da festa só fica garantida depois do contrato, e ele depende do seu cadastro 🙏 Ficou alguma dúvida ou teve dificuldade com o formulário? Me responde aqui que eu te ajudo 😊 {{link}}",
];

export const DEFAULT_CLIENT_DATA_MESSAGE =
  "Olá {{nome}}! 😊\n\nEstamos finalizando os detalhes da sua festa no {{empresa}} no dia {{data_evento}}.\n\nPara seguirmos, preencha seus dados pessoais e as informações do aniversariante no link abaixo. Assim o buffet consegue finalizar o contrato com essas informações. 🎉\n\n{{link}}";

/** Mesmas variáveis da tela (resolveFormAutomationMessage) */
export function fillClientDataTemplate(template: string, vars: { nome?: string | null; empresa?: string | null; data_evento?: string | null; link: string }): string {
  const nome = (vars.nome || "").trim() || "Cliente";
  const first = nome.split(/\s+/)[0] || "Cliente";
  const map: Record<string, string> = {
    nome, primeiro_nome: first,
    empresa: vars.empresa || "", buffet: vars.empresa || "", nome_buffet: vars.empresa || "",
    data_evento: vars.data_evento || "", data_festa: vars.data_evento || "",
    link: vars.link, link_formulario_contrato: vars.link,
  };
  let out = template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k: string) => map[k.toLowerCase()] ?? "");
  // Sem data da festa: tira o "no dia ." que ficaria pela metade
  if (!vars.data_evento) out = out.replace(/\s+no dia\s*(?=[.,!])/i, "");
  return out;
}

/** Agradecimento ao cliente logo depois de preencher o formulário */
export function clientDataThanks(name: string | null | undefined): string {
  const raw = String(name || "").trim().split(/\s+/)[0] || "";
  // "DIANDRA" → "Diandra"
  const first = raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : "";
  return `Recebemos seus dados${first ? `, ${first}` : ""}! 💜 Obrigado por preencher.\n\nAgora a equipe já consegue preparar o seu contrato 📝✨`;
}

export interface ReminderState {
  sent_at: string | null;
  reminder_count: number;
}

/** Qual cobrança está vencida (0, 1, 2…) ou null — prazos contados a partir do envio do link */
export function dueReminder(req: ReminderState, hours: number[], nowMs: number): number | null {
  if (!req.sent_at || req.reminder_count >= hours.length) return null;
  const due = Date.parse(req.sent_at) + hours[req.reminder_count] * 3600000;
  return nowMs >= due ? req.reminder_count : null;
}

/** Cobranças acabaram sem resposta: alerta 24 h depois da última */
export function isOverdue(req: ReminderState & { last_reminder_at: string | null }, hours: number[], nowMs: number): boolean {
  if (req.reminder_count < hours.length || req.reminder_count >= 99 || !req.last_reminder_at) return false;
  return nowMs - Date.parse(req.last_reminder_at) >= 24 * 3600000;
}

/** Horas válidas (1 a 240), em ordem; sem configuração, 24/48/72 */
export function normalizeReminderHours(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw.map(Number).filter((n) => Number.isFinite(n) && n >= 1 && n <= 240) : [];
  return list.length > 0 ? [...list].sort((a, b) => a - b) : [24, 48, 72];
}

function validCpf(d: string): boolean {
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const check = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return (r === 10 ? 0 : r) === Number(d[len]);
  };
  return check(9) && check(10);
}

/** O cliente mandou um CPF válido pelo chat (sinal de que já passou os dados por texto) */
export function hasCpfInText(text: string | null | undefined): boolean {
  const matches = String(text || "").match(/\d{3}[.\s]?\d{3}[.\s]?\d{3}[-.\s]?\d{2}/g) || [];
  return matches.some((m) => validCpf(m.replace(/\D/g, "")));
}
