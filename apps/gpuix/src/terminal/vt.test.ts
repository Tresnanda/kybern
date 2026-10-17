import { describe, expect, test } from 'bun:test'
import { VT } from './vt.ts'
import { terminalKey, terminalPaste, terminalMouse } from './keys.ts'
describe('bounded terminal', () => {
  test('carriage return, fragmented CSI, cursor and erase preserve text', () => {
    const vt = new VT(20, 3)
    vt.write('progress 10%\rprogress 20%\x1b['); vt.write('K\r\nnext')
    expect(vt.screen[0]!.chars.join('').trimEnd()).toBe('progress 20%')
    vt.write('\x1b[1;1H\x1b[31mred\x1b[0m')
    expect(vt.runs(vt.screen[0]!)[0]).toMatchObject({ text: 'red', style: { fg: 1 } })
    expect(vt.screen[1]!.chars.join('')).toBe('next')
  })
  test('screen wraps, wide characters, combining and alternate screen', () => {
    const vt = new VT(4, 2)
    vt.write('ab界e\u0301')
    expect(vt.screen[0]!.chars).toEqual(['a', 'b', '界', ''])
    expect(vt.screen[1]!.chars.join('')).toBe('e\u0301')
    vt.write('\x1b[?1049hother\x1b[?1049l')
    expect(vt.screen[0]!.chars.join('')).toBe('ab界')
    expect(vt.screen[1]!.chars.join('')).toBe('e\u0301')
  })
  test('OSC title is bounded, hyperlinks and clipboard are inert', () => {
    const vt = new VT()
    vt.write('\x1b]2;title\x1b'); vt.write('\\ok\x1b]52;c;secret\x07\x1b]8;;https://example.com\x07link\x1b]8;;\x07')
    expect(vt.title).toBe('title'); expect(vt.text().trim()).toBe('oklink')
  })
  test('200000 lines stay bounded with the last line intact', () => {
    const vt = new VT(80, 24)
    for (let i = 0; i < 200000; i++) vt.write(`${i}\r\n`)
    expect(vt.history.length).toBeLessThanOrEqual(5128)
    expect(vt.text()).toContain('199999')
    expect(vt.text()).not.toContain('100000\n')
  })
  test('true colour, indexed colour, scroll region and row insertion', () => {
    const vt = new VT(10, 4)
    vt.write('\x1b[38;2;10;20;30;48;5;200mX\x1b[0m\r\n1\r\n2\r\n3')
    expect(vt.runs(vt.screen[0]!)[0]!.style).toMatchObject({ fg: 'rgb(10,20,30)', bg: 200 })
    vt.write('\x1b[2;3r\x1b[3;1H\n')
    expect(vt.screen[0]!.chars.join('')).toBe('X')
    expect(vt.screen[1]!.chars.join('')).toBe('2')
    expect(vt.screen[3]!.chars.join('')).toBe('3')
  })
  test('resize, saved cursors and device replies stay within the new screen', () => {
    const replies: string[] = [], vt = new VT(80, 24, 10, 1000, value => replies.push(value))
    vt.write('\x1b[24;80H\x1b7\x1b[?1049h')
    vt.resize(20, 4); vt.write('\x1b[?1049l\x1b8X\x1b[6n\x1b[5n')
    expect(vt.y).toBe(3); expect(vt.screen.length).toBe(4)
    expect(replies).toEqual(['\x1b[4;21R', '\x1b[0n'])  // x is still pending past the margin, as in xterm.js
    vt.write('\rA' + '\u0301'.repeat(10000))
    expect(vt.screen[3]!.chars[0]!.length).toBeLessThanOrEqual(64)
  })
  test('keyboard preserves command shortcuts and encodes control chords', () => {
    expect(terminalKey({ key: 'j', modifiers: { cmd: true, ctrl: false, alt: false, shift: false } })).toBeNull()
    expect(terminalKey({ key: 'c', modifiers: { cmd: false, ctrl: true, alt: false, shift: false } })).toBe('\x03')
    expect(terminalKey({ key: 'up' })).toBe('\x1b[A')
    expect(terminalKey({ key: 'up' }, true)).toBe('\x1bOA')
    expect(terminalKey({ key: 'enter' })).toBe('\r')
    expect(terminalKey({ key: 'a', keyChar: 'A', modifiers: { cmd: false, ctrl: false, alt: false, shift: true } })).toBe('A')
  })
  test('origin mode addresses inside scroll margins and reset restores normal modes', () => {
    const vt = new VT(10, 5)
    vt.write('\x1b[2;4r\x1b[?6h\x1b[1;1HX')
    expect(vt.screen[1]!.chars.join('')).toBe('X')
    vt.write('\x1b[99B'); expect(vt.y).toBe(3)
    // xterm.js adds the margin again to relative moves in origin mode (reference: 'origin mode relative moves').
    vt.write('\x1b[99A'); expect(vt.y).toBe(2)
    vt.write('\x1b[?25l\x1b[?2004h\x1b[?1h\x1bc\x1b[1;1HY')
    expect(vt.screen[0]!.chars.join('')).toBe('Y')
    expect(vt.cursorVisible).toBe(true)
    expect(vt.bracketedPaste).toBe(false)
    expect(vt.applicationCursor).toBe(false)
  })
  test('insert mode and colon-form RGB support empty color-space fields', () => {
    const vt = new VT(10, 2)
    vt.write('abcd\r\x1b[4hX\x1b[4lY')
    expect(vt.screen[0]!.chars.join('')).toBe('XYbcd')
    vt.write('\r\x1b[38:2::12:34:56mR')
    expect(vt.runs(vt.screen[0]!)[0]!.style.fg).toBe('rgb(12,34,56)')
  })

})

