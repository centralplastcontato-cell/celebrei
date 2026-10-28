-- "Aprenda a usar": vídeos Testar a sua IA, Pacotes e valores e Campanhas.
-- Os arquivos ficam no site (public/videos). Pode rodar de novo: não duplica.
insert into public.training_lessons (title, description, video_url, thumbnail_url, category, sort_order, is_published)
select v.title, v.description, v.video_url, v.thumbnail_url, v.category, v.sort_order, true
from (values
  ('Testar a sua IA antes do cliente', 'Converse com a sua IA como se fosse um cliente: pelo site ou pelo WhatsApp, valores, fotos, visita e quando ela passa para a equipe.', '/videos/ia-testar.mp4', '/videos/ia-testar.jpg', 'Inteligência Artificial', 2),
  ('Pacotes e valores do jeito certo', 'Como cadastrar cada pacote: o que inclui, se a IA pode passar valor, a grade de preços e o convidado extra.', '/videos/pacotes-valores.mp4', '/videos/pacotes-valores.jpg', 'Operações', 0),
  ('Campanhas com mensagens e arte da IA', 'Campanhas prontas (datas livres e outras), as 5 mensagens da IA, a arte feita pela IA, o público e o envio.', '/videos/campanhas.mp4', '/videos/campanhas.jpg', 'Atendimento', 0)
) as v(title, description, video_url, thumbnail_url, category, sort_order)
where not exists (select 1 from public.training_lessons t where t.video_url = v.video_url);
