// P3 motion lab: the real overlay and kit pieces in fixed spots, driven by keys and real mouse events from motion-p3-strips.ts.
// Every widget is the shipped component; only its inputs are scripted.
// x context menu · d dialog (pointer) · k dialog opened by a shortcut (instant) · a alert dialog · s sheet · n badge count
// r preview reload↔stop · i preview nav dim · h reveal control · e empty state remount · v switch · g segmented · l skeleton loading (delayed) · b busy list loader
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { Profiler, useState } from 'react'
import { ThemeProvider, useTheme, Label } from '../src/ui.tsx'
import { Menu, MenuItem, MenuSeparator, MenuSub, ContextMenu, Tip, Dialog, DialogHeader, useDialogClose } from '../src/nav/overlay.tsx'
import { Button } from '../src/kit/Button.tsx'
import { AlertDialog, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogClose } from '../src/kit/AlertDialog.tsx'
import { Sheet, SheetHeader, SheetTitle, SheetDescription, SheetPanel } from '../src/kit/Sheet.tsx'
import { Select } from '../src/kit/Select.tsx'
import { HoverCard } from '../src/kit/HoverCard.tsx'
import { Segmented } from '../src/kit/Segmented.tsx'
import { Switch } from '../src/kit/Switch.tsx'
import { Badge } from '../src/kit/Badge.tsx'
import { DockEmpty } from '../src/dock/parts.tsx'
import { LoadingLines } from '../src/dock/loading.tsx'
import { Dim, ReloadButton } from '../src/preview/Chrome.tsx'
import { revealTransform } from '../src/motion/kit.tsx'
import { N } from '../src/nav/glyphs.ts'
import { Icon } from '../src/icons.tsx'

let commits = 0
const at = (x: number, y: number, w: number, h: number) => ({ position: 'absolute', left: x, top: y, width: w, height: h, display: 'flex' }) as const

function CardButton({ testId }: { testId: string }) {
  const close = useDialogClose()
  return <div testId={testId}><Button onClick={() => close?.()}>Cancel</Button></div>
}

