import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
const assert: (v: unknown) => asserts v = (v) => { if (!v) throw new Error("assert falhou"); };
import { decodeHtmlEntities, parseSocialPost, socialPostNote, socialPostUrl } from "./social-post.ts";

Deno.test("decodeHtmlEntities: emojis em hexa/decimal e &amp;", () => {
  assertEquals(decodeHtmlEntities("&#x1f5a4;&#x1f389; MEGA BLACK"), "🖤🎉 MEGA BLACK");
  assertEquals(decodeHtmlEntities("&#127881; festa &amp; alegria &quot;já&quot;"), '🎉 festa & alegria "já"');
  assertEquals(decodeHtmlEntities("a.jpg?stp=x&amp;_nc_cat=1&amp;oh=2"), "a.jpg?stp=x&_nc_cat=1&oh=2");
  assertEquals(decodeHtmlEntities("&naoexiste; fica"), "&naoexiste; fica");
});

Deno.test("socialPostUrl: post, reel e links sem https", () => {
  assertEquals(socialPostUrl("instagram.com/p/DfIfu7kEkH8/"), "https://instagram.com/p/DfIfu7kEkH8/");
  assertEquals(socialPostUrl("olha https://www.instagram.com/reel/AbC_1-2/?igsh=xyz"), "https://www.instagram.com/reel/AbC_1-2/?igsh=xyz");
  assertEquals(socialPostUrl("https://www.tiktok.com/@buffet/video/123"), "https://www.tiktok.com/@buffet/video/123");
  assertEquals(socialPostUrl("vi no instagram de vocês"), null);
  assertEquals(socialPostUrl("https://instagram.com/buffetmegamagic"), null); // perfil, não post
});

Deno.test("parseSocialPost: Instagram (título + descrição com curtidas)", () => {
  const post = parseSocialPost(
    "https://instagram.com/p/DfIfu7kEkH8/",
    "Buffet Mega Magic no Instagram: &quot;&#x1f5a4;&#x1f389; MEGA BLACK...&quot;",
    "3 likes, 0 comments - buffetmegamagicpremium on October 30, 2026: &quot;&#x1f5a4;&#x1f389; MEGA BLACK FRIDAY: festa fechada até 30/11 ganha decoração premium.&quot;",
  );
  assert(post);
  assertEquals(post.network, "Instagram");
  assertEquals(post.author, "Buffet Mega Magic");
  assertEquals(post.caption, "🖤🎉 MEGA BLACK FRIDAY: festa fechada até 30/11 ganha decoração premium.");
  const note = socialPostNote(post);
  assert(note.includes("post do Instagram de Buffet Mega Magic"));
  assert(note.includes("MEGA BLACK FRIDAY"));
  assert(note.includes("sem dizer que não consegue abrir"));
});

Deno.test("parseSocialPost: só o título", () => {
  const post = parseSocialPost("https://instagram.com/p/x/", 'Buffet X on Instagram: "Promoção de dezembro"', "");
  assertEquals(post?.caption, "Promoção de dezembro");
  assertEquals(post?.author, "Buffet X");
});

Deno.test("parseSocialPost: página de login sem nada útil", () => {
  assertEquals(parseSocialPost("https://instagram.com/p/x/", "", ""), null);
});
