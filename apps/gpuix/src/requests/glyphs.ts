// Glyphs of the summoned request cards (sign-in, password prompt, macOS permission, deadline), at the kit stroke.
import {
  Camera01Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  ComputerIcon,
  ComputerVideoIcon,
  Cursor01Icon,
  FlashIcon,
  HardDriveIcon,
  Key01Icon,
  Location01Icon,
  Mic01Icon,
  Notification01Icon,
  PauseIcon,
  Shield01Icon,
  SquareLock01Icon,
  Wifi01Icon,
} from '@hugeicons/core-free-icons'
import { glyph } from '../icons.tsx'
import { T } from '../transcript/glyphs.ts'

/** A filled triangle (Vercel's mark), tinted like the other marks. */
const TRIANGLE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#000" d="M12 3 22.5 21h-21z"/></svg>'

export const RG = {
  lock: glyph(SquareLock01Icon),
  key: glyph(Key01Icon),
  shield: glyph(Shield01Icon),
  clock: glyph(Clock01Icon),
  pause: glyph(PauseIcon),
  checkCircle: glyph(CheckmarkCircle02Icon),
  cross: T.close,
} as const

/** The tile mark of a sign-in card by CLI; unknown CLIs get the terminal glyph. */
export function serviceMark(cli: string): string {
  switch (cli) {
    case 'gh': return T.github
    case 'vercel': return TRIANGLE
    case 'supabase': return glyph(FlashIcon)
    default: return T.terminal
  }
}

/** The pane's glyph: the permission card's tile (the daemon sends no app icon) and the well's pane label. */
export function paneGlyph(pane: string): string {
  switch (pane) {
    case 'camera': return glyph(Camera01Icon)
    case 'microphone': return glyph(Mic01Icon)
    case 'screen_recording': return glyph(ComputerVideoIcon)
    case 'accessibility': return glyph(Cursor01Icon)
    case 'local_network': return glyph(Wifi01Icon)
    case 'full_disk_access': return glyph(HardDriveIcon)
    case 'notifications': return glyph(Notification01Icon)
    case 'location': return glyph(Location01Icon)
    default: return glyph(ComputerIcon)
  }
}
