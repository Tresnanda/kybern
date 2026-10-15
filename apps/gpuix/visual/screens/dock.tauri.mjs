async function open(p) {
  await p.getByText('Dock visual review', { exact: true }).first().click()
  await p.waitForTimeout(1200)
  if (!await p.getByRole('button', { name: 'Add panel', exact: true }).count()) await p.keyboard.press('Meta+j')
  await p.waitForTimeout(600)
}
const labels = { agents: 'Agents', activity: 'Activity', changes: 'Diff', explorer: 'Explorer', review: 'Review', terminal: 'Terminal', artifacts: 'Artifacts', notes: 'Notes', tasks: 'Tasks', preview: 'Preview' }
export const screens = {
  'dock-narrow': async p => { await screens['dock-agents'](p); await p.setViewportSize({ width: 980, height: 820 }); await p.waitForTimeout(800); await p.mouse.move(975, 815) },
  'dock-diff-file': async p => {
    await p.evaluate(async () => {
      const { rpc } = await import('/src/state/rpc.ts')
      const client = rpc(), call = client.call.bind(client)
      client.call = (method, params) => method === 'threads.diff' ? Promise.resolve({ patch: 'diff --git a/src/dock-example.ts b/src/dock-example.ts\n--- a/src/dock-example.ts\n+++ b/src/dock-example.ts\n@@ -1 +1,2 @@\n export const example = 1;\n+export const next = 2;', files: [{ path: 'src/dock-example.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n export const example = 1;\n+export const next = 2;' }] }) : call(method, params)
    })
    await screens['dock-changes'](p)
    await p.getByText('dock-example.ts', { exact: true }).first().click()
    await p.waitForTimeout(1000)
    await p.mouse.move(1275, 815)
  },
  'dock-live': async p => {
    await p.getByText('Dock visual review', { exact: true }).first().click()
    await p.waitForTimeout(1000)
    await p.evaluate(async () => {
      const { rpc } = await import('/src/state/rpc.ts'), { useStore } = await import('/src/state/store.ts')
      const client = rpc(), call = client.call.bind(client)
      const image = btoa('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#e8eef5"/><rect x="24" y="24" width="592" height="352" rx="16" fill="white"/><text x="52" y="80" font-size="26" fill="#182337">Scratch live-view fixture</text><text x="52" y="128" font-size="18" fill="#526273">The latest agent frame stays in memory.</text><rect x="52" y="180" width="190" height="48" rx="10" fill="#3566b1"/><text x="76" y="211" font-size="18" fill="white">Continue</text></svg>')
      client.call = (method, params) => method === 'computer.frame' ? Promise.resolve({ frame: { seq: 1, window_id: 1, app: 'Fixture', title: 'Scratch app', action: 'Pressed “Continue”', media_type: 'image/svg+xml', data: image, width: 640, height: 400, captured_at: new Date().toISOString() } }) : call(method, params)
      const s = useStore.getState(), id = s.selected.id
      s.set({ settings: { ...s.settings, computer_use: { ...s.settings.computer_use, enabled: true } }, threads: { ...s.threads, [id]: { ...s.threads[id], status: 'running' } } })
    })
    await p.getByLabel('What the agent sees in Fixture', { exact: true }).waitFor()
    await p.waitForTimeout(700)
    await p.mouse.move(1275, 815)
  },
  'dock-preview-opened': async p => { await open(p); await preview(p, false) },
  'dock-preview-mini': async p => { await p.getByText('Dock visual review', { exact: true }).first().click(); await p.waitForTimeout(1000); await preview(p, true) },
  'dock-project': async p => { await p.getByText('Open coordinator', { exact: true }).first().click(); await p.waitForTimeout(1200); if (!await p.getByRole('button', { name: 'Add panel', exact: true }).count()) await p.keyboard.press('Meta+j'); await p.getByRole('button', { name: 'Add panel', exact: true }).click(); await p.getByRole('menuitem', { name: /^Project/ }).click(); await p.waitForTimeout(1200); await p.mouse.move(1275, 815) },
  'dock-explorer-file': async p => { await screens['dock-explorer'](p); await p.getByText('src', { exact: true }).last().click(); await p.getByText('dock-example.ts', { exact: true }).last().click(); await p.waitForTimeout(1000); await p.mouse.move(1275, 815) },
  'dock-explorer-search': async p => { await screens['dock-explorer'](p); await p.getByRole('textbox', { name: 'Search files' }).fill('preview'); await p.waitForTimeout(1000); await p.mouse.move(1275, 815) },
  'dock-resize': async p => { await screens['dock-agents'](p); await p.mouse.move(736, 400); await p.mouse.down(); await p.mouse.move(796, 400, { steps: 8 }); await p.mouse.up(); await p.waitForTimeout(600); await p.mouse.move(1275, 815) },
  'dock-note-editor': async p => {
    await p.getByRole('button', { name: 'Notes', exact: true }).first().click()
    await p.getByPlaceholder('Search notes').fill('Design review notes')
    await p.waitForTimeout(500)
    await p.locator('[data-note-card][aria-label="Design review notes"]').first().click()
    await p.waitForTimeout(1500)
    await p.mouse.move(1275, 815)
  },
  ...Object.fromEntries(Object.entries(labels).map(([tab, label]) => [`dock-${tab}`, async p => {
    if (tab === 'changes') await p.evaluate(async () => {
      const { rpc } = await import('/src/state/rpc.ts')
      const client = rpc(), call = client.call.bind(client)
      client.call = (method, params) => method === 'git.status' ? Promise.resolve({ is_git: false }) : call(method, params)
    })
    await open(p)
    await p.getByRole('button', { name: 'Add panel', exact: true }).click()
    await p.getByRole('menuitem', { name: new RegExp(`^${label}`) }).click()
    await p.waitForTimeout(1500)
    await p.mouse.move(1275, 815)
  }])),
  'dock-add-menu': async p => { await open(p); await p.getByRole('button', { name: 'Add panel', exact: true }).click(); await p.waitForTimeout(500); await p.mouse.move(1275, 815) },
}

