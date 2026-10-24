import { describe, expect, test } from 'bun:test'
import { candidatePathHint, copyChoices, folderName, mergeCandidates, nonMembers, orderCandidates, relativeInside, remoteSlug, remoteWebUrl, tildify, toggled } from './model.ts'
import { groupsSupported } from './store.ts'

describe('group sheet paths', () => {
  test('tildify shortens the home folder only', () => {
    expect(tildify('/Users/me/work/acme', '/Users/me')).toBe('~/work/acme')
    expect(tildify('/Users/me', '/Users/me/')).toBe('~')
    expect(tildify('/Users/meg/acme', '/Users/me')).toBe('/Users/meg/acme')
  })
  test('relativeInside keeps picks inside the group folder', () => {
    expect(relativeInside('/w/acme', '/w/acme/services/billing')).toBe('services/billing')
    expect(relativeInside('/w/acme/', '/w/acme')).toBe('.')
    expect(relativeInside('/w/acme', '/w/acme-old/api')).toBeNull()
    expect(relativeInside('/w/acme', '/w/other')).toBeNull()
  })
  test('folderName and the path hint', () => {
    expect(folderName('/w/acme/')).toBe('acme')
    expect(candidatePathHint({ path: 'services/billing', name: 'billing' })).toBe('services/billing')
    expect(candidatePathHint({ path: 'api', name: 'api' })).toBeNull()
    expect(candidatePathHint({ path: '.', name: 'acme' })).toBeNull()
  })
})

describe('checklist selection', () => {
  test('toggling keeps the daemon order, the group folder first', () => {
    expect(toggled([], 'web')).toEqual(['web'])
    expect(toggled(['web'], 'api')).toEqual(['api', 'web'])
    expect(toggled(['api', 'web'], '.')).toEqual(['.', 'api', 'web'])
    expect(toggled(['api', 'web'], 'api')).toEqual(['web'])
  })
  test('a rescan appends the added folder, tagged, in order', () => {
    const shown = orderCandidates([{ path: 'web', name: 'web' }, { path: 'api', name: 'api' }])
    expect(shown.map((c) => c.path)).toEqual(['api', 'web'])
    const merged = mergeCandidates(shown, [{ path: 'api', name: 'api' }, { path: 'deep/docs', name: 'docs' }, { path: 'web', name: 'web' }], ['deep/docs'])
    expect(merged.map((c) => c.path)).toEqual(['api', 'deep/docs', 'web'])
    expect(merged.find((c) => c.path === 'deep/docs')?.added).toBe(true)
    expect(merged.find((c) => c.path === 'api')).toBe(shown[0])
  })
  test('add repositories offers non-members; copy offers unpicked top-level entries', () => {
    expect(nonMembers([{ path: 'api', name: 'api' }, { path: 'docs', name: 'docs' }], ['api']).map((c) => c.path)).toEqual(['docs'])
    const entries = [{ name: '.git', is_dir: true }, { name: '.env', is_dir: false }, { name: 'api', is_dir: true }, { name: 'Makefile', is_dir: false }]
    expect(copyChoices(entries, ['Makefile'], ['api']).map((e) => e.name)).toEqual(['.env'])
  })
})

describe('remotes and gating', () => {
  test('remote slugs and web pages', () => {
    expect(remoteSlug('git@github.com:acme/api.git')).toBe('acme/api')
    expect(remoteSlug('https://github.com/acme/web')).toBe('acme/web')
    expect(remoteSlug(null)).toBeNull()
    expect(remoteWebUrl('git@github.com:acme/api.git')).toBe('https://github.com/acme/api')
    expect(remoteWebUrl('/srv/git/api')).toBeNull()
  })
  test('group projects need daemon 0.15.0', () => {
    const saved = process.env.KYBERN_GROUPS
    delete process.env.KYBERN_GROUPS
    expect(groupsSupported('0.14.9')).toBe(false)
    expect(groupsSupported('0.15.0')).toBe(true)
    expect(groupsSupported('1.0.0')).toBe(true)
    expect(groupsSupported(null)).toBe(false)
    if (saved !== undefined) process.env.KYBERN_GROUPS = saved
  })
})
