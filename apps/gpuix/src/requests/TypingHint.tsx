// The hint above the composer while a card waits for the reader to stop typing (`typingGuard.ts`): one calm line, "Claude has a
// question · it opens when you pause". A click opens the card now; so does Esc in the composer, except for a password or a
// secret, which open on the pause or a click only. Sits in the same stacked panel the card would, so the card replaces it in place.
import type { ApprovalRequest } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { Kbd } from '../kit/Kbd.tsx'
import { Label } from '../ui.tsx'
import { useCardTokens } from './Card.tsx'
import { RG } from './glyphs.ts'
import { holdTitle, isSensitiveCard, releaseCard } from './typingGuard.ts'

export function TypingHint({ approval, provider }: { approval: ApprovalRequest; provider: string | undefined }) {
  const k = useCardTokens()
  const title = holdTitle(approval, provider)
  const open = () => releaseCard(approval.id)
  return (
    <div testId="typing-hint" role="button" aria-label={`${title}. Open now`} tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') open() }}
      style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, marginLeft: 6, marginRight: 6, marginTop: 4, marginBottom: 2, paddingLeft: 10, paddingRight: 8, borderRadius: 10, cursor: 'pointer', minWidth: 0, hover: { backgroundColor: k.hover } }}>
      <Icon source={RG.clock} size={14} color={k.t.textTertiary} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden' }}>
        <Label color={k.t.textSecondary} size={12.5} lineHeight={18} weight={500} truncate>{title}</Label>
        <Label color={k.t.textTertiary} size={12.5} lineHeight={18} truncate>{'· it opens when you pause'}</Label>
      </div>
      {!isSensitiveCard(approval) && <Kbd keys={['esc']} />}
    </div>
  )
}
