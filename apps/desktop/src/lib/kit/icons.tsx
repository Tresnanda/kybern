import { type FC, type SVGProps } from "react";
import { VscMcp } from "react-icons/vsc";
import { type IconSvgElement } from "@hugeicons/react";
import { hugeGlyph, hugeGlyphFilled } from "./hugeGlyph";
import {
  // --- generic utility glyphs (former Tabler / react-icons set) ---
  AlertCircleIcon as HiAlertCircle,
  Alert02Icon as HiAlertTriangle,
  Archive02Icon as HiArchive,
  ArrowTurnBackwardIcon as HiUndo,
  ArrowLeft01Icon as HiArrowLeft,
  ArrowRight01Icon as HiArrowRight,
  ArrowDown01Icon as HiArrowDown,
  ArrowUp01Icon as HiArrowUp,
  ArrowUpRight01Icon as HiArrowUpRight,
  FlashIcon as HiFlash,
  BrainIcon as HiBrain,
  BugIcon as HiBug,
  Camera01Icon as HiCamera,
  Tick02Icon as HiCheck,
  ChevronDownIcon as HiChevronDown,
  ChevronLeftIcon as HiChevronLeft,
  ChevronRightIcon as HiChevronRight,
  ChevronUpIcon as HiChevronUp,
  UnfoldMoreIcon as HiSelector,
  CheckmarkCircle02Icon as HiCircleCheck,
  LayoutTwoColumnIcon as HiColumns2,
  MoreHorizontalIcon as HiDots,
  Download04Icon as HiDownload,
  LinkSquare02Icon as HiExternalLink,
  EyeIcon as HiEye,
  File01Icon as HiFile,
  Flag01Icon as HiFlag,
  FlaskConicalIcon as HiFlask,
  Folder01Icon as HiFolder,
  FolderOpenIcon as HiFolderOpen,
  HistoryIcon as HiHistory,
  InformationCircleIcon as HiInfo,
  Layout01Icon as HiRows3,
  CheckListIcon as HiListCheck,
  Task01Icon as HiListTodo,
  Loading03Icon as HiLoader,
  ArrowExpand01Icon as HiMaximize,
  ArrowShrink01Icon as HiMinimize,
  MinusSignIcon as HiMinus,
  LaptopIcon as HiLaptop,
  Rotate01Icon as HiDeviceRotate,
  PlugSocketIcon as HiPlugOff,
  ShutDownIcon as HiPower,
  Comment01Icon as HiMessageCircle,
  Moon02Icon as HiMoon,
  Attachment01Icon as HiPaperclip,
  PlusSignIcon as HiPlus,
  RefreshIcon as HiRefresh,
  RotateLeft01Icon as HiRotateCcw,
  StarIcon as HiStar,
  Sun03Icon as HiSun,
  TextWrapIcon as HiTextWrap,
  Delete02Icon as HiTrash,
  Cancel01Icon as HiX,
  GridViewIcon as HiApps,
  SquareSplitHorizontalIcon as HiSplitH,
  SquareSplitVerticalIcon as HiSplitV,
  GithubIcon as HiGithub,
  // --- former Central (signature) glyphs, now Hugeicons ---
  SquareArrowDown01Icon as HcBackgroundTray,
  WorkflowSquare01Icon as HcAgents,
  ArrowTurnForwardIcon as HcSteer,
  ArrowDataTransferHorizontalIcon as HcHandoff,
  CubeIcon as HcSkill,
  PencilEdit02Icon as HcCompose,
  DragDropVerticalIcon as HcDrag,
  PreferenceHorizontalIcon as HcCustomize,
  EraserIcon as HcEraser,
  ArrowUpDownIcon as HcSort,
  RoboticIcon as HcRobot,
  Book02Icon as HcBook,
  HelpCircleIcon as HcQuestion,
  CircleArrowUp01Icon as HcArrowUpCircle,
  CloudSyncIcon as HcCloudSync,
  Edit02Icon as HcChanges,
  Copy01Icon as HcCopy,
  Link01Icon as HcLink,
  GitCompareIcon as HcDiff,
  Note01Icon as HcNotes,
  Clock01Icon as HcClock,
  SourceCodeIcon as HcCode,
  FolderLibraryIcon as HcFolders,
  GiftIcon as HcGift,
  GitCommitIcon as HcCommit,
  GitBranchIcon as HcBranch,
  GitMergeIcon as HcMerge,
  CloudUploadIcon as HcPush,
  GitPullRequestIcon as HcPR,
  GitPullRequestDraftIcon as HcPRDraft,
  GitPullRequestClosedIcon as HcPRClosed,
  GitMergeConflictIcon as HcConflict,
  FilterIcon as HcFilter,
  UserGroupIcon as HcUsers,
  Globe02Icon as HcGlobe,
  SmartPhone01Icon as HcPhone,
  Home01Icon as HcHome,
  SquareLock02Icon as HcLock,
  VolumeHighIcon as HcVolUp,
  VolumeLowIcon as HcVolDown,
  RecordIcon as HcRecord,
  StopIcon as HcStop,
  PuzzleIcon as HcPuzzle,
  HammerIcon as HcHammer,
  KanbanIcon as HcKanban,
  KeyboardIcon as HcKeyboard,
  BubbleChatIcon as HcBubble,
  Comment02Icon as HcSidechat,
  Mic01Icon as HcMic,
  SidebarLeftIcon as HcPanelLeft,
  SidebarRightIcon as HcPanelRight,
  AppWindowMacIcon as HcWindow,
  SidebarLeft01Icon as HcLayoutSidebar,
  PencilIcon as HcPencil,
  PinIcon as HcPin,
  PauseIcon as HcPause,
  PlayIcon as HcPlay,
  Target02Icon as HcGoal,
  Search01Icon as HcSearch,
  Settings01Icon as HcSettings,
  CommandLineIcon as HcConsole,
  GitForkIcon as HcWorktree,
  ShieldCheckIcon as HcShieldCheck,
  ShieldIcon as HcShield,
  Analytics01Icon as HcAnalytics,
  HandIcon as HcHand,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";

// The whole app renders its icons through the Hugeicons free set (stroke-rounded).
// Provider brand logos live in ./Icons; a few brand/file-type marks come from
// Simple Icons (react-icons). This module is the single source for every other glyph.
export type LucideIcon = FC<SVGProps<SVGSVGElement>>;

// Hugeicons default to a thin strokeWidth 1.5; pin every glyph to 2.5 so the icons
// carry enough optical weight next to the app's medium/semibold text instead of
// reading as hairlines. HugeiconsIcon renders a real <svg>, so kit `[&_svg]` sizing
// rules apply. Keep FileEntryIcon/FolderClosed/kit sidebar in step with this value.
const HUGEICON_STROKE_WIDTH = 2.5;

function hugeIcon(icon: IconSvgElement, strokeWidth: number = HUGEICON_STROKE_WIDTH): LucideIcon {
  return hugeGlyph(icon, strokeWidth);
}

// The folder is a large, dense glyph — it reads too heavy at the shared 2.5, so
// folders use a lighter stroke. Keep FolderClosed.tsx in step with this value.
const FOLDER_STROKE_WIDTH = 2;

// Solid variant: the free set is stroke-only, so filled states (play/pause/stop,
// pinned, fast-mode bolt) fill the glyph's paths with currentColor. Simple closed
// shapes become solid; any stroke-only detail (e.g. the pushpin tail) is preserved
// by omitting strokeWidth so the glyph keeps its own path attributes.
function hugeIconFilled(icon: IconSvgElement): LucideIcon {
  return hugeGlyphFilled(icon);
}

export const AppsIcon: LucideIcon = hugeIcon(HiApps);
// Composer stacked-panel glyphs (subagent strip / workflow run card).
export const BackgroundTrayIcon: LucideIcon = hugeIcon(HcBackgroundTray);
export const PanelExpandIcon: LucideIcon = hugeIcon(HiMaximize);
export const PanelCollapseIcon: LucideIcon = hugeIcon(HiMinimize);
export const BackToParentIcon: LucideIcon = hugeIcon(HiUndo);
export const WorkflowIcon: LucideIcon = hugeIcon(HcAgents);
export const SteerIcon: LucideIcon = hugeIcon(HcSteer);
/**
 * Round send control. A chevron's ink sits in the lower half of its viewBox,
 * so centering the 24² box (or a CSS grid shrink-wrap of it) leaves extra
 * space above the peak. Fill the 32px disc and translate the glyph up until
 * padding above the peak matches padding below the legs.
 */
export const ComposerSendArrowIcon: LucideIcon = ({ className, ...props }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden
    className={cn("block size-full origin-center overflow-visible -translate-y-[2px]", className)}
    {...props}
  >
    <path
      d="M6 15L12 9L18 15"
      stroke="currentColor"
      strokeWidth={HUGEICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
export const HandoffIcon: LucideIcon = hugeIcon(HcHandoff);
export const SkillCubeIcon: LucideIcon = hugeIcon(HcSkill);
export const NewThreadIcon: LucideIcon = hugeIcon(HcCompose);
/** The "+" affordance behind every add/create action (Add project, activity header). */
export const AddPlusIcon: LucideIcon = hugeIcon(HiPlus);
/** Grip for drag-to-reorder handles (provider rows, sidebar nav customize). */
export const DragHandleIcon: LucideIcon = hugeIcon(HcDrag);
/** Sliders glyph for "customize this surface" entries. */
export const CustomizeIcon: LucideIcon = hugeIcon(HcCustomize);
export const EraserIcon: LucideIcon = hugeIcon(HcEraser);
export const ArrowLeftIcon = hugeIcon(HiArrowLeft);
export const ArrowRightIcon = hugeIcon(HiArrowRight);
export const ArrowDownIcon = hugeIcon(HiArrowDown);
export const ArrowUpIcon = hugeIcon(HiArrowUp);
export const ArrowUpRightIcon = hugeIcon(HiArrowUpRight);
export const SortIcon: LucideIcon = hugeIcon(HcSort);
// Single source for the robot/agent glyph so every robot affordance (reasoning
// rows, agent-task rows, agent mention chips, subagent menus, agent-activity
// headers) renders one identical icon.
export const BotIcon: LucideIcon = hugeIcon(HcRobot);
export const BookIcon: LucideIcon = hugeIcon(HcBook);
export const BugIcon = hugeIcon(HiBug);
export const CameraIcon = hugeIcon(HiCamera);
export const CheckIcon = hugeIcon(HiCheck);
export const ChevronDownIcon = hugeIcon(HiChevronDown);
export const ChevronLeftIcon = hugeIcon(HiChevronLeft);
export const ChevronRightIcon = hugeIcon(HiChevronRight);
export const ChevronUpIcon = hugeIcon(HiChevronUp);
export const ChevronsUpDownIcon = hugeIcon(HiSelector);
export const CircleAlertIcon = hugeIcon(HiAlertCircle);
export const CircleCheckIcon = hugeIcon(HiCircleCheck);
export const CheckCircle2Icon: LucideIcon = hugeIcon(HiCircleCheck);
// User-input rows: a question-mark circle while the agent waits for an answer,
// and an up-arrow circle once the answer is submitted.
export const CircleQuestionIcon: LucideIcon = hugeIcon(HcQuestion);
export const ArrowUpCircleIcon: LucideIcon = hugeIcon(HcArrowUpCircle);
export const CloudSyncIcon = hugeIcon(HcCloudSync);
export const Columns2Icon = hugeIcon(HiColumns2);
export const ChangesIcon = hugeIcon(HcChanges);
export const CopyIcon = hugeIcon(HcCopy);
export const LinkIcon = hugeIcon(HcLink);
export const DiffIcon = hugeIcon(HcDiff);
export const DownloadIcon = hugeIcon(HiDownload);
// The clock doubles as the automation glyph everywhere it appears (meta chip,
// Automations nav, slash command, created card, environment section).
export const BellIcon: LucideIcon = hugeIcon(HcNotes);
export const ClockIcon = hugeIcon(HcClock);
export const EllipsisIcon = hugeIcon(HiDots);
export const ExternalLinkIcon = hugeIcon(HiExternalLink);
export const EyeIcon = hugeIcon(HiEye);
// Markdown Source/Preview toggle glyphs (raw source = code brackets, rendered
// preview = open eye).
export const CodeIcon: LucideIcon = hugeIcon(HcCode);
export const EyeOpenIcon: LucideIcon = hugeIcon(HiEye);
export const PaperclipIcon = hugeIcon(HiPaperclip);
export const ArchiveIcon = hugeIcon(HiArchive);
export const BrainIcon = hugeIcon(HiBrain);
export const FileIcon = hugeIcon(HiFile);
export const FlagIcon = hugeIcon(HiFlag);
export const FlaskConicalIcon = hugeIcon(HiFlask);
export const FolderIcon = hugeIcon(HiFolder, FOLDER_STROKE_WIDTH);
export const FolderOpenIcon = hugeIcon(HiFolderOpen, FOLDER_STROKE_WIDTH);
// Stacked "folders" glyph used as the single representation of a file tree /
// explorer surface (right-dock explorer, editor Files activity, diff file-tree toggle).
export const FoldersIcon: LucideIcon = hugeIcon(HcFolders, FOLDER_STROKE_WIDTH);
export const GiftIcon: LucideIcon = hugeIcon(HcGift);
export const GitCommitIcon: LucideIcon = hugeIcon(HcCommit);
export const GitBranchIcon: LucideIcon = hugeIcon(HcBranch);
// Forking a thread reuses the branch glyph so fork and branch share one visual.
export const GitForkIcon: LucideIcon = GitBranchIcon;
export const GitMergeIcon: LucideIcon = hugeIcon(HcMerge);
export const GitMergedSimpleIcon: LucideIcon = hugeIcon(HcMerge);
export const PushIcon: LucideIcon = hugeIcon(HcPush);
export const GitHubIcon: LucideIcon = hugeIcon(HiGithub);
export const GitPullRequestIcon = hugeIcon(HcPR);
// Pull-request state glyphs from the same family as "pull-request".
export const GitPullRequestDraftIcon: LucideIcon = hugeIcon(HcPRDraft);
export const GitPullRequestClosedIcon: LucideIcon = hugeIcon(HcPRClosed);
export const GitMergeConflictIcon: LucideIcon = hugeIcon(HcConflict);
// Three descending-width lines — the app's one "filter controls" glyph.
export const FilterIcon: LucideIcon = hugeIcon(HcFilter);
// Two-person glyph for "reviewers"/"people" rows (pull request meta grid).
export const UsersIcon: LucideIcon = hugeIcon(HcUsers);
// One globe for the whole app (browser rows, web search, favicon fallback, local servers).
export const GlobeIcon: LucideIcon = hugeIcon(HcGlobe);
export const WebSearchIcon: LucideIcon = GlobeIcon;
// Handset glyph for the iOS Simulator dock pane.
export const DeviceMobileIcon: LucideIcon = hugeIcon(HcPhone);
// Hardware-button glyphs for the simulator's control rail.
export const DeviceHomeIcon: LucideIcon = hugeIcon(HcHome);
export const DeviceLockIcon: LucideIcon = hugeIcon(HcLock);
export const DeviceVolumeUpIcon: LucideIcon = hugeIcon(HcVolUp);
export const DeviceVolumeDownIcon: LucideIcon = hugeIcon(HcVolDown);
export const DeviceShutterIcon: LucideIcon = hugeIcon(HiCamera);
// Simulator toolbar: start/stop a screen recording, turn the view, power off, detach.
export const DeviceRecordIcon: LucideIcon = hugeIcon(HcRecord);
export const DeviceRecordStopIcon: LucideIcon = hugeIconFilled(HcStop);
export const DeviceRotateIcon = hugeIcon(HiDeviceRotate);
export const DevicePowerIcon = hugeIcon(HiPower);
export const DeviceDetachIcon = hugeIcon(HiPlugOff);
// MCP has no Hugeicons/Simple Icons mark; keep the VS Code MCP glyph.
export const McpIcon: LucideIcon = (props) => (
  <VscMcp className={props.className} style={props.style} />
);
export const PluginIcon: LucideIcon = hugeIcon(HcPuzzle);
// Single hammer/build glyph (tool-call rows, codex provider, "build" scripts).
export const HammerIcon: LucideIcon = hugeIcon(HcHammer);
export const HistoryIcon = hugeIcon(HiHistory);
export const InfoIcon = hugeIcon(HiInfo);
export const KanbanIcon = hugeIcon(HcKanban);
export const KeyboardIcon: LucideIcon = hugeIcon(HcKeyboard);
export const ListChecksIcon = hugeIcon(HiListCheck);
export const ListTodoIcon = hugeIcon(HiListTodo);
export const Loader2Icon = hugeIcon(HiLoader);
export const LoaderCircleIcon = hugeIcon(HiLoader);
export const LoaderIcon = hugeIcon(HiLoader);
export const Maximize2 = hugeIcon(HiMaximize);
export const Minimize2 = hugeIcon(HiMinimize);
export const MessageCircleIcon = hugeIcon(HiMessageCircle);
export const MinusIcon = hugeIcon(HiMinus);
export const ChatBubbleIcon: LucideIcon = hugeIcon(HcBubble);
// Canonical side-chat glyph — every sidechat surface uses this one.
export const SidechatIcon: LucideIcon = hugeIcon(HcSidechat);
export const MicIcon: LucideIcon = hugeIcon(HcMic);
export const PanelLeftIcon = hugeIcon(HcPanelLeft);
export const PanelRightCloseIcon = hugeIcon(HcPanelRight);
export const WindowIcon: LucideIcon = hugeIcon(HcWindow);
export const LayoutSidebarIcon: LucideIcon = hugeIcon(HcLayoutSidebar);
export const PencilIcon: LucideIcon = hugeIcon(HcPencil);
export const PinIcon: LucideIcon = hugeIcon(HcPin);
// Solid pin from the same glyph — used wherever a pin reflects "pinned" status.
export const PinFilledIcon: LucideIcon = hugeIconFilled(HcPin);
export const PauseIcon: LucideIcon = hugeIconFilled(HcPause);
export const PlayIcon: LucideIcon = hugeIconFilled(HcPlay);
// Outline transport glyphs for surfaces that read as neutral actions rather than
// playback state — e.g. the composer goal strip.
export const PauseOutlineIcon: LucideIcon = hugeIcon(HcPause);
export const PlayOutlineIcon: LucideIcon = hugeIcon(HcPlay);
/** Trash can (outline). */
export const TrashCanIcon: LucideIcon = hugeIcon(HiTrash);
// Persistent thread goal ("Pursuing goal" strip, /goal surfaces).
export const GoalIcon: LucideIcon = hugeIcon(HcGoal);
export const Plus = hugeIcon(HiPlus);
export const PlusIcon = hugeIcon(HiPlus);
export const RefreshCwIcon = hugeIcon(HiRefresh);
export const RotateCcwIcon = hugeIcon(HiRotateCcw);
export const Rows3Icon = hugeIcon(HiRows3);
export const SearchIcon: LucideIcon = hugeIcon(HcSearch);
// Single source for the settings gear.
export const SettingsIcon: LucideIcon = hugeIcon(HcSettings);
export const StarIcon = hugeIcon(HiStar);
export const StarFilledIcon = hugeIconFilled(HiStar);
export const SunIcon = hugeIcon(HiSun);
export const MoonIcon = hugeIcon(HiMoon);
export const DeviceLaptopIcon = hugeIcon(HiLaptop);
export const StopIcon: LucideIcon = hugeIconFilled(HcStop);
export const StopFilledIcon: LucideIcon = hugeIconFilled(HcStop);
export const SquareSplitHorizontal: LucideIcon = hugeIcon(HiSplitH);
export const SquareSplitVertical: LucideIcon = hugeIcon(HiSplitV);
// Approval-mode glyphs (composer permission menu: ask / edits / auto / full).
export const HandRaisedIcon: LucideIcon = hugeIcon(HcHand);
export const ShieldCheckIcon: LucideIcon = hugeIcon(HcShieldCheck);
export const ShieldIcon: LucideIcon = hugeIcon(HcShield);
// Usage / analytics (sidebar quick action).
export const AnalyticsIcon: LucideIcon = hugeIcon(HcAnalytics);
// Dotted "annotation" chat bubble — the temporary thread marker shown on the
// composer toggle and beside temporary threads in the sidebar.
const TemporaryThreadGlyph = hugeIcon(HiMessageCircle);
export const TemporaryThreadIcon: LucideIcon = ({ className, ...props }) => (
  <TemporaryThreadGlyph className={cn("size-3.5 shrink-0", className)} {...props} />
);
export const TerminalIcon = hugeIcon(HcConsole);
export const TerminalSquare = hugeIcon(HcConsole);
export const TerminalSquareIcon = hugeIcon(HcConsole);
export const TextWrapIcon = hugeIcon(HiTextWrap);
export const Trash2 = hugeIcon(HiTrash);
export const TriangleAlertIcon = hugeIcon(HiAlertTriangle);
export const Undo2Icon = hugeIcon(HiUndo);
export const WorktreeIcon = hugeIcon(HcWorktree);
export const XIcon = hugeIcon(HiX);
export const ZapIcon = hugeIcon(HiFlash);
// Single source for the fast-mode glyph — one solid lightning bolt.
export const FastModeIcon: LucideIcon = hugeIconFilled(HiFlash);
// Outline twin of FastModeIcon for the inactive toggle state.
export const FastModeOutlineIcon: LucideIcon = hugeIcon(HiFlash);
