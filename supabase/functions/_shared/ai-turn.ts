// Regras de "vez" da IA (beta): juntar mensagens seguidas do cliente numa
// resposta só e saber se a equipe já respondeu depois da passagem.

// Espera antes de responder: mensagens que chegam nesse intervalo são
// respondidas juntas, numa resposta só. 10 s não bastava: no teste de 05/10
// a segunda pergunta chegou 14 s depois da primeira.
export const AI_DEBOUNCE_MS = 16000;
// Mensagem que parece completa (pergunta, frase longa, áudio): espera curta
export const AI_DEBOUNCE_COMPLETE_MS = 5000;
// Meio-termo (frase curta sem "?")
export const AI_DEBOUNCE_MEDIUM_MS = 9000;
// A mensagem do cliente leva 3 a 4 s para chegar ao sistema depois de enviada
// (Silvana, Castelo, 24/10: "Qual valores" saiu 13:21:33 e só foi gravada
// 13:21:36,4 — a resposta à mensagem anterior saiu 13:21:36,0). Antes de
// enviar, a IA espera esse tempo e só então confere se chegou mensagem nova.
export const AI_INBOUND_LAG_MS = 4500;

const OPENERS = /^(oi+|ol[aá]|opa|e a[ií]|bom dia|boa tarde|boa noite|ent[aã]o|e|mas|tipo|assim|s[oó]|ok|okay|hum+|hm+|blz|beleza|certo|sim|n[aã]o|t[aá]|tudo bem|td bem)[\s!.,…]*$/i;

/**
 * Quanto esperar antes de responder, pela cara da última mensagem:
 * - completa (tem "?", frase longa ou áudio/foto): 5 s;
 * - incompleta ("Olá", "Então", uma palavra, termina em vírgula/reticências): 16 s;
 * - o resto: 9 s.
 * Se a IA acabou de fazer uma pergunta, resposta curta conta como completa.
 */
export function debounceMsFor(text: string, isMedia = false, answeringQuestion = false): number {
  if (isMedia) return AI_DEBOUNCE_COMPLETE_MS;
  const t = (text || "").trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  const trailing = /(,|\.\.\.|…|\s(e|mas|que|pra|para|de))$/i.test(t);
  // Resposta curta a uma pergunta da IA ("Victor", "dezembro", "60") já é completa
  if (answeringQuestion && t && !trailing && !/^(oi+|ol[aá]|opa|ent[aã]o|e|mas|tipo|assim|hum+|hm+)[\s!.,…]*$/i.test(t)) return AI_DEBOUNCE_COMPLETE_MS;
  if (!t || OPENERS.test(t) || words <= 1 || trailing) return AI_DEBOUNCE_MS;
  if (t.includes("?") || t.length >= 40 || words >= 7) return AI_DEBOUNCE_COMPLETE_MS;
  return AI_DEBOUNCE_MEDIUM_MS;
}

export interface IncomingRow {
  message_id: string | null;
  timestamp: string;
}

// A mensagem mais recente do cliente decide quem responde. Empate no mesmo
// segundo: maior message_id — todas as execuções chegam à mesma escolha.
export function pickLatestIncoming(rows: IncomingRow[]): string | null {
  let best: IncomingRow | null = null;
  for (const r of rows) {
    if (!r.message_id) continue;
    if (!best) { best = r; continue; }
    const tr = Date.parse(r.timestamp), tb = Date.parse(best.timestamp);
    if (tr > tb || (tr === tb && r.message_id > (best.message_id || ""))) best = r;
  }
  return best?.message_id ?? null;
}

// Mensagens nossas que NÃO são de uma pessoa da equipe (robôs/avisos)
// "reaction": emoji numa mensagem (pela Central ou celular) não é a equipe respondendo
const AUTOMATED_SOURCES = new Set(["auto_reminder", "campaign_auto_reply", "system_alert", "ai_agent", "reactivation_engine", "visit_confirmation", "reaction", "client_data", "post_visit", "scheduled_return"]);

export interface OutgoingRow {
  from_me: boolean;
  timestamp: string;
  metadata: Record<string, unknown> | null;
}

