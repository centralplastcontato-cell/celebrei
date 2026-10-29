import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import {
  evolutionConnectionEvent,
  evolutionNumber,
  extractEvolutionMessageId,
  isEvolutionPayload,
  mediaUrlProblem,
  parseDataUrl,
  normalizeEvolutionPayload,
  redactEvolutionPayload,
  sameToken,
} from "./evolution.ts";

// Payloads reais capturados na instância de teste (09/10/2026), encurtados
const envelope = { instanceId: "dcd61a4e-a22d-4604-b826-f7219e028ceb", instanceName: "celebrei-go", instanceToken: "tok-123" };

const fromMeText = {
  ...envelope,
  event: "Message",
  data: {
    Info: {
      Chat: "191826157928683@lid", ID: "3A17524592FB6C73F6D7", IsFromMe: true, IsGroup: false, MediaType: "",
      PushName: "VAMU 3D", RecipientAlt: "5515981121710@s.whatsapp.net", Sender: "67848252715201@lid", SenderAlt: "",
      Timestamp: "2026-10-09T17:36:00-03:00", Type: "text",
    },
    Message: { extendedTextMessage: { text: "Teste tehdjdjdjdjdndnd", contextInfo: { expiration: 7776000 } } },
  },
};

const clientImage = {
  ...envelope,
  event: "Message",
  data: {
    Info: {
      Chat: "5515981121710@s.whatsapp.net", ID: "2A0DF5D903B758722C1D", IsFromMe: false, IsGroup: false, MediaType: "image",
      PushName: "Vitor", RecipientAlt: "", Sender: "5515981121710@s.whatsapp.net", SenderAlt: "191826157928683@lid",
      Timestamp: "2026-10-09T17:35:32-03:00", Type: "media",
    },
    Message: {
      imageMessage: { URL: "https://mmg.whatsapp.net/o1/v/t24/x", directPath: "/o1/v/t24/x", mediaKey: "gdD9", mimetype: "image/jpeg", height: 640, width: 640 },
    },
  },
};

const clientAudio = {
  ...envelope,
  event: "Message",
  data: {
    Info: {
      Chat: "5515981121710@s.whatsapp.net", ID: "2AA145F22789EF624AFA", IsFromMe: false, IsGroup: false, MediaType: "ptt",
      PushName: "Vitor", Sender: "5515981121710@s.whatsapp.net", SenderAlt: "191826157928683@lid",
      Timestamp: "2026-10-09T17:35:25-03:00", Type: "media",
    },
    Message: { audioMessage: { PTT: true, URL: "https://mmg.whatsapp.net/v/t62/y", mediaKey: "l+2T", mimetype: "audio/ogg; codecs=opus", seconds: 3 } },
  },
};

const groupText = {
  ...envelope,
  event: "Message",
  data: {
    Info: {
      Chat: "120363410944720544@g.us", Sender: "556199343704@s.whatsapp.net", SenderAlt: "243400259428534@lid",
      IsFromMe: false, IsGroup: true, ID: "A577DC08D45A7A1145980F415BDC743C", PushName: "Geração Sonora Escola de Música",
      Timestamp: "2026-10-09T17:49:05-03:00", Type: "text", MediaType: "",
    },
    Message: { conversation: "Pessoal, sobre vender com cpf ou CNPJ" },
  },
};

const receipt = (state: string, type: string, ids: string[], isFromMe = false) => ({
  ...envelope,
  event: "Receipt",
  state,
  data: { Chat: "191826157928683@lid", IsFromMe: isFromMe, IsGroup: false, MessageIDs: ids, Sender: "191826157928683@lid", Type: type },
});

Deno.test("envelope da Evolution é reconhecido; Z-API/W-API não", () => {
  assertEquals(isEvolutionPayload(fromMeText), true);
  assertEquals(isEvolutionPayload({ event: "messages.upsert", instanceId: "x", data: {} }), false);
  assertEquals(isEvolutionPayload({ type: "ReceivedCallback", phone: "55", instanceId: "x" }), false);
});

Deno.test("mensagem do celular da equipe: @lid na chave e telefone real (RecipientAlt) no sender", () => {
  const n = normalizeEvolutionPayload(fromMeText)!;
  assertEquals(n.event, "messages.upsert");
  assertEquals(n.instanceId, envelope.instanceId);
  assertEquals(n.data.key, { fromMe: true, id: "3A17524592FB6C73F6D7", remoteJid: "191826157928683@lid" });
  assertEquals(n.data.sender, { id: "5515981121710@s.whatsapp.net" });
  assertEquals(n.data.message.extendedTextMessage.text, "Teste tehdjdjdjdjdndnd");
  assertEquals(n.data.messageTimestamp, Math.floor(Date.parse("2026-10-09T20:36:00Z") / 1000));
});

