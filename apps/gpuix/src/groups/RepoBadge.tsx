// The quiet "N repos" badge after a group project's name in the thread panel (L3 sheet 4): 18 tall, a capsule of ink at
// 6% (8% on a hovered or selected row), 11/500 secondary text. It never truncates; the name does. A member missing on disk
// adds a warning dot before the count. Hovering it for 500 ms opens a card naming the folder, every member and its
// branch (the kit hover card: scale 0.98 → 1 from the badge, instant when another card was just open).
import { useEffect } from 'react'
import { memberMissingLabel, repoBadge, repoBadgeTooltip } from '../../../../packages/kybern-client/src/groups.ts'
import type { Project } from '../../../../packages/kybern-client/src/types.ts'
import { HoverCard } from '../kit/HoverCard.tsx'
import { useControls } from '../kit/controls.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { Label, useTheme } from '../ui.tsx'
import { tildify } from './model.ts'
import { loadMemberStatus, useMemberStatus } from './store.ts'
import { homedir } from 'node:os'

export function RepoBadge({ project, emphasized }: { project: Project; emphasized: boolean }) {
  const t = useTheme()
  const c = useControls()
  const members = project.members ?? []
  const missing = members.some((m) => m.status !== 'ok')
  return (
    <HoverCard
      delay={500}
      side="bottom"
      align="start"
      sideOffset={6}
      width={232}
      testId={`project-badge-card-${project.id}`}
      rootStyle={{ flexShrink: 0 }}
      style={{ padding: 10, borderRadius: 12 }}
      trigger={
        <div testId={`project-badge-${project.id}`} style={{ display: 'flex', alignItems: 'center', gap: 4, height: 18, paddingLeft: 6, paddingRight: 6, borderRadius: 9, flexShrink: 0, backgroundColor: c.ink(emphasized ? 0.08 : 0.06) }}>
          {missing && <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.warning }} />}
          <Label color={t.textSecondary} size={11} lineHeight={14} weight={500}>{repoBadge(members.length)}</Label>
        </div>
      }
    >
      <BadgeCard project={project} />
    </HoverCard>
  )
}

function BadgeCard({ project }: { project: Project }) {
  const t = useTheme()
  const status = useMemberStatus(project.id)
  useEffect(() => { void loadMemberStatus(project.id) }, [project.id])
  const members = project.members ?? []
  const folder = activeEnvironment().local ? tildify(project.path, homedir()) : project.path
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Label color={t.text} size={12} lineHeight={16} weight={500}>{repoBadgeTooltip(members.length, folder)}</Label>
      {members.map((member) => {
        const state = status?.members.find((m) => m.path === member.path)
        const gone = (state?.status ?? member.status) !== 'ok'
        const detail = gone ? memberMissingLabel(folder) : state?.branch
        return (
          <Label key={member.path} color={gone ? t.warning : t.textSecondary} size={12} lineHeight={16} truncate>
            {detail ? `${member.name} · ${detail}` : member.name}
          </Label>
        )
      })}
    </div>
  )
}
