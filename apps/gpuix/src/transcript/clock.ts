// Message times are the desktop's own `clockTime` (`apps/desktop/src/lib/format.ts`). `src/locale.ts` gives it
// the system locale, so GPUIX prints what the desktop's web view prints ("0:18", not "00:18" or "12:18 AM").
import '../locale.ts'

export { clockTime } from '@/lib/format'
