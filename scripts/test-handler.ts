/* Simula mensagens do WhatsApp com um socket falso (sem conexão real).
 * Uso: npx tsx scripts/test-handler.ts <pasta com photo.jpg, vertical.mp4 e wide_gif.mp4> */
import { readFile } from "node:fs/promises";
import pino from "pino";
import { deps, handleMessage } from "../src/commands.js";
import { getStickerMetadata, readChunks } from "../src/webp-exif.js";

const media = process.argv[2];
const files: Record<string, string> = { img: "photo.jpg", vid: "vertical.mp4", gif: "wide_gif.mp4" };
let lastSticker: Buffer | undefined;
deps.download = async (m) => {
    const c = m.message!;
    if (c.stickerMessage) return lastSticker!;
    const key = c.imageMessage ? "img" : c.videoMessage?.gifPlayback ? "gif" : "vid";
    return readFile(`${media}/${files[key]}`);
};
const sock: any = {
    sendMessage: async (jid: string, content: any) => {
        if (content.sticker) {
            lastSticker = content.sticker;
            const ch = readChunks(content.sticker);
            console.log("   -> sticker", (content.sticker.length / 1024).toFixed(0) + "KB", "animated:", content.isAnimated,
                "frames:", ch.filter((c) => c.fourcc === "ANMF").length || 1, JSON.stringify(getStickerMetadata(content.sticker)).slice(40));
        } else if (content.react) console.log("   -> react", content.react.text);
        else console.log("   -> text", JSON.stringify(content.text).slice(0, 90));
    },
};
const logger = pino({ level: "silent" });
const base = (message: any) => ({ key: { remoteJid: "123@g.us", id: "X", fromMe: false }, pushName: "Gabriel", message });
const ctx = (quotedMessage: any) => ({ stanzaId: "Q", participant: "9@s.whatsapp.net", quotedMessage });
const cases: [string, any][] = [
    ["foto com legenda !sticker", { imageMessage: { caption: "!sticker", mimetype: "image/jpeg" } }],
    ["vídeo com legenda !s crop", { videoMessage: { caption: "!s crop", seconds: 15 } }],
    ["resposta a GIF com '!fig Meu Pack | Eu'", { extendedTextMessage: { text: "!fig Meu Pack | Eu", contextInfo: ctx({ videoMessage: { gifPlayback: true } }) } }],
    ["resposta a figurinha com !s (renomear)", { extendedTextMessage: { text: "!s Roubei | Gabriel", contextInfo: ctx({ stickerMessage: { isAnimated: true } }) } }],
    ["view once com !s", { viewOnceMessageV2: { message: { imageMessage: { caption: "!s" } } } }],
    ["texto !sticker sem mídia", { conversation: "!sticker" }],
    ["!menu", { conversation: "!menu" }],
    ["mensagem comum (ignorar)", { conversation: "oi tudo bem" }],
];
for (const [name, message] of cases) {
    console.log("*", name);
    await handleMessage(sock, base(message) as any, logger as any);
}
