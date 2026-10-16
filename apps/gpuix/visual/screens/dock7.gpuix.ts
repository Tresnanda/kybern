import { readFileSync } from 'node:fs'
import type { Step } from '../screens.gpuix.ts'
import { until, openDock, painted } from '../../scripts/dock-waits.ts'
const fixture = () => JSON.parse(readFileSync('/Users/mymac/projects/ade-gpuix-scratch/round7-dock/dock7-fixture.json', 'utf8'))
export const screens: Record<string, Step> = {
  'dock7-provider-marks': async app => { await app.getByTestId('mark-Palette-droid').waitFor() },
  'dock7-explorer': async app => {
    await app.getByTestId(`thread-${fixture().thread}`).click()
    await app.getByTestId('header-title').waitFor()
    if (!await app.getByTestId('right-dock').count()) await app.getByTestId('app-ready').press('cmd-j')
    await openDock(app.getByTestId('right-dock'))
    await app.getByTestId('dock-add').click(); await app.getByTestId('dock-add-explorer').waitFor(); await app.getByTestId('dock-add-explorer').click()
    for (const name of ['src', 'src/components', 'src/components/kit']) { await painted(app.getByTestId(`dock-file-${name}`)); await app.getByTestId(`dock-file-${name}`).click() }
    await painted(app.getByTestId('dock-file-src/components/kit/theme.ts'))
    await app.getByTestId('dock-file-src/components/kit/theme.ts').click()
    await app.getByTestId('dock-code-chunk-0').waitFor()
    await until(async () => (await app.getByTestId('dock-file-README.md').bounds()).y > 470, 'tree finishes entrance')
    await app.getByTestId('dock-file-search').fill('theme.ts')
    await until(async () => await app.getByTestId('dock-file-src/components/kit').count() === 0, 'search replaces folder rows')
    await painted(app.getByTestId('dock-file-src/components/kit/theme.ts'))
    await app.getByTestId('dock-file-src/components/kit/theme.ts').click()
    await app.getByTestId('dock-file-search').fill('')
    await painted(app.getByTestId('dock-file-src/components/kit'))
    await painted(app.getByTestId('dock-file-src/components/kit/theme.ts'))
    await app.getByTestId('dock-file-src/components/kit/theme.ts').click()
  },
}
export const entries = { 'dock7-provider-marks': { entry: 'scripts/dock7-marks.fixture.tsx' } }
