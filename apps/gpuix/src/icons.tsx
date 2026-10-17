// The desktop renders its glyphs from the Hugeicons free set at a 2.25 stroke
// (`apps/desktop/src/lib/kit/icons.tsx`). GPUIX paints a monochrome `<svg>` from
// raw source and tints it with `style.color`, so each glyph is serialized once
// with a black stroke and the same widths.
import {
  Analytics01Icon,
  ArrowDataTransferHorizontalIcon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  Clock01Icon,
  Copy01Icon,
  Folder01Icon,
  FolderOpenIcon,
  HammerIcon,
  HandIcon,
  Home01Icon,
  LaptopIcon,
  MoreHorizontalIcon,
  Note01Icon,
  Notification03Icon,
  PencilEdit02Icon,
  PinIcon,
  PlusSignIcon,
  Search01Icon,
  Settings01Icon,
  ShieldIcon,
  SidebarLeftIcon,
  SidebarRightIcon,
  AppWindowMacIcon,
  Task01Icon,
  GitPullRequestIcon,
  Robot01Icon,
  CheckListIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SidebarLeft01Icon,
  CommandLineIcon,
  File01Icon,
  Edit02Icon,
  Globe02Icon,
  UserGroupIcon,
} from '@hugeicons/core-free-icons'
import type { StyleDesc } from '@gpuix/react'

type IconData = readonly (readonly [string, Record<string, unknown>])[]

const STROKE = 2.25
const FOLDER_STROKE = 2

function kebab(name: string) {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

function toSvg(icon: IconData, strokeWidth: number): string {
  const body = icon
    .map(([tag, attrs]) => {
      const out: string[] = []
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'key') continue
        if (k === 'stroke' || k === 'strokeWidth') continue
        if (k === 'fill' && v !== 'none') {
          out.push(`fill="#000"`)
          continue
        }
        out.push(`${kebab(k)}="${String(v)}"`)
      }
      out.push(`stroke="#000"`, `stroke-width="${strokeWidth}"`)
      return `<${tag} ${out.join(' ')}/>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">${body}</svg>`
}

/** Serialize a Hugeicons glyph at the kit stroke (2.25; folders 2, send 2). */
export const glyph = (icon: unknown, stroke = STROKE) => toSvg(icon as IconData, stroke)

/** Solid variant, like `hugeGlyphFilled`: paths filled, no stroke override. */
export function filled(icon: unknown): string {
  return toSvg(icon as IconData, 0).replace(/ stroke-width="0"/g, '').replace(/fill="none"\/>/g, 'fill="#000"/>').replace(/<(path|circle|rect)((?:(?!fill=)[^>])*)\/>/g, '<$1$2 fill="#000"/>')
}

export const ICONS = {
  home: glyph(Home01Icon),
  note: glyph(Note01Icon),
  tasks: glyph(Task01Icon),
  pullRequest: glyph(GitPullRequestIcon),
  usage: glyph(Analytics01Icon),
  settings: glyph(Settings01Icon),
  search: glyph(Search01Icon),
  bell: glyph(Notification03Icon),
  laptop: glyph(LaptopIcon),
  compose: glyph(PencilEdit02Icon),
  clock: glyph(Clock01Icon),
  folder: glyph(Folder01Icon, FOLDER_STROKE),
  folderOpen: glyph(FolderOpenIcon, FOLDER_STROKE),
  chevronDown: glyph(ChevronDownIcon),
  chevronRight: glyph(ChevronRightIcon),
  arrowLeft: glyph(ArrowLeft01Icon),
  arrowRight: glyph(ArrowRight01Icon),
  arrowDown: glyph(ArrowDown01Icon),
  send: glyph(ArrowUp01Icon, 2),
  plus: glyph(PlusSignIcon),
  hand: glyph(HandIcon),
  shield: glyph(ShieldIcon),
  handoff: glyph(ArrowDataTransferHorizontalIcon),
  ellipsis: glyph(MoreHorizontalIcon),
  panelLeft: glyph(SidebarLeftIcon),
  panelRight: glyph(SidebarRightIcon),
  window: glyph(AppWindowMacIcon),
  pin: glyph(PinIcon),
  copy: glyph(Copy01Icon),
  hammer: glyph(HammerIcon),
  bot: glyph(Robot01Icon),
  checklist: glyph(CheckListIcon),
  layoutSidebar: glyph(SidebarLeft01Icon),
  console: glyph(CommandLineIcon),
  file: glyph(File01Icon),
  edit: glyph(Edit02Icon),
  globe: glyph(Globe02Icon),
  users: glyph(UserGroupIcon),
  pinFilled: filled(PinIcon),
} as const

export type IconName = keyof typeof ICONS

/** A kit glyph by name, or any monochrome SVG `source` (see `glyph`). */
export function Icon({ name, source, size = 16, color, style }: { name?: IconName; source?: string; size?: number; color: string; style?: StyleDesc }) {
  return (
    <svg
      source={source ?? ICONS[name!]}
      style={{ width: size, height: size, flexShrink: 0, color, ...style }}
    />
  )
}
