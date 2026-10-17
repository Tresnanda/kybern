import {screens as dock} from './dock.tauri.mjs'
import {screens as settings} from './settings.tauri.mjs'
import {screens as conversation} from './conversation.tauri.mjs'
const glass = async p => p.evaluate(() => {
  document.documentElement.setAttribute('data-full-translucency', '')
  document.documentElement.setAttribute('data-window-material', 'translucent')
})
export const screens = {
  'blur-dialog': async p => { await settings['dialog-account'](p); await glass(p); await p.waitForTimeout(600) },
  'blur-palette': async p => { await settings.palette(p); await glass(p); await p.waitForTimeout(600) },
  'blur-popover': async p => { await conversation['conversation-model'](p); await glass(p); await p.waitForTimeout(600) },
  'blur-live-controls': async p => { await dock['dock-live'](p); await p.locator('.computer-live-view').hover(); await p.waitForTimeout(500) },
   'blur-preview-header': async p => {
    await dock['dock-preview-mini'](p)
    // Isolate the real header material with an inert frame. GPUIX currently
    // presents a browser-launch card, so this is header evidence, not iframe parity.
    await p.evaluate(async () => {
      const {useStore} = await import('/src/state/store.ts')
      const {patchSession} = await import('/src/state/previewSession.ts')
      patchSession(useStore.getState().selected.id, {frame:{url:'about:blank',seq:1},load:{phase:'ready'},loading:false})
    })
    await p.locator('.preview-surface[data-shape="pip"][data-visible="true"]').hover()
    await p.waitForTimeout(500)
  },
  'blur-transcript-links': conversation['conversation-transcript'],
  'blur-note-links': async p => {
    await p.evaluate(async () => {
      const {rpc} = await import('/src/state/rpc.ts')
      const existing = (await rpc().call('notes.list', {})).notes.find(n => n.title === 'Link styling')
      if (!existing) await rpc().call('notes.create', {scope:'global', title:'Link styling', body:'Read [the documentation](https://example.com/docs) for details.\n\nA second [reference link](https://example.com/reference) uses the same accent color.'})
    })
    await p.getByRole('button',{name:'Notes',exact:true}).first().click()
    await p.getByPlaceholder('Search notes').fill('Link styling')
    await p.locator('[data-note-card][aria-label="Link styling"]').click()
    await p.waitForTimeout(1200)
    await p.mouse.move(1275,815)
  },
}
