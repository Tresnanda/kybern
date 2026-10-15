// The home screen (`views/Draft.tsx`): the mark and "What should we do in
// {Project}?" centred (the project name is a menu with a dotted underline),
// then the composer with the landing tray docked on it. Sending starts a
// thread in the chosen project, workspace, branch, mode and model.
//
// Motion: the desktop's `t-stagger` entrance (`views/Draft.tsx:112,150`): the
// mark, the heading and the composer block rise 12px over 500 ms, 70 ms apart.
// Like the desktop it plays once per mount, never on the launch mount; unlike
// it, a mount from a keyboard shortcut (⌘N, ⌘[ / ⌘]) appears settled.
import { useState } from 'react'
import { Composer, useDraftTarget } from './Composer.tsx'
import { Icon } from './icons.tsx'
import { useApp } from './state.ts'
import { COLUMN, GUTTER } from './Transcript.tsx'
import { ink, Label, LOGO_SVG, useTheme } from './ui.tsx'
import { G } from './composer/glyphs.ts'
import { PickerItem, PickerMenu } from './composer/Menu.tsx'
import { patchDraft } from './composer/store.ts'
import { LandingTray } from './composer/Tray.tsx'
import { Rise } from './motion/kit.tsx'
import { addWindowKeyHandler } from './nav/keys.ts'

/** The last window key press (`performance.now()`); never consumes the event. */
let lastKeyAt = -Infinity
addWindowKeyHandler(() => {
  lastKeyAt = performance.now()
  return false
})
let mounts = 0
/** Read once per mount, like the desktop's `useState(() => !isLaunching())`. */
function shouldEnter(): boolean {
  const launch = mounts++ === 0
  return !launch && performance.now() - lastKeyAt > 400
}

export function Draft() {
  const t = useTheme()
  const projects = useApp((s) => s.projects)
  const { projectId, project, useWorktree } = useDraftTarget()
  const list = [...projects].sort((a, b) => a.name.localeCompare(b.name))
  const heading = ink(t, 0.95)
  const [enter] = useState(shouldEnter)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, paddingLeft: GUTTER, paddingRight: GUTTER }}>
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, width: '100%', maxWidth: COLUMN, paddingLeft: 24, paddingRight: 24 }}>
          <Rise kind="stagger" index={0} play={enter} style={{ alignItems: 'center' }}>
            <div style={{ display: 'flex', width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}>
              <svg source={LOGO_SVG} style={{ width: 40, height: 25, color: t.text }} />
            </div>
          </Rise>
          <Rise kind="stagger" index={1} play={enter} style={{ flexDirection: 'row', alignSelf: 'stretch', alignItems: 'baseline', flexWrap: 'wrap', justifyContent: 'center' }}>
            <Label color={heading} size={30} lineHeight={34.5}>
              {project ? 'What should we do in ' : 'What can I help with?'}
            </Label>
            {project && (
              <>
                <PickerMenu
                  testId="heading-project"
                  side="bottom"
                  align="center"
                  minWidth={224}
                  trigger={() => <HeadingProject name={project.name} />}
                >
                  {list.map((p) => (
                    <PickerItem key={p.id} id={p.id} onSelect={() => patchDraft({ projectId: p.id, worktree: null, baseBranch: null })}>
                      <Icon name="folder" size={18} color={t.text} style={{ opacity: 0.8 }} />
                      <Label color={t.text} truncate style={{ flexGrow: 1 }}>
                        {p.name}
                      </Label>
                      {p.id === projectId && <Icon source={G.checkBold} size={14} color={t.text} />}
                    </PickerItem>
                  ))}
                </PickerMenu>
                <Label color={heading} size={30} lineHeight={34.5}>
                  ?
                </Label>
              </>
            )}
          </Rise>
        </div>
      </div>
      <Rise kind="stagger" index={2} play={enter} style={{ flexDirection: 'row', justifyContent: 'center', paddingBottom: 16 }}>
        <Composer thread={null} tray={<LandingTray projectId={projectId} useWorktree={useWorktree} />} />
      </Rise>
    </div>
  )
}

/** The project name as a menu trigger: dotted 1.5px underline 6px below, 70% ink on hover. */
function HeadingProject({ name }: { name: string }) {
  const t = useTheme()
  return (
    <div style={{ position: 'relative', cursor: 'pointer', display: 'flex' }}>
      <Label color={ink(t, 0.95)} size={30} lineHeight={34.5}>
        {name}
      </Label>
      <DottedRule color={ink(t, 0.4)} chars={name.length} />
    </div>
  )
}

/** A 1.5px dotted underline, 6px below the baseline. */
function DottedRule({ color, chars }: { color: string; chars: number }) {
  // One node per dot, so draw only as many as the 30px name needs.
  const dots = Math.ceil((chars * 17) / 3.5)
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: -4, height: 1.5, display: 'flex', gap: 2, overflow: 'hidden', pointerEvents: 'none' }}>
      {Array.from({ length: dots }, (_, i) => (
        <div key={i} style={{ width: 1.5, height: 1.5, borderRadius: 0.75, backgroundColor: color, flexShrink: 0 }} />
      ))}
    </div>
  )
}
