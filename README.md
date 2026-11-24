# 🎨 WhatsApp Sticker Bot

Réplica, focada em figurinhas, do [whatsapp-sticker3](https://github.com/vinnybrunn00/whatsapp-sticker3).
Usa **[Baileys](https://github.com/WhiskeySockets/Baileys)** (sem Chrome, sem licença paga) e **ffmpeg** local para converter
imagens, vídeos e GIFs em figurinhas.

## Por que o vídeo não funcionava no bot original

O original foi migrado para o `@open-wa/wa-automate` v5, em que `sendSticker` usa o runtime `@open-wa/stickers`.
Esse runtime **não tem decodificador de MP4** em nenhum backend (no navegador aceita só GIF/PNG/WebP/AVIF; o README dele diz
"Standalone AVIF and MP4 are not yet implemented"). Como todo vídeo e GIF do WhatsApp chega como MP4, a figurinha de vídeo sempre
falha. Além disso, o próprio open-wa v5 diz que o envio de figurinhas exige licença.

Aqui a conversão é feita localmente com ffmpeg (`libwebp_anim`), então funciona com qualquer vídeo/GIF.

## Comandos

| Comando | O que faz |
| :--- | :--- |
| `!sticker` / `!s` / `!fig` | Na legenda de uma foto/vídeo/GIF, **ou respondendo** uma mídia, gera a figurinha |
| `!s crop` | Corta em quadrado (padrão: mantém a imagem inteira com bordas transparentes) |
| `!s Meu Pack \| Meu Nome` | Define pack e autor da figurinha |
| `!s` respondendo uma figurinha | Coloca seu nome/pack numa figurinha existente (mantém animação) |
| `!menu` | Mostra a ajuda |

Também funciona com mídia de visualização única e com imagem/vídeo enviados como documento.

Vídeos usam os primeiros 8 s (configurável). A figurinha sai sempre 512×512 e dentro dos limites do WhatsApp
(100 KB estática, 500 KB animada): se passar, o bot reduz fps/qualidade automaticamente.

## Instalação

Precisa de **Node.js 20+**.

```bash
git clone <este-repo> sticker-bot
cd sticker-bot
npm install
cp .env.example .env   # opcional, para mudar pack, prefixo etc.
npm start
```

Escaneie o QR code em **WhatsApp → Aparelhos conectados → Conectar um aparelho**.
A sessão fica salva na pasta `auth/` (não precisa escanear de novo).

Prefere código em vez de QR? Coloque `PAIRING_NUMBER=5511999998888` no `.env`.

### ffmpeg

No Windows, Linux e Mac o `npm install` já baixa um ffmpeg (pacote `ffmpeg-static`). No **Termux**:

```bash
pkg install nodejs ffmpeg
```

Se quiser usar outro, defina `FFMPEG_PATH` no `.env`.

### Produção

```bash
npm run build
npm run prod
```

## Testar a conversão sem WhatsApp

```bash
npm run test:sticker -- ./minhas-midias ./saida
```

Converte todo `.jpg/.png/.webp` e `.mp4/.gif` da pasta e mostra tamanho, quadros e metadados de cada figurinha.

## Estrutura

```
src/
  index.ts      conexão (QR/código, reconexão)
  commands.ts   !sticker, !menu
  sticker.ts    conversão com ffmpeg
  webp-exif.ts  grava pack/autor no WebP
  config.ts     variáveis do .env
```
