// Tree lane harness: the unchanged bench app (perf/bench/app.ts) plus in-process fixture state.
//   TREE_SIDEBAR=1   working children under the first thread of every project, two levels deep under the tree parent
//   TREE_OPEN=work,group,tool   transcript disclosures of those kinds start open
// A second control server (tree-control.json) adds or settles children while the window is up.
//   TREE_SOURCE=<commit>   the sidebar, transcript and dock files the tree lane touched, as they were at that commit (A/B)
import { writeFileSync } from 'node:fs'
import path from 'node:path'
if (process.env.TREE_SOURCE) Bun.plugin({ name: 'tree-source', setup(build) {
  build.onLoad({ filter: /\/src\/(?:Sidebar\.tsx|sidebar\/(?:rows\.tsx|model\.ts)|transcript\/(?:rows|Turn)\.tsx|dock\/Agents\.tsx)$/ }, args => {
    const root = path.resolve(import.meta.dir, '../../../..')
    const source = Bun.spawnSync(['git', 'show', `${process.env.TREE_SOURCE}:${path.relative(root, args.path)}`], { cwd: root })
    if (source.exitCode) throw Error(source.stderr.toString())
    return { contents: source.stdout.toString(), loader: args.path.endsWith('.ts') ? 'ts' : 'tsx' }
  })
} })
await import('../bench/app.ts')
const state = await import('../../src/state.ts')
const nav = await import('../../src/nav/store.ts')
const dock = await import('../../src/dock/store.ts')
const { setRowStateDefault } = await import('../../src/transcript/store.ts')
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'

const open = new Set((process.env.TREE_OPEN ?? '').split(',').filter(Boolean))
if (open.size) setRowStateDefault(key => open.has(key.split(':')[1] ?? '') ? true : undefined)

const manifest = process.env.TREE_MANIFEST ? (await Bun.file(process.env.TREE_MANIFEST).json()) as { parent: string } : null
const started = new Date(Date.now() - 20_000).toISOString()
let made = 0
function child(parent: Thread, title: string, delegated: boolean): Thread {
  const id = `${parent.id}-tree-${made++}`
  const base = { ...parent, id, title, pinned: false, parent_thread_id: parent.id, status: 'running' as const, coordinator_project_id: null, last_seq: 1 }
  return delegated
    ? { ...base, subagent: null, delegation: { task_id: id, operation_id: id, parent_thread_id: parent.id, depth: 1, role: 'review', workspace: 'shared', status: 'running', started_at: started } }
    : { ...base, delegation: null, subagent: { task_id: id, root_thread_id: parent.id, parent_turn_id: 'tree-turn', agent_type: 'Explore', status: 'running', started_at: started } }
}
const TITLES = ['Explore the sidebar rows', 'Audit the dock Agents tree and its lineage rows', 'Write the geometry test for stems, ticks and the last elbow']

function install() {
  const s = state.getState()
  if (!s.listsLoaded) return false
  const children: Record<string, Thread> = {}
  const add = (thread: Thread) => { children[thread.id] = thread; return thread }
  const parents = s.projects.flatMap(project => s.threads.filter(thread => thread.project_id === project.id && !thread.parent_thread_id).slice(0, 1))
  const tree = manifest ? s.threads.find(thread => thread.id === manifest.parent) : undefined
  for (const parent of tree ? [tree, ...parents] : parents) {
    const [a, b, c] = TITLES.map((title, i) => add(child(parent, title, i === 1)))
    if (parent === tree) { add(child(b!, 'Read Agents.tsx', false)); add(child(b!, 'Check the shared lineage rules for hidden subagents', true)) }
    void a; void c
  }
  nav.setNav({ children: { ...nav.getNav().children, ...children } })
  console.error('[tree-fixture-ready]')
  return true
}
if (process.env.TREE_SIDEBAR === '1' && !install()) { const stop = state.subscribe(() => { if (state.getState().listsLoaded) { stop(); install() } }) }

const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const body = await req.json() as { action: string; parent?: string; title?: string; id?: string }
  try {
    const children = nav.getNav().children
    if (body.action === 'add-child') {
      const parent = state.getState().threads.find(t => t.id === body.parent) ?? children[body.parent!]
      if (!parent) throw Error('No parent')
      const next = child(parent, body.title ?? 'A new subagent', false)
      nav.setNav({ children: { ...children, [next.id]: next } })
      return Response.json({ id: next.id })
    }
    if (body.action === 'testids') {
      const root = (globalThis as Record<string, unknown>).__benchFiberRoot as { containerInfo?: { nativeRenderer?: { getAutomationTree: () => string } } } | undefined
      type Node = { testId?: string; children?: Node[] }
      const tree = JSON.parse(root?.containerInfo?.nativeRenderer?.getAutomationTree() ?? '[]') as Node | Node[], stack = Array.isArray(tree) ? tree : [tree], ids: string[] = []
      const match = new RegExp(body.title ?? '.')
      while (stack.length) { const node = stack.pop()!; if (node.testId && match.test(node.testId)) ids.push(node.testId); stack.push(...node.children ?? []) }
      return Response.json({ ids })
    }
    if (body.action === 'dock-agents') dock.setDock(state.getState().selectedId, { open: true, tabs: ['agents'], tab: 'agents', width: 420, instant: true })
    if (body.action === 'remove-child') {
      const next = { ...children }; delete next[body.id!]
      nav.setNav({ children: next })
    }
    return Response.json({ ok: true, children: Object.keys(children).length })
  } catch (e) { return Response.json({ error: String(e) }, { status: 500 }) }
} })
writeFileSync(path.join(process.env.KYBERN_CLIENT_CONFIG_DIR!, 'tree-control.json'), JSON.stringify({ port: server.port }))
export {}
