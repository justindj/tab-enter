import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(start: string): string {
  let dir = start;
  while (!existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Could not locate the tab-enter repository root.');
    dir = parent;
  }
  return dir;
}

/** Invented demo data shipped with the repo. */
export function getFixturesDir(): string {
  return (
    process.env.TAB_ENTER_FIXTURES_DIR ??
    path.join(findRepoRoot(path.dirname(fileURLToPath(import.meta.url))), 'fixtures')
  );
}
