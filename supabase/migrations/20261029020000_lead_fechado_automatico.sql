-- Fechado automático (29/10): o lead vira "Fechado" sozinho quando
--   1) uma festa (não cancelada) é cadastrada ou ligada a ele, ou
--   2) o contrato dele é assinado.
-- Não mexe em quem já está Fechado nem em contatos que não são cliente
-- (Trabalhe Conosco, Fornecedor, Outros). A pré-reserva fica em outra tabela
-- (pre_reservations) e não fecha o lead.
CREATE OR REPLACE FUNCTION public.auto_close_lead(_lead_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.campaign_leads
  SET status = 'fechado'
  WHERE id = _lead_id
    AND status NOT IN ('fechado', 'trabalhe_conosco', 'fornecedor', 'outros');
$$;

CREATE OR REPLACE FUNCTION public.trg_event_closes_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL AND COALESCE(NEW.status, '') <> 'cancelado'
     AND (TG_OP = 'INSERT' OR OLD.lead_id IS DISTINCT FROM NEW.lead_id OR OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public.auto_close_lead(NEW.lead_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_closes_lead ON public.company_events;
CREATE TRIGGER trg_event_closes_lead
  AFTER INSERT OR UPDATE OF lead_id, status ON public.company_events
  FOR EACH ROW EXECUTE FUNCTION public.trg_event_closes_lead();

CREATE OR REPLACE FUNCTION public.trg_contract_signed_closes_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL AND NEW.status = 'assinado'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'assinado') THEN
    PERFORM public.auto_close_lead(NEW.lead_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contract_signed_closes_lead ON public.generated_contracts;
CREATE TRIGGER trg_contract_signed_closes_lead
  AFTER INSERT OR UPDATE OF status ON public.generated_contracts
  FOR EACH ROW EXECUTE FUNCTION public.trg_contract_signed_closes_lead();

REVOKE ALL ON FUNCTION public.auto_close_lead(uuid) FROM PUBLIC, anon, authenticated;
