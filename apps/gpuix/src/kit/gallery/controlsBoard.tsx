// The control system board (ADE-55): every control × variant × size × state that can be shown at rest, like the spec's `kit-C`.
// `KIT_SECTION=controls-board`; see `scripts/kit-controls-board.ts` for the capture.
import { useState, type ComponentType, type ReactNode } from 'react'
import { Label, useTheme } from '../../ui.tsx'
import { Button } from '../Button.tsx'
import { Checkbox } from '../Checkbox.tsx'
import { IconButton } from '../IconButton.tsx'
import { Kbd } from '../Kbd.tsx'
import { NumberField } from '../NumberField.tsx'
import { PickerChip } from '../PickerChip.tsx'
import { Radio } from '../Radio.tsx'
import { RadioRow } from '../RadioRow.tsx'
import { SearchField } from '../SearchField.tsx'
import { Segmented } from '../Segmented.tsx'
import { SelectTrigger } from '../SelectTrigger.tsx'
import { Slider } from '../Slider.tsx'
import { Switch } from '../Switch.tsx'
import { TextArea } from '../TextArea.tsx'
import { TextField } from '../Field.tsx'
import { TokenChip } from '../TokenChip.tsx'

const noop = () => {}
function Row({ title, children }: { title: string; children: ReactNode }) {
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 36 }}><div style={{ width: 84, flexShrink: 0 }}><Label color={t.textTertiary} size={11}>{title}</Label></div>{children}</div>
}
function Head({ children }: { children: string }) {
  const t = useTheme()
  return <div style={{ paddingTop: 10 }}><Label color={t.text} size={13} weight={600}>{children}</Label></div>
}
function Group({ children }: { children: ReactNode }) { return <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{children}</div> }

