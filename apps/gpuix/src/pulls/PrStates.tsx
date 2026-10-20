import { spawn } from 'node:child_process'
import { classifyPrError } from '@/state/prReviewModel'
import { Label, useTheme } from '../ui.tsx'
import { Button, column, row } from '../usage/controls.tsx'
export function openUrl(url: string) { if (/^https?:\/\//i.test(url)) { const child = spawn('open', [url], { stdio: 'ignore' }); child.on('error', () => {}); child.unref() } }
export function copy(text: string) { const child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] }); child.on('error', () => {}); child.stdin.end(text) }
export function Problem({ error, refresh }: { error: string; refresh: () => void }) {
  const t = useTheme(); const kind = classifyPrError(error); const missing = kind === 'gh-missing'; const auth = kind === 'gh-auth'
  return <div role="alert" style={{ ...column, gap: 12 }}><Label color={t.text} size={16} weight={500}>{missing ? 'Install the GitHub CLI' : auth ? 'Sign in to the GitHub CLI' : 'Unable to load pull requests'}</Label><Label color={t.textSecondary} size={13} lineHeight={20}>{missing ? 'Kybern reads pull requests through gh on this Mac. Install it, sign in with gh auth login, then refresh.' : auth ? 'Run gh auth login in a terminal, then refresh.' : error}</Label><div style={row}>{(missing || auth) && <Button onClick={() => missing ? openUrl('https://cli.github.com') : copy('gh auth login')}>{missing ? 'Open install guide' : 'Copy command'}</Button>}<Button onClick={refresh}>{missing || auth ? 'Refresh' : 'Try again'}</Button></div></div>
}
