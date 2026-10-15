import { park, settle, type Step } from '../screens.gpuix.ts'
const home = async (app: Parameters<Step>[0]) => { await app.getByTestId('rail-home').click(); await settle(800) }
export const screens: Record<string, Step> = {
  'shell-home': async (app) => { await home(app); await park(app) },
  'shell-sidebar-collapsed': async (app) => { await home(app); await app.getByTestId('sidebar-toggle').click(); await settle(700); await park(app) },
  'shell-sidebar-hover': async (app) => { await home(app); await app.mouse.move({ x: 130, y: 354 }); await settle(500) },
  'shell-new-chat-hover': async (app) => { await home(app); await app.mouse.move({ x: 116, y: 147 }); await settle(500) },
}
