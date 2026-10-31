-- "Aprenda a usar": vídeo de onde colocar a imagem da assistente (personagem) do buffet. Pode rodar de novo: não duplica.
insert into public.training_lessons (title, description, video_url, thumbnail_url, category, sort_order, is_published)
select v.title, v.description, v.video_url, v.thumbnail_url, v.category, v.sort_order, true
from (values
  ('A cara do seu buffet: o personagem da IA', 'Veja onde colocar a imagem da assistente do seu buffet: na primeira mensagem da IA, nos follow-ups e nos lembretes da festa.', '/videos/ia-personagem.mp4', '/videos/ia-personagem.jpg', 'Inteligência Artificial', 5)
) as v(title, description, video_url, thumbnail_url, category, sort_order)
where not exists (select 1 from public.training_lessons t where t.video_url = v.video_url);
