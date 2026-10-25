import { AppWindowMacIcon, CommandLineIcon, Delete02Icon, FolderLibraryIcon, GitCompareIcon, GitCommitIcon, GridViewIcon, MapsIcon, ArrowReloadHorizontalIcon, WorkflowSquare01Icon } from '@hugeicons/core-free-icons'
import { glyph } from '../icons.tsx'

// The same marks as desktop lib/kit/icons.tsx.
export const DOCK_ICONS = {
  trash: glyph(Delete02Icon),
  activity: glyph(WorkflowSquare01Icon),
  changes: glyph(GitCompareIcon),
  terminal: glyph(CommandLineIcon),
  explorer: glyph(FolderLibraryIcon, 2),
  artifacts: glyph(GridViewIcon),
  preview: glyph(AppWindowMacIcon),
  commit: glyph(GitCommitIcon),
  map: glyph(MapsIcon),
  refresh: glyph(ArrowReloadHorizontalIcon),
}
