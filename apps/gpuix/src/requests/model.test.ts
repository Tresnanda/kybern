import { describe, expect, test } from 'bun:test'
import type { ApprovalRequest } from '../../../../packages/kybern-client/src/types.ts'
import { approvalCard, commandOf, diffLines, editDiff, forwardsDeclineReason, grantLines, listParts, rowForDigit, sessionLabel, shellQuote, stepHighlight, type CardModel, type Part } from './model.ts'

const base = { id: 'a1', thread_id: 't', turn_id: 'u', tool_call_id: 'c', created_at: '2026-10-23T00:00:00Z', summary: '' }
const request = (tool_name: string, input: unknown, suggestions: unknown[] = [], summary = ''): ApprovalRequest => ({ ...base, tool_name, input: input as never, suggestions: suggestions as never, summary })
const rule = (destination: string, ...rules: string[]) => ({ type: 'addRules', behavior: 'allow', destination, rules: rules.map((ruleContent) => ({ toolName: 'Bash', ruleContent })) })
const plain = (parts: Part[] | null) => parts?.map((p) => (p.code ? `\`${p.text}\`` : p.text)).join('') ?? null
const rowLabels = (card: CardModel | null) => card?.rows.map((r) => plain(r.label))

describe('commandOf', () => {
  test('is the real command, not the summary', () => {
    expect(commandOf({ command: 'a && b' })).toBe('a && b')
    expect(commandOf({ metadata: { command: 'ls | wc' } })).toBe('ls | wc')
    expect(commandOf({ command: ['git', 'status'] })).toBe('git status')
    expect(commandOf({ rawInput: { command: 'x' } })).toBe('x')
    expect(commandOf({ title: 'Run', raw: { command: 'a && b' } })).toBe('a && b')
    expect(commandOf({})).toBe('')
  })
  test('an argv array is quoted word by word, so a script argument never reads as a chain', () => {
    expect(commandOf({ command: ['bash', '-lc', 'rm -rf x && echo ok'] })).toBe(`bash -lc 'rm -rf x && echo ok'`)
    expect(commandOf({ command: ['echo', "it's", ''] })).toBe(`echo 'it'\\''s' ''`)
    expect(shellQuote('src/a.ts')).toBe('src/a.ts')
  })
})

