-- "Aprenda a usar": vídeo "Ensinar a IA" (corrigir respostas por texto ou áudio).
-- O arquivo fica no site (public/videos). Pode rodar de novo: não duplica.
insert into public.training_lessons (title, description, video_url, thumbnail_url, category, sort_order, is_published)
select
  'Ensinar a IA: corrija uma resposta',
  'A IA respondeu errado? Veja como corrigir no teste, por texto ou áudio, conferir o que ela aprendeu e desligar ou apagar um ensinamento.',
  '/videos/ia-ensinar.mp4',
  '/videos/ia-ensinar.jpg',
  'Inteligência Artificial',
  1,
  true
where not exists (
  select 1 from public.training_lessons where video_url = '/videos/ia-ensinar.mp4'
);
