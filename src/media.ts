import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ffmpegStaticModule: unknown = createRequire(import.meta.url)('ffmpeg-static');
const bundledFFmpegPath = typeof ffmpegStaticModule === 'string' ? ffmpegStaticModule : null;

const MAX_STICKER_BYTES = 500 * 1024;
const MAX_VIDEO_SECONDS = 60;

interface ProcessResult {
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill(), 60_000);

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8_000);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

function ffmpegPath(): string {
  const path = process.env.FFMPEG_PATH || bundledFFmpegPath;
  if (!path) {
    throw new Error('No bundled FFmpeg binary is available for this platform; set FFMPEG_PATH.');
  }
  return path;
}

function ffprobePath(): string {
  return process.env.FFPROBE_PATH || 'ffprobe';
}

async function probe(inputPath: string, args: string[]): Promise<string> {
  const result = await run(ffprobePath(), [
    '-v', 'error',
    ...args,
    '-of', 'default=noprint_wrappers=1:nokey=1',
    inputPath,
  ]);
  return result.stdout.trim();
}

export async function makeStickerAndAudio(video: Uint8Array): Promise<{
  sticker: Buffer;
  audio: Buffer;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'wa-sticker-'));
  const inputPath = join(directory, 'input-video');
  const audioPath = join(directory, 'audio.ogg');

  try {
    await writeFile(inputPath, video);

    const duration = Number(await probe(inputPath, ['-show_entries', 'format=duration']));
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Could not determine the video duration.');
    }
    if (duration > MAX_VIDEO_SECONDS) {
      throw new Error(`Video is longer than ${MAX_VIDEO_SECONDS} seconds.`);
    }

    const audioStream = await probe(inputPath, [
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type',
    ]);
    if (!audioStream) {
      throw new Error('The video does not contain an audio track.');
    }

    await run(ffmpegPath(), [
      '-y', '-i', inputPath,
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', String(MAX_VIDEO_SECONDS),
      '-af', 'aresample=48000:async=1:first_pts=0,asetpts=PTS-STARTPTS',
      '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1',
      '-application', 'audio', '-f', 'ogg', audioPath,
    ]);

    const encodings = [
      { fps: 15, quality: 55, scale: 512 },
      { fps: 12, quality: 42, scale: 512 },
      { fps: 10, quality: 32, scale: 448 },
    ];

    for (let index = 0; index < encodings.length; index += 1) {
      const { fps, quality, scale } = encodings[index];
      const stickerPath = join(directory, `sticker-${index}.webp`);
      const filter = [
        `fps=${fps}`,
        `scale=${scale}:${scale}:force_original_aspect_ratio=decrease:flags=lanczos`,
        'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
        'setsar=1',
      ].join(',');

      await run(ffmpegPath(), [
        '-y', '-i', inputPath, '-t', String(MAX_VIDEO_SECONDS),
        '-an', '-vf', filter,
        '-c:v', 'libwebp_anim', '-loop', '0',
        '-quality', String(quality), '-compression_level', '6',
        '-preset', 'default', stickerPath,
      ]);

      if ((await stat(stickerPath)).size <= MAX_STICKER_BYTES) {
        return {
          sticker: await readFile(stickerPath),
          audio: await readFile(audioPath),
        };
      }
    }

    throw new Error('The video cannot fit within WhatsApp’s 500 KiB animated sticker limit.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
