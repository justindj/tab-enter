import 'server-only';
import { getDataDir } from '@tab-enter/db';
import { createSecretStore, type SecretStore } from '@tab-enter/secrets';

let store: Promise<SecretStore> | null = null;

/** Credentials are written here and never read back into the browser. */
export function getSecretStore(): Promise<SecretStore> {
  store ??= createSecretStore({
    dataDir: getDataDir(),
    passphrase: process.env.TAB_ENTER_PASSPHRASE,
  }).catch((err: unknown) => {
    store = null;
    throw err;
  });
  return store;
}
