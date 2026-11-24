import {
    downloadMediaMessage,
    proto as WAProto,
    getContentType,
    normalizeMessageContent,
    type proto,
    type WAMessage,
    type WASocket,
} from "baileys";
import type { Logger } from "pino";

import { config } from "./config.js";
import { makeSticker } from "./sticker.js";
import { setStickerMetadata } from "./webp-exif.js";

const STICKER_COMMANDS = ["sticker", "s", "fig", "figurinha", "f"];
const MENU_COMMANDS = ["menu", "help", "ajuda"];
const CROP_WORDS = ["crop", "c", "quadrado", "cortar"];
const MAX_INPUT_BYTES = 64 * 1024 * 1024;

/** Dependências externas (trocáveis nos testes). */
export const deps = {
    download: (message: WAMessage, sock: WASocket, logger: Logger): Promise<Buffer> =>
        downloadMediaMessage(message, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage }),
};

type Media =
    | { kind: "image" | "video" | "gif" | "sticker"; message: WAMessage; animated: boolean }
    | undefined;

/** Fila simples para não abrir ffmpeg demais ao mesmo tempo (ex.: Termux). */
let running = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= config.maxConcurrent) await new Promise<void>((r) => waiting.push(r));
    running++;
    try {
        return await fn();
    } finally {
        running--;
        waiting.shift()?.();
    }
}

function textOf(content: proto.IMessage | undefined): string {
    return (
        content?.conversation ||
        content?.extendedTextMessage?.text ||
        content?.imageMessage?.caption ||
        content?.videoMessage?.caption ||
        content?.documentMessage?.caption ||
        content?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
        ""
    ).trim();
}

/** Descobre se a própria mensagem (ou a respondida) tem mídia usável. */
function mediaOf(content: proto.IMessage | undefined | null, msg: WAMessage): Media {
    content = normalizeMessageContent(content);
    if (!content) return undefined;
    const as = (message: proto.IMessage): WAMessage => ({ ...msg, message });

    if (content.imageMessage) return { kind: "image", message: as(content), animated: false };
    if (content.videoMessage) {
        const gif = !!content.videoMessage.gifPlayback;
        return { kind: gif ? "gif" : "video", message: as(content), animated: true };
    }
    if (content.stickerMessage) {
        return { kind: "sticker", message: as(content), animated: !!content.stickerMessage.isAnimated };
    }
    const doc =
        content.documentMessage ?? content.documentWithCaptionMessage?.message?.documentMessage;
    const mime = doc?.mimetype ?? "";
    if (doc && (mime.startsWith("image/") || mime.startsWith("video/"))) {
        const animated = mime.startsWith("video/") || mime === "image/gif";
        return { kind: animated ? "video" : "image", message: as(content), animated };
    }
    return undefined;
}

function quotedOf(msg: WAMessage, content: proto.IMessage): WAMessage | undefined {
    const type = getContentType(content);
    const ctx: proto.IContextInfo | undefined = type
        ? (content[type] as { contextInfo?: proto.IContextInfo } | undefined)?.contextInfo ?? undefined
        : undefined;
    if (!ctx?.quotedMessage) return undefined;
    return {
        key: {
            remoteJid: msg.key.remoteJid,
            id: ctx.stanzaId,
            participant: ctx.participant,
            fromMe: false,
        },
        message: ctx.quotedMessage,
    };
}

function mediaSize(m: WAMessage): number {
    const c = m.message!;
    const doc = c.documentMessage ?? c.documentWithCaptionMessage?.message?.documentMessage;
    const len = c.imageMessage?.fileLength ?? c.videoMessage?.fileLength ?? doc?.fileLength ?? 0;
    return Number(len);
}

function menu(): string {
    const p = config.prefix;
    return (
        "*🎨 Bot de Figurinhas*\n\n" +
        `• Envie uma *foto, vídeo ou GIF* com a legenda *${p}sticker* (ou *${p}s*)\n` +
        `• Ou *responda* uma mídia com *${p}sticker*\n` +
        `• *${p}s crop* → corta em quadrado em vez de manter a imagem inteira\n` +
        `• *${p}s Meu Pack | Meu Nome* → muda pack/autor\n` +
        `• Responda uma *figurinha* com *${p}s* para colocar seu nome nela\n\n` +
        `Vídeos usam os primeiros ${config.maxVideoSeconds}s.`
    );
}

