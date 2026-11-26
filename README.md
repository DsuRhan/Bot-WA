# WhatsApp video sticker bot

This bot watches only videos that you send **from the paired account to its own WhatsApp number**. Add the configured caption (default: `!sticker`) to a video to convert it.

The bot sends an animated WebP sticker with its audio attached as one `audioStickerMessage`, using the Elaina Baileys fork's extended WhatsApp message schema. This is a nonstandard/experimental message type and may not render as a voiced sticker on every WhatsApp client.

## Requirements

- Node.js 20 or newer
- `ffprobe` available on `PATH` or configured with `FFPROBE_PATH`; `ffmpeg-static` supplies FFmpeg on supported platforms (its binary must include the `libwebp_anim` and `libopus` encoders)
- A WhatsApp account to pair with the bot

## Setup

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Scan the QR code printed in the terminal with the WhatsApp account that should run the bot. Its login credentials and keys are stored in the single `auth_info.json` file; keep it private and do not share it. Existing `auth_info/` multi-file sessions are migrated automatically on first startup, and the old files are left untouched. After the first pairing, start with `npm start` (after `npm run build`) and the saved session will be reused.

Set `TRIGGER_CAPTION` in `.env` to change the exact caption required. Matching ignores letter case and surrounding whitespace. `MAX_VIDEO_BYTES` sets the maximum video download size; videos must also be no longer than 60 seconds and the animated sticker must fit WhatsApp's 500 KiB limit.

Audio is resampled to mono 48 kHz, timestamp-reset, and encoded as Ogg Opus at 48 kb/s to normalize differing source audio formats. Baileys logs default to warnings and errors; set `LOG_LEVEL` in `.env` to adjust verbosity.

If the bundled FFmpeg binary is unavailable or incompatible with your platform, set `FFMPEG_PATH` in `.env` to a compatible executable. Set `FFPROBE_PATH` if `ffprobe` is not on `PATH`.
