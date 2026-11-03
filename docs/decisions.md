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
  - **Cleanup** of worktrees for merged MRs: see "Completing the spec".
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

## Communication page (M4)

- **Messages are built as structured items, then rendered** to Slack mrkdwn or plain text, so one
  template serves both formats.
  - **Slack:** `<url|text>` links, `•` bullets, `*Heading*`, and `& < >` escaped in text.
  - **Plain text:** `text (url)`, `-` bullets, `Heading:`.
  - **Templates** live in Settings. A `# ` line is a heading, and `{{done}}`, `{{inProgress}}`
    and the like take pre-rendered lists.
- **Daily report sections:**
  - **Done:** tickets completed in the window, each with the MRs merged for it, then other merges.
  - **In progress:** started tickets, with each open MR's status.
  - **Next:** the top 3 suggestions from the Now page.
  - **Blockers:** my MRs with a failing pipeline, conflicts, or awaiting review longer than the
    stale threshold (counted from when the MR was opened), plus tickets in a blocked status.
- **Windows use the machine's local time.** "On Mondays, cover since Friday" means the same time
  on Friday, 72 hours back. "Since my last report" uses the last daily report you _copied_:
  copying is the signal you sent it, not generating it. The page's window picker overrides the
  window for one report through the URL.
- **Done can only reach back as far as sync.** Completed tickets and merged MRs are now synced
  for at least 7 days (`completedSyncDays`), even though Now still only shows the 3-day retention.
  When a report's window starts earlier, the page says so.
- **History saves on Copy**, not on generate. Copying the same text again doesn't add a
  duplicate, and only the newest 30 per profile are kept.
- **Polish with Claude** is a `short-text` run: one turn, haiku, no tools, in an empty scratch
  folder rather than a worktree.
  - **The prompt** wraps the message in `<message>` tags and asks Claude to keep every key, link
    and number. The answer is unwrapped from code fences and tags.
  - **Review:** the result replaces the text with an Undo, and the user reviews it before copying.
  - **Gating:** the same as other runs.
  - **Demo:** there's no recording of rewriting _this_ text, so the replay echoes it unchanged and
    says so.
- **Keyboard:** with a message card focused (Tab to it), `c` copies it. Typing in the text box
  doesn't trigger it.

## Code Review page (M5)

- **A review is an `agent-run` with the `code-review` preset.**
  - It runs in a worktree on the MR's source branch, using read-only tools (Read, Grep, Glob) in
    `dontAsk` mode.
  - The worker builds the prompt, because it needs the diff: it fetches, fast-forwards the
    worktree to `origin/<source>`, then `git diff origin/<target>...HEAD`.
  - If the worktree can't fast-forward, the review uses its HEAD and the log says so.
  - The demo uses the fixture's diff.
- **Re-reviews are incremental.** If an earlier review produced a valid result, and its commit
  still exists, only `<reviewed sha>..HEAD` is sent, with that review's blockers to re-check. After
  a force-push, the review falls back to the full diff. "Changed since review" compares the last
  reviewed commit with the MR's synced head.
- **Diff hygiene:**
  - Files matching `reviewExcludeGlobs` (lockfiles, snapshots, vendored, minified, generated)
    are dropped, and the prompt lists them.
  - The rest is capped at `contextCaps.diffChars`, smallest files first, so one huge file can't
    crowd out the others. Claude can read anything cut from the worktree.
  - Globs are matched by a small converter (`**`, `*`, `?`), so the same rule applies to git and
    demo diffs.
- **Structured output.**
  - **Format:** the prompt asks for one JSON object (summary, blockers, suggestions, questions,
    verdict), validated with zod. A fenced or surrounded object is still found, and "text" or
    "comment" are accepted as the reason.
  - **Retry:** if the reply doesn't validate, the run asks once more in the same session with the
    validation error. Both answers count toward usage.
  - **Fallback:** if the retry fails too, the raw text is stored and shown.
  - **Not used yet:** `--json-schema`, which exists in 2.1.309, but its output shape hasn't been
    checked against a real run. It's a candidate once a logged-in CLI is available.
- **Teammates' tickets.** Sync now also fetches tickets linked from MRs I review (up to 25,
  skipping any I can't read), so review prompts get their acceptance criteria. They're stored with
  `assignedToMe: false` and stay out of Now, Active Work and the daily report.
