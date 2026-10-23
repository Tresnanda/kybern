// The glyph each inline token kind leads with (`InlineTokenIcon`), shared by sent messages and the composer.
import { getFileIconName } from '../../../desktop/src/lib/kit/fileIcons.ts'
import type { InlineTokenKind } from '@/lib/inlineTokenLabel'
import { diffFileIcons } from '../native/diff-file-icons.ts'
import { T } from '../transcript/glyphs.ts'
import { G } from './glyphs.ts'

export function tokenIcon(kind: InlineTokenKind, token: string): string {
  switch (kind) {
    case 'skill': return G.skill
    case 'plugin': return G.plugin
    case 'computer': return G.laptop
    case 'thread': return G.message
    case 'note': return T.note
    case 'task': return T.listChecks
    case 'secret': return G.key
    case 'anchor': return G.target
    case 'attachment': return diffFileIcons[token.startsWith('@image') ? 'file-jpg' : getFileIconName(token.slice(1))] ?? T.file
    default: return diffFileIcons[getFileIconName(token.slice(1))] ?? T.file
  }
}
