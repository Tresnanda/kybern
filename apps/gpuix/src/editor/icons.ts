// Block icons for the slash menu and Turn into (desktop `views/notes/slashIcons.ts`).
import {
  CheckListIcon, Heading01Icon, Heading02Icon, Heading03Icon, Image01Icon, LeftToRightListBulletIcon,
  LeftToRightListNumberIcon, MinusSignIcon, ParagraphIcon, QuoteDownIcon, SourceCodeSquareIcon, Task01Icon,
} from '@hugeicons/core-free-icons'
import { glyph } from '../icons.tsx'
import type { SlashIcon } from './slash.ts'

export const SLASH_ICON: Record<SlashIcon, string> = {
  text: glyph(ParagraphIcon),
  heading1: glyph(Heading01Icon),
  heading2: glyph(Heading02Icon),
  heading3: glyph(Heading03Icon),
  bullet: glyph(LeftToRightListBulletIcon),
  number: glyph(LeftToRightListNumberIcon),
  checklist: glyph(CheckListIcon),
  quote: glyph(QuoteDownIcon),
  code: glyph(SourceCodeSquareIcon),
  divider: glyph(MinusSignIcon),
  image: glyph(Image01Icon),
}

/** The "Make task" button's icon (desktop `taskLinks.ts`). */
export const TASK_ICON = glyph(Task01Icon)