function Board() {
  const [seg, setSeg] = useState('translucent')
  const [range, setRange] = useState('open')
  const [text, setText] = useState('docs-site')
  const [rad, setRad] = useState('approve')
  return (
    <div style={{ position: 'absolute', left: 24, top: 8, width: 1232, display: 'flex', gap: 40 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, width: 600 }}>
        <Head>Buttons · md 28</Head>
        <Row title="primary"><Group><Button variant="primary">Save</Button><Button variant="primary" kbd="⌘↵">Approve once</Button><Button variant="primary" disabled>Save</Button><Button variant="primary" busy>Merging…</Button></Group></Row>
        <Row title="secondary"><Group><Button>Save</Button><Button icon="edit" chevron>Review</Button><Button disabled>Save</Button></Group></Row>
        <Row title="ghost"><Group><Button variant="ghost">Cancel</Button><Button variant="ghost" icon="plus">Add a criterion</Button><Button variant="ghost" disabled>Save</Button></Group></Row>
        <Row title="destructive"><Group><Button variant="destructive">Remove worktree</Button><Button danger>Don’t save</Button><Button variant="ghost" danger>Delete</Button></Group></Row>
        <Row title="sm 24"><Group><Button size="sm" variant="primary">Send</Button><Button size="sm" icon="copy">Refresh</Button><Button size="sm" variant="ghost" icon="plus">Add</Button></Group></Row>
        <Row title="lg 32"><Group><Button size="lg" variant="primary">Close window</Button><Button size="lg">Cancel</Button><Button size="lg" variant="destructive">Remove</Button></Group></Row>
        <Head>Icon buttons</Head>
        <Row title="sm / md / lg"><Group><IconButton size="sm" icon="panelLeft" label="a" onClick={noop} /><IconButton icon="panelLeft" label="b" onClick={noop} /><IconButton size="lg" icon="panelLeft" label="c" onClick={noop} /><IconButton icon="panelRight" label="d" active onClick={noop} /><IconButton icon="panelRight" label="e" secondary onClick={noop} /><IconButton icon="panelRight" label="f" disabled onClick={noop} /></Group></Row>
        <Head>Chips</Head>
        <Row title="picker"><Group><PickerChip icon="hammer" onClick={noop}>main</PickerChip><PickerChip icon="hammer" open onClick={noop}>main</PickerChip><PickerChip selected chevron={false} onClick={noop}>All</PickerChip><PickerChip disabled onClick={noop}>main</PickerChip></Group></Row>
        <Row title="picker sm"><Group><PickerChip size="sm" onClick={noop}>Global</PickerChip><PickerChip size="sm" dot="#3fb950" onClick={noop}>docs-site</PickerChip><PickerChip size="sm" mark="codex" secondary="High" onClick={noop}>GPT-6.1 Sol</PickerChip></Group></Row>
        <Row title="token"><Group><TokenChip onRemove={noop}>Calculator</TokenChip><TokenChip onRemove={noop}>Notes</TokenChip><TokenChip>src/date.ts</TokenChip></Group></Row>
        <Head>Checkbox, radio, switch</Head>
        <Row title="checkbox"><Group><Checkbox aria-label="a" /><Checkbox aria-label="b" defaultChecked /><Checkbox aria-label="c" indeterminate /><Checkbox aria-label="d" disabled /><Checkbox aria-label="e" disabled defaultChecked /><Checkbox aria-label="f" invalid /></Group></Row>
        <Row title="radio"><Group><Radio checked={false} /><Radio checked /><Radio checked={false} disabled /><Radio checked disabled /></Group></Row>
        <Row title="switch"><Group><Switch aria-label="a" /><Switch aria-label="b" defaultChecked /><Switch aria-label="c" disabled /><Switch aria-label="d" disabled defaultChecked /></Group></Row>
        <Head>Segmented and slider</Head>
        <Row title="md 28"><Segmented aria-label="material" value={seg} onChange={setSeg} options={[{ value: 'solid', label: 'Solid' }, { value: 'translucent', label: 'Translucent' }]} /></Row>
        <Row title="sm 24"><Segmented size="sm" aria-label="range" value={range} onChange={setRange} options={[{ value: 'open', label: 'Open', count: 12 }, { value: 'merged', label: 'Merged' }, { value: 'closed', label: 'Closed' }, { value: 'all', label: 'All' }]} /></Row>
        <Row title="slider"><Slider value={64} min={0} max={100} onChange={noop} onCommit={noop} valueLabel="Blur 64" aria-label="Blur" ariaValueText="64" /></Row>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, width: 560 }}>
        <Head>Fields</Head>
        <Row title="text md"><Group><TextField label="a" value="" placeholder="Name" onChange={noop} width={130} /><TextField label="b" value={text} onChange={setText} width={130} /><TextField label="c" value="docs-site" onChange={noop} invalid width={130} /><TextField label="d" value="docs-site" onChange={noop} disabled width={130} /></Group></Row>
        <Row title="search"><Group><SearchField label="s" value="" placeholder="Search" onChange={noop} width={150} /><SearchField label="s2" value="worktree" onChange={noop} width={150} /></Group></Row>
        <Row title="number"><Group><NumberField label="n" value={10} unit="min" onCommit={noop} /><NumberField label="n2" value={0} unit="min" onCommit={noop} /></Group></Row>
        <Row title="lg 32"><TextField label="p" value="/Users/mymac/projects" onChange={noop} size="lg" width={260} /></Row>
        <Row title="textarea"><TextArea label="ta" value="" placeholder="Type your own answer" onChange={noop} width={340} /></Row>
        <Head>Select triggers</Head>
        <Row title="md"><Group><SelectTrigger>Supervised</SelectTrigger><SelectTrigger mark="claude-code">Claude Code</SelectTrigger><SelectTrigger open>Ask first</SelectTrigger><SelectTrigger disabled>Ask first</SelectTrigger></Group></Row>
        <Row title="sm / lg"><Group><SelectTrigger size="sm">Last 30 days</SelectTrigger><SelectTrigger size="lg" minWidth={140}>Use environment</SelectTrigger></Group></Row>
        <Head>Radio rows</Head>
        <div role="radiogroup" aria-label="Review type" style={{ display: 'flex', flexDirection: 'column', gap: 2, width: 340 }}>
          <RadioRow checked={rad === 'comment'} title="Comment" description="Post feedback without a verdict." onSelect={() => setRad('comment')} />
          <RadioRow checked={rad === 'approve'} title="Approve" description="Approve these changes." onSelect={() => setRad('approve')} />
        </div>
        <Head>Kbd</Head>
        <Row title="kbd"><Group><Kbd keys={['⌘', 'N']} /><Kbd keys={['⌥', '⌘', 'N']} /><Kbd keys={['esc']} /></Group></Row>
      </div>
    </div>
  )
}

export const sections: Record<string, ComponentType> = { 'controls-board': Board }
