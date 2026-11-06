import { describe, expect, test } from 'bun:test'
import { actionPhrase } from './action.ts'

describe('actionPhrase', () => {
  test('turns an old title into the phrase after "Couldn\'t"', () => {
    expect(actionPhrase('Unable to open link')).toBe('open link')
    expect(actionPhrase('Unable to ask Claude to sign in. Try again')).toBe('ask Claude to sign in')
    expect(actionPhrase('Couldn’t steer with this follow-up. If the turn just ended it was already sent.')).toBe('steer with this follow-up')
    expect(actionPhrase('Unable to cancel the turn. Press Esc to try again')).toBe('cancel the turn')
  })

  test('leaves a phrase alone', () => {
    expect(actionPhrase('rename the thread')).toBe('rename the thread')
  })

  test('never returns an empty phrase', () => {
    expect(actionPhrase('')).toBe('finish that')
  })
})
