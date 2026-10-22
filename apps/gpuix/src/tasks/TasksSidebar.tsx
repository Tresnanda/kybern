import { useMemo, useState } from 'react'
import { arrangeTaskProjects, countTasks, filterLabel, type TaskFilter } from '@/state/tasksModel'
import { useApp } from '../state.ts'
import { inSpace } from '../../../../packages/kybern-client/src/spaces.ts'
import { useCurrentSpaceId, useSpaceProjects } from '../spaces/current.ts'
import { useAddProject } from '../sidebar/rows.tsx'
import { useNav } from '../nav/store.ts'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { IconButton } from '../kit/IconButton.tsx'
import { SearchField } from '../kit/SearchField.tsx'
import { ContextMenu, MenuItem, Tip } from '../nav/overlay.tsx'
import { ProjectDot } from '../notes/kit.tsx'
import { ink, Label, useTheme } from '../ui.tsx'
import { StatusGlyph } from './Glyphs.tsx'
import { chooseFilter, taskTyping, prefs, quickAdd, setTasks, useTasks } from './store.ts'
import { pressTransform } from '../motion/press.ts'
import { Chevron } from '../motion/Chevron.tsx'
import { motion } from '@gpuix/react'
import { DISCLOSURE, EASE } from '../motion/tokens.ts'
import { REDUCED_MOTION } from '../ui.tsx'
import { CountPop } from './CountPop.tsx'

