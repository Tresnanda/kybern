export const screens = {
  'dock7-explorer': async page => {
    await page.getByText('Dock7 claude-code', { exact: true }).first().click()
    if (!await page.getByRole('button', { name: 'Add panel', exact: true }).count()) await page.keyboard.press('Meta+j')
    await page.getByRole('button', { name: 'Add panel', exact: true }).click()
    await page.getByRole('menuitem', { name: /^Explorer/ }).click()
    for (const name of ['src', 'components', 'kit']) await page.getByRole('treeitem', { name, exact: true }).click()
    await page.getByRole('treeitem', { name: 'theme.ts', exact: true }).click()
    await page.locator('pre').filter({ hasText: 'export const example' }).first().waitFor()
  },
  'dock7-provider-marks': async page => {
    await page.evaluate(async () => {
      const reactModule = await import('/node_modules/.vite/deps/react.js')
      const React = reactModule.default ?? reactModule
      const clientModule = await import('/node_modules/.vite/deps/react-dom_client.js')
      const createRoot = clientModule.createRoot ?? clientModule.default.createRoot
      const { ProviderIcon } = await import('/src/components/kit/ProviderIcon.tsx')
      const h = React.createElement
      const root = document.createElement('div'); root.style.cssText = 'position:fixed;inset:0;z-index:99999;background:var(--color-background-surface);padding-top:44px;color:var(--color-text-foreground);font-family:system-ui'
      document.body.append(root)
      const kinds = ['claudeAgent', 'codex', 'opencode', 'pi', 'omp', 'cursor', 'devin', 'antigravity', 'grok', 'droid']
      const surfaces = [['Sidebar',12],['Model / account tabs',14],['Thread header',14],['Hand off',16],['Subagent row / hover',12],['Settings agents',14],['Settings accounts',18],['Usage ring / hover',11],['Palette',15]]
      const row = {display:'flex',alignItems:'center',paddingLeft:24}
      const cell = {width:100,display:'flex',alignItems:'center',justifyContent:'center'}
      createRoot(root).render(h(React.Fragment,null,
        h('div',{style:{...row,height:60,fontSize:18,fontWeight:600}},'Provider marks · desktop surface sizes'),
        h('div',{style:{...row,height:48}},h('div',{style:{width:210}}),...kinds.map((kind,i)=>h('div',{key:kind,style:{...cell,fontSize:11,color:'var(--color-text-foreground-secondary)'}},i===0?'claude-code':kind))),
        ...surfaces.map(([surface,size])=>h('div',{key:surface,style:{...row,height:56,borderTop:'0.5px solid var(--color-border-light)'}},h('div',{style:{width:210,fontSize:12,color:'var(--color-text-foreground-secondary)'}},`${surface} · ${size}px`),...kinds.map(kind=>h('div',{key:kind,style:{...cell,height:56}},h(ProviderIcon,{provider:kind,tone:surface==='Thread header'?'header':'default',style:{width:size,height:size}}))))),
        h('div',{style:{padding:24,fontSize:12,color:'var(--color-text-foreground-secondary)'}},'Same ProviderMark component used by all app surfaces. Multicolour assets retain their source colours.')
      ))
    })
    await page.getByText('Palette · 15px', {exact:true}).waitFor()
  },
}
