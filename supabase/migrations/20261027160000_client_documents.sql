-- Documento com foto (RG/CNH) no formulário de dados do contratante (Castelo 27/10).
-- Cada buffet escolhe: não pedir / opcional / obrigatório (padrão: não pedir).
-- O arquivo vai para um bucket PRIVADO: o cliente só envia enquanto o pedido de
-- dados dele está aberto; só a equipe do buffet consegue abrir.
ALTER TABLE public.form_automation_settings
  ADD COLUMN IF NOT EXISTS document_upload text NOT NULL DEFAULT 'off';
DO $$ BEGIN
  ALTER TABLE public.form_automation_settings
    ADD CONSTRAINT form_automation_settings_document_upload_check CHECK (document_upload IN ('off', 'optional', 'required'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('client-documents', 'client-documents', false, 10485760,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- Como o buffet pede o documento (o formulário público lê pelo token)
CREATE OR REPLACE FUNCTION public.get_client_data_document_mode(_token text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT s.document_upload
    FROM public.client_data_requests r
    JOIN public.form_automation_settings s ON s.company_id = r.company_id AND s.form_type = 'contrato'
    WHERE r.token = _token
    LIMIT 1
  ), 'off');
$$;
GRANT EXECUTE ON FUNCTION public.get_client_data_document_mode(text) TO anon, authenticated;

-- Pode subir arquivo em <empresa>/<token>/…? Só com o pedido aberto e o buffet pedindo documento
CREATE OR REPLACE FUNCTION public.client_document_upload_allowed(_company text, _token text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.client_data_requests r
    JOIN public.form_automation_settings s ON s.company_id = r.company_id AND s.form_type = 'contrato'
    WHERE r.token = _token
      AND r.company_id::text = _company
      AND r.status IN ('pending', 'sent')
      AND s.document_upload <> 'off'
  );
$$;
GRANT EXECUTE ON FUNCTION public.client_document_upload_allowed(text, text) TO anon, authenticated;

DROP POLICY IF EXISTS "client_documents_upload" ON storage.objects;
CREATE POLICY "client_documents_upload" ON storage.objects
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    bucket_id = 'client-documents'
    AND public.client_document_upload_allowed((storage.foldername(name))[1], (storage.foldername(name))[2])
  );

DROP POLICY IF EXISTS "client_documents_team_read" ON storage.objects;
CREATE POLICY "client_documents_team_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'client-documents'
    AND (storage.foldername(name))[1] = ANY (SELECT unnest(public.get_user_company_ids(auth.uid()))::text)
  );
