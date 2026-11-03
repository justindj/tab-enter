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

- **License: Apache 2.0, not MIT** (decided 2026-11-02). The spec says MIT, but the GitHub repo
  was created with an Apache 2.0 license and the owner chose to keep it. Its patent grant is the
  main difference.

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
- **`apps/web` touches only SQLite and the secret store**, plus one network call: **Test
  connection**, which calls each service's "who am I" endpoint from a server action. It needs an
  answer while the user waits, the spec allows server-side API calls from the web app, and it reads
  the token server-side and returns only "Connected as …" or the error. Everything else (syncs,
  git, Claude Code, files) goes through the worker. Removing a deleted profile's files is queued as
  a worker job.
- **Approval is always a human click** behind a confirmation, even when Claude recommends approving.
  v1 has no auto-approve setting. This is deliberate: an approval is a statement by the reviewer, and
  tab-enter must not make it for them.

## Claude Code CLI

> **Verified against Claude Code 2.1.309** (2026-11-02) with `claude --help` and by parsing each
> flag with an empty prompt, which makes the CLI validate options and then exit before calling a
> model. Unknown options are rejected (`error: unknown option`), so a removed flag fails loudly.
> The stream parser fixtures in `fixtures/claude/` are still hand-written. Re-record them from a
> real run in M3, once a logged-in CLI is on PATH.

| Flag                          | Used for                                                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-p` / `--print`              | Headless mode. **The prompt is written to stdin, never passed as an argument**, which avoids OS command-line limits and quoting problems.                                         |
| `--output-format stream-json` | Task runs (streamed events, one JSON object per line)                                                                                                                             |
| `--verbose`                   | Required by `stream-json` in print mode                                                                                                                                           |
| `--output-format json`        | Analysis runs (one result object)                                                                                                                                                 |
| `--model <alias>`             | Preset model (`sonnet`, `haiku`). The model actually used is read from `modelUsage` in the result.                                                                                |
| `--permission-mode <mode>`    | `acceptEdits` for task presets, `dontAsk` for read-only presets. 2.1.309 lists `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`. `default` is accepted but unlisted. |
| `--permission-prompts none`   | Every run. Headless runs have nobody to answer a prompt, so anything not explicitly allowed is denied rather than hanging.                                                        |
| `--max-turns <n>`             | Per preset. **Hidden** in 2.1.309 (not in `--help`) but accepted. Watch for its removal.                                                                                          |
| `--allowedTools <rules…>`     | Explicit allowlist. Each rule is a **separate argv entry** because rules contain spaces, e.g. `Bash(git commit:*)`. The CLI also accepts comma/space-separated lists.             |
| `--disallowedTools <rules…>`  | Preset denials plus `ALWAYS_DISALLOWED_TOOLS` (below)                                                                                                                             |
| `--resume <session_id>`       | Continue a run, and "Open in terminal"                                                                                                                                            |
| `--settings <file-or-json>`   | RTK per-run mode: a run-only settings file carrying RTK's hook (never the user's global settings)                                                                                 |
| `--version`, `auth status`    | Detection. `auth status` prints JSON (`loggedIn`, `authMethod`, …) and exits 1 when logged out.                                                                                   |

Not used yet, worth considering later: `--json-schema` (validated structured output, for code
review in M5), `--tools ""` (removes all tools, stronger than denying them, for the short-text
preset), `--max-budget-usd` (per-run soft limit), `--no-session-persistence` (analysis runs that
are never resumed).

- **The Claude desktop app's bundled CLI is not used.** It lives in a private, versioned folder
  under the app's data directory, isn't on PATH, and gets its login from the desktop app (its own
  `auth status` reports logged out). tab-enter only detects a `claude` on PATH, which the user
  installs and logs in to (`claude auth login`).

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
- **Login detection** runs `claude auth status` (verified on 2.1.309; only attempted on 2.1.0+,
  since older CLIs may treat unknown words as a prompt). If its output can't be read, detection
  falls back to the presence of `~/.claude/.credentials.json` (Linux and Windows). On macOS
  credentials are in the keychain, so a missing file shows "unknown" rather than "logged out".
- **Minimum supported version: 2.1.0** (`CLAUDE_MIN_VERSION`). Flags were verified on 2.1.309;
  earlier 2.1.x releases are assumed compatible but untested.
- **Windows:** `claude.exe` (the native installer) is preferred. A `.cmd` shim (npm install) can
  only run through `cmd.exe`, so `spawnCommand` quotes each argument and refuses any containing
  `" % ! ^ & | < >` or newlines rather than trying to escape them.

## Jira connector (M1)

Checked against Atlassian's docs on 2026-11-02.

- **Cloud uses `POST /rest/api/3/search/jql`.** The old `/rest/api/3/search` was removed from
  Cloud. The new endpoint pages with `nextPageToken` / `isLast` and returns no `total`, so the loop
  follows tokens. POST keeps long JQL out of the URL. **Data Center uses `POST /rest/api/2/search`**
  with `startAt` / `maxResults` / `total`. Data Center's v3 API isn't reliable (some versions return
  an HTML page for `/rest/api/3/...`).
