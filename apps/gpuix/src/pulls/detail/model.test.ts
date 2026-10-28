import { describe, expect, test } from 'bun:test'
import { assessPullRequest, groupChecks } from '../../../../../packages/kybern-client/src/pullRequests.ts'
import type { PrCheck, PrDetailResult } from '../../../../../packages/kybern-client/src/types.ts'
import { avatarSource } from '../../kit/avatarSource.ts'
import { actionFailure, agentPrompt, barSegments, checksSummaryLine, foldChecks, foldedWords, groupSubtitle, needsConfirmation, requestForMenu, requestForPrimary, reviewerRows, wantsToMerge } from './model.ts'

const check = (name: string, status: string, conclusion: string, over: Partial<PrCheck> = {}): PrCheck => ({ name, status, conclusion, url: '', ...over })
const NOW = Date.parse('2026-10-28T10:00:00Z')
const checks = [
  check('Tests (1/4)', 'IN_PROGRESS', '', { workflow_name: 'CI', is_required: true, started_at: '2026-10-28T09:56:48Z' }),
  check('Tests (2/4)', 'COMPLETED', 'SUCCESS', { workflow_name: 'CI', is_required: true, started_at: '2026-10-28T09:56:48Z', completed_at: '2026-10-28T09:58:00Z' }),
  check('Tests (3/4)', 'COMPLETED', 'FAILURE', { workflow_name: 'CI', is_required: true, started_at: '2026-10-28T09:56:48Z', completed_at: '2026-10-28T09:58:10Z' }),
  check('Typecheck', 'COMPLETED', 'SUCCESS'),
  check('Deploy preview', 'COMPLETED', 'SKIPPED'),
]

describe('verdict actions', () => {
  const pr = { number: 1, title: 'T', url: 'u', state: 'OPEN', head: 'dev', base: 'staging', is_draft: false, author: 'a', updated_at: '2026-10-28T09:00:00Z' }
  const viewer = { can_merge: true, can_merge_as_admin: true, can_update_branch: true, can_enable_auto_merge: true, can_disable_auto_merge: true, can_mark_ready: true, merge_methods: ['squash', 'merge'] as ('squash' | 'merge')[] }
  test('a ready pull request merges with the preferred method and asks first', () => {
    const a = assessPullRequest({ pull_request: pr, merge_state_status: 'CLEAN', checks: [check('A', 'COMPLETED', 'SUCCESS')], viewer }, NOW)
    expect(requestForPrimary(a.primary)).toEqual({ kind: 'merge', method: 'squash' })
    expect(needsConfirmation(requestForPrimary(a.primary)!)).toBe(true)
  })
  test('required running checks arm auto-merge without a dialog', () => {
    const a = assessPullRequest({ pull_request: pr, merge_state_status: 'BLOCKED', checks: [check('A', 'IN_PROGRESS', '')], viewer }, NOW)
    expect(requestForPrimary(a.primary)).toEqual({ kind: 'enable_auto_merge', method: 'squash' })
    expect(needsConfirmation(requestForPrimary(a.primary)!)).toBe(false)
  })
  test('checks that are not required can be merged past, after a confirmation that says so', () => {
    const a = assessPullRequest({ pull_request: pr, merge_state_status: 'UNSTABLE', checks: [check('A', 'IN_PROGRESS', '')], viewer }, NOW)
    expect(requestForPrimary(a.primary)).toBeNull()
    const anyway = requestForMenu(a.menu.find(m => m.label === 'Merge anyway')!)
    expect(anyway).toEqual({ kind: 'merge', method: 'squash', anyway: true })
    expect(needsConfirmation(anyway)).toBe(true)
  })
  test('conflicts go to an agent; none has no request', () => {
    const a = assessPullRequest({ pull_request: { ...pr, mergeable: 'CONFLICTING' }, merge_state_status: 'DIRTY', viewer }, NOW)
    expect(requestForPrimary(a.primary)).toEqual({ kind: 'agent', topic: 'conflicts' })
    expect(requestForPrimary({ kind: 'none', label: '' })).toBeNull()
  })
  test('Merge anyway is an admin merge', () => {
    const a = assessPullRequest({ pull_request: { ...pr, review_decision: 'REVIEW_REQUIRED' }, merge_state_status: 'BLOCKED', viewer }, NOW)
    const anyway = a.menu.find(m => m.kind === 'merge_admin')!
    expect(requestForMenu(anyway)).toEqual({ kind: 'merge', method: 'squash', admin: true })
  })
  test('failures read as sentences', () => {
    expect(actionFailure('Error: Head branch was modified')).toBe('Head branch was modified.')
    expect(actionFailure('Nope.')).toBe('Nope.')
  })
})

