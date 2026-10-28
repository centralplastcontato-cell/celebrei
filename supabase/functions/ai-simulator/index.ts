// Simulador de testes da IA Conversacional (beta).
//
// POST { action: "start", company_id, scenario_ids?, rerun_failed_of? }  (usuário logado)
//   cria a rodada, uma linha por cenário, e dispara 3 "trabalhadores".
// POST { action: "resume", run_id }  (usuário logado) — destrava rodada parada.
// POST { action: "audit", company_id, days? } (usuário logado) — confere as
//   conversas REAIS da IA nos últimos dias (sem IA, custo zero).
// POST { action: "work", run_id }    (só o próprio servidor) — pega o próximo
//   cenário, conversa até ~1 min, guarda o estado e chama o próximo trabalhador.
//
// Só funciona com o módulo IA Conversacional ligado no Hub. A IA responde no
// modo isolado: nada sai pelo WhatsApp e nada é gravado fora destas tabelas.

// deno-lint-ignore-file no-explicit-any

import { createClient } from "npm:@supabase/supabase-js@2";
import { loadAiConversationalEnabled } from "../_shared/ai-module.ts";
import { DEFAULT_AI_MODEL } from "../_shared/ai-models.ts";
import { listAvailableSlots, normalizeTime, parseVisitHours, slotKey, teamHoursText, visitSlotsByDay } from "../_shared/business-hours.ts";
import { GENERAL_SCENARIOS } from "./scenarios.ts";
import { buildAiSiteWelcome, cleanIntroImage, cleanSiteLead, siteLeadBotData } from "../_shared/ai-site-lead.ts";
import { isHolidayYmd, localHolidaysFrom } from "../_shared/package-pricing.ts";
import { auditConversation, type RealMessage, realTranscript } from "./audit.ts";
import { closedPeriodsNote, isClosedDay, parseClosedPeriods } from "../_shared/closed-periods.ts";
import { AI_ACTOR, AI_ACTOR_HEADER } from "../wapi-webhook/ai-db-guard.ts";
import {
  agentCostUsd,
  CHAT_MAX_TURNS,
  deterministicChecks,
  initialState,
  judgeScenario,
  passed,
  runChatTurn,
  runScenarioSlice,
  type Scenario,
  type ScenarioState,
} from "./engine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WORKERS = 3;
// Tempo de conversa por chamada (o resto fica para o avaliador e para gravar)
const SLICE_MS = 55_000;
const LEASE_MS = 150_000;

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
// O que a IA lê do banco real vai com o cabeçalho da IA: se algo tentasse
// gravar em festa/financeiro, o gatilho do banco recusaria (2ª trava)
const aiReadDb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
  global: { headers: { [AI_ACTOR_HEADER]: AI_ACTOR } },
});

function background(p: Promise<unknown>) {
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(p);
  else p.catch((e) => console.error("[Simulador] erro em segundo plano:", e));
}

