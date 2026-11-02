// Stand-in for the `claude` CLI in tests: replays a recorded fixture to stdout.
// FAKE_CLAUDE_FIXTURE: file to replay. FAKE_CLAUDE_EXIT: exit code (default 0).
// FAKE_CLAUDE_ARGS_OUT: if set, the received argv and stdin are written there as JSON.
import { readFileSync, writeFileSync } from 'node:fs';

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  if (process.env.FAKE_CLAUDE_ARGS_OUT) {
    writeFileSync(
      process.env.FAKE_CLAUDE_ARGS_OUT,
      JSON.stringify({ args: process.argv.slice(2), stdin, cwd: process.cwd() }),
    );
  }
  if (process.env.FAKE_CLAUDE_FIXTURE) {
    process.stdout.write(readFileSync(process.env.FAKE_CLAUDE_FIXTURE, 'utf8'));
  }
  if (process.env.FAKE_CLAUDE_STDERR) process.stderr.write(process.env.FAKE_CLAUDE_STDERR);
  process.exitCode = Number(process.env.FAKE_CLAUDE_EXIT ?? 0);
});
