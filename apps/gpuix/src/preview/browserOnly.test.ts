import { expect, test } from 'bun:test'
import { browserOnlyCopy } from './browserOnly.ts'
import { browserAddress } from './address.ts'
import type { Entry } from './store.ts'

test('the dock says where the page is, and what to do when the browser did not open', () => {
  expect(browserOnlyCopy(false, null, 'localhost:5173').title).toBe('Opening in your browser…')
  expect(browserOnlyCopy(true, null, 'localhost:5173').title).toBe('Opened in your browser')
  expect(browserOnlyCopy(true, null, 'localhost:5173').body).toContain("can't embed web pages")
  expect(browserOnlyCopy(false, 'Could not open the browser.', 'localhost:5173')).toEqual({ title: "Couldn't open your browser", body: 'Open localhost:5173 again, or copy its address and paste it into a browser.' })
})
const server: Entry = { address: 'http://localhost:5173/', url: '/preview-proxy/T', frameUrl: 'http://127.0.0.1:4455/', title: 'localhost', kind: 'server', proxy: true }
test('the browser opens the server itself, or the local relay when the server is on another machine', () => {
  expect(browserAddress(server, undefined, true, false)).toBe('http://localhost:5173/')
  expect(browserAddress(server, undefined, false, false)).toBe('http://127.0.0.1:4455/')
  // macOS keeps its address whatever the environment.
  expect(browserAddress(server, undefined, false, true)).toBe('http://localhost:5173/')
  expect(browserAddress({ ...server, frameUrl: undefined }, undefined, false, false)).toBe('http://localhost:5173/')
})
