// Configuração da IA (tabela ai_agent_settings): leitura, gravação e tipos
// usados pelas páginas de Configurações → Inteligência Artificial.
// Cada página carrega a linha ao abrir e grava só o que mudou nela.

/* eslint-disable @typescript-eslint/no-explicit-any -- tabela fora dos tipos gerados */
import { useEffect, useState } from "react";
import { useCompany } from "@/contexts/CompanyContext";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { DEFAULT_AI_MODEL, type AiUsageRow } from "@/lib/aiModels";
import type { AiFollowUpConfig } from "@/lib/aiFollowUp";

export interface ExtraUnit {
  unit: string;
  activated_at: string;
}

export interface ClosedPeriod {
  start: string; // AAAA-MM-DD
  end: string;
}

export interface AiAgentSettings {
  id?: string;
  enabled: boolean;
  unit: string | null;
  activated_at: string | null;
  extra_instructions: string | null;
  visit_hours: string;
  // Modo de Teste da própria IA — separado do Modo de Teste do bot fixo.
  // Ligado, a IA só conversa com este número; para os demais, nada muda.
  test_mode_enabled: boolean;
  test_mode_number: string | null;
  // Modelo dos clientes e, opcionalmente, outro só para o número de teste
  model: string;
  test_model: string | null;
  // Passagem para a equipe: horário de atendimento e alerta forte
  team_hours?: string | null;
  handoff_alert_minutes?: number | null;
  handoff_alert_phone?: string | null;
  // Horários de festa para a IA dizer as datas livres da agenda
  party_slots?: string | null;
  // Recesso / dias fechados
  closed_periods?: ClosedPeriod[] | null;
  // Acompanhamento: inatividade, follow-ups por etapa e perdido automático
  followup_config?: AiFollowUpConfig | null;
  // Apresentação: nome da assistente e a arte dela (vai na 1ª mensagem)
  assistant_name?: string | null;
  intro_image_url?: string | null;
  // Outros números com a IA, cada um com a sua data de liberação
  extra_units?: ExtraUnit[] | null;
  // Alerta de cliente com festa nos próximos 60 dias
  party_soon_alert?: boolean | null;
  // Confraternização de empresas
  corporate_events_enabled?: boolean | null;
  corporate_max_guests?: number | null;
  // Quem marca as visitas: 'ia' (padrão) ou 'equipe' (a IA não oferece horários)
  visit_scheduling?: "ia" | "equipe" | null;
}

export const BASE_COLUMNS = "id, enabled, unit, activated_at, extra_instructions, visit_hours, test_mode_enabled, test_mode_number, model";
export const DEFAULT_VISIT_HOURS = "Segunda a sexta, das 10:00 às 17:00, de meia em meia hora";
export const DEFAULT_PARTY_SLOTS = "13:00-17:00, 19:00-23:00";
export const USAGE_WINDOW_DAYS = 30;

// Banco ainda sem as colunas novas (migration não rodada)
function isMissingNewColumn(error: { message?: string } | null): boolean {
  return !!error?.message && /test_model|team_hours|handoff_alert|party_slots|closed_periods|followup_config|assistant_name|intro_image_url|extra_units/.test(error.message);
}

