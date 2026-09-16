import { type FC, type SVGProps } from "react";
import {
  type Icon,
  type IconProps,
  type IconWeight,
  AppWindow,
  Archive,
  ArrowArcLeft,
  ArrowArcRight,
  ArrowBendDownRight,
  ArrowBendUpLeft,
  ArrowCircleUp,
  ArrowCounterClockwise,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  ArrowUUpLeft,
  ArrowUp,
  ArrowUpRight,
  ArrowsClockwise,
  ArrowsDownUp,
  ArrowsIn,
  ArrowsLeftRight,
  ArrowsOut,
  ArrowsSplit,
  Bell,
  Book,
  BracketsCurly,
  Brain,
  Bug,
  Calendar,
  Camera,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  CaretUpDown,
  ChartBar,
  ChatCircle,
  ChatTeardrop,
  ChatTeardropDots,
  ChatTeardropText,
  Check,
  CheckCircle,
  CircleNotch,
  Clock,
  ClockCounterClockwise,
  CloudArrowUp,
  Code,
  Columns,
  Copy,
  CornersIn,
  CornersOut,
  Cube,
  DeviceMobile,
  DeviceRotate,
  DotsSixVertical,
  DotsThree,
  DownloadSimple,
  Eraser,
  Eye,
  FadersHorizontal,
  File,
  FileAudio,
  FileC,
  FileCode,
  FileDoc,
  FileImage,
  FileJpg,
  FileJs,
  FileJsx,
  FileMd,
  FilePdf,
  FilePng,
  FilePy,
  FileRs,
  FileText,
  FileTs,
  FileVideo,
  FileVue,
  FileXls,
  FileZip,
  Files,
  Flag,
  Flask,
  Folder,
  FolderOpen,
  Folders,
  Funnel,
  Gear,
  Gift,
  GitBranch,
  GitCommit,
  GitDiff,
  GitFork,
  GitMerge,
  GitPullRequest,
  GithubLogo,
  Globe,
  Hammer,
  HandPalm,
  House,
  Info,
  Kanban,
  Keyboard,
  Laptop,
  Lightning,
  Link,
  List,
  ListChecks,
  Lock,
  MagnifyingGlass,
  Microphone,
  Minus,
  Moon,
  NotePencil,
  Package,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plugs,
  PlugsConnected,
  Plus as PhosphorPlus,
  Power,
  PushPin,
  PuzzlePiece,
  Question,
  Record,
  Robot,
  Rows,
  ShieldCheck,
  ShieldStar,
  Sidebar,
  SidebarSimple,
  SpeakerHigh,
  SpeakerLow,
  SquareSplitHorizontal as PhosphorSquareSplitHorizontal,
  SquareSplitVertical as PhosphorSquareSplitVertical,
  SquaresFour,
  Star,
  Stop,
  Sun,
  Target,
  Terminal,
  TerminalWindow,
  TextAlignLeft,
  Trash,
  TrayArrowDown,
  TreeStructure,
  Triangle,
  Users,
  Warning,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

// Keep the existing icon API stable while the app moves from Central/Tabler to Phosphor.
export type LucideIcon = FC<SVGProps<SVGSVGElement> & { size?: string | number }>;

// Phosphor bold is the heaviest outline (1.5px at 16px). Folder's enclosed
// silhouette already matches nearby labels at that weight. Sparse line glyphs
// (pencil, clock, git, charts) still read thin, so the kit default is fill.
// Folder/FolderOpen/Folders stay bold — do not lighten them.
const KIT_ICON_WEIGHT: IconWeight = "fill";
const KIT_FOLDER_WEIGHT: IconWeight = "bold";

// Central glyphs were a masked square span. Phosphor SVGs use a 256 viewBox.
// Putting `inline-flex` + `min-width: <slot>` on the SVG itself lets WebKit use
// that viewBox as flex min-content (scaling mounted 802 messages). The square
// slot is a span — no viewBox — with equal sides so the glyph cannot squash.
// The inner SVG zeros min-content and fills 100% so it cannot inflate rows.
const KIT_ICON_SLOT_CLASS = "inline-flex size-4 shrink-0 overflow-hidden align-middle";

type KitIconProps = SVGProps<SVGSVGElement> & { size?: string | number };

/** Resolve a square slot so the wrapper's width and height stay equal. */
function kitIconSlotSize(
  explicit: string | number | undefined,
  className?: string,
): string | number {
  if (explicit != null && explicit !== "") return explicit;
  if (className) {
    const arbitrary = className.match(/(?:^|\s)(?:!)?size-\[([^\]]+)\]/);
    if (arbitrary?.[1]) return arbitrary[1];
    const numbered = className.match(/(?:^|\s)(?:!)?size-(\d+(?:\.\d+)?)(?=\s|$)/);
    if (numbered?.[1]) return `${Number(numbered[1]) * 0.25}rem`;
  }
  return 16;
}

