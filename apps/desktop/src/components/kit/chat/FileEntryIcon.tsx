// FILE: FileEntryIcon.tsx
// Purpose: Shared file/folder glyph for composer, diff, and transcript rows.

import { FolderClosed, FolderOpen } from "@/components/kit/FolderClosed"
import { CentralIcon } from "@/lib/kit/central-icons"
import { getAttachmentIconName, getFileIconName } from "@/lib/kit/fileIcons"
import { cn } from "@/lib/utils"

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
  const colorClassName = props.colorMode === "inherit" ? undefined : (FILE_ICON_COLOR_CLASS_BY_ICON_NAME[iconName] ?? FILE_ICON_COLOR_CLASS_BY_ICON_NAME["code-brackets"])
  return <CentralIcon name={iconName} className={cn("size-4 shrink-0", props.className, colorClassName)} />
}
