const park = (p) => p.mouse.move(1275, 815)
const home = async (p) => { await p.getByRole('button', { name: 'Home', exact: true }).first().click(); await p.waitForTimeout(800) }
export const screens = {
  'shell-home': async (p) => { await home(p); await park(p) },
  'shell-sidebar-collapsed': async (p) => { await home(p); await p.getByRole('button', { name: 'Toggle thread sidebar' }).click(); await p.waitForTimeout(700); await park(p) },
  'shell-sidebar-hover': async (p) => { await home(p); await p.mouse.move(130, 354); await p.waitForTimeout(500) },
  'shell-new-chat-hover': async (p) => { await home(p); await p.mouse.move(116, 147); await p.waitForTimeout(500) },
}

// The close guard is Tauri-only (`onCloseRequested`). Pretend to be Tauri just enough to register
// the listener (the endpoint comes from the page URL), mark two threads running, then fire it.
screens['close-guard'] = async (p) => {
  for (let i = 0; i < 60; i++) { if (await p.evaluate(async () => { try { const { rpc } = await import('/src/state/rpc.ts'); return !!rpc().info } catch { return false } })) break; await p.waitForTimeout(500) }
  const url = new URL(p.url())
  const info = await p.evaluate(async () => { const { rpc } = await import('/src/state/rpc.ts'); const i = rpc().info; return { environment_id: i.environment_id, hostname: i.hostname } })
  await p.addInitScript(({ ws, token, info }) => {
    const callbacks = new Map()
    let next = 1
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
      transformCallback(cb) { const id = next++; callbacks.set(id, cb); window[`_${id}`] = cb; return id },
      unregisterCallback(id) { callbacks.delete(id) },
      invoke: async (cmd, args) => {
        const endpoint = { url: ws, http_base: ws.replace(/^ws/, 'http').replace(/\/ws$/, ''), token, spawned: false }
        const profile = { id: 'local', name: 'Development environment', url: null, environment_id: info.environment_id, hostname: info.hostname, local: false }
        if (cmd === 'endpoint') return endpoint
        if (cmd === 'environments_list') return { selected_id: 'local', environments: [profile] }
        if (cmd === 'environment_open') return { profile, endpoint }
        if (cmd === 'plugin:event|listen') { if (args.event === 'tauri://close-requested') window.__closeHandler = callbacks.get(args.handler); return next++ }
        return null
      },
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
  }, { ws: url.searchParams.get('url'), token: url.searchParams.get('token'), info })
  await p.reload()
  await p.waitForSelector('button[aria-label="Notes"]', { timeout: 30000 })
  await p.waitForTimeout(1500)
  await p.addStyleTag({ content: '*::-webkit-scrollbar{display:none}' })
  await p.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    const s = useStore.getState()
    const threads = { ...s.threads }
    for (const id of Object.keys(threads)) if (['Visual worktree', 'Dock visual review'].includes(threads[id].title)) threads[id] = { ...threads[id], status: 'running' }
    s.set({ threads })
    await window.__closeHandler({ event: 'tauri://close-requested', id: 1, payload: null })
  })
  await p.waitForTimeout(1000)
  await p.mouse.move(1275, 815)
}

const thread = async (p) => { await p.getByText('Visual worktree', { exact: true }).first().click(); await p.waitForTimeout(1200) }
screens['thread-header'] = async (p) => { await thread(p); await park(p) }
screens['env-panel'] = async (p) => { await thread(p); await p.getByRole('button', { name: 'Toggle environment panel' }).click(); await p.waitForTimeout(900); await park(p) }

const connection = (value) => async (p) => {
  await p.evaluate(async (value) => { const { useStore } = await import('/src/state/store.ts'); useStore.getState().set({ connection: value }) }, value)
  await p.waitForTimeout(900)
  await park(p)
}
screens['banner-reconnecting'] = connection({ state: 'reconnecting', detail: 'Connection interrupted' })
screens['banner-failed'] = connection({ state: 'failed', detail: 'The token was rejected. Reopen kybern.' })
screens['toasts'] = async (p) => {
  await p.evaluate(async () => {
    const dep = performance.getEntriesByType('resource').map((r) => r.name).find((n) => /deps\/sonner\.js/.test(n))
    const { toast } = await import(dep)
    toast('Thread is no longer available')
    toast.success('Saved to “Notes”', { action: { label: 'Open', onClick: () => {} } })
    toast.error('Unable to load thread', { description: 'Connection interrupted. Check the environment, then try again.' })
  })
  await p.waitForTimeout(1200)
  await park(p)
}

screens['split-empty'] = async (p) => { await thread(p); await p.keyboard.press('Meta+\\'); await p.waitForTimeout(1200); await park(p) }

screens['split-two'] = async (p) => { await screens['split-empty'](p); await p.getByText('Dock visual review', { exact: true }).first().click(); await p.waitForTimeout(1500); await park(p) }

screens['split-drop'] = async (p) => {
  await thread(p)
  await p.mouse.move(130, 413); await p.mouse.down()
  for (const x of [150, 200, 400, 700, 1000]) await p.mouse.move(x, 420, { steps: 4 })
  await p.waitForTimeout(900)
}