function renderPhosphor(
  Component: Icon,
  { className, style, color, width, height, size, ...rest }: KitIconProps,
  extras: { weight?: IconWeight; mirrored?: boolean } = {},
) {
  const slot = kitIconSlotSize(size ?? width ?? height, className);
  const explicitSize = size ?? width ?? height;
  return (
    <span
      className={cn(
        explicitSize == null ? KIT_ICON_SLOT_CLASS : "inline-flex shrink-0 overflow-hidden align-middle",
        className,
      )}
      style={{
        ...style,
        width: slot,
        height: slot,
        minWidth: slot,
        minHeight: slot,
        maxWidth: slot,
        maxHeight: slot,
        aspectRatio: "1 / 1",
        overflow: "hidden",
        flexShrink: 0,
      }}
      aria-hidden
    >
      <Component
        {...(rest as Partial<IconProps>)}
        className="block size-full min-h-0 min-w-0"
        style={{ width: "100%", height: "100%", minWidth: 0, minHeight: 0, overflow: "hidden", display: "block" }}
        color={typeof color === "string" ? color : undefined}
        weight={extras.weight ?? KIT_ICON_WEIGHT}
        mirrored={extras.mirrored}
        overflow="hidden"
        preserveAspectRatio="xMidYMid meet"
        size="100%"
      />
    </span>
  );
}

function adaptIcon(Component: Icon, weight: IconWeight = KIT_ICON_WEIGHT): LucideIcon {
  function AdaptedIcon(props: KitIconProps) {
    return renderPhosphor(Component, props, { weight });
  }
  AdaptedIcon.displayName = Component.displayName ?? Component.name;
  return AdaptedIcon;
}

function adaptMirrored(Component: Icon, weight: IconWeight = KIT_ICON_WEIGHT): LucideIcon {
  function AdaptedIcon(props: KitIconProps) {
    return renderPhosphor(Component, props, { weight, mirrored: true });
  }
  AdaptedIcon.displayName = `${Component.displayName ?? Component.name}Mirrored`;
  return AdaptedIcon;
}

