/*
 * Testa a conversão sem precisar do WhatsApp:
 *   npx tsx scripts/test-sticker.ts <pasta-com-midias> <pasta-de-saida>
 * Converte todo .jpg/.jpeg/.png/.webp (estático) e .mp4/.gif (animado).
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FFMPEG, makeSticker } from "../src/sticker.js";
import { getStickerMetadata, readChunks } from "../src/webp-exif.js";

const [dir, out = "./test-output"] = process.argv.slice(2);
if (!dir) throw new Error("uso: npx tsx scripts/test-sticker.ts <pasta-com-midias> [pasta-de-saida]");
await mkdir(out, { recursive: true });
console.log("ffmpeg:", FFMPEG);

for (const file of await readdir(dir)) {
    const ext = path.extname(file).toLowerCase();
    const animated = [".mp4", ".gif", ".mov", ".webm"].includes(ext);
    if (!animated && ![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) continue;
    for (const fit of ["contain", "cover"] as const) {
        const t = Date.now();
        const buf = await makeSticker(await readFile(path.join(dir, file)), {
            animated, fit, pack: "Pack", author: "Feito por: Teste",
        });
        await writeFile(path.join(out, `${file}.${fit}.webp`), buf);
        const chunks = readChunks(buf);
        const flags = chunks[0].data[0];
        console.log(
            `${file} [${fit}] ${(buf.length / 1024).toFixed(0)}KB`,
            `frames=${chunks.filter((c) => c.fourcc === "ANMF").length || 1}`,
            `alpha=${!!(flags & 0x10)} exif=${!!(flags & 0x08)}`,
            `${Date.now() - t}ms`,
            JSON.stringify(getStickerMetadata(buf)),
        );
    }
}
