import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BlobStore } from '@tab-enter/core';

/** Filesystem BlobStore rooted at a directory. Keys are '/'-separated relative paths. */
export class FileBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    const full = path.resolve(this.root, ...key.split('/'));
    const root = path.resolve(this.root);
    if (full !== root && !full.startsWith(root + path.sep))
      throw new Error(`Blob key escapes store: ${key}`);
    return full;
  }

  async put(key: string, data: Uint8Array | string): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.resolve(prefix), { recursive: true, force: true });
  }
}