// Até esta data as mensagens da IA saíam gravadas como "platform", iguais às
// da equipe pelo Celebrei — antes dela, "platform" não prova resposta humana.
export const AI_SOURCE_MARKED_SINCE = "2026-10-05T23:10:00Z";

// Alguém da equipe respondeu depois da passagem? Mensagens do Celebrei
// (metadata.source "platform") e do celular (sem metadata) contam; follow-up
// automático, avisos do sistema e a própria IA não.
export function teamRepliedAfter(rows: OutgoingRow[], sinceIso: string): boolean {
  const since = Date.parse(sinceIso);
  const markedSince = Date.parse(AI_SOURCE_MARKED_SINCE);
  return rows.some((r) => {
    const at = Date.parse(r.timestamp);
    if (!r.from_me || at <= since) return false;
    const source = typeof r.metadata?.source === "string" ? r.metadata.source as string : null;
    if (source === "platform" && at < markedSince) return false; // pode ser a IA antiga
    return !source || !AUTOMATED_SOURCES.has(source);
  });
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

// Junta mensagens seguidas do mesmo lado numa só (o cliente costuma mandar
// várias perguntas picadas) e conta quantas do cliente estão sem resposta.
export function mergeConsecutiveTurns<T extends Turn>(turns: T[]): { merged: T[]; pendingUserMessages: number } {
  const merged: T[] = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.content = `${last.content}\n${t.content}`;
    else merged.push({ ...t });
  }
  let pending = 0;
  for (let i = turns.length - 1; i >= 0 && turns[i].role === "user"; i--) pending++;
  return { merged, pendingUserMessages: pending };
}

// Quantas respostas da IA desde o último convite para visita (0 = a última
// resposta convidou; null = ainda não convidou). Serve para não terminar toda
// mensagem com "posso agendar uma visita".
const VISIT_INVITE = /\bvisita/i;
export function repliesSinceVisitInvite(turns: Turn[]): number | null {
  // Conta VEZES da IA (mensagens seguidas dela = uma resposta): o envio das
  // fotos/vídeo/PDF são várias mensagens e inflavam a conta (achado do simulador)
  let count = 0;
  let inAssistantBlock = false;
  let blockHasInvite = false;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role !== "assistant" || t.content.startsWith("🧪")) {
      if (inAssistantBlock) {
        if (blockHasInvite) return count;
        count++;
        inAssistantBlock = false;
        blockHasInvite = false;
      }
      continue;
    }
    inAssistantBlock = true;
    // Mesma detecção da trava (a IA convida sem a palavra "visita": "quer conhecer o espaço?")
    if (VISIT_INVITE.test(t.content) || hasVisitInvite(t.content)) blockHasInvite = true;
  }
  if (inAssistantBlock && blockHasInvite) return count;
  return null;
}

// Menor pacote (convidados) entre os PDFs de pacotes com quantidade definida
export function smallestPackageGuests(materials: Array<{ type?: string; guest_count?: number | null }>): number | null {
  const counts = materials
    .filter((m) => m.type === "pdf_package" && typeof m.guest_count === "number" && m.guest_count > 0)
    .map((m) => m.guest_count as number);
  return counts.length > 0 ? Math.min(...counts) : null;
}

// Pergunta de PREÇO de verdade. "Orçamento" sozinho (ou a opção "Orçamento
// para uma festa" do menu) não conta: recebe fotos, vídeo e PDF, e a IA
// conduz para data e visita — o dono não quer valor aberto para quem não perguntou
const PRICE_ASK = /(pre[cç]o|valor|quanto (fica|custa|sai|é|e|ficaria|seria|cobra|vai ficar|d[aá])|investimento|tabela de pre|\bcusto\b)/i;

/** Só vale pergunta de preço dos últimos 7 dias (cliente que volta depois de semanas começa do zero) */
export const PRICE_ASK_WINDOW_MS = 7 * 24 * 3600 * 1000;

/** O cliente perguntou o preço nas mensagens recebidas (o chamador passa só as recentes)? */
export function clientAskedPrice(turns: Turn[]): boolean {
  return turns.some((t) => t.role === "user" && PRICE_ASK.test(t.content));
}

