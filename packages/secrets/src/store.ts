import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Where credentials live. Values never leave the server process. */
export interface SecretStore {
  readonly kind: 'keychain' | 'encrypted-file' | 'memory';
  get(profileId: string, name: string): Promise<string | null>;
  set(profileId: string, name: string, value: string): Promise<void>;
  delete(profileId: string, name: string): Promise<void>;
}

export const SECRET_NAMES = {
  jiraToken: 'jira-token',
  gitlabToken: 'gitlab-token',
} as const;

const SERVICE = 'tab-enter';
const account = (profileId: string, name: string) => `${profileId}/${name}`;

function isMissingEntry(err: unknown): boolean {
  return /no (matching )?entry|not found|no such/i.test(String(err));
}

/** OS keychain via @napi-rs/keyring (macOS Keychain, Windows Credential Manager, libsecret). */
export class KeychainSecretStore implements SecretStore {
  readonly kind = 'keychain' as const;

  private async entry(profileId: string, name: string) {
    const { Entry } = await import('@napi-rs/keyring');
    return new Entry(SERVICE, account(profileId, name));
  }

  async get(profileId: string, name: string): Promise<string | null> {
    try {
      return (await this.entry(profileId, name)).getPassword() ?? null;
    } catch (err) {
      if (isMissingEntry(err)) return null;
      throw err;
    }
  }

  async set(profileId: string, name: string, value: string): Promise<void> {
    (await this.entry(profileId, name)).setPassword(value);
  }

  async delete(profileId: string, name: string): Promise<void> {
    try {
      (await this.entry(profileId, name)).deletePassword();
    } catch (err) {
      if (!isMissingEntry(err)) throw err;
    }
  }
}

interface EncryptedEntry {
  iv: string;
  tag: string;
  data: string;
}
interface EncryptedFile {
  version: 1;
  salt: string;
  entries: Record<string, EncryptedEntry>;
}

/**
 * Fallback when no OS keychain is available: AES-256-GCM per entry, key
 * derived from a user passphrase with scrypt. Never a plain-text file.
 */
export class EncryptedFileSecretStore implements SecretStore {
  readonly kind = 'encrypted-file' as const;
  private keyCache: { salt: string; key: Buffer } | null = null;

  constructor(
    private readonly filePath: string,
    private readonly passphrase: string,
  ) {
    if (!passphrase) throw new Error('An encrypted secrets file needs a passphrase.');
  }

  private async load(): Promise<EncryptedFile> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as EncryptedFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return { version: 1, salt: randomBytes(16).toString('base64'), entries: {} };
    }
  }

  private async save(file: EncryptedFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
    await rename(tmp, this.filePath);
  }

  private key(salt: string): Buffer {
    if (this.keyCache?.salt !== salt) {
      this.keyCache = { salt, key: scryptSync(this.passphrase, Buffer.from(salt, 'base64'), 32) };
    }
    return this.keyCache.key;
  }

  async get(profileId: string, name: string): Promise<string | null> {
    const file = await this.load();
    const entry = file.entries[account(profileId, name)];
    if (!entry) return null;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key(file.salt),
      Buffer.from(entry.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    try {
      return Buffer.concat([
        decipher.update(Buffer.from(entry.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('Could not decrypt secrets file: wrong passphrase?');
    }
  }

  async set(profileId: string, name: string, value: string): Promise<void> {
    const file = await this.load();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(file.salt), iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    file.entries[account(profileId, name)] = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    await this.save(file);
  }

  async delete(profileId: string, name: string): Promise<void> {
    const file = await this.load();
    if (!(account(profileId, name) in file.entries)) return;
    delete file.entries[account(profileId, name)];
    await this.save(file);
  }
}

/** For tests and demo mode. */
export class MemorySecretStore implements SecretStore {
  readonly kind = 'memory' as const;
  private readonly values = new Map<string, string>();
  async get(profileId: string, name: string) {
    return this.values.get(account(profileId, name)) ?? null;
  }
  async set(profileId: string, name: string, value: string) {
    this.values.set(account(profileId, name), value);
  }
  async delete(profileId: string, name: string) {
    this.values.delete(account(profileId, name));
  }
}

let keychainUsable: boolean | null = null;

async function probeKeychain(store: KeychainSecretStore): Promise<boolean> {
  if (keychainUsable !== null) return keychainUsable;
  try {
    await store.set('_probe', 'probe', 'ok');
    keychainUsable = (await store.get('_probe', 'probe')) === 'ok';
    await store.delete('_probe', 'probe');
  } catch {
    keychainUsable = false;
  }
  return keychainUsable;
}

/**
 * The OS keychain when it works; otherwise an encrypted file unlocked by
 * TAB_ENTER_PASSPHRASE. Fails with setup instructions when neither is available.
 */
export async function createSecretStore(opts: {
  dataDir: string;
  passphrase?: string;
}): Promise<SecretStore> {
  const keychain = new KeychainSecretStore();
  if (await probeKeychain(keychain)) return keychain;
  if (opts.passphrase) {
    return new EncryptedFileSecretStore(path.join(opts.dataDir, 'secrets.enc'), opts.passphrase);
  }
  throw new Error(
    'No OS keychain is available. Set TAB_ENTER_PASSPHRASE to store credentials in an encrypted file instead.',
  );
}
