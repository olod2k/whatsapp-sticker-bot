import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setStickerMetadata } from "./webp-exif.js";

const require = createRequire(import.meta.url);

/**
 * Caminho do ffmpeg: FFMPEG_PATH > ffmpeg-static (Windows/Linux/Mac) >
 * "ffmpeg" do sistema (Termux: `pkg install ffmpeg`).
 */
function resolveFfmpeg(): string {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    try {
        const p: string | null = require("ffmpeg-static");
        if (p) return p;
    } catch {}
    return "ffmpeg";
}

export const FFMPEG = resolveFfmpeg();

// Limites do WhatsApp para figurinhas.
const SIZE = 512;
const MAX_STATIC_BYTES = 100 * 1024;
const MAX_ANIMATED_BYTES = 500 * 1024;

export type StickerOptions = {
    animated: boolean;
    pack: string;
    author: string;
    /** "contain" mantém a imagem inteira (bordas transparentes), "cover" corta em quadrado. */
    fit?: "contain" | "cover";
    /** Duração máxima em segundos para vídeos/GIFs. */
    maxSeconds?: number;
};

function run(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
        let stderr = "";
        proc.stderr.on("data", (d) => (stderr += d));
        proc.on("error", (err) =>
            reject(new Error(`Não foi possível executar o ffmpeg (${FFMPEG}): ${err.message}`)),
        );
        proc.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`ffmpeg saiu com código ${code}: ${stderr.trim()}`)),
        );
    });
}

/**
 * Encaixa a mídia num quadro SIZE x SIZE transparente. `inner` < SIZE
 * encolhe o conteúdo (usado como último recurso para caber no limite).
 */
function scaleFilter(fit: "contain" | "cover", inner: number = SIZE): string {
    const pad = `pad=${SIZE}:${SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
    return fit === "cover"
        ? `scale=${inner}:${inner}:force_original_aspect_ratio=increase,crop=${inner}:${inner},${pad}`
        : `scale=${inner}:${inner}:force_original_aspect_ratio=decrease,${pad}`;
}

/**
 * Tentativas em ordem decrescente de qualidade. A figurinha animada é
 * sempre 512x512 (exigência do WhatsApp); o que muda é fps, qualidade,
 * duração e, por último, o tamanho do conteúdo dentro do quadro.
 */
const ANIMATED_ATTEMPTS = [
    { fps: 15, quality: 60, secondsFactor: 1, inner: 512 },
    { fps: 12, quality: 45, secondsFactor: 1, inner: 512 },
    { fps: 10, quality: 30, secondsFactor: 1, inner: 512 },
    { fps: 10, quality: 25, secondsFactor: 0.75, inner: 400 },
    { fps: 8, quality: 20, secondsFactor: 0.5, inner: 320 },
    { fps: 6, quality: 15, secondsFactor: 0.4, inner: 256 },
    { fps: 5, quality: 10, secondsFactor: 0.3, inner: 192 },
];

const STATIC_QUALITIES = [90, 75, 60, 45, 30, 15];

async function convert(input: Buffer, opts: StickerOptions, dir: string): Promise<Buffer> {
    const inFile = path.join(dir, "input");
    const outFile = path.join(dir, "output.webp");
    await writeFile(inFile, input);
    const fit = opts.fit ?? "contain";

    if (!opts.animated) {
        let last: Buffer | undefined;
        for (const q of STATIC_QUALITIES) {
            await run([
                "-i", inFile,
                "-vf", `${scaleFilter(fit)},format=rgba`,
                "-frames:v", "1",
                "-c:v", "libwebp", "-lossless", "0", "-q:v", String(q),
                "-compression_level", "6",
                outFile,
            ]);
            last = await readFile(outFile);
            if (last.length <= MAX_STATIC_BYTES) return last;
        }
        return last!;
    }

    const maxSeconds = opts.maxSeconds ?? 8;
    let last: Buffer | undefined;
    for (const a of ANIMATED_ATTEMPTS) {
        const seconds = Math.max(1, +(maxSeconds * a.secondsFactor).toFixed(2));
        await run([
            "-t", String(seconds),
            "-i", inFile,
            "-vf", `fps=${a.fps},${scaleFilter(fit, a.inner)},format=yuva420p`,
            "-an", "-c:v", "libwebp", "-lossless", "0",
            "-q:v", String(a.quality), "-compression_level", "6",
            "-loop", "0", "-preset", "default",
            "-fps_mode", "passthrough",
            outFile,
        ]);
        last = await readFile(outFile);
        if (last.length <= MAX_ANIMATED_BYTES) return last;
    }
    if (last && last.length > MAX_ANIMATED_BYTES) {
        throw new Error("O vídeo ficou grande demais para virar figurinha, tente um trecho menor.");
    }
    return last!;
}

export async function makeSticker(input: Buffer, opts: StickerOptions): Promise<Buffer> {
    const dir = await mkdtemp(path.join(tmpdir(), "sticker-"));
    try {
        const webp = await convert(input, opts, dir);
        return setStickerMetadata(webp, opts.pack, opts.author);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