export const AppsIcon = adaptIcon(SquaresFour);
export const BackgroundTrayIcon = adaptIcon(TrayArrowDown);
export const PanelExpandIcon = adaptIcon(CornersOut);
export const PanelCollapseIcon = adaptIcon(CornersIn);
export const BackToParentIcon = adaptIcon(ArrowBendUpLeft);
export const WorkflowIcon = adaptIcon(TreeStructure);
export const SteerIcon = adaptIcon(ArrowBendDownRight);
export const ComposerSendArrowIcon = adaptIcon(ArrowUp);
export const HandoffIcon = adaptIcon(ArrowsLeftRight);
export const SkillCubeIcon = adaptIcon(Cube);
export const NewThreadIcon = adaptIcon(NotePencil);
/** The "+" affordance behind every add/create action (Add project, activity header). */
export const AddPlusIcon = adaptIcon(PhosphorPlus);
/** 2x3 dot grip for drag-to-reorder handles (provider rows, sidebar nav customize). */
export const DragHandleIcon = adaptIcon(DotsSixVertical);
/** Sliders glyph for "customize this surface" entries. */
export const CustomizeIcon = adaptIcon(FadersHorizontal);
export const EraserIcon = adaptIcon(Eraser);
export const ArrowLeftIcon = adaptIcon(ArrowLeft);
export const ArrowRightIcon = adaptIcon(ArrowRight);
export const ArrowDownIcon = adaptIcon(ArrowDown);
export const ArrowUpIcon = adaptIcon(ArrowUp);
export const ArrowUpRightIcon = adaptIcon(ArrowUpRight);
export const HistoryBackIcon = adaptIcon(ArrowArcLeft);
export const HistoryForwardIcon = adaptIcon(ArrowArcRight);
export const SortIcon = adaptIcon(ArrowsDownUp);
// Single source for the robot/agent glyph. Every robot affordance (reasoning rows,
// agent-task rows, mention chips, subagent menus) renders this one Phosphor icon.
export const AGENT_ROBOT_ICON_NAME = "robot";
export const BotIcon = adaptIcon(Robot);
export const BookIcon = adaptIcon(Book);
export const BugIcon = adaptIcon(Bug);
export const CameraIcon = adaptIcon(Camera);
export const CheckIcon = adaptIcon(Check);
export const ChevronDownIcon = adaptIcon(CaretDown);
export const ChevronLeftIcon = adaptIcon(CaretLeft);
export const ChevronRightIcon = adaptIcon(CaretRight);
export const ChevronUpIcon = adaptIcon(CaretUp);
export const ChevronsUpDownIcon = adaptIcon(CaretUpDown);
export const CircleAlertIcon = adaptIcon(WarningCircle);
export const CircleCheckIcon = adaptIcon(CheckCircle);
export const CheckCircle2Icon = adaptIcon(CheckCircle);
export const CircleQuestionIcon = adaptIcon(Question);
export const ArrowUpCircleIcon = adaptIcon(ArrowCircleUp);
export const CloudSyncIcon = adaptIcon(ArrowsClockwise);
export const Columns2Icon = adaptIcon(Columns);
export const ChangesIcon = adaptIcon(Files);
export const CopyIcon = adaptIcon(Copy);
export const LinkIcon = adaptIcon(Link);
export const DiffIcon = adaptIcon(GitDiff);
export const DownloadIcon = adaptIcon(DownloadSimple);
export const BellIcon = adaptIcon(Bell);
export const ClockIcon = adaptIcon(Clock);
export const EllipsisIcon = adaptIcon(DotsThree);
export const ExternalLinkIcon = adaptIcon(ArrowSquareOut);
export const EyeIcon = adaptIcon(Eye);
export const CodeIcon = adaptIcon(Code);
export const EyeOpenIcon = adaptIcon(Eye);
export const PaperclipIcon = adaptIcon(Paperclip);
export const ArchiveIcon = adaptIcon(Archive);
export const BrainIcon = adaptIcon(Brain);
export const FileIcon = adaptIcon(File);
export const FlagIcon = adaptIcon(Flag);
export const FlaskConicalIcon = adaptIcon(Flask);
export const FolderIcon = adaptIcon(Folder, KIT_FOLDER_WEIGHT);
export const FolderOpenIcon = adaptIcon(FolderOpen, KIT_FOLDER_WEIGHT);
export const FoldersIcon = adaptIcon(Folders, KIT_FOLDER_WEIGHT);
export const GiftIcon = adaptIcon(Gift);
export const GitCommitIcon = adaptIcon(GitCommit);
export const GitBranchIcon = adaptIcon(GitBranch);
export const GitForkIcon = adaptIcon(GitFork);
export const GitMergeIcon = adaptIcon(GitMerge);
export const GitMergedSimpleIcon = adaptIcon(GitMerge);
export const PushIcon = adaptIcon(CloudArrowUp);
export const GitHubIcon = adaptIcon(GithubLogo);
export const GitPullRequestIcon = adaptIcon(GitPullRequest);
export const GitPullRequestDraftIcon = adaptIcon(GitPullRequest);
export const GitPullRequestClosedIcon = adaptIcon(GitPullRequest);
export const GitMergeConflictIcon = adaptIcon(Warning);
export const GitCompareIcon = adaptIcon(GitDiff);
export const FilterIcon = adaptIcon(Funnel);
export const UsersIcon = adaptIcon(Users);
export const GlobeIcon = adaptIcon(Globe);
export const WebSearchIcon: LucideIcon = GlobeIcon;
export const DeviceMobileIcon = adaptIcon(DeviceMobile);
export const DeviceHomeIcon = adaptIcon(House);
export const DeviceLockIcon = adaptIcon(Lock);
export const DeviceVolumeUpIcon = adaptIcon(SpeakerHigh);
export const DeviceVolumeDownIcon = adaptIcon(SpeakerLow);
export const DeviceShutterIcon = adaptIcon(Camera);
export const DeviceRecordIcon = adaptIcon(Record);
export const DeviceRecordStopIcon = adaptIcon(Stop, "fill");
export const DeviceRotateIcon = adaptIcon(DeviceRotate);
export const DevicePowerIcon = adaptIcon(Power);
export const DeviceDetachIcon = adaptIcon(Plugs);
export const McpIcon = adaptIcon(PlugsConnected);
export const PluginIcon = adaptIcon(PuzzlePiece);
export const HammerIcon = adaptIcon(Hammer);
export const HistoryIcon = adaptIcon(ClockCounterClockwise);
export const InfoIcon = adaptIcon(Info);
export const KanbanIcon = adaptIcon(Kanban);
export const KeyboardIcon = adaptIcon(Keyboard);
export const ListChecksIcon = adaptIcon(ListChecks);
export const ListTodoIcon = adaptIcon(List);
export const Loader2Icon = adaptIcon(CircleNotch, KIT_FOLDER_WEIGHT);
export const LoaderCircleIcon = adaptIcon(CircleNotch, KIT_FOLDER_WEIGHT);
export const LoaderIcon = adaptIcon(CircleNotch, KIT_FOLDER_WEIGHT);
export const Maximize2 = adaptIcon(ArrowsOut);
export const Minimize2 = adaptIcon(ArrowsIn);
export const MessageCircleIcon = adaptIcon(ChatCircle);
export const MinusIcon = adaptIcon(Minus);
export const ChatBubbleIcon = adaptIcon(ChatTeardropText);
export const SidechatIcon = adaptIcon(ChatTeardrop);
export const MicIcon = adaptIcon(Microphone);
export const PanelLeftIcon = adaptIcon(Sidebar);
export const PanelRightCloseIcon = adaptMirrored(SidebarSimple);
export const WindowIcon = adaptIcon(AppWindow);
export const LayoutSidebarIcon = adaptIcon(Sidebar);
export const PencilIcon = adaptIcon(Pencil);
export const PinIcon = adaptIcon(PushPin);
export const PinFilledIcon = adaptIcon(PushPin, "fill");
export const PauseIcon = adaptIcon(Pause, "fill");
export const PlayIcon = adaptIcon(Play, "fill");
export const PauseOutlineIcon = adaptIcon(Pause, KIT_FOLDER_WEIGHT);
export const PlayOutlineIcon = adaptIcon(Play, KIT_FOLDER_WEIGHT);
export const TrashCanIcon = adaptIcon(Trash);
export const GoalIcon = adaptIcon(Target);
export const PlusIcon = adaptIcon(PhosphorPlus);
export const Plus = PlusIcon;
export const RefreshCwIcon = adaptIcon(ArrowsClockwise);
export const RotateCcwIcon = adaptIcon(ArrowCounterClockwise);
export const Rows3Icon = adaptIcon(Rows);
export const SearchIcon = adaptIcon(MagnifyingGlass);
export const SettingsIcon = adaptIcon(Gear);
export const StarIcon = adaptIcon(Star);
export const StarFilledIcon = adaptIcon(Star, "fill");
export const SunIcon = adaptIcon(Sun);
export const MoonIcon = adaptIcon(Moon);
export const DeviceLaptopIcon = adaptIcon(Laptop);
export const StopIcon = adaptIcon(Stop, "fill");
export const StopFilledIcon = adaptIcon(Stop, "fill");
export const SquareSplitHorizontal = adaptIcon(PhosphorSquareSplitHorizontal);
export const SquareSplitVertical = adaptIcon(PhosphorSquareSplitVertical);
const TemporaryThreadGlyph = adaptIcon(ChatTeardropDots);
export const TemporaryThreadIcon: LucideIcon = ({ className, ...props }) => (
  <TemporaryThreadGlyph className={cn("size-3.5 shrink-0", className)} {...props} />
);
export const TerminalIcon = adaptIcon(TerminalWindow);
export const TerminalSquare = TerminalIcon;
export const TerminalSquareIcon = TerminalIcon;
export const TextWrapIcon = adaptIcon(TextAlignLeft);
export const Trash2 = adaptIcon(Trash);
export const TriangleAlertIcon = adaptIcon(Warning);
export const Undo2Icon = adaptIcon(ArrowUUpLeft);
export const WorktreeIcon = adaptIcon(ArrowsSplit);
export const XIcon = adaptIcon(X);
export const ZapIcon = adaptIcon(Lightning);
export const FastModeIcon = adaptIcon(Lightning, "fill");
export const FastModeOutlineIcon = adaptIcon(Lightning, KIT_FOLDER_WEIGHT);
export const HandRaisedIcon = adaptIcon(HandPalm);
export const ShieldCodeIcon = adaptIcon(ShieldCheck);
export const ShieldAccessIcon = adaptIcon(ShieldStar);
export const AnalyticsIcon = adaptIcon(ChartBar);

