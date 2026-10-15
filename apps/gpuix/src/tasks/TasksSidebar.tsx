import { useMemo } from 'react'
import { arrangeTaskProjects, countTasks, filterLabel, type TaskFilter } from '@/state/tasksModel'
import { useApp } from '../state.ts'
import { useAddProject } from '../sidebar/rows.tsx'
import { useNav } from '../nav/store.ts'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { TextField, Button } from '../settings/controls.tsx'
import { ink, Label, useTheme } from '../ui.tsx'
import { StatusGlyph } from './Glyphs.tsx'
import { chooseFilter, taskTyping, prefs, quickAdd, setTasks, useTasks } from './store.ts'

export function TasksSidebar() {
  const t = useTheme()
  const addProject = useAddProject()
  const tasks = useTasks((s) => s.tasks)
  const p = useTasks((s) => s.prefs)
  const query = useTasks((s) => s.query)
  const projects = useApp((s) => s.projects)
  const order = useNav((s) => s.projectOrder)
  const counts = useMemo(() => countTasks(Object.values(tasks), Date.now()), [tasks])
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
  ).filter((r) => r.visible)
  const row = (filter: TaskFilter, label: string, count: number, glyph: React.ReactNode) => (
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
      <Label color={t.textTertiary} size={12} style={{ pointerEvents: 'none' }}>
        {String(count)}
      </Label>
    </div>
  )
  return (
    <div testId="tasks-sidebar" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', height: 48, paddingLeft: 16, paddingRight: 10, gap: 8 }}>
        <Label color={t.text} size={15} weight={600} style={{ flexGrow: 1 }}>
          Tasks
        </Label>
        <Button testId="task-new" onClick={() => quickAdd()}>
          +
        </Button>
      </div>
      <div style={{ paddingLeft: 10, paddingRight: 10, paddingBottom: 10 }}>
        <TextField
          testId="task-search"
          onFocus={() => taskTyping(true)}
          onBlur={() => taskTyping(false)}
          label="Search tasks"
          placeholder="Search"
          value={query}
          onChange={(query) => setTasks({ query, openId: null, quick: null })}
          width="100%"
          onKeyDown={(e) => {
            if (e.key === 'escape') setTasks({ query: '' })
          }}
          style={{ height: 28, borderWidth: 0, backgroundColor: ink(t, 0.05) }}
        />
      </div>
      <virtual-list style={{ flexGrow: 1, minHeight: 0, width: '100%' }}>
        {(['all', 'inbox', 'running', 'needs_review', 'done', 'global'] as const).map((filter) => (
          <div key={filter} style={{ paddingLeft: 8, paddingRight: 8, paddingTop: filter === 'global' ? 8 : 0 }}>
            {row(
              filter,
              filterLabel(filter, () => undefined),
              counts[filter],
              filter === 'all' || filter === 'global' ? (
                <Icon source={filter === 'all' ? N.tasks : N.folder} size={14} color={t.textSecondary} />
              ) : (
                <StatusGlyph status={filter} mono />
              ),
            )}
          </div>
        ))}
        <div key="heading" style={{ display: 'flex', height: 42, paddingLeft: 16, paddingRight: 10, alignItems: 'center' }}>
          <div onClick={() => prefs({ projectsCollapsed: !p.projectsCollapsed })} style={{ flexGrow: 1, cursor: 'pointer' }}>
            <Label color={t.textTertiary} size={12} style={{ pointerEvents: 'none' }}>
              {p.projectsCollapsed ? 'Projects ›' : 'Projects ⌄'}
            </Label>
          </div>
          <Button
            testId="task-add-project"
            onClick={() => {
              void addProject()
            }}
          >
            +
          </Button>
        </div>
        {rows.map(({ project, pinned }) => (
          <div key={project.id} style={{ display: 'flex', paddingLeft: 8, paddingRight: 8 }}>
            <div style={{ flexGrow: 1, minWidth: 0 }}>
              {row(
                `project:${project.id}`,
                project.name,
                counts.projects[project.id] ?? 0,
                <Icon source={N.folder} size={14} color={t.textSecondary} />,
              )}
            </div>
            <Menu
              testId={`task-project-menu-${project.id}`}
              trigger={() => (
                <div style={{ padding: 6, pointerEvents: 'none' }}>
                  <Label color={t.textTertiary} size={12}>
                    {pinned ? '⌖' : '⋯'}
                  </Label>
                </div>
              )}
            >
              <MenuItem
                id="pin"
                label={pinned ? 'Unpin' : 'Pin'}
                onSelect={() =>
                  prefs({ pinnedProjects: pinned ? p.pinnedProjects.filter((id) => id !== project.id) : [...p.pinnedProjects, project.id] })
                }
              />
            </Menu>
          </div>
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
    </div>
  )
}