// O cliente pediu o valor e ainda não recebeu nenhum "R$" depois disso?
export function priceRequestPending(turns: Turn[]): boolean {
  let asked = false;
  for (const t of turns) {
    if (t.role === "user" && PRICE_ASK.test(t.content)) asked = true;
    else if (t.role === "assistant" && /R\$\s*\d/.test(t.content)) asked = false;
  }
  return asked;
}

// A última mensagem do cliente cruzou com a última resposta da IA (chegou
// antes dela ou poucos segundos depois)? Então ele ainda não viu a pergunta.
export function crossedWithLastReply(rows: Array<{ from_me: boolean; timestamp: string }>, windowMs = 5000): boolean {
  let lastOut = -Infinity;
  let lastIn = -Infinity;
  for (const r of rows) {
    const t = Date.parse(r.timestamp);
    if (isNaN(t)) continue;
    if (r.from_me) lastOut = Math.max(lastOut, t);
    else lastIn = Math.max(lastIn, t);
  }
  if (!isFinite(lastOut) || !isFinite(lastIn)) return false;
  return lastIn - lastOut < windowMs && lastOut - lastIn < 60000;
}

// ---------- Convite para visita na hora certa ----------
// O simulador pegou a IA convidando em 3 respostas seguidas, inclusive depois
// de a cliente dizer "não vai dar pra fechar". A instrução não bastou: o
// convite é tirado da resposta quando não é a hora.

const VISIT_INVITE_SENTENCE = /(posso (te |lhe )?(receber|agendar|marcar|deixar|reservar|separar)|quer (agendar|marcar|conhecer|vir)|vir conhecer|conhec(er|endo|e) (o |nosso |de perto o )?(espa[cç]o|castelo|buffet)|conhecer pessoalmente|ver (tudo |isso |o espa[cç]o )?de pert|te receber|visit(a|inha)s?\b.*sem compromisso|(agendar|marcar|deixar) (uma |a |sua )?visit|sem compromisso|hor[aá]rios? de visita|que tal (uma |vir )|vale (muito |super |a pena |muito a pena )?(conhecer|vir)|valeria (muito )?a pena|te (passar|oferecer) (dois|2) hor[aá]rios)/i;

/** A mensagem convida para visita? */
export function hasVisitInvite(text: string): boolean {
  return VISIT_INVITE_SENTENCE.test(text || "");
}

/** O cliente falou de visita (quer conhecer, pediu horário...) */
export function clientAsksVisit(text: string): boolean {
  return /(visit|conhecer|ir a[ií]|passar a[ií]|ver (o espa[cç]o|pessoalmente)|agendar|hor[aá]rios? (de|pra|para) (visita|conhecer|ir))/i.test(text || "");
}

/**
 * Proposta de permuta, parceria ou patrocínio (influenciadora oferecendo
 * divulgação em troca da festa): a IA não aceita nem recusa — passa para a equipe.
 * "Vi a divulgação de vocês" não conta.
 */
export function asksPartnership(text: string): boolean {
  const t = text || "";
  return /(?<![\p{L}])(permuta|parceri\p{L}*|patroc[ií]n\p{L}*|collab|publipost|publi paga)(?![\p{L}])/iu.test(t) ||
    /(?<![\p{L}])em troca d[aeo]s? (divulga|post|stories|story|publi|v[ií]deo|reels|marca[çc])/iu.test(t) ||
    /(?<![\p{L}])(divulg|post|stories|story|reels|publi)\p{L}*.{0,40}em troca(?![\p{L}])/iu.test(t) ||
    (/(?<![\p{L}])(sou influenc\p{L}*|influenciador\p{L}*|\d+\s*(mil|k)\s*seguidores)(?![\p{L}])/iu.test(t) &&
      /(?<![\p{L}])(divulg\p{L}*|post\p{L}*|stories|story|reels|publi\p{L}*|troca|marcar|mostrar)(?![\p{L}])/iu.test(t));
}

export type ContactIntent = "trabalhar" | "fornecedor" | "cliente_com_festa" | "duvida_festa";

