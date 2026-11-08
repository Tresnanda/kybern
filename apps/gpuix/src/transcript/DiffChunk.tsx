// The body of a `diff` / `patch` fence (#294), drawn like the app's own diff rows: removed lines on the removed tint in the
// removed colour, added lines the same in green, `@@` hunk headers muted, context plain. The fence is cut into runs of
// neighbouring lines of one kind (`diffRuns`), so a hundred-line diff is a handful of native `<code>` elements, each with
// soft wrap and selection of its own; the text is the fence's exact source, `+` and `-` included, and Copy reads that source.
import { memo, useMemo } from 'react'
import { useTheme } from '../ui.tsx'
import type { Theme } from '../theme.ts'
import { alpha, cachedCodeTheme, CODE, muted } from './kit.tsx'
import { diffRuns, type DiffKind } from './diffFence.ts'

/** The wash behind a run: the same strength the Markdown theme gives native diffs (`diffAdd`, `diffDel`). */
export function diffTint(t: Theme, kind: DiffKind): string | undefined {
  const strength = t.variant === 'dark' ? 0.16 : 0.12
  return kind === 'add' ? alpha(t.green, strength) : kind === 'del' ? alpha(t.red, strength) : undefined
}

/** The text colour of a run. */
export function diffInk(t: Theme, kind: DiffKind): string | undefined {
  return kind === 'add' ? t.green : kind === 'del' ? t.red : kind === 'hunk' ? muted(t) : undefined
}

const themes = new WeakMap<Theme, Partial<Record<DiffKind, ReturnType<typeof cachedCodeTheme>>>>()
/** One stable code theme per (theme, kind), so memoized native nodes never see a new prop. */
export function diffRunTheme(t: Theme, kind: DiffKind) {
  let byKind = themes.get(t)
  if (!byKind) themes.set(t, (byKind = {}))
  const base = cachedCodeTheme(t)
  const ink = diffInk(t, kind)
  return (byKind[kind] ??= ink ? { ...base, text: ink, codeText: ink } : base)
}

export const DiffChunk = memo(function DiffChunk({ text, wrap, first = true, last = true }: { text: string; wrap: boolean; first?: boolean; last?: boolean }) {
  const t = useTheme()
  const runs = useMemo(() => diffRuns(text.replace(/\n$/, '')), [text])
  return <div testId="code-body" style={{ display: 'flex', flexDirection: 'column', paddingTop: first ? 8 : 0, paddingBottom: last ? 8 : 0, backgroundColor: t.codeSurface, minWidth: 0, borderBottomLeftRadius: last ? CODE.radius : 0, borderBottomRightRadius: last ? CODE.radius : 0, overflow: 'hidden' }}>
    {runs.map((run, i) => {
      const tint = diffTint(t, run.kind)
      // An empty run (a blank line between two changes) keeps its one line of height.
      return <div key={i} testId={`diff-${run.kind}`} style={{ display: 'flex', flexDirection: 'column', paddingLeft: 9.6, paddingRight: 9.6, minWidth: 0, ...(tint ? { backgroundColor: tint } : {}) }}>
        <code softWrap={wrap} code={run.text || ' '} theme={diffRunTheme(t, run.kind)} style={{ minWidth: 0, userSelect: 'text' }} />
      </div>
    })}
  </div>
})
