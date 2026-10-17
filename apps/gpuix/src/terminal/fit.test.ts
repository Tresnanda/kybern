import { expect, test } from 'bun:test'
import { fitTerminal } from './fit.ts'

test('matches xterm.js FitAddon in the desktop dock pane', () => {
  // 538px dock at 1280x820: the desktop pty is 68 columns (measured over terminals.list).
  expect(fitTerminal(538, 690, 7, 21.5).cols).toBe(68)
  expect(fitTerminal(538 + 6, 690, 7, 21.5).cols).toBe(68)
  expect(fitTerminal(538 + 7, 690, 7, 21.5).cols).toBe(69)
  expect(fitTerminal(538, 32 + 21.5 * 30, 7, 21.5).rows).toBe(30)
  expect(fitTerminal(538, 32 + 21.5 * 30 - 1, 7, 21.5).rows).toBe(29)
})
