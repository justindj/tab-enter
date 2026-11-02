import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('redacts known token formats', () => {
    const input = 'gitlab glpat-abcdefghijklmnopqrstuv and jira ATATT3xFfGF0abcdefghijklmnopqrstu';
    const out = redactSecrets(input);
    expect(out).not.toContain('glpat-abc');
    expect(out).not.toContain('ATATT3x');
    expect(out.match(new RegExp(REDACTED.replace(/[[\]]/g, '\\$&'), 'g'))).toHaveLength(2);
  });

  it('redacts keyed values but keeps the key', () => {
    expect(redactSecrets('Authorization: Bearer abc123def456')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(redactSecrets('{"password": "hunter2hunter2"}')).toBe(`{"password": "${REDACTED}"}`);
    expect(redactSecrets('PRIVATE-TOKEN=zzzzzzzzzz')).toBe(`PRIVATE-TOKEN=${REDACTED}`);
  });

  it('redacts private key blocks', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(`before ${key} after`)).toBe(`before ${REDACTED} after`);
  });

  it('leaves ordinary text alone', () => {
    const text = 'Fixed ABC-123: the token refresh now retries. 42 tests passed.';
    expect(redactSecrets(text)).toBe(text);
  });
});
