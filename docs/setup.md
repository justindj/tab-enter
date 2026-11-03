# Setup

## Requirements

| Tool        | Version                                                                          | Notes                                                                                                                                                                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js     | 22 or newer                                                                      | Developed on 26                                                                                                                                                                                                                                                               |
| pnpm        | 10                                                                               | `npm install -g pnpm@10` (Node 25+ no longer bundles corepack)                                                                                                                                                                                                                |
| Git         | any recent                                                                       |                                                                                                                                                                                                                                                                               |
| Claude Code | **2.1.0 or newer** (flags verified on 2.1.309, see [decisions.md](decisions.md)) | Optional for exploring the demo; required for AI features. Install the CLI so `claude` is on PATH, then run `claude auth login`. On Windows, prefer the native installer (`claude.exe`). The copy bundled inside the Claude desktop app is not on PATH and has its own login. |
| RTK         | optional                                                                         | Rust Token Killer. Detected automatically; leave it off unless you want it.                                                                                                                                                                                                   |

tab-enter never needs an Anthropic API key. It runs your installed `claude` with your own login.

## Run

```bash
pnpm install
pnpm dev
```

`pnpm dev` does the following:

1. Creates `~/.tab-enter/` and applies database migrations.
2. Starts the worker, which runs syncs, tool detection and (later) Claude Code and Playwright jobs.
3. Starts the web app on `http://127.0.0.1:3737` (never on other interfaces).
4. Prints and opens a one-time link containing a fresh session token.

The link changes on every start. Other local processes and websites can't use the app without it.

On first run you land in the **Demo** profile. It uses the invented data in `fixtures/demo/`,
needs no credentials, and spends no tokens.

The app starts in dark mode. Switch to Light or System with the control at the top right, or in
Settings → Appearance.

## Connect a real client

