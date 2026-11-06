import { describe, expect, test } from 'bun:test'
import { worktreeLock, worktreeLockCopy } from './worktreeProblem.ts'

describe('worktree file locks', () => {
  test('a Windows sharing violation is a lock', () => {
    expect(worktreeLock('failed to remove D:\work\wt: The process cannot access the file because it is being used by another process. (os error 32)')).toEqual({})
    expect(worktreeLock('error: unable to unlink old \'src/a.rs\': Permission denied')).toEqual({})
  })

  test('names the program when the error does', () => {
    const lock = worktreeLock('the file is being used by another process (Code.exe)')
    expect(lock).toEqual({ holder: 'Code' })
    expect(worktreeLockCopy(lock!).title).toBe('Code is using this worktree')
  })

  test('says the work is safe, with no path or code in the words', () => {
    const { title, body } = worktreeLockCopy({})
    expect(title).toBe('A program is using this worktree')
    expect(body).toContain('Your work is safe')
    expect(`${title} ${body}`).not.toMatch(/os error|EBUSY/)
  })

  test('another failure is not a lock', () => {
    expect(worktreeLock('not a git repository')).toBeNull()
  })
})
