-- "Aprenda a usar": vídeo da tela de Promoção da IA. Pode rodar de novo: não duplica.
insert into public.training_lessons (title, description, video_url, thumbnail_url, category, sort_order, is_published)
select v.title, v.description, v.video_url, v.thumbnail_url, v.category, v.sort_order, true
from (values
  ('Promoção que a IA oferece', 'Cadastre a promoção do momento (o que o cliente ganha, até quando vale e para quais festas) e veja a IA oferecer depois dos valores.', '/videos/ia-promocao.mp4', '/videos/ia-promocao.jpg', 'Inteligência Artificial', 4)
) as v(title, description, video_url, thumbnail_url, category, sort_order)
where not exists (select 1 from public.training_lessons t where t.video_url = v.video_url);
