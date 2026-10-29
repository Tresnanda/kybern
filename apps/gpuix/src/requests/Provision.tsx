// "os-kdi doesn't have kybern yet" (`kybern_project_provision`): an agent delegated, forked or moved work to a machine without
// the repository, or asked with `kybern_project_add_to_machine`. A closed form like the secret card: the folder on that machine
// (checked there, Choose… browses its folders), the env files to copy, then Add or Cancel. The daemon queues the provisioning
// and the waiting work goes on by itself; nothing is asked again.
import { useEffect, useState } from 'react'
import type { ApprovalRequest, ProvisionCardInput } from '../../../../packages/kybern-client/src/types.ts'
import { PROVISION_COPY as COPY, defaultEnvFiles, defaultPath, pathAccepted, provisionAnswer } from '../../../../packages/kybern-client/src/provision.ts'
import { Button } from '../kit/Button.tsx'
import { MachineBadge } from '../sidebar/MachineBadge.tsx'
import { glyphOfMachine } from '../machines/index.ts'
import { EnvFileList, FolderField, useProvisionPlan } from '../provision/parts.tsx'
import { fixtureClient } from '../provision/targets.ts'
import { respondApproval } from '../transcript/store.ts'
import { threadClient } from '../state.ts'
import { T } from '../transcript/glyphs.ts'
import { Label } from '../ui.tsx'
import { CardShell, HintText, Hints, RequestBody, RequestHeader, useCardTokens } from './Card.tsx'
import { keyboardAnswer } from './Panel.tsx'

export function ProvisionRequestPanel({ approval, input, count, threadId }: { approval: ApprovalRequest; input: ProvisionCardInput; count: number; threadId: string }) {
  const k = useCardTokens()
  const { plan: asked } = input
  // The thread's own machine sent the card and is the source; it checks folders with the target.
  const [source] = useState(() => { try { return fixtureClient() ?? threadClient(threadId) } catch { return null } })
  const [path, setPath] = useState<string>(() => defaultPath(asked))
  const [env, setEnv] = useState<string[]>(() => defaultEnvFiles(asked.env_files))
  const { plan, check, checking } = useProvisionPlan(source, asked.project_id, asked.target.id, path, asked)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setError('') }, [path])
  const view = plan ?? asked
  const ready = !busy && !checking && path.trim() !== '' && pathAccepted(check)
  const respond = async (add: boolean) => {
    if (busy || (add && !ready)) return
    setBusy(true); setError('')
    try { await respondApproval(approval.id, add ? provisionAnswer(path.trim(), env) : { decision: 'deny' }) }
    catch { setError('Unable to send your answer. Check the connection and try again.'); setBusy(false) }
  }
  return (
    <CardShell testId="provision-request-panel" stealFocus={false}>
      <RequestHeader glyph={T.laptop} title={COPY.cardTitle(view.target.name, view.project_name)} badge={count > 1 ? `1 of ${count}` : undefined} meta={input.reason || COPY.cardThen(input.then, view.target.name)}
        tileMark={<MachineBadge glyph={glyphOfMachine(view.target.id)} size={20} />} />
      <RequestBody style={{ gap: 12, marginTop: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Label color={k.t.textSecondary} size={12.5} lineHeight={18} weight={500}>{`${COPY.folder} on ${view.target.name}`}</Label>
          <FolderField testId="provision-card-folder" plan={view} path={path} onPath={setPath} check={check} checking={checking} disabled={busy} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Label color={k.t.textSecondary} size={12.5} lineHeight={18} weight={500}>{COPY.envFiles}</Label>
          <EnvFileList plan={view} selected={env} onChange={setEnv} disabled={busy} />
        </div>
      </RequestBody>
      <Hints
        error={error}
        left={<HintText>{`${view.target.name} clones it, or ${view.source.name} sends it`}</HintText>}
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <Button variant="ghost" size="sm" onKeyboard={keyboardAnswer} testId="provision-decline" disabled={busy} onClick={() => void respond(false)}>{COPY.decline}</Button>
            <Button variant="primary" size="sm" swap onKeyboard={keyboardAnswer} kbd="↵" testId="provision-approve" disabled={!ready} onClick={() => void respond(true)}>{busy ? COPY.adding(view.target.name) : COPY.add(view.target.name)}</Button>
          </div>
        }
      />
    </CardShell>
  )
}
