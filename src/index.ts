import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  generateWAMessageFromContent,
  jidNormalizedUser,
  normalizeMessageContent,
  prepareWAMessageMedia,
  proto,
  useMultiFileAuthState,
} from '@rexxhayanasi/elaina-baileys';
import 'dotenv/config';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { makeStickerAndAudio } from './media.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const triggerCaption = (process.env.TRIGGER_CAPTION || '!sticker').trim().toLowerCase();
const maxVideoBytes = Number(process.env.MAX_VIDEO_BYTES || 16 * 1024 * 1024);
const authDirectory = 'auth_info';

interface ConnectionUpdate {
  connection?: string;
  lastDisconnect?: { error?: unknown } | null;
  qr?: string;
}

interface MessagesUpsert {
  messages: proto.IWebMessageInfo[];
  type: string;
}

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
  socket.ev.on('connection.update', ({ connection, lastDisconnect, qr }: ConnectionUpdate) => {
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

  socket.ev.on('messages.upsert', async ({ messages, type }: MessagesUpsert) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      const key = message.key;
      const remoteJid = key?.remoteJid;
      if (!key?.fromMe || !remoteJid) continue;

      const ownJids = [
        socket.user?.id,
        state.creds.me?.id,
        state.creds.me?.lid,
      ]
        .filter((jid): jid is string => Boolean(jid))
        .map(jidNormalizedUser);
      if (!ownJids.includes(jidNormalizedUser(remoteJid))) continue;

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
        const stickerMedia = await prepareWAMessageMedia(
          { sticker },
          { upload: socket.waUploadToServer },
        );
        const audioMedia = await prepareWAMessageMedia(
          { audio, mimetype: 'audio/ogg; codecs=opus' },
          { upload: socket.waUploadToServer },
        );
        if (!stickerMedia.stickerMessage || !audioMedia.audioMessage || !socket.user?.id) {
          throw new Error('WhatsApp did not prepare the sticker and audio media.');
        }

        const voicedSticker = generateWAMessageFromContent(
          remoteJid,
          {
            audioStickerMessage: {
              message: {
                stickerMessage: {
                  ...stickerMedia.stickerMessage,
                  isAnimated: true,
                  audioMessage: audioMedia.audioMessage,
                },
              },
            },
          },
          { userJid: socket.user.id },
        );
        const messageId = voicedSticker.key?.id;
        if (!messageId) {
          throw new Error('WhatsApp did not generate an ID for the voiced sticker.');
        }
        await socket.relayMessage(remoteJid, voicedSticker.message, {
          messageId,
          participant: undefined,
          additionalAttributes: undefined,
          additionalNodes: undefined,
          useUserDevicesCache: undefined,
          useCachedGroupMetadata: undefined,
          addBizAttributes: undefined,
          statusJidList: undefined,
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
