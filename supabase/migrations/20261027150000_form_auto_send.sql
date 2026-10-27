-- Envio automático de formulários (Automações → Formulários), por buffet:
-- cardápio X minutos depois do contrato gerado; avaliação X horas depois da festa.
-- Começa desligado em todos os buffets; quem envia é o follow-up-check.
ALTER TABLE public.form_automation_settings
  ADD COLUMN IF NOT EXISTS auto_send boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_delay_minutes integer,
  ADD COLUMN IF NOT EXISTS auto_enabled_at timestamptz;

COMMENT ON COLUMN public.form_automation_settings.auto_send IS 'Envia sozinho (cardápio: depois do contrato gerado; avaliação: depois da festa)';
COMMENT ON COLUMN public.form_automation_settings.auto_delay_minutes IS 'Espera em minutos (cardápio: após gerar o contrato; avaliação: após o fim da festa)';
COMMENT ON COLUMN public.form_automation_settings.auto_enabled_at IS 'Quando foi ligado: contratos/festas de antes disso não recebem envio';