async function triggerWorker(runId: string): Promise<void> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ai-simulator`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "work", run_id: runId }),
    });
    await res.text();
  } catch (e) {
    console.error("[Simulador] não consegui chamar o próximo trabalhador:", e);
  }
}

async function authorize(req: Request, companyId: string): Promise<{ userId: string | null } | Response> {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Faça login" }, 401);
  // O próprio servidor (chave de serviço) pode rodar uma bateria — o módulo continua obrigatório
  if (jwt === SERVICE_KEY) {
    return (await loadAiConversationalEnabled(admin, companyId))
      ? { userId: null }
      : json({ error: "O módulo IA Conversacional não está liberado para esta empresa" }, 403);
  }
  const { data: { user }, error } = await admin.auth.getUser(jwt);
  if (error || !user) return json({ error: "Sessão inválida" }, 401);
  const { data: membership } = await admin.from("user_companies").select("company_id").eq("user_id", user.id).eq("company_id", companyId).maybeSingle();
  if (!membership) {
    const { data: isAdmin } = await admin.rpc("is_admin", { _user_id: user.id });
    if (isAdmin !== true) return json({ error: "Sem acesso a esta empresa" }, 403);
  }
  if (!(await loadAiConversationalEnabled(admin, companyId))) {
    return json({ error: "O módulo IA Conversacional não está liberado para esta empresa" }, 403);
  }
  return { userId: user.id };
}

// Deixa os cenários gerais do banco iguais aos do código (scenarios.ts)
async function syncGeneralScenarios(): Promise<void> {
  const { data: existing } = await admin.from("ai_sim_scenarios").select("id, key, title, persona, expectation, sort_order").is("company_id", null);
  const byKey = new Map(((existing || []) as any[]).map((r) => [r.key, r]));
  for (let i = 0; i < GENERAL_SCENARIOS.length; i++) {
    const s = GENERAL_SCENARIOS[i];
    const row = byKey.get(s.key);
    const values = { title: s.title, persona: s.persona, expectation: s.expectation, sort_order: i + 1 };
    if (!row) {
      await admin.from("ai_sim_scenarios").insert({ company_id: null, key: s.key, ...values });
    } else if (row.title !== s.title || row.persona !== s.persona || row.expectation !== s.expectation || row.sort_order !== i + 1) {
      await admin.from("ai_sim_scenarios").update(values).eq("id", row.id);
    }
  }
}

// Número usado no teste: o que a IA atende ou, se o buffet ainda não escolheu,
// o número do próprio buffet (o teste não manda nada pelo WhatsApp). Antes o
// teste travava em "Responda as perguntas da IA" mesmo com tudo preenchido
// (Rodrigo, Mega Magic 28/10: só faltava escolher o número).
async function testUnit(companyId: string, settings: any): Promise<string | null> {
  if (settings?.unit) return String(settings.unit);
  const { data } = await admin.from("wapi_instances").select("unit, status").eq("company_id", companyId);
  const list = ((data || []) as Array<{ unit: string | null; status: string | null }>).filter((i) => i.unit);
  return (list.find((i) => i.status === "connected") || list[0])?.unit || null;
}

async function start(req: Request, body: any): Promise<Response> {
  const companyId = String(body.company_id || "");
  if (!companyId) return json({ error: "company_id obrigatório" }, 400);
  const auth = await authorize(req, companyId);
  if (auth instanceof Response) return auth;

  const { data: settings } = await admin.from("ai_agent_settings").select("*").eq("company_id", companyId).maybeSingle();
  if (!settings) return json({ error: "Responda as perguntas da IA antes de rodar os testes" }, 400);
  if (!(await testUnit(companyId, settings))) return json({ error: "Conecte um número de WhatsApp antes de rodar os testes" }, 400);

  // Uma rodada por vez por empresa
  const since = new Date(Date.now() - 30 * 60000).toISOString();
  const { data: running } = await admin.from("ai_sim_runs").select("id").eq("company_id", companyId).eq("status", "running").gte("created_at", since).limit(1);
  if (running && running.length > 0) return json({ run_id: running[0].id, already_running: true });

  await syncGeneralScenarios().catch((e) => console.error("[Simulador] Falha ao sincronizar cenários gerais:", e));
  const { data: allScenarios, error: scErr } = await admin.from("ai_sim_scenarios")
    .select("id, key, title, persona, expectation, company_id")
    .eq("is_active", true)
    .or(`company_id.is.null,company_id.eq.${companyId}`)
    .order("sort_order");
  if (scErr) return json({ error: scErr.message }, 500);
  let scenarios = (allScenarios || []) as Scenario[];
  if (Array.isArray(body.scenario_ids) && body.scenario_ids.length > 0) {
    const ids = new Set(body.scenario_ids.map(String));
    scenarios = scenarios.filter((s) => ids.has(s.id));
  } else if (body.rerun_failed_of) {
    const { data: prev } = await admin.from("ai_sim_results").select("scenario_id, status")
      .eq("run_id", String(body.rerun_failed_of)).eq("company_id", companyId);
    const failedIds = new Set((prev || []).filter((r: any) => r.status === "failed" || r.status === "error").map((r: any) => r.scenario_id));
    scenarios = scenarios.filter((s) => failedIds.has(s.id));
  }
  if (scenarios.length === 0) return json({ error: "Nenhum cenário para rodar" }, 400);

  // Mesmo modelo do número de teste (com o Modo de Teste ligado) ou o dos clientes
  const model = (settings.test_mode_enabled && settings.test_model) || settings.model || DEFAULT_AI_MODEL;
  const { data: run, error: runErr } = await admin.from("ai_sim_runs")
    .insert({ company_id: companyId, created_by: auth.userId, model, total: scenarios.length })
    .select("id").single();
  if (runErr || !run) return json({ error: runErr?.message || "Erro ao criar a rodada" }, 500);

  const rows = scenarios.map((s) => ({
    run_id: run.id,
    company_id: companyId,
    scenario_id: s.id,
    scenario_key: s.key,
    scenario_title: s.title,
    scope: s.company_id ? "empresa" : "geral",
    status: "pending",
    state: { scenario: s },
  }));
  const { error: resErr } = await admin.from("ai_sim_results").insert(rows);
  if (resErr) return json({ error: resErr.message }, 500);

  background(Promise.all(Array.from({ length: Math.min(WORKERS, scenarios.length) }, () => triggerWorker(run.id))));
  return json({ run_id: run.id, total: scenarios.length, model });
}

// "Testar a minha IA": o dono escreve como se fosse um cliente e a IA responde no
// modo isolado. Vale antes da aprovação (o módulo ainda desligado) porque nada
// sai pelo WhatsApp nem é gravado; só dono/admin da empresa (ou da Celebrei).
async function chat(req: Request, body: any): Promise<Response> {
  const companyId = String(body.company_id || "");
  const message = String(body.message || "").trim().slice(0, 600);
  // Começo "veio pelo site": o mesmo que o site faz (dados anotados + boas-vindas da IA)
  const siteLead = !body.state && body.site_lead ? cleanSiteLead(body.site_lead) : null;
  if (!companyId || (!message && !siteLead)) return json({ error: "Escreva uma mensagem" }, 400);
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = jwt ? await admin.auth.getUser(jwt) : { data: { user: null } };
  if (!user) return json({ error: "Faça login" }, 401);
  const { data: link } = await admin.from("user_companies").select("role").eq("user_id", user.id).eq("company_id", companyId).maybeSingle();
  if (!link || !["owner", "admin"].includes(link.role)) {
    const { data: isAdmin } = await admin.rpc("is_admin", { _user_id: user.id });
    if (isAdmin !== true) return json({ error: "Só o dono do buffet pode testar a IA" }, 403);
  }
  const { data: settings } = await admin.from("ai_agent_settings").select("*").eq("company_id", companyId).maybeSingle();
  if (!settings) return json({ error: "Responda as perguntas da IA antes de testar" }, 400);
  const unit = await testUnit(companyId, settings);
  if (!unit) return json({ error: "Conecte um número de WhatsApp antes de testar a IA" }, 400);

  let state = body.state && typeof body.state === "object" && body.state.sandbox ? body.state as ScenarioState : null;
  if (!state) {
    const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    const { data: visits } = await admin.from("lead_visits")
      .select("id, lead_id, company_id, unit, data_visita, horario_visita, status_visita")
      .eq("company_id", companyId).gte("data_visita", today).limit(500);
    state = initialState(`chat-${crypto.randomUUID()}`, "Cliente", visits || []);
  }
  if (siteLead) {
    const todayYmd = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    const { data: company } = await admin.from("companies").select("name").eq("id", companyId).maybeSingle();
    const welcome = buildAiSiteWelcome(siteLead, company?.name || "Buffet", todayYmd, String(settings.assistant_name || ""));
    const conv = state.sandbox.memory.wapi_conversations.find((c: any) => c.id === state!.convId);
    if (conv) {
      conv.contact_name = siteLead.name || "Cliente";
      conv.bot_step = "ai_agent";
      conv.bot_data = { ...(conv.bot_data || {}), ...siteLeadBotData(siteLead, todayYmd) };
    }
    state.sandbox.memory.wapi_messages.push({
      id: crypto.randomUUID(), conversation_id: state.convId, message_id: `sim-out-site`, from_me: true,
      content: welcome, message_type: "text", timestamp: new Date().toISOString(), metadata: { source: "site" },
    });
    const image = cleanIntroImage(settings.intro_image_url);
    const replies = [image ? { kind: "image", text: welcome, mediaUrl: image } : { kind: "text", text: welcome }];
    return json({ state, replies, handoff: false, left: CHAT_MAX_TURNS - state.turn });
  }
  if (state.turn >= CHAT_MAX_TURNS) return json({ error: `O teste vai até ${CHAT_MAX_TURNS} mensagens. Toque em "Começar de novo".` }, 400);

  const model = (settings.test_mode_enabled && settings.test_model) || settings.model || DEFAULT_AI_MODEL;
  const r = await runChatTurn({ realDb: aiReadDb, companyId, unit, model, state, message });
  return json({ state: r.state, replies: r.replies, handoff: r.handoff, left: CHAT_MAX_TURNS - r.state.turn });
}

async function resume(req: Request, body: any): Promise<Response> {
  const runId = String(body.run_id || "");
  const { data: run } = await admin.from("ai_sim_runs").select("id, company_id, status").eq("id", runId).maybeSingle();
  if (!run) return json({ error: "Rodada não encontrada" }, 404);
  const auth = await authorize(req, run.company_id);
  if (auth instanceof Response) return auth;
  if (run.status === "running") background(triggerWorker(run.id));
  return json({ ok: true });
}

// Tenta pegar um cenário: pendente, ou "rodando" com o prazo vencido (trabalhador que caiu)
async function claim(runId: string): Promise<any | null> {
  const now = new Date();
  const { data: candidates } = await admin.from("ai_sim_results")
    .select("id, status, lease_until")
    .eq("run_id", runId)
    .in("status", ["pending", "running"])
    .order("created_at")
    .limit(20);
  for (const c of candidates || []) {
    if (c.status === "running" && c.lease_until && Date.parse(c.lease_until) > now.getTime()) continue;
    let q = admin.from("ai_sim_results")
      .update({ status: "running", lease_until: new Date(now.getTime() + LEASE_MS).toISOString() })
      .eq("id", c.id)
      .eq("status", c.status);
    if (c.status === "running") q = q.lt("lease_until", now.toISOString());
    const { data: got } = await q.select("*");
    if (got && got.length > 0) return got[0];
  }
  return null;
}

async function finalizeIfDone(runId: string): Promise<void> {
  const { data: results } = await admin.from("ai_sim_results").select("status, cost_usd").eq("run_id", runId);
  const list = results || [];
  if (list.some((r: any) => r.status === "pending" || r.status === "running")) return;
  const count = (s: string) => list.filter((r: any) => r.status === s).length;
  const cost = list.reduce((s: number, r: any) => s + (Number(r.cost_usd) || 0), 0);
  await admin.from("ai_sim_runs").update({
    status: "done",
    passed: count("passed"),
    failed: count("failed"),
    errors: count("error"),
    cost_usd: Number(cost.toFixed(6)),
    finished_at: new Date().toISOString(),
  }).eq("id", runId).eq("status", "running");
  console.log(`[Simulador] Rodada ${runId} terminada: ${count("passed")} passaram, ${count("failed")} falharam, ${count("error")} erros, US$ ${cost.toFixed(4)}`);
}

// O que a IA sabe do buffet (informações da configuração + o que cada pacote
// inclui) — o avaliador usa para conferir se ela inventou algo
async function loadKnowledge(companyId: string): Promise<string> {
  const [{ data: settings }, { data: packages }, { data: company }] = await Promise.all([
    admin.from("ai_agent_settings").select("*").eq("company_id", companyId).maybeSingle(),
    admin.from("company_packages").select("*").eq("company_id", companyId).eq("is_active", true).order("sort_order"),
    admin.from("companies").select("settings").eq("id", companyId).maybeSingle(),
  ]);
  const pk = ((packages || []) as any[])
    .filter((p) => p.ai_quote !== false)
    .map((p) => `Pacote ${p.name}:\n${p.includes || p.description || "(sem lista)"}`)
    .join("\n\n");
  // Horários de visita livres (a mesma conta que a IA recebe), para o avaliador
  // não achar que ela inventou os horários que ofereceu
  const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  const { data: visits } = await admin.from("lead_visits").select("data_visita, horario_visita, unit, status_visita")
    .eq("company_id", companyId).gte("data_visita", today).in("status_visita", ["agendada", "confirmada", "remarcada"]).limit(1000);
  const booked = new Set<string>();
  for (const v of (visits || []) as any[]) {
    const t = normalizeTime(v.horario_visita || "");
    if (t) booked.add(slotKey({ date: String(v.data_visita).slice(0, 10), time: t }));
  }
  const closed = parseClosedPeriods(settings?.closed_periods);
  // Feriado não tem visita (mesma regra da IA)
  const holidays = localHolidaysFrom(((company as any)?.settings || null) as any);
  const isHolidayDate = (ymd: string) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return !!y && !!m && !!d && isHolidayYmd(y, m, d, holidays);
  };
  const freeVisits = visitSlotsByDay(listAvailableSlots(parseVisitHours(settings?.visit_hours || null), Date.now(), booked, { days: 28, minLeadMinutes: 120, max: 120 })
    .filter((sl) => !isClosedDay(sl.date, closed) && !isHolidayDate(sl.date)), 7, 12)
    .map((d) => `${d.date}: ${d.times.join(", ")}`).join("; ");
  return [
    settings?.extra_instructions || "",
    closedPeriodsNote(closed, today) || "",
    freeVisits ? `Horários de VISITA livres agora (a IA recebe esta lista e pode oferecê-los): ${freeVisits}` : "",
    settings?.visit_hours ? `Horários de VISITA ao espaço: ${settings.visit_hours}` : "",
    `Horário de atendimento da EQUIPE (a IA informa ao passar a conversa): ${teamHoursText(settings?.team_hours)}`,
    "A IA recebe a lista de horários de VISITA livres dos próximos dias (da agenda de visitas) e pode oferecê-los sem consultar ferramenta.",
    pk,
  ]
    .filter(Boolean).join("\n\n").slice(0, 16000);
}

async function work(runId: string): Promise<void> {
  const row = await claim(runId);
  if (!row) {
    await finalizeIfDone(runId);
    return;
  }
  const { data: run } = await admin.from("ai_sim_runs").select("company_id, model").eq("id", runId).single();
  if (!run) return;
  const companyId = run.company_id as string;
  const scenario = row.state?.scenario as Scenario;
  let sim = row.state?.sim as ScenarioState | undefined;
  try {
    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) throw new Error("OPENAI_API_KEY não configurada (cliente simulado e avaliador usam OpenAI)");
    const [{ data: company }, { data: settings }] = await Promise.all([
      admin.from("companies").select("name").eq("id", companyId).single(),
      admin.from("ai_agent_settings").select("unit").eq("company_id", companyId).single(),
    ]);
    if (!sim) {
      // Visitas reais (cópia): a IA confere conflito de horário sem tocar nelas
      const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
      const { data: visits } = await admin.from("lead_visits")
        .select("id, lead_id, company_id, unit, data_visita, horario_visita, status_visita")
        .eq("company_id", companyId).gte("data_visita", today).limit(1000);
      const contactName = scenario.persona.match(/se chama ([A-ZÀ-Úa-zà-ú]+)/)?.[1] || "Cliente";
      sim = initialState(`sim-${row.id}`, contactName, visits || []);
    }
    sim = await runScenarioSlice({
      realDb: aiReadDb,
      companyId,
      companyName: company?.name || "Buffet",
      unit: (await testUnit(companyId, settings)) || "",
      model: run.model || null,
      scenario,
      state: sim,
      openaiKey,
      budgetMs: SLICE_MS,
    });
    const partialCost = agentCostUsd(sim) + sim.helperCostUsd;
    if (!sim.done) {
      await admin.from("ai_sim_results").update({
        status: "pending",
        lease_until: null,
        state: { scenario, sim },
        transcript: sim.transcript,
        turns: sim.turn,
        cost_usd: Number(partialCost.toFixed(6)),
      }).eq("id", row.id);
    } else {
      const knowledge = await loadKnowledge(companyId);
      const judged = await judgeScenario(openaiKey, company?.name || "Buffet", scenario, sim, knowledge);
      // Reprova só o que o código confere; o avaliador (IA) comenta, mas não reprova
      const checks = [...deterministicChecks(sim, { knowledge }), ...judged.checks];
      const cost = partialCost + judged.costUsd;
      await admin.from("ai_sim_results").update({
        status: passed(checks) ? "passed" : "failed",
        lease_until: null,
        state: null,
        transcript: sim.transcript,
        checks,
        summary: judged.summary,
        end_reason: sim.endReason,
        turns: sim.turn,
        cost_usd: Number(cost.toFixed(6)),
        finished_at: new Date().toISOString(),
      }).eq("id", row.id);
      console.log(`[Simulador] ${scenario.key}: ${passed(checks) ? "passou" : "falhou"} (${sim.turn} vezes, US$ ${cost.toFixed(4)})`);
    }
  } catch (err) {
    console.error(`[Simulador] Erro no cenário ${scenario?.key}:`, err);
    await admin.from("ai_sim_results").update({
      status: "error",
      lease_until: null,
      state: null,
      transcript: sim?.transcript || [],
      error: String((err as Error)?.message || err).slice(0, 1000),
      turns: sim?.turn || 0,
      cost_usd: Number(((sim ? agentCostUsd(sim) + sim.helperCostUsd : 0)).toFixed(6)),
      finished_at: new Date().toISOString(),
    }).eq("id", row.id);
  }
  // Próximo cenário (ou fecha a rodada)
  await triggerWorker(runId);
}

const chunks = <T>(list: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

// Conversas reais da IA no período, com o que as conferências do código acharam
async function audit(req: Request, body: any): Promise<Response> {
  const companyId = String(body.company_id || "");
  if (!companyId) return json({ error: "company_id obrigatório" }, 400);
  const auth = await authorize(req, companyId);
  if (auth instanceof Response) return auth;
  const days = Math.min(Math.max(Number(body.days) || 1, 1), 14);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const { data: aiRows, error } = await admin.from("wapi_messages").select("conversation_id")
    .eq("company_id", companyId).eq("from_me", true).eq("metadata->>source", "ai_agent")
    .gte("timestamp", since).limit(5000);
  if (error) throw new Error(error.message);
  const convIds = Array.from(new Set(((aiRows || []) as any[]).map((r) => r.conversation_id as string))).slice(0, 200);
  if (convIds.length === 0) return json({ days, checked: 0, conversations: [] });

  const [{ data: settings }, convs, msgs] = await Promise.all([
    admin.from("ai_agent_settings").select("extra_instructions").eq("company_id", companyId).maybeSingle(),
    Promise.all(chunks(convIds, 50).map((ids) =>
      admin.from("wapi_conversations").select("id, contact_name, remote_jid, bot_step, lead_id").in("id", ids).then((r) => (r.data || []) as any[])
    )).then((l) => l.flat()),
    // Até 1000 linhas por consulta: 10 conversas por vez
    Promise.all(chunks(convIds, 10).map((ids) =>
      admin.from("wapi_messages").select("conversation_id, from_me, content, message_type, timestamp, metadata")
        .in("conversation_id", ids).gte("timestamp", since).order("timestamp").limit(1000)
        .then((r) => (r.data || []) as any[])
    )).then((l) => l.flat()),
  ]);
  const byConv = new Map<string, RealMessage[]>();
  for (const m of msgs) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id)!.push(m as RealMessage);
  }
  const knowledge = settings?.extra_instructions || "";
  const conversations = convs.map((c) => {
    const transcript = realTranscript(byConv.get(c.id) || [], c.bot_step === "human_takeover");
    const problems = auditConversation(transcript, { knowledge });
    const lastAt = (byConv.get(c.id) || []).reduce((max, m) => (m.timestamp > max ? m.timestamp : max), "");
    return {
      id: c.id,
      name: c.contact_name || null,
      phone: String(c.remote_jid || "").replace(/@.*/, ""),
      lead_id: c.lead_id || null,
      last_at: lastAt,
      problems: problems.map((p) => ({ id: p.id, label: p.label, note: p.note })),
      transcript: problems.length > 0 ? transcript.filter((e) => e.who !== "ferramenta") : [],
    };
  }).filter((c) => c.problems.length > 0).sort((a, b) => b.last_at.localeCompare(a.last_at));
  return json({ days, checked: convIds.length, conversations });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    if (body.action === "work") {
      if ((req.headers.get("Authorization") || "") !== `Bearer ${SERVICE_KEY}`) return json({ error: "não autorizado" }, 401);
      background(work(String(body.run_id || "")));
      return json({ accepted: true }, 202);
    }
    if (body.action === "start") return await start(req, body);
    if (body.action === "resume") return await resume(req, body);
    if (body.action === "chat") return await chat(req, body);
    if (body.action === "audit") return await audit(req, body);
    return json({ error: "ação desconhecida" }, 400);
  } catch (err) {
    console.error("[Simulador] Erro:", err);
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
