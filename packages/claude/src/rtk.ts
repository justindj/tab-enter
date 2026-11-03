// RTK (Rust Token Killer) per-run mode: a settings file passed to one Claude
// Code run with --settings, carrying RTK's Bash hook. The user's global
// ~/.claude/settings.json is never touched.
//
// Hook shape per RTK's source and install docs (2026-11): a PreToolUse hook on
// Bash running `rtk hook claude`, which rewrites commands like `git status` to
// `rtk git status`. Confirm against `rtk init --show` when RTK is installed.

export const RTK_HOOK_COMMAND = 'rtk hook claude';

export interface ClaudeSettingsFile {
  hooks: {
    PreToolUse: { matcher: string; hooks: { type: 'command'; command: string }[] }[];
  };
  env?: Record<string, string>;
}

/**
 * Settings for one run. Unless the profile opted in to telemetry, the run's
 * environment carries DO_NOT_TRACK=1 (the common opt-out convention; RTK's own
 * switch is unverified, see docs/decisions.md). Model routing and the proxy
 * are separate RTK commands tab-enter never enables.
 */
export function rtkRunSettings(opts: {
  rtkPath?: string | null;
  telemetry: boolean;
}): ClaudeSettingsFile {
  const command = opts.rtkPath ? `"${opts.rtkPath}" hook claude` : RTK_HOOK_COMMAND;
  return {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }],
    },
    ...(opts.telemetry ? {} : { env: { DO_NOT_TRACK: '1' } }),
  };
}
