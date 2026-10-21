// "Move to space" in a project's context menu (`docs/specs/spaces.md` §7.9): one row per other
// space, then "New space…", which creates one anchored to the rail's "+" and moves the project in.
import { SPACE_COPY } from '../../../../packages/kybern-client/src/spaces.ts'
import type { Project } from '../../../../packages/kybern-client/src/types.ts'
import { N } from '../nav/glyphs.ts'
import { MenuItem, MenuSeparator, MenuSub } from '../nav/overlay.tsx'
import { SpaceLogo } from './SpaceLogo.tsx'
import { moveProjectToSpace, useSpaces } from './store.ts'
import { openSpaceEditor } from './ui.ts'

export function MoveToSpaceMenu({ project }: { project: Pick<Project, 'id' | 'name' | 'space_id'> }) {
  const supported = useSpaces((s) => s.supported === true)
  const spaces = useSpaces((s) => s.spaces)
  if (!supported) return null
  return (
    <MenuSub id="space" icon={N.arrowRight} label={SPACE_COPY.moveToSpace} testId="project-menu-space">
      {spaces.filter((space) => space.id !== project.space_id).map((space) => (
        <MenuItem
          key={space.id}
          id={`space:${space.id}`}
          testId={`move-to-space-${space.id}`}
          iconNode={<SpaceLogo space={space} size={16} />}
          label={space.name}
          onSelect={() => void moveProjectToSpace(project, space)}
        />
      ))}
      {spaces.length > 1 && <MenuSeparator />}
      <MenuItem id="space-new" testId="move-to-new-space" icon={N.plus} label={SPACE_COPY.newSpaceMenu} onSelect={() => openSpaceEditor({ anchor: 'plus', mode: 'create', moveProject: { id: project.id, name: project.name } })} />
    </MenuSub>
  )
}
