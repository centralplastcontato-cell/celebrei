-- Quem marca as visitas (28/10): 'ia' (padrão — a IA oferece horários e
-- agenda) ou 'equipe' (a IA não oferece horários; quem quer visitar vai
-- para a equipe, que combina o dia). Pedido do Mega Magic.
ALTER TABLE public.ai_agent_settings
  ADD COLUMN IF NOT EXISTS visit_scheduling text NOT NULL DEFAULT 'ia';
ALTER TABLE public.ai_agent_settings DROP CONSTRAINT IF EXISTS ai_agent_settings_visit_scheduling_check;
ALTER TABLE public.ai_agent_settings
  ADD CONSTRAINT ai_agent_settings_visit_scheduling_check CHECK (visit_scheduling IN ('ia', 'equipe'));