describe('session option', () => {
  test('Claude names the rules its suggestions add, and says so when they outlive the session', () => {
    const r = request('Bash', { command: 'pnpm run typecheck && bun test src' }, [rule('session', 'pnpm run typecheck:*', 'bun test:*')])
    expect(plain(sessionLabel(r, 'claude-code', 'command'))).toBe('Allow `pnpm run typecheck` and `bun test` commands for this session')
    const saved = request('Bash', { command: 'bun test' }, [rule('localSettings', 'bun test:*')])
    expect(plain(sessionLabel(saved, 'claude-code', 'command'))).toBe('Always allow `bun test` commands')
  })
  test('an exact Claude rule is not called a prefix, and a rule with no command allows every command', () => {
    expect(plain(sessionLabel(request('Bash', { command: 'ls -la' }, [rule('session', 'ls -la')]), 'claude-code', 'command'))).toBe('Allow `ls -la` for this session')
    expect(plain(sessionLabel(request('Bash', { command: 'ls' }, [rule('session', '')]), 'claude-code', 'command'))).toBe('Allow every command for this session')
  })
  test('a Claude suggestion the card cannot name is still sent, so the label says so', () => {
    const r = request('Bash', { command: 'x' }, [rule('session', 'x'), { type: 'setMode', mode: 'bypassPermissions', destination: 'session' }])
    expect(plain(sessionLabel(r, 'claude-code', 'command'))).toBe('Allow `x` and other permission changes for this session')
    expect(plain(sessionLabel(request('Bash', {}, [{ type: 'removeRules', destination: 'session' }]), 'claude-code', 'command'))).toBe('Allow the permission changes Claude suggests for this session')
  })
  test('long lists read "a, b and N more"', () => {
    expect(plain(listParts(['a', 'b', 'c', 'd', 'e', 'f']))).toBe('`a`, `b` and 4 more')
    expect(plain(listParts(['a', 'a', 'b']))).toBe('`a` and `b`')
  })
  test('Claude with no suggestion has nothing to allow beyond once, so no session row', () => {
    expect(sessionLabel(request('Bash', { command: 'x' }), 'claude-code', 'command')).toBeNull()
  })
  test('Claude acceptEdits suggests allowing edits', () => {
    const r = request('Edit', { file_path: '/a' }, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
    expect(plain(sessionLabel(r, 'claude-code', 'edit'))).toBe('Allow edits for this session')
  })
  test('Codex remembers the exact command, and the files of an edit', () => {
    expect(plain(sessionLabel(request('shell', { command: 'x' }), 'codex', 'command'))).toBe('Allow this exact command for this session')
    expect(plain(sessionLabel(request('apply_patch', { changes: [{ path: '/a' }] }), 'codex', 'edit'))).toBe('Allow edits to this file for this session')
    expect(plain(sessionLabel(request('apply_patch', { changes: [{ path: '/a' }, { path: '/b' }] }), 'codex', 'edit'))).toBe('Allow edits to these files for this session')
  })
  test('Pi remembers the exact call through Kybern\'s extension; its other prompts only approve once', () => {
    expect(plain(sessionLabel(request('bash', { command: 'x' }), 'pi', 'command'))).toBe('Allow this exact command for this session')
    expect(sessionLabel({ ...request('bash', { command: 'x' }), tool_call_id: null }, 'omp', 'command')).toBeNull()
  })
  test('Cursor offers its own always option, or nothing when it has none', () => {
    const options = (kinds: string[]) => ({ title: 'Run ls', options: kinds.map((kind, i) => ({ id: String(i), name: kind === 'AllowAlways' ? 'allow always' : kind, kind })) })
    expect(plain(sessionLabel(request('execute', options(['AllowOnce', 'AllowAlways', 'RejectOnce'])), 'cursor', 'command'))).toBe('Allow always')
    expect(sessionLabel(request('execute', options(['AllowOnce', 'RejectOnce'])), 'cursor', 'command')).toBeNull()
  })
  test('OpenCode names its always patterns', () => {
    expect(plain(sessionLabel(request('bash', {}, ['pnpm run *']), 'opencode', 'command'))).toBe('Allow `pnpm run` commands for this session')
    expect(plain(sessionLabel(request('bash', {}, ['*']), 'opencode', 'command'))).toBe('Allow every `bash` request for this session')
    expect(plain(sessionLabel(request('edit', {}, ['src/*']), 'opencode', 'edit'))).toBe('Allow `src/*` for this session')
  })
})

describe('the rows of each card, in key order', () => {
  const session = [rule('session', 'pnpm run typecheck:*', 'bun test:*')]
  test('a command: once, session, decline', () => {
    const card = approvalCard(request('Bash', { command: 'pnpm run typecheck && bun test src' }, session), 'claude-code', 'ade/apps/gpuix')
    expect(card?.kind).toBe('command')
    expect(card?.well).toEqual({ kind: 'command', command: 'pnpm run typecheck && bun test src' })
    expect(rowLabels(card)).toEqual(['Run once', 'Allow `pnpm run typecheck` and `bun test` commands for this session', 'Decline and tell Claude what to do instead'])
    expect(card?.rows.map((r) => r.action)).toEqual([
      { kind: 'decide', decision: { decision: 'allow_once' } },
      { kind: 'decide', decision: { decision: 'allow_always' } },
      { kind: 'decline' },
    ])
  })
  test('without a session option Decline moves up to 2 and stays last', () => {
    const card = approvalCard(request('Bash', { command: 'ls' }), 'claude-code')
    expect(rowLabels(card)).toEqual(['Run once', 'Decline and tell Claude what to do instead'])
    expect(rowForDigit(card!.rows, 2)?.id).toBe('decline')
    expect(rowForDigit(card!.rows, 3)).toBeNull()
  })
  test('Codex names Codex', () => {
    expect(rowLabels(approvalCard(request('shell', { command: 'ls' }), 'codex'))?.at(-1)).toBe('Decline and tell Codex what to do instead')
  })
  test('a Codex network request with no command is a grant, not "Run this command?"', () => {
    const card = approvalCard(request('shell', { command: '', network: { host: 'registry.npmjs.org' } }, [], 'network access to registry.npmjs.org'), 'codex')
    expect(card?.kind).toBe('grant')
    expect(rowLabels(card)).toEqual(['Grant once', 'Grant for this session', 'Decline and tell Codex what to do instead'])
  })
  test('a Codex edit that asks for a write root says the session option covers the root', () => {
    const card = approvalCard(request('apply_patch', { changes: [{ path: '/w/a.ts', diff: '+x' }], grant_root: '/w/out' }), 'codex')
    expect(card?.kind).toBe('edit')
    expect(card?.meta).toBe('Codex also asks to write in /w/out for the rest of the session.')
    expect(rowLabels(card)![1]).toBe('Allow writes in `/w/out` for this session')
  })
  test('an edit shows its diff', () => {
    const card = approvalCard(request('Edit', { file_path: '/p/src/date.ts', old_string: 'a\nb', new_string: 'a\nc\nd' }, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]), 'claude-code')
    expect(card?.title).toBe('Apply this edit?')
    expect(card?.well).toMatchObject({ kind: 'diff', diff: { added: 2, removed: 1 } })
    expect(rowLabels(card)![0]).toBe('Apply edit')
  })
  test('a write creates a file', () => {
    expect(approvalCard(request('Write', { file_path: '/p/new.ts', content: 'x' }), 'claude-code')?.title).toBe('Create this file?')
  })
  test('a plan: start implementing, or keep planning with a note', () => {
    const card = approvalCard(request('ExitPlanMode', { plan: '1. a' }), 'claude-code')
    expect(rowLabels(card)).toEqual(['Start implementing', 'Keep planning and tell Claude what to change'])
    expect(card?.rows[1]!.action).toEqual({ kind: 'decline' })
  })
  test('a connector: once, session only when allowed, decline; 1 is once now', () => {
    const input = (persist: string[]) => ({ serverName: 'Linear', message: 'Allow Linear to create an issue?', _meta: { codex_approval_kind: 'mcp_tool_call', connector_name: 'Linear', persist } })
    const both = approvalCard(request('mcp_elicitation', input(['session', 'always'])), 'codex')
    expect(rowLabels(both)).toEqual(['Allow once', 'Allow `Linear` for this session', 'Decline and tell Codex what to do instead'])
    expect(both?.rows[0]!.action).toEqual({ kind: 'decide', decision: { decision: 'submit', response: { action: 'accept', content: {} } } })
    expect(both?.rows[1]!.action).toEqual({ kind: 'decide', decision: { decision: 'submit', response: { action: 'accept', content: {}, _meta: { persist: 'session' } } } })
    expect(rowLabels(approvalCard(request('mcp_elicitation', input([])), 'codex'))).toEqual(['Allow once', 'Decline and tell Codex what to do instead'])
  })
  test('computer use: background offers Always allow as row 3 and decline is 4; foreground has no Always', () => {
    const background = approvalCard(request('kybern_computer_use', { app: 'Safari', mode: 'background' }), 'claude-code')
    expect(rowLabels(background)).toEqual(['Allow for this turn', 'Allow for this session', 'Always allow Safari in the background', 'Decline and tell Claude what to do instead'])
    expect(background?.rows[2]!.action).toEqual({ kind: 'decide', decision: { decision: 'submit', response: { scope: 'always' } } })
    expect(rowLabels(approvalCard(request('kybern_computer_use', { app: 'Safari', mode: 'foreground' }), 'claude-code'))).toHaveLength(3)
  })
  test('a note or task change: once, this thread, decline', () => {
    const card = approvalCard(request('kybern_notes_tasks', { action: 'create_task', title: 'T', criteria: 2 }, [], 'Create the task “T”'), 'claude-code')
    expect(card?.title).toBe('Create the task “T”?')
    expect(rowLabels(card)).toEqual(['Allow once', 'Allow for this thread', 'Decline and tell Claude what to do instead'])
  })
  test('permissions list one line each', () => {
    const card = approvalCard(request('external_directory', { permission: 'external_directory', patterns: ['~/.cache/*', '/tmp/x'] }), 'opencode')
    expect(card?.kind).toBe('grant')
    expect(card?.well).toEqual({ kind: 'grants', lines: [{ name: 'Access outside the workspace', target: '~/.cache/*', glyph: 'folder' }, { name: 'Access outside the workspace', target: '/tmp/x', glyph: 'folder' }] })
    expect(rowLabels(card)![0]).toBe('Grant once')
  })
  test('questions and forms have no card here', () => {
    expect(approvalCard(request('AskUserQuestion', { questions: [] }), 'claude-code')).not.toBeNull
  })
})