Deno.test("foto do cliente: telefone + @lid, URL vira url", () => {
  const n = normalizeEvolutionPayload(clientImage)!;
  assertEquals(n.data.key.remoteJid, "191826157928683@lid");
  assertEquals(n.data.sender.id, "5515981121710@s.whatsapp.net");
  assertEquals(n.data.key.fromMe, false);
  assertEquals(n.data.pushName, "Vitor");
  assertEquals(n.data.message.imageMessage.url, "https://mmg.whatsapp.net/o1/v/t24/x");
  assertEquals(n.data.message.imageMessage.mediaKey, "gdD9");
});

Deno.test("áudio de voz: PTT vira ptt e URL vira url", () => {
  const n = normalizeEvolutionPayload(clientAudio)!;
  assertEquals(n.data.message.audioMessage.ptt, true);
  assertEquals(n.data.message.audioMessage.url, "https://mmg.whatsapp.net/v/t62/y");
});

Deno.test("grupo continua grupo: Chat @g.us e quem falou em participant", () => {
  const n = normalizeEvolutionPayload(groupText)!;
  assertEquals(n.data.key.remoteJid, "120363410944720544@g.us");
  assertEquals(n.data.key.participant, "556199343704@s.whatsapp.net");
  assertEquals(n.data.sender, undefined);
  assertEquals(n.data.message.conversation, "Pessoal, sobre vender com cpf ou CNPJ");
});

Deno.test("cliente só com telefone (sem @lid): telefone direto na chave", () => {
  const p = structuredClone(clientImage);
  p.data.Info.SenderAlt = "";
  const n = normalizeEvolutionPayload(p)!;
  assertEquals(n.data.key.remoteJid, "5515981121710@s.whatsapp.net");
  assertEquals(n.data.sender, undefined);
});

Deno.test("recibos: Delivered/Read viram tiques; ReadSelf e sem id são ignorados", () => {
  assertEquals(normalizeEvolutionPayload(receipt("Delivered", "", ["3A17524592FB6C73F6D7"])), {
    event: "webhookDelivery", instanceId: envelope.instanceId, data: { messageId: "3A17524592FB6C73F6D7", ids: ["3A17524592FB6C73F6D7"], status: "DELIVERED" },
  });
  assertEquals(normalizeEvolutionPayload(receipt("Read", "read", ["A", "B"]))!.data.ids, ["A", "B"]);
  assertEquals(normalizeEvolutionPayload(receipt("Read", "read", ["A"]))!.data.status, "READ");
  assertEquals(normalizeEvolutionPayload(receipt("ReadSelf", "read-self", ["2AA1", "2A0D"], true)), null);
  assertEquals(normalizeEvolutionPayload(receipt("Delivered", "", [])), null);
});

Deno.test("clique de botão: usa o Message (selectedButtonID → selectedButtonId) e ignora o ButtonClick", () => {
  const p = structuredClone(clientImage) as any;
  p.data.Message = { buttonsResponseMessage: { selectedButtonID: "opt_1", selectedDisplayText: "Agendar visita" } };
  const n = normalizeEvolutionPayload(p)!;
  assertEquals(n.data.message.buttonsResponseMessage.selectedButtonId, "opt_1");
  assertEquals(normalizeEvolutionPayload({ ...envelope, event: "ButtonClick", data: { selectedButtonID: "opt_1" } }), null);
});

Deno.test("reação vira [Reação] apontando para a mensagem; reação removida fica vazia", () => {
  const p = structuredClone(clientImage) as any;
  p.data.Message = { reactionMessage: { key: { id: "MSG123" }, text: "❤️" } };
  const n = normalizeEvolutionPayload(p)!;
  assertEquals(n.data.message, { conversation: "[Reação] ❤️" });
  assertEquals(n.data.referenceMessageId, "MSG123");
  p.data.Message = { reactionMessage: { key: { id: "MSG123" }, text: "" } };
  assertEquals(normalizeEvolutionPayload(p)!.data.message, {});
});

Deno.test("eventos de conexão não viram mensagem; viram aviso para o monitor", () => {
  assertEquals(normalizeEvolutionPayload({ ...envelope, event: "LoggedOut", data: {} }), null);
  assertEquals(normalizeEvolutionPayload({ ...envelope, event: "Connected", data: {} }), null);
  assertEquals(evolutionConnectionEvent({ ...envelope, event: "LoggedOut", data: {} })?.hint, "needs_qr");
  assertEquals(evolutionConnectionEvent({ ...envelope, event: "Disconnected", data: {} })?.hint, "reconnecting");
  assertEquals(evolutionConnectionEvent({ ...envelope, event: "Connected", data: {} })?.hint, "online");
  assertEquals(evolutionConnectionEvent({ ...envelope, event: "Message", data: {} }), null);
});

