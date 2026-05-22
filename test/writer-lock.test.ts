import { describe, expect, test } from 'bun:test';
import { commandLooksLikeAgentMonitorTui } from '../src/indexer/writer-lock.ts';

function cmd(args: string[]): string {
  return args.join('\0') + '\0';
}

describe('writer lock owner detection', () => {
  test('recognizes installed agent-monitor tui command', () => {
    expect(commandLooksLikeAgentMonitorTui(cmd(['/home/me/.local/bin/agent-monitor', 'tui']))).toBe(true);
  });

  test('recognizes source CLI tui command', () => {
    expect(commandLooksLikeAgentMonitorTui(cmd(['bun', 'run', 'src/cli.ts', 'tui']))).toBe(true);
  });

  test('does not treat unrelated process mentioning repo name as a writer', () => {
    const raw = cmd([
      'codex',
      '--command-cwd',
      '/home/chenyi/tools/todo_apps/agent-monitor',
      '--',
      '/bin/bash',
    ]);
    expect(commandLooksLikeAgentMonitorTui(raw)).toBe(false);
  });

  test('does not treat non-tui monitor commands as writer', () => {
    expect(commandLooksLikeAgentMonitorTui(cmd(['agent-monitor', 'doctor']))).toBe(false);
  });
});
