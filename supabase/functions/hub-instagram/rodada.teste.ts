// Ciclo completo com banco em memória, OpenAI e Postaí falsos (nada sai para a internet).
// As artes são montadas de verdade com resvg; wasm e fontes vêm de arquivos locais.
// Não termina em .test.ts de propósito: o CI roda `deno test supabase/functions/` sem node_modules,
// e este arquivo (via imagem.ts e repo.ts) importa pacotes npm. Rodar à mão:
//   INSTAGRAM_WASM=/caminho/index_bg.wasm deno test -A --node-modules-dir=none supabase/functions/hub-instagram/rodada.teste.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { configuraRecursos } from "./imagem.ts";
import { idDoStory } from "./postai.ts";
import { VagaOcupada, type Condicao, type Filtro, type NovoPost, type Post, type Repo } from "./repo.ts";
import { vagasProximas } from "./pauta.ts";
import { acaoNoPost, avancaEtapa, gravarConfig, lerConfig, listar, manutencao, postDeTeste, rodada } from "./rodada.ts";

const AQUI = new URL(".", import.meta.url).pathname;
const wasm = Deno.env.get("INSTAGRAM_WASM");
const pular = !wasm;

configuraRecursos({
  wasm: () => Deno.readFile(wasm!),
  fontes: async () => [
    await Deno.readFile(`${AQUI}../../../public/fonts/instagram/Nunito-SemiBold.ttf`),
    await Deno.readFile(`${AQUI}../../../public/fonts/instagram/Nunito-ExtraBold.ttf`),
  ],
});

// ------------------------------------------------------------------ banco em memória

function repoMemoria(): Repo & { linhas: Post[]; cfg: Map<string, { valor: string; booleano: boolean | null }> } {
  const linhas: Post[] = [];
  const cfg = new Map<string, { valor: string; booleano: boolean | null }>([
    ["aprovacao_manual", { valor: "nao", booleano: false }],
    ["pausado", { valor: "sim", booleano: true }],
    ["rodada_em", { valor: new Date(0).toISOString(), booleano: null }],
  ]);
  const bate = (p: Post, f: Filtro) =>
    (!f.status || f.status.includes(p.status)) &&
    (!f.vagaDesde || p.vaga >= f.vagaDesde) &&
    (!f.vagaAte || p.vaga < f.vagaAte) &&
    (f.teste === undefined || p.teste === f.teste);
  const ativo = (p: Post) => !["recusado", "refazer"].includes(p.status);
  const conflito = (p: Post) => ativo(p) && linhas.some((o) => o.id !== p.id && o.vaga === p.vaga && ativo(o));
  const copia = <T>(x: T): T => structuredClone(x);
  return {
    linhas,
    cfg,
    config: async () => new Map(cfg),
    gravaConfig: async (chave, valor, booleano) => void cfg.set(chave, { valor, booleano }),
    trava: async (agora, limite) => {
      if (cfg.get("rodada_em")!.valor >= limite) return false;
      cfg.set("rodada_em", { valor: agora, booleano: null });
      return true;
    },
    solta: async () => void cfg.set("rodada_em", { valor: new Date(0).toISOString(), booleano: null }),
    posts: async (f) =>
      copia(linhas.filter((p) => bate(p, f)).sort((a, b) => a.vaga.localeCompare(b.vaga) || b.criado_em.localeCompare(a.criado_em))),
    post: async (id) => copia(linhas.find((p) => p.id === id) ?? null),
    recentes: async (n) => linhas.slice(-n).reverse().map((p) => ({ tema: p.tema, cenario: p.cenario })),
    insere: async (n: NovoPost) => {
      const agora = new Date().toISOString();
      const p: Post = { motivo: null, tentativas: 0, gerando_desde: null, postai_id: null, instagram_url: null, criado_em: agora, atualizado_em: agora, ...n } as Post;
      if (conflito(p)) throw new VagaOcupada("ocupada");
      linhas.push(copia(p));
      return copia(p);
    },
    atualiza: async (id, campos, c: Condicao = {}) => {
      const p = linhas.find((x) => x.id === id);
      if (!p) return null;
      if (c.status && !c.status.includes(p.status)) return null;
      if (c.livreAntes && p.gerando_desde && p.gerando_desde >= c.livreAntes) return null;
      const novo = { ...p, ...copia(campos), atualizado_em: new Date().toISOString() };
      if (conflito(novo)) throw new VagaOcupada("ocupada");
      Object.assign(p, novo);
      return copia(p);
    },
    atualizaVarios: async (f, campos, antes) => {
      let n = 0;
      for (const p of linhas) {
        if (!bate(p, f) || (antes && p.atualizado_em >= antes)) continue;
        Object.assign(p, copia(campos), { atualizado_em: new Date().toISOString() });
        n++;
      }
      return n;
    },
    sobe: async (caminho) => `https://storage.test/${caminho}`,
  };
}

