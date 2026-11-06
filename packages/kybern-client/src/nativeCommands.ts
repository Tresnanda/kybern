import type { ProviderCommand, ProviderKind } from './types.ts';

export const LOCAL_COMMAND_NAMES = ['resume', 'sessions', 'new', 'stop', 'activity', 'agents', 'reconnect', 'attach', 'changes', 'terminal', 'files', 'environment', 'pr', 'archive', 'settings', 'usage'];
const controls = new Set(['model', 'effort', 'fast', 'switch', 'new', 'resume', 'fork', 'clear', 'approvals']);
const ompTerminal = new Set(['stats', 'trace', 'browser', 'ssh', 'marketplace', 'share', 'computer', 'move', 'wt', 'fullscreen']);

export function nativeCommandSpecs(commands: readonly ProviderCommand[], provider?: ProviderKind) {
  return commands.filter(c => c.source !== 'skill' && !controls.has(c.name)
    && !(provider === 'omp' && ompTerminal.has(c.name))
    && !(provider === 'antigravity' && ['browser', 'schedule'].includes(c.name))
    && (c.name !== 'compact' || (provider === 'omp' && !!c.subcommands?.length)))
    .map(c => ({ ...c, invocation: c.name,
      name: c.name === 'compact' ? 'omp:compact' : LOCAL_COMMAND_NAMES.includes(c.name) ? `harness:${c.name}` : c.name }));
}
