import { describe, expect, test } from 'bun:test'
import { installDefaultLocale, systemLocale, webKitLocale } from './locale.ts'

describe('webKitLocale', () => {
  test('resolves English regions without a macOS localization to en-GB', () => {
    expect(webKitLocale('en-ID')).toBe('en-GB')
    expect(webKitLocale('en_SG')).toBe('en-GB')
    expect(webKitLocale('en-US')).toBe('en-US')
    expect(webKitLocale('en-AU')).toBe('en-AU')
    expect(webKitLocale('id-ID')).toBe('id-ID')
    expect(webKitLocale('fr')).toBe('fr')
    expect(webKitLocale('zh-Hans-CN')).toBe('zh-CN')
  })
})

describe('installDefaultLocale', () => {
  test('gives the desktop helpers the system locale, and leaves explicit locales alone', () => {
    installDefaultLocale('en-GB')
    const date = new Date(2026, 9, 18, 0, 18)
    expect(date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })).toBe('18 Oct')
    expect(date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })).toBe('0:18')
    expect(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })).toBe('Oct 18')
    expect(new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)).toBe('0:18')
    expect((1234.5).toLocaleString()).toBe('1,234.5')
  })
  test('reads a locale Intl supports from this machine', () => {
    const locale = systemLocale()
    expect(locale === null || Intl.DateTimeFormat.supportedLocalesOf([locale]).length === 1).toBe(true)
  })
})