test('alternate-screen cursor restoration restores color and combining attaches to wide glyphs', () => {
  const vt = new VT(20, 3)
  vt.write('\x1b[31mA\x1b[?1049h\x1b[32mB\x1b[?1049lC界\u0301')
  expect(vt.runs(vt.screen[0]!)[0]!.style.fg).toBe(1)
  expect(vt.screen[0]!.chars.join('')).toBe('AC界\u0301')
  expect(vt.screen[0]!.chars[3]).toBe('')
})


test('cursor modes, origin reports and fragmented bracketed paste mode', () => {
  const replies: string[] = [], vt = new VT(20, 6, 10, 1000, value => replies.push(value))
  vt.write('\x1b[2;5r\x1b[?6h\x1b[2d\x1b[6n')
  expect(vt.y).toBe(2)
  expect(replies).toEqual(['\x1b[3;1R'])  // DSR reports the absolute row, as xterm.js does
  vt.write('\x1b[?1;25;2004'); vt.write('h')
  expect(terminalKey({ key: 'left' }, vt.applicationCursor)).toBe('\x1bOD')
  expect(terminalPaste('one\ntwo', vt.bracketedPaste)).toBe('\x1b[200~one\ntwo\x1b[201~')
  expect(terminalPaste('x\x1b[201~y', true)).toBe('\x1b[200~x[201~y\x1b[201~')
  vt.write('\x1b[?1;25;2004l')
  expect(vt.cursorVisible).toBe(false)
  expect(terminalPaste('plain', vt.bracketedPaste)).toBe('plain')
})

test('alternate screens preserve normal history and indexed/RGB pens after resize', () => {
  const vt = new VT(20, 3)
  vt.write('normal\r\n\x1b[38:5:232;48:2::1:2:3mA')
  const history = vt.history
  vt.write('\x1b[?1049h' + 'alternate\r\n'.repeat(20))
  expect(vt.history).toBe(history)
  expect(vt.history.length).toBe(0)
  vt.resize(10, 4)
  vt.write('\x1b[?1049lB')
  expect(vt.screen[0]!.chars.join('')).toBe('normal')
  expect(vt.runs(vt.screen[1]!)[0]!.style).toMatchObject({ fg: 232, bg: 'rgb(1,2,3)' })
  expect(vt.screen[1]!.chars.join('')).toBe('AB')
  expect(vt.screen.length).toBe(4)
})

test('the alternate buffer is blank every time it opens, like xterm.js', () => {
  const vt = new VT(20, 3)
  vt.write('normal\x1b[?47hgone\x1b[?47l')
  expect(vt.text()).toContain('normal')
  vt.write('\x1b[?47h')
  expect(vt.text().trim()).toBe('')
})

