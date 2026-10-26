import { initWasm, Resvg } from "npm:@resvg/resvg-wasm@2.6.2";
import { AMARELO, ARROBA, AZUL, CINZA, FUNDO, LARANJA, LOGO_512, LOGO_DEFS, ROSA, ROXO, SITE, TINTA } from "./marca.ts";

// Gera a foto com a IA de imagem da OpenAI e monta a arte da Celebrei em volta dela
// (fundo creme, degradê do chapéu de festa, logo, título e site) com resvg em WebAssembly.
// Custo de CPU: ~0,7 s por arte com foto. As Edge Functions têm ~2 s de CPU por
// chamada, por isso a rodada monta no máximo UMA arte com foto por vez.

export const LARGURA = 1080;
export const ALTURA = 1350; // 4:5, o máximo vertical aceito no feed

const MARGEM = 64;

// ---------------------------------------------------------------- recursos (wasm + fontes)

type Bytes = Uint8Array | ArrayBuffer;
export type Recursos = { wasm: () => Promise<Bytes>; fontes: () => Promise<Uint8Array[]> };

const VERSAO_RESVG = "2.6.2";
const URLS_WASM = [
  `https://unpkg.com/@resvg/resvg-wasm@${VERSAO_RESVG}/index_bg.wasm`,
  `https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@${VERSAO_RESVG}/index_bg.wasm`,
];
// As mesmas fontes que testamos localmente ficam no próprio site (public/fonts/instagram);
// o Google Fonts é a reserva.
const FONTES_DO_SITE = ["Nunito-SemiBold.ttf", "Nunito-ExtraBold.ttf"].map((f) => `https://${SITE}/fonts/instagram/${f}`);
const FONTES_GOOGLE = "https://fonts.googleapis.com/css2?family=Nunito:wght@600;800";

async function baixa(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** TTF/OTF de verdade (o site devolve o index.html com 200 quando o arquivo não existe). */
function ehFonte(b: Uint8Array) {
  const m = b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3];
  return b.length > 10_000 && (m === 0x00010000 || m === 0x4f54544f /* OTTO */ || m === 0x74727565 /* true */);
}

async function baixaWasm(): Promise<Bytes> {
  const erros: string[] = [];
  for (const url of URLS_WASM) {
    try {
      const b = await baixa(url);
      if (b[0] === 0 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d) return b; // "\0asm"
      erros.push(`${url}: não é wasm`);
    } catch (e) {
      erros.push((e as Error).message);
    }
  }
  throw new Error(`não consegui baixar o motor de imagem (${erros.join("; ")})`);
}

async function baixaFontes(): Promise<Uint8Array[]> {
  try {
    const fontes = await Promise.all(FONTES_DO_SITE.map(baixa));
    if (fontes.every(ehFonte)) return fontes;
  } catch {
    /* tenta o Google */
  }
  const css = await fetch(FONTES_GOOGLE, { signal: AbortSignal.timeout(20_000) }).then((r) => r.text());
  const urls = [...new Set([...css.matchAll(/src:\s*url\(([^)]+)\)\s*format\('(?:truetype|opentype)'\)/g)].map((m) => m[1]))];
  if (!urls.length) throw new Error("não consegui baixar as fontes (nem do site, nem do Google Fonts)");
  const fontes = (await Promise.all(urls.slice(0, 12).map(baixa))).filter(ehFonte);
  if (!fontes.length) throw new Error("as fontes baixadas não são TTF");
  return fontes;
}

let recursos: Recursos = { wasm: baixaWasm, fontes: baixaFontes };
let wasmPronto: Promise<void> | null = null;
let fontesPromessa: Promise<Uint8Array[]> | null = null;

/** Troca a origem do wasm/fontes (os testes passam arquivos locais). Chamar antes de renderizar. */
export function configuraRecursos(r: Partial<Recursos>) {
  recursos = { ...recursos, ...r };
  fontesPromessa = null;
}

