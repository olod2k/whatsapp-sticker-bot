import makeWASocket, {
    Browsers,
    DisconnectReason,
    fetchLatestBaileysVersion,
    useMultiFileAuthState,
} from "baileys";
import { rm } from "node:fs/promises";
import pino from "pino";
import qrcode from "qrcode-terminal";

import { handleMessage } from "./commands.js";
import { config } from "./config.js";
import { FFMPEG } from "./sticker.js";

const logger = pino({
    level: process.env.LOG_LEVEL ?? "info",
    transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" } },
});
// Baileys é muito verboso (ex.: avisos de sincronização de contatos que não
// afetam o bot); só mostra erros dele.
const baileysLogger = logger.child({ module: "baileys" }, { level: process.env.BAILEYS_LOG ?? "error" });

async function start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    const sock = makeWASocket({
        auth: state,
        logger: baileysLogger,
        browser: Browsers.ubuntu("Chrome"),
        markOnlineOnConnect: false,
        // o bot não precisa do histórico de conversas: economiza CPU, RAM e dados
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        ...(version ? { version } : {}),
    });

    sock.ev.on("creds.update", saveCreds);

    let pairingRequested = false;
    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            if (config.pairingNumber && !state.creds.registered && !pairingRequested) {
                pairingRequested = true;
                const code = await sock.requestPairingCode(config.pairingNumber);
                console.log(
                    `\nCódigo de pareamento: ${code.slice(0, 4)}-${code.slice(4)}\n` +
                        "WhatsApp → Aparelhos conectados → Conectar um aparelho →\n" +
                        "Conectar com número de telefone. Vale por ~2 minutos; se expirar,\n" +
                        "um código novo é gerado sozinho.\n",
                );
            } else if (!config.pairingNumber) {
                console.log("\nEscaneie o QR code em WhatsApp → Aparelhos conectados:\n");
                qrcode.generate(qr, { small: true });
            }
        }

        if (connection === "open") {
            logger.info(`Conectado como ${sock.user?.id}. ffmpeg: ${FFMPEG}`);
        }

        if (connection === "close") {
            const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
            // Pareamento não concluído (código expirou) ou aparelho desconectado
            // no celular: a sessão salva não serve mais, então recomeça do zero.
            if (status === DisconnectReason.loggedOut || !state.creds.registered) {
                logger.warn(
                    status === DisconnectReason.loggedOut && state.creds.registered
                        ? "Sessão encerrada no celular. Gerando novo pareamento..."
                        : "Pareamento não concluído a tempo. Gerando novo código...",
                );
                await rm(config.authDir, { recursive: true, force: true });
                setTimeout(start, 2000);
                return;
            }
            logger.warn(`Conexão caiu (código ${status}), reconectando...`);
            setTimeout(start, status === DisconnectReason.restartRequired ? 0 : 3000);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        for (const msg of messages) {
            // "notify" = mensagem nova; "append" pega comandos que você mesmo
            // manda do celular quando o bot roda no seu número.
            const recent = Date.now() / 1000 - Number(msg.messageTimestamp ?? 0) < 60;
            if (type !== "notify" && !(msg.key.fromMe && recent)) {
                logger.debug(`ignorada (upsert=${type}, fromMe=${!!msg.key.fromMe}, recente=${recent})`);
                continue;
            }
            // não bloqueia a fila de eventos enquanto converte vídeo
            handleMessage(sock, msg, logger).catch((err) =>
                logger.error({ err }, "erro ao processar mensagem"),
            );
        }
    });
}

start().catch((err) => {
    logger.fatal({ err }, "falha ao iniciar");
    process.exit(1);
});
