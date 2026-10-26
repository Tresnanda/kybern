import { describe, expect, test } from 'bun:test'
import { anchorLabel, cleanPayload } from './hub.ts'
import { PICKER_SOURCE } from './pickerScript.ts'
import { anchorMentionPart, parseComposerChip, secretMentionPart } from '../../../../packages/kybern-client/src/userInput.ts'

describe('page payloads are untrusted data', () => {
  test('strings are bounded, numbers checked, unknown fields dropped', () => {
    const payload = cleanPayload({ selector: 'button.buy', tag: 'button', text: 'x'.repeat(2000), html: '<b>'.repeat(2000), page_url: 'http://localhost/', box: { x: 1.5, y: 2, width: 30, height: 10 }, id: 'pay', evil: { a: 1 }, __proto__: { polluted: true } })!
    expect(payload.selector).toBe('button.buy')
    expect(payload.text!.length).toBe(300)
    expect(payload.html!.length).toBe(1500)
    expect(payload.box).toEqual({ x: 1.5, y: 2, width: 30, height: 10 })
    expect('evil' in payload).toBe(false)
  })
  test('no selector, an empty box or a non-finite number is no element', () => {
    expect(cleanPayload({ text: 'hi' })).toBeNull()
    expect(cleanPayload(null)).toBeNull()
    expect(cleanPayload('button')).toBeNull()
    expect(cleanPayload({ selector: 'a', box: { x: 0, y: 0, width: 0, height: 10 } })!.box).toBeUndefined()
    expect(cleanPayload({ selector: 'a', box: { x: NaN, y: 0, width: 5, height: 10 } })!.box).toBeUndefined()
  })
  test('anchor labels name the element', () => {
    expect(anchorLabel({ selector: 'x', tag: 'button', text: 'Pay $48.00' })).toBe('button “Pay $48.00”')
    expect(anchorLabel({ selector: 'x', tag: 'button', text: 'Pay', id: 'pay' })).toBe('pay')
    expect(anchorLabel({ selector: 'main > div:nth-of-type(2)', tag: 'div' })).toBe('main > div:nth-of-type(2)')
    expect(anchorLabel({ selector: 's', tag: 'p', text: 'a "quoted" very long sentence that goes on' })).toBe('p “a quoted very long sent…”')
  })
})

describe('the picker script', () => {
  test('is valid JavaScript that returns its readiness', () => {
    expect(() => new Function(`return ${PICKER_SOURCE}`)).not.toThrow()
    expect(PICKER_SOURCE).not.toContain('`')
    expect(PICKER_SOURCE).not.toContain('${')
  })
  test('talks only through the isolated-world handler', () => {
    expect(PICKER_SOURCE).toContain('webkit.messageHandlers.kybernFrame.postMessage')
    expect(PICKER_SOURCE).not.toContain('eval(')
  })
  test('synthetic events from the page never become an anchor, a pick or a cancel', () => {
    const { fire, posted, picker } = runPicker()
    const button = element('button')
    for (const type of ['mousedown', 'click']) fire(type, { isTrusted: false, altKey: true, button: 0, target: button })
    expect(posted).toEqual([])
    fire('mousedown', { isTrusted: true, altKey: true, button: 0, target: button })
    fire('click', { isTrusted: true, altKey: true, button: 0, target: button })
    expect(posted.map(m => m.event)).toEqual(['anchor'])
    expect(posted[0]!.payload).toMatchObject({ tag: 'button', selector: 'button' })

    posted.length = 0
    expect(picker().start('Pick')).toBe('picking')
    fire('mousemove', { isTrusted: false, target: button })
    fire('click', { isTrusted: false, target: button })
    fire('keydown', { isTrusted: false, key: 'Enter' })
    fire('keydown', { isTrusted: false, key: 'Escape' })
    expect(posted).toEqual([])
    fire('mousemove', { isTrusted: true, target: button })
    fire('click', { isTrusted: true, target: button })
    expect(posted.map(m => m.event)).toEqual(['picked'])
    posted.length = 0
    picker().start('Pick')
    fire('keydown', { isTrusted: true, key: 'Escape' })
    expect(posted.map(m => m.event)).toEqual(['cancelled'])
  })
})

/** A DOM element as far as the picker reads one. */
function element(tag: string): any {
  return {
    nodeType: 1, localName: tag, id: '', classList: [], parentElement: null, innerText: 'Buy', textContent: 'Buy', outerHTML: `<${tag}>Buy</${tag}>`,
    getAttribute: () => null, closest: () => null, getBoundingClientRect: () => ({ x: 1, y: 2, left: 1, top: 2, width: 30, height: 10, bottom: 12 }),
  }
}

/** The picker source run against a stub window and document; `fire` calls its capture listeners like the DOM would. */
function runPicker() {
  const listeners = new Map<string, ((event: any) => void)[]>()
  const target = () => ({
    addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, [...listeners.get(type) ?? [], listener]),
    removeEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, (listeners.get(type) ?? []).filter(l => l !== listener)),
  })
  const posted: { kind: string; event: string; payload: any }[] = []
  const node = (): any => ({ style: {}, className: '', textContent: '', appendChild: () => {}, addEventListener: () => {}, remove: () => {}, attachShadow: () => node() })
  const document = { ...target(), querySelectorAll: () => ({ length: 1 }), documentElement: { appendChild: () => {} }, createElement: node, createTextNode: () => ({}) }
  const window: any = { ...target(), innerHeight: 800, innerWidth: 1000, focus: () => {}, webkit: { messageHandlers: { kybernFrame: { postMessage: (m: any) => posted.push(m) } } } }
  const location = { href: 'http://localhost:5173/' }
  new Function('window', 'document', 'location', 'requestAnimationFrame', 'CSS', `return ${PICKER_SOURCE}`)(window, document, location, () => {}, undefined)
  const fire = (type: string, init: Record<string, unknown>) => {
    const event = { preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, metaKey: false, ...init }
    for (const listener of listeners.get(type) ?? []) listener(event)
  }
  return { fire, posted, picker: () => window.__kybernPicker }
}

describe('composer chips', () => {
  test('a secret chip carries a name and a file, never a value', () => {
    expect(secretMentionPart({ key: 'STRIPE_SECRET_KEY', file: '.env' })).toEqual({ type: 'mention', name: 'STRIPE_SECRET_KEY', path: 'kybern://secret/STRIPE_SECRET_KEY', display_name: 'STRIPE_SECRET_KEY' })
    const local = secretMentionPart({ key: 'K', file: '.env.local' })
    expect(parseComposerChip(local.path)).toEqual({ kind: 'secret', key: 'K', file: '.env.local' })
  })
  test('an anchor chip round-trips its payload', () => {
    const part = anchorMentionPart('button “Pay”', { selector: 'button.buy', text: 'Pay é中', box: { x: 1, y: 2, width: 3, height: 4 } })
    const parsed = parseComposerChip(part.path)
    expect(parsed).toMatchObject({ kind: 'anchor', payload: { selector: 'button.buy', text: 'Pay é中' } })
    expect(parseComposerChip('kybern://anchor/%%%')).toBeNull()
    expect(parseComposerChip('kybern://computer')).toBeNull()
  })
})
