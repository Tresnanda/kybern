import { settle, type Step } from '../screens.gpuix.ts'

/** The update surfaces (the rail card has no WebKit reference: it needs a packaged Tauri build; see verify.update.ts), against the in-process local feed of `src/platform/update.fixture.ts`. */
export const screens: Record<string, Step> = {
  'update-announcement': async (app) => { await app.getByTestId('update-announcement').waitFor({ timeoutMs: 20_000 }); await settle(900) },
  'update-details': async (app) => { await app.getByTestId('update-announcement').waitFor({ timeoutMs: 20_000 }); await app.getByTestId('update-announcement-details').click(); await app.getByTestId('update-details').waitFor({ timeoutMs: 5000 }); await settle(900) },
}
export const entries = Object.fromEntries(Object.keys(screens).map(name => [name, { entry: 'src/platform/update.fixture.ts' }]))
