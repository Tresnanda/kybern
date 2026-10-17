import { useMemo, useRef, useState, useImperativeHandle, type Ref } from 'react'
import type { PublicInstance } from '@gpuix/react'
import { RichTextarea, type RichTextareaHandle } from './RichTextarea.tsx'
import { parseRichText, richTableCellRange } from './rich-text.ts'
import { NoteImage } from './NoteBlock.tsx'
import { useTheme } from '../ui.tsx'
import { copyText } from '../transcript/store.ts'

type Props = Parameters<typeof RichTextarea>[0] & { columnWidth?: number; noteId?: string; imageDefinitions?: ReadonlyMap<string, string> }
type Node = NonNullable<ReturnType<typeof parseRichText>['tree']>
const begin = (node: Node) => node.position?.start.offset ?? 0
const finish = (node: Node) => node.position?.end.offset ?? begin(node)
const isImage = (node: Node) => node.type === 'image' || node.type === 'imageReference'
const imagesIn = (node: Node): Node[] => isImage(node) ? [node] : (node.children ?? []).flatMap(imagesIn)
const onlyImage = (node: Node) => node.type === 'paragraph' && !!node.children?.length && node.children.every(isImage)
function assign<T>(ref: Ref<T> | undefined, value: T | null) { if (typeof ref === 'function') ref(value); else if (ref) ref.current = value }

/** Prose/code use native attributed inputs. Image blocks keep the existing
 * native image host; table cells are formatted inputs in a native grid. Each
 * child changes only its parsed source range, preserving sibling source. */
