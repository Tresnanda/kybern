import assert from 'node:assert/strict'
import { mock } from 'bun:test'
const environment = { id: 'test', revision: 1 }, leaving: (() => void)[] = [], actions: unknown[] = []
const thread = { id: 'one', project_id: 'project', cwd: '/repo' }
mock.module('../state.ts', () => ({ getState: () => ({ threads: [thread], projects: [{ id: 'project', path: '/repo' }] }) }))
mock.module('../shell/environment.ts', () => ({ activeEnvironment: () => environment, onEnvironmentLeaving: (fn: () => void) => leaving.push(fn) }))
mock.module('./store.ts', () => ({ chooseTab: (...args: unknown[]) => actions.push(args), setDock: (...args: unknown[]) => actions.push(args) }))
const { showFileInExplorer, takeExplorerSelection, canShowFileInExplorer } = await import('./explorerSelection.ts')
showFileInExplorer('one', 'project', '/repo/mock/deep/page.html')
const selected = takeExplorerSelection('one', 'project')
assert.equal(selected?.path, 'mock/deep/page.html'); assert.deepEqual(selected?.ancestors, ['mock', 'mock/deep'])
assert.equal(takeExplorerSelection('one', 'project'), null, 'must consume only once; ordinary selection is untouched thereafter')
assert.deepEqual(actions, [['one', 'explorer'], ['one', { open: true }]])
assert.equal(canShowFileInExplorer('one', 'project', '/worktree/mock/deep/page.html'), false)
assert.equal(canShowFileInExplorer('one', 'project', '/repo/../outside'), false)
showFileInExplorer('one', 'project', '/repo/page.html'); thread.cwd = '/worktree'
assert.equal(takeExplorerSelection('one', 'project'), null, 'workspace changes invalidate selection')
thread.cwd = '/repo'; showFileInExplorer('one', 'project', '/repo/page.html'); environment.revision++
assert.equal(takeExplorerSelection('one', 'project'), null, 'same environment reconnect cannot consume old selection')
showFileInExplorer('one', 'project', '/repo/page.html'); assert.equal(takeExplorerSelection('other', 'project'), null)
assert.equal(takeExplorerSelection('one', 'other'), null)
assert.equal(takeExplorerSelection('one', 'project')?.path, 'page.html', 'unrelated Explorer must leave the intended request pending')
showFileInExplorer('one', 'project', '/repo/page.html'); leaving.forEach(fn => fn()); assert.equal(takeExplorerSelection('one', 'project'), null)
console.log('PASS one-shot Explorer handoff: current environment/thread/project/workspace; ancestor expansion plan; no stale or outside paths')
