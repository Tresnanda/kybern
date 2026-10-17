import { park, settle, type Step } from '../screens.gpuix.ts'

const ids = (fx: { extra?: Record<string, Record<string, unknown>> }) => (fx.extra?.convo9 ?? {}) as Record<string, string>
async function open(app: Parameters<Step>[0], fx: Parameters<Step>[1], title: string) {
  const id = ids(fx)[title]!
  for (let attempt = 0; attempt < 12; attempt++) {
    try { await app.getByTestId(`thread-${id}`).click(); break }
    catch (error) { if (attempt === 11) throw error; await app.mouse.wheel({ x: 180, y: 600 }, 0, -200); await settle(200) }
  }
  await settle(1500)
}
const composer = (app: Parameters<Step>[0]) => app.getByTestId('composer')
export const screens: Record<string, Step> = {
  'convo9-composer-empty': async (app, fx) => { await open(app, fx, 'Markdown B'); await park(app) },
  'convo9-composer-text': async (app, fx) => { await open(app, fx, 'Markdown B'); await composer(app).fill('First line of a longer prompt\nSecond line\nThird line'); await park(app) },
  'convo9-composer-mention': async (app, fx) => { await open(app, fx, 'Markdown B'); await composer(app).fill('@'); await settle(1200); await park(app) },
  'convo9-composer-mention-notes': async (app, fx) => { await open(app, fx, 'Markdown B'); await composer(app).fill('@'); await settle(900); await composer(app).press('right'); await settle(900); await composer(app).press('right'); await settle(1200); await park(app) },
  'convo9-composer-mention-query': async (app, fx) => { await open(app, fx, 'Markdown B'); await composer(app).fill('Look at @Rel'); await settle(1200); await park(app) },
  'convo9-composer-slash': async (app, fx) => { await open(app, fx, 'Markdown B'); await composer(app).fill('/'); await settle(1200); await park(app) },
  'convo9-composer-slash-query': async (app, fx) => { await open(app, fx, 'Markdown B'); await composer(app).fill('/ar'); await settle(1200); await park(app) },
  'convo9-composer-token': async (app, fx) => { await open(app, fx, 'Markdown B'); await composer(app).fill('Look at @Release'); await settle(1000); await composer(app).press('enter'); await settle(800); await composer(app).press('End'); await park(app) },
  'convo9-md-a': async (app, fx) => { await open(app, fx, 'Markdown A'); await park(app) },
  'convo9-md-b': async (app, fx) => { await open(app, fx, 'Markdown B'); await park(app) },
  'convo9-md-c': async (app, fx) => { await open(app, fx, 'Markdown C'); await park(app) },

  'convo9-visual': async (app, fx) => { await open(app, fx, 'Visual reply'); await settle(3500); await park(app) },
  'convo9-visual-hover': async (app, fx) => { await open(app, fx, 'Visual reply'); await settle(3500); await app.getByTestId('visual-frame').hover(); await settle(900) },
  'convo9-visual-expanded': async (app, fx) => { await open(app, fx, 'Visual reply'); await settle(3500); await app.getByTestId('visual-frame').hover(); await settle(500); await app.getByTestId('visual-expand').click(); await settle(900); await park(app) },
  'convo9-mermaid': async (app, fx) => { await open(app, fx, 'Mermaid diagram'); await settle(2500); await park(app) },
}
