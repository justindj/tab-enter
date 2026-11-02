# Decisions

Non-obvious choices, newest at the bottom of each section. When a decision changes, edit it here
and say why.

## Answers to the spec's open questions (2026-11-02)

| #   | Question                      | Decision                                                                                    |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | Jira Cloud or Data Center?    | **Both.** Cloud uses email + API token (Basic); Data Center uses a PAT (Bearer).            |
| 2   | gitlab.com or self-managed?   | **Both.** The base URL is per profile; nothing assumes gitlab.com.                          |
| 3   | Preset models and turn limits | **Spec defaults**: sonnet for task/review/verification presets, haiku for short text.       |
| 4   | "Current sprint"              | `sprint in openSprints()` by default, with an optional per-profile `jira.boardId` override. |
| 5   | Daily report format           | **Done / In progress / Next / Blockers.**                                                   |
| 6   | Verification video            | **Screenshots only** by default; `verification.captureVideo` opts in.                       |
| 7   | RTK default for new profiles  | **Off.**                                                                                    |

## Stack and repository

- **SQLite driver: `@libsql/client`, not `better-sqlite3`.** libsql ships prebuilt N-API binaries,
  so it installs on new Node majors (development started on Node 26) without a C++ toolchain. Its
  async API also matches the Postgres drivers a hosted version would use. Drizzle supports both.
- **Connection pragmas** (WAL, `busy_timeout`, foreign keys) live in `packages/db/src/client.ts`.
  They are SQLite-specific, but they configure the connection rather than access data, so the "no
  SQLite-specific SQL" rule still holds for queries.
- **TypeScript is pinned to 5.9.** TypeScript 7 (the native compiler) is out, but Next.js
  integration with it hasn't been checked yet.
