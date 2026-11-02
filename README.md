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

```bash
pnpm install
pnpm dev
```

This opens a demo profile with invented data. See [docs/setup.md](docs/setup.md) for requirements
and connecting real clients, and [docs/decisions.md](docs/decisions.md) for design decisions.

## Layout

```
apps/web          Next.js UI (reads SQLite; never runs git, Claude Code or Playwright)
apps/worker       Job runner: sync, tool detection, Claude Code runs, verification
packages/core     Domain types, settings, linking, MR status, view models, job protocol
packages/connectors  IssueTracker / CodeHost interfaces, demo + (M1) Jira / GitLab
packages/db       Drizzle schema, migrations, repository functions
packages/claude   Claude Code CLI: detection, args, stream parser, runner
packages/secrets  OS keychain / encrypted-file secret store, credential provider
fixtures/         Invented demo data and recorded Claude Code output
```

## Status

| Milestone                   | State                                                                |
| --------------------------- | -------------------------------------------------------------------- |
| M0 Scaffold                 | Done (Claude CLI flags still to be verified against `claude --help`) |
| M1 Jira + GitLab connectors | Next                                                                 |
| M2–M7                       | Planned (see spec)                                                   |

## License

Apache License 2.0. See [LICENSE](LICENSE).