// ------------------------------------------------------------------ OpenAI e Postaí falsos

type PostLa = { id: string; external_id: string; formato: string; horario: string; midias: string[]; legenda?: string; hashtags?: string; status: string };

function internetFalsa() {
  const postai = new Map<string, PostLa>();
  const chamadas: { metodo: string; url: string; corpo?: Record<string, unknown> }[] = [];
  const falhas = { imagem: 0, postai: 0 as number, postaiStatus: 422, modelosSumidos: [] as string[] };
  const jpeg = Deno.readFileSync(`${AQUI}../../../src/assets/espaco-carrossel-poster-interna-2.jpg`);
  let b64 = "";
  for (let i = 0; i < jpeg.length; i += 0x8000) b64 += String.fromCharCode(...jpeg.subarray(i, i + 0x8000));
  b64 = btoa(b64);
  let seq = 0;
  const resposta = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

  const fetchFalso = async (entrada: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(entrada instanceof Request ? entrada.url : entrada);
    const metodo = init.method || "GET";
    const corpo = init.body ? JSON.parse(String(init.body)) : undefined;
    chamadas.push({ metodo, url, corpo });
    if (url.endsWith("/chat/completions")) {
      const pedido = JSON.parse(corpo.messages[1].content);
      const carrossel = pedido.tipo_de_post === "carrossel";
      return resposta({
        choices: [{
          message: {
            content: JSON.stringify({
              titulo: "Quem responde primeiro, fecha",
              pergunta: "Quanto tempo seu buffet leva para responder?",
              legenda: "A mãe pediu orçamento para vários buffets ao mesmo tempo.\n\nCom a Celebrei, seu buffet responde no WhatsApp na hora, com fotos e pacotes.\n\nCrie sua conta grátis em hubcelebrei.com.br.",
              hashtags: ["buffetinfantil", "festainfantil", "donodebuffet", "atendimento", "funildevendas", "vendas", "festas", "eventos"],
              ...(carrossel ? { pontos: [{ titulo: "Resposta em segundos", texto: "O atendimento responde com os pacotes do buffet." }, { titulo: "Convite para a visita", texto: "O cliente já é convidado para conhecer o espaço." }] } : {}),
            }),
          },
        }],
      });
    }
    if (url.endsWith("/images/generations")) {
      if (falhas.modelosSumidos.includes(corpo.model)) {
        return resposta({ error: { message: `The model '${corpo.model}' does not exist.` } }, 400);
      }
      if (falhas.imagem > 0) {
        falhas.imagem--;
        return resposta({ error: { message: "Billing hard limit has been reached" } }, 400);
      }
      assertEquals(corpo.size, "1536x1024");
      assertEquals(corpo.output_format, "jpeg");
      return resposta({ data: [{ b64_json: b64 }] });
    }
    if (url.startsWith("https://postai.test/api/v1/posts")) {
      assertEquals((init.headers as Record<string, string>).Authorization, "Bearer pa_teste");
      if (metodo === "POST") {
        if (falhas.postai > 0) {
          falhas.postai--;
          return resposta({ ok: false, erro: "falha", erros: [{ campo: "midias[0]", codigo: "PROPORCAO", mensagem: "fora" }] }, falhas.postaiStatus);
        }
        const existente = [...postai.values()].find((p) => p.external_id === corpo.external_id);
        if (existente) return resposta({ ok: true, criado: false, post: existente });
        const p: PostLa = { id: `pa${++seq}`, ...corpo, status: corpo.status };
        postai.set(p.id, p);
        return resposta({ ok: true, criado: true, post: { ...p, motivo_falha: null, link_instagram: null } }, 201);
      }
      const ext = new URL(url).searchParams.get("external_id");
      const id = decodeURIComponent(url.split("/posts/")[1] || "");
      const p = ext ? [...postai.values()].find((x) => x.external_id === ext) : postai.get(id);
      if (!p) return resposta({ ok: false, erro: "não existe" }, 404);
      if (metodo === "DELETE") {
        postai.delete(p.id);
        return resposta({ ok: true });
      }
      return resposta({ ok: true, post: { ...p, motivo_falha: null, link_instagram: p.status === "publicado" ? `https://instagram.com/p/${p.id}` : null } });
    }
    throw new Error(`internet de verdade no teste: ${url}`);
  };
  return { postai, chamadas, falhas, fetchFalso };
}

function ambiente() {
  Deno.env.set("OPENAI_API_KEY", "sk-teste");
  Deno.env.set("POSTAI_API_KEY", "pa_teste");
  Deno.env.set("POSTAI_URL", "https://postai.test/api/v1");
  const net = internetFalsa();
  const original = globalThis.fetch;
  globalThis.fetch = net.fetchFalso as typeof fetch;
  return { ...net, restaura: () => (globalThis.fetch = original) };
}

