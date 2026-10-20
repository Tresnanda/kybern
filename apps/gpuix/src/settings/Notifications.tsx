// Settings › Notifications (desktop `SettingsScreen.tsx` `Notifications` and
// `NotificationSettings`): the daemon's agent-notification switch, and access
// to macOS notifications for the packaged app (`native/notifications.ts`).
import { useEffect, useState } from 'react'
import { notifications, type NotificationStatus } from '../native/notifications.ts'
import { toast } from '../shell/toasts.tsx'
import { Button, Row, Section } from './controls.tsx'
import { Switch } from '../kit/Switch.tsx'
import { updateSettings, useSettings } from './store.ts'

export function Notifications() {
  const { settings, saving } = useSettings()
  const [permission, setPermission] = useState<NotificationStatus>('not-determined')
  const [busy, setBusy] = useState(false)
  useEffect(() => { let active = true; void notifications.status().then(value => { if (active) setPermission(value) }).catch(() => { if (active) setPermission('unsupported') }); return () => { active = false } }, [])
  const test = async () => {
    setBusy(true)
    try {
      const state = await notifications.requestPermission()
      setPermission(state)
      if (state === 'granted' && !await notifications.post({ id: `settings-test-${Date.now()}`, title: 'Kybern', body: "Notifications are ready. You'll hear when an agent needs you." })) throw Error('Check notification access in system settings and try again.')
    } catch (e) { toast.error('Unable to send notification', { description: e instanceof Error ? e.message : String(e) }) }
    finally { setBusy(false) }
  }
  const description = permission === 'granted' ? 'System alerts appear when Kybern is in the background.' : permission === 'denied' ? 'Allow Kybern notifications in system settings, then try again.' : permission === 'unsupported' ? "System notifications aren't available in this environment. In-app alerts still work." : 'Enable access to receive alerts outside Kybern.'
  return <>
    <Section title="Agent activity"><Row title="Show agent notifications" description="When work finishes, fails, or needs your input."><Switch aria-label="Show agent notifications" testId="settings-notifications" checked={settings?.notifications ?? false} disabled={saving} onCheckedChange={(notifications) => void updateSettings({ notifications })} /></Row></Section>
    <Section title="System notifications"><Row title="Notification access" description={description}><Button testId="settings-notification-access" disabled={busy || permission === 'unsupported'} onClick={() => void test()}>{permission === 'granted' ? 'Send test notification' : 'Enable notifications'}</Button></Row></Section>
  </>
}
