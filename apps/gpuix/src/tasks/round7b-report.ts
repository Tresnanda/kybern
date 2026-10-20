import {readFileSync, readdirSync, writeFileSync} from 'node:fs'
const out = '/Users/mymac/projects/ade/previews/gpuix/round7/tasks7b'
const pacing = (label: string, prefix: string) => {
  const dir = `${out}/${label}-pacing`, file = readdirSync(dir).filter(name => name.startsWith(prefix)).sort().at(-1)!
  const {frames, p50, p95, max, pointerToBounds} = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'))
  return {file: `${label}-pacing/${file}`, frames, p50, p95, max, pointerToBounds}
}
const comparison = []
for (const theme of ['dark', 'light']) for (const reduced of ['0', '1']) {
  const before = `before2-${theme}-${reduced}`, after = `after-${theme}-${reduced}`
  comparison.push({mode: `${theme}-${reduced === '1' ? 'reduced' : 'normal'}`, before: {board:pacing(before,'tasks-board-'),list:pacing(before,'tasks-list-'),projects:pacing(before,'projects-')}, after:{board:pacing(after,'tasks-board-'),list:pacing(after,'tasks-list-'),projects:pacing(after,'projects-')}})
}
const resources = (label: string) => Object.fromEntries(['board','list','projects'].map(kind => {
  const input = JSON.parse(readFileSync(`${out}/${label}-input.json`, 'utf8')).find((row: {kind:string}) => row.kind === kind)
  const file = `${label}-${kind}-resources.txt`, text = readFileSync(`${out}/${file}`, 'utf8')
  const match = text.match(/total\s+([\d.]+) MiB\s+cpu\s+([\d.]+)%\s+gpu\s+([\d.]+) ms over ([\d.]+)s/)!
  return [kind, {file,moves:input.times.length,footprintMiB:Number(match[1]),cpuPercent:Number(match[2]),gpuMs:Number(match[3]),seconds:Number(match[4])}]
}))
const commits = (label: string) => {
  const log = readFileSync(`${out}/${label}-full-native.log`, 'utf8')
  const segments = log.split('[pacing]')
  let previous = 0
  return segments.map((segment, index) => {
    const matches = [...segment.matchAll(/\[react-commits\] (\{[^\n]*\})/g)]
    if (!matches.length) return null
    const last = JSON.parse(matches.at(-1)![1]!), delta = last.commits - previous
    previous = last.commits
    return {phase:['board with setup','list with view switch','projects with page switch'][index],rootCommits:delta,islandRenders:[...segment.matchAll(/\[islands\] render /g)].length}
  }).filter(Boolean)
}
writeFileSync(`${out}/comparison.json`, JSON.stringify({
  workload:'17 tasks (5 Inbox/12 To do), 3 projects, 1280x820, Apple M1/macOS27.0.1/Bun1.4.0, copied round7 addon; KYBERN_FULL_RATE=1; unchanged project control',
  kind:'120 moves, 8ms sleeps, no per-move geometry queries or screenshots; changed native bounds callbacks, not display presents',
  comparison,
  resources:{workload:'15s sustained carry, same 120-position path repeated; no screenshots or sampling profiler; matched-before and after in the same UI lock session',before:resources('matched-before-resources'),after:resources('after-resources')},
  react:{kind:'Separate diagnostics. Root commits include setup/view switch and cleanup; component prop/hook counters are diagnostic estimates and are excluded.',before:commits('matched-before-profile'),after:commits('after-profile')},
  limits:['Native bounds callbacks are not OS display presentation or physical input latency.','The task7 66.6%CPU/428msGPU result used a different sustained path and per-move geometry queries; it is not the baseline for this A/B.','CPU changed only3–4%; the substantial carry reduction gate remains unmet.','Normal-motion list p95 remains above16.7ms; reduced-motion results just meet it.','Extra row islands re-render during pointer motion; caching alone does not avoid native render/layout.','Early before-* logs enabled island debugging by setting it to0 and had physical-pointer interference. Use before2-* or matched-before-* instead.','WebKit images are the desktop frontend in WebKit, not packaged native Tauri.'],
  nativeNeed:{
    suggestedApi:'setSubtreeTranslation(elementId, {translateX,translateY}); native subtree paintMotion with the existing tween/spring fields',
    requiredBehavior:'Move the cached subtree scene and reported bounds without rebuilding the element tree, ancestor revisions or Taffy layout. Reuse retained clipping, glyphs, shadows and opacity. Preserve pointer capture, selection and AX; sibling motion must also transform hitboxes until landing finishes. Native layout observers report transformed visual bounds while task slot wrappers remain unshifted. Latest pointer input wins; cancel/drop/remount invalidate retained translations. Cache replay must survive ordinary pointer motion.',
    nativeChangesMade:false,
  },
}, null, 2))
console.log(comparison.map(row => ({mode:row.mode,beforeList:row.before.list.p95,afterList:row.after.list.p95})))
