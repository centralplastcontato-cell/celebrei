import { TEMAS, escolheCenario, escolheTema, promptDaFoto, type Publico, type TipoPost } from "./catalogo.ts";
import { geraFoto, renderiza, svgCapa, svgChamada, svgPergunta, svgPonto } from "./imagem.ts";
import { escreveTexto } from "./legenda.ts";
import { hojeBrasilia, horarioBrasilia, horarioDeTeste, vagasProximas } from "./pauta.ts";
import { ErroPostai, cancelaPostEStory, consultaPost, criaPost, idDoStory } from "./postai.ts";
import { VagaOcupada, type Item, type Post, type Repo, type Status } from "./repo.ts";
import { validaReels, type DadosReels } from "./reels.ts";

const FOLGA_ENVIO_MS = 12 * 60e3; // o Postaí recusa horário no passado
const TRAVA_ETAPA_MS = 4 * 60e3; // etapa que caiu no meio volta a ficar livre depois disso
const MAX_TENTATIVAS = 3;
/** Cartões só de texto custam ~0,3 s de CPU cada; uma arte com foto ~0,8 s. Limite ~2 s por chamada. */
const CARTOES_POR_ETAPA = 3;

export type Registro = { etapa: string; mensagem: string };
export type Config = { aprovacaoManual: boolean; pausado: boolean; inicio: string | null };

export async function lerConfig(repo: Repo): Promise<Config> {
  const mapa = await repo.config();
  return {
    aprovacaoManual: mapa.get("aprovacao_manual")?.booleano ?? false,
    pausado: mapa.get("pausado")?.booleano ?? true,
    inicio: mapa.get("inicio")?.valor || null,
  };
}

/** Liga/desliga. Na primeira vez que a automação é ligada, o ritmo começa a contar (inicio = hoje). */
export async function gravarConfig(repo: Repo, chave: "aprovacao_manual" | "pausado", valor: boolean) {
  await repo.gravaConfig(chave, valor ? "sim" : "nao", valor);
  if (chave === "pausado" && !valor) {
    const cfg = await lerConfig(repo);
    if (!cfg.inicio) await repo.gravaConfig("inicio", hojeBrasilia(), null);
  }
}

const statusPronto = (manual: boolean, p: Pick<Post, "teste">): Status => (p.teste || !manual ? "aprovado" : "aguardando");

// ------------------------------------------------------------------ criação e etapas

/** Cria o post (legenda + plano das imagens) como "gerando". As imagens vêm nas etapas. */
export async function novoPost(
  repo: Repo,
  o: { vaga: Date; tipo: TipoPost; publico: Publico; teste?: boolean },
): Promise<Post> {
  const recentes = await repo.recentes(30);
  const semente = Math.floor(Date.now() / 1000) + o.vaga.getUTCHours();
  const tema = escolheTema(o.publico, recentes.map((r) => r.tema), semente);
  const cenario = escolheCenario(tema, recentes.map((r) => r.cenario), semente);
  const texto = await escreveTexto(tema, o.tipo, `${tema.imagem}, ${cenario}`, semente);

  const plano: Item[] = [];
  if (o.tipo === "pergunta") {
    plano.push({ tipo: "pergunta", prompt: promptDaFoto(tema.imagem, cenario), pergunta: texto.pergunta || tema.perguntas[0] });
  } else {
    plano.push({ tipo: "capa", prompt: promptDaFoto(tema.imagem, cenario), selo: tema.nome, titulo: texto.titulo, arraste: o.tipo === "carrossel" });
  }
  if (o.tipo === "carrossel") {
    const pontos = texto.pontos || tema.pontos;
    pontos.forEach((p, i) => plano.push({ tipo: "ponto", numero: i + 1, titulo: p.titulo, texto: p.texto }));
    plano.push({ tipo: "chamada" });
  }

  return await repo.insere({
    id: crypto.randomUUID(),
    vaga: o.vaga.toISOString(),
    tipo: o.tipo,
    publico: o.publico,
    tema: tema.id,
    cenario,
    titulo: o.tipo === "pergunta" ? texto.pergunta || texto.titulo : texto.titulo,
    legenda: texto.legenda,
    hashtags: texto.hashtags,
    plano,
    midias: [],
    status: "gerando",
    nota: texto.origem === "reserva" ? `Legenda de reserva (a IA de texto não respondeu: ${texto.erro})` : null,
    teste: Boolean(o.teste),
  });
}

