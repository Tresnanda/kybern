import type { ProviderCommand, ProviderKind } from './types.ts';

export const LOCAL_COMMAND_NAMES = ['resume', 'sessions', 'new', 'stop', 'activity', 'agents', 'reconnect', 'attach', 'changes', 'terminal', 'files', 'environment', 'pr', 'archive', 'settings', 'usage'];
const controls = new Set(['model', 'effort', 'fast', 'switch', 'new', 'resume', 'fork', 'clear', 'approvals']);
const ompTerminal = new Set(['stats', 'trace', 'browser', 'ssh', 'marketplace', 'share', 'computer', 'move', 'wt', 'fullscreen']);

const shortNames: Partial<Record<ProviderKind, string>> = { 'claude-code': 'claude', antigravity: 'agy', 'grok-build': 'grok' };
const shortName = (provider: ProviderKind) => shortNames[provider] ?? provider;
const commandLabel = (name: string) => {
  const words = name.replace(/[-_]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export function nativeCommandSpecs(commands: readonly ProviderCommand[], provider?: ProviderKind) {
  return commands.filter(c => c.source !== 'skill' && !controls.has(c.name)
    && !(provider === 'omp' && ompTerminal.has(c.name))
    && !(provider === 'antigravity' && ['browser', 'schedule'].includes(c.name))
    && (c.name !== 'compact' || (provider === 'omp' && !!c.subcommands?.length)))
    .map(c => ({ ...c, invocation: c.name, label: commandLabel(c.name),
      name: c.name === 'compact' || LOCAL_COMMAND_NAMES.includes(c.name) ? `${shortName(provider ?? 'codex')}:${c.name}` : c.name }));
}