const opcoes = { ignore: pular, sanitizeResources: false, sanitizeOps: false };

// ------------------------------------------------------------------ cenários

Deno.test({ name: "nasce pausado: a rodada não cria nada", ...opcoes }, async () => {
  const net = ambiente();
  try {
    const repo = repoMemoria();
    const log = await rodada(repo, "teste");
    assertEquals(repo.linhas.length, 0);
    assert(log.some((l) => l.mensagem.includes("pausada")));
    assertEquals(net.chamadas.length, 0);
  } finally {
    net.restaura();
  }
});

Deno.test({ name: "post de teste: 1 foto, daqui ~30 min, vai ao Postaí sem Story mesmo pausado", ...opcoes }, async () => {
  const net = ambiente();
  try {
    const repo = repoMemoria();
    const r = await postDeTeste(repo);
    assert(r.vaga.endsWith("-03:00"));
    const p = repo.linhas[0];
    assertEquals(p.status, "enviado");
    assertEquals(p.tipo, "foto");
    assertEquals(p.midias.length, 1);
    assertEquals(net.postai.size, 1);
    const la = [...net.postai.values()][0];
    assertEquals(la.formato, "feed");
    assertEquals(la.status, "agendado");
    assertEquals(la.external_id, p.id);
    assertEquals(la.horario, r.vaga);
    const minutos = (new Date(la.horario).getTime() - Date.now()) / 60e3;
    assert(minutos >= 29 && minutos <= 36, `horário a ${minutos} min`);
    assert(!net.chamadas.some((c) => c.corpo?.formato === "story"));
  } finally {
    net.restaura();
  }
});

Deno.test({ name: "ligado: preenche 3 dias, monta as imagens etapa por etapa e envia feed + Story", ...opcoes }, async () => {
  const net = ambiente();
  try {
    const repo = repoMemoria();
    await gravarConfig(repo, "pausado", false);
    const inicio = (await lerConfig(repo)).inicio;
    assert(inicio, "início do ritmo gravado ao ligar");
    const esperadas = vagasProximas(inicio, 3).length;
    for (let i = 0; i < 40; i++) {
      await rodada(repo, "teste");
      if (repo.linhas.length === esperadas && repo.linhas.every((p) => p.status === "enviado")) break;
    }
    assertEquals(repo.linhas.length, esperadas);
    for (const p of repo.linhas) {
      assertEquals(p.status, "enviado", `${p.tipo} ${p.vaga}: ${p.motivo}`);
      assertEquals(p.midias.length, p.plano.length);
      if (p.tipo === "carrossel") assertEquals(p.midias.length, 4);
      const feed = [...net.postai.values()].find((x) => x.external_id === p.id)!;
      assertEquals(feed.formato, p.tipo === "carrossel" ? "carrossel" : "feed");
      assertEquals(feed.midias, p.midias);
      const story = [...net.postai.values()].find((x) => x.external_id === idDoStory(p.id))!;
      assertEquals(story.formato, "story");
      assertEquals(story.midias, [p.midias[0]]);
      assertEquals(story.horario, feed.horario);
    }
    // Assunto alterna 2:1 e nenhuma imagem foi pedida duas vezes para a mesma etapa.
    assert(repo.linhas.some((p) => p.publico === "gestao"));
    const fotos = net.chamadas.filter((c) => c.url.endsWith("/images/generations")).length;
    assertEquals(fotos, repo.linhas.length);

    // Gerar outro: cancela feed e Story no Postaí e já monta a 1ª imagem do novo.
    const alvo = repo.linhas.find((p) => p.tipo === "carrossel") ?? repo.linhas[0];
    const r = await acaoNoPost(repo, alvo.id, "refazer");
    assert(!net.postai.has(alvo.postai_id!));
    assert(![...net.postai.values()].some((x) => x.external_id === idDoStory(alvo.id)));
    const novo = repo.linhas.find((p) => p.id === (r as { novo: { id: string } }).novo.id)!;
    assertEquals(novo.vaga, alvo.vaga);
    assertEquals(novo.midias.length, 1);
    while ((await acaoNoPost(repo, novo.id, "avancar")).etapa?.pronto === false);
    assertEquals(repo.linhas.find((p) => p.id === novo.id)!.status, "enviado");

    // Recusar tira do Postaí e libera o horário.
    await acaoNoPost(repo, novo.id, "recusar");
    assertEquals(repo.linhas.find((p) => p.id === novo.id)!.status, "recusado");
    assert(![...net.postai.values()].some((x) => x.external_id === novo.id));

    const painel = await listar(repo);
    assert(painel.posts.length > 0 && painel.env.postai && painel.env.openai);
  } finally {
    net.restaura();
  }
});