- **Results are stored per review** in `code_reviews`, with the reviewed commit, the run, the
  result or raw text, and any excluded files. The page shows the latest review and has copy
  actions: blockers, the full review as Markdown, and single comments. It refreshes itself while a
  review runs.
- **Approving stays a human click in GitLab.** The verdict is a recommendation only. Posting
  comments and approving from tab-enter are M7, behind settings and a confirmation.

## Verification (M6)

- **Walkthroughs are data, not code.** The spec suggested Claude writing Playwright scripts and
  running `npx playwright`. Instead:
  - **What Claude does:** the `verification-script` preset is read-only (Read, Grep, Glob,
    `dontAsk`). Claude reads the code and replies with a JSON list of steps: goto, click, fill,
    press, expectText, expectVisible, screenshot, wait. The steps are validated with zod, and
    unknown actions are rejected.
  - **What tab-enter does:** runs the steps with Playwright's library itself.
  - **Why:**
    - No generated code is ever executed.
    - The tools Claude needs stay minimal.
    - The saved script is a reviewable JSON file that re-runs with no AI cost.
  - **Upgrade:** stored presets from M3–M5, which allowed Write and Bash, are upgraded to the
    read-only one when settings load.
- **Browser:** `playwright-core` drives the user's installed **Edge or Chrome** (headless), then
  Playwright's bundled Chromium if present. There's no browser download in `pnpm install`. Checked
  on this machine: Edge 156 and Chrome 156 both launch.
- **Walkthroughs stay on the configured test origin.**
  - **Navigation:** `goto` paths resolve against the project's test URL, and any other origin is
    refused.
  - **Requests:** every request to another origin (analytics, CDNs, third parties) is aborted.
    Client content can't leak, and a test environment can't call production.
- **Credentials:**
  - **Storage:** each project's test username and password are one keychain entry
    (`test-credentials:<project>`).
  - **Placeholders:** Claude only ever sees `{{TEST_USER}}` / `{{TEST_PASSWORD}}`, and the runner
    substitutes them when filling a field.
  - **The slideshow** shows password fills as `••••`.
  - **Tested:** a real-browser test checks that the password reaches the app but not the prompt or
    the slideshow.
- **The app under test:**
  - With a start command, the app is started in a worktree, and tab-enter waits up to 120 s for
    the URL to answer. Afterwards the whole process tree is stopped (`taskkill /t` on Windows, the
    process group elsewhere).
  - An open MR runs its source branch.
  - A merged ticket runs a **detached** worktree at `origin/<target>`, so no local branch is
    involved and the user's checkout is never touched.
  - With no start command, the test URL is assumed to be running already.
- **Changed files come from GitLab's MR diff**, which works for open and merged MRs (a merged
  branch is often deleted). A simple classifier decides "UI" (tsx/vue/svelte/css/html, pages and
  components folders) and "test" files. In Auto mode, UI files mean a walkthrough; otherwise it's
  test evidence. The user can force either mode.
- **Assessment:** Claude (`short-text`, JSON) marks each acceptance criterion verified, partial or
  not verified, from the walkthrough results, pipeline status and changed tests.
  - **Without Claude** (not approved, or the demo), the assessment is evidence-only, labelled as
    such, and never says "verified".
  - **Outcome:**
    - **Passed:** every criterion is verified and nothing failed.
    - **Needs coverage:** a backend change with no changed tests.
    - **Issues found:** anything else.
  - **Retries:** each Claude call is an ordinary run (on the Runs page, with cost), retried once
    in the same session if the JSON is invalid.
- **The slideshow is one self-contained HTML file.** Screenshots are embedded as data URIs and
  there are no external resources.
  - **Navigation:** arrow keys. Print CSS puts one slide per page for "Save as PDF".
  - **Viewing in the app:** it's served with a CSP that allows only inline styles and scripts and
    `data:` images, inside a sandboxed iframe.
  - **Storage:** it lives in the BlobStore under the profile's folder, so deleting the profile
    removes it.
  - **Web access:** reading the BlobStore from the web app is the second exception to "web only
    touches SQLite", like the secret store. It's storage behind an interface that becomes object
    storage when hosted.