async function prepara() {
  if (!wasmPronto) {
    wasmPronto = (async () => {
      await initWasm(await recursos.wasm());
    })().catch((e) => {
      wasmPronto = null; // tenta de novo na próxima
      throw e;
    });
  }
  if (!fontesPromessa) {
    fontesPromessa = recursos.fontes().catch((e) => {
      fontesPromessa = null;
      throw e;
    });
  }
  const [, fontes] = await Promise.all([wasmPronto, fontesPromessa]);
  return fontes;
}

/** SVG 1080×1350 → PNG. */
export async function renderiza(svg: string): Promise<Uint8Array> {
  const fontes = await prepara();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: LARGURA },
    font: { fontBuffers: fontes, defaultFontFamily: "Nunito" },
  });
  try {
    const img = resvg.render();
    try {
      return img.asPng();
    } finally {
      img.free();
    }
  } finally {
    resvg.free(); // a memória do wasm não é liberada sozinha
  }
}

// ---------------------------------------------------------------- foto pela IA

export type Foto = { b64: string; mime: "image/jpeg" | "image/png" };

// Modelos tentados em ordem. Em 26/10/2026 a OpenAI passou a responder "The model 'gpt-image-1'
// does not exist" e nenhuma imagem saiu: se um modelo some, a foto vem do próximo da lista.
// OPENAI_IMAGE_MODEL (segredo do Supabase) entra na frente de todos.
const MODELOS_IMAGEM = ["gpt-image-2", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"];
let modeloQueFunciona: string | null = null;

/** Erro que significa "este modelo não existe ou esta chave não tem acesso": vale tentar o próximo. */
const modeloIndisponivel = (status: number, msg: string) =>
  (status === 400 || status === 403 || status === 404) && /model|does not exist|not found|do not have access/i.test(msg);

export async function geraFoto(prompt: string): Promise<Foto> {
  const chave = Deno.env.get("OPENAI_API_KEY");
  if (!chave) throw new Error("OPENAI_API_KEY não configurada nos segredos do Supabase.");
  const preferido = Deno.env.get("OPENAI_IMAGE_MODEL");
  const fila = [...new Set([modeloQueFunciona, preferido, ...MODELOS_IMAGEM].filter(Boolean) as string[])];
  const recusados: string[] = [];
  for (const modelo of fila) {
    const r = await fetch(`${Deno.env.get("OPENAI_BASE_URL") || "https://api.openai.com/v1"}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelo,
        prompt,
        size: "1536x1024", // a foto entra num quadro deitado, com cantos arredondados
        quality: Deno.env.get("OPENAI_IMAGE_QUALITY") || "medium",
        n: 1,
        ...(modelo.startsWith("gpt-image") ? { output_format: "jpeg" } : { response_format: "b64_json" }),
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const dados = (await r.json().catch(() => ({}))) as { data?: { b64_json?: string }[]; error?: { message?: string } };
    const b64 = dados.data?.[0]?.b64_json;
    if (r.ok && b64) {
      if (modeloQueFunciona !== modelo) console.log(`Instagram: imagem pelo modelo ${modelo}`);
      modeloQueFunciona = modelo;
      return { b64, mime: b64.startsWith("/9j/") ? "image/jpeg" : "image/png" };
    }
    const msg = dados.error?.message || "sem imagem na resposta";
    if (!modeloIndisponivel(r.status, msg)) throw new Error(`OpenAI imagem ${r.status} (${modelo}): ${msg}`.slice(0, 400));
    if (modeloQueFunciona === modelo) modeloQueFunciona = null;
    recusados.push(`${modelo}: ${msg}`);
  }
  throw new Error(`OpenAI imagem: nenhum modelo disponível (${recusados.join(" | ")})`.slice(0, 600));
}

// ---------------------------------------------------------------- texto

export function escapa(t: string) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Largura dos caracteres da Nunito ExtraBold (em "em", medida no arquivo da fonte), para quebrar
// linhas sem medir a fonte. A SemiBold é ~3,5% mais estreita. Acentos usam a letra base.
const LARGURAS: Record<string, number> = {
  a: 0.557, b: 0.61, c: 0.478, d: 0.61, e: 0.549, f: 0.382, g: 0.615, h: 0.595, i: 0.268, j: 0.273, k: 0.558, l: 0.333, m: 0.889,
  n: 0.595, o: 0.589, p: 0.61, q: 0.61, r: 0.412, s: 0.492, t: 0.404, u: 0.59, v: 0.534, w: 0.861, x: 0.559, y: 0.533, z: 0.48,
  A: 0.753, B: 0.695, C: 0.684, D: 0.774, E: 0.605, F: 0.57, G: 0.742, H: 0.78, I: 0.297, J: 0.372, K: 0.688, L: 0.573, M: 0.876,
  N: 0.753, O: 0.796, P: 0.664, Q: 0.796, R: 0.696, S: 0.641, T: 0.632, U: 0.743, V: 0.727, W: 1.12, X: 0.685, Y: 0.631, Z: 0.615,
  " ": 0.279, ".": 0.26, ",": 0.26, ":": 0.26, ";": 0.26, "!": 0.26, "?": 0.468, "'": 0.256, "\"": 0.481, "-": 0.44, "–": 0.5,
  "—": 1, "·": 0.26, "…": 0.78, "(": 0.382, ")": 0.382, "/": 0.331, "@": 0.952, "&": 0.745,
};
function larguraTexto(texto: string, tamanho: number, espacamento = 0, peso: 600 | 800 = 800) {
  let em = 0;
  for (const c of texto) {
    const base = c.normalize("NFD")[0];
    em += LARGURAS[c] ?? LARGURAS[base] ?? 0.6;
  }
  return em * tamanho * (peso === 600 ? 0.965 : 1) + espacamento * [...texto].length;
}

/** Quebra em linhas que caibam em `largura` px. Se passar de `linhasMax`, corta com reticências. */
export function quebra(texto: string, largura: number, tamanho: number, linhasMax: number, espacamento = 0, peso: 600 | 800 = 800) {
  const palavras = texto.split(/\s+/).filter(Boolean);
  const linhas: string[] = [];
  let atual = "";
  for (const p of palavras) {
    const tentativa = atual ? `${atual} ${p}` : p;
    if (atual && larguraTexto(tentativa, tamanho, espacamento, peso) > largura) {
      linhas.push(atual);
      atual = p;
    } else atual = tentativa;
  }
  if (atual) linhas.push(atual);
  if (linhas.length <= linhasMax) return { linhas, cabe: true };
  const corte = linhas.slice(0, linhasMax);
  corte[linhasMax - 1] = corte[linhasMax - 1].replace(/\s*\S*$/, "") + "…";
  return { linhas: corte, cabe: false };
}

/** Mesma quantidade de linhas, mas com larguras parecidas (evita uma palavra sozinha na última). */
export function equilibra(texto: string, largura: number, tamanho: number, linhasMax: number, espacamento = 0, peso: 600 | 800 = 800) {
  const base = quebra(texto, largura, tamanho, linhasMax, espacamento, peso);
  const n = base.linhas.length;
  if (!base.cabe || n < 2) return base;
  let menor = largura / 2;
  let maior = largura;
  for (let k = 0; k < 12; k++) {
    const meio = (menor + maior) / 2;
    const r = quebra(texto, meio, tamanho, linhasMax, espacamento, peso);
    if (r.cabe && r.linhas.length === n) maior = meio;
    else menor = meio;
  }
  return quebra(texto, maior, tamanho, linhasMax, espacamento, peso);
}

/** Escolhe o maior tamanho de fonte (da lista) em que o texto cabe em `linhasMax` linhas. */
function ajusta(texto: string, largura: number, tamanhos: number[], linhasMax: number, peso: 600 | 800 = 800, espacamentoPorPx = 0) {
  for (const t of tamanhos) {
    const r = equilibra(texto, largura, t, linhasMax, t * espacamentoPorPx, peso);
    if (r.cabe) return { tamanho: t, linhas: r.linhas };
  }
  const t = tamanhos[tamanhos.length - 1];
  return { tamanho: t, linhas: quebra(texto, largura, t, linhasMax, t * espacamentoPorPx, peso).linhas };
}

// ---------------------------------------------------------------- peças da arte

const ROSA_ESCURO = "#D23468";

const DEFS = `${LOGO_DEFS}
  <linearGradient id="marca" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="${LARANJA}"/><stop offset="0.55" stop-color="${ROSA}"/><stop offset="1" stop-color="${ROXO}"/>
  </linearGradient>
  <radialGradient id="mancha-amarela"><stop offset="0" stop-color="${AMARELO}" stop-opacity="0.34"/><stop offset="1" stop-color="${AMARELO}" stop-opacity="0"/></radialGradient>
  <radialGradient id="mancha-rosa"><stop offset="0" stop-color="${ROSA}" stop-opacity="0.2"/><stop offset="1" stop-color="${ROSA}" stop-opacity="0"/></radialGradient>
  <radialGradient id="mancha-roxa"><stop offset="0" stop-color="${ROXO}" stop-opacity="0.14"/><stop offset="1" stop-color="${ROXO}" stop-opacity="0"/></radialGradient>`;

/** Logo da Celebrei (chapéu de festa + nome), como no topo do site. */
function logo(x: number, y: number, tamanho: number, comNome = true) {
  const s = tamanho / 512;
  const nome = comNome
    ? `<text x="${x + tamanho * 1.08}" y="${y + tamanho * 0.74}" font-family="Nunito" font-weight="800" font-size="${Math.round(tamanho * 0.62)}" letter-spacing="${-tamanho * 0.012}" fill="${TINTA}">Celebrei</text>`
    : "";
  return `<g transform="translate(${x} ${y}) scale(${s})">${LOGO_512}</g>${nome}`;
}

/** Fundo creme com as manchas de cor do site (amarelo, rosa e roxo, bem suaves). */
function fundo(variante: "topo" | "centro" = "topo") {
  const m = variante === "topo"
    ? [["amarela", -120, -160, 620], ["rosa", 1180, 120, 560], ["roxa", 380, 1480, 700]]
    : [["amarela", -80, 260, 560], ["rosa", 1140, 380, 620], ["roxa", 560, 1460, 720]];
  return `<rect width="${LARGURA}" height="${ALTURA}" fill="${FUNDO}"/>` +
    m.map(([cor, cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#mancha-${cor})"/>`).join("");
}

/** Confetes soltos (os mesmos do logo), para dar clima de festa sem atrapalhar o texto. */
function confetes(lista: [number, number][]) {
  const formas = [
    (x: number, y: number) => `<rect x="${x - 5}" y="${y - 16}" width="10" height="32" rx="5" fill="${AMARELO}" transform="rotate(-24 ${x} ${y})"/>`,
    (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="10" fill="${AZUL}"/>`,
    (x: number, y: number) => `<rect x="${x - 5}" y="${y - 16}" width="10" height="32" rx="5" fill="${LARANJA}" transform="rotate(52 ${x} ${y})"/>`,
    (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="8" fill="${ROSA}"/>`,
  ];
  return lista.map(([x, y], i) => formas[i % formas.length](x, y)).join("");
}

/** Pílula com o degradê da marca e o endereço do site. */
function pilulaSite(x: number, yBase: number, tamanho = 28, alinhamento: "esquerda" | "centro" = "esquerda") {
  const h = Math.round(tamanho * 2.2);
  const w = Math.round(larguraTexto(SITE, tamanho, 0, 800) + tamanho * 1.9);
  const x0 = alinhamento === "centro" ? x - w / 2 : x;
  return `<rect x="${x0}" y="${yBase - h}" width="${w}" height="${h}" rx="${h / 2}" fill="url(#marca)"/>
    <text x="${x0 + w / 2}" y="${yBase - h / 2 + tamanho * 0.36}" text-anchor="middle" font-family="Nunito" font-weight="800" font-size="${tamanho}" fill="#FFFFFF">${SITE}</text>`;
}

function selo(x: number, y: number, texto: string) {
  const t = texto.toUpperCase();
  const tamanho = 22;
  const w = Math.round(larguraTexto(t, tamanho, 2.4) + 44);
  return `<rect x="${x}" y="${y}" width="${w}" height="46" rx="23" fill="${ROSA}" fill-opacity="0.1" stroke="${ROSA}" stroke-opacity="0.6" stroke-width="2"/>
    <text x="${x + w / 2}" y="${y + 31}" text-anchor="middle" font-family="Nunito" font-weight="800" font-size="${tamanho}" letter-spacing="2.4" fill="${ROSA_ESCURO}">${escapa(t)}</text>`;
}

/** A foto num quadro de cantos arredondados, com uma borda branca de "adesivo" como o logo. */
function quadroFoto(f: Foto, x: number, y: number, w: number, h: number) {
  const id = `quadro-${Math.round(y)}`;
  return {
    defs: `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="44"/></clipPath>`,
    corpo: `<rect x="${x - 10}" y="${y - 10}" width="${w + 20}" height="${h + 20}" rx="54" fill="#FFFFFF"/>
      <image href="data:${f.mime};base64,${f.b64}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/>`,
  };
}

/** "Arraste para o lado" com uma seta desenhada (a Nunito não tem o caractere da seta). */
function arraste(yBase: number) {
  const xSeta = LARGURA - MARGEM - 26;
  const y = yBase - 9;
  return `<text x="${xSeta - 14}" y="${yBase}" text-anchor="end" font-family="Nunito" font-weight="800" font-size="26" fill="${CINZA}" fill-opacity="0.8">Arraste para o lado</text>
    <path d="M${xSeta} ${y} H${xSeta + 24} M${xSeta + 14} ${y - 9} L${xSeta + 24} ${y} L${xSeta + 14} ${y + 9}" fill="none" stroke="${CINZA}" stroke-opacity="0.8" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function svg(conteudo: string, defsExtra = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${LARGURA}" height="${ALTURA}" viewBox="0 0 ${LARGURA} ${ALTURA}"><defs>${DEFS}${defsExtra}</defs>${conteudo}</svg>`;
}

const RODAPE_Y = ALTURA - MARGEM; // linha de base da pílula do site
const TOPO_FOTO_MIN = 470;

/** Linhas de título escuras; a última (quando há mais de uma) no degradê da marca, como no site. */
function linhasTitulo(linhas: string[], x: number, y0: number, alt: number, tamanho: number, ancora: "start" | "middle" = "start") {
  return linhas
    .map((l, i) => {
      const cor = linhas.length > 1 && i === linhas.length - 1 ? "url(#marca)" : TINTA;
      return `<text x="${x}" y="${y0 + i * alt}" text-anchor="${ancora}" font-family="Nunito" font-weight="800" font-size="${tamanho}" letter-spacing="${-tamanho * 0.02}" fill="${cor}">${escapa(l)}</text>`;
    })
    .join("");
}

/** Capa: logo, selo do tema e título grande em cima; a foto num quadro arredondado embaixo. */
export function svgCapa(o: { foto: Foto; selo: string; titulo: string; arraste?: boolean }) {
  const { tamanho, linhas } = ajusta(o.titulo, LARGURA - 2 * MARGEM, [92, 84, 76, 68], 3, 800, -0.02);
  const alt = Math.round(tamanho * 1.06);
  const y0 = 196 + 46 + 36 + tamanho * 0.8; // logo + selo + respiro
  const fimTitulo = y0 + (linhas.length - 1) * alt;
  const topoFoto = Math.max(TOPO_FOTO_MIN, Math.round(fimTitulo + 52));
  const fimFoto = RODAPE_Y - 62 - 40;
  const q = quadroFoto(o.foto, MARGEM, topoFoto, LARGURA - 2 * MARGEM, fimFoto - topoFoto);
  return svg(
    `${fundo("topo")}
    ${confetes([[880, 96], [960, 168], [1010, 70], [830, 186]])}
    ${logo(MARGEM, MARGEM, 72)}
    ${selo(MARGEM, 196, o.selo)}
    ${linhasTitulo(linhas, MARGEM, y0, alt, tamanho)}
    ${q.corpo}
    ${pilulaSite(MARGEM, RODAPE_Y)}
    ${o.arraste ? arraste(RODAPE_Y - 22) : `<text x="${LARGURA - MARGEM}" y="${RODAPE_Y - 22}" text-anchor="end" font-family="Nunito" font-weight="800" font-size="26" fill="${CINZA}" fill-opacity="0.8">${ARROBA}</text>`}`,
    q.defs,
  );
}

/** Pergunta: a foto em cima e, embaixo, a pergunta grande com o convite para comentar. */
export function svgPergunta(o: { foto: Foto; pergunta: string }) {
  const { tamanho, linhas } = ajusta(o.pergunta, LARGURA - 2 * MARGEM, [76, 68, 62, 56], 3, 800, -0.015);
  const alt = Math.round(tamanho * 1.1);
  const fimTexto = RODAPE_Y - 62 - 56;
  const yUltima = fimTexto - Math.round(tamanho * 0.22);
  const yPrimeira = yUltima - (linhas.length - 1) * alt;
  const yRotulo = yPrimeira - tamanho - 26;
  const fimFoto = yRotulo - 30 - 44 - 26;
  const topoFoto = 176;
  const q = quadroFoto(o.foto, MARGEM, topoFoto, LARGURA - 2 * MARGEM, fimFoto - topoFoto);
  const xSelo = MARGEM + 96;
  return svg(
    `${fundo("centro")}
    ${confetes([[900, 92], [980, 128], [840, 70]])}
    ${logo(MARGEM, MARGEM - 8, 72)}
    ${q.corpo}
    <circle cx="${xSelo}" cy="${fimFoto + 4}" r="48" fill="#FFFFFF"/>
    <circle cx="${xSelo}" cy="${fimFoto + 4}" r="40" fill="url(#marca)"/>
    <text x="${xSelo}" y="${fimFoto + 22}" text-anchor="middle" font-family="Nunito" font-weight="800" font-size="52" fill="#FFFFFF">?</text>
    <text x="${MARGEM}" y="${yRotulo}" font-family="Nunito" font-weight="800" font-size="24" letter-spacing="2.4" fill="${ROSA_ESCURO}">RESPONDA NOS COMENTÁRIOS</text>
    ${linhas.map((l, i) => `<text x="${MARGEM}" y="${yPrimeira + i * alt}" font-family="Nunito" font-weight="800" font-size="${tamanho}" letter-spacing="${-tamanho * 0.015}" fill="${TINTA}">${escapa(l)}</text>`).join("")}
    ${pilulaSite(MARGEM, RODAPE_Y)}
    <text x="${LARGURA - MARGEM}" y="${RODAPE_Y - 22}" text-anchor="end" font-family="Nunito" font-weight="800" font-size="26" fill="${CINZA}" fill-opacity="0.8">${ARROBA}</text>`,
    q.defs,
  );
}

/** Cartão de texto do carrossel: número grande no degradê, título e explicação curta. */
export function svgPonto(o: { numero: number; pagina: number; total: number; titulo: string; texto: string }) {
  const t = ajusta(o.titulo, LARGURA - 2 * MARGEM, [84, 76, 68], 3, 800, -0.02);
  const altT = Math.round(t.tamanho * 1.08);
  const yT = 740;
  const c = ajusta(o.texto, LARGURA - 2 * MARGEM - 20, [46, 42, 38], 5, 600);
  const altC = Math.round(c.tamanho * 1.4);
  const yC = yT + (t.linhas.length - 1) * altT + 60 + c.tamanho;
  const numero = String(o.numero).padStart(2, "0");
  return svg(
    `${fundo("topo")}
    ${confetes([[900, 410], [990, 490], [860, 530], [1000, 360]])}
    ${logo(MARGEM, MARGEM, 60)}
    <text x="${LARGURA - MARGEM}" y="${MARGEM + 42}" text-anchor="end" font-family="Nunito" font-weight="800" font-size="28" fill="${CINZA}" fill-opacity="0.6">${o.pagina}/${o.total}</text>
    <text x="${MARGEM - 8}" y="600" font-family="Nunito" font-weight="800" font-size="240" letter-spacing="-8" fill="url(#marca)">${numero}</text>
    ${t.linhas.map((l, i) => `<text x="${MARGEM}" y="${yT + i * altT}" font-family="Nunito" font-weight="800" font-size="${t.tamanho}" letter-spacing="${-t.tamanho * 0.02}" fill="${TINTA}">${escapa(l)}</text>`).join("")}
    ${c.linhas.map((l, i) => `<text x="${MARGEM}" y="${yC + i * altC}" font-family="Nunito" font-weight="600" font-size="${c.tamanho}" fill="${CINZA}">${escapa(l)}</text>`).join("")}
    ${pilulaSite(MARGEM, RODAPE_Y)}
    ${o.pagina < o.total ? arraste(RODAPE_Y - 22) : ""}`,
  );
}

export const CTA = { titulo: "Crie sua conta grátis", texto: "Seu buffet atendendo no WhatsApp 24 horas por dia." };

/** Último cartão do carrossel: convite para criar a conta grátis no site. */
export function svgChamada(o: { pagina: number; total: number }) {
  const t = ajusta(CTA.titulo, LARGURA - 2 * MARGEM, [104, 96, 88], 2, 800, -0.025);
  const altT = Math.round(t.tamanho * 1.06);
  const yT = 690;
  const c = equilibra(CTA.texto, LARGURA - 2 * MARGEM - 80, 44, 3, 0, 600).linhas;
  const yC = yT + (t.linhas.length - 1) * altT + 92;
  const yPilula = yC + (c.length - 1) * 60 + 170;
  return svg(
    `${fundo("centro")}
    ${confetes([[250, 300], [830, 260], [190, 470], [880, 450], [300, 200], [770, 520]])}
    <text x="${LARGURA - MARGEM}" y="${MARGEM + 42}" text-anchor="end" font-family="Nunito" font-weight="800" font-size="28" fill="${CINZA}" fill-opacity="0.6">${o.pagina}/${o.total}</text>
    ${logo(LARGURA / 2 - 120, 230, 240, false)}
    ${linhasTitulo(t.linhas, LARGURA / 2, yT, altT, t.tamanho, "middle")}
    ${c.map((l, i) => `<text x="${LARGURA / 2}" y="${yC + i * 60}" text-anchor="middle" font-family="Nunito" font-weight="600" font-size="44" fill="${CINZA}">${escapa(l)}</text>`).join("")}
    ${pilulaSite(LARGURA / 2, yPilula, 40, "centro")}
    <text x="${LARGURA / 2}" y="${RODAPE_Y}" text-anchor="middle" font-family="Nunito" font-weight="800" font-size="28" fill="${CINZA}" fill-opacity="0.7">${ARROBA}</text>`,
  );
}
