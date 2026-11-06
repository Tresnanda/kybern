import { describe, expect, test } from 'bun:test'
import { cliRefusedCopy } from './cliProblem.ts'

describe('cli problems', () => {
  test('a refused link says what to do, without the code or the path', () => {
    const copy = cliRefusedCopy('install', 'Unable to link C:\Users\a\.local\bin\kybern: EPERM: operation not permitted, symlink')!
    expect(copy.title).toBe("Couldn't install the kybern command")
    expect(`${copy.title} ${copy.body}`).not.toMatch(/EPERM|C:/)
    expect(copy.body).toContain('try again')
  })

  test('other failures are left to describeProblem', () => {
    expect(cliRefusedCopy('install', 'Kybern couldn’t find your home folder.')).toBeNull()
  })
})
