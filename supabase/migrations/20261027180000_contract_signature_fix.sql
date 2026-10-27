-- Assinatura digital (27/10): errar o código 3 vezes não mata mais o link.
-- Antes: 3 erros → status 'expired' e o "Reenviar código" respondia "Token
-- expirado" para sempre (a equipe tinha de gerar outro link). Agora: 3 erros
-- apagam o código e o cliente pede outro. IP real vem da função contract-otp.
CREATE OR REPLACE FUNCTION public.submit_contract_signature(
  _token text,
  _otp text,
  _signature_base64 text,
  _ip text,
  _user_agent text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_sig record;
  v_content text;
  v_hash text;
BEGIN
  SELECT * INTO v_sig FROM public.contract_signatures WHERE token = _token;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Link inválido.');
  END IF;

  IF v_sig.status = 'signed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Este contrato já foi assinado.');
  END IF;

  IF _signature_base64 IS NULL OR length(_signature_base64) < 100 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Desenhe sua assinatura antes de confirmar.');
  END IF;

  IF v_sig.otp_code IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Peça um novo código para continuar.', 'need_new_code', true);
  END IF;

  IF v_sig.otp_sent_at IS NULL OR (now() - v_sig.otp_sent_at) > interval '10 minutes' THEN
    UPDATE public.contract_signatures SET otp_code = NULL WHERE id = v_sig.id;
    RETURN jsonb_build_object('success', false, 'error', 'O código venceu (vale 10 minutos). Peça um novo.', 'need_new_code', true);
  END IF;

  IF v_sig.otp_code <> trim(_otp) THEN
    IF COALESCE(v_sig.otp_attempts, 0) + 1 >= 3 THEN
      UPDATE public.contract_signatures SET otp_attempts = 0, otp_code = NULL, status = 'pending' WHERE id = v_sig.id;
      RETURN jsonb_build_object('success', false, 'error', 'Código errado 3 vezes. Peça um novo código.', 'need_new_code', true);
    END IF;
    UPDATE public.contract_signatures SET otp_attempts = COALESCE(otp_attempts, 0) + 1 WHERE id = v_sig.id;
    RETURN jsonb_build_object('success', false, 'error', 'Código incorreto. Confira e tente de novo.', 'attempts_left', 2 - COALESCE(v_sig.otp_attempts, 0));
  END IF;

  SELECT conteudo_renderizado INTO v_content FROM public.generated_contracts WHERE id = v_sig.contract_id;
  v_hash := encode(digest(v_content, 'sha256'), 'hex');

  UPDATE public.contract_signatures SET
    signature_image_url = _signature_base64,
    document_hash = v_hash,
    ip_address = _ip,
    user_agent = _user_agent,
    otp_verified_at = now(),
    signed_at = now(),
    otp_code = NULL,
    status = 'signed'
  WHERE id = v_sig.id;

  UPDATE public.generated_contracts SET status = 'assinado', signature_token = _token WHERE id = v_sig.contract_id;

  -- Outros links abertos do mesmo contrato deixam de valer
  UPDATE public.contract_signatures SET status = 'expired', otp_code = NULL
  WHERE contract_id = v_sig.contract_id AND id <> v_sig.id AND status IN ('pending', 'otp_sent');

  INSERT INTO public.contract_audit_logs (company_id, contract_id, template_id, action, details, performed_by)
  SELECT v_sig.company_id, v_sig.contract_id, gc.template_id, 'contract_signed',
    jsonb_build_object('signer_name', v_sig.signer_name, 'signer_phone', v_sig.signer_phone, 'ip', _ip, 'hash', v_hash, 'signed_by', 'public_signer'),
    NULL
  FROM public.generated_contracts gc WHERE gc.id = v_sig.contract_id;

  INSERT INTO public.notifications (user_id, company_id, type, title, message, data)
  SELECT uc.user_id, v_sig.company_id, 'contract_signed',
    '✅ Contrato assinado!',
    COALESCE(v_sig.signer_name, 'Cliente') || ' assinou o contrato digitalmente.',
    jsonb_build_object('contract_id', v_sig.contract_id, 'signer_name', v_sig.signer_name)
  FROM public.user_companies uc WHERE uc.company_id = v_sig.company_id;

  RETURN jsonb_build_object('success', true);
END;
$$;
