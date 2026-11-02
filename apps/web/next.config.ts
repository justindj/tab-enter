import path from 'node:path';
import type { NextConfig } from 'next';

// pnpm runs scripts from apps/web, so the monorepo root is two levels up.
const repoRoot = path.resolve(process.cwd(), '../..');

const config: NextConfig = {
  poweredByHeader: false,
  // Don't write a generated AGENTS.md into the app folder.
  agentRules: false,
  transpilePackages: ['@tab-enter/core', '@tab-enter/db', '@tab-enter/secrets'],
  // Native modules stay as runtime requires instead of being bundled.
  serverExternalPackages: ['@libsql/client', 'libsql', '@napi-rs/keyring'],
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
};

export default config;