/**
 * Nem todo contato quer orçamento: quem quer trabalhar, quem quer vender algo,
 * quem já tem festa marcada, ou quem diz que "tem uma festa" e quer tirar
 * dúvida (pode ser cliente ou orçamento — a IA pergunta antes de supor).
 */
export function contactIntent(text: string): ContactIntent | null {
  const t = text || "";
  const w = (re: string) => new RegExp(`(?<![\\p{L}])(${re})(?![\\p{L}])`, "iu").test(t);
  if (w("quero trabalhar|gostaria de trabalhar|trabalhar (a[íi]|com voc[êe]s|no buffet|na empresa)|vaga(s)?( de emprego| de trabalho| para| pra)?|curr[íi]culo|emprego|freela(ncer)?|trabalhe conosco|oportunidade de trabalho|t[ãa]o contratando|est[ãa]o contratando")) return "trabalhar";
  if (w("sou (representante|vendedor[a]?|fornecedor[a]?)|represento a|gostaria de (oferecer|apresentar|divulgar) (meu|minha|nosso|nossa|os|as)|tenho (uma|um) (empresa|loja|marca) de|ofere[çc]o (servi[çc]os?|produtos?)|parceria comercial|vendemos|trabalho com (venda|revenda)")) return "fornecedor";
  if (w("j[áa] (fechei|contratei|tenho (contrato|festa marcada)|sou cliente)|sou cliente|minha festa (est[áa]|j[áa] est[áa]) marcada|festa (j[áa] )?(marcada|agendada|contratada|fechada) (com voc[êe]s|a[íi]|no buffet|dia)|tenho (uma )?festa (marcada|agendada|contratada|fechada)|contrato (da|de) festa")) return "cliente_com_festa";
  if (w("tenho uma festa|vou ter uma festa|minha festa") && w("d[úu]vida|pergunta|saber")) return "duvida_festa";
  return null;
}

// Só cumprimento, confirmação solta ou "quem é?": não diz nada sobre a festa
const FILLER_WORDS = /\b(oi+e?|ola|opa|eai|e ai|bom dia|boa tarde|boa noite|bom|boa|tudo bem|tudo bom|td bem|tdb|como vai|blz|beleza|ok|okay|certo|sim|nao|hum+|hm+|alo|obrigad[oa]|valeu|vlw|quem e voce|quem e vc|quem e|quem eh|quem fala|quem ta falando|quem esta falando)\b/g;

/**
 * A mensagem do cliente confirma que o assunto é a festa (lead do site, que
 * já chega com data e convidados)? Foto/figurinha sem texto, só um "oi" ou
 * "quem é?", e quem quer trabalhar/vender/já tem festa NÃO confirmam — aí a
 * Bia pergunta antes de mandar fotos, vídeo e PDF.
 */
export function confirmsPartyInterest(text: string): boolean {
  if (contactIntent(text)) return false;
  const words = (text || "")
    // Foto do cliente: só a legenda conta; áudio transcrito conta
    .replace(/\[Foto enviada pelo cliente[^\]]*\]/g, " ")
    .replace(/\[O cliente mandou [^\]]*\]/g, " ")
    .replace(/\[Áudio do cliente, transcrito\]:/g, " ")
    .replace(/Legenda:/g, " ")
    .replace(/\[(sticker|document|video|image|audio|location|contact)\][^\n]*/gi, " ")
    .toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(FILLER_WORDS, " ")
    .replace(/\s+/g, " ").trim();
  return words.replace(/[^a-z0-9]/g, "").length >= 2;
}

// Linha só com "---": separa o que vai antes dos materiais do que vai depois do PDF
const MATERIALS_BREAK = /\n[ \t]*-{3,}[ \t]*(?:\n|$)/;

/**
 * Resposta que vai junto com os materiais: a 1ª parte sai antes das fotos e a
 * 2ª (a pergunta) depois do PDF, para a Bia não ficar quieta no fim. Sem a
 * linha "---", a 2ª parte fica vazia (o sistema usa uma pergunta padrão).
 */