- **Added after M7:** "before" screenshots, coverage change, the repo's own Playwright specs, and
  the backend → UI page mapping. See "Completing the spec" below.
- **Verification jobs run in the same pool as Claude runs** (`maxParallelRuns` per profile), so a
  long walkthrough never blocks syncs.

## Gated write actions (M7)

- **Seven actions, each behind its own per-profile toggle, all off by default:**
  - push a branch
  - open an MR
  - comment on an MR (as one comment, or on lines)
  - approve an MR
  - comment on a Jira ticket
  - move a Jira ticket

  Enabling a toggle only makes the button usable. Every use still opens a confirmation showing
  exactly what will be sent (text, commits, target commit) and where.

- **Log first, then write.**
  - The web app writes a `pending` row to `write_action_log` with the confirmed payload and queues
    a `write-action` job.
  - The worker checks the toggle again, performs the write, and records `done` (with a URL or
    message) or `failed` (with the error).
  - Settings → Write log shows every attempt with its payload. The web app waits up to 90 s for the
    outcome, so the result appears next to the button.
- **Writes are never retried after a possible success.**
  - The HTTP client's `write()` retries only a 429, since a rate-limited request wasn't processed.
  - A 5xx or a dropped connection may already have posted, so the user decides whether to try
    again.
  - The job itself runs once.
