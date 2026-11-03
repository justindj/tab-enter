import type { CommandResult, RunCommand } from '@tab-enter/claude';
import { fakeFetch } from '@tab-enter/connectors/test-support';
import { parseProfileSettings } from '@tab-enter/core';
import { createProfile, getProfile, updateProfile, type Db } from '@tab-enter/db';
import { createTestDb } from '@tab-enter/db/test-support';
import { MemorySecretStore, SECRET_NAMES } from '@tab-enter/secrets';
import { describe, expect, it } from 'vitest';
import { importGlabToken, readGlabToken } from './handlers/cli-logins';

const res = (stdout: string, code = 0, stderr = ''): CommandResult => ({
  code,
  stdout,
  stderr,
  timedOut: false,
});

function fakeGlab(responses: Record<string, CommandResult>) {
  const calls: string[] = [];
  const run: RunCommand = async (_file, args) => {
    const key = args.join(' ');
    calls.push(key);
    return responses[key] ?? res('', 1);
  };
  return { run, calls };
}

const TOKEN = 'glpat-abcdefghij123456';

describe('reading glab’s token', () => {
  it('uses the config value when glab keeps the token there', async () => {
    const { run, calls } = fakeGlab({
      'config get token --host gitlab.example.com': res(`${TOKEN}\n`),
    });
    expect(await readGlabToken(run, 'glab', 'gitlab.example.com')).toBe(TOKEN);
    expect(calls).toHaveLength(1);
  });

  it('falls back to auth status (keyring storage), which prints to stderr', async () => {
    const { run } = fakeGlab({
      'config get token --host gitlab.example.com': res(''),
      'auth status --hostname gitlab.example.com --show-token': res(
        '',
        0,
        `gitlab.example.com\n  ✓ Logged in to gitlab.example.com as dana\n  ✓ Token: ${TOKEN}\n`,
      ),
    });
    expect(await readGlabToken(run, 'glab', 'gitlab.example.com')).toBe(TOKEN);
  });

  it('returns null when glab is logged out or masks the token', async () => {
    const { run } = fakeGlab({
      'auth status --hostname gitlab.example.com --show-token': res(
        '',
        1,
        '  ✓ Token: **************',
      ),
    });
    expect(await readGlabToken(run, 'glab', 'gitlab.example.com')).toBeNull();
  });
});

describe('importing glab’s token', () => {
  async function profile(db: Db) {
    const id = await createProfile(db, { name: 'Client' });
    await updateProfile(db, id, {
      settings: parseProfileSettings({ gitlab: { baseUrl: 'https://gitlab.example.com' } }),
    });
    return id;
  }
  const glab = () => fakeGlab({ 'config get token --host gitlab.example.com': res(TOKEN) }).run;

  it('checks the token with GitLab, then stores it in the keychain', async () => {
    const db = await createTestDb();
    const id = await profile(db);
    const secrets = new MemorySecretStore();
    const { fetch, seen } = fakeFetch(({ url }) =>
      url.pathname === '/api/v4/user'
        ? { body: { id: 5, username: 'dana', name: 'Dana' } }
        : undefined,
    );
    const result = await importGlabToken(
      db,
      { profileId: id },
      { run: glab(), findGlab: async () => 'glab', fetch, secrets },
    );
    // The job result names the account, never the token.
    expect(result).toEqual({ username: 'dana', host: 'gitlab.example.com' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(seen[0]!.headers['PRIVATE-TOKEN']).toBe(TOKEN);
    expect(await secrets.get(id, SECRET_NAMES.gitlabToken)).toBe(TOKEN);
    expect((await getProfile(db, id))!.secretNames).toContain(SECRET_NAMES.gitlabToken);
  });

  it('keeps the existing token when glab’s is rejected, without echoing it', async () => {
    const db = await createTestDb();
    const id = await profile(db);
    const secrets = new MemorySecretStore();
    await secrets.set(id, SECRET_NAMES.gitlabToken, 'old-working-token');
    const { fetch } = fakeFetch(() => ({ status: 401, body: { message: '401 Unauthorized' } }));
    const err = await importGlabToken(
      db,
      { profileId: id },
      { run: glab(), findGlab: async () => 'glab', fetch, secrets },
    ).catch((e: Error) => e);
    expect(String(err)).toMatch(/glab's token didn't work/);
    expect(String(err)).not.toContain(TOKEN);
    expect(await secrets.get(id, SECRET_NAMES.gitlabToken)).toBe('old-working-token');
  });

  it('explains when glab is missing or logged out', async () => {
    const db = await createTestDb();
    const id = await profile(db);
    const secrets = new MemorySecretStore();
    await expect(
      importGlabToken(db, { profileId: id }, { findGlab: async () => null, secrets }),
    ).rejects.toThrow(/not installed/);
    await expect(
      importGlabToken(
        db,
        { profileId: id },
        { run: fakeGlab({}).run, findGlab: async () => 'glab', secrets },
      ),
    ).rejects.toThrow(/glab auth login --hostname gitlab.example.com/);
  });
});
