# WhatsApp video sticker bot

This bot watches only videos that you send **from the paired account to its own WhatsApp number**. Add the configured caption (default: `!sticker`) to a video to convert it.

The bot sends an animated WebP sticker with its audio attached as one `audioStickerMessage`, using the Elaina Baileys fork's extended WhatsApp message schema. This is a nonstandard/experimental message type and may not render as a voiced sticker on every WhatsApp client.

## Requirements

- Node.js 20 or newer
- FFmpeg and FFprobe available on `PATH` (FFmpeg must include the `libwebp_anim` and `libopus` encoders)
- A WhatsApp account to pair with the bot

## Setup

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Scan the QR code printed in the terminal with the WhatsApp account that should run the bot. Its login credentials are stored in `auth_info/`; keep that directory private and do not share it. After the first pairing, start with `npm start` (after `npm run build`) and the saved session will be reused.

Set `TRIGGER_CAPTION` in `.env` to change the exact caption required. Matching ignores letter case and surrounding whitespace. `MAX_VIDEO_BYTES` sets the maximum video download size; videos must also be no longer than 10 seconds and the animated sticker must fit WhatsApp's 500 KiB limit.

If FFmpeg is not on `PATH`, set `FFMPEG_PATH` and `FFPROBE_PATH` in `.env` to the executable paths.
