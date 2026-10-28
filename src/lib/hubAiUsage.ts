// Tela "Consumo de IA" do Hub. Antes ela lia só ai_usage_logs (artes,
// campanhas e resumos) e mostrava US$ 0,31 no mês, quando o gasto real
// (as conversas da IA no WhatsApp, em ai_agent_usage) passava de US$ 29.
// Aqui as duas tabelas viram um resumo só, por empresa, modelo e função.

import { getAiModel, providerForModel } from "../../supabase/functions/_shared/ai-models.ts";

export interface AgentUsageRow {
  company_id: string;
  model: string;
  provider: string | null;
  kind: string;
  cost_usd: number | string | null;
  is_test: boolean | null;
  conversation_id: string | null;
  created_at: string;
}

export interface LogUsageRow {
  company_id: string;
  function_name: string;
  model?: string | null;
  estimated_cost_usd: number | string | null;
  created_at: string;
}

const KIND_LABELS: Record<string, string> = {
  chat: "Atendimento WhatsApp",
  transcription: "Áudios transcritos",
  vision: "Fotos lidas",
  insights: "Insights semanais",
  hub_summary: "Resumo do Hub",
};

const FUNCTION_LABELS: Record<string, string> = {
  "lead-summary": "Resumo do lead",
  "daily-summary": "Resumo diário",
  "fix-text": "Correção de texto",
  "wapi-webhook": "Qualificação do robô",
  "support-chat": "Chat de suporte",
  "campaign-ai": "Mensagens de campanha",
  "campaign-image": "Artes de campanha",
};

export const PROVIDER_LABELS: Record<string, string> = { anthropic: "Anthropic (Claude)", openai: "OpenAI (GPT)" };

export interface CompanyUsage {
  whatsappUsd: number;
  otherUsd: number;
  totalUsd: number;
  conversations: number;
  calls: number;
  lastAt: string | null;
}

export interface HubAiUsageSummary {
  totalUsd: number;
  whatsappUsd: number;
  otherUsd: number;
  conversations: number;
  calls: number;
  byProvider: Record<string, number>;
  byCompany: Record<string, CompanyUsage>;
  byFeature: Array<{ name: string; usd: number; calls: number }>;
  byModel: Array<{ model: string; label: string; provider: string; usd: number; calls: number }>;
}

const num = (v: number | string | null | undefined) => Number(v || 0);

/** Nome do modelo sem a data da versão ("gpt-5.4-2026-03-05" → "gpt-5.4") */
function baseModel(id: string): string {
  return getAiModel(id)?.id || id.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, "");
}

export function summarizeHubAiUsage(agent: AgentUsageRow[], logs: LogUsageRow[]): HubAiUsageSummary {
  const byCompany: Record<string, CompanyUsage> = {};
  const byProvider: Record<string, number> = {};
  const features = new Map<string, { usd: number; calls: number }>();
  const models = new Map<string, { provider: string; usd: number; calls: number }>();
  const convs = new Map<string, Set<string>>();
  let whatsappUsd = 0;
  let otherUsd = 0;

  const company = (id: string) =>
    (byCompany[id] ||= { whatsappUsd: 0, otherUsd: 0, totalUsd: 0, conversations: 0, calls: 0, lastAt: null });
  const add = (companyId: string, usd: number, at: string, whatsapp: boolean, feature: string, model: string | null | undefined, provider: string | null | undefined) => {
    const c = company(companyId);
    c.calls++;
    c.totalUsd += usd;
    if (whatsapp) c.whatsappUsd += usd;
    else c.otherUsd += usd;
    if (!c.lastAt || at > c.lastAt) c.lastAt = at;
    const f = features.get(feature) || { usd: 0, calls: 0 };
    f.usd += usd;
    f.calls++;
    features.set(feature, f);
    if (model) {
      const key = baseModel(model);
      const prov = provider || providerForModel(model);
      const m = models.get(key) || { provider: prov, usd: 0, calls: 0 };
      m.usd += usd;
      m.calls++;
      models.set(key, m);
      byProvider[prov] = (byProvider[prov] || 0) + usd;
    }
  };

  for (const r of agent) {
    const usd = num(r.cost_usd);
    add(r.company_id, usd, r.created_at, true, KIND_LABELS[r.kind] || r.kind, r.model, r.provider);
    whatsappUsd += usd;
    if (r.kind === "chat" && r.conversation_id && !r.is_test) {
      const set = convs.get(r.company_id) || new Set<string>();
      set.add(r.conversation_id);
      convs.set(r.company_id, set);
    }
  }
  for (const r of logs) {
    const usd = num(r.estimated_cost_usd);
    add(r.company_id, usd, r.created_at, false, FUNCTION_LABELS[r.function_name] || r.function_name, r.model, null);
    otherUsd += usd;
  }
  let conversations = 0;
  for (const [id, set] of convs) {
    company(id).conversations = set.size;
    conversations += set.size;
  }

  return {
    totalUsd: whatsappUsd + otherUsd,
    whatsappUsd,
    otherUsd,
    conversations,
    calls: agent.length + logs.length,
    byProvider,
    byCompany,
    byFeature: [...features].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.usd - a.usd),
    byModel: [...models]
      .map(([model, v]) => ({ model, label: getAiModel(model)?.label || model, ...v }))
      .sort((a, b) => b.usd - a.usd),
  };
}
