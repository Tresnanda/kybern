import { screens as dock, entries as dockEntries } from './dock.gpuix.ts'
import { connect, readState } from '../fixture.ts'
import {screens as settings} from './settings.gpuix.ts'
import {screens as conversation} from './conversation.gpuix.ts'
import {click, type Step} from '../screens.gpuix.ts'
const glass: Step = async app => {
  await click(app, 'rail-settings')
  await click(app, 'settings-tab-appearance')
  await click(app, 'settings-translucency')
  await click(app, 'settings-back')
}
export const screens: Record<string, Step> = {
  'blur-dialog': async (app, fx) => { await glass(app, fx); await settings['dialog-account']!(app, fx) },
  'blur-palette': async (app, fx) => { await glass(app, fx); await settings['palette']!(app, fx) },
  'blur-popover': async (app, fx) => { await glass(app, fx); await conversation['conversation-model']!(app, fx) },
  'blur-live-controls': async (app, fx) => { await dock['dock-live']!(app, fx); await app.getByTestId('computer-live').hover(); await new Promise(r => setTimeout(r, 500)) },
  'blur-preview-header': async (app, fx) => { await dock['dock-preview-mini']!(app, fx); await app.getByTestId('preview-mini').hover(); await new Promise(r => setTimeout(r, 500)) },
  'blur-transcript-links': conversation['conversation-transcript']!,
  'blur-note-links': async app => {
    await click(app, 'rail-notes')
    await app.getByTestId('notes-search').fill('Link styling')
    await new Promise(r => setTimeout(r, 700))
    const client = await connect(readState()!)
    let id: string
    try { id = (await client.call('notes.list', {})).notes.find(note => note.title === 'Link styling')!.id } finally { client.close() }
    await app.getByTestId(`note-card-${id}`).click()
    await app.getByTestId('note-editor').waitFor()
    await new Promise(r => setTimeout(r, 800))
    await app.mouse.move({x:1275,y:815})
  },
}
export const entries = { 'blur-live-controls': dockEntries['dock-live'], 'blur-preview-header': dockEntries['dock-preview-mini'], ...Object.fromEntries(['blur-dialog','blur-palette','blur-popover'].map(name => [name,{entry:'visual/screens/blur.entry.tsx'}])) }
