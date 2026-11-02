# Setup

## Requirements

| Tool        | Version                                                            | Notes                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js     | 22 or newer                                                        | Developed on 26                                                                                                                                                                            |
| pnpm        | 10                                                                 | `npm install -g pnpm@10` (Node 25+ no longer bundles corepack)                                                                                                                             |
| Git         | any recent                                                         |                                                                                                                                                                                            |
| Claude Code | **2.0.0 or newer** (provisional, see [decisions.md](decisions.md)) | Optional for exploring the demo; required for AI features. Install it from the Claude Code docs, then run `claude` once to log in. On Windows, prefer the native installer (`claude.exe`). |
| RTK         | optional                                                           | Rust Token Killer. Detected automatically; leave it off unless you want it.                                                                                                                |

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

## Connect a real client (from M1)

1. Go to **Settings → Profiles** and create a profile.
2. Under **Connections**, enter:
   - **Jira Cloud:** site URL, account email and an API token.
   - **Jira Data Center:** base URL and a personal access token.
   - **GitLab:** base URL (gitlab.com or self-managed) and a personal access token with `read_api`
     scope. Write actions (M7) need `api` scope.
3. Tokens go to your OS keychain (macOS Keychain, Windows Credential Manager, or libsecret). On a
   machine with no keychain, set `TAB_ENTER_PASSPHRASE`; tokens are then kept in an encrypted file.

Live sync arrives in M1. Until then, non-demo profiles show a "not built yet" sync error.

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
pnpm typecheck
pnpm lint
pnpm check:fixtures  # fails if fixtures contain non-example domains
pnpm check           # all of the above
pnpm db:generate     # after editing packages/db/src/schema.ts
```

## Troubleshooting

| Symptom                                   | Fix                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| "Not signed in to this tab-enter session" | Open the link printed by `pnpm dev`. Restarting issues a new token.                                                                  |
| "The database has not been set up"        | Start with `pnpm dev`, not `next dev` directly. It runs migrations first.                                                            |
| Claude Code shows "Not installed"         | Install it, make sure `claude --version` works in a new terminal, then click **Re-check** in Settings.                               |
| "No OS keychain is available"             | Set `TAB_ENTER_PASSPHRASE` and restart.                                                                                              |
| `EPERM … unlink …\.next\…` during build   | A sync client (e.g. OneDrive) is locking build output. Delete `apps/web/.next` and rebuild, or keep the repo outside synced folders. |
