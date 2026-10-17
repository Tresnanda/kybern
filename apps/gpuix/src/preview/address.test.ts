import { expect, test } from 'bun:test'
import { currentAddress, reloadAddress } from './address.ts'
import type { Entry } from './store.ts'
const file: Entry = { kind: 'file', address: '/project/mock/index.html', url: 'https://daemon/preview-files/ticket/mock/index.html', title: 'index.html', target: { kind: 'file', path: '/project/mock/index.html', root: '/project', in_project: true } }
test('file chrome and both reload paths retain actual bridge path, query and hash', () => {
  const address = currentAddress(file, 'other/next.html?mode=1#step', { projectName: 'Demo' })
  expect(address.full).toBe('/project/other/next.html?mode=1#step')
  expect(address.segments.map(s => s.text).join('')).toBe('Demo › other › next.html?mode=1#step')
  expect(reloadAddress(file, 'other/next.html?mode=1#step')).toBe('https://daemon/preview-files/ticket/other/next.html?mode=1#step')
  expect(() => reloadAddress(file, '../../outside')).toThrow('Invalid preview file path')
})
test('server rest chrome and no-cache reload retain nested path and all page query values', () => {
  const server: Entry = { kind: 'server', address: 'http://localhost:5173/nested/page?mode=1#step', url: 'https://daemon/preview-proxy/ticket/', frameUrl: 'http://127.0.0.1:5555/nested/page?mode=1#step', title: 'server' }
  expect(currentAddress(server).segments).toEqual([{ text: 'localhost:5173', emphasis: true }, { text: '/nested/page?mode=1#step', emphasis: false }])
  expect(reloadAddress(server, undefined, true, 42)).toBe('http://127.0.0.1:5555/nested/page?mode=1&__kybern_reload=42#step')
  expect(reloadAddress(server)).toBe(server.frameUrl!)
})
