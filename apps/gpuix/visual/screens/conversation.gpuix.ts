import { park, settle, type Step } from '../screens.gpuix.ts'

const conv = (fx: { extra?: Record<string, Record<string, string>> }) => fx.extra?.conversation ?? {}
async function open(app: Parameters<Step>[0], fx: Parameters<Step>[1], title: string) {
  await app.getByTestId(`thread-${conv(fx as never)[title]}`).click()
  await settle(1500)
}

export const screens: Record<string, Step> = {
  'conversation-transcript': async (app, fx) => { await open(app, fx, 'Date helper cleanup'); await park(app) },
}