export function RichDocument({ columnWidth = 620, noteId, imageDefinitions, editorRef, nativeRef, ...props }: Props) {
  const t = useTheme()
  const doc = useMemo(() => parseRichText(props.value, props.markdownContext), [props.value, props.markdownContext])
  const context = props.markdownContext ?? (doc.tree?.children ?? []).filter(node => node.type === 'definition').map(node => props.value.slice(begin(node), finish(node))).join('\n')
  const split = (source: string): string[] => {
    const children = parseRichText(source, context).tree?.children ?? []
    return children.length ? children.map((node, index) => source.slice(index ? begin(node) : 0, children[index + 1] ? begin(children[index + 1]!) : source.length)) : [source]
  }
  const [saved, setSegments] = useState(() => split(props.value))
  const segmentRef = useRef(saved)
  const received = useRef(props.value)
  const live = useRef(props.value)
  let segments = saved
  if (received.current !== props.value) {
    received.current = props.value
    if (live.current !== props.value) { segments = split(props.value); segmentRef.current = segments; setSegments(segments); live.current = props.value }
  }
  // Keep an edited paragraph's scope stable when Enter creates another block.
  // Re-segment only external replacements, so a source echo cannot remove the
  // new line from the focused native buffer or move its selection.
  const nodes = segments.map(raw => parseRichText(raw, context).tree?.children?.[0] ?? { type: 'paragraph', children: [] })
  const complex = nodes.some(node => node.type === 'table' || node.type === 'code' || imagesIn(node).length > 0)
  const definitions = new Map((doc.tree?.children ?? []).filter(node => node.type === 'definition').map(node => [node.identifier, node.url]))
  const imageSource = (image: Node) => image.url ?? definitions.get(image.identifier) ?? (image.identifier ? imageDefinitions?.get(image.identifier) : undefined) ?? ''
  const handles = useRef(new Map<string, RichTextareaHandle>())
  const inputs = useRef(new Map<string, PublicInstance>())
  const active = useRef<string | null>(null)
  const current = () => (active.current ? handles.current.get(active.current) : null) ?? handles.current.values().next().value
  useImperativeHandle(editorRef, () => ({ focus: () => current()?.focus(), mark: marker => current()?.mark(marker), block: kind => current()?.block(kind), link: (label, href) => current()?.link(label, href), selection: () => current()?.selection() ?? { start: 0, end: 0, composing: false, reversed: false } }))
  const editNode = (index: number, value: string) => {
    const next = [...segmentRef.current]; next[index] = value
    segmentRef.current = next
    live.current = next.join(''); setSegments(next); props.onChange(live.current)
  }
  const editCell = (index: number, row: number, cell: number, value: string) => {
    const source = segmentRef.current[index] ?? '', node = parseRichText(source, context).tree?.children?.[0]?.children?.[row]?.children?.[cell]
    if (!node) return
    const range = richTableCellRange(source, node)
    const body = value.replace(/\r?\n/g, ' ').replace(/(?<!\\)\|/g, '\\|').trim()
    editNode(index, source.slice(0, range.start) + body + source.slice(range.end))
  }
  let fields = 0
  const field = (key: string, value: string, onChange: (value: string) => void, inlineOnly = false, header = false) => {
    const first = fields++ === 0
    return <RichTextarea key={key} {...props} markdownContext={context} editorRef={handle => { if (handle) handles.current.set(key, handle); else handles.current.delete(key) }}
      nativeRef={node => { if (node) inputs.current.set(key, node); else inputs.current.delete(key); assign(nativeRef, inputs.current.values().next().value ?? null) }}
      testId={first ? props.testId : `${props.testId}-${key}`} value={value} onChange={onChange} autoFocus={first && props.autoFocus} inlineOnly={inlineOnly}
      onFocus={event => { active.current = key; props.onFocus?.(event) }}
      style={{ ...props.style, width: '100%', ...(header ? { fontWeight: 600 } : {}) }} />
  }
  if (!complex) return field('body', props.value, props.onChange)
  return <div testId={`${props.testId}-document`} style={{ display: 'flex', flexDirection: 'column', width: props.style?.width ?? '100%', flexGrow: props.style?.flexGrow, minHeight: 0, gap: props.style?.lineHeight ?? 24, ...(props.style?.flexGrow ? { overflowY: 'scroll' } : {}) }}>
    {nodes.map((node, index) => {
      const raw = segments[index] ?? ''
      if (node.type === 'definition') return null
      if (onlyImage(node)) return <div key={index} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{imagesIn(node).map((image, imageIndex) => <div key={imageIndex} testId={`${props.testId}-image-${index}-${imageIndex}`} tabIndex={props.readOnly ? -1 : 0} onKeyDown={event => {
        if ((event.modifiers?.cmd || event.modifiers?.ctrl) && event.key === 'c') { event.preventDefault(); void copyText(raw) }
        if (!props.readOnly && (event.key === 'backspace' || event.key === 'delete')) { event.preventDefault(); editNode(index, '') }
      }}><NoteImage noteId={noteId} source={imageSource(image)} label={image.alt ?? ''} width={columnWidth} /></div>)}</div>
      if (node.type === 'table') return <div key={index} testId={`${props.testId}-table-${index}`} style={{ display: 'flex', flexDirection: 'column', width: '100%', borderWidth: 1, borderColor: t.border, borderRadius: 6 }}>
        {(node.children ?? []).map((row, rowIndex) => <div key={rowIndex} style={{ display: 'flex', width: '100%', backgroundColor: rowIndex === 0 ? t.buttonSecondary : undefined, ...(rowIndex ? { borderTopWidth: 1, borderColor: t.border } : {}) }}>
          {(row.children ?? []).map((cell, cellIndex) => <div key={cellIndex} style={{ flexGrow: 1, flexBasis: 0, minWidth: 0, padding: 8, ...(cellIndex ? { borderLeftWidth: 1, borderColor: t.border } : {}) }}>{field(`${index}-${rowIndex}-${cellIndex}`, raw.slice(richTableCellRange(raw, cell).start, richTableCellRange(raw, cell).end), value => editCell(index, rowIndex, cellIndex, value), true, rowIndex === 0)}</div>)}
        </div>)}
      </div>
      return <div key={index} style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 8 }}>
        {field(`${index}`, raw, value => editNode(index, value))}
        {imagesIn(node).map((image, imageIndex) => <NoteImage key={imageIndex} noteId={noteId} source={imageSource(image)} label={image.alt ?? ''} width={columnWidth} />)}
      </div>
    })}
    {(onlyImage(nodes.at(-1) ?? { type: '' }) || nodes.at(-1)?.type === 'table') && field('tail', '', value => {
      if (!value) return
      const next = [...segmentRef.current]
      next[next.length - 1] = (next.at(-1) ?? '').trimEnd() + '\n\n'
      next.push(value); segmentRef.current = next
      live.current = next.join(''); setSegments(next); props.onChange(live.current)
    })}
  </div>
}
