import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { HubLayout } from "@/components/hub/HubLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Brain, MessageCircle, Coins, Cpu, TrendingUp } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { toast } from "sonner";
import type { Json } from "@/integrations/supabase/types";
import { fetchAllPages } from "@/lib/fetchAllPages";
import { AI_MODELS, getAiModel, formatBrlFromUsd, formatUsd } from "@/lib/aiModels";
import { PROVIDER_LABELS, summarizeHubAiUsage, type AgentUsageRow, type LogUsageRow } from "@/lib/hubAiUsage";

interface CompanyInfo {
  id: string;
  name: string;
  settings: Json | null;
}

export default function HubAIUsage() {
  const [period, setPeriod] = useState("30");
  const [selectedCompany, setSelectedCompany] = useState("all");
  const [agentRows, setAgentRows] = useState<AgentUsageRow[]>([]);
  const [logs, setLogs] = useState<LogUsageRow[]>([]);
  const [companies, setCompanies] = useState<CompanyInfo[]>([]);
  // Modelo da IA de cada empresa (só quem já tem a IA configurada)
  const [models, setModels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  async function fetchData() {
    setLoading(true);
    const since = new Date(Date.now() - parseInt(period) * 24 * 3600 * 1000).toISOString();
    const db = supabase as any;
    try {
      const [agent, logRows, companiesRes, settingsRes] = await Promise.all([
        fetchAllPages<AgentUsageRow>((a, b) =>
          db.from("ai_agent_usage").select("company_id, model, provider, kind, cost_usd, is_test, conversation_id, created_at")
            .gte("created_at", since).order("created_at", { ascending: false }).range(a, b),
        ),
        fetchAllPages<LogUsageRow>((a, b) =>
          db.from("ai_usage_logs").select("company_id, function_name, model, estimated_cost_usd, created_at")
            .gte("created_at", since).order("created_at", { ascending: false }).range(a, b),
        ),
        supabase.from("companies").select("id, name, settings").eq("is_active", true).order("name"),
        db.from("ai_agent_settings").select("company_id, model"),
      ]);
      setAgentRows(agent);
      setLogs(logRows);
      setCompanies(companiesRes.data || []);
      setModels(Object.fromEntries(((settingsRes.data || []) as Array<{ company_id: string; model: string | null }>).map((r) => [r.company_id, r.model || "gpt-4o-mini"])));
    } catch (err) {
      console.error("HubAIUsage:", err);
      toast.error("Não consegui carregar o consumo de IA");
    } finally {
      setLoading(false);
    }
  }

  const only = <T extends { company_id: string }>(rows: T[]) => (selectedCompany === "all" ? rows : rows.filter((r) => r.company_id === selectedCompany));
  const summary = summarizeHubAiUsage(only(agentRows), only(logs));

  const chartData = summary.byFeature.map((f) => ({ name: f.name, custo: Number(f.usd.toFixed(2)) }));

  const companyMap = new Map(companies.map(c => [c.id, c]));

  // Empresas com consumo ou com a IA configurada (para trocar o modelo)
  const companyIds = new Set([...Object.keys(summary.byCompany), ...Object.keys(models)]);
  const companyRows = [...companyIds]
    .filter((id) => companyMap.has(id) && (selectedCompany === "all" || id === selectedCompany))
    .map((companyId) => ({
      companyId,
      companyName: companyMap.get(companyId)?.name || "Desconhecida",
      ...(summary.byCompany[companyId] || { whatsappUsd: 0, otherUsd: 0, totalUsd: 0, conversations: 0, calls: 0, lastAt: null }),
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd || a.companyName.localeCompare(b.companyName));

  async function changeModel(companyId: string, model: string) {
    const name = companyMap.get(companyId)?.name || "a empresa";
    const label = getAiModel(model)?.label || model;
    if (!window.confirm(`Trocar o modelo da IA de ${name} para ${label}?\n\nVale a partir da próxima mensagem dos clientes.`)) return;
    const { error } = await (supabase as any).from("ai_agent_settings").update({ model }).eq("company_id", companyId);
    if (error) {
      toast.error("Não consegui trocar o modelo");
      return;
    }
    setModels((prev) => ({ ...prev, [companyId]: model }));
    toast.success(`${name}: agora com ${label}`);
  }

  async function toggleAI(companyId: string, enabled: boolean) {
    const company = companyMap.get(companyId);
    const currentSettings = (company?.settings || {}) as Record<string, unknown>;
    const { error } = await supabase
      .from("companies")
      .update({ settings: { ...currentSettings, ai_enabled: enabled } })
      .eq("id", companyId);

    if (error) {
      toast.error("Erro ao atualizar configuração");
    } else {
      toast.success(enabled ? "IA ativada" : "IA desativada");
      setCompanies(prev => prev.map(c => c.id === companyId ? { ...c, settings: { ...currentSettings, ai_enabled: enabled } } : c));
    }
  }

  function isAIEnabled(companyId: string): boolean {
    const company = companyMap.get(companyId);
    const settings = company?.settings as Record<string, unknown> | null;
    return settings?.ai_enabled !== false; // default true
  }

  function formatDate(iso: string | null): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  return (
    <HubLayout currentPage="consumo-ia" header={<h2 className="font-semibold text-lg">Consumo IA</h2>}>
      {() => (<div className="space-y-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Brain className="h-6 w-6 text-primary" />
              Consumo de IA
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Quanto cada empresa gasta com IA (atendimento no WhatsApp e outras funções) e qual modelo usa
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">7 dias</SelectItem>
                <SelectItem value="30">30 dias</SelectItem>
                <SelectItem value="90">90 dias</SelectItem>
              </SelectContent>
            </Select>
            <Select value={selectedCompany} onValueChange={setSelectedCompany}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Todas empresas" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas empresas</SelectItem>
                {companies.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Kpi icon={<Coins className="h-5 w-5 text-emerald-500" />} tone="bg-emerald-500/10" label="Gasto total" loading={loading}
            value={formatUsd(summary.totalUsd)} hint={`≈ ${formatBrlFromUsd(summary.totalUsd)}`} />
          <Kpi icon={<MessageCircle className="h-5 w-5 text-primary" />} tone="bg-primary/10" label="Atendimento no WhatsApp" loading={loading}
            value={formatUsd(summary.whatsappUsd)} hint={`${summary.conversations.toLocaleString("pt-BR")} conversas · ${formatUsd(summary.conversations ? summary.whatsappUsd / summary.conversations : 0)} por conversa`} />
          <Kpi icon={<Brain className="h-5 w-5 text-violet-500" />} tone="bg-violet-500/10" label="Outras funções" loading={loading}
            value={formatUsd(summary.otherUsd)} hint="Artes, campanhas, resumos e suporte" />
        </div>

        {/* Por provedor e por modelo */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><Cpu className="h-4 w-4" /> Por modelo</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading ? <Skeleton className="h-24 w-full" /> : (
              <>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(summary.byProvider).sort((a, b) => b[1] - a[1]).map(([prov, usd]) => (
                    <div key={prov} className="rounded-lg border px-3 py-2">
                      <p className="text-[11px] text-muted-foreground">{PROVIDER_LABELS[prov] || prov}</p>
                      <p className="text-sm font-semibold">{formatUsd(usd)}</p>
                    </div>
                  ))}
                </div>
                {summary.byProvider.anthropic !== undefined && (
                  <p className="text-[11px] text-muted-foreground">
                    O gasto com Claude sai do crédito mensal de US$ 100 do plano Max (Console da Anthropic). Sem crédito, a IA em Claude para de responder até o próximo mês.
                  </p>
                )}
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Modelo</TableHead>
                        <TableHead className="text-right">Chamadas</TableHead>
                        <TableHead className="text-right">Custo</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summary.byModel.map((m) => (
                        <TableRow key={m.model}>
                          <TableCell className="font-medium">{m.label}</TableCell>
                          <TableCell className="text-right">{m.calls.toLocaleString("pt-BR")}</TableCell>
                          <TableCell className="text-right">{formatUsd(m.usd)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Chart */}
        {chartData.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="h-4 w-4" />
                Gasto por função (US$)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} className="fill-muted-foreground" interval={0} />
                  <YAxis tick={{ fontSize: 12 }} className="fill-muted-foreground" />
                  <RechartsTooltip formatter={(v: number) => formatUsd(v)} />
                  <Bar dataKey="custo" name="Custo" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {/* Table by company */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Por empresa</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : companyRows.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                Nenhum dado de consumo registrado no período selecionado.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Empresa</TableHead>
                      <TableHead>Modelo da IA</TableHead>
                      <TableHead className="text-right">Conversas</TableHead>
                      <TableHead className="text-right">WhatsApp</TableHead>
                      <TableHead className="text-right">Outras</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Última</TableHead>
                      <TableHead className="text-center">IA ativa</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {companyRows.map(row => (
                      <TableRow key={row.companyId}>
                        <TableCell className="font-medium">{row.companyName}</TableCell>
                        <TableCell className="min-w-[200px]">
                          {models[row.companyId] ? (
                            <Select value={models[row.companyId]} onValueChange={(v) => changeModel(row.companyId, v)}>
                              <SelectTrigger className="h-9 text-xs" aria-label={`Modelo da IA de ${row.companyName}`}>
                                <SelectValue>{getAiModel(models[row.companyId])?.label || models[row.companyId]}</SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                {AI_MODELS.map((m) => <SelectItem key={m.id} value={m.id} className="text-xs">{m.label}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          ) : (
                            <span className="text-xs text-muted-foreground">IA de atendimento não configurada</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">{row.conversations.toLocaleString("pt-BR")}</TableCell>
                        <TableCell className="text-right">{formatUsd(row.whatsappUsd)}</TableCell>
                        <TableCell className="text-right">{formatUsd(row.otherUsd)}</TableCell>
                        <TableCell className="text-right font-semibold">
                          {formatUsd(row.totalUsd)}
                          <span className="block text-[10px] font-normal text-muted-foreground">≈ {formatBrlFromUsd(row.totalUsd)}</span>
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground text-xs">
                          {formatDate(row.lastAt)}
                        </TableCell>
                        <TableCell className="text-center">
                          <Switch
                            checked={isAIEnabled(row.companyId)}
                            onCheckedChange={(checked) => toggleAI(row.companyId, checked)}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>)}
    </HubLayout>
  );
}

function Kpi({ icon, tone, label, value, hint, loading }: { icon: React.ReactNode; tone: string; label: string; value: string; hint: string; loading: boolean }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${tone}`}>{icon}</div>
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">{label}</p>
            {loading ? <Skeleton className="h-7 w-24" /> : (
              <>
                <p className="text-2xl font-bold">{value}</p>
                <p className="text-[11px] text-muted-foreground">{hint}</p>
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