- **Auth:** Cloud is Basic `email:api-token`; Data Center is `Authorization: Bearer <PAT>` (Jira
  8.14+).
- **Rich text:** Cloud returns descriptions and comments as Atlassian Document Format (ADF) JSON,
  and Data Center returns wiki markup. Both are reduced to plain text with `- ` bullets
  (`jira-text.ts`), so context builders see one format.
- **Acceptance criteria** come from the list under an "Acceptance criteria" heading in the
  description. Jira has no standard field for them, and custom field ids differ per site. A
  per-profile custom field id can be added if a client keeps them in a field.
- **Rank:** the rank field is a custom field whose id differs per site, so tab-enter asks Jira for
  `ORDER BY Rank ASC` and stores each issue's position as a zero-padded string. It sorts the same
  way and needs no field discovery.
- **Sprint:** a second, key-only query with `AND sprint in openSprints()` (or `sprint in (<active
sprint ids>)` when a board id is set, via `/rest/agile/1.0/board/{id}/sprint?state=active`). If
  the site has no sprint field (no Jira Software), the query fails with 400 and every active issue
  counts as current, so the sprint toggle doesn't hide everything.
- **Recently completed:** `statusCategory = Done AND updated >= -<N>m`, then filtered on
  `resolutiondate` (falling back to `statuscategorychangedate`, then `updated`). Relative minutes
  avoid JQL's rule that absolute dates are in the user's Jira timezone.
- **Done-like statuses** from Settings are excluded from active work (`status not in (…)`) and
  counted as done.
- **Search results carry the detail fields** (description, comments), so a sync makes 3–4
  requests in total, not one per issue. Up to 1000 issues per query.

## GitLab connector (M1)

Checked against docs.gitlab.com on 2026-11-02.

- **Lists:** `GET /merge_requests` with `scope=created_by_me` (mine, opened and merged with
  `updated_after`) and `scope=all&reviewer_id=<me>` (review requests). This is one call per list
  across all projects, rather than one per watched project. Watched projects filter the results by
  id or path, and an empty list means all projects. Pagination follows the `x-next-page` header.
- **Per-MR requests:** list rows have no head pipeline, approvals or thread state, so each MR
  costs:
  - `GET /projects/:id/merge_requests/:iid` (`head_pipeline`, `detailed_merge_status`,
    `has_conflicts`)
  - `…/approvals`, which is available on Free. Community Edition returns only `approved_by`, so
    `approvals_required` defaults to 0.
  - for open MRs only, `…/discussions` and `…/diffs` (line counts; GitLab 15.7+, and a 404 just
    means no counts).

  At most 4 MRs are fetched at a time.

- **Unresolved threads** are discussions with a resolvable note that isn't resolved.
- **Changes requested** is `detailed_merge_status == requested_changes`. GitLab reports only the
  top merge blocker there, so an MR with conflicts _and_ requested changes shows only the
  conflicts. The per-reviewer `…/reviewers` state would fix that for one more request per MR. Left
  for later.
- **Pipeline statuses** fold into tab-enter's set: `created`, `waiting_for_resource`, `preparing`,
  `scheduled` → pending; `canceling` → canceled; no pipeline → none.

## Sync (M1)

- **The HTTP client** (`packages/connectors/src/http.ts`) retries 429/502/503/504 and network
  errors up to 3 times, honouring `Retry-After` (capped at 60 s) or else backing off exponentially.
  It times out after 30 s. It maps errors to messages the UI can show as they are:
  - 401: "renew it in Settings"
  - 403: scopes
  - DNS or connection failures: "check the VPN"
  - an HTML page served with status 200: "a login/VPN page is in the way"
- **Jira and GitLab sync independently.** If one fails, its last good rows are kept, its error
  goes in `sync_state`, and the other still updates. If both fail, the job fails.
- **Still a full replace, not incremental.** The `updated >=` cursor (spec section 5) would save
  little at one developer's volume, and it complicates detecting removed issues (unassigned,
  deleted). `sync_state.cursor` stays reserved.
- **Saving connections queues a sync** so new settings take effect at once.

## Active Work page (M2)

- **Filtering, sorting and grouping run in the browser**, over data the server page loads from
  SQLite. One developer's tickets are at most a few hundred rows, so every filter change is
  instant and needs no round trip. The logic is plain functions in `packages/core/active-work.ts`
  and is unit-tested.
- **View choices are remembered per profile in localStorage**: layout (by status / table), sort,
  scope and filters. These are per-browser preferences, not profile settings. The search box is
  remembered too, so a reload doesn't lose your place. Esc or Clear resets the filters.
- **Status columns** follow the category order (To Do, then In Progress), then the order in which
  each status first appears in rank order. Jira's real column order lives in board configuration
  that tab-enter doesn't fetch. This approximates it well enough for typical workflows.
- **"Has an MR" counts open MRs only.** A ticket whose only MR is merged is shown as "No MR". It
  usually needs a follow-up, or its status needs moving. Merged MRs still show when the ticket is
  expanded.
- **Priority order** covers both of Jira's default schemes (Highest…Lowest and
  Blocker…Trivial). Custom names sort with Medium, and "no priority" goes last.
