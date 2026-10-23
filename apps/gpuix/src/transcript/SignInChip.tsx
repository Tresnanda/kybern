// "Sign in to GitHub" at the trailing edge of a finished tool row whose output says the CLI is signed out (`loginRecipes.ts`). The
// daemon has no user-started sign-in card, so a click queues a message asking the agent to raise `kybern_request_login` and retry.
// One chip per CLI and turn (the latest failure), worked out once per turn in `Turn.tsx`.
import { useState, useSyncExternalStore } from 'react'
import { signInRequestMessage, type LoginRecipe } from '../../../../packages/kybern-client/src/loginRecipes.ts'
import { sendToThread } from '../composer/store.ts'
import { HoverCard } from '../kit/HoverCard.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'
import { DURATION, EASE } from '../motion/kit.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { agentName } from '../requests/model.ts'
import { threadProvider } from '../requests/actions.ts'
import { serviceMark } from '../requests/glyphs.ts'
import { CodeText } from '../requests/summoned.tsx'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { reportError } from './store.ts'

/** Rows whose chip was used, for this window's life: the chip then says what it did. */
const asked = new Set<string>()
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

const EASE_OUT = [...EASE.out] as [number, number, number, number]

export function SignInChip({ callId, threadId, recipe }: { callId: string; threadId: string; recipe: LoginRecipe }) {
  const t = useTheme()
  const done = useSyncExternalStore(subscribe, () => asked.has(callId))
  const [busy, setBusy] = useState(false)
  // `t-chip-appear`: opacity and a 0.96 scale at the chip, decided on mount (a row scrolled back into view does not replay it).
  const [enter] = useState(() => !PATCHED_NATIVE ? undefined : REDUCED_MOTION
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease: EASE_OUT } }
    : { initial: { opacity: 0, scale: 0.96 }, animate: { opacity: 1, scale: 1 }, transition: { duration: DURATION.quick, ease: EASE_OUT } })
  const agent = agentName(threadProvider(threadId))
  const Agent = agent.charAt(0).toUpperCase() + agent.slice(1)
  const ask = async () => {
    if (busy || done) return
    setBusy(true)
    try {
      await sendToThread(threadId, { parts: [{ type: 'text', text: signInRequestMessage(recipe) }] }, 'queue')
      asked.add(callId)
      for (const l of listeners) l()
    } catch (e) { reportError(`Unable to ask ${agent} to sign in. Try again`, e) } finally { setBusy(false) }
  }
  const chip = (
    <div paintTransform={enter} style={{ display: 'flex', flexShrink: 0 }}>
      <PickerChip size="sm" selected={!done} chevron={false} icon={serviceMark(recipe.cli)} disabled={busy || done} onClick={() => void ask()} testId={`sign-in-chip-${callId}`} label={done ? `Asked ${Agent} to sign in to ${recipe.service}` : `Sign in to ${recipe.service}`}>
        {done ? `Asked ${Agent} to sign in` : `Sign in to ${recipe.service}`}
      </PickerChip>
    </div>
  )
  return (
    <HoverCard width={290} side="bottom" align="end" testId={`sign-in-chip-card-${callId}`} trigger={chip}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Label color={t.text} size={13} lineHeight={18} weight={600}>{`Sign in to ${recipe.service}`}</Label>
        <CodeText text={`Asks ${Agent} to open the sign-in card for the \`${recipe.cli}\` CLI, then retry what failed.`} />
      </div>
    </HoverCard>
  )
}