async function preview(p, floating) {
  await p.evaluate(async floating => {
    const { useStore } = await import('/src/state/store.ts')
    const s = useStore.getState(), id = s.selected.id
    s.openWebPreview(id, { kind: 'external', url: 'https://example.com' }, { title: 'example.com' })
    if (floating) { useStore.getState().setPreviewFloating(id, true); useStore.getState().set({ rightOpen: false }) }
  }, floating)
  await p.waitForTimeout(1500)
  await p.mouse.move(1275, 815)
}

// Stable server rows: other developers' processes must not change this comparison.
screens['dock-preview'] = async p => {
  await p.evaluate(async () => {
    const { rpc } = await import('/src/state/rpc.ts')
    const client = rpc(), call = client.call.bind(client)
    client.call = (method, params) => method === 'previews.servers.list' ? Promise.resolve({ servers: [
      { url: 'http://localhost:5173', port: 5173, host: 'localhost', process_name: 'node', cwd: '/workspace/kybern-app', title: 'Kybern', in_project: true },
      { url: 'http://localhost:3000', port: 3000, host: 'localhost', process_name: 'node', cwd: '/workspace/docs-site', title: 'Documentation', in_project: false },
    ], scanned_at: '2026-10-15T12:00:00Z', method: 'fixture' }) : call(method, params)
  })
  await open(p)
  await p.getByRole('button', { name: 'Add panel', exact: true }).click()
  await p.getByRole('menuitem', { name: /^Preview/ }).click()
  await p.waitForTimeout(1500)
  await p.mouse.move(1275, 815)
}

// Keep exactly one scratch shell so repeated captures do not accumulate tabs.
screens['dock-terminal'] = async p => {
  await open(p)
  await p.getByRole('button', { name: 'Add panel', exact: true }).click()
  await p.getByRole('menuitem', { name: /^Terminal/ }).click()
  await p.waitForTimeout(1500)
  await p.evaluate(async () => {
    const { rpc } = await import('/src/state/rpc.ts'), { useStore } = await import('/src/state/store.ts')
    const s = useStore.getState(), id = s.selected.id, tabs = s.terminalTabs[id] || []
    const keep = tabs.findLast(tab => tab.terminalId)
    if (!keep) throw Error('Terminal fixture did not create a shell')
    for (const terminal of (await rpc().call('terminals.list', { thread_id: id })).terminals) {
      if (terminal.id !== keep.terminalId) await rpc().call('terminals.close', { terminal_id: terminal.id })
    }
    useStore.getState().set(state => ({ terminalTabs: { ...state.terminalTabs, [id]: [keep] }, activeTerminalTab: { ...state.activeTerminalTab, [id]: keep.key } }))
  })
  await p.waitForTimeout(500)
  await p.mouse.move(1275, 815)
}