Deno.test("token: comparação exata e log sem o token", () => {
  assertEquals(sameToken("abc", "abc"), true);
  assertEquals(sameToken("abc", "abd"), false);
  assertEquals(sameToken("", ""), false);
  assertEquals(redactEvolutionPayload(fromMeText).instanceToken, "***");
});

Deno.test("número de envio e id da resposta", () => {
  assertEquals(evolutionNumber("5515981121710@s.whatsapp.net"), "5515981121710");
  assertEquals(evolutionNumber("+55 (15) 98112-1710"), "5515981121710");
  assertEquals(evolutionNumber("120363410944720544@g.us"), "120363410944720544@g.us");
  assertEquals(extractEvolutionMessageId({ data: { Info: { ID: "3EB0ABCDEF123456" } } }), "3EB0ABCDEF123456");
  assertEquals(extractEvolutionMessageId({ data: { id: "3EB0ABCDEF999999" } }), "3EB0ABCDEF999999");
  assertEquals(extractEvolutionMessageId({ message: "ok" }), null);
});

Deno.test("link bloqueado (HTML/403) não vira vídeo vazio: envio é barrado antes", () => {
  assertEquals(mediaUrlProblem(200, "video/mp4"), null);
  assertEquals(mediaUrlProblem(206, "application/pdf"), null);
  assertEquals(mediaUrlProblem(200, null), null);
  assertEquals(mediaUrlProblem(403, "text/plain"), "o link da mídia respondeu 403");
  assertEquals(mediaUrlProblem(200, "text/html; charset=utf-8"), "o link da mídia não devolve o arquivo (text/html)");
});

Deno.test("download da Evolution: data URL vira bytes + mimetype", () => {
  const p = parseDataUrl("data:audio/ogg; codecs=opus;base64,T2dnUw==")!;
  assertEquals(p.mime, "audio/ogg");
  assertEquals(new TextDecoder().decode(p.bytes), "OggS");
  assertEquals(parseDataUrl("T2dnUw=="), null);
});

Deno.test("reação do contato e remoção (formato real de 09/10)", () => {
  const base = structuredClone(clientImage) as any;
  base.data.Message = { reactionMessage: { key: { ID: "3EB0A4B9CB37CA4FAE1672", fromMe: false, remoteJID: "67848252715201@lid" }, text: "❤️" } };
  const n = normalizeEvolutionPayload(base)!;
  assertEquals(n.data.message, { conversation: "[Reação] ❤️" });
  assertEquals(n.data.referenceMessageId, "3EB0A4B9CB37CA4FAE1672");
  base.data.Message = { reactionMessage: { key: { ID: "3EB0A4B9CB37CA4FAE1672" }, senderTimestampMS: 1 } };
  assertEquals(normalizeEvolutionPayload(base)!.data.message, {});
});

Deno.test("resposta citando: stanzaID da Evolution vira stanzaId", () => {
  const p = structuredClone(clientImage) as any;
  p.data.Message = { extendedTextMessage: { text: "Teste F", contextInfo: { stanzaID: "3EB0A4B9CB37CA4FAE1672", participant: "67848252715201@lid" } } };
  const n = normalizeEvolutionPayload(p)!;
  assertEquals(n.data.message.extendedTextMessage.contextInfo.stanzaId, "3EB0A4B9CB37CA4FAE1672");
  assertEquals(n.data.message.extendedTextMessage.text, "Teste F");
  p.data.Message = { imageMessage: { URL: "https://mmg.whatsapp.net/x", contextInfo: { stanzaID: "3EB00D1DC0C2D64426C916" } } };
  assertEquals(normalizeEvolutionPayload(p)!.data.message.imageMessage.contextInfo.stanzaId, "3EB00D1DC0C2D64426C916");
});

Deno.test("prévia do link: só links de formulário/contrato, sempre com https://", async () => {
  const { linkPreviewText } = await import("./evolution.ts");
  assertEquals(
    linkPreviewText("Preencha aqui:\n\nwww.castelodadiversao.com.br/dados/S7VVHZE\n\nObrigado!"),
    "Preencha aqui:\n\nhttps://www.castelodadiversao.com.br/dados/S7VVHZE\n\nObrigado!",
  );
  assertEquals(linkPreviewText("https://buffet.com.br/avaliacao/x/y"), "https://buffet.com.br/avaliacao/x/y");
  assertEquals(linkPreviewText("Veja nosso Instagram instagram.com/castelo"), null);
  assertEquals(linkPreviewText("Oi! Tudo bem?"), null);
  assertEquals(linkPreviewText("email contato@buffet.com.br/dados/x"), null);
});
