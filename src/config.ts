import "dotenv/config";

function bool(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined || value === "") return fallback;
    return ["1", "true", "sim", "yes"].includes(value.toLowerCase());
}

export const config = {
    /** Prefixo dos comandos. */
    prefix: process.env.PREFIX ?? "!",
    /** Nome do pacote gravado na figurinha. */
    packName: process.env.PACK_NAME ?? "hubberBot",
    /** Autor gravado na figurinha; {nome} vira o nome de quem pediu. */
    authorTemplate: process.env.AUTHOR ?? "Feito por: {nome}",
    /** Se true, só responde em grupos (como o bot original). */
    onlyGroups: bool(process.env.ONLY_GROUPS, false),
    /** Segundos de vídeo/GIF usados na figurinha (WhatsApp aceita até ~10). */
    maxVideoSeconds: Math.min(10, Math.max(1, Number(process.env.MAX_VIDEO_SECONDS ?? 8))),
    /** Número (com DDI, só dígitos) para conectar por código em vez de QR. */
    pairingNumber: process.env.PAIRING_NUMBER?.replace(/\D/g, "") || undefined,
    /** Pasta onde a sessão do WhatsApp fica salva. */
    authDir: process.env.AUTH_DIR ?? "auth",
    /** Quantas conversões rodam ao mesmo tempo. */
    maxConcurrent: Math.max(1, Number(process.env.MAX_CONCURRENT ?? 2)),
};