/** Monta as próximas imagens do plano: uma arte com foto, ou até 3 cartões de texto. */
async function montaImagens(post: Post) {
  const novas: string[] = [];
  const arquivos: { caminho: string; dados: Uint8Array; tipo: string }[] = [];
  const total = post.plano.length;
  for (let i = post.midias.length; i < total; i++) {
    const item = post.plano[i];
    const temFoto = item.tipo === "capa" || item.tipo === "pergunta";
    if (temFoto && arquivos.length > 0) break; // foto só no começo de uma etapa
    if (!temFoto && arquivos.length >= CARTOES_POR_ETAPA) break;
    let svg: string;
    if (item.tipo === "capa" || item.tipo === "pergunta") {
      const foto = await geraFoto(item.prompt);
      // Guarda a foto crua (sem o acabamento) para poder refazer a arte depois.
      arquivos.push({ caminho: `posts/${post.id}/${i + 1}-foto.${foto.mime === "image/jpeg" ? "jpg" : "png"}`, dados: decodifica(foto.b64), tipo: foto.mime });
      svg = item.tipo === "capa"
        ? svgCapa({ foto, selo: item.selo, titulo: item.titulo, arraste: item.arraste })
        : svgPergunta({ foto, pergunta: item.pergunta });
    } else if (item.tipo === "ponto") {
      svg = svgPonto({ numero: item.numero, pagina: i + 1, total, titulo: item.titulo, texto: item.texto });
    } else {
      svg = svgChamada({ pagina: i + 1, total });
    }
    const png = await renderiza(svg);
    arquivos.push({ caminho: `posts/${post.id}/${i + 1}.png`, dados: png, tipo: "image/png" });
    novas.push(`posts/${post.id}/${i + 1}.png`);
    if (temFoto) break;
  }
  return { novas, arquivos };
}

