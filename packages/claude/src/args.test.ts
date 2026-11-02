import { DEFAULT_PRESETS } from '@tab-enter/core';
import { describe, expect, it } from 'vitest';
import { ALWAYS_DISALLOWED_TOOLS, buildClaudeArgs } from './args';

function flagValues(args: string[], flag: string): string[] {
  const start = args.indexOf(flag);
  if (start === -1) return [];
  const values: string[] = [];
  for (let i = start + 1; i < args.length && !args[i]!.startsWith('--'); i++) values.push(args[i]!);
  return values;
}

describe('buildClaudeArgs', () => {
  const vars = { artifactsDir: '/data/p1/artifacts/run1' };

  it('builds a streamed task run', () => {
    const args = buildClaudeArgs({ preset: DEFAULT_PRESETS['work-ticket'] });
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(flagValues(args, '--model')).toEqual(['sonnet']);
    expect(flagValues(args, '--permission-mode')).toEqual(['acceptEdits']);
    expect(flagValues(args, '--max-turns')).toEqual(['50']);
    expect(flagValues(args, '--allowedTools')).toContain('Bash(git commit:*)');
  });

  it('always disallows pushing and remote-changing commands', () => {
    for (const preset of Object.values(DEFAULT_PRESETS)) {
      const disallowed = flagValues(buildClaudeArgs({ preset, vars }), '--disallowedTools');
      for (const rule of ALWAYS_DISALLOWED_TOOLS) expect(disallowed).toContain(rule);
    }
  });

  it('never skips permissions', () => {
    for (const preset of Object.values(DEFAULT_PRESETS)) {
      expect(buildClaudeArgs({ preset, vars }).join(' ')).not.toContain('dangerously');
    }
  });

  it('uses JSON output and read-only tools for code review', () => {
    const args = buildClaudeArgs({ preset: DEFAULT_PRESETS['code-review'] });
    expect(flagValues(args, '--output-format')).toEqual(['json']);
    expect(args).not.toContain('--verbose');
    expect(flagValues(args, '--allowedTools')).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('omits --allowedTools when a preset allows none', () => {
    expect(buildClaudeArgs({ preset: DEFAULT_PRESETS['short-text'] })).not.toContain(
      '--allowedTools',
    );
  });

  it('adds resume and settings flags', () => {
    const args = buildClaudeArgs({
      preset: DEFAULT_PRESETS['address-feedback'],
      resumeSessionId: 'abc',
      settingsPath: '/tmp/run-settings.json',
    });
    expect(flagValues(args, '--resume')).toEqual(['abc']);
    expect(flagValues(args, '--settings')).toEqual(['/tmp/run-settings.json']);
  });

  it('substitutes placeholders and fails loudly when one is missing', () => {
    const preset = DEFAULT_PRESETS['verification-script'];
    const args = buildClaudeArgs({ preset, vars: { artifactsDir: '/data/p1/artifacts/run1' } });
    expect(flagValues(args, '--allowedTools')).toContain('Write(/data/p1/artifacts/run1/**)');
    expect(() => buildClaudeArgs({ preset })).toThrow(/artifactsDir/);
  });
});