describe('key mapping', () => {
  test('digits are one-based positions; out of range is nothing', () => {
    const card = approvalCard(request('kybern_computer_use', { app: 'Safari', mode: 'background' }), 'claude-code')!
    expect([1, 2, 3, 4, 5].map((n) => rowForDigit(card.rows, n)?.id ?? null)).toEqual(['once', 'session', 'always', 'decline', null])
  })
  test('the highlight wraps both ways', () => {
    expect(stepHighlight(0, -1, 3)).toBe(2)
    expect(stepHighlight(2, 1, 3)).toBe(0)
    expect(stepHighlight(1, 1, 3)).toBe(2)
    expect(stepHighlight(0, 1, 0)).toBe(0)
  })
})

describe('decline reason', () => {
  test('Claude and the daemon cards carry it; other drivers drop it', () => {
    expect(forwardsDeclineReason(request('Bash', {}), 'claude-code')).toBe(true)
    expect(forwardsDeclineReason(request('shell', {}), 'codex')).toBe(false)
    expect(forwardsDeclineReason(request('kybern_computer_use', { app: 'x' }), 'codex')).toBe(true)
    expect(forwardsDeclineReason(request('kybern_notes_tasks', { action: 'create_note' }), 'codex')).toBe(true)
  })
})

describe('diffs', () => {
  test('keeps shared lines as context, in order', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([{ kind: 'ctx', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'add', text: 'x' }, { kind: 'ctx', text: 'c' }])
    expect(diffLines('', 'a')).toEqual([{ kind: 'add', text: 'a' }])
  })
  test('unified patches and Codex changes', () => {
    expect(editDiff({ path: 'p', patch: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n ctx' })).toMatchObject({ added: 1, removed: 1 })
    expect(editDiff({ changes: [{ path: '/a/b.ts', diff: '+x\n+y' }, { path: '/c.ts' }] })).toMatchObject({ path: 'b.ts and 1 more', added: 2 })
  })
  test('grant lines read Codex network and write roots', () => {
    expect(grantLines({ network: { host: 'registry.npmjs.org' }, grant_root: '~/.cache/bun' })).toEqual([{ name: 'Network access', target: 'registry.npmjs.org', glyph: 'network' }, { name: 'Write outside the workspace', target: '~/.cache/bun', glyph: 'folder' }])
  })
})
