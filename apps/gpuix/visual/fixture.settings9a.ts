/** Settings the settings9a screens read from the scratch daemon itself (allowed apps, Preview folders). */
import type { KybernClient } from '../../../packages/kybern-client/src/client.ts'

export async function seed(client: KybernClient) {
  const settings = await client.call('settings.get', {})
  await client.call('settings.update', { settings: { ...settings, computer_use: { ...settings.computer_use, enabled: true, foreground: 'ask', show_cursor: false, always_allowed_apps: ['Calculator', 'Notes', 'TextEdit'] }, preview_allowed_folders: ['/Users/me/Sites/demo-site', '/private/tmp/preview-fixtures'] } })
}
