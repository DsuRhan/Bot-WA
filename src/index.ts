import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import 'dotenv/config';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { makeStickerAndAudio } from './media.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const triggerCaption = (process.env.TRIGGER_CAPTION || '!sticker').trim().toLowerCase();
const maxVideoBytes = Number(process.env.MAX_VIDEO_BYTES || 16 * 1024 * 1024);
const authDirectory = 'auth_info';

if (!triggerCaption) {
  throw new Error('TRIGGER_CAPTION must not be empty.');
}
if (!Number.isSafeInteger(maxVideoBytes) || maxVideoBytes <= 0) {
  throw new Error('MAX_VIDEO_BYTES must be a positive safe integer.');
}

async function startBot(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(authDirectory);
  const socket = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
  });

  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      logger.info('Scan this QR code with the WhatsApp account that will run the bot:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info('Connected. Send a video with the configured caption to your own number.');
    }

    if (connection === 'close') {
      const error = lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
      if (error?.output?.statusCode === DisconnectReason.loggedOut) {
        logger.error('WhatsApp logged out. Remove auth_info and restart to pair again.');
        return;
      }

      logger.warn('Connection closed; reconnecting shortly.');
      setTimeout(() => {
        void startBot().catch((reconnectError: unknown) => {
          logger.error({ err: reconnectError }, 'Failed to reconnect.');
        });
      }, 3_000);
    }
  });

  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      const remoteJid = message.key.remoteJid;
      const ownJid = socket.user?.id;
      if (!message.key.fromMe || !remoteJid || !ownJid) continue;
      if (jidNormalizedUser(remoteJid) !== jidNormalizedUser(ownJid)) continue;

      const content = normalizeMessageContent(message.message);
      const video = content?.videoMessage;
      if (!video || video.caption?.trim().toLowerCase() !== triggerCaption) continue;

      try {
        const reportedSize = Number(video.fileLength);
        if (Number.isFinite(reportedSize) && reportedSize > maxVideoBytes) {
          throw new Error(`Video exceeds the configured ${maxVideoBytes}-byte download limit.`);
        }

        const downloaded = await downloadMediaMessage(message, 'buffer', {}, {
          logger,
          reuploadRequest: socket.updateMediaMessage,
        });
        if (downloaded.byteLength > maxVideoBytes) {
          throw new Error(`Video exceeds the configured ${maxVideoBytes}-byte download limit.`);
        }

        const { sticker, audio } = await makeStickerAndAudio(downloaded);
        await socket.sendMessage(remoteJid, { sticker, mimetype: 'image/webp' });
        await socket.sendMessage(remoteJid, {
          audio,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true,
        });
      } catch (error) {
        logger.error({ err: error }, 'Could not convert the video.');
        await socket.sendMessage(remoteJid, {
          text: `Could not make the sticker: ${error instanceof Error ? error.message : 'Unexpected error.'}`,
        });
      }
    }
  });
}

startBot().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Bot failed to start.');
  process.exitCode = 1;
});
