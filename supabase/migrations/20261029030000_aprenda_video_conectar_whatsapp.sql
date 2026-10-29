-- "Aprenda a usar": vídeo de como o próprio buffet conecta o número de WhatsApp.
-- Pode rodar de novo: não duplica.
insert into public.training_lessons (title, description, video_url, thumbnail_url, category, sort_order, is_published)
select v.title, v.description, v.video_url, v.thumbnail_url, v.category, v.sort_order, true
from (values
  ('Conectar o WhatsApp', 'Como conectar o número do buffet: QR Code pelo celular ou código pelo telefone, e como conferir se está conectado.', '/videos/whatsapp-conectar.mp4', '/videos/whatsapp-conectar.jpg', 'Atendimento', 0)
) as v(title, description, video_url, thumbnail_url, category, sort_order)
where not exists (select 1 from public.training_lessons t where t.video_url = v.video_url);
