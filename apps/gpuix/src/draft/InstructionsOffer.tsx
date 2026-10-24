// "Add shared instructions for this group?" (L3 sheet 7): on a group project's new chat page, above the tray, when the
// group folder lacks AGENTS.md or CLAUDE.md. Non-modal: the composer stays usable, and nothing is written until "Create
// files" (never automatic, never overwriting). "Not now" and × hide it for this project (`instructions_offer_dismissed`);
// the Repositories dialog keeps its own row. Preview shows the exact files. After creating, the card becomes a one-line
// confirmation that leaves by itself after 6 s.
//
// Motion: the preview opens with the disclosure height tween (tier 2, 220 ms) and Reduce Motion makes it instant; the
// card's content swaps to the confirmation with the kit `Swap` cross-fade; dismissing fades the card up 4 px (150 ms)
// while its height closes, so the composer below slides up instead of jumping.
import { useEffect, useState } from 'react'
import {
  GROUP_COPY,
  instructionsCreatedText,
  instructionsOfferBody,
  instructionsPreview,
  isGroupProject,
} from '../../../../packages/kybern-client/src/groups.ts'
import type { Project } from '../../../../packages/kybern-client/src/types.ts'
import { spawn } from 'node:child_process'
import { Button } from '../kit/Button.tsx'
import { RADIUS, useControls } from '../kit/controls.ts'
import { IconButton } from '../kit/IconButton.tsx'
import { folderName } from '../groups/model.ts'
import { loadMemberStatus, updateGroup, useMemberStatus } from '../groups/store.ts'
import { Icon } from '../icons.tsx'
import { Collapse, Swap } from '../motion/kit.tsx'
import { EXIT, Presence } from '../motion/Presence.tsx'
import { errorText } from '../nav/actions.ts'
import { N } from '../nav/glyphs.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { getClient } from '../state.ts'
import { FONT_MONO } from '../theme.ts'
import { Label, useTheme } from '../ui.tsx'

const AUTO_DISMISS_MS = 6000

/** Which shared files the group folder is missing, once its status is known. */
export function missingInstructions(status: { agents_md: boolean; claude_md: boolean } | null): string[] {
  if (!status) return []
  return [...(status.agents_md ? [] : ['AGENTS.md']), ...(status.claude_md ? [] : ['CLAUDE.md'])]
}

export function InstructionsOffer({ project }: { project: Project | undefined }) {
  const group = isGroupProject(project) && !project!.instructions_offer_dismissed ? project! : null
  const status = useMemberStatus(group?.id)
  useEffect(() => { if (group) void loadMemberStatus(group.id) }, [group?.id])
  // Written this session: the confirmation stays until it leaves, even though the files now exist.
  const [created, setCreated] = useState<{ projectId: string; files: string[] } | null>(null)
  const [hidden, setHidden] = useState<string | null>(null)
  const missing = missingInstructions(status)
  const done = created?.projectId === group?.id ? created : null
  const show = !!group && hidden !== group.id && (missing.length > 0 || !!done)
  // Single projects render nothing here at all, so their new chat page stays exactly as it was.
  if (!group) return null
  return (
    // Stretched to the composer's width: the column it sits in centres shrink-to-fit children, and the body must wrap.
    <div style={{ display: 'flex', flexDirection: 'column', alignSelf: 'stretch', width: '100%' }}>
    <Collapse open={show} closeDuration={0.22}>
      <Presence show={show} exit={EXIT.row} style={{ width: '100%', paddingBottom: 16 }}>
        {group && (
          <OfferCard
            key={group.id}
            project={group}
            missing={missing}
            done={done?.files ?? null}
            onCreated={(files) => setCreated({ projectId: group.id, files })}
            onHide={(persist) => {
              setHidden(group.id)
              if (persist) void updateGroup(group.id, { instructions_offer_dismissed: true }).catch(() => {})
            }}
          />
        )}
      </Presence>
    </Collapse>
    </div>
  )
}

