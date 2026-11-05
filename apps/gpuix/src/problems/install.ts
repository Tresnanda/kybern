// How a missing tool gets installed from a Problem's "Install" button: the command to type into a Kybern terminal (winget on Windows,
// Homebrew on a Mac that has it, npm for the agents), or the page to open when there is no installer to run. Pure: `plan` takes the
// platform and a file probe so tests need no machine. Only this computer's own OS is known; a remote machine runs only the npm
// commands, which are the same everywhere, and otherwise gets the download page.
import { existsSync } from 'node:fs'
import type { ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { AGENT_NAMES, agentCommand } from '../onboarding/model.ts'

export type InstallPlan =
  | { kind: 'command'; title: string; command: string }
  | { kind: 'cursor' }
  | { kind: 'page'; url: string }

interface Installer { title: string; win?: string; brew?: string; url: string }

/** The tools people meet first: what each is called in the terminal's title, its installers and its download page. */
const INSTALLERS: Record<string, Installer> = {
  gh: { title: 'Install GitHub CLI', win: 'winget install --id GitHub.cli -e', brew: 'brew install gh', url: 'https://cli.github.com' },
  git: { title: 'Install Git', win: 'winget install --id Git.Git -e', brew: 'brew install git', url: 'https://git-scm.com/downloads' },
  node: { title: 'Install Node.js', win: 'winget install --id OpenJS.NodeJS.LTS -e', brew: 'brew install node', url: 'https://nodejs.org/en/download' },
  tailscale: { title: 'Install Tailscale', win: 'winget install --id Tailscale.Tailscale -e', brew: 'brew install --cask tailscale', url: 'https://tailscale.com/download' },
}
const ALIASES: Record<string, string> = { npm: 'node', npx: 'node' }

const PROVIDERS: Record<string, ProviderKind> = {
  claude: 'claude-code', 'claude-code': 'claude-code', codex: 'codex', opencode: 'opencode', pi: 'pi', omp: 'omp',
  cursor: 'cursor', 'cursor-agent': 'cursor', agy: 'antigravity', antigravity: 'antigravity',
}

/** The agent a tool name (a binary or a subject) stands for, or `null`. */
export const providerOf = (tool: string): ProviderKind | null => PROVIDERS[tool.toLowerCase()] ?? null

const BREW = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']

/** What installs `tool`, or `null` when Kybern knows no way (the button is then not shown). */
export function installPlan(tool: string, local: boolean, platform: NodeJS.Platform = process.platform, hasFile: (path: string) => boolean = existsSync): InstallPlan | null {
  const kind = providerOf(tool)
  if (kind === 'cursor') return { kind: 'cursor' }
  if (kind) {
    const command = agentCommand(kind, 'install', local ? platform : 'linux')
    return command ? { kind: 'command', title: `Install ${AGENT_NAMES[kind]}`, command } : null
  }
  const installer = INSTALLERS[ALIASES[tool] ?? tool]
  if (!installer) return null
  const command = !local ? null : platform === 'win32' ? installer.win : platform === 'darwin' && BREW.some(hasFile) ? installer.brew : null
  return command ? { kind: 'command', title: installer.title, command } : { kind: 'page', url: installer.url }
}
