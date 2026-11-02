# Database schema (proposal for review before M1)

Source of truth: [`packages/db/src/schema.ts`](../packages/db/src/schema.ts). Migrations are
generated into `packages/db/drizzle/` with `pnpm db:generate` and applied by `pnpm dev`.

Conventions:

- Every table has `user_id` (always `local` in v1).
- Client data also has `profile_id`. Deleting a profile deletes every row with that id.
- Timestamps are epoch milliseconds.
- Synced provider objects are stored whole in a JSON `data` column, with the filter and sort fields
  copied into columns.
- Rows refer to each other by natural key (`issue_key`, `mr_key` = `projectId!iid`).

| Table                    | Key                               | Purpose                                                                                                                                                                                                                                         |
| ------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                  | `id`                              | One row (`local`) in v1; real users in a hosted version                                                                                                                                                                                         |
| `profiles`               | `id`                              | One per client: `name`, `is_demo`, `settings` (JSON, validated by `ProfileSettingsSchema`), `secret_names` (keychain entry names, never values)                                                                                                 |
| `app_state`              | `user_id, key`                    | Small per-user state, such as the active profile                                                                                                                                                                                                |
| `tool_status`            | `user_id, tool`                   | Latest `claude` / `rtk` detection                                                                                                                                                                                                               |
| `issues`                 | `id`; unique `profile_id, key`    | Synced Jira issues. Columns: `status_category`, `in_open_sprint`, `rank`, `updated_at`, `completed_at`; `data` holds `IssueDetail`                                                                                                              |
| `merge_requests`         | `id`; unique `profile_id, mr_key` | Synced GitLab MRs. Columns: `state`, `is_mine`, `is_reviewer`, `needs_my_review`, `updated_at`, `merged_at`; `data` holds `MergeRequest`                                                                                                        |
| `mr_issue_links`         | `profile_id, mr_key, issue_key`   | Links computed by the linking rules (rebuilt each sync), with their `source`                                                                                                                                                                    |
| `manual_links`           | `profile_id, mr_key, issue_key`   | The user's manual link and unlink overrides (never touched by sync)                                                                                                                                                                             |
| `sync_state`             | `profile_id, source`              | Last success, last attempt, last error, incremental cursor                                                                                                                                                                                      |
| `agent_runs`             | `id`                              | A Claude Code run: ticket and MR, preset, prompt, `session_id`, `parent_run_id` (Continue), status, cwd, requested and used model, exit code, error, files changed, tokens (input, output, cache read, cache creation), cost, turns, timestamps |
| `run_events`             | `run_id, seq`                     | The streamed log of a run as normalized `AgentEvent`s, redacted before insert                                                                                                                                                                   |
| `verification_artifacts` | `id`                              | Per-ticket verification: status, slideshow blob key, saved walkthrough script blob key, per-criterion results, summary                                                                                                                          |
| `code_reviews`           | `id`                              | Stored review results per MR with `reviewed_sha`, for incremental re-review                                                                                                                                                                     |
| `messages`               | `id`                              | Generated Slack messages (daily report, review request), format, window. The newest 30 per profile are kept.                                                                                                                                    |
| `write_action_log`       | `id`                              | Every write to Jira or GitLab, and every push: action, target, summary, time                                                                                                                                                                    |
| `jobs`                   | `id`                              | SQLite-backed job queue: type, JSON payload (`JobSchema`), status, attempts, `run_after`, lock                                                                                                                                                  |

## Open points for M1

- **Incremental sync:** use `sync_state.cursor` with Jira's `updated >= "<cursor>"` and GitLab's
  `updated_after`, and switch from replace-all to upsert plus pruning of rows no longer returned.
- **`issues.assigned_to_me`** exists so that, with upserts, a ticket reassigned away can drop out of
  views without being deleted.
- **Usage roll-ups** (per day, preset and ticket) are computed from `agent_runs` with `GROUP BY`. No
  extra table is needed unless that gets slow.
