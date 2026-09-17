// FILE: FileEntryIcon.tsx
// Purpose: Shared file/folder glyph for composer, diff, and transcript rows.
// Notes: File-type glyphs come from Hugeicons (generic types) and Simple Icons
//        (react-icons) for language/tool brand marks. Folder glyphs come from
//        FolderClosed/FolderOpen.

import type { FC } from "react"
import {
  Calendar03Icon,
  CommandLineIcon,
  File01Icon,
  File02Icon,
  FileZipIcon,
  GridTableIcon,
  Image01Icon,
  MusicNote01Icon,
  Pdf01Icon,
  Settings01Icon,
  SourceCodeIcon,
  Video01Icon,
} from "@hugeicons/core-free-icons"
import { type IconSvgElement } from "@hugeicons/react"
import { hugeGlyph } from "@/lib/kit/hugeGlyph"
import {
  SiBun,
  SiC,
  SiGit,
  SiJavascript,
  SiJson,
  SiMarkdown,
  SiNpm,
  SiOpenjdk,
  SiPhp,
  SiPython,
  SiReact,
  SiRust,
  SiSvelte,
  SiTypescript,
  SiVercel,
  SiVuedotjs,
} from "react-icons/si"
import { FolderClosed, FolderOpen } from "@/components/kit/FolderClosed"
import { getAttachmentIconName, getFileIconName } from "@/lib/kit/fileIcons"
import { cn } from "@/lib/utils"

type GlyphComponent = FC<{ className?: string }>

// Hugeicons rendered at the same stroke weight as the rest of the app chrome.
function hugeFileIcon(icon: IconSvgElement): GlyphComponent {
  const Glyph = hugeGlyph(icon, 2.5)
  return ({ className }) => <Glyph className={className} />
}

// Logical icon name (from fileIcons.ts) -> glyph component. Brand/language marks
// use Simple Icons; everything else uses a Hugeicons generic file glyph.
const FILE_ICON_COMPONENT_BY_ICON_NAME: Record<string, GlyphComponent> = {
  npm: SiNpm,
  bun: SiBun,
  git: SiGit,
  typescript: SiTypescript,
  react: SiReact,
  javascript: SiJavascript,
  json: SiJson,
  rust: SiRust,
  phyton: SiPython,
  php: SiPhp,
  java: SiOpenjdk,
  c: SiC,
  vue: SiVuedotjs,
  svelte: SiSvelte,
  vercel: SiVercel,
  markdown: SiMarkdown,
  "code-brackets": hugeFileIcon(SourceCodeIcon),
  "file-text": hugeFileIcon(File01Icon),
  "page-text": hugeFileIcon(File02Icon),
  "file-chart": hugeFileIcon(GridTableIcon),
  "calendar-days": hugeFileIcon(Calendar03Icon),
  cmd: hugeFileIcon(CommandLineIcon),
  lock: hugeFileIcon(Settings01Icon),
  "file-png": hugeFileIcon(Image01Icon),
  "file-jpg": hugeFileIcon(Image01Icon),
  "image-alt-text": hugeFileIcon(Image01Icon),
  "file-pdf": hugeFileIcon(Pdf01Icon),
  "file-zip": hugeFileIcon(FileZipIcon),
  video: hugeFileIcon(Video01Icon),
  audio: hugeFileIcon(MusicNote01Icon),
  "settings-gear-1": hugeFileIcon(Settings01Icon),
}

const DEFAULT_FILE_GLYPH = hugeFileIcon(SourceCodeIcon)

const FILE_ICON_COLOR_CLASS_BY_ICON_NAME: Record<string, string> = {
  audio: "text-[#38bdf8]",
  bun: "text-[#f4d7a1]",
  "calendar-days": "text-[#f59e0b]",
  c: "text-[#659ad2]",
  cmd: "text-[#4ade80]",
  "code-brackets": "text-[#9ca3af]",
  "file-jpg": "text-[#22c55e]",
  "file-pdf": "text-[#ef4444]",
  "file-png": "text-[#22c55e]",
  "file-text": "text-[#94a3b8]",
  "file-zip": "text-[#f97316]",
  "page-text": "text-[#94a3b8]",
  git: "text-[#f05032]",
  "image-alt-text": "text-[#22c55e]",
  java: "text-[#f89820]",
  javascript: "text-[#f7df1e]",
  json: "text-[#f5c542]",
  lock: "text-[#f59e0b]",
  markdown: "text-[#6cb6ff]",
  npm: "text-[#cb3837]",
  php: "text-[#777bb4]",
  phyton: "text-[#3776ab]",
  react: "text-[#61dafb]",
  rust: "text-[#dea584]",
  "settings-gear-1": "text-[#a78bfa]",
  svelte: "text-[#ff3e00]",
  typescript: "text-[#3178c6]",
  vercel: "text-foreground",
  video: "text-[#c084fc]",
  vue: "text-[#42b883]",
}

export function FileEntryIcon(props: {
  pathValue: string
  kind: "file" | "directory"
  mimeType?: string | null
  className?: string
  colorMode?: "file" | "inherit"
  expanded?: boolean
}) {
  if (props.kind === "directory") {
    const FolderIcon = props.expanded ? FolderOpen : FolderClosed
    return <FolderIcon className={cn("size-4 shrink-0 text-muted-foreground", props.className)} />
  }

  const iconName = props.mimeType === undefined ? getFileIconName(props.pathValue) : getAttachmentIconName({ name: props.pathValue, mimeType: props.mimeType })
  const Glyph = FILE_ICON_COMPONENT_BY_ICON_NAME[iconName] ?? DEFAULT_FILE_GLYPH
  const colorClassName = props.colorMode === "inherit" ? undefined : (FILE_ICON_COLOR_CLASS_BY_ICON_NAME[iconName] ?? FILE_ICON_COLOR_CLASS_BY_ICON_NAME["code-brackets"])
  return <Glyph className={cn("size-4 shrink-0", props.className, colorClassName)} />
}
