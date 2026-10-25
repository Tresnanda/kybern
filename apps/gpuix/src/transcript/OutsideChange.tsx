// After a turn of a group worktree chat, a repository left out of the worktree changed in the user's own checkout
// (`outside_repo_changed`, L3 §8.5). A quiet warning row under the turn names it; Open shows that checkout. Kybern never
// reverts it: the row only says what happened.
import { GROUP_COPY, outsideChangeText } from '../../../../packages/kybern-client/src/groups.ts'
import type { OutsideRepoChange } from '../../../../packages/kybern-client/src/types.ts'
import { Button } from '../kit/Button.tsx'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { Label, useTheme } from '../ui.tsx'
import { openManyQuietly } from '../platform/os.ts'

export function OutsideChange({ repos }: { repos: OutsideRepoChange[] }) {
  const t = useTheme()
  const local = activeEnvironment().local
  const open = () => {
    const paths = repos.map((r) => r.source_path).filter(Boolean)
    if (local && paths.length) openManyQuietly(paths)
  }
  return (
    <div testId="outside-change" role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, minHeight: 28 }}>
      <Icon source={N.alert} size={14} color={t.warning} />
      <Label color={t.textSecondary} size={13} lineHeight={19} style={{ flexShrink: 1, minWidth: 0 }}>{outsideChangeText(repos.map((r) => r.name))}</Label>
      {local && <Button testId="outside-change-open" variant="ghost" size="sm" onClick={open}>{GROUP_COPY.outsideChangeOpen}</Button>}
    </div>
  )
}
