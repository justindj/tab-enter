// CI guard: fixtures must contain only invented data. Fails if any URL host or
// email address in fixtures/ is outside example.com / example.test.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'fixtures');
const ALLOWED = /(^|\.)example\.(com|test)$/i;
const URL_RE = /\bhttps?:\/\/([^/\s"'<>)]+)/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else yield full;
  }
}

const problems = [];
for (const file of files(root)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const re of [URL_RE, EMAIL_RE]) {
      for (const match of line.matchAll(re)) {
        const host = match[1].replace(/:\d+$/, '').toLowerCase();
        if (!ALLOWED.test(host))
          problems.push(`${path.relative(root, file)}:${i + 1}: ${match[0]}`);
      }
    }
  });
}

if (problems.length > 0) {
  console.error(
    'Fixtures must only use example.com / example.test domains:\n  ' + problems.join('\n  '),
  );
  process.exit(1);
}
console.log('fixtures: ok (only example.com / example.test domains)');
