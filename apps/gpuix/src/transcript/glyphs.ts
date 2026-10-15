// Transcript glyphs: the same Hugeicons the desktop transcript imports from
// `lib/kit/icons.tsx` (names in the comments), serialized once at the kit stroke.
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowTurnBackwardIcon,
  Attachment01Icon,
  BrainIcon,
  BubbleChatIcon,
  CheckListIcon,
  CheckmarkSquare04Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ComputerTerminal01Icon,
  Copy01Icon,
  CubeIcon,
  Edit02Icon,
  Edit03Icon,
  EyeIcon,
  File01Icon,
  GithubIcon,
  Globe02Icon,
  HammerIcon,
  HelpCircleIcon,
  LaptopIcon,
  MoreHorizontalIcon,
  Note01Icon,
  Robot01Icon,
  Search01Icon,
  SidebarRightIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { glyph } from '../icons.tsx'

/** `McpIcon` is react-icons' VscMcp (a filled glyph on a 16×17 box). */
const MCP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 17"><path fill-rule="evenodd" clip-rule="evenodd" fill="#000" d="M14.5565 8.46765C14.5385 8.48615 14.5205 8.50415 14.5025 8.52165L8.69846 14.2132C8.62596 14.2837 8.62446 14.3992 8.69496 14.4717C8.69596 14.4732 8.69746 14.4742 8.69846 14.4752L9.89046 15.6447C10.1075 15.8557 10.1125 16.2032 9.90146 16.4207C9.89796 16.4242 9.89446 16.4282 9.89046 16.4317C9.66696 16.6487 9.31196 16.6487 9.08846 16.4317L7.89646 15.2632C7.38946 14.7707 7.37796 13.9602 7.87046 13.4532C7.87896 13.4442 7.88746 13.4357 7.89646 13.4272L13.7005 7.73515C14.352 7.10065 14.3665 6.05815 13.732 5.40665C13.7215 5.39615 13.711 5.38565 13.7005 5.37515L13.667 5.34265C12.998 4.69165 11.9325 4.69065 11.2625 5.34065L6.48096 10.0302L6.47946 10.0317L6.41396 10.0962C6.19046 10.3137 5.83446 10.3137 5.61146 10.0962C5.39446 9.88465 5.38946 9.53765 5.60046 9.32015C5.60396 9.31665 5.60746 9.31265 5.61146 9.30915L10.46 4.55365C11.1105 3.91815 11.123 2.87565 10.4875 2.22515C10.478 2.21515 10.468 2.20565 10.458 2.19565C9.78796 1.54365 8.72096 1.54365 8.05146 2.19565L1.63496 8.48815C1.41146 8.70515 1.05646 8.70515 0.832957 8.48815C0.615957 8.27715 0.610957 7.92965 0.821957 7.71215C0.825457 7.70865 0.828957 7.70465 0.832957 7.70115L7.24996 1.40815C8.36596 0.321652 10.1445 0.321652 11.2605 1.40815C11.8905 2.02065 12.189 2.89815 12.063 3.76815C12.9435 3.64315 13.8325 3.93365 14.469 4.55465L14.5025 4.58815C15.5885 5.64465 15.613 7.38115 14.5565 8.46715V8.46765ZM12.8655 6.91515C13.083 6.70365 13.0875 6.35665 12.8765 6.13915C12.873 6.13565 12.8695 6.13165 12.8655 6.12815C12.642 5.91065 12.286 5.91065 12.063 6.12815L7.31696 10.7827C6.64696 11.4347 5.57996 11.4347 4.91046 10.7827C4.25896 10.1482 4.24446 9.10565 4.87896 8.45415C4.88946 8.44365 4.89996 8.43315 4.91046 8.42265L9.65696 3.76815C9.87396 3.55665 9.87896 3.20965 9.66796 2.99215C9.66446 2.98865 9.66096 2.98465 9.65696 2.98115C9.43346 2.76365 9.07746 2.76365 8.85446 2.98115L4.10846 7.63565C3.02246 8.69215 2.99796 10.4287 4.05446 11.5147C4.07246 11.5332 4.09046 11.5512 4.10846 11.5687C5.22496 12.6547 7.00296 12.6547 8.11896 11.5687L12.8655 6.91415V6.91515Z"/></svg>`

export const T = {
  note: glyph(Note01Icon), // NoteIcon
  listChecks: glyph(CheckListIcon), // ListChecksIcon
  chatBubble: glyph(BubbleChatIcon), // ChatBubbleIcon
  github: glyph(GithubIcon), // GitHubIcon
  globe: glyph(Globe02Icon), // GlobeIcon, WebSearchIcon
  mcp: MCP, // McpIcon
  laptop: glyph(LaptopIcon), // DeviceLaptopIcon
  skill: glyph(CubeIcon), // SkillCubeIcon
  terminal: glyph(ComputerTerminal01Icon), // ComputerTerminalIcon
  pencil: glyph(Edit03Icon), // PencilIcon
  search: glyph(Search01Icon), // SearchIcon
  eye: glyph(EyeIcon), // EyeIcon
  robot: glyph(Robot01Icon), // RobotIcon
  hammer: glyph(HammerIcon), // HammerIcon
  alert: glyph(AlertCircleIcon), // CircleAlertIcon
  brain: glyph(BrainIcon), // BrainIcon
  check: glyph(Tick02Icon), // CheckIcon
  copy: glyph(Copy01Icon), // CopyIcon
  chevronRight: glyph(ChevronRightIcon), // ChevronRightIcon (DisclosureChevron closed)
  chevronDown: glyph(ChevronDownIcon), // DisclosureChevron open (rotate-90)
  chevronLeft: glyph(ChevronLeftIcon),
  arrowDown: glyph(ArrowDown01Icon), // ArrowDownIcon
  arrowLeft: glyph(ArrowLeft01Icon),
  arrowRight: glyph(ArrowRight01Icon),
  changes: glyph(Edit02Icon), // ChangesIcon
  undo: glyph(ArrowTurnBackwardIcon), // Undo2Icon, BackToParentIcon
  question: glyph(HelpCircleIcon), // CircleQuestionIcon
  checkSquare: glyph(CheckmarkSquare04Icon), // CheckmarkSquare04Icon
  panelRight: glyph(SidebarRightIcon), // PanelRightCloseIcon
  dots: glyph(MoreHorizontalIcon), // EllipsisIcon
  file: glyph(File01Icon),
  attachment: glyph(Attachment01Icon),
} as const