- **Push:**
  - Runs `git push --porcelain -u origin refs/heads/<b>:refs/heads/<b>` with the user's own git
    credentials. It never uses `--force` or `--force-with-lease`; a rejected push is reported.
  - Refuses protected names (main, master, develop, release/*, production…), branches with unusual
    characters, and a worktree whose HEAD isn't the run's branch.
  - Claude Code still can't push: `git push` stays in `ALWAYS_DISALLOWED_TOOLS`. Only this
    confirmed tab-enter action can.
- **Unpushed work is recorded** after every task run: commits ahead of the upstream (or
  origin's default branch) and the number of uncommitted files. The run page shows them, and the
  push confirmation lists the commits.
- **Approve sends `sha`** (the commit Claude reviewed), so GitLab refuses if the MR has moved on.
  The confirmation warns when new commits arrived after the review, and when Claude recommended
  requesting changes. Approval is still a human click, never automatic (spec 4.5).
- **Line comments** use the MR's `diff_refs`. A line GitLab can't place on the diff is posted as a
  general comment prefixed with `file:line`, rather than lost.
- **Jira comments** are ADF on Cloud (one paragraph per line) and plain text on Data Center.
  Transitions come from the ticket's own workflow (`GET …/transitions`) through a worker query job,
  and the job row now has a `result` column for such reads.
- **After approve, open MR or move ticket, a sync is queued** so the UI catches up.
- **Demo profiles simulate writes.** Enabled actions are logged as "simulated, nothing was sent",
  so the flows can be tried safely.
- **GitLab tokens need the `api` scope** for any GitLab write. With `read_api` the write fails
  with a 403 that says to check scopes.

## Completing the spec (after M7)

- **Dark mode, dark by default.**
  - **Options:** Dark, Light or System, chosen in the header or Settings → Appearance.
  - **Scope:** one app-wide preference (`app_state.theme`), not per profile, since it's about the
    person, not the client.
  - **No flash:** the server renders `<html data-theme>`, so the page never flashes the wrong
    theme.
  - **System:** follows `prefers-color-scheme`. Tailwind's `dark:` variant covers both cases.
  - **Native controls:** `color-scheme` is set, so scrollbars and date pickers follow too.
- **Token expiry warnings** (spec 3, Jira details).
  - **GitLab:** reports expiry through `GET /personal_access_tokens/self` (15.5+). It's read after
    each successful sync and stored on `sync_state.token_expires_at`, not in settings, so it can't
    race the user's edits. Older GitLab gives a 404, which is treated as unknown.
  - **Jira:** has no such endpoint, so Settings takes the date the user chose when creating the
    token.
  - **When it shows:** the header dot turns amber 14 days before expiry and red after it, even if
    the last sync worked. Test connection also reports GitLab's expiry.
- **Worktree cleanup** (spec 5).
  - **When:** after each sync of a profile with local clones, a `cleanup-worktrees` job looks at
    tab-enter's own worktrees (only under `.tab-enter-worktrees/`).
  - **Which:** a branch whose MRs are all merged or closed, with none open, is up for cleanup.
  - **Clean worktrees are removed** with `git worktree remove`, without `--force`, so git itself
    refuses if something changed since the check.
  - **Worktrees with local work wait:**
    - "Local work" means uncommitted files, or commits on no remote (`HEAD --not --remotes`).
    - These are recorded as needing confirmation. Settings → Worktrees lists them, with what would
      be lost.
    - **Remove anyway** (confirmed) queues a `remove-worktree` job that uses `--force`. **Keep**
      stops tab-enter asking.
  - **Branches are kept:** local branches are never deleted, so commits survive in the branch.
  - **Left alone:** detached verification worktrees, which are reused.
  - **Squash merges:** a GitLab source branch deleted after merge and pruned locally makes its
    commits look unpushed, so tab-enter asks rather than guesses.
- **RTK savings** (spec 4.7).
  - **Source:** tool detection runs `rtk gain --all --format json`. The documented shape has a
    `summary` with `total_commands`, `total_input`, `total_saved` and `avg_savings_pct`.
  - **Display:** the Usage panel shows the totals, labelled as RTK's own estimate.
  - **Scope:** the figures cover all projects. RTK tracks per machine, not per tab-enter profile.
  - **Safety:** only a binary that identifies itself as RTK is asked. Older RTK without JSON
    output just shows nothing.
- **Verification additions** (spec 4.3).
  - **The repo's own Playwright tests.** A per-project "Playwright tests" command (e.g.
    `npx playwright test e2e/`) replaces the Claude-written walkthrough for UI tickets, at no AI
    cost.
    - **How it runs:** in the change's worktree, through the user's shell, like the start command.
      tab-enter appends `--reporter=json` and sets `PLAYWRIGHT_JSON_OUTPUT_NAME`.
    - **Environment:** `BASE_URL`, plus `TEST_USERNAME` / `TEST_PASSWORD` from the keychain when
      configured. Credentials go in the environment only, and are masked out of any error output.
    - **Results:** per-test statuses and PNG attachments (up to 12) go into the slideshow and the
      assessment prompt.
    - **Time limit:** 10 minutes.
  - **Backend → UI pages.** One `glob => /path` per line per project. A backend change with
    matching files gets a goto-and-screenshot smoke check of those pages (at most 8). A page that
    fails to load counts as an issue.
  - **"Before" screenshots** (opt-in, Settings → Verification):
    - **What runs:** after the change's walkthrough, the same steps run against the MR's target
      branch (a detached worktree), started with the same start command.
    - **Port handoff:** the first app is stopped and its port confirmed free before the second
      starts.
    - **Display:** the slideshow shows the before and after shots side by side.
    - **Failures don't count:** checks failing on the old code are expected and don't affect the
      outcome, and they use a 4 s step timeout so they fail fast.
    - **Scope:** only open MRs; for merged ones the target branch already contains the change.
  - **Coverage change.** GitLab's pipeline `coverage` for the MR head and for the target branch's
    latest successful pipeline. The test-evidence slide shows both and the difference. Unknown
    values are just omitted.
- **End-to-end tests of tab-enter itself** (spec 9).
  - **Run:** `pnpm test:e2e` starts the real app (web + worker, via `scripts/dev.mjs`) on a spare
    port with a throwaway data folder, in demo mode. CI runs it after the build.
  - **Coverage:**
    - the token gate
    - sign-in
    - the dark default and the theme switch
    - `g a` navigation
    - a replayed Claude run
    - the daily report
    - a replayed review
    - a demo verification and its slideshow
    - Settings
  - **Browser:** Playwright (`playwright-core`) drives the installed Edge or Chrome.
  - **Teardown:** kills the whole process tree and waits for it. Otherwise a leftover `next dev`
    blocks the next start.

## Worker

- **Non-run jobs run one at a time.** Since M3, agent runs have their own pool limited by
  `claude.maxParallelRuns` (default 2), so a long run doesn't block syncs.
- **Jobs stuck in "running" for more than 10 minutes are requeued at startup** (crashed worker).
- **Demo mode shifts fixture timestamps** so the fixture's `anchor` lands on "now". The demo never
  goes stale: "recently completed" and waiting times look the same on any date.
