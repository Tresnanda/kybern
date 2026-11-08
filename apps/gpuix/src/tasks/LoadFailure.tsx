// The All tasks page's first-load failure (#299): the empty-state layout with a title, one sentence and "Try again".
// It replaces the "Loading tasks…" label; the two are never on the page together.
import { useState } from 'react'
import { Button } from '../kit/Button.tsx'
import { Label, useTheme } from '../ui.tsx'
import { loadFailureCopy } from './loadFailure.ts'

export function LoadFailure({ error, retry }: { error: unknown; retry: () => Promise<void> }) {
  const t = useTheme()
  const [trying, setTrying] = useState(false)
  const copy = loadFailureCopy(error)
  const tryAgain = () => {
    setTrying(true)
    void retry().finally(() => setTrying(false))
  }
  return (
    <div testId="tasks-load-failure" style={{ display: 'flex', flexGrow: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, padding: 32 }}>
      <Label color={t.text} size={17} lineHeight={22} weight={500}>{copy.title}</Label>
      <Label color={t.textTertiary} size={13} lineHeight={19} style={{ maxWidth: 340, textAlign: 'center' }}>{copy.description}</Label>
      <Button testId="tasks-load-retry" busy={trying} onClick={tryAgain}>Try again</Button>
    </div>
  )
}