- **Extra package `packages/secrets`** (not in the spec's layout) holds the keychain store and the
  `CredentialProvider`. Both the web app (to save tokens) and the worker (to use them, from M1) need
  it, and it must stay out of `core`, which has no I/O.
- **`packages/verify` is not created yet.** It's added in M6 rather than kept as an empty stub.
- **Workspace packages export TypeScript source** (`"exports": "./src/index.ts"`), with no build
  step. Next.js compiles them via `transpilePackages` and the worker runs them through `tsx`.
- **CI is GitHub Actions** (`.github/workflows/ci.yml`). If the repository ends up elsewhere, port
  the same steps: fixtures check, lint, typecheck, test, build.
- **Next.js telemetry is disabled** (`NEXT_TELEMETRY_DISABLED=1` in `scripts/dev.mjs` and CI)
  because tab-enter promises no telemetry. `agentRules: false` stops Next 16.4 from writing an
  `AGENTS.md` into `apps/web`.
- **Dark mode follows the OS** (`prefers-color-scheme`) with no toggle yet.

## Data model

See [schema.md](schema.md) for the full proposal.

- **Synced objects are stored whole as JSON** (`issues.data`, `merge_requests.data`). Fields used
  for filtering or sorting are copied into real columns. This avoids a wide column-per-field mapping
  that would churn every time a connector gains a field, and maps directly to `jsonb` in Postgres.
- **Rows reference each other by natural key** (`issue_key`, `mr_key` = `projectId!iid`), not row
  ids. Synced rows are replaced on every sync, so runs, reviews and artifacts must survive that.
- **Sync replaces a profile's issues, MRs and computed links in a single transaction** in M0. The
  `sync_state.cursor` column is reserved for incremental (`updated >= cursor`) sync in M1.
- **Active issues are synced regardless of sprint**, so the "Current sprint / All" toggle works
  from local data without another fetch.
- **Every table has `user_id`** (always `"local"` in v1), and every client-data table has
  `profile_id`.

## Linking and status

- **Linking uses the union of all rules, not the first rule that matches.** An MR can close several
  tickets. Each link records the highest-precedence rule that found it (branch > title >
  description). Manual unlink removes a key and manual link adds one; both override the rules.
- **Key matches must be whole tokens**: no letter or digit may directly precede or follow the match,
  so `xABC-1`, `ABC-12x` and the `ABC-12` inside `ABC-123` don't match. Lowercase keys in branch
  names (`feature/abc-123`) don't match the default regex. Uppercasing branches first would produce
  false keys like `LOGIN-2` from `fix/login-2`.
- **Derived MR status edge cases:**
  - Merged and closed MRs are terminal and ignore every other condition.
  - Drafts are never "Awaiting review" or "Approved". After conflicts, failed pipelines and threads
    are checked, a draft shows as Draft.
  - Unresolved threads count as "Changes requested".
  - "Approved" needs at least one approval, even when the project requires none.

## Security

- **Session auth:** `pnpm dev` generates a 32-byte random token and opens `/?token=…`. The Next.js
  proxy (`apps/web/src/proxy.ts`, Next 16's replacement for middleware) swaps it for an `HttpOnly`,
  `SameSite=Strict` cookie and redirects. Every other request needs the cookie.
- **DNS rebinding:** the proxy rejects any `Host` other than `127.0.0.1`, `localhost` or `[::1]`.
- **Secrets:** `@napi-rs/keyring` with service `tab-enter` and account `<profileId>/<name>`. If no
  keychain works, the fallback is an AES-256-GCM file (`~/.tab-enter/secrets.enc`) with a scrypt key
  derived from `TAB_ENTER_PASSPHRASE`. There is never a plain-text fallback. Token fields are
  write-only in the UI: a blank field keeps the stored token, and values are never sent back.
- **Profiles store secret names, never values** (`profiles.secret_names`), so deleting a profile
  can remove its keychain entries.
- **`apps/web` touches only SQLite and the secret store.** The secret store counts as storage, like
  the database. Removing a deleted profile's files is queued as a worker job.
- **Approval is always a human click** behind a confirmation, even when Claude recommends approving.
  v1 has no auto-approve setting. This is deliberate: an approval is a statement by the reviewer, and
  tab-enter must not make it for them.

## Claude Code CLI

> **Unverified flags.** `claude` was not installed on the machine where M0 was written, so the
> flags below come from the Claude Code docs and have not yet been checked against `claude --help`.
> Before M3, run `claude --help` and `claude --version`, update this table, and record the version
> checked. The stream parser is tested against recorded output in `fixtures/claude/`. Re-record
> those fixtures from a real run at the same time.

| Flag                          | Used for                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `-p` / `--print`              | Headless mode. **The prompt is written to stdin, never passed as an argument**, which avoids OS command-line limits and quoting problems. |
| `--output-format stream-json` | Task runs (streamed events, one JSON object per line)                                                                                     |
| `--verbose`                   | Required by `stream-json` in print mode                                                                                                   |
| `--output-format json`        | Analysis runs (one result object)                                                                                                         |
| `--model <alias>`             | Preset model (`sonnet`, `haiku`). The model actually used is read from `modelUsage` in the result.                                        |
| `--permission-mode <mode>`    | `acceptEdits` for task presets, `default` for read-only presets                                                                           |
| `--max-turns <n>`             | Per preset                                                                                                                                |
| `--allowedTools <rules…>`     | Explicit allowlist. Each rule is a **separate argv entry** because rules contain spaces, e.g. `Bash(git commit:*)`.                       |
| `--disallowedTools <rules…>`  | Preset denials plus `ALWAYS_DISALLOWED_TOOLS` (below)                                                                                     |
| `--resume <session_id>`       | Continue a run, and "Open in terminal"                                                                                                    |
| `--settings <file>`           | RTK per-run mode: a run-only settings file carrying RTK's hook (never the user's global settings)                                         |
| `--version`, `auth status`    | Detection                                                                                                                                 |

- **Never used:** `--dangerously-skip-permissions` and `--allow-dangerously-skip-permissions`.
  `buildClaudeArgs` throws if either appears, and the preset schema has no `bypassPermissions` mode.
- **Always disallowed:** `git push`, `git remote`, `git config`, `gh`, `glab`, `npm/pnpm/yarn
publish`, `curl`, `wget`, `ssh`, `scp`. Claude may commit locally. Pushing and opening MRs are
  separate, confirmed tab-enter actions. `curl` and `wget` are blocked because they can change
  remote state. Revisit this if test suites need them.
- **Code review preset** explicitly disallows `Edit`, `Write`, `NotebookEdit` and `Bash` on top of
  allowing only `Read`, `Grep` and `Glob`.
- **Verification preset** limits `Write` to `{{artifactsDir}}/**`, substituted per run. A missing
  value throws rather than producing a broader rule.
- **Short-text preset** allows no tools, denies the common ones, and runs one turn.
- **Login detection** runs `claude auth status` only on CLI 2.1.0 and later (to be verified). Older
  CLIs may treat unknown words as a prompt and start a session. Otherwise detection falls back to the
  presence of `~/.claude/.credentials.json` (Linux and Windows). On macOS credentials are in the
  keychain, so a missing file shows "unknown" rather than "logged out".
- **Minimum supported version: 2.0.0** (`CLAUDE_MIN_VERSION`), provisional until verified.
- **Windows:** `claude.exe` (the native installer) is preferred. A `.cmd` shim (npm install) can
  only run through `cmd.exe`, so `spawnCommand` quotes each argument and refuses any containing
  `" % ! ^ & | < >` or newlines rather than trying to escape them.

## Worker

- **Jobs run one at a time in M0.** In M3, agent runs get their own pool limited by
  `claude.maxParallelRuns` (default 2), so a long run doesn't block syncs.
- **Jobs stuck in "running" for more than 10 minutes are requeued at startup** (crashed worker).
- **Demo mode shifts fixture timestamps** so the fixture's `anchor` lands on "now". The demo never
  goes stale: "recently completed" and waiting times look the same on any date.
