// Scratch-only integration check; always closes its own window and deletes its fixtures.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launch, type App, type Locator } from '@gpuix/react/automation'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'

const scratch = path.resolve(process.env.KYBERN_DATA_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/data')
if (!scratch.includes('gpuix-scratch') && !scratch.endsWith('/apps/gpuix/.combined/data') && !scratch.endsWith('/ade-gpuix-notes/.p4/data')) throw new Error('This check writes fixtures: set KYBERN_DATA_DIR to the GPUIX scratch daemon.')
const port = readFileSync(path.join(scratch, 'daemon.port'), 'utf8').trim()
const token = readFileSync(path.join(scratch, 'daemon.token'), 'utf8').trim()
const client = new KybernClient(
  { url: `ws://127.0.0.1:${port}/ws`, token },
  {
    createSocket: (url, token) =>
      new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${token}` } } as unknown as string[]),
  },
)
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Connection timeout')), 10000)
  client.onStatus((status) => {
    if (status === 'open') {
      clearTimeout(timer)
      resolve()
    }
  })
  client.connect()
})
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/tasks'
mkdirSync(out, { recursive: true })
const ids: string[] = []
const noteIds: string[] = []
let app: App | null = null
const tag = `GPUIX Tasks ${Date.now()}`
const resumeTask = process.argv.find((arg) => arg.startsWith('--resume-task='))?.slice('--resume-task='.length)
async function until<T>(fn: () => Promise<T>, accepts: (value: T) => boolean, label: string, timeout = 15000): Promise<T> {
  const start = Date.now()
  while (true) {
    const value = await fn()
    if (accepts(value)) return value
    if (Date.now() - start > timeout) throw new Error(`Timeout: ${label}`)
    await Bun.sleep(100)
  }
}
async function click(locator: Locator) {
  await locator.waitFor({ timeoutMs: 15000 })
  const bounds = await until(
    async () => {
      const b = await locator.bounds().catch(() => null)
      if ((!b || b.width <= 0 || b.height <= 0) && app) await app.screenshot({ path: path.join(out, 'paint.png') })
      return b
    },
    (b) => !!b && b.width > 0 && b.height > 0,
    'painted bounds',
  )
  await app!.mouse.click({ x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 })
}

async function dismissToasts() {
  if (!app) return
  for (let i = 0; i < 5; i++) {
    const nodes = await app.getByTestId('toast-close').all()
    const node = nodes[0]
    if (!node) break
    const b = node.bounds ?? (await app.call('getBounds', { elementId: node.id })).bounds
    if (!b) break
    await app.mouse.click({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
    await until(
      () => app!.getByTestId('toast-close').all(),
      (list) => !list.some((v) => v.id === node.id),
      'toast dismissed',
    )
  }
}

async function sendPrompt() {
  await dismissToasts()
  await app!.getByTestId('composer').press('cmd-enter')
  await until(
    () => app!.getByTestId('task-run-composer').count(),
    (n) => n === 0,
    'send accepted',
    60000,
  )
}

async function dragTo(id: string, target: { x: number; y: number }, cancel = false) {
  const source = app!.getByTestId(`task-drag-${id}`)
  await source.waitFor({ timeoutMs: 15000 })
  const start = await source.center()
  await app!.mouse.move(start)
  await app!.mouse.down(start)
  await app!.mouse.move({ x: start.x + 7, y: start.y }, { pressedButton: 0 })
  await app!.getByTestId('task-drag-layer').waitFor()
  await until(
    () => app!.getByTestId('task-drag-layer').bounds(),
    (b) => b.width > 0,
    'drag capture painted',
  )
  await app!.mouse.move(target, { pressedButton: 0 })
  await app!.getByTestId('task-drop-indicator').waitFor()
  if (cancel) await source.press('escape')
  else await app!.screenshot({ path: path.join(out, `drag-${process.argv.includes('--light') ? 'light' : 'dark'}.png`) })
  await app!.mouse.up(target)
  await until(
    () => app!.getByTestId('task-drag-layer').count(),
    (n) => n === 0,
    'drag finished',
  )
}

try {
  const project = (await client.call('projects.list', {})).projects.find((p) => p.name === 'scratch-project')!
  if (!project) throw new Error('scratch-project is required')
  if (process.argv.includes('--send')) {
    const config = JSON.parse(readFileSync(path.join(scratch, 'gpuix-ui.json'), 'utf8'))['kybern.tasks.send:local']?.[project.id]
    if (config?.model !== 'claude-haiku-5-5' || config?.provider?.kind !== 'claude-code' || config?.useWorktree !== false)
      throw new Error(
        'Use the task composer to save claude-code / claude-haiku-5-5 / Local checkout in the scratch environment before running --send.',
      )
  }
  if (!!resumeTask) {
    const restored = await client.call('tasks.items.restore', { id: resumeTask! })
    ids.push(restored.id)
  }
  const note = await client.call('notes.create', {
    scope: 'project',
    project_id: project.id,
    title: 'Tasks verification brief',
    body: 'Keep the workspace responsive. Verify both appearance variants and keyboard navigation.',
  })
  noteIds.push(note.id)
  for (const [index, title] of [
    'Review keyboard navigation',
    'Polish task details',
    'Verify linked notes',
    'Check acceptance criteria',
    'Prepare the next release',
    'Improve workspace search',
    'Review connection recovery',
    'Document task shortcuts',
  ].entries()) {
    const task = await client.call('tasks.items.create', {
      scope: 'project',
      project_id: project.id,
      title,
      body: `Keep the Tasks page clear and responsive.\n\n- [ ] Verify the interface\n- [x] Read the desktop source`,
      note_ids: index === 0 ? [note.id] : [],
      priority: (index % 5) as 0 | 1 | 2 | 3 | 4,
      status: index % 3 === 0 ? 'todo' : 'inbox',
    })
    ids.push(task.id)
  }
  app = await launch({
    command: 'bun',
    args: [path.resolve(import.meta.dir, '../main.tsx')],
    env: {
      GPUIX_BACKGROUND: '1',
      KYBERN_APPEARANCE: process.argv.includes('--light') ? 'light' : 'dark',
      KYBERN_DATA_DIR: scratch,
      NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH,
    },
  })
  const initialized = await app.call('initialize', { protocolVersion: 1, client: 'tasks-check' })
  console.log('PID', initialized.pid)
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await app.getByTestId('rail-tasks').waitFor()
  await click(app.getByTestId('rail-tasks'))
  await app.getByTestId('tasks-sidebar').waitFor()
  await app.getByTestId(`task-filter-project:${project.id}`).waitFor()
  await click(app.getByTestId(`task-filter-project:${project.id}`))
  if (await app.getByTestId('task-board').count()) await click(app.getByTestId('task-view-list'))
  await app.getByTestId('task-list').waitFor()
  await app.getByTestId(`task-row-${ids[0]}`).waitFor()
  await app.screenshot({ path: path.join(out, `list-${process.argv.includes('--light') ? 'light' : 'dark'}.png`) })
  console.log('LIST OK')
  if (process.argv.includes('--drag-only')) {
    console.log('VIEWPORT', await app.getByTestId('task-list-viewport').bounds())
    const b = await app.getByTestId(`task-row-${ids[1]}`).bounds()
    await dragTo(ids[2]!, { x: b.x + b.width / 2, y: b.y + 3 })
    console.log('DRAG ONLY OK')
    process.exitCode = 0
  } else if (process.argv.includes('--screens')) {
    await click(app.getByTestId(`task-row-${ids[0]}`))
    await app.getByTestId('task-detail').waitFor()
    await app.screenshot({ path: path.join(out, `detail-${process.argv.includes('--light') ? 'light' : 'dark'}.png`) })
    await click(app.getByTestId('task-back'))
    await click(app.getByTestId('task-view-board'))
    await app.getByTestId('task-board').waitFor()
    await app.screenshot({ path: path.join(out, `board-${process.argv.includes('--light') ? 'light' : 'dark'}.png`) })
    await click(app.getByTestId('task-view-list'))
    await click(app.getByTestId(`task-row-${ids[0]}`))
    await click(app.getByTestId('task-send-open'))
    await app.getByTestId('composer').waitFor()
    await app.screenshot({ path: path.join(out, `composer-${process.argv.includes('--light') ? 'light' : 'dark'}.png`) })
  } else {
    if (!process.argv.includes('--send-only')) {
      await app.getByTestId('task-search').fill('criteria')
      await app.getByTestId('task-search').press('s')
      if (await app.getByTestId('task-status-menu').count()) throw new Error('Typing in search opened a task shortcut')
      await app.getByTestId('task-search').fill('')
      await app.getByTestId('task-list').waitFor()
      await app.getByTestId('task-new').waitFor()
      await click(app.getByTestId('task-new'))
      await app.getByTestId('task-quick-title').waitFor()
      await app.getByTestId('task-quick-title').fill(`${tag} quick add`)
      await app.getByTestId('task-quick-add').waitFor()
      await click(app.getByTestId('task-quick-add'))
      const result = await until(
        () => client.call('tasks.items.list', {}),
        (r) => r.tasks.some((v) => v.title === `${tag} quick add`),
        'quick add',
      )
      const added = result.tasks.find((v) => v.title === `${tag} quick add`)!
      ids.push(added.id)
      await app.getByTestId('task-quick-title').waitFor()
      await app.getByTestId('task-quick-title').press('escape')
      await app.getByTestId(`task-row-${ids[0]}`).waitFor()
      await click(app.getByTestId(`task-row-${ids[0]}`))
      await app.getByTestId('task-detail').waitFor()
      await app.screenshot({ path: path.join(out, `detail-${process.argv.includes('--light') ? 'light' : 'dark'}.png`) })
      console.log('DETAIL OK')
      await app.getByText('Tasks verification brief').waitFor()
      await click(app.getByText('Tasks verification brief'))
      await until(
        () => app!.call('getPaintedText', {}),
        (r) => r.text.join(' ').includes('Keep the workspace responsive.'),
        'linked note content',
      )
      console.log('LINKED NOTE OK')
      await click(app.getByTestId(`task-detach-${note.id}`))
      await until(() => client.call('tasks.items.get', { id: ids[0]! }), (r) => !r.task!.note_ids.includes(note.id), 'note detached')
      await click(app.getByTestId('task-attach-note'))
      await click(app.getByTestId(`task-attach-${note.id}`))
      await until(() => client.call('tasks.items.get', { id: ids[0]! }), (r) => r.task!.note_ids.includes(note.id), 'note attached')
      console.log('NOTE ATTACHMENT EDITING OK')
      await app.getByTestId('task-criterion-0').waitFor()
      await click(app.getByTestId('task-criterion-0'))
      await until(
        () => client.call('tasks.items.get', { id: ids[0]! }),
        (r) => r.task?.body.includes('- [x] Verify the interface') ?? false,
        'criterion',
      )
      await app.getByTestId('task-edit').waitFor()
      await click(app.getByTestId('task-edit'))
      await app.getByTestId('task-edit-title').waitFor()
      await app.getByTestId('task-edit-title').fill('Review keyboard navigation — verified')
      await app.getByTestId('task-edit-body').fill('Autosaved description.')
      await app.getByTestId('task-criterion-text-0').fill('Verify keyboard and pointer interaction')
      await until(
        () => client.call('tasks.items.get', { id: ids[0]! }),
        (r) => r.task?.body.startsWith('Autosaved description.') ?? false,
        'description autosaved',
      )
      await click(app.getByTestId('note-format-bold'))
      await until(() => client.call('tasks.items.get', { id: ids[0]! }), (r) => r.task!.body.startsWith('**Autosaved description.**'), 'description formatting')
      const base = (await client.call('tasks.items.get', { id: ids[0]! })).task!
      await app.getByTestId('task-edit-body').press('x')
      await client.call('tasks.items.update', { id: base.id, expected_revision: base.revision, body: 'Remote description.' })
      await app.getByTestId('task-keep-mine').waitFor({ timeoutMs: 15000 })
      await click(app.getByTestId('task-keep-mine'))
      await until(() => client.call('tasks.items.get', { id: base.id }), (r) => r.task!.body.includes('Autosaved description.'), 'conflict keeps draft')
      console.log('DESCRIPTION FORMATTING AND CONFLICT RECOVERY OK')
      await click(app.getByTestId('task-edit-done'))
      await until(
        () => client.call('tasks.items.get', { id: ids[0]! }),
        (r) => r.task?.title.endsWith('verified') ?? false,
        'save task',
      )
      await app.getByTestId('task-back').waitFor()
      await click(app.getByTestId('task-back'))
      await app.getByTestId('task-list').waitFor()
      await app.getByTestId(`task-row-${ids[0]}`).waitFor()
      await app.getByTestId(`task-row-${ids[0]}`).hover()
      await app.getByTestId(`task-select-${ids[0]}`).waitFor()
      await click(app.getByTestId(`task-select-${ids[0]}`))
      await app.getByTestId(`task-row-${ids[1]}`).hover()
      await app.getByTestId(`task-select-${ids[1]}`).waitFor()
      await click(app.getByTestId(`task-select-${ids[1]}`))
      await app.getByTestId('task-selection').waitFor()
      await app.getByTestId('task-priority').waitFor()
      await click(app.getByTestId('task-priority'))
      await app.getByTestId('task-priority-2').waitFor()
      await click(app.getByTestId('task-priority-2'))
      await until(
        () => client.call('tasks.items.list', {}),
        (r) => ids.slice(0, 2).every((id) => r.tasks.find((v) => v.id === id)?.priority === 2),
        'bulk priority',
      )
      await app.screenshot({ path: path.join(out, `selection-${process.argv.includes('--light') ? 'light' : 'dark'}.png`) })
      console.log('SELECTION OK')
      await app.getByTestId('task-selection-delete').waitFor()
      await click(app.getByTestId('task-selection-delete'))
      await until(
        () => client.call('tasks.items.list', {}),
        (r) => ids.slice(0, 2).every((id) => !r.tasks.some((v) => v.id === id)),
        'delete',
      )
      await app.getByTestId('toast-action').waitFor()
      await click(app.getByTestId('toast-action'))
      await until(
        () => client.call('tasks.items.list', {}),
        (r) => ids.slice(0, 2).every((id) => r.tasks.some((v) => v.id === id)),
        'restore',
      )
      console.log('UNDO OK')
      await dismissToasts()
      const listTarget = await app.getByTestId(`task-row-${ids[1]}`).bounds()
      await dragTo(ids[2]!, { x: listTarget.x + listTarget.width / 2, y: listTarget.y + 3 })
      await until(
        () => client.call('tasks.items.list', {}),
        (r) => r.tasks.find((task) => task.id === ids[2])!.rank < r.tasks.find((task) => task.id === ids[1])!.rank,
        'list reordered',
      )
      console.log('LIST DRAG OK')
      await app.getByTestId(`task-row-${ids[0]}`).press('cmd-n')
      await app.getByTestId('task-quick-title').waitFor()
      await app.getByTestId('task-quick-title').press('escape')
      await until(
        () => app!.getByTestId('task-quick-title').count(),
        (n) => n === 0,
        'new-task shortcut escaped',
      )
      console.log('TASK CMD-N OK')
      await click(app.getByTestId('task-view-board'))
      await app.getByTestId('task-board').waitFor()
      const todo = await app.getByTestId('task-column-todo').bounds()
      await dragTo(ids[2]!, { x: todo.x + todo.width / 2, y: todo.y + 65 }, true)
      if ((await client.call('tasks.items.get', { id: ids[2]! })).task!.status !== 'inbox') throw new Error('Escape committed a drag')
      await dragTo(ids[2]!, { x: todo.x + todo.width / 2, y: todo.y + 65 })
      await until(
        () => client.call('tasks.items.get', { id: ids[2]! }),
        (r) => r.task?.status === 'todo',
        'board moved',
      )
      console.log('BOARD DRAG AND CANCEL OK')
      await app.screenshot({ path: path.join(out, `board-${process.argv.includes('--light') ? 'light' : 'dark'}.png`) })
      await click(app.getByTestId('task-view-list'))
      await app.getByTestId('task-list').waitFor()
    }
    await app.getByTestId(`task-row-${ids[0]}`).waitFor()
    await click(app.getByTestId(`task-row-${ids[0]}`))
    await app.getByTestId('task-detail').waitFor()
    await app.getByTestId('task-send-open').waitFor()
    await click(app.getByTestId('task-send-open'))
    await app.getByTestId('task-run-composer').waitFor()
    await app.getByTestId('composer').waitFor()
    await app.getByTestId('composer').fill('Reply with OK only. Do not edit files or use tools.')
    await app.screenshot({ path: path.join(out, `composer-${process.argv.includes('--light') ? 'light' : 'dark'}.png`) })
    console.log('COMPOSER OK')
    if (process.argv.includes('--send')) {
      if (!!!resumeTask) {
        // Reuse the exact Haiku choice persisted by the earlier picker integration check.
        await dismissToasts()
        console.log('SEND')
        await sendPrompt()
        await until(
          () => client.call('tasks.items.get', { id: ids[0]! }),
          (r) => (r.task?.runs.length ?? 0) > 0,
          'single send',
          60000,
        )
        const singleRun = (await client.call('tasks.items.get', { id: ids[0]! })).task!.runs.at(-1)!
        if (singleRun.model !== 'claude-haiku-5-5' || singleRun.provider.kind !== 'claude-code')
          throw new Error('Unexpected verification model')
        console.log('SINGLE RUN STARTED')
        await until(
          () => client.call('tasks.items.get', { id: ids[0]! }),
          (r) => r.task?.status === 'needs_review',
          'single settled',
          90000,
        )
        await app.getByTestId('tasks-review-dot').waitFor()
        console.log('SINGLE RUN SETTLED, REVIEW DOT OK')
      } else {
        await click(app.getByTestId('task-composer-close'))
      }
      if (!process.argv.includes('--batch-only')) {
        const beforeFollowup = await client.call('threads.get', {
          thread_id: (await client.call('tasks.items.get', { id: ids[0]! })).task!.runs.at(-1)!.thread_id,
        })
        await click(app.getByTestId('task-send-open'))
        await app.getByTestId('composer').waitFor()
        await app.getByTestId('composer').fill('Reply with OK only. Do not edit files or use tools.')
        await dismissToasts()
        console.log('SEND')
        await sendPrompt()
        await until(
          () => client.call('threads.get', { thread_id: beforeFollowup.thread.id }),
          (r) => r.thread.updated_at !== beforeFollowup.thread.updated_at,
          'followup sent',
          60000,
        )
        await until(
          () => app!.getByTestId('task-run-composer').count(),
          (n) => n === 0,
          'followup accepted',
        )
        await until(
          () => client.call('tasks.items.get', { id: ids[0]! }),
          (r) => r.task?.status === 'needs_review',
          'followup settled',
          90000,
        )
        console.log('FOLLOWUP OK')
      }
      await click(app.getByTestId('task-back'))
      await app.getByTestId('task-list').waitFor()
      for (const id of ids.slice(1, 3)) {
        await app.getByTestId(`task-row-${id}`).hover()
        await app.getByTestId(`task-select-${id}`).waitFor()
        await click(app.getByTestId(`task-select-${id}`))
      }
      await app.getByTestId('task-batch-open').waitFor()
      await click(app.getByTestId('task-batch-open'))
      await click(app.getByText('One run'))
      await app.getByTestId('composer').fill('Reply with OK only. Do not edit files or use tools.')
      await dismissToasts()
      console.log('SEND')
      await sendPrompt()
      await until(
        () => client.call('tasks.items.list', {}),
        (r) => ids.slice(1, 3).every((id) => r.tasks.find((v) => v.id === id)?.status === 'needs_review'),
        'batch settled',
        90000,
      )
      console.log('COMBINED BATCH OK')
    }
    if (process.argv.includes('--perf')) {
      for (let i = 0; i < 200; i++) {
        const task = await client.call('tasks.items.create', {
          scope: 'project',
          project_id: project.id,
          title: `History task ${i + 1}`,
          status: i % 2 ? 'inbox' : 'todo',
          priority: 0,
        })
        ids.push(task.id)
      }
      console.log('PERF FIXTURES', ids.length)
      await app.getByTestId('task-composer-close').waitFor()
      if (await app.getByTestId('task-composer-close').count()) await click(app.getByTestId('task-composer-close'))
      await app.getByTestId('task-back').waitFor()
      await click(app.getByTestId('task-back'))
      const lastId = ids.at(-1)!
      await until(
        async () => {
          const row = await app!
            .getByTestId(`task-row-${lastId}`)
            .bounds()
            .catch(() => null)
          if (row && row.height > 0) return true
          await app!.getByTestId('task-list-viewport').wheel(0, -1200)
          return false
        },
        Boolean,
        'last virtual task reachable',
      )
      await app.getByTestId(`task-row-${lastId}`).hover()
      await click(app.getByTestId(`task-select-${lastId}`))
      await until(
        async () => {
          const row = await app!
            .getByTestId(`task-row-${ids[0]}`)
            .bounds()
            .catch(() => null)
          if (row && row.height > 0) return true
          await app!.getByTestId('task-list-viewport').wheel(0, 1200)
          return false
        },
        Boolean,
        'first virtual task reachable',
      )
      await app.getByText('1 selected').waitFor()
      await click(app.getByText('Clear'))
      console.log('WINDOWED HISTORY AND SELECTION OK')
      const sample = async (label: string, active: boolean) => {
        const process = Bun.spawn(['bun', path.resolve(import.meta.dir, '../../perf/sample.ts'), '15', `Tasks=${initialized.pid}`], {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...Bun.env },
        })
        const end = Date.now() + 16000
        if (active) {
          let direction = 1,
            passes = 0
          while (Date.now() < end) {
            await app!.getByTestId('task-list-viewport').wheel(0, direction * 220)
            if (++passes % 12 === 0) direction *= -1
            await Bun.sleep(250)
          }
        }
        await process.exited
        const output = await new Response(process.stdout).text()
        writeFileSync(path.join(out, `${label}.txt`), output)
        console.log(label, output)
      }
      await sample('idle-1', false)
      await sample('idle-2', false)
      await sample('active-1', true)
      await sample('active-2', true)
    }
  }
  console.log('ALL CHECKS PASSED')
} catch (error) {
  if (app) await app.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
  throw error
} finally {
  if (app) await app.close()
  for (const id of ids) await client.call('tasks.items.delete', { id }).catch(() => {})
  for (const id of noteIds) await client.call('notes.delete', { id }).catch(() => {})
  client.close()
}
