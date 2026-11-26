import { randomUUID } from 'node:crypto';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BufferJSON } from '@rexxhayanasi/elaina-baileys';

const LEGACY_KEY_TYPES = [
  'app-state-sync-version',
  'app-state-sync-key',
  'sender-key-memory',
  'identity-key',
  'device-list',
  'lid-mapping',
  'sender-key',
  'pre-key',
  'session',
  'tctoken',
];

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code;
}

async function statIfExists(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return null;
    throw error;
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'), BufferJSON.reviver) as unknown;
}

export async function migrateLegacyAuthState(
  authFile: string,
  legacyDirectory: string,
): Promise<number | null> {
  const authFileInfo = await statIfExists(authFile);
  if (authFileInfo) {
    if (!authFileInfo.isFile()) {
      throw new Error(`Auth state path is not a file: ${authFile}`);
    }
    return null;
  }

  const legacyDirectoryInfo = await statIfExists(legacyDirectory);
  if (!legacyDirectoryInfo) return null;
  if (!legacyDirectoryInfo.isDirectory()) {
    throw new Error(`Legacy auth state path is not a directory: ${legacyDirectory}`);
  }

  const entries = await readdir(legacyDirectory, { withFileTypes: true });
  const jsonFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  if (jsonFiles.length === 0) return null;

  const credsPath = join(legacyDirectory, 'creds.json');
  const credsInfo = await statIfExists(credsPath);
  if (!credsInfo?.isFile()) {
    throw new Error(`Legacy auth state contains files but no creds.json: ${legacyDirectory}`);
  }

  const fileData: Record<string, unknown> = {
    creds: await readJson(credsPath),
  };
  let migratedKeys = 0;

  for (const entry of jsonFiles) {
    if (entry.name === 'creds.json') continue;

    const stem = entry.name.slice(0, -'.json'.length);
    const keyType = LEGACY_KEY_TYPES.find((type) => stem.startsWith(`${type}-`));
    if (!keyType) {
      throw new Error(`Cannot migrate unrecognized auth key file: ${entry.name}`);
    }

    const encodedId = stem.slice(keyType.length + 1);
    if (!encodedId) {
      throw new Error(`Cannot migrate auth key with an empty ID: ${entry.name}`);
    }

    const id = encodedId.replace(/__/g, '/').replace(/-/g, ':');
    const key = `${keyType}${id}`;
    if (Object.hasOwn(fileData, key)) {
      throw new Error(`Duplicate auth key while migrating: ${entry.name}`);
    }

    fileData[key] = await readJson(join(legacyDirectory, entry.name));
    migratedKeys += 1;
  }

  const tempFile = `${authFile}.migration-${randomUUID()}.tmp`;
  await writeFile(tempFile, JSON.stringify(fileData, BufferJSON.replacer));
  await rename(tempFile, authFile);
  return migratedKeys;
}
