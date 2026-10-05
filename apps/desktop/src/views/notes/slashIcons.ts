// The icon for each block the "/" menu and the format bar's Text menu can insert.
import {
  CodeBlockIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ListBulletIcon,
  ListNumberIcon,
  ListChecksIcon,
  MinusIcon,
  ParagraphIcon,
  QuoteIcon,
  type LucideIcon,
} from "@/lib/kit/icons"
import type { SlashIcon } from "./slashItems"

export const SLASH_ICONS: Record<SlashIcon, LucideIcon> = {
  text: ParagraphIcon,
  heading1: Heading1Icon,
  heading2: Heading2Icon,
  heading3: Heading3Icon,
  bullet: ListBulletIcon,
  number: ListNumberIcon,
  checklist: ListChecksIcon,
  quote: QuoteIcon,
  code: CodeBlockIcon,
  divider: MinusIcon,
}
