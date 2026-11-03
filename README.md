# tab-enter

A local-first developer cockpit around the **Claude Code CLI**. One screen answers: _what am I
working on, what's waiting on me, what do I tell my team, and what do I need to review?_

- **Jira + GitLab** in one view, with merge requests linked to tickets automatically.
- **Next actions** (address feedback, fix a pipeline, review, start the next ticket), each with an
  editable prompt you can hand to Claude Code.
- **Local only.** Binds to 127.0.0.1, keeps tokens in your OS keychain, and has no telemetry. AI runs
  through your own `claude` login.
- **Read-only by default.** Every write to Jira or GitLab is opt-in per profile and confirmed per
  click.

## Quick start

Needs Node.js 22+, pnpm 10 (`npm install -g pnpm@10`) and Git. For AI features, install the
Claude Code CLI and run `claude auth login`.

```bash
git clone https://github.com/justindj/tab-enter.git
cd tab-enter
pnpm install
pnpm dev
```

The first run opens a short setup: name a profile, connect Jira and GitLab (with Test connection),
and set up Claude Code. Or choose "Explore the demo first" to try it on invented data. Your
profiles, tokens and history live on each machine (`~/.tab-enter` and the OS keychain), so a new
machine starts with setup again. See [docs/setup.md](docs/setup.md) for requirements
and connecting real clients, and [docs/decisions.md](docs/decisions.md) for design decisions.

## Layout

```
apps/web          Next.js UI (reads SQLite; never runs git, Claude Code or Playwright)
apps/worker       Job runner: sync, tool detection, Claude Code runs, verification
packages/core     Domain types, settings, linking, MR status, view models, job protocol
packages/connectors  IssueTracker / CodeHost interfaces, demo, Jira (Cloud + DC), GitLab
packages/db       Drizzle schema, migrations, repository functions
packages/claude   Claude Code CLI: detection, args, stream parser, runner
packages/secrets  OS keychain / encrypted-file secret store, credential provider
fixtures/         Invented demo data and recorded Claude Code output
```

## Status

| Milestone                   | State                                                       |
| --------------------------- | ----------------------------------------------------------- |
| M0 Scaffold                 | Done (Claude CLI flags verified on 2.1.309)                 |
| M1 Jira + GitLab connectors | Done (contract-tested; not yet run against a live instance) |
| M2 Active Work page         | Done                                                        |
| M3 Claude Code runner + Now | Done (real runs not yet tried: no logged-in CLI on PATH)    |
| M4 Communication page       | Done                                                        |
| M5 Code Review page         | Done                                                        |
| M6 Verification             | Done                                                        |
| M7 Gated write actions      | Done                                                        |
| Spec leftovers              | Done (dark mode, cleanup, coverage, e2e…; see decisions.md) |
| Later                       | Slack (read-only), Azure DevOps, GitHub, `npx` distribution |

## License

Apache License 2.0. See [LICENSE](LICENSE).
