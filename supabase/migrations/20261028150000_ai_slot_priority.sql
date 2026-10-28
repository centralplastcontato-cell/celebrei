-- Ordem de venda dos horários de festa (do que mais vende ao que menos vende).
-- Com ela, a IA oferece primeiro os horários que menos vendem, perto da data
-- pedida. Vazio = como antes (mesmo dia da semana, ordem de calendário).
ALTER TABLE public.ai_agent_settings ADD COLUMN IF NOT EXISTS slot_priority jsonb;

COMMENT ON COLUMN public.ai_agent_settings.slot_priority IS
  'Lista do que mais vende ao que menos vende, ex.: ["sab-noite","sab-almoco","sex-noite","dom-almoco","dom-noite","qui","qua","ter","seg"]';
