import { expect, test } from 'bun:test'
import { artifactBrowserCopy } from './artifactFallback.ts'

test('the artifact state walks idle, opening, opened, failed with a verb-first action', () => {
  expect(artifactBrowserCopy('idle', 'report.html')).toMatchObject({ title: 'Open this artifact in your browser', action: 'Open in browser' })
  expect(artifactBrowserCopy('opening', 'report.html').title).toBe('Opening in your browser…')
  expect(artifactBrowserCopy('opened', 'report.html')).toMatchObject({ title: 'Opened in your browser', action: 'Open again' })
  expect(artifactBrowserCopy('opened', 'report.html').body).toContain('report.html')
  expect(artifactBrowserCopy('failed', 'report.html')).toMatchObject({ title: "Couldn't open your browser", action: 'Try again' })
})
