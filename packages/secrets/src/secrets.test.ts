import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseProfileSettings } from '@tab-enter/core';
import { describe, expect, it } from 'vitest';
import { MissingCredentialError, PatCredentialProvider } from './credentials';
import { EncryptedFileSecretStore, MemorySecretStore, SECRET_NAMES } from './store';

describe('EncryptedFileSecretStore', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tab-enter-secrets-'));
  const file = path.join(dir, 'secrets.enc');

  it('round-trips values without storing them in plain text', async () => {
    const store = new EncryptedFileSecretStore(file, 'correct horse');
    await store.set('p1', 'gitlab-token', 'glpat-super-secret-value');
    expect(await store.get('p1', 'gitlab-token')).toBe('glpat-super-secret-value');
    expect(await store.get('p2', 'gitlab-token')).toBeNull();
    expect(readFileSync(file, 'utf8')).not.toContain('super-secret');
  });

  it('rejects the wrong passphrase', async () => {
    const wrong = new EncryptedFileSecretStore(file, 'wrong');
    await expect(wrong.get('p1', 'gitlab-token')).rejects.toThrow(/passphrase/);
  });

  it('deletes entries', async () => {
    const store = new EncryptedFileSecretStore(file, 'correct horse');
    await store.delete('p1', 'gitlab-token');
    expect(await store.get('p1', 'gitlab-token')).toBeNull();
    await store.delete('p1', 'never-set');
  });
});

describe('PatCredentialProvider', () => {
  const store = new MemorySecretStore();
  const settings = {
    cloud: parseProfileSettings({ jira: { deployment: 'cloud', email: 'dev@example.com' } }),
    dc: parseProfileSettings({ jira: { deployment: 'datacenter' } }),
  };
  const provider = new PatCredentialProvider(store, async (id) => settings[id as 'cloud' | 'dc']);

  it('uses basic auth for Jira Cloud and bearer for Data Center', async () => {
    await store.set('cloud', SECRET_NAMES.jiraToken, 'tok');
    await store.set('dc', SECRET_NAMES.jiraToken, 'pat');
    expect(await provider.getAuthHeaders('cloud', 'jira')).toEqual({
      Authorization: `Basic ${Buffer.from('dev@example.com:tok').toString('base64')}`,
    });
    expect(await provider.getAuthHeaders('dc', 'jira')).toEqual({ Authorization: 'Bearer pat' });
  });

  it('uses PRIVATE-TOKEN for GitLab and reports missing tokens', async () => {
    await expect(provider.getAuthHeaders('dc', 'gitlab')).rejects.toBeInstanceOf(
      MissingCredentialError,
    );
    await store.set('dc', SECRET_NAMES.gitlabToken, 'glpat-x');
    expect(await provider.getAuthHeaders('dc', 'gitlab')).toEqual({ 'PRIVATE-TOKEN': 'glpat-x' });
  });
});
