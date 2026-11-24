import makeWASocket, {
    Browsers,
    DisconnectReason,
    fetchLatestBaileysVersion,
    useMultiFileAuthState,
} from "baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";

import { handleMessage } from "./commands.js";
import { config } from "./config.js";
import { FFMPEG } from "./sticker.js";

const logger = pino({
    level: process.env.LOG_LEVEL ?? "info",
    transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" } },
});
// Baileys é muito verboso; só mostra avisos dele.
const baileysLogger = logger.child({ module: "baileys" }, { level: process.env.BAILEYS_LOG ?? "warn" });

async function start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    const sock = makeWASocket({
        auth: state,
        logger: baileysLogger,
        browser: Browsers.ubuntu("Chrome"),
        markOnlineOnConnect: false,
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
                    `\nCódigo de pareamento: ${code}\n` +
                        "WhatsApp → Aparelhos conectados → Conectar com número de telefone\n",
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
            if (status === DisconnectReason.loggedOut) {
                logger.error(
                    `Sessão encerrada no celular. Apague a pasta "${config.authDir}" e rode de novo para parear.`,
                );
                process.exit(1);
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
            if (type !== "notify" && !(msg.key.fromMe && recent)) continue;
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
