import type { TaskPreset } from '@tab-enter/core';

/**
 * Appended to every run regardless of preset: nothing Claude runs may change
 * a remote. Pushing and opening MRs are separate, confirmed tab-enter actions.
 */
export const ALWAYS_DISALLOWED_TOOLS = [
  'Bash(git push:*)',
  'Bash(git remote:*)',
  'Bash(git config:*)',
  'Bash(gh:*)',
  'Bash(glab:*)',
  'Bash(npm publish:*)',
  'Bash(pnpm publish:*)',
  'Bash(yarn publish:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
  'Bash(ssh:*)',
  'Bash(scp:*)',
];

const FORBIDDEN_FLAGS = ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'];

export interface BuildArgsInput {
  preset: TaskPreset;
  resumeSessionId?: string;
  /** Run-specific settings file, e.g. carrying RTK's hook in per-run mode. */
  settingsPath?: string;
  /** Values for {{placeholders}} in tool rules, e.g. artifactsDir. */
  vars?: Record<string, string>;
}

function substitute(rule: string, vars: Record<string, string>): string {
  return rule.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`Tool rule "${rule}" needs a value for {{${name}}}`);
    return value;
  });
}

/**
 * Build the `claude` argv for a headless run. The prompt is NOT included: it is
 * written to stdin, which avoids OS command-line length limits and quoting.
 * See docs/decisions.md for why each flag is used.
 */
export function buildClaudeArgs(input: BuildArgsInput): string[] {
  const { preset } = input;
  const vars = input.vars ?? {};
  const args = ['-p', '--output-format', preset.mode === 'task' ? 'stream-json' : 'json'];
  // stream-json in print mode requires --verbose.
  if (preset.mode === 'task') args.push('--verbose');
  args.push('--model', preset.model);
  args.push('--permission-mode', preset.permissionMode);
  // Headless: nobody can answer a permission prompt, so anything not allowed is denied.
  args.push('--permission-prompts', 'none');
  args.push('--max-turns', String(preset.maxTurns));

  const allowed = preset.allowedTools.map((t) => substitute(t, vars));
  if (allowed.length > 0) args.push('--allowedTools', ...allowed);
  const disallowed = [...new Set([...preset.disallowedTools, ...ALWAYS_DISALLOWED_TOOLS])];
  args.push('--disallowedTools', ...disallowed.map((t) => substitute(t, vars)));

  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
  if (input.settingsPath) args.push('--settings', input.settingsPath);

  for (const flag of FORBIDDEN_FLAGS) {
    if (args.includes(flag)) throw new Error(`${flag} is never allowed`);
  }
  return args;
}