Deno.test({ name: "aprovação manual: espera o Aprovar; Postaí fora do ar volta para a fila; recusa vira 'falhou'", ...opcoes }, async () => {
  const net = ambiente();
  try {
    const repo = repoMemoria();
    await gravarConfig(repo, "pausado", false);
    await gravarConfig(repo, "aprovacao_manual", true);
    for (let i = 0; i < 6; i++) await rodada(repo, "teste");
    const pronto = repo.linhas.find((p) => p.status === "aguardando")!;
    assert(pronto, "deveria haver post esperando aprovação");
    assertEquals(net.postai.size, 0);

    net.falhas.postai = 1;
    net.falhas.postaiStatus = 503;
    await acaoNoPost(repo, pronto.id, "aprovar");
    assertEquals(repo.linhas.find((p) => p.id === pronto.id)!.status, "aprovado");
    await rodada(repo, "teste");
    assertEquals(repo.linhas.find((p) => p.id === pronto.id)!.status, "enviado");

    const outro = repo.linhas.find((p) => p.status === "aguardando")!;
    net.falhas.postai = 1;
    net.falhas.postaiStatus = 422;
    await acaoNoPost(repo, outro.id, "aprovar");
    const falhou = repo.linhas.find((p) => p.id === outro.id)!;
    assertEquals(falhou.status, "falhou");
    assert(falhou.motivo?.includes("PROPORCAO") || falhou.motivo?.includes("fora"));
  } finally {
    net.restaura();
  }
});

Deno.test({ name: "imagem falhando 3 vezes vira 'erro' e para de tentar", ...opcoes }, async () => {
  const net = ambiente();
  try {
    const repo = repoMemoria();
    await gravarConfig(repo, "pausado", false);
    net.falhas.imagem = 99;
    await rodada(repo, "teste"); // cria 2 e tenta a 1ª imagem
    const id = repo.linhas[0].id;
    for (let i = 0; i < 5; i++) await avancaEtapa(repo, { id });
    const p = repo.linhas.find((x) => x.id === id)!;
    assertEquals(p.status, "erro");
    assertEquals(p.tentativas, 3);
    assert(p.motivo?.includes("Billing"));
    await assertRejects(() => acaoNoPost(repo, "00000000-0000-0000-0000-000000000000", "aprovar"));
  } finally {
    net.restaura();
  }
});

Deno.test({ name: "modelo de imagem que sumiu: usa o próximo da lista", ...opcoes }, async () => {
  const net = ambiente();
  try {
    const repo = repoMemoria();
    net.falhas.modelosSumidos = ["gpt-image-2", "gpt-image-1.5", "gpt-image-1"];
    const r = await postDeTeste(repo);
    const p = repo.linhas.find((x) => x.id === r.id)!;
    assertEquals(p.status, "enviado");
    const modelos = net.chamadas.filter((c) => c.url.endsWith("/images/generations")).map((c) => (c.corpo as { model: string }).model);
    assertEquals(modelos, ["gpt-image-2", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"]);
  } finally {
    net.falhas.modelosSumidos = [];
    net.restaura();
  }
});

Deno.test({ name: "'erro' ganha nova rodada de tentativas depois de 3 h se o horário estiver longe", ...opcoes }, async () => {
  const net = ambiente();
  try {
    const repo = repoMemoria();
    await gravarConfig(repo, "pausado", false);
    net.falhas.imagem = 99;
    await rodada(repo, "teste");
    const [longe, perto] = repo.linhas;
    for (let i = 0; i < 3; i++) {
      await avancaEtapa(repo, { id: longe.id });
      await avancaEtapa(repo, { id: perto.id });
    }
    const agora = Date.now();
    // Um horário daqui a 2 dias e outro que, 3 h depois, estará a menos de 1 h.
    Object.assign(repo.linhas.find((x) => x.id === longe.id)!, { vaga: new Date(agora + 2 * 24 * 3600e3).toISOString() });
    Object.assign(repo.linhas.find((x) => x.id === perto.id)!, { vaga: new Date(agora + 3.5 * 3600e3).toISOString() });
    for (const id of [longe.id, perto.id]) assertEquals(repo.linhas.find((x) => x.id === id)!.status, "erro");

    await manutencao(repo, [], agora); // logo depois: continua em erro
    assertEquals(repo.linhas.find((x) => x.id === longe.id)!.status, "erro");

    await manutencao(repo, [], agora + 3 * 3600e3 + 60e3);
    const p = repo.linhas.find((x) => x.id === longe.id)!;
    assertEquals(p.status, "gerando");
    assertEquals(p.tentativas, 0);
    assertEquals(repo.linhas.find((x) => x.id === perto.id)!.status, "erro");
  } finally {
    net.restaura();
  }
});
