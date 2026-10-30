// What a terminal tab says. Windows consoles announce their own executable ("C:\WINDOWS\system32\cmd.exe") until the
// user runs `title`; that reads as a path, not a name, so it is shown as the shell's friendly name instead.
const SHELLS: Record<string, string> = { cmd: 'cmd', powershell: 'PowerShell', pwsh: 'PowerShell', wsl: 'WSL', bash: 'bash' }
const FRIENDLY = new Set(Object.values(SHELLS))

/** The friendly shell name when `raw` is just a shell executable's path (`Administrator: ` prefix and quotes allowed), else null. */
export function shellExecutableLabel(raw: string): string | null {
  const title = raw.trim().replace(/^Administrator:\s*/i, '').replace(/^"(.*)"$/, '$1')
  const match = /^(?:[A-Za-z]:)?(?:.*[\\/])?([^\\/\s]+)\.exe(?:\s.*)?$/i.exec(title)
  if (!match) return null
  const name = match[1]!.toLowerCase()
  return SHELLS[name] ?? match[1]!
}

/** A tab's label: the shell's friendly name for a default title, with the machine's name for a terminal on another machine. */
export function terminalTabLabel(raw: string | undefined, machineName?: string): string {
  const title = raw?.trim() ?? ''
  const shell = shellExecutableLabel(title) ?? (FRIENDLY.has(title) && machineName ? title : null)
  if (shell) return machineName ? `${shell} · ${machineName}` : shell
  return title || 'Terminal'
}