- **Manual links store only the difference from the rules.**
  - Unlinking a key the rules found stores an `unlink`. Linking a key no rule finds stores a
    `link`.
  - Reversing either deletes the override instead of storing the opposite. Later syncs (for
    example after a branch rename) keep working, and "Restore" brings back the automatic link.
  - A change recomputes that MR's links at once, in SQLite only, without waiting for a sync.
- **Claude Code runs per ticket** have a placeholder in the expanded row until M3.

## Claude Code runner and Now page (M3)

- **The suggestion engine** (`packages/core/suggestions.ts`) is plain code. Order: feedback →
  failing pipeline → conflicts → reviews waiting on me → next tickets (up to 3, unstarted, in the
  sprint, with no open MR, in rank order). An MR appears once, under its most urgent reason, and the
  reason line lists everything that applies. Review suggestions only offer Copy prompt until the
  structured review run arrives in M5.
- **Prompts come from per-profile templates** (Settings → Prompt templates) filled by context
  builders. A line whose variables are all empty is dropped, so a ticket with no comments doesn't
  leave an empty "Recent comments:" heading. Edits on the Now page apply to that run only.
- **Thread text and failed-job logs are synced for my open MRs only.**
  - Unresolved threads come from the discussions the sync already fetches.
  - For a failed head pipeline, sync fetches its failed jobs (`/pipelines/:id/jobs?scope[]=failed`,
    skipping `allow_failure` ones) and the last 300 lines of up to 3 job logs (`/jobs/:id/trace`).
  - The context builder then sends an error-focused tail capped at `contextCaps.jobLogTailLines`:
    the earliest error line near the end, plus the tail. This costs a few requests per failing MR,
    and only for MRs that are mine and failing.
- **Worktrees:** one per ticket (or `mr-<iid>`), at
  `<clone parent>/.tab-enter-worktrees/<repo>/<key>`. The user's checkout is never switched. Only
  `git fetch` and `git worktree add` touch the repository.
  - **New tickets** get `feature/<KEY>-<slug>` from `origin/HEAD` (falling back to
    `origin/main`/`master`).
  - **MRs** check out their source branch.
  - **A branch already in one of our worktrees** is reused. A branch checked out in the user's own
    clone is refused with an explanation, since git allows a branch in only one worktree and we
    won't touch their checkout.
  - **Branch names from GitLab** must match a conservative ref pattern. Git is always run with
    argv, never a shell.
  - **Cleanup** of worktrees for merged MRs comes later, with a confirmation.
- **Runs go through the job queue** as `agent-run` jobs.
  - The worker runs them in a pool beside syncs, at most `claude.maxParallelRuns` per profile. The
    rest wait in the queue.
  - Events are redacted (`redactDeep`, strings capped at 20k characters) and written to
    `run_events` in batches. The UI polls for them every second; one developer doesn't need
    WebSockets.
  - Cancel sets `cancel_requested`. The worker checks it every second and kills the process.
  - A run left "running" when the worker dies is marked failed at the next start. It can be
    continued, since the session survives.
- **Continue** creates a child run with the same session (`--resume`), folder and preset.
- **Open in terminal** is a worker job that starts `claude --resume <session>` (or plain `claude`
  in the worktree, from a suggestion; the prompt is copied first).
  - **Windows:** Windows Terminal (`wt -d`), falling back to `cmd /c start`.
  - **macOS:** Terminal.app via `osascript`.
  - **Linux:** the first of x-terminal-emulator, gnome-terminal, konsole, xterm.
  - **Guards:** session ids must be UUIDs, and paths with shell-special characters are refused.
- **Gating:** Run in Claude Code is disabled, with the reason shown, until the profile is
  approved for Claude Code, `claude` is installed, and it isn't logged out. The worker checks the
  approval again before running. Demo profiles skip all of this: they replay
  `fixtures/claude/*.jsonl` at a visible pace and cost nothing.
- **Usage** is what Claude Code reports in its result event: tokens, cache reads and `total_cost_usd`.
  It is shown per day, preset and ticket in Settings, with today's total on Now. Soft limits only
  warn.
- **RTK per-run mode** writes a run-only settings file with RTK's `PreToolUse` Bash hook
  (`rtk hook claude`, per RTK's source and install docs) and passes it with `--settings`. If RTK
  isn't installed, the run goes ahead without it and the log says so.
  - **Not verified yet:** no RTK was installed to check against `rtk init --show`.
  - **Telemetry:** unless the profile opts in, the run's settings set `DO_NOT_TRACK=1`. RTK's own
    telemetry switch also needs checking.
  - **Savings** from `rtk gain` aren't in the Usage panel yet.

## Worker

- **Non-run jobs run one at a time.** Since M3, agent runs have their own pool limited by
  `claude.maxParallelRuns` (default 2), so a long run doesn't block syncs.
- **Jobs stuck in "running" for more than 10 minutes are requeued at startup** (crashed worker).
- **Demo mode shifts fixture timestamps** so the fixture's `anchor` lands on "now". The demo never
  goes stale: "recently completed" and waiting times look the same on any date.
