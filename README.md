# WhatsApp video sticker bot

This bot converts media sent to the paired account, as well as media you send from that account to its own number. Use the caption `!sticker` on an image for a still sticker, `!gif` on a video for an animated sticker without audio, or `!voiced` on a video for an animated sticker with its audio attached. For media received in a group chat, the bot privately sends the result to the sender.

For `!voiced`, the bot attaches the video's audio to an animated WebP sticker in one `audioStickerMessage`, using the Elaina Baileys fork's extended WhatsApp message schema. This is a nonstandard/experimental message type and may not render as a voiced sticker on every WhatsApp client.

## Requirements

- Node.js 20 or newer
- `ffmpeg-static` supplies FFmpeg on supported platforms (its binary must include the `libwebp_anim` and `libopus` encoders)
- A WhatsApp account to pair with the bot

## Setup

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Scan the QR code printed in the terminal with the WhatsApp account that should run the bot. Its login credentials and keys are stored in the single `auth_info.json` file; keep it private and do not share it. Existing `auth_info/` multi-file sessions are migrated automatically on first startup, and the old files are left untouched. After the first pairing, start with `npm start` (after `npm run build`) and the saved session will be reused.

Matching ignores letter case and surrounding whitespace. `MAX_VIDEO_BYTES` sets the maximum downloaded media size. For videos longer than 10 seconds, the bot uses only the first 10 seconds to create the animated sticker and, for `!voiced`, its audio. Stickers preserve the source aspect ratio, scale within a 512 × 512-pixel bounding box, and must fit WhatsApp's 500 KiB limit.

Audio is resampled to mono 48 kHz, timestamp-reset, and encoded as Ogg Opus at 48 kb/s to normalize differing source audio formats. Baileys logs default to warnings and errors; set `LOG_LEVEL` in `.env` to adjust verbosity.

If the bundled FFmpeg binary is unavailable or incompatible with your platform, set `FFMPEG_PATH` in `.env` to a compatible executable.