test('restoring a saved cursor does not mutate its saved color', () => {
  const vt = new VT(10, 2)
  vt.write('\x1b[31m\x1b7\x1b8\x1b[32mX\x1b8R')
  expect(vt.runs(vt.screen[0]!)[0]!.style.fg).toBe(1)
})

test('modified terminal keys preserve xterm control and function sequences', () => {
  const modifiers = { cmd: false, ctrl: true, alt: false, shift: false }
  expect(terminalKey({ key: 'space', modifiers })).toBe('\0')
  expect(terminalKey({ key: 'c', modifiers: { ...modifiers, alt: true } })).toBe('\x1b\x03')
  expect(terminalKey({ key: '3', modifiers })).toBe('\x1b')
  expect(terminalKey({ key: '8', modifiers })).toBe('\x7f')
  expect(terminalKey({ key: 'pageup', modifiers })).toBe('\x1b[5;5~')
  expect(terminalKey({ key: 'f1', modifiers: { ...modifiers, ctrl: false, shift: true } })).toBe('\x1b[1;2P')
  expect(terminalKey({ key: 'f5', modifiers: { ...modifiers, ctrl: false, alt: true } })).toBe('\x1b[15;3~')
})

test('mouse protocols preserve coordinates, release, drag, hover and Shift selection override', () => {
  const vt = new VT(300, 4)
  const event = { kind: 'down' as const, button: 0, column: 10, row: 2 }
  expect(terminalMouse(event, vt)).toBeNull()
  vt.write('\x1b[?1000;1006h')
  expect(terminalMouse(event, vt)).toBe('\x1b[<0;11;3M')
  expect(terminalMouse({ ...event, kind: 'up' }, vt)).toBe('\x1b[<0;11;3m')
  expect(terminalMouse({ ...event, kind: 'move' }, vt)).toBeNull()
  expect(terminalMouse({ ...event, modifiers: { shift: true } }, vt)).toBeNull()
  expect(terminalMouse({ ...event, kind: 'wheel', deltaY: 3 }, vt)).toBe('\x1b[<64;11;3M')
  expect(terminalMouse({ ...event, kind: 'wheel', deltaY: -3, modifiers: { ctrl: true, alt: true } }, vt)).toBe('\x1b[<89;11;3M')
  vt.write('\x1b[?1002h')
  expect(terminalMouse({ ...event, kind: 'move' }, vt)).toBe('\x1b[<32;11;3M')
  expect(terminalMouse({ ...event, kind: 'move', button: undefined }, vt)).toBeNull()
  vt.write('\x1b[?1003h')
  expect(terminalMouse({ ...event, kind: 'move', button: undefined }, vt)).toBe('\x1b[<35;11;3M')
  vt.write('\x1b[?1006l')
  expect(terminalMouse(event, vt)).toBe('\x1b[M' + String.fromCharCode(32, 43, 35))
  expect(terminalMouse({ ...event, kind: 'up' }, vt)).toBe('\x1b[M' + String.fromCharCode(35, 43, 35))
  expect(terminalMouse({ ...event, column: 240 }, vt)).toBeNull()
  // xterm.js ignores the UTF-8 (1005) and urxvt (1015) encodings.
  vt.write('\x1b[?1005h\x1b[?1015h')
  expect(terminalMouse({ ...event, column: 240 }, vt)).toBeNull()
  expect(terminalMouse(event, vt)).toBe('\x1b[M' + String.fromCharCode(32, 43, 35))
  vt.write('\x1b[?1004h\x1bc')
  expect(vt.mouseTracking).toBe(0)
  expect(vt.focusReporting || vt.mouseSgr || vt.mouseUtf8 || vt.mouseUrxvt).toBe(false)
})

test('initial terminal fit preserves replay above the cursor instead of dropping it', () => {
  const vt = new VT(80, 24)
  vt.write('First replayed line\r\nSecond replayed line')
  vt.resize(80, 20)
  expect(vt.screen[0]!.chars.join('')).toBe('First replayed line')
  expect(vt.screen[1]!.chars.join('')).toBe('Second replayed line')
  expect(vt.history).toHaveLength(0)
  vt.write('\x1b[20;1Hbottom')
  vt.resize(80, 18)
  expect(vt.history).toHaveLength(2)
  expect(vt.screen[17]!.chars.join('')).toBe('bottom')
})
