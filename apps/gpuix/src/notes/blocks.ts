// Lossless segmentation: separators stay in the blocks. Blank lines inside code
// fences never split a block; no serializer rewrites untouched Markdown.
export function splitBlocks(source: string): string[] {
  if (!source) return ['']
  const blocks: string[] = []
  let block = ''
  let fence: string | null = null
  for (const line of source.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) fence = fence ? null : marker
    block += line
    if (!fence && !line.trim() && block.trim()) { blocks.push(block); block = '' }
  }
  if (block) { if (!block.trim() && blocks.length) blocks[blocks.length - 1] += block; else blocks.push(block) }
  return blocks.length ? blocks : [source]
}
export const BLOCKS = [
  { id: 'body', label: 'Body', prefix: '' }, { id: 'h1', label: 'Heading 1', prefix: '# ' },
  { id: 'h2', label: 'Heading 2', prefix: '## ' }, { id: 'h3', label: 'Heading 3', prefix: '### ' },
  { id: 'bullet', label: 'Bullet list', prefix: '- ' }, { id: 'number', label: 'Numbered list', prefix: '1. ' },
  { id: 'checklist', label: 'Checklist', prefix: '- [ ] ' }, { id: 'quote', label: 'Quote', prefix: '> ' },
  { id: 'code', label: 'Code block', prefix: '```\n' }, { id: 'divider', label: 'Divider', prefix: '---\n' },
] as const
export function formatBlock(source: string, id: string) {
  const raw = source.replace(/^\/[\w ]*$/, '').replace(/^(?:#{1,6}\s+|>\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)/, '')
  const block = BLOCKS.find((b) => b.id === id)
  if (!block) return source
  if (id === 'code') return `\`\`\`\n${raw.trimEnd()}\n\`\`\`\n\n`
  if (id === 'divider') return `---\n\n${raw}`
  return block.prefix + raw
}
