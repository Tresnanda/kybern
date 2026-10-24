// Sidebar, rail and title-bar glyphs: the same Hugeicons the desktop maps in
// `lib/kit/icons.tsx` (names in the comments), at the kit stroke (2.25; folders
// 2). Pass to `<Icon source={…}>`.
import {
  Analytics01Icon,
  AppWindowMacIcon,
  Archive02Icon,
  ArrowDataTransferHorizontalIcon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowTurnBackwardIcon,
  ArrowUp01Icon,
  Cancel01Icon,
  Delete02Icon,
  ImageUploadIcon,
  CheckListIcon,
  CheckmarkCircle02Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  Clock01Icon,
  CommandIcon,
  Edit03Icon,
  FilterIcon,
  Folder01Icon,
  FoldersIcon,
  RepositoryIcon,
  Alert02Icon,
  File02Icon,
  ViewIcon,
  LinkSquare02Icon,
  FolderOpenIcon,
  GitBranchIcon,
  GitForkIcon,
  GitPullRequestIcon,
  Globe02Icon,
  Home01Icon,
  InformationCircleIcon,
  LaptopIcon,
  Loading03Icon,
  Moon02Icon,
  MoreHorizontalIcon,
  Note01Icon,
  Notification03Icon,
  PencilEdit02Icon,
  PinIcon,
  PlusSignIcon,
  RefreshIcon,
  Search01Icon,
  Settings01Icon,
  SidebarLeft01Icon,
  SidebarRightIcon,
  SquareSplitHorizontalIcon,
  SquareSplitVerticalIcon,
  LayoutTwoColumnIcon,
  StopIcon,
  Sun03Icon,
  Tick02Icon,
  UserGroupIcon,
} from '@hugeicons/core-free-icons'
import { filled, glyph } from '../icons.tsx'

export const N = {
  home: glyph(Home01Icon),
  note: glyph(Note01Icon),
  /** `ListChecksIcon` = CheckList. */
  tasks: glyph(CheckListIcon),
  pullRequest: glyph(GitPullRequestIcon),
  /** `AnalyticsIcon`. */
  usage: glyph(Analytics01Icon),
  settings: glyph(Settings01Icon),
  search: glyph(Search01Icon),
  bell: glyph(Notification03Icon),
  laptop: glyph(LaptopIcon),
  globe: glyph(Globe02Icon),
  /** `NewThreadIcon` = PencilEdit02. */
  newThread: glyph(PencilEdit02Icon),
  /** `PencilIcon` = Edit03 (draft marker, Rename). */
  pencil: glyph(Edit03Icon),
  clock: glyph(Clock01Icon),
  folder: glyph(Folder01Icon, 2),
  folderOpen: glyph(FolderOpenIcon, 2),
  /** Group projects (several repositories under one folder): stacked folders. */
  folders: glyph(FoldersIcon, 2),
  /** One git repository of a group. */
  repo: glyph(RepositoryIcon),
  /** A missing member, an outside change. */
  alert: glyph(Alert02Icon),
  /** An instructions file (AGENTS.md, CLAUDE.md). */
  file: glyph(File02Icon),
  /** Preview. */
  eye: glyph(ViewIcon),
  /** Opens elsewhere (GitHub, Finder). */
  external: glyph(LinkSquare02Icon),
  chevronRight: glyph(ChevronRightIcon),
  chevronDown: glyph(ChevronDownIcon),
  arrowLeft: glyph(ArrowLeft01Icon),
  arrowRight: glyph(ArrowRight01Icon),
  arrowUp: glyph(ArrowUp01Icon),
  arrowDown: glyph(ArrowDown01Icon),
  /** `ArchiveIcon` = Archive02. */
  archive: glyph(Archive02Icon),
  /** `Trash2Icon` = Delete02 (Delete space). */
  trash: glyph(Delete02Icon),
  /** The space editor's image well. */
  imageUpload: glyph(ImageUploadIcon),
  pin: glyph(PinIcon),
  pinFilled: filled(PinIcon),
  /** `WorktreeIcon` = GitFork. */
  worktree: glyph(GitForkIcon),
  branch: glyph(GitBranchIcon),
  /** `UsersIcon` = UserGroup (Create coordinator). */
  users: glyph(UserGroupIcon),
  filter: glyph(FilterIcon),
  plus: glyph(PlusSignIcon),
  /** `HandoffIcon`. */
  handoff: glyph(ArrowDataTransferHorizontalIcon),
  /** `EllipsisIcon`. */
  ellipsis: glyph(MoreHorizontalIcon),
  /** `PanelRightCloseIcon` = SidebarRight. */
  panelRight: glyph(SidebarRightIcon),
  /** `WindowIcon` = AppWindowMac. */
  window: glyph(AppWindowMacIcon),
  /** `LayoutSidebarIcon` = SidebarLeft01. */
  layoutSidebar: glyph(SidebarLeft01Icon),
  /** Split right / Open to the right: hugeicons' `SquareSplitHorizontal` draws the vertical divider (a left | right split). */
  splitRight: glyph(SquareSplitHorizontalIcon),
  /** Split down / Open below: `SquareSplitVertical` draws the horizontal divider. */
  splitDown: glyph(SquareSplitVerticalIcon),
  /** `BackToParentIcon` = ArrowTurnBackward. */
  backToParent: glyph(ArrowTurnBackwardIcon),
  stop: filled(StopIcon),
  check: glyph(Tick02Icon),
  x: glyph(Cancel01Icon),
  /** `Columns2Icon` = LayoutTwoColumn. */
  columns: glyph(LayoutTwoColumnIcon),
  command: glyph(CommandIcon),
  info: glyph(InformationCircleIcon),
  refresh: glyph(RefreshIcon),
  loader: glyph(Loading03Icon),
  circleCheck: glyph(CheckmarkCircle02Icon),
  sun: glyph(Sun03Icon),
  moon: glyph(Moon02Icon),
} as const