function decodifica(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type ResultadoEtapa = { id: string; feitas: number; total: number; pronto: boolean; erro?: string } | null;

/**
 * Avança UMA etapa de um post "gerando" (o indicado, ou o de horário mais próximo).
 * O post é "reservado" (gerando_desde) para que o cron e o painel nunca façam a mesma etapa juntos.
 */
export async function avancaEtapa(repo: Repo, o: { id?: string; incluiNaoTeste?: boolean } = {}): Promise<ResultadoEtapa> {
  const agora = Date.now();
  const livreAntes = new Date(agora - TRAVA_ETAPA_MS).toISOString();
  let candidatos: Post[];
  if (o.id) {
    const p = await repo.post(o.id);
    candidatos = p && p.status === "gerando" ? [p] : [];
  } else {
    candidatos = (await repo.posts({ status: ["gerando"] })).filter((p) => o.incluiNaoTeste !== false || p.teste);
  }
  let post: Post | null = null;
  for (const c of candidatos) {
    post = await repo.atualiza(c.id, { gerando_desde: new Date(agora).toISOString() }, { status: ["gerando"], livreAntes });
    if (post) break;
  }
  if (!post) return null;

  const total = post.plano.length;
  try {
    const { novas, arquivos } = await montaImagens(post);
    const urls = new Map<string, string>();
    for (const a of arquivos) urls.set(a.caminho, await repo.sobe(a.caminho, a.dados, a.tipo));
    const midias = [...post.midias, ...novas.map((c) => urls.get(c)!)];
    const pronto = midias.length >= total;
    const cfg = await lerConfig(repo);
    await repo.atualiza(
      post.id,
      { midias, gerando_desde: null, tentativas: 0, motivo: null, ...(pronto ? { status: statusPronto(cfg.aprovacaoManual, post) } : {}) },
      { status: ["gerando"] }, // se foi recusado no meio, não ressuscita
    );
    return { id: post.id, feitas: midias.length, total, pronto };
  } catch (e) {
    const tentativas = post.tentativas + 1;
    const msg = (e as Error).message;
    const desiste = tentativas >= MAX_TENTATIVAS;
    await repo.atualiza(
      post.id,
      {
        gerando_desde: null,
        tentativas,
        motivo: desiste ? `Não consegui gerar a imagem (${MAX_TENTATIVAS} tentativas): ${msg}` : `Tentativa ${tentativas} de ${MAX_TENTATIVAS} falhou, tento de novo: ${msg}`,
        ...(desiste ? { status: "erro" as Status } : {}),
      },
      { status: ["gerando"] },
    );
    return { id: post.id, feitas: post.midias.length, total, pronto: false, erro: msg };
  }
}

// ------------------------------------------------------------------ Postaí

/**
 * Envia UM post ao Postaí. "Reserva" o post antes (status enviando) para que dois envios
 * ao mesmo tempo (rodada + aprovação no painel) nunca mandem o mesmo post duas vezes.
 * Junto vai uma cópia em Story (post separado, external_id "<id>-story"), menos no post de teste.
 */
export async function enviaAoPostai(repo: Repo, id: string, log: Registro[] = []) {
  const p = await repo.atualiza(id, { status: "enviando" }, { status: ["aguardando", "aprovado"] });
  if (!p) return log;
  const horario = horarioBrasilia(new Date(p.vaga));
  try {
    const post = await enviaFeed(p, horario);
    await repo.atualiza(p.id, { status: "enviado", postai_id: post.id, motivo: null });
    log.push({ etapa: "envio", mensagem: `enviado ao Postaí: ${p.tema} (${horario})` });
    // Reels não ganha cópia no Story (Story de vídeo vai até 60 s)
    if (!p.teste && p.tipo !== "reels") {
      try {
        await criaPost({ formato: "story", horario, midias: [p.midias[0]], status: "agendado", external_id: idDoStory(p.id) });
      } catch (e) {
        log.push({ etapa: "envio", mensagem: `Story não foi junto (${p.tema}): ${(e as Error).message}` });
      }
    }
  } catch (e) {
    const erro = e as ErroPostai;
    await repo.atualiza(p.id, erro.reenviar ? { status: "aprovado" } : { status: "falhou", motivo: erro.message });
    log.push({
      etapa: "envio",
      mensagem: erro.reenviar ? `Postaí indisponível, tenta de novo na próxima rodada: ${erro.message}` : `recusado pelo Postaí: ${erro.message}`,
    });
  }
  return log;
}

function enviaFeed(p: Post, horario: string) {
  if (p.tipo === "reels") {
    return criaPost({
      formato: "reels",
      horario,
      midias: [p.midias[0]],
      ...(p.midias[1] ? { capa: p.midias[1] } : {}),
      legenda: p.legenda,
      hashtags: p.hashtags,
      status: "agendado",
      external_id: p.id,
    });
  }
  return criaPost({
    formato: p.tipo === "carrossel" ? "carrossel" : "feed",
    horario,
    midias: p.midias,
    legenda: p.legenda,
    hashtags: p.hashtags,
    status: "agendado",
    external_id: p.id,
  });
}

/** Marca perdidos, envia ao Postaí o que está pronto e confere o que já foi enviado. */
export async function manutencao(repo: Repo, log: Registro[] = [], agora = Date.now()) {
  const cfg = await lerConfig(repo);
  const limiteEnvio = new Date(agora + FOLGA_ENVIO_MS).toISOString();

  // 1. Perdidos: o horário chegou e o post não foi enviado.
  const perdidos = await repo.atualizaVarios(
    { status: ["gerando", "aguardando", "aprovado"], vagaAte: limiteEnvio },
    { status: "perdido", motivo: "O horário passou antes do envio ao Postaí.", gerando_desde: null },
  );
  if (perdidos) log.push({ etapa: "perdidos", mensagem: `${perdidos} post(s) perderam o horário` });

  // Envio interrompido no meio (ex.: a função caiu): volta para a fila.
  await repo.atualizaVarios({ status: ["enviando"] }, { status: "aprovado" }, new Date(agora - 5 * 60e3).toISOString());

  // Imagem que desistiu ("erro") ganha nova rodada de tentativas a cada 3 h enquanto o horário
  // estiver longe: uma falha da OpenAI que passa (ex.: modelo trocado em 26/10/2026) não deixa
  // o horário vazio para sempre.
  await repo.atualizaVarios(
    { status: ["erro"], vagaDesde: new Date(agora + 60 * 60e3).toISOString() },
    { status: "gerando", tentativas: 0, gerando_desde: null, motivo: "Tentando gerar a imagem de novo." },
    new Date(agora - 3 * 3600e3).toISOString(),
  );

  // 2. Envio: aprovados (ou aguardando, com a aprovação manual desligada). Pausado: só o de teste.
  await enviaProntos(repo, cfg, log);

  // 3. Conferência dos enviados cujo horário já chegou.
  const enviados = await repo.posts({
    status: ["enviado"],
    vagaDesde: new Date(agora - 3 * 24 * 3600e3).toISOString(),
    vagaAte: new Date(agora).toISOString(),
  });
  for (const p of enviados) {
    if (!p.postai_id) continue;
    try {
      const la = await consultaPost(p.postai_id);
      if (!la) {
        await repo.atualiza(p.id, { status: "recusado", motivo: "Recusado ou apagado no painel do Postaí." }, { status: ["enviado"] });
      } else if (la.status === "publicado") {
        await repo.atualiza(p.id, { status: "publicado", instagram_url: la.link_instagram, motivo: null }, { status: ["enviado"] });
        log.push({ etapa: "conferencia", mensagem: `publicado: ${p.tema}` });
      } else if (la.status === "falhou") {
        const motivo = `Falhou no Postaí (ele tenta de novo a cada ~10 min): ${la.motivo_falha || "sem motivo"}`;
        if (motivo !== p.motivo) await repo.atualiza(p.id, { motivo }, { status: ["enviado"] });
      }
    } catch (e) {
      log.push({ etapa: "conferencia", mensagem: (e as Error).message });
    }
  }
  return log;
}

async function enviaProntos(repo: Repo, cfg: Config, log: Registro[]) {
  const prontos = await repo.posts({ status: cfg.aprovacaoManual ? ["aprovado"] : ["aguardando", "aprovado"] });
  for (const p of prontos) {
    // Vídeo postado à mão vai mesmo com a automação pausada
    if (cfg.pausado && !p.teste && p.tipo !== "reels") continue;
    await enviaAoPostai(repo, p.id, log);
  }
}

// ------------------------------------------------------------------ rodada

/** Cria os posts das vagas livres dos próximos 3 dias (só legenda; as imagens vêm nas etapas). */
export async function preencheVagas(repo: Repo, cfg: Config, log: Registro[], maximo = 2, agora = new Date()) {
  const vagas = vagasProximas(cfg.inicio || hojeBrasilia(agora), 3, agora);
  if (!vagas.length) return 0;
  const ativos = await repo.posts({ vagaDesde: vagas[0].vaga.toISOString() });
  const tomadas = new Set(ativos.filter((p) => !["recusado", "refazer"].includes(p.status)).map((p) => new Date(p.vaga).getTime()));
  let feitos = 0;
  for (const v of vagas) {
    if (tomadas.has(v.vaga.getTime())) continue;
    if (feitos >= maximo) break;
    try {
      const p = await novoPost(repo, { vaga: v.vaga, tipo: v.tipo, publico: v.publico });
      log.push({ etapa: "gerar", mensagem: `novo ${p.tipo} (${p.tema}) para ${horarioBrasilia(v.vaga)}` });
      feitos++;
    } catch (e) {
      if (e instanceof VagaOcupada) continue;
      log.push({ etapa: "gerar", mensagem: `falhou ao criar o post de ${horarioBrasilia(v.vaga)}: ${(e as Error).message}` });
      break;
    }
  }
  return feitos;
}

/** Rodada completa (cron a cada 10 min ou botão "Rodar agora"). Idempotente. */
export async function rodada(repo: Repo, origem: string): Promise<Registro[]> {
  const inicio = Date.now();
  const travou = await repo.trava(new Date(inicio).toISOString(), new Date(inicio - 5 * 60e3).toISOString());
  if (!travou) return [{ etapa: "rodada", mensagem: "já existe uma rodada em andamento (aguarde alguns minutos)" }];
  const log: Registro[] = [{ etapa: "rodada", mensagem: `início (${origem})` }];
  try {
    await manutencao(repo, log);
    const cfg = await lerConfig(repo);
    if (cfg.pausado) log.push({ etapa: "gerar", mensagem: "automação pausada no painel" });
    else await preencheVagas(repo, cfg, log);
    // Uma etapa de imagem por rodada (limite de CPU), começando pelo horário mais próximo.
    // Só se sobrou tempo: a foto leva até ~2 min.
    if (Date.now() - inicio < 25_000) {
      const r = await avancaEtapa(repo, { incluiNaoTeste: !cfg.pausado });
      if (r) log.push({ etapa: "imagens", mensagem: r.erro ? `falhou: ${r.erro}` : `post ${r.id.slice(0, 8)}: ${r.feitas}/${r.total} imagem(ns)` });
      if (r?.pronto) await enviaProntos(repo, await lerConfig(repo), log);
    }
  } finally {
    await repo.solta();
  }
  return log;
}

// ------------------------------------------------------------------ ações do painel

export class ErroAcao extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

function exigeChaves(...nomes: ("OPENAI_API_KEY" | "POSTAI_API_KEY")[]) {
  const faltam = nomes.filter((n) => !Deno.env.get(n));
  if (faltam.length) throw new ErroAcao(`Falta configurar nos segredos do Supabase: ${faltam.join(" e ")}.`, 412);
}

/** Termina de gerar um post na hora (o painel espera). Feed = 1 etapa; carrossel = 2. */
async function terminaDeGerar(repo: Repo, id: string, etapasMax: number) {
  let r: ResultadoEtapa = null;
  for (let i = 0; i < etapasMax; i++) {
    r = await avancaEtapa(repo, { id });
    if (!r || r.pronto || r.erro) break;
  }
  return r;
}

/** Post de teste: 1 foto no feed, daqui ~30 min, enviado ao Postaí sem Story, mesmo com a automação pausada. */
export async function postDeTeste(repo: Repo) {
  exigeChaves("OPENAI_API_KEY", "POSTAI_API_KEY");
  let vaga = horarioDeTeste();
  let post: Post | null = null;
  for (let i = 0; i < 4 && !post; i++) {
    try {
      post = await novoPost(repo, { vaga, tipo: "foto", publico: "vendas", teste: true });
    } catch (e) {
      if (!(e instanceof VagaOcupada)) throw e;
      vaga = new Date(vaga.getTime() + 5 * 60e3);
    }
  }
  if (!post) throw new ErroAcao("Não achei um horário livre para o teste. Tente de novo em alguns minutos.", 409);
  const etapa = await terminaDeGerar(repo, post.id, 1);
  if (!etapa?.pronto) {
    throw new ErroAcao(`O post de teste foi criado, mas a imagem falhou (${etapa?.erro || "sem resposta"}). A rodada automática tenta de novo.`, 502);
  }
  const log = await enviaAoPostai(repo, post.id);
  return { id: post.id, vaga: horarioBrasilia(vaga), envio: log[0]?.mensagem ?? null };
}

/** Vídeo (Reels) postado à mão no painel: já nasce aprovado e vai na hora ao Postaí, mesmo pausado. */
export async function novoReels(repo: Repo, dados: DadosReels, agora = Date.now()) {
  exigeChaves("POSTAI_API_KEY");
  const r = validaReels(dados, agora + FOLGA_ENVIO_MS);
  if ("erro" in r) throw new ErroAcao(r.erro);
  let post: Post;
  try {
    post = await repo.insere({
      id: crypto.randomUUID(),
      vaga: r.vaga.toISOString(),
      tipo: "reels",
      publico: "vendas",
      tema: "video",
      cenario: "",
      titulo: r.titulo,
      legenda: r.legenda,
      hashtags: r.hashtags,
      plano: [],
      midias: r.capa ? [r.video, r.capa] : [r.video],
      status: "aprovado",
      nota: null,
      teste: false,
    });
  } catch (e) {
    if (e instanceof VagaOcupada) throw new ErroAcao("Já tem um post nesse horário. Escolha outro (por exemplo, 5 minutos depois).", 409);
    throw e;
  }
  const log = await enviaAoPostai(repo, post.id);
  return { id: post.id, vaga: horarioBrasilia(r.vaga), envio: log[0]?.mensagem ?? null };
}

export type AcaoPost = "aprovar" | "recusar" | "refazer" | "editar" | "avancar";

export async function acaoNoPost(repo: Repo, id: string, acao: AcaoPost, corpo: { legenda?: string; hashtags?: string } = {}) {
  const post = await repo.post(id);
  if (!post) throw new ErroAcao("Post não encontrado.", 404);
  switch (acao) {
    case "aprovar": {
      if (!["aguardando", "falhou", "recusado"].includes(post.status)) return { resumo: null };
      if (new Date(post.vaga).getTime() - Date.now() < FOLGA_ENVIO_MS) {
        throw new ErroAcao("O horário deste post já passou (ou falta menos de 12 min). Use “Gerar outro” num horário futuro.", 409);
      }
      if (post.postai_id && post.status !== "aguardando") await cancelaPostEStory(post.postai_id, post.id); // libera o external_id
      const ok = await repo.atualiza(id, { status: "aprovado", postai_id: null, motivo: null }, { status: [post.status] });
      if (!ok) throw new ErroAcao("O post mudou enquanto você aprovava. Atualize a tela.", 409);
      const cfg = await lerConfig(repo);
      if (cfg.pausado && !post.teste && post.tipo !== "reels") return { resumo: "Aprovado. A automação está pausada: ele vai ao Postaí quando você despausar." };
      const log = await enviaAoPostai(repo, id);
      return { resumo: log[0]?.mensagem ?? null };
    }
    case "recusar":
    case "refazer": {
      if (post.status === "publicado") throw new ErroAcao("Já foi publicado.", 409);
      if (acao === "refazer" && post.tipo === "reels") throw new ErroAcao("Vídeo não tem “Gerar outro”: recuse e poste o vídeo de novo.");
      if (acao === "refazer") exigeChaves("OPENAI_API_KEY");
      if (post.postai_id) await cancelaPostEStory(post.postai_id, post.id);
      await repo.atualiza(id, {
        status: acao === "recusar" ? "recusado" : "refazer",
        postai_id: null,
        gerando_desde: null,
        motivo: acao === "refazer" ? "Outro post será gerado para este horário." : null,
      });
      if (acao === "recusar") return { resumo: null };
      if (new Date(post.vaga).getTime() - Date.now() < FOLGA_ENVIO_MS) {
        return { resumo: "O post saiu. O horário dele já está muito perto, então não gerei outro." };
      }
      try {
        const novo = await novoPost(repo, { vaga: new Date(post.vaga), tipo: post.tipo as TipoPost, publico: post.publico, teste: post.teste });
        const r = await avancaEtapa(repo, { id: novo.id });
        return { resumo: null, novo: { id: novo.id, feitas: r?.feitas ?? 0, total: novo.plano.length } };
      } catch (e) {
        throw new ErroAcao(`O post antigo saiu, mas não consegui gerar o novo agora (${(e as Error).message}). A próxima rodada tenta de novo.`, 502);
      }
    }
    case "editar": {
      if (!["gerando", "aguardando", "aprovado", "falhou", "erro"].includes(post.status)) {
        throw new ErroAcao("Só dá para editar antes do envio ao Postaí.", 409);
      }
      const legenda = String(corpo.legenda ?? post.legenda).slice(0, 2000);
      const hashtags = String(corpo.hashtags ?? post.hashtags).slice(0, 600);
      if ((legenda + " " + hashtags).length > 2200) throw new ErroAcao("Legenda + hashtags passam de 2.200 caracteres.");
      if ((hashtags.match(/#/g) || []).length + (legenda.match(/#/g) || []).length > 30) throw new ErroAcao("O Instagram aceita no máximo 30 hashtags.");
      await repo.atualiza(id, { legenda, hashtags });
      return { resumo: "Texto salvo." };
    }
    case "avancar": {
      if (post.status !== "gerando") return { resumo: null, etapa: { id, feitas: post.midias.length, total: post.plano.length, pronto: true } };
      const r = await avancaEtapa(repo, { id });
      if (r?.pronto) {
        const cfg = await lerConfig(repo);
        if (!cfg.pausado || post.teste) await enviaProntos(repo, cfg, []);
      }
      return { resumo: null, etapa: r ?? { id, feitas: post.midias.length, total: post.plano.length, pronto: false, ocupado: true } };
    }
    default:
      throw new ErroAcao("Ação inválida.");
  }
}

/** Dados do painel: posts de 3 dias atrás em diante (mais os que ainda estão gerando). */
export async function listar(repo: Repo) {
  const desde = new Date(Date.now() - 3 * 24 * 3600e3).toISOString();
  const [cfg, posts] = await Promise.all([lerConfig(repo), repo.posts({ vagaDesde: desde })]);
  const nomes = new Map(TEMAS.map((t) => [t.id, t.nome]));
  return {
    config: cfg,
    env: { openai: Boolean(Deno.env.get("OPENAI_API_KEY")), postai: Boolean(Deno.env.get("POSTAI_API_KEY")) },
    posts: posts.map((p) => ({
      id: p.id,
      vaga: p.vaga,
      tipo: p.tipo,
      publico: p.publico,
      tema: nomes.get(p.tema) || (p.tipo === "reels" ? "Vídeo" : p.tema),
      titulo: p.titulo,
      legenda: p.legenda,
      hashtags: p.hashtags,
      midias: p.midias,
      total: p.plano.length,
      status: p.status,
      motivo: p.motivo,
      nota: p.nota,
      teste: p.teste,
      instagramUrl: p.instagram_url,
    })),
  };
}
