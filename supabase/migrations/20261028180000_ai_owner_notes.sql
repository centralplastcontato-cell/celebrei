-- "Ensinar a IA" (28/10): o dono do buffet corrige uma resposta do teste ou
-- manda uma orientação (texto ou áudio) e ela vira uma regra que a IA segue
-- sempre — só naquele buffet. A IA lê; quem grava é a tela do buffet.
CREATE TABLE IF NOT EXISTS public.ai_owner_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  text text NOT NULL CHECK (char_length(text) BETWEEN 3 AND 1500),
  kind text NOT NULL DEFAULT 'orientacao', -- orientacao (jeito de atender) | informacao (fato do buffet)
  source text NOT NULL DEFAULT 'ensinar', -- ensinar | teste
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_owner_notes_company ON public.ai_owner_notes (company_id, created_at);

ALTER TABLE public.ai_owner_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view ai owner notes for their companies" ON public.ai_owner_notes;
CREATE POLICY "Users can view ai owner notes for their companies"
  ON public.ai_owner_notes FOR SELECT TO authenticated
  USING (company_id IN (SELECT unnest(public.get_user_company_ids(auth.uid()))));

DROP POLICY IF EXISTS "Users can insert ai owner notes for their companies" ON public.ai_owner_notes;
CREATE POLICY "Users can insert ai owner notes for their companies"
  ON public.ai_owner_notes FOR INSERT TO authenticated
  WITH CHECK (company_id IN (SELECT unnest(public.get_user_company_ids(auth.uid()))));

DROP POLICY IF EXISTS "Users can update ai owner notes for their companies" ON public.ai_owner_notes;
CREATE POLICY "Users can update ai owner notes for their companies"
  ON public.ai_owner_notes FOR UPDATE TO authenticated
  USING (company_id IN (SELECT unnest(public.get_user_company_ids(auth.uid()))));

DROP POLICY IF EXISTS "Users can delete ai owner notes for their companies" ON public.ai_owner_notes;
CREATE POLICY "Users can delete ai owner notes for their companies"
  ON public.ai_owner_notes FOR DELETE TO authenticated
  USING (company_id IN (SELECT unnest(public.get_user_company_ids(auth.uid()))));
