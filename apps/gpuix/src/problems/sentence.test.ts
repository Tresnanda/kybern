import { describe, expect, test } from 'bun:test'
import { problemSentence } from './sentence.ts'

describe('problemSentence', () => {
  test('is the headline and one sentence, without the technical text', () => {
    const text = problemSentence(new Error('RpcCallError: run gh: program not found'), { action: 'send your answer' })
    expect(text).toMatch(/^Install GitHub CLI to send your answer\. /)
    expect(text).not.toMatch(/RpcCallError|program not found/)
  })

  test('a plain message is kept as the sentence', () => {
    expect(problemSentence(new Error('Pick a folder inside this project.'), { action: 'send your choice' })).toBe("Couldn't send your choice. Pick a folder inside this project.")
  })

  test('does not point at a Details button that is not there', () => {
    expect(problemSentence(new Error('exit status 1'), { action: 'save the capture' })).toBe("Couldn't save the capture. Try again.")
  })
})
