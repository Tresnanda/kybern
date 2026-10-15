// Composer glyphs, the same Hugeicons the desktop maps in `lib/kit/icons.tsx`
// (2.25 stroke unless noted). Pass to `<Icon source={…}>`.
import {
  Attachment01Icon,
  Cancel01Icon,
  Clock01Icon,
  Comment01Icon,
  CommandLineIcon,
  CubeIcon,
  Edit03Icon,
  FlashIcon,
  GitBranchIcon,
  GitForkIcon,
  HandIcon,
  PuzzleIcon,
  Refresh01Icon,
  RefreshIcon,
  Search01Icon,
  ShieldCheckIcon,
  ShieldIcon,
  StarIcon,
  SquareArrowDown01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { filled, glyph, ICONS } from '../icons.tsx'

export const G = {
  folder: ICONS.folder,
  /** `DeviceLaptopIcon` (Checkout). */
  laptop: ICONS.laptop,
  /** `HandRaisedIcon` (Ask for approval). */
  hand: glyph(HandIcon),
  /** `PencilIcon` = Edit03 (Approve edits). */
  pencil: glyph(Edit03Icon),
  /** `ShieldCheckIcon` (Approve for me). */
  shieldCheck: glyph(ShieldCheckIcon),
  /** `ShieldIcon` (Full access). */
  shield: glyph(ShieldIcon),
  /** `CheckIcon` = Tick02. Menu radio indicators draw it at 12px with a 2 stroke. */
  check: glyph(Tick02Icon, 2),
  checkBold: glyph(Tick02Icon),
  paperclip: glyph(Attachment01Icon),
  branch: glyph(GitBranchIcon),
  /** `WorktreeIcon` = GitFork. */
  worktree: glyph(GitForkIcon),
  message: glyph(Comment01Icon),
  star: glyph(StarIcon),
  starFilled: filled(StarIcon),
  refresh: glyph(RefreshIcon),
  /** `ResetIcon`: Refresh01 mirrored (the desktop flips it with `-scale-x-100`). */
  reset: glyph(Refresh01Icon)
    .replace(/(<svg[^>]*>)/, '$1<g transform="translate(24 0) scale(-1 1)">')
    .replace('</svg>', '</g></svg>'),
  x: glyph(Cancel01Icon),
  bolt: filled(FlashIcon),
  boltOutline: glyph(FlashIcon),
  skill: glyph(CubeIcon),
  plugin: glyph(PuzzleIcon),
  terminal: glyph(CommandLineIcon),
  search: glyph(Search01Icon),
  clock: glyph(Clock01Icon),
  /** The stop control's 10px rounded square. */
  background: glyph(SquareArrowDown01Icon),
  stop: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" rx="2" fill="#000"/></svg>',
} as const