export function TasksSidebar() {
  const t = useTheme()
  const addProject = useAddProject()
  const tasks = useTasks((s) => s.tasks)
  const p = useTasks((s) => s.prefs)
  const query = useTasks((s) => s.query)
  const projects = useSpaceProjects()
  const everyProject = useApp((s) => s.projects)
  const spaceId = useCurrentSpaceId()
  const order = useNav((s) => s.projectOrder)
  const [hover, setHover] = useState(false)
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number } } | null>(null)
  const counts = useMemo(() => countTasks(Object.values(tasks).filter((task) => inSpace(task.project_id, everyProject, spaceId)), Date.now()), [tasks, everyProject, spaceId])
  const sorted = useMemo(
    () =>
      [...projects]
        .filter((v) => v.id !== '00000000-0000-0000-0000-000000000000')
        .sort((a, b) => {
          const ai = order.indexOf(a.id),
            bi = order.indexOf(b.id)
          return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || a.name.localeCompare(b.name)
        }),
    [projects, order],
  )
  const rows = arrangeTaskProjects(
    sorted,
    p.pinnedProjects,
    p.projectsCollapsed,
    p.filter.startsWith('project:') ? p.filter.slice(8) : null,
  )
  const row = (filter: TaskFilter, label: string, count: number, glyph: React.ReactNode, trailing?: React.ReactNode) => (
    <div
      testId={`task-filter-${filter}`}
      onClick={() => chooseFilter(filter)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        height: 30,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 7,
        cursor: 'pointer',
        backgroundColor: p.filter === filter ? ink(t, 0.075) : 'transparent',
        hover: { backgroundColor: ink(t, 0.04) },
      }}
    >
      <div style={{ width: 16, pointerEvents: 'none' }}>{glyph}</div>
      <Label color={t.text} size={13} truncate style={{ flexGrow: 1, pointerEvents: 'none' }}>
        {label}
      </Label>
      {trailing}
      <CountPop value={count} color={t.textTertiary} size={12} style={{ pointerEvents: 'none' }} />
    </div>
  )
  return (
    <div testId="tasks-sidebar" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', height: 48, paddingLeft: 16, paddingRight: 10, gap: 8 }}>
        <Label color={t.text} size={15} weight={600} style={{ flexGrow: 1 }}>
          Tasks
        </Label>
        <Tip label="New task · C" side="bottom">
          <div style={{ display: 'flex', flexShrink: 0 }}><IconButton testId="task-new" icon={N.newThread} label="New task" glyph={16} onClick={() => quickAdd()} /></div>
        </Tip>
      </div>
      <div style={{ paddingLeft: 10, paddingRight: 10, paddingBottom: 10 }}>
        <SearchField
          testId="task-search"
          label="Search tasks"
          placeholder="Search"
          width="100%"
          value={query}
          onFocus={() => taskTyping(true)}
          onBlur={() => taskTyping(false)}
          onChange={(value) => setTasks({ query: value, openId: null, quick: null })}
          onKeyDown={(e) => {
            if (e.key === 'escape') setTasks({ query: '' })
          }}
        />
      </div>
      <virtual-list style={{ flexGrow: 1, minHeight: 0, width: '100%' }}>
        {(['all', 'inbox', 'running', 'needs_review', 'done', 'global'] as const).map((filter) => (
          <div key={filter} style={{ paddingLeft: 8, paddingRight: 8, paddingTop: filter === 'global' ? 8 : 0 }}>
            {row(
              filter,
              filterLabel(filter, () => undefined),
              counts[filter],
              filter === 'all' ? (
                <Icon source={N.tasks} size={16} color={t.textSecondary} />
              ) : filter === 'global' ? (
                <div style={{ display: 'flex', justifyContent: 'center' }}><ProjectDot projectId={null} /></div>
              ) : (
                <StatusGlyph status={filter} mono />
              ),
            )}
          </div>
        ))}
        <div key="heading" style={{ display: 'flex', height: 42, paddingLeft: 16, paddingRight: 10, paddingBottom: 6, alignItems: 'flex-end' }}>
          {/* `.tk-nav-disclose`: scale 0.96 on press over `--duration-quick` both ways. */}
          <div testId="task-projects-toggle" onClick={() => prefs({ projectsCollapsed: !p.projectsCollapsed })} paintTransform={pressTransform(true, 0.96, 0.15, 0.15)} style={{ display: 'flex', alignItems: 'center', gap: 4, height: 20, marginLeft: -4, paddingLeft: 4, paddingRight: 4, cursor: 'pointer' }}>
            <Label color={t.textTertiary} size={12} lineHeight={18} weight={500} style={{ pointerEvents: 'none' }}>Projects</Label>
            <Chevron open={!p.projectsCollapsed} size={12} color={t.textTertiary} />
          </div>
          <div style={{ flexGrow: 1 }} />
          <Tip label="Add project" side="right">
            <div style={{ display: 'flex', marginRight: -4, marginBottom: -3, opacity: hover || !rows.some((r) => r.visible) ? 1 : 0 }}><IconButton testId="task-add-project" size="sm" icon={N.plus} label="Add project" onClick={() => { void addProject() }} /></div>
          </Tip>
        </div>
        {rows.map(({ project, pinned, visible }) => (
          // Pinned and current projects stay; the rest fold away with the heading's chevron (height + opacity, 220 ms; the rows are one
          // known height, so no measuring pass is needed and a folded row stays mounted at height 0).
          <motion.div key={project.id} initial={false} animate={{ height: visible ? 30 : 0, opacity: visible ? 1 : 0 }} transition={{ duration: REDUCED_MOTION ? 0 : visible ? DISCLOSURE : 0.18, ease: [...EASE.out] }} style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}><div style={{ display: 'flex', paddingLeft: 8, paddingRight: 8 }}>
            <div style={{ flexGrow: 1, minWidth: 0 }} onAuxClick={(e) => { if (e.isRightClick || e.button === 2) setMenu({ id: project.id, at: { x: e.x ?? 0, y: e.y ?? 0 } }) }}>
              {row(
                `project:${project.id}`,
                project.name,
                counts.projects[project.id] ?? 0,
                <div style={{ display: 'flex', justifyContent: 'center' }}><ProjectDot projectId={project.id} /></div>,
                pinned ? <Icon source={N.pin} size={12} color={ink(t, 0.28)} style={{ marginRight: -3 }} /> : undefined,
              )}
            </div>
          </div></motion.div>
        ))}
      </virtual-list>
      {(counts.running > 0 || counts.needs_review > 0) && (
        <div
          onClick={() => chooseFilter(counts.running ? 'running' : 'needs_review')}
          style={{ display: 'flex', gap: 10, padding: 16, cursor: 'pointer' }}
        >
          <StatusGlyph status={counts.running ? 'running' : 'needs_review'} />
          <Label color={t.textSecondary} size={13} style={{ pointerEvents: 'none' }}>
            {counts.running
              ? `${counts.running} ${counts.running === 1 ? 'agent' : 'agents'} running`
              : `${counts.needs_review} waiting for review`}
          </Label>
        </div>
      )}
      {menu && (
        <ContextMenu at={menu.at} onClose={() => setMenu(null)} testId="task-project-menu" width={176}>
          {(() => {
            const pinned = p.pinnedProjects.includes(menu.id)
            return <MenuItem id="pin" icon={N.pin} label={pinned ? 'Unpin' : 'Pin'} onSelect={() => prefs({ pinnedProjects: pinned ? p.pinnedProjects.filter((id) => id !== menu.id) : [...p.pinnedProjects, menu.id] })} />
          })()}
        </ContextMenu>
      )}
    </div>
  )
}
