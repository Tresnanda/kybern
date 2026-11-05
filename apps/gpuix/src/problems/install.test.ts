import { describe, expect, test } from 'bun:test'
import { installPlan, providerOf } from './install.ts'

const noBrew = () => false
const brew = (path: string) => path === '/opt/homebrew/bin/brew'

describe('install plans', () => {
  test('Windows installs the system tools with winget', () => {
    expect(installPlan('git', true, 'win32')).toEqual({ kind: 'command', title: 'Install Git', command: 'winget install --id Git.Git -e' })
    expect(installPlan('gh', true, 'win32')).toMatchObject({ command: 'winget install --id GitHub.cli -e' })
    expect(installPlan('npm', true, 'win32')).toMatchObject({ title: 'Install Node.js', command: 'winget install --id OpenJS.NodeJS.LTS -e' })
  })

  test('a Mac with Homebrew installs with brew, and one without opens the download page', () => {
    expect(installPlan('tailscale', true, 'darwin', brew)).toMatchObject({ kind: 'command', command: 'brew install --cask tailscale' })
    expect(installPlan('tailscale', true, 'darwin', noBrew)).toEqual({ kind: 'page', url: 'https://tailscale.com/download' })
  })

  test('only a page opens when there is no installer to run', () => {
    expect(installPlan('git', true, 'linux')).toEqual({ kind: 'page', url: 'https://git-scm.com/downloads' })
    // Another computer's own OS is unknown, so its system installers are never guessed.
    expect(installPlan('git', false, 'win32')).toEqual({ kind: 'page', url: 'https://git-scm.com/downloads' })
  })

  test('agents install with npm on any machine, and Cursor with its own setup', () => {
    expect(installPlan('claude', true, 'win32')).toEqual({ kind: 'command', title: 'Install Claude Code', command: 'npm install -g @anthropic-ai/claude-code' })
    expect(installPlan('codex', false, 'win32')).toMatchObject({ kind: 'command', command: 'npm install -g @openai/codex' })
    expect(installPlan('cursor-agent', true)).toEqual({ kind: 'cursor' })
  })

  test('a tool Kybern knows no installer for has none', () => {
    expect(installPlan('ffmpeg', true, 'win32')).toBeNull()
    expect(providerOf('claude')).toBe('claude-code')
    expect(providerOf('git')).toBeNull()
  })
})
