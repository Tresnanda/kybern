import { describe, expect, test } from 'bun:test'
import { VT } from './vt.ts'
import { terminalKey, terminalPaste } from './keys.ts'
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
    expect(replies).toEqual(['\x1b[4;20R', '\x1b[0n'])
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
    vt.write('\x1b[99A'); expect(vt.y).toBe(1)
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
  expect(replies).toEqual(['\x1b[2;1R'])
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

test('legacy alternate buffer is retained while 1047 clears it', () => {
  const vt = new VT(20, 3)
  vt.write('normal\x1b[?47hretained\x1b[?47l')
  expect(vt.text()).toContain('normal')
  vt.write('\x1b[?47h')
  expect(vt.text()).toContain('retained')
  vt.write('\x1b[?1047l\x1b[?47h')
  expect(vt.text().trim()).toBe('')
})

test('restoring a saved cursor does not mutate its saved color', () => {
  const vt = new VT(10, 2)
  vt.write('\x1b[31m\x1b7\x1b8\x1b[32mX\x1b8R')
  expect(vt.runs(vt.screen[0]!)[0]!.style.fg).toBe(1)
})