describe('checks', () => {
  const groups = groupChecks(checks, NOW)
  const rows = foldChecks(groups)
  test('failed first, then running; passed and skipped fold', () => {
    expect(rows.open.map(g => `${g.bucket}:${g.label}`)).toEqual(['failed:Tests'])
    expect(foldChecks(groupChecks(checks.filter(c => !c.name.includes('3/4')), NOW)).open.map(g => g.bucket)).toEqual(['pending'])
    expect(rows.folded.map(g => g.label)).toEqual(['Typecheck', 'Deploy preview'])
    expect(foldedWords(rows)).toEqual(['1 passed', '1 skipped'])
  })
  test('a sharded required job says how far it is', () => {
    expect(groupSubtitle(rows.open[0])).toBe('Required · shards 2/3 done · 1 failed')
    expect(groupSubtitle(rows.folded[0])).toBe('')
  })
  test('the summary line and bar agree', () => {
    const s = { total: 12, passed: 1, failed: 0, pending: 6, skipped: 5 }
    expect(checksSummaryLine(s)).toBe('6 running · 1 passed · 5 skipped')
    expect(barSegments(s)).toEqual([{ bucket: 'pending', flex: 6 }, { bucket: 'passed', flex: 1 }, { bucket: 'skipped', flex: 5 }])
  })
})

describe('reviewers', () => {
  test('one row per person, changes requested first, requested names kept', () => {
    const detail: Pick<PrDetailResult, 'reviews' | 'reviewers'> = { reviews: [{ login: 'ann', state: 'APPROVED' }, { login: 'kevin', state: 'CHANGES_REQUESTED', avatar_url: 'https://x/y' }, { login: 'bo', state: 'COMMENTED' }], reviewers: ['zed', 'ann'] }
    expect(reviewerRows(detail).map(r => `${r.login}:${r.state}`)).toEqual(['kevin:changes_requested', 'zed:requested', 'ann:approved', 'bo:commented'])
  })
})

describe('words and sources', () => {
  test('the heading sentence follows the state', () => {
    expect(wantsToMerge('OPEN', 3)).toBe('wants to merge 3 commits into')
    expect(wantsToMerge('OPEN', 1)).toBe('wants to merge 1 commit into')
    expect(wantsToMerge('OPEN', undefined)).toBe('wants to merge into')
    expect(wantsToMerge('MERGED', 2)).toBe('merged 2 commits into')
  })
  test('avatar sources are https only and sized for the slot', () => {
    expect(avatarSource('https://avatars.githubusercontent.com/u/1?v=4', 20)).toBe('https://avatars.githubusercontent.com/u/1?v=4&s=40')
    expect(avatarSource('http://avatars.githubusercontent.com/u/1', 20)).toBe('')
    expect(avatarSource('not a url', 20)).toBe('')
  })
  test('agent prompts name the pull request and never ask to push', () => {
    const ctx = { number: 7, title: 'T', url: 'https://example.com/7', head: 'dev', base: 'staging', sha: '1234567890' }
    for (const p of [agentPrompt('conflicts', ctx), agentPrompt('checks', ctx, ['Tests']), agentPrompt('feedback', ctx, ['kevin'])]) {
      expect(p).toContain('#7')
      expect(p).toContain('12345678')
      expect(p).toMatch(/without asking/)
    }
    expect(agentPrompt('checks', ctx, ['Tests', 'Lint'])).toContain('"Tests", "Lint"')
  })
})
