// "Report a problem", the review step: the exact GitHub issue text (already stripped of paths, names, e-mail addresses and tokens by
// `problems/report.ts`), editable. Nothing leaves the computer until "Open on GitHub", which opens the prefilled issue in the browser.
import { useWindowSize } from '@gpuix/react'
import { useState } from 'react'
import { reportIssueUrl, type ProblemReport } from '../../../../packages/kybern-client/src/report.ts'
import { Button } from '../kit/Button.tsx'
import { TextField } from '../kit/Field.tsx'
import { TextArea } from '../kit/TextArea.tsx'
import { Dialog, useDialogClose } from '../nav/overlay.tsx'
import { toastProblem } from '../problems/toast.ts'
import { openExternal } from '../settings/external.ts'
import { Label, useTheme } from '../ui.tsx'

export function ReportProblem({ draft, close }: { draft: ProblemReport; close: () => void }) {
  return (
    <Dialog onClose={close} width={560} testId="report-problem">
      <ReportSheet draft={draft} close={close} />
    </Dialog>
  )
}

function ReportSheet({ draft, close }: { draft: ProblemReport; close: () => void }) {
  const t = useTheme()
  const exit = useDialogClose()
  const [title, setTitle] = useState(draft.title)
  const [body, setBody] = useState(draft.body)
  // The whole issue fits on screen when the window allows (it starts with the caret at the end, which scrolls a taller text to its last lines).
  const window = useWindowSize({ intervalMs: 250 })
  const rows = Math.max(8, Math.min(28, Math.floor((window.height - 230) / 19)))
  const dismiss = () => (exit ? exit() : close())
  const open = () => {
    openExternal(reportIssueUrl({ title: title.trim(), body })).then(dismiss, (error) => toastProblem(error, { action: 'open GitHub' }))
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingLeft: 20, paddingRight: 20, paddingTop: 20, paddingBottom: 16 }}>
      <Label color={t.text} size={17} lineHeight={22} weight={600}>Report a problem</Label>
      <TextField testId="report-title" label="Title" value={title} onChange={setTitle} width="100%" />
      <TextArea testId="report-body" label="Details" value={body} onChange={setBody} minRows={Math.min(rows, Math.max(10, draft.body.split('\n').length))} maxRows={rows} width="100%" style={{ fontSize: 12 }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button testId="report-cancel" variant="secondary" onClick={dismiss}>Cancel</Button>
        <Button testId="report-open" variant="primary" disabled={!title.trim()} onClick={open}>Open on GitHub</Button>
      </div>
    </div>
  )
}
