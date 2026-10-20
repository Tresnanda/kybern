// The "/" menu's items and search (desktop `views/notes/slashItems.ts`, which imports
// the TipTap editor; its data and ranking are repeated here without it).
export type SlashIcon = 'text' | 'heading1' | 'heading2' | 'heading3' | 'bullet' | 'number' | 'checklist' | 'quote' | 'code' | 'divider' | 'image'
export interface SlashItem {
  /** The native editor's turn-into id. */
  id: 'text' | 'h1' | 'h2' | 'h3' | 'bullet' | 'number' | 'checklist' | 'quote' | 'code' | 'divider' | 'image'
  title: string
  /** The Markdown you can type instead, shown beside the title so the shortcut gets learned. */
  shortcut: string
  keywords: string[]
  icon: SlashIcon
}

export const SLASH_ITEMS: SlashItem[] = [
  { id: 'text', title: 'Body', shortcut: '', keywords: ['text', 'paragraph', 'plain', 'p'], icon: 'text' },
  { id: 'h1', title: 'Heading 1', shortcut: '#', keywords: ['h1', 'title', 'header', '#'], icon: 'heading1' },
  { id: 'h2', title: 'Heading 2', shortcut: '##', keywords: ['h2', 'subtitle', 'header', '##'], icon: 'heading2' },
  { id: 'h3', title: 'Heading 3', shortcut: '###', keywords: ['h3', 'header', '###'], icon: 'heading3' },
  { id: 'bullet', title: 'Bullet list', shortcut: '-', keywords: ['ul', 'unordered', 'list', '-'], icon: 'bullet' },
  { id: 'number', title: 'Numbered list', shortcut: '1.', keywords: ['ol', 'ordered', 'list', '1.'], icon: 'number' },
  { id: 'checklist', title: 'Checklist', shortcut: '[ ]', keywords: ['todo', 'task', 'check', 'tasks', '[]'], icon: 'checklist' },
  { id: 'quote', title: 'Quote', shortcut: '>', keywords: ['blockquote', 'cite', '>'], icon: 'quote' },
  { id: 'code', title: 'Code block', shortcut: '```', keywords: ['pre', 'snippet', '```'], icon: 'code' },
  { id: 'divider', title: 'Divider', shortcut: '---', keywords: ['hr', 'rule', 'line', 'separator', '---'], icon: 'divider' },
]

export const SLASH_IMAGE_ITEM: SlashItem = { id: 'image', title: 'Image', shortcut: '', keywords: ['picture', 'photo', 'screenshot', 'upload', 'file', 'img'], icon: 'image' }

/** The "/" menu for one editor: the blocks, and Image where images can be kept. */
export function slashItemsFor(canAddImages: boolean): readonly SlashItem[] {
  return canAddImages ? [...SLASH_ITEMS, SLASH_IMAGE_ITEM] : SLASH_ITEMS
}

/** Items for what has been typed after "/": title matches first, then keywords. */
export function filterSlashItems(query: string, items: readonly SlashItem[] = SLASH_ITEMS): SlashItem[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...items]
  const rank = (item: SlashItem): number => {
    const title = item.title.toLowerCase()
    if (title.startsWith(needle)) return 0
    if (title.split(' ').some((word) => word.startsWith(needle))) return 1
    if (item.keywords.some((keyword) => keyword.startsWith(needle))) return 2
    if (title.includes(needle) || item.keywords.some((keyword) => keyword.includes(needle))) return 3
    return -1
  }
  return items
    .map((item, order) => ({ item, order, rank: rank(item) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((entry) => entry.item)
}

/** The blocks the format bar's "Body" menu turns a selection into: the slash items minus the divider. */
export const TURN_INTO_ITEMS: readonly SlashItem[] = SLASH_ITEMS.filter((item) => item.id !== 'divider')