export async function handleMessage(sock: WASocket, msg: WAMessage, logger: Logger): Promise<void> {
    const content = normalizeMessageContent(msg.message);
    const chat = msg.key.remoteJid;
    if (!chat || chat === "status@broadcast") return;

    if (msg.messageStubType === WAProto.WebMessageInfo.StubType.CIPHERTEXT) {
        logger.warn(
            `Não consegui ler uma mensagem de ${msg.pushName || chat} (${msg.messageStubParameters?.[0] ?? "sem detalhes"}). ` +
                "É normal logo após parear: o WhatsApp reenvia sozinho, ou peça para mandar de novo.",
        );
        return;
    }
    if (!content) return;

    const text = textOf(content);
    logger.debug(
        `msg de ${msg.pushName || "?"} em ${chat} fromMe=${!!msg.key.fromMe} ` +
            `tipo=${getContentType(content)} texto=${JSON.stringify(text.slice(0, 40))}`,
    );
    if (!text.startsWith(config.prefix)) return;
    logger.info(`Comando recebido de ${msg.pushName || chat}: ${text.slice(0, 40)}`);

    const [rawCmd, ...rest] = text.slice(config.prefix.length).trim().split(/\s+/);
    const cmd = rawCmd?.toLowerCase() ?? "";
    const isGroup = chat.endsWith("@g.us");
    if (config.onlyGroups && !isGroup) return;

    if (MENU_COMMANDS.includes(cmd)) {
        await sock.sendMessage(chat, { text: menu() }, { quoted: msg });
        return;
    }
    if (!STICKER_COMMANDS.includes(cmd)) return;

    let args = rest;
    const fit = args[0] && CROP_WORDS.includes(args[0].toLowerCase()) ? "cover" : "contain";
    if (fit === "cover") args = args.slice(1);

    const name = msg.pushName || "alguém";
    const [customPack, customAuthor] = args.join(" ").split("|").map((s) => s.trim());
    const pack = customPack || config.packName;
    const author = customAuthor || config.authorTemplate.replace("{nome}", name);

    const media = mediaOf(content, msg) ?? (() => {
        const quoted = quotedOf(msg, content);
        return quoted ? mediaOf(quoted.message, quoted) : undefined;
    })();

    if (!media) {
        await sock.sendMessage(
            chat,
            { text: `Envie ou responda uma *imagem, vídeo ou GIF* com *${config.prefix}sticker*.` },
            { quoted: msg },
        );
        return;
    }
    if (mediaSize(media.message) > MAX_INPUT_BYTES) {
        await sock.sendMessage(chat, { text: "Arquivo grande demais (máx. 64 MB)." }, { quoted: msg });
        return;
    }

    try {
        await sock.sendMessage(chat, { react: { text: "⌛", key: msg.key } });

        const input = await deps.download(media.message, sock, logger);

        const sticker =
            media.kind === "sticker"
                ? // figurinha pronta: só troca pack/autor (mantém animação)
                  setStickerMetadata(input, pack, author)
                : await withSlot(() =>
                      makeSticker(input, {
                          animated: media.animated,
                          fit,
                          pack,
                          author,
                          maxSeconds: config.maxVideoSeconds,
                      }),
                  );

        await sock.sendMessage(chat, { sticker, isAnimated: media.animated }, { quoted: msg });
        await sock.sendMessage(chat, { react: { text: "✅", key: msg.key } });
        logger.info(`${name} gerou figurinha (${media.kind}, ${(sticker.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
        logger.error({ err }, "falha ao gerar figurinha");
        await sock.sendMessage(chat, { react: { text: "❌", key: msg.key } }).catch(() => {});
        const reason = err instanceof Error ? err.message : String(err);
        await sock
            .sendMessage(chat, { text: `Não consegui fazer a figurinha 😕\n${reason}` }, { quoted: msg })
            .catch(() => {});
    }
}