/** File-type glyphs for composer, diff, and transcript rows. Keys match `fileIcons.ts`. */
export const FILE_ENTRY_ICONS: Record<string, LucideIcon> = {
  audio: adaptIcon(FileAudio),
  bun: adaptIcon(Cube),
  "calendar-days": adaptIcon(Calendar),
  c: adaptIcon(FileC),
  cmd: adaptIcon(Terminal),
  "code-brackets": adaptIcon(BracketsCurly),
  "file-jpg": adaptIcon(FileJpg),
  "file-pdf": adaptIcon(FilePdf),
  "file-png": adaptIcon(FilePng),
  "file-text": adaptIcon(FileText),
  "file-zip": adaptIcon(FileZip),
  "page-text": adaptIcon(FileDoc),
  git: adaptIcon(GitBranch),
  "image-alt-text": adaptIcon(FileImage),
  java: adaptIcon(FileCode),
  javascript: adaptIcon(FileJs),
  json: adaptIcon(BracketsCurly),
  lock: adaptIcon(Lock),
  markdown: adaptIcon(FileMd),
  npm: adaptIcon(Package),
  php: adaptIcon(FileCode),
  phyton: adaptIcon(FilePy),
  react: adaptIcon(FileJsx),
  rust: adaptIcon(FileRs),
  "settings-gear-1": adaptIcon(Gear),
  svelte: adaptIcon(FileCode),
  typescript: adaptIcon(FileTs),
  vercel: adaptIcon(Triangle),
  video: adaptIcon(FileVideo),
  vue: adaptIcon(FileVue),
  "file-chart": adaptIcon(FileXls),
};
