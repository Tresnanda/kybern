import { type Step, park } from '../screens.gpuix.ts'
export async function pointer(app: Parameters<Step>[0], id: string) {
  const target = app.getByTestId(id)
  await target.waitFor({ timeoutMs: 15000 })
  await app.mouse.move(await target.center())
  // Deliberate human hover dwell: filled child hitboxes only exist after hover.
  await new Promise(resolve => setTimeout(resolve, 150))
  await app.mouse.click(await target.center())
}
const environment = (kind: string, ready: string): Step => async app => {
  await pointer(app, 'environment-switcher')
  await pointer(app, `environment-${kind}`)
  await app.getByTestId(ready).waitFor({ timeoutMs: 15000 })
  await park(app)
}
export const screens: Record<string, Step> = {
  'environment-add-ssh': environment('add', 'environment-machine'),
  'environment-add-address': async (app, fx) => { await screens['environment-add-ssh']!(app, fx); await app.getByText('Address or invitation', { exact: true }).click(); await app.getByTestId('environment-address').waitFor(); await park(app) },
  'environment-manage': environment('manage', 'environment-manage-list'),
  'environment-pair-empty': environment('pair', 'pairing-create'),
  'environment-pair-invitation': async (app, fx) => { await screens['environment-pair-empty']!(app, fx); await pointer(app, 'pairing-create'); await app.getByTestId('pairing-address').waitFor(); await app.getByTestId('pairing-address').fill('http://192.0.2.10:4219'); await app.getByTestId('pairing-qr').waitFor(); await park(app) },
}

export const entries = { 'composer-uploaded-images': { entry: 'src/main.tsx', env: { KYBERN_GPUIX_THREAD: 'Empty conversation' } } }
screens['composer-uploaded-images'] = async app => { await app.getByTestId('user-bubble').waitFor({timeoutMs:20000}); const deadline=Date.now()+15000; while(await app.getByTestId('response-image').count()<3){if(Date.now()>deadline)throw Error('Sent image thumbnails did not load');await new Promise(resolve=>setTimeout(resolve,30))} await park(app) }

for (const [name,trigger] of [['composer-home-workspace','tray-workspace'],['composer-home-branch','tray-branch']]) screens[name!] = async app => { await app.getByTestId('rail-home').waitFor({timeoutMs:30000}); await pointer(app,trigger!); await app.getByTestId(`${trigger}-menu`).waitFor(); await park(app) }