export function useAiAgentSettings() {
  const { currentCompany } = useCompany();
  const companyId = currentCompany?.id;
  const [settings, setSettings] = useState<AiAgentSettings | null>(null);
  const [units, setUnits] = useState<string[]>([]);
  const [usageRows, setUsageRows] = useState<AiUsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!companyId) return;
    let alive = true;
    (async () => {
      setLoading(true);
      const since = new Date(Date.now() - USAGE_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
      const [settingsRes, { data: instances }, usageRes] = await Promise.all([
        (supabase as any).from("ai_agent_settings").select("*").eq("company_id", companyId).maybeSingle(),
        supabase.from("wapi_instances").select("unit").eq("company_id", companyId).eq("is_active", true),
        (supabase as any)
          .from("ai_agent_usage")
          .select("conversation_id, model, kind, cost_usd, is_test")
          .eq("company_id", companyId)
          .gte("created_at", since)
          .limit(10000),
      ]);
      let row = settingsRes.data;
      if (settingsRes.error && isMissingNewColumn(settingsRes.error)) {
        const retry = await (supabase as any).from("ai_agent_settings").select(BASE_COLUMNS).eq("company_id", companyId).maybeSingle();
        row = retry.data ? { ...retry.data, test_model: null } : null;
      }
      if (!alive) return;
      // Tabela de consumo ainda não criada: painel fica vazio, sem erro
      setUsageRows((usageRes?.data || []) as AiUsageRow[]);
      setSettings(row || {
        enabled: false,
        unit: null,
        activated_at: null,
        extra_instructions: null,
        visit_hours: DEFAULT_VISIT_HOURS,
        test_mode_enabled: false,
        test_mode_number: null,
        model: DEFAULT_AI_MODEL,
        test_model: null,
      });
      setUnits((Array.from(new Set(((instances || []) as { unit: string | null }[]).map((i) => i.unit).filter(Boolean))) as string[]).sort());
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [companyId]);

  const persist = async (patch: Partial<AiAgentSettings>): Promise<AiAgentSettings | undefined> => {
    if (!companyId || !settings) return;
    setSaving(true);
    const next = { ...settings, ...patch };
    const payload: Record<string, unknown> = {
      company_id: companyId,
      enabled: next.enabled,
      unit: next.unit,
      activated_at: next.activated_at,
      extra_instructions: next.extra_instructions,
      visit_hours: next.visit_hours,
      test_mode_enabled: next.test_mode_enabled,
      test_mode_number: next.test_mode_number,
      model: next.model || DEFAULT_AI_MODEL,
      test_model: next.test_model,
      team_hours: next.team_hours ?? null,
      handoff_alert_minutes: next.handoff_alert_minutes ?? 10,
      handoff_alert_phone: next.handoff_alert_phone ?? null,
      party_slots: next.party_slots ?? null,
      closed_periods: next.closed_periods ?? [],
      followup_config: next.followup_config ?? null,
      assistant_name: next.assistant_name ?? null,
      intro_image_url: next.intro_image_url ?? null,
      // Só manda quando o banco já tem a coluna (veio na leitura)
      ...(next.extra_units !== undefined ? { extra_units: next.extra_units ?? [] } : {}),
      ...(next.party_soon_alert !== undefined ? { party_soon_alert: next.party_soon_alert === true } : {}),
      ...(next.corporate_events_enabled !== undefined
        ? { corporate_events_enabled: next.corporate_events_enabled === true, corporate_max_guests: next.corporate_max_guests ?? null }
        : {}),
      ...(next.visit_scheduling !== undefined ? { visit_scheduling: next.visit_scheduling === "equipe" ? "equipe" : "ia" } : {}),
      updated_at: new Date().toISOString(),
    };
    const save = (body: Record<string, unknown>, columns: string) =>
      (supabase as any).from("ai_agent_settings").upsert(body, { onConflict: "company_id" }).select(columns).single();
    let { data, error } = await save(payload, "*");
    if (error && isMissingNewColumn(error)) {
      // Banco sem as colunas novas: salva o resto e avisa que falta a atualização
      const { test_model: _t, team_hours: _h, handoff_alert_minutes: _m, handoff_alert_phone: _p, party_slots: _s, closed_periods: _c, followup_config: _f, assistant_name: _n, intro_image_url: _i, extra_units: _x, ...withoutNew } = payload;
      ({ data, error } = await save(withoutNew, BASE_COLUMNS));
      if (!error) {
        data = { ...data, test_model: null };
        toast({ title: "Parte das configurações não foi salva", description: "Falta rodar a atualização do banco (SQL) da IA. O resto foi salvo." });
      }
    }
    setSaving(false);
    if (error) {
      toast({ title: "Erro ao salvar", description: error.message, variant: "destructive" });
      return;
    }
    setSettings(data as AiAgentSettings);
    return data as AiAgentSettings;
  };

  return { companyId, settings, units, usageRows, loading, saving, persist };
}