function Lab() {
  const t = useTheme()
  const [ctx, setCtx] = useState(false), [dialog, setDialog] = useState<'closed' | 'pointer' | 'key'>('closed'), [alert, setAlert] = useState(false), [sheet, setSheet] = useState(false)
  const [count, setCount] = useState(3), [empty, setEmpty] = useState(0), [on, setOn] = useState(false), [seg, setSeg] = useState('a'), [loading, setLoading] = useState(false)
  const [choice, setChoice] = useState<string | null>('b'), [pload, setPload] = useState(false), [pdim, setPdim] = useState(true), [reveal, setReveal] = useState(false)
  const action = (k: string) => {
    if (k === 'x') setCtx(v => !v)
    if (k === 'd') setDialog(v => (v === 'closed' ? 'pointer' : 'closed'))
    if (k === 'k') setDialog(v => (v === 'closed' ? 'key' : 'closed'))
    if (k === 'a') setAlert(v => !v)
    if (k === 's') setSheet(v => !v)
    if (k === 'n') setCount(v => v + 1)
    if (k === 'e') setEmpty(v => v + 1)
    if (k === 'r') setPload(v => !v)
    if (k === 'i') setPdim(v => !v)
    if (k === 'h') setReveal(v => !v)
    if (k === 'v') setOn(v => !v)
    if (k === 'g') setSeg(v => (v === 'a' ? 'b' : v === 'b' ? 'c' : 'a'))
    if (k === 'l') setLoading(v => !v)
  }
  const fill = t.buttonSecondaryHover
  return (
    <div testId="app-ready" tabIndex={0} onKeyDown={e => action(e.key ?? '')} style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: t.v('--background') }}>
      <div testId="menu" style={{ ...at(16, 16, 200, 220), alignItems: 'flex-start' }}>
        <Menu testId="menu-main" trigger={() => <div style={{ display: 'flex', alignItems: 'center', height: 28, paddingLeft: 10, paddingRight: 10, borderRadius: 10, backgroundColor: fill }}><Label color={t.text} size={13}>Menu</Label></div>}>
          <MenuItem id="one" testId="menu-item-one" label="Rename" icon={N.note} onSelect={() => {}} />
          <MenuItem id="two" testId="menu-item-two" label="Duplicate" icon={N.refresh} onSelect={() => {}} />
          <MenuSub id="more" testId="menu-sub" label="More actions">
            <MenuItem id="m1" testId="menu-item-m1" label="Archive" onSelect={() => {}} />
            <MenuItem id="m2" label="Export" onSelect={() => {}} />
          </MenuSub>
          <MenuSeparator />
          <MenuItem id="three" label="Delete" destructive onSelect={() => {}} />
        </Menu>
      </div>
      {ctx && <ContextMenu at={{ x: 330, y: 60 }} onClose={() => setCtx(false)} testId="ctx"><MenuItem id="c1" testId="ctx-item" label="Open" onSelect={() => {}} /><MenuItem id="c2" label="Copy link" onSelect={() => {}} /></ContextMenu>}
      <div testId="tips" style={{ ...at(560, 16, 140, 40), gap: 8 }}>
        <Tip label="First tooltip" shortcut={['⌘', 'K']} side="bottom"><div testId="tip-a" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, backgroundColor: fill }}><Icon source={N.note} size={16} color={t.text} /></div></Tip>
        <Tip label="Second one" side="bottom"><div testId="tip-b" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, backgroundColor: fill }}><Icon source={N.tasks} size={16} color={t.text} /></div></Tip>
      </div>
      <div testId="select" style={{ ...at(16, 260, 220, 40) }}>
        <Select testId="sel" label="Model" options={[{ value: 'a', label: 'Opus 5.5' }, { value: 'b', label: 'Sonnet 5.5' }, { value: 'c', label: 'Haiku 5.5' }]} value={choice} onValueChange={setChoice} />
      </div>
      <div testId="hovercard" style={{ ...at(300, 260, 220, 120), alignItems: 'flex-start' }}>
        <HoverCard delay={100} closeDelay={50} width={200} trigger={<div testId="hover-trigger" style={{ display: 'flex', alignItems: 'center', height: 28, paddingLeft: 10, paddingRight: 10, borderRadius: 10, backgroundColor: fill }}><Label color={t.text} size={13}>Hover me</Label></div>}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 12 }}><Label color={t.text} size={13}>A hover card</Label><Label color={t.textSecondary} size={12}>Holds a few lines of detail.</Label></div>
        </HoverCard>
      </div>
      <div testId="controls" style={{ ...at(16, 340, 460, 50), alignItems: 'center', gap: 24 }}>
        <div testId="segmented" style={{ width: 200, display: 'flex' }}><Segmented fill value={seg} onChange={setSeg} aria-label="View" options={[{ value: 'a', label: 'List' }, { value: 'b', label: 'Board' }, { value: 'c', label: 'Grid' }]} /></div>
        <div testId="switch" style={{ display: 'flex' }}><Switch checked={on} onCheckedChange={setOn} aria-label="Toggle" /></div>
        <div testId="badge" style={{ display: 'flex', gap: 6 }}><Badge variant="secondary">{String(count)}</Badge><Badge variant="outline">New</Badge></div>
      </div>
      <div testId="empty" style={{ ...at(560, 100, 260, 220) }}><div key={empty} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, width: 260 }}><DockEmpty lineage icon={N.users} title="No agents yet" body="Ask the agent to delegate work to another agent; children appear here." /></div></div>
      <div testId="preview" style={{ ...at(420, 420, 300, 40), alignItems: 'center', gap: 8, paddingLeft: 8, borderRadius: 10, backgroundColor: fill }}>
        <Dim on={pdim}><div style={{ display: 'flex', width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}><Icon source={N.arrowLeft} size={14} color={t.text} /></div></Dim>
        <Dim on><ReloadButton loading={pload} onClick={() => {}} /></Dim>
        <div style={{ flexGrow: 1 }} />
        <div paintTransform={revealTransform(reveal)} style={{ display: 'flex', width: 24, height: 24, marginRight: 8, alignItems: 'center', justifyContent: 'center', ...(reveal ? {} : { pointerEvents: 'none' }) }}><Icon source={N.plus} size={14} color={t.text} /></div>
      </div>
      <div testId="loading" style={{ ...at(16, 420, 360, 120), flexDirection: 'column' }}>{loading && <LoadingLines />}</div>
      {dialog !== 'closed' && (
        <Dialog onClose={() => setDialog('closed')} width={420} testId="dialog" instant={dialog === 'key'}>
          <DialogHeader title="Rename project" description="Choose a new name for this project." onClose={() => setDialog('closed')} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12 }}><CardButton testId="dialog-cancel" /></div>
        </Dialog>
      )}
      <AlertDialog open={alert} onOpenChange={setAlert} width={400} testId="alert">
        <AlertDialogHeader><AlertDialogTitle>Close this thread?</AlertDialogTitle><AlertDialogDescription>The agent is still running. Closing stops it.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogClose testId="alert-cancel">Cancel</AlertDialogClose><AlertDialogClose variant="destructive">Stop and close</AlertDialogClose></AlertDialogFooter>
      </AlertDialog>
      <Sheet open={sheet} onOpenChange={setSheet} side="right" width={320} testId="sheet">
        <SheetHeader><SheetTitle>Details</SheetTitle><SheetDescription>A panel docked to the right edge.</SheetDescription></SheetHeader>
        <SheetPanel><Label color={t.text} size={13}>Body content</Label></SheetPanel>
      </Sheet>
    </div>
  )
}
// Every React commit anywhere in the lab is logged: a paint-only tween must add none between its first and last frame.
render(<ThemeProvider><Profiler id="lab" onRender={() => { console.error(`[lab-commit] ${++commits}`) }}><Lab /></Profiler></ThemeProvider>, { title: 'motion-p3', width: 960, height: 600, focus: false })
