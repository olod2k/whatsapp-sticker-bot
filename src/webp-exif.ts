/*
 * Injeta o chunk EXIF com pack/autor numa figurinha WebP.
 *
 * Feito à mão porque o node-webpmux, ao regravar WebP animado, perde a
 * flag de transparência do VP8X e as bordas viram pretas.
 */

type Chunk = { fourcc: string; data: Buffer };

const FLAG_ALPHA = 0x10;
const FLAG_EXIF = 0x08;

export function readChunks(webp: Buffer): Chunk[] {
    if (webp.toString("ascii", 0, 4) !== "RIFF" || webp.toString("ascii", 8, 12) !== "WEBP") {
        throw new Error("Arquivo não é um WebP válido.");
    }
    const chunks: Chunk[] = [];
    let off = 12;
    while (off + 8 <= webp.length) {
        const fourcc = webp.toString("ascii", off, off + 4);
        const size = webp.readUInt32LE(off + 4);
        chunks.push({ fourcc, data: webp.subarray(off + 8, off + 8 + size) });
        off += 8 + size + (size & 1);
    }
    return chunks;
}

function writeChunks(chunks: Chunk[]): Buffer {
    const parts: Buffer[] = [];
    for (const { fourcc, data } of chunks) {
        const head = Buffer.alloc(8);
        head.write(fourcc, 0, "ascii");
        head.writeUInt32LE(data.length, 4);
        parts.push(head, data);
        if (data.length & 1) parts.push(Buffer.alloc(1));
    }
    const body = Buffer.concat(parts);
    const riff = Buffer.alloc(12);
    riff.write("RIFF", 0, "ascii");
    riff.writeUInt32LE(body.length + 4, 4);
    riff.write("WEBP", 8, "ascii");
    return Buffer.concat([riff, body]);
}

/** Dimensões de um WebP simples (sem VP8X). */
function simpleSize(chunk: Chunk): [number, number] {
    const d = chunk.data;
    if (chunk.fourcc === "VP8L") {
        const bits = d.readUInt32LE(1);
        return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
    }
    // VP8 (lossy): largura/altura nos bytes 6..9 do quadro-chave
    return [d.readUInt16LE(6) & 0x3fff, d.readUInt16LE(8) & 0x3fff];
}

function stickerExif(pack: string, author: string): Buffer {
    const json = Buffer.from(
        JSON.stringify({
            "sticker-pack-id": `sticker-bot-${Date.now()}`,
            "sticker-pack-name": pack,
            "sticker-pack-publisher": author,
            emojis: [""],
        }),
        "utf-8",
    );
    // Cabeçalho TIFF com uma tag 0x5741 (formato usado pelo WhatsApp)
    const tiff = Buffer.from([
        0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
        0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
    ]);
    tiff.writeUInt32LE(json.length, 14);
    return Buffer.concat([tiff, json]);
}

export function setStickerMetadata(webp: Buffer, pack: string, author: string): Buffer {
    let chunks = readChunks(webp).filter((c) => c.fourcc !== "EXIF");

    let vp8x = chunks.find((c) => c.fourcc === "VP8X");
    if (!vp8x) {
        const image = chunks.find((c) => c.fourcc === "VP8 " || c.fourcc === "VP8L");
        if (!image) throw new Error("WebP sem dados de imagem.");
        const [w, h] = simpleSize(image);
        const data = Buffer.alloc(10);
        if (image.fourcc === "VP8L" || chunks.some((c) => c.fourcc === "ALPH")) data[0] |= FLAG_ALPHA;
        data.writeUIntLE(w - 1, 4, 3);
        data.writeUIntLE(h - 1, 7, 3);
        vp8x = { fourcc: "VP8X", data };
        chunks = [vp8x, ...chunks];
    } else {
        vp8x.data = Buffer.from(vp8x.data); // não alterar o buffer original
    }
    vp8x.data[0] |= FLAG_EXIF;

    chunks.push({ fourcc: "EXIF", data: stickerExif(pack, author) });
    return writeChunks(chunks);
}

/** Lê pack/autor de volta (usado nos testes). */
export function getStickerMetadata(webp: Buffer): Record<string, unknown> | undefined {
    const exif = readChunks(webp).find((c) => c.fourcc === "EXIF");
    if (!exif) return undefined;
    const len = exif.data.readUInt32LE(14);
    return JSON.parse(exif.data.subarray(22, 22 + len).toString("utf-8"));
}
