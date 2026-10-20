// "Hand off to another agent" (`views/Handoff.tsx`): pick an installed agent and
// start a new thread in the same project, seeded with the conversation so far.
import { useState } from 'react'
import { Icon } from '../icons.tsx'
import { MatrixLoader } from '../MatrixLoader.tsx'
import { useApp } from '../state.ts'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { revealTransform, SwapOnChange } from '../motion/kit.tsx'
import { errorText, handOff } from './actions.ts'
import { N } from './glyphs.ts'
import { Dialog, DialogHeader, muted } from './overlay.tsx'
import { setNav, useNav } from './store.ts'

/** The target row's trailing slot: the arrow fades in with a 4px slide on hover and out over 100 ms (`t-reveal`); the loader swaps in for it when the hand-off starts (`IconSwap`). */
export function HandoffTrailing({ busy, hover }: { busy: boolean; hover: boolean }) {
  const t = useTheme()
  return (
    <SwapOnChange kind="icon" active={busy ? 'busy' : 'idle'} style={{ width: 16, height: 16, flexShrink: 0 }}>
      {busy ? <MatrixLoader /> : (
        <div paintTransform={revealTransform(hover)} style={{ display: 'flex' }}>
          <Icon source={N.arrowRight} size={14} color={muted(t, 1)} />
        </div>
      )}
    </SwapOnChange>
  )
}

export function HandoffDialog() {
  const handoff = useNav((s) => s.handoff)
  if (!handoff) return null
  return <HandoffBody threadId={handoff.threadId} target={handoff.target} />
}

function HandoffBody({ threadId, target }: { threadId: string; target: string | null }) {
  const t = useTheme()
  const providers = useNav((s) => s.providers)
  const thread = useNav((s) => s.children[threadId])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const listed = useApp((s) => s.threads.find((x) => x.id === threadId))
  const kind = (thread ?? listed)?.provider.kind
  const choices = providers.filter((p) => p.available && p.kind !== kind)
  const close = () => setNav({ handoff: null })
  return (
    <Dialog onClose={close} width={448} testId="handoff-dialog">
      <DialogHeader
        title="Hand off to another agent"
        description="Starts a new thread in the same project. The new agent gets the conversation so far and continues from there."
        onClose={close}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 16, paddingRight: 16, paddingTop: 4, paddingBottom: 20 }}>
        {choices.length === 0 && <Label color={muted(t, 1)}>No other agent is installed in this environment.</Label>}
        {choices.map((p) => {
          const model = p.models?.find((m) => m.is_default) ?? p.models?.[0]
          const lit = busy === p.kind || target === p.kind || hover === p.kind
          return (
            <div
              key={p.kind}
              testId={`handoff-${p.kind}`}
              onMouseEnter={() => setHover(p.kind)}
              onMouseLeave={() => setHover((h) => (h === p.kind ? null : h))}
              onClick={async () => {
                if (busy) return
                setBusy(p.kind)
                setError(null)
                try {
                  await handOff(threadId, { kind: p.kind, instance: 'default' }, model?.id)
                  close()
                } catch (e) {
                  setError(`Unable to hand off. ${errorText(e)}`)
                } finally {
                  setBusy(null)
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                paddingLeft: 10,
                paddingRight: 10,
                paddingTop: 6,
                paddingBottom: 6,
                borderRadius: 10,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy && busy !== p.kind ? 0.5 : 1,
                ...(lit ? { backgroundColor: t.buttonSecondaryHover } : {}),
              }}
            >
              <ProviderMark kind={p.kind} size={16} />
              <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
                <Label color={t.text} truncate>
                  {p.display_name}
                </Label>
                {model && (
                  <Label color={muted(t, 1)} size={13} truncate>
                    {model.display_name}
                  </Label>
                )}
              </div>
              <HandoffTrailing busy={busy === p.kind} hover={hover === p.kind} />
            </div>
          )
        })}
        {error && (
          <Label color={t.red} size={13}>
            {error}
          </Label>
        )}
      </div>
    </Dialog>
  )
}
