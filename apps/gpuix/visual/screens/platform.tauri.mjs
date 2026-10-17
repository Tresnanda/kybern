// Update surfaces in the desktop web build: the update store is set directly
// (no Tauri updater in WebKit). The rail badge needs canSelfUpdate(), which is
// false outside a packaged Tauri build, so it has no reference here.
const NOTES = `## Release Notes

<!-- kybern-release-title: Faster threads and a calmer sidebar -->
<!-- kybern-release-summary: Threads open instantly, the sidebar keeps its place, and updates install in the background. -->

- Open long threads instantly, keeping your reading position.
- Keep the sidebar where you left it across windows.
- Install updates with progress in the app rail.`
const update = (p, patch) => p.evaluate(async ([notes, patch]) => {
  const m = await import('/src/lib/appUpdate.ts')
  m.useAppUpdate.setState({ phase: 'available', version: '0.9.2', notes, ...patch })
}, [NOTES, patch])
export const screens = {
  'update-announcement': async p => { await update(p, { announcementOpen: true }); await p.waitForTimeout(900); await p.mouse.move(1275, 815); await p.waitForTimeout(400) },
  'update-details': async p => { await update(p, { announcementOpen: false, detailsOpen: true }); await p.waitForTimeout(900) },
}
