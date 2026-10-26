# Instagram automático da Celebrei (@hubcelebrei)

Gera arte + legenda com IA e manda para o **Postaí** (meupostai.com.br), que publica no
Instagram @hubcelebrei e na Página "Celebrei" do Facebook. É a mesma automação da Prospecta
(repositório prospectaleads), adaptada para a Celebrei.

```
pg_cron no Supabase, a cada 10 min (job hub-instagram-rodada)
  → Edge Function "hub-instagram" (supabase/functions/hub-instagram)
     1. manutenção: marca perdidos, envia ao Postaí o que está pronto, confere o que foi publicado
     2. cria os posts das vagas livres dos próximos 3 dias (tema + legenda pela IA, presa aos FATOS)
     3. monta UMA arte com foto por rodada (foto pela IA + acabamento da marca), ou até 3 cartões de texto
painel: Hub → Instagram (/hub/instagram): aprovar, editar texto, gerar outro, recusar, post de teste, ligar/pausar
```

## Como funciona

- **Ritmo** (`pauta.ts`, horário de Brasília): 1ª semana 3/dia (09:00 foto, 12:30 pergunta ou carrossel,
  18:30 foto); 2ª semana 2/dia (12:00, 18:30); depois 1/dia às 12:00 (foto → carrossel → pergunta).
  As semanas contam a partir do dia em que a automação foi **ligada pela primeira vez** (`hub_instagram_config.inicio`).
- **Assunto**: o público é sempre o dono de buffet infantil. Pela ordem dos posts, 2 de **vendas**
  (resposta na hora, 24 horas, visita, follow-up, funil, conta grátis) para 1 de **gestão**
  (agenda e pré-reservas, contrato e parcelas, dia da festa, feita dentro de um buffet).
- **Temas e fatos** (`catalogo.ts`): só o que está na landing page e no /comecar. Proibido na legenda
  (o verificador recusa e usa a legenda de reserva): preço, nome de plano, porcentagem, algarismos
  (fora "24 horas"), garantia, grátis além da conta e da demonstração, e convite para chamar no
  WhatsApp ou no direct. O WhatsApp pode ser citado como o canal do atendimento automático; o convite
  é sempre para o site **hubcelebrei.com.br** (regra do Victor, 19/10/2026).
- **Arte** (`imagem.ts`): 1080×1350, **clara** como o site: fundo creme, manchas suaves de amarelo, rosa e
  roxo, chapéu de festa + "Celebrei", selo do tema, título em Nunito (a última linha no degradê
  laranja → rosa → roxo), foto num quadro de cantos arredondados e a pílula com o site.
  Carrossel = capa com foto + 2 cartões de texto + cartão final "Crie sua conta grátis".
  A foto da IA nunca tem texto nem crianças; todo texto é desenhado por nós (sem erro de grafia).
- **Logo**: o mesmo vetor do site (`CelebreiLogo.tsx`), redesenhado em `marca.ts` (`LOGO_512`).
- **Aprovação manual** (painel): começa desligada (os posts vão direto ao Postaí). Ligada, cada post espera "Aprovar".
- **Automação** nasce **pausada**: nada é gerado nem enviado até ligar no painel.
- **Imagem que falhou 3 vezes** (status "erro", no painel "Não deu para gerar") volta sozinha a tentar a
  cada 3 h, enquanto o horário estiver a mais de 1 h. Uma falha passageira da OpenAI não deixa o horário vazio.
- **Post de teste**: botão no painel. Gera 1 foto para daqui ~30 min e manda ao Postaí (só feed, sem Story),
  mesmo com a automação pausada.
- **Quem acessa**: o painel e a função só aceitam admin da Celebrei (`is_admin`).

## Postaí (API v1)

- Vai com antecedência, como `agendado`, com `external_id` = id do post (reenviar não duplica).
  O Postaí recusa horário no passado: se faltar menos de 12 min, o post vira "perdeu o horário".
- **Story**: o Postaí não espelha no Story o que chega pela API. Cada post vai junto com uma cópia em Story
  (post separado, mesma hora, capa do post, `external_id` = `<id>-story`). Recusar / gerar outro cancela os dois.
- Recusado ou apagado no painel do Postaí vira `recusado` aqui.

## Segredos (Supabase → Edge Functions → Secrets)

| Nome | Situação |
|---|---|
| `POSTAI_API_KEY` | a chave `pa_…` da marca Celebrei no Postaí (guardada em 19/10/2026) |
| `OPENAI_API_KEY` | já existe (usada pelas outras funções) |

O segredo do cron **não** fica aqui: o próprio SQL da instalação cria um valor aleatório em
`hub_instagram_config.cron_segredo`, que o job manda no header `x-cron-secret` e a função confere.

Opcionais: `OPENAI_IMAGE_MODEL` (se vazio, tenta gpt-image-2, gpt-image-1.5, gpt-image-1 e gpt-image-1-mini, nessa ordem; em 26/10/2026 o gpt-image-1 saiu do ar), `OPENAI_IMAGE_QUALITY` (`medium`),
`OPENAI_TEXT_MODEL` (`gpt-4o-mini`), `POSTAI_URL`.

## Instalação (uma vez)

1. SQL Editor do Supabase: colar e rodar `supabase/migrations/20261019230000_hub_instagram.sql`
   (tabelas, segredo do cron, balde público `hub-instagram` e o job `hub-instagram-rodada`).
   Pode rodar de novo sem estragar nada.
2. Publicar a função: GitHub → Actions → **Deploy Edge Functions** → Run workflow → `hub-instagram`.
3. Hub → Instagram → **Post de teste (daqui 30 min)** → conferir no Instagram e no Facebook.
4. Tudo certo? Ligar a **Automação**.

Para conferir o job: `select jobname, schedule from cron.job where jobname = 'hub-instagram-rodada';`

## Limites técnicos

As Edge Functions têm ~2 s de CPU por chamada. Montar uma arte com foto custa ~0,8 s; um cartão de texto ~0,2 s.
Por isso cada rodada monta no máximo uma arte com foto (ou até 3 cartões). O carrossel fica pronto em 2 rodadas.
Com o painel aberto, as imagens que faltam são montadas na hora, uma etapa por vez.

Fontes: `public/fonts/instagram/` (Nunito SemiBold e ExtraBold, servidas pelo site); reserva no Google Fonts.
Motor de imagem (resvg em WebAssembly) baixado do unpkg/jsDelivr na primeira chamada de cada servidor.

## Custo aproximado

Foto média 1536×1024 ≈ US$ 0,06 (1 por post, inclusive no carrossel). Legenda: centavos. No ritmo inicial,
~US$ 3 a 5 no 1º mês (≈ 50 fotos, mais testes e "gerar outro"), depois ~US$ 2/mês.

## Testes

```
deno test -A supabase/functions/hub-instagram/
INSTAGRAM_WASM=/caminho/@resvg/resvg-wasm/index_bg.wasm deno test -A --node-modules-dir=none supabase/functions/hub-instagram/rodada.teste.ts
```

O `rodada.teste.ts` roda o ciclo inteiro com banco em memória e OpenAI/Postaí falsos (nada sai para a internet).
Ele não termina em `.test.ts` de propósito: importa pacotes npm, e o CI roda os testes sem `node_modules`.
