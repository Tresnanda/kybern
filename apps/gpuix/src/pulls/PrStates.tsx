import { classifyPrError } from '@/state/prReviewModel'
import { Skeleton } from '../kit/Skeleton.tsx'
import { DURATION, EASE } from '../motion/tokens.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { Label, useTheme } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { column, row } from '../usage/controls.tsx'
import { openQuietly, osLabels, writeClipboardText } from '../platform/os.ts'
export function openUrl(url: string) { if (/^https?:\/\//i.test(url)) openQuietly(url) }
export function copy(text: string) { void writeClipboardText(text).catch(() => {}) }
/** `partial`: other pull requests did load, so `error` (one line per project or repository) is shown as it is. */
export function Problem({ error, refresh, partial = false }: { error: string; refresh: () => void; partial?: boolean }) {
  const t = useTheme()
  if (partial) return <div role="alert" style={{ ...column, gap: 8 }}><Label color={t.text} size={14} weight={500}>Some pull requests didn’t load</Label><Label color={t.textSecondary} size={13} lineHeight={20}>{error}</Label><div style={row}><Button size="sm" onClick={refresh}>Try again</Button></div></div>
  const kind = classifyPrError(error); const missing = kind === 'gh-missing'; const auth = kind === 'gh-auth'
  return <div role="alert" style={{ ...column, gap: 12 }}><Label color={t.text} size={16} weight={500}>{missing ? 'Install the GitHub CLI' : auth ? 'Sign in to the GitHub CLI' : 'Unable to load pull requests'}</Label><Label color={t.textSecondary} size={13} lineHeight={20}>{missing ? `Kybern reads pull requests through gh ${osLabels().onThisComputer}. Install it, sign in with gh auth login, then refresh.` : auth ? 'Run gh auth login in a terminal, then refresh.' : error}</Label><div style={{ ...row, gap: 8 }}>{(missing || auth) && <Button variant="primary" onClick={() => missing ? openUrl('https://cli.github.com') : copy('gh auth login')}>{missing ? 'Open install guide' : 'Copy command'}</Button>}<Button variant={missing || auth ? 'secondary' : 'primary'} onClick={refresh}>{missing || auth ? 'Refresh' : 'Try again'}</Button></div></div>
}

/**
 * Loading state of a pull request surface: skeleton rows that fade in after 150 ms (a fast answer never flashes them; the delay
 * is the fade's own `delay`, no timer). `list` draws pull request rows, `page` a heading, a meta line and paragraph lines.
 */
export function PrLoading({ label, kind = 'page', rows = 4 }: { label: string; kind?: 'list' | 'page'; rows?: number }) {
  const fade = PATCHED_NATIVE ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { delay: 0.15, duration: DURATION.quick, ease: [...EASE.out] as [number, number, number, number] } } : undefined
  const widths = ['100%', '92%', '97%', '64%', '88%'] as const
  return (
    <div role="status" aria-label={label} testId="pr-loading" paintTransform={fade} style={{ ...column, gap: kind === 'list' ? 14 : 12, width: '100%' }}>
      {kind === 'list'
        ? Array.from({ length: rows }, (_, i) => <div key={i} style={{ ...column, gap: 8 }}><Skeleton width={i % 2 ? '58%' : '78%'} height={14} /><Skeleton width="44%" height={11} /></div>)
        : <>
          <Skeleton width={96} height={24} radius={12} />
          <Skeleton width="62%" height={26} />
          <Skeleton width="38%" height={14} />
          <div style={{ ...column, gap: 9, paddingTop: 8 }}>{Array.from({ length: rows }, (_, i) => <Skeleton key={i} width={widths[i % widths.length]} height={13} />)}</div>
        </>}
    </div>
  )
}