function OfferCard({ project, missing, done, onCreated, onHide }: {
  project: Project
  missing: string[]
  done: string[] | null
  onCreated: (files: string[]) => void
  /** `persist`: remember it for this project (Not now, ×); the confirmation's own exit does not. */
  onHide: (persist: boolean) => void
}) {
  const t = useTheme()
  const c = useControls()
  const status = useMemberStatus(project.id)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const name = folderName(project.path)
  const members = (project.members ?? []).filter((m) => m.path !== '.')
  const local = activeEnvironment().local

  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => onHide(false), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [done])

  const create = async () => {
    const client = getClient()
    if (!client || busy) return
    setBusy(true); setError('')
    try {
      const result = await client.call('projects.instructions.create', { project_id: project.id })
      if (getClient() !== client) return
      onCreated(result.created)
      void loadMemberStatus(project.id, true)
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const openAgents = () => { if (local) spawn('open', [`${project.path}/AGENTS.md`], { stdio: 'ignore' }).on('error', () => {}) }

  const files = instructionsPreview(project.name, (project.members ?? []).map((m) => ({ path: m.path, instructions: status?.members.find((s) => s.path === m.path)?.instructions })), project.is_git)
  const card = { width: '100%', borderRadius: RADIUS.xl, borderWidth: 1, borderColor: t.borderLight, backgroundColor: t.v('--background') } as const

  return (
    <Swap active={done ? 'done' : 'offer'} style={{ width: '100%' }} innerStyle={{ width: '100%' }}>
      {done ? (
        <div testId="instructions-done" style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, paddingLeft: 12, paddingRight: 8 }}>
          <div style={{ display: 'flex', width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: c.ink(0.04) }}>
            <Icon source={N.check} size={14} color={t.green} />
          </div>
          <Label color={t.text} size={13} lineHeight={19} truncate style={{ flexGrow: 1, minWidth: 0 }}>{instructionsCreatedText(done, name)}</Label>
          {local && done.includes('AGENTS.md') && <Button variant="ghost" size="sm" onClick={openAgents}>{GROUP_COPY.openAgentsMd}</Button>}
          <IconButton size="sm" icon={N.x} label="Dismiss" onClick={() => onHide(false)} />
        </div>
      ) : (
        <div testId="instructions-offer" role="region" aria-label={GROUP_COPY.instructionsOfferTitle} style={{ ...card, position: 'relative', display: 'flex', gap: 12, paddingLeft: 14, paddingRight: 14, paddingTop: 14, paddingBottom: 12 }}>
          <div style={{ display: 'flex', width: 28, height: 28, borderRadius: 8, flexShrink: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: c.acc(0.1) }}>
            <Icon source={N.file} size={15} color={c.accentFg} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexGrow: 1, minWidth: 0, paddingRight: 20 }}>
            <Label color={t.text} size={14} lineHeight={20} weight={600}>{GROUP_COPY.instructionsOfferTitle}</Label>
            <Label color={t.textSecondary} size={13} lineHeight={19}>{instructionsOfferBody(name, members.map((m) => m.name), missing, project.is_git)}</Label>
            <Collapse open={preview} testId="instructions-preview">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8 }}>
                {missing.includes('AGENTS.md') && <PreviewFile title={`${name}/AGENTS.md`} text={files.agents} />}
                {missing.includes('CLAUDE.md') && <PreviewFile title={`${name}/CLAUDE.md`} text={files.claude} />}
              </div>
            </Collapse>
            {error && <Label color={t.red} size={12} lineHeight={17}>{error}</Label>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 6 }}>
              <Button testId="instructions-create" variant="primary" size="sm" busy={busy} swap onClick={() => void create()}>{busy ? GROUP_COPY.creating : GROUP_COPY.createFiles}</Button>
              <Button testId="instructions-preview-toggle" size="sm" icon={N.eye} onClick={() => setPreview(!preview)}>{preview ? GROUP_COPY.hidePreview : GROUP_COPY.preview}</Button>
              <div style={{ flexGrow: 1 }} />
              <Button testId="instructions-not-now" variant="ghost" size="sm" onClick={() => onHide(true)}>{GROUP_COPY.notNow}</Button>
            </div>
          </div>
          <div style={{ position: 'absolute', top: 8, right: 8 }}>
            <IconButton testId="instructions-close" size="sm" icon={N.x} label="Hide this suggestion" onClick={() => onHide(true)} />
          </div>
        </div>
      )}
    </Swap>
  )
}

function PreviewFile({ title, text }: { title: string; text: string }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderRadius: RADIUS.md, backgroundColor: t.codeSurface }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon source={N.file} size={12} color={t.textSecondary} />
        <Label color={t.text} size={12} lineHeight={16} weight={500}>{title}</Label>
        <Label color={t.textTertiary} size={12} lineHeight={16}>{`· ${GROUP_COPY.newFile}`}</Label>
      </div>
      <Label color={t.textSecondary} size={11.5} lineHeight={17} font={FONT_MONO} style={{ userSelect: 'text' }}>{text.trimEnd()}</Label>
    </div>
  )
}