export function splitAroundMaterials(text: string): { before: string; after: string } {
  const m = MATERIALS_BREAK.exec(text || "");
  if (!m) return { before: (text || "").trim(), after: "" };
  return { before: text.slice(0, m.index).trim(), after: text.slice(m.index + m[0].length).replace(MATERIALS_BREAK, "\n\n").trim() };
}

/** Tira a linha "---" de uma resposta que não vai com materiais */
export function dropMaterialsBreak(text: string): string {
  let out = text || "";
  while (MATERIALS_BREAK.test(out)) out = out.replace(MATERIALS_BREAK, "\n\n");
  return out.trim();
}

/** Pergunta depois do PDF quando a IA não escreveu a 2ª parte */
export function closingAfterMaterials(firstName: string, seed: number): string {
  const name = firstName ? `, ${firstName}` : "";
  const options = [
    `E aí${name}, o que achou do nosso espaço? 😍✨`,
    `Dá uma olhadinha com calma e me conta${name}: o que achou? 😊✨`,
    `Me conta${name}: curtiu o espaço? 🥰🎈`,
  ];
  return options[Math.abs(seed) % options.length];
}

/**
 * Depois do PDF, quando ainda não sabemos o DIA da festa (só o mês): perguntar
 * o dia para conferir na agenda — o convite para visita vem na resposta
 * seguinte, já com a data conferida (Castelo, 22/10).
 */
export function askPartyDayAfterMaterials(firstName: string, month: string | null | undefined, seed: number): string {
  const name = firstName ? `, ${firstName}` : "";
  const m = String(month || "").trim().toLowerCase().replace(/\s+de\s+\d{4}$/, "");
  const when = m ? ` em ${m}` : "";
  const options = [
    `Já te mandei tudo pra vocês verem com calma${name} 🥳\n\nVocês já têm um dia em mente${when}? Assim já confiro aqui na agenda se está livre 😊`,
    `Dá uma olhadinha com calma${name} 😍\n\nE me conta: já tem um dia certinho${when}? Eu confiro agora na agenda se está livre ✨`,
  ];
  return options[Math.abs(seed) % options.length];
}

/** Ainda não sabemos o dia da festa (só o mês) e ainda não perguntamos */
export function needsPartyDay(bd: Record<string, unknown> | null | undefined): boolean {
  const b = bd || {};
  const hasDay = typeof b.data_festa === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.data_festa);
  return !hasDay && !b.dia_perguntado && !!b.mes;
}

const WEEKDAY_NAMES = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** "amanhã às 10h", "quinta (22/10) às 15h30" */
export function friendlyVisitSlot(slot: { date: string; time: string }, todayYmd: string): string {
  const noon = (ymd: string) => Date.parse(`${ymd}T12:00:00Z`);
  const diff = Math.round((noon(slot.date) - noon(todayYmd)) / 86400000);
  const [, mo, d] = slot.date.split("-");
  const day = diff === 0 ? "hoje" : diff === 1 ? "amanhã" : `${WEEKDAY_NAMES[new Date(noon(slot.date)).getUTCDay()]} (${d}/${mo})`;
  const hour = slot.time.endsWith(":00") ? `${Number(slot.time.slice(0, 2))}h` : slot.time.slice(0, 5).replace(/^0/, "").replace(":", "h");
  return `${day} às ${hour}`;
}

/**
 * Depois do PDF: convite para conhecer o espaço com 2 horários livres da
 * agenda (em vez de "o que achou?", que deixava a conversa parada). null =
 * sem 2 horários livres.
 */
export function visitInviteAfterMaterials(firstName: string, offers: Array<{ date: string; time: string }>, todayYmd: string, seed: number): string | null {
  if (offers.length < 2) return null;
  const [a, b] = offers.slice(0, 2).map((o) => friendlyVisitSlot(o, todayYmd));
  const name = firstName ? `, ${firstName}` : "";
  const options = [
    `Se fizer sentido pra vocês${name}, te recebo pra conhecer o espaço: ${a} ou ${b}. Qual fica melhor? 😊`,
    `Que tal vir conhecer o espaço de pertinho${name}? Tenho ${a} ou ${b}. Qual fica melhor pra vocês? 🎈✨`,
  ];
  return options[Math.abs(seed) % options.length];
}

