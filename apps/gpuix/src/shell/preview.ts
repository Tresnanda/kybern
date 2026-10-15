// Screenshot fixtures for the visual pair tool (`visual/screens/shell.*`): with
// `KYBERN_PREVIEW` set the app raises one piece of chrome by itself once it has settled,
// because headless automation cannot cause a lost connection or fire toasts.
import { set } from '../state.ts'
import { toast } from './toasts.tsx'

export function startPreview() {
  const name = process.env.KYBERN_PREVIEW
  if (!name) return
  setTimeout(() => {
    if (name === 'banner-reconnecting') set({ status: 'reconnecting', statusDetail: 'Connection interrupted' })
    else if (name === 'banner-failed') set({ status: 'failed', statusDetail: 'The token was rejected. Reopen kybern.' })
    else if (name === 'toasts') {
      toast('Thread is no longer available')
      toast.success('Saved to “Notes”', { action: { label: 'Open', onClick: () => {} } })
      toast.error('Unable to load thread', { description: 'Connection interrupted. Check the environment, then try again.' })
    }
  }, 1500)
}
