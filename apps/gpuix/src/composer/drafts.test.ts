import { describe, expect, test } from 'bun:test'
import { createDraftStore, type StoredDraft } from './drafts.ts'

function store(initial: [string, StoredDraft<string>][] = []) {
  let saved: [string, StoredDraft<string>][] = initial
  const drafts = createDraftStore<string>(() => saved, (entries) => { saved = entries })
  return { drafts, saved: () => saved }
}

describe('composer drafts', () => {
  test('text typed before a card replaced the composer is there when the next composer mounts', () => {
    const { drafts } = store()
    drafts.keep('pane:thread:1', 'half a sentence', ['a.png'])
    expect(drafts.get('pane:thread:1')).toEqual({ text: 'half a sentence', attachments: ['a.png'] })
  })

  test('an empty composer forgets its key; a sent draft is dropped', () => {
    const { drafts, saved } = store()
    drafts.keep('k', 'hello', [])
    drafts.keep('k', '', [])
    expect(drafts.get('k')).toBeUndefined()
    drafts.keep('k', 'again', [])
    drafts.drop('k', true)
    expect(drafts.get('k')).toBeUndefined()
    expect(saved()).toEqual([])
  })

  test('drafts are written out and read back, and a changed environment reloads them', () => {
    const { drafts, saved } = store()
    drafts.keep('k', 'kept', [])
    expect(saved()).toEqual([['k', { text: 'kept', attachments: [] }]])
    const other = createDraftStore<string>(() => saved(), () => {})
    expect(other.get('k')?.text).toBe('kept')
    drafts.drop('k')
    drafts.reload()
    expect(drafts.get('k')?.text).toBe('kept')
  })

  test('only the newest hundred are written out', () => {
    const { drafts, saved } = store()
    for (let i = 0; i < 105; i++) drafts.keep(`k${i}`, `t${i}`, [])
    expect(saved().length).toBe(100)
    expect(saved()[0]![0]).toBe('k5')
  })
})