/**
 * Preferência de dia que o cliente escreveu: "na semana", "durante a semana",
 * "dia útil" → dia de semana; "final de semana" → fim de semana. "Semana que
 * vem" e "segunda semana" não contam (são quando, não o tipo de dia).
 */
export function dayPreferenceFrom(text: string): "dia de semana" | "fim de semana" | null {
  const t = (text || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const weekend = /\b(fim|final|fins|finais) de semana\b|\bsabado ou domingo\b/.test(t);
  const weekday = /\bdias? (de|da) semana\b|\bdias? ute?is\b|\bdia util\b|\b(na|durante a|no meio da) semana\b(?! (que vem|seguinte|passada))/.test(t);
  if (weekend === weekday) return null;
  return weekend ? "fim de semana" : "dia de semana";
}

/** O cliente desistiu / disse que não vai fechar agora */
export function clientDeclined(text: string): boolean {
  return /(n[aã]o vai dar|n[aã]o d[aá] pra|n[aã]o vou (fechar|conseguir)|desist|fica pra (pr[oó]xima|outra)|sem interesse|n[aã]o tenho interesse|acho que n[aã]o|vou procurar outro|muito caro pra mim)/i.test(text || "");
}

/**
 * Remove da resposta as frases que convidam para visita (o resto fica). Se
 * sobrar quase nada, devolve a resposta original.
 */
// Pergunta que só faz sentido junto do convite cortado ("Qual horário fica melhor?")
const ORPHAN_VISIT_QUESTION = /(?:^|[\s,])(?:qual|quais)\s+(?:hor[aá]rio|hor[aá]rios|dia|dos dois|das duas|op[cç][aã]o|deles|delas|desses|dessas)[^?]*\?|(?:^|[\s,])(?:qual|o que) (?:voc[eê] )?prefere\b[^?]*\?/i;

/**
 * Resposta curta de "aceite" do cliente ("ok", "ótimo", "gostei", "pode ser"):
 * é a hora de conduzir para o próximo passo, não de travar o convite.
 */
export function clientAffirms(text: string): boolean {
  const t = (text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.split(" ").length > 6) return /^\s*(?:👍|👏|🙏|❤️|😍|🥰)+\s*$/u.test(text || "");
  return /^(ok|okay|oks|otimo|perfeito|gostei|adorei|amei|legal|show|top|beleza|blz|massa|maravilha|bacana|joia|sim|claro|pode ser|bom|muito bom|certo|entendi|ta bom|tudo bem|combinado|fechado|interessante|lindo|que lindo|gostei muito|achei otimo|achei lindo)( (sim|demais|muito|entao|obrigad[oa]))*$/.test(t);
}

export function stripVisitInvite(text: string): { text: string; removed: boolean } {
  let removed = false;
  const touched = new Set<number>(); // parágrafos de onde saiu um convite
  const paragraphs = text.split(/\n/).map((line, idx) => {
    if (!VISIT_INVITE_SENTENCE.test(line)) return line;
    touched.add(idx);
    // Frases da linha (mantém a pontuação/emojis de cada uma)
    const sentences = line.match(/[^.!?]+[.!?]+[^\p{L}\p{N}*_(]*|[^.!?]+$/gu) || [line];
    const kept = sentences.filter((sentence) => {
      if (VISIT_INVITE_SENTENCE.test(sentence)) {
        removed = true;
        return false;
      }
      return true;
    });
    return kept.join("").trim();
  });
  // Sem o convite, "Qual horário fica melhor?" (no mesmo parágrafo) fica solta: sai junto
  const cleaned = removed
    ? paragraphs.map((line, idx) => {
      if (!touched.has(idx)) return line;
      const sentences = line.match(/[^.!?]+[.!?]+[^\p{L}\p{N}*_(]*|[^.!?]+$/gu) || [line];
      return sentences.filter((sentence) => !ORPHAN_VISIT_QUESTION.test(sentence)).join("").trim();
    })
    : paragraphs;
  const out = cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!removed || out.replace(/\s/g, "").length < 15) return { text, removed: false };
  return { text: out, removed: true };
}