1. Go to **Settings → Profiles** and create a profile.
2. Under **Connections**, enter:
   - **Jira Cloud:** site URL (`https://your-site.atlassian.net`), account email and an
     [API token](https://id.atlassian.com/manage-profile/security/api-tokens).
   - **Jira Data Center:** base URL and a personal access token (Jira 8.14+; profile → Personal
     Access Tokens).
   - **Board id** (optional): limits "current sprint" to one board's active sprints. It's the
     `rapidView`/board number in the board URL. Without it, all open sprints count.
   - **Done-like statuses** (optional): status names to treat as done even though Jira puts them in
     another category, e.g. `Ready for Release`.
   - **Token expires** (optional): the expiry you chose when creating the Jira token. Jira doesn't
     report it, but GitLab does, so GitLab's is read automatically. The header dot turns amber 14
     days before a token expires.
   - **GitLab:** base URL (gitlab.com or self-managed) and a personal access token with `read_api`
     scope. Write actions (M7) need `api` scope.
   - **Watched projects** (optional): one `group/project` path or numeric id per line, optionally
     `= C:\path\to\clone`. Empty means MRs from every project.
3. Click **Save**. Tokens go to your OS keychain (macOS Keychain, Windows Credential Manager, or
   libsecret). On a machine with no keychain, set `TAB_ENTER_PASSPHRASE`; tokens are then kept in
   an encrypted file. Saving queues a sync.
4. Click **Test connection**. It calls each service's "who am I" endpoint with the saved values and
   shows who you're connected as, or why it failed.

The worker then syncs every 5 minutes (Settings → sync interval) and on **Refresh** (`r`). Jira and
GitLab sync independently: if one fails, its last good data stays on screen and the header dot for
it turns red with the reason.

## Run Claude Code from tab-enter

1. Install the Claude Code CLI so `claude` is on PATH, and run `claude auth login`. Click
   **Re-check** in Settings → Tools.
2. In Settings → Connections → **Watched projects**, add each project with its local clone:
   `group/project = C:\code\project`. Runs never touch that checkout. They work in a git
   worktree next to it, under `.tab-enter-worktrees/`.
3. In Settings → Claude Code, tick **Claude Code is approved for this client**. Until you do,
   every AI button is replaced by Copy prompt.
4. On **Now → Up next**, edit the prompt if you like, then **Run in Claude Code**. The run page
   streams Claude's work live, and from it you can:
   - **Cancel** the run.
   - **Continue** in the same session.
   - **Open in terminal**, which runs `claude --resume` in the worktree so you can take over.

Runs can commit locally but never push. Pushing and opening MRs are separate, confirmed actions
(M7). In the Demo profile, runs replay recorded output and cost nothing.

## Verify completed tickets

1. Have **Microsoft Edge or Google Chrome** installed. Playwright drives it headless; nothing is
   downloaded. Without either, run `npx playwright install chromium` once.
2. In Settings → **Verification**, for each project set:
   - **Test URL:** a local or test environment, e.g. `http://localhost:3000`. Walkthroughs never
     open anything else.
   - **Start command** (optional): e.g. `pnpm install && pnpm dev`. It runs in a worktree until
     the URL answers. Leave it empty if the app is already running.
   - **Test username and password** (optional): a test account. They go to your keychain and are
     filled in by tab-enter, never sent to Claude.
   - **Playwright tests** (optional): your repo's own specs, e.g. `npx playwright test e2e/`.
     When set, UI tickets run these instead of a Claude-written walkthrough, at no AI cost.
     tab-enter adds `--reporter=json`. Your tests get `BASE_URL`, `TEST_USERNAME` and
     `TEST_PASSWORD` as environment variables.
   - **UI pages for backend changes** (optional): one `glob => /path` per line, e.g.
     `src/api/orders/** => /orders`. A backend change touching matching files gets screenshots of
     those pages.
   - **Capture "before" screenshots** (optional, all projects): repeats the walkthrough on the
     MR's target branch for side-by-side shots. It needs a start command and roughly doubles the
     time.
3. On the **Verification** page, click **Verify** on a completed ticket (or one with an approved
   MR).
   - **Auto** picks a UI walkthrough when UI files changed, otherwise test evidence.
   - **Re-run walkthrough** repeats the saved steps with no AI cost.
   - **View slideshow** opens the result. **Download HTML** saves it for offline viewing or
     printing to PDF.

UI walkthroughs need Claude Code approved for the client, since Claude writes the steps. Backend
verification and re-runs work without it, and so do your repo's own Playwright tests, but
criteria are then marked from evidence only. When GitLab reports pipeline coverage, the slideshow
shows it next to the target branch's.

## Worktrees

Each Claude run works in a git worktree next to your clone (`.tab-enter-worktrees/`), so your own
checkout is never touched.

- **Cleanup:** after each sync, worktrees whose branch's MR has merged or closed are removed.
- **Local work is never deleted silently.** If a worktree has uncommitted changes or commits that
  aren't on any remote, Settings → **Worktrees** asks first, showing what would be lost.
- **Branches are kept:** local branches are never deleted.

## Write to GitLab and Jira (optional)

Everything is read-only until you opt in. In Settings → **Write actions**, tick only what you
want:

- **Push branches:** pushes a run's branch with your own git credentials. It never force-pushes
  and never pushes main/master.
- **Open merge requests, post comments, approve:** need a GitLab token with the **`api`** scope
  (replace the `read_api` token in Connections).
- **Comment on / move Jira tickets:** need a Jira token that can edit the tickets.

Each action still asks you to confirm, showing exactly what will be sent. Every attempt, with its
payload and outcome, is listed under Settings → **Write log**.

Where the buttons are:

- **Run page:** Push branch, Open merge request.
- **Code Review page:** post the selected findings (as one comment, or on lines), and Approve.
- **Verification page:** Post to MR, Post to Jira.
- **Active Work page:** Move ticket.

## Environment variables

| Variable               | Default                    | Purpose                                                             |
| ---------------------- | -------------------------- | ------------------------------------------------------------------- |
| `TAB_ENTER_HOME`       | `~/.tab-enter`             | Data directory: database, artifacts, run logs, per-profile folders  |
| `TAB_ENTER_PORT`       | `3737`                     | Web port (always bound to 127.0.0.1)                                |
| `TAB_ENTER_PASSPHRASE` | unset                      | Unlocks the encrypted secrets file when no OS keychain is available |
| `TAB_ENTER_NO_OPEN`    | unset                      | Don't open a browser on start                                       |
| `TAB_ENTER_DB_URL`     | `file:<home>/tab-enter.db` | Override the database location                                      |

## Development

```bash
pnpm test            # unit + integration tests (no network, no tokens)
pnpm test:e2e        # starts the app in demo mode and drives it with your Edge or Chrome
pnpm typecheck
pnpm lint
pnpm check:fixtures  # fails if fixtures contain non-example domains
pnpm check           # all of the above
pnpm db:generate     # after editing packages/db/src/schema.ts
```

## Troubleshooting

| Symptom                                      | Fix                                                                                                                                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Not signed in to this tab-enter session"    | Open the link printed by `pnpm dev`. Restarting issues a new token.                                                                                                                 |
| "The database has not been set up"           | Start with `pnpm dev`, not `next dev` directly. It runs migrations first.                                                                                                           |
| Claude Code shows "Not installed"            | Install the CLI, make sure `claude --version` works in a new terminal, then click **Re-check** in Settings. The Claude desktop app's built-in copy doesn't count: it isn't on PATH. |
| Claude Code shows "Logged out"               | Run `claude auth login` in a terminal (the CLI has its own login, separate from the desktop app), then **Re-check**.                                                                |
| Jira or GitLab: "rejected the token (401)"   | The token expired or was revoked. Create a new one and paste it in Settings → Connections.                                                                                          |
| "Can't resolve …" / "Can't reach …"          | The host isn't reachable from this machine. Connect to the VPN for internal instances, or check the URL.                                                                            |
| "returned a web page instead of API data"    | The URL points at a login/SSO or VPN page, or isn't the instance root. Use the base URL (no `/jira` path unless your instance has one).                                             |
| Run fails: "Set a local clone path…"         | Add `= C:\path\to\clone` after the project in Settings → Watched projects.                                                                                                          |
| Run fails: "Branch … is checked out in …"    | That branch is checked out in your own clone. Switch your clone to another branch so tab-enter can make a separate worktree.                                                        |
| Run fails: "The worker stopped…"             | The worker restarted mid-run. Open the run and use **Continue** to pick the session back up.                                                                                        |
| Jira: no issues under "Current sprint"       | Your issues aren't in an open sprint, or the board id is wrong. Toggle to **All** to check.                                                                                         |
| "No OS keychain is available"                | Set `TAB_ENTER_PASSPHRASE` and restart.                                                                                                                                             |
| "Another next dev server is already running" | A previous `pnpm dev` (or `pnpm test:e2e`) is still running. Stop it (Ctrl+C, or end its `node` processes) and start again.                                                         |
| `EPERM … unlink …\.next\…` during build      | A sync client (e.g. OneDrive) is locking build output. Delete `apps/web/.next` and rebuild, or keep the repo outside synced folders.                                                |
