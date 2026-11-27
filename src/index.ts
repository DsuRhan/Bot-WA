import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  generateWAMessageFromContent,
  jidNormalizedUser,
  normalizeMessageContent,
  prepareWAMessageMedia,
  proto,
  useSingleFileAuthState,
} from '@rexxhayanasi/elaina-baileys';
import 'dotenv/config';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { migrateLegacyAuthState } from './auth-state.js';
import { makeAnimatedSticker, makeStickerAndAudio, makeStillSticker } from './media.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
const maxVideoBytes = Number(process.env.MAX_VIDEO_BYTES || 16 * 1024 * 1024);
const authFile = 'auth_info.json';
const legacyAuthDirectory = 'auth_info';

interface ConnectionUpdate {
  connection?: string;
  lastDisconnect?: { error?: unknown } | null;
  qr?: string;
}

interface MessagesUpsert {
  messages: proto.IWebMessageInfo[];
  type: string;
}

if (!Number.isSafeInteger(maxVideoBytes) || maxVideoBytes <= 0) {
  throw new Error('MAX_VIDEO_BYTES must be a positive safe integer.');
}

async function startBot(): Promise<void> {
  const migratedKeys = await migrateLegacyAuthState(authFile, legacyAuthDirectory);
  if (migratedKeys !== null) {
    logger.warn(
      { migratedKeys, legacyAuthDirectory },
      'Migrated the existing multi-file WhatsApp session; old files were left untouched.',
    );
  }

  const { state, saveCreds } = await useSingleFileAuthState(authFile);
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
      logger.info('Connected. Use !sticker with an image, !gif with a video, or !voiced with a video.');
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
      if (!key || !remoteJid || remoteJid === 'status@broadcast') continue;

      const ownJids = [
        socket.user?.id,
        state.creds.me?.id,
        state.creds.me?.lid,
      ]
        .filter((jid): jid is string => Boolean(jid))
        .map(jidNormalizedUser);
      const isSelfChat = Boolean(key.fromMe)
        && ownJids.includes(jidNormalizedUser(remoteJid));
      if (key.fromMe && !isSelfChat) continue;

      const content = normalizeMessageContent(message.message);
      const video = content?.videoMessage;
      const image = content?.imageMessage;
      if (!video && !image) continue;

      const caption = (video?.caption ?? image?.caption)?.trim().toLowerCase();
      const mode = video
        ? caption === '!gif'
          ? 'animated'
          : caption === '!voiced'
            ? 'voiced'
            : undefined
        : caption === '!sticker'
          ? 'still'
          : undefined;
      if (!mode) continue;

      const isGroupChat = remoteJid.endsWith('@g.us');
      const recipientJid = isSelfChat
        ? remoteJid
        : isGroupChat
          ? key.participant
          : remoteJid;
      if (!recipientJid) {
        logger.warn({ remoteJid }, 'Cannot privately reply to a group video without its sender ID.');
        continue;
      }

      try {
        const reportedSize = Number(video?.fileLength ?? image?.fileLength);
        if (Number.isFinite(reportedSize) && reportedSize > maxVideoBytes) {
          throw new Error(`Media exceeds the configured ${maxVideoBytes}-byte download limit.`);
        }

        const downloaded = await downloadMediaMessage(message, 'buffer', {}, {
          logger,
          reuploadRequest: socket.updateMediaMessage,
        });
        if (downloaded.byteLength > maxVideoBytes) {
          throw new Error(`Media exceeds the configured ${maxVideoBytes}-byte download limit.`);
        }

        let sticker: Buffer;
        let audio: Buffer | undefined;
        if (mode === 'voiced') {
          ({ sticker, audio } = await makeStickerAndAudio(downloaded));
        } else if (mode === 'animated') {
          sticker = await makeAnimatedSticker(downloaded);
        } else {
          sticker = await makeStillSticker(downloaded);
        }

        const stickerMedia = await prepareWAMessageMedia(
          { sticker },
          { upload: socket.waUploadToServer },
        );
        if (!stickerMedia.stickerMessage || !socket.user?.id) {
          throw new Error('WhatsApp did not prepare the sticker media.');
        }

        let outgoingMessage: proto.IWebMessageInfo;
        if (mode === 'voiced') {
          if (!audio) {
            throw new Error('Audio was not prepared for the voiced sticker.');
          }
          const audioMedia = await prepareWAMessageMedia(
            { audio, mimetype: 'audio/ogg; codecs=opus' },
            { upload: socket.waUploadToServer },
          );
          if (!audioMedia.audioMessage) {
            throw new Error('WhatsApp did not prepare the sticker audio.');
          }
          outgoingMessage = generateWAMessageFromContent(
            recipientJid,
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
        } else {
          outgoingMessage = generateWAMessageFromContent(
            recipientJid,
            {
              stickerMessage: {
                ...stickerMedia.stickerMessage,
                isAnimated: mode === 'animated',
              },
            },
            { userJid: socket.user.id },
          );
        }
        const messageId = outgoingMessage.key?.id;
        if (!messageId) {
          throw new Error('WhatsApp did not generate an ID for the sticker.');
        }
        await socket.relayMessage(recipientJid, outgoingMessage.message, {
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
        logger.error({ err: error }, 'Could not convert the media.');
        await socket.sendMessage(recipientJid, {
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
