-- "Aprenda a usar": vídeos da plataforma (atendimento, leads, agenda, contratos,
-- financeiro, formulários e materiais/lembretes da IA). Pode rodar de novo: não duplica.
insert into public.training_lessons (title, description, video_url, thumbnail_url, category, sort_order, is_published)
select v.title, v.description, v.video_url, v.thumbnail_url, v.category, v.sort_order, true
from (values
  ('Central de Atendimento', 'As conversas do WhatsApp num lugar só: status do cliente, responder com materiais e áudio, atalhos, filtros e o aviso de visita.', '/videos/central-atendimento.mp4', '/videos/central-atendimento.jpg', 'Atendimento', 1),
  ('Leads e funil de vendas', 'Lista de leads, métricas e filtros, o funil (CRM), a ficha do cliente e o "Precisam de atenção".', '/videos/leads-crm.mp4', '/videos/leads-crm.jpg', 'Atendimento', 2),
  ('Agenda de festas e visitas', 'Resumo do mês, calendário, nova festa, pré-reserva e visitas.', '/videos/agenda.mp4', '/videos/agenda.jpg', 'Agenda e festas', 0),
  ('Contratos com assinatura digital', 'Modelos com variáveis, gerar o contrato da festa, enviar para assinar pelo celular e o comprovante.', '/videos/contratos.mp4', '/videos/contratos.jpg', 'Operações', 1),
  ('Financeiro do buffet', 'Visão do mês, receitas, despesas, festas e o resultado do período.', '/videos/financeiro.mp4', '/videos/financeiro.jpg', 'Financeiro', 0),
  ('Formulários do cliente', 'Pré-festa, cardápio e avaliação: como montar, ver as respostas e ligar o envio automático.', '/videos/formularios.mp4', '/videos/formularios.jpg', 'Operações', 2),
  ('Materiais e lembretes da IA', 'Os materiais que a IA envia (PDF, fotos, vídeo) e os lembretes para quem parou de responder.', '/videos/ia-materiais-lembretes.mp4', '/videos/ia-materiais-lembretes.jpg', 'Inteligência Artificial', 3)
) as v(title, description, video_url, thumbnail_url, category, sort_order)
where not exists (select 1 from public.training_lessons t where t.video_url = v.video_url);
