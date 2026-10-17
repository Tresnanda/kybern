/**
 * xterm.js 6.0.0's `Utf8ToUtf32` (`common/input/TextDecoder.ts`), which decodes the pty bytes the desktop writes:
 * invalid sequences, overlong forms, surrogates and U+FEFF are dropped (a `TextDecoder` would print U+FFFD for each),
 * and a sequence split across chunks is kept in `interim` for the next one.
 */
export class Utf8ToUtf32 {
  public interim = new Uint8Array(3)
  private target = new Uint32Array(0)

  /** The chunk as a string; partial trailing sequences wait for the next chunk. */
  public decodeString(input: Uint8Array): string {
    if (this.target.length < input.length) this.target = new Uint32Array(Math.max(input.length, 1024))
    const size = this.decode(input, this.target)
    let out = ''
    for (let i = 0; i < size; i += 4096) out += String.fromCodePoint(...this.target.subarray(i, Math.min(size, i + 4096)))
    return out
  }

  public decode(input: Uint8Array, target: Uint32Array): number {
    const length = input.length
    if (!length) return 0
    let size = 0, byte1: number, byte2: number, byte3: number, byte4: number, codepoint: number, startPos = 0
    // Leftover bytes from the previous chunk.
    if (this.interim[0]) {
      let discardInterim = false
      let cp = this.interim[0]
      cp &= (cp & 0xE0) === 0xC0 ? 0x1F : (cp & 0xF0) === 0xE0 ? 0x0F : 0x07
      let pos = 0, tmp: number
      while ((tmp = this.interim[++pos]! & 0x3F) && pos < 4) { cp <<= 6; cp |= tmp }
      const type = (this.interim[0] & 0xE0) === 0xC0 ? 2 : (this.interim[0] & 0xF0) === 0xE0 ? 3 : 4
      const missing = type - pos
      while (startPos < missing) {
        if (startPos >= length) return 0
        tmp = input[startPos++]!
        if ((tmp & 0xC0) !== 0x80) { startPos--; discardInterim = true; break }
        this.interim[pos++] = tmp
        cp <<= 6; cp |= tmp & 0x3F
      }
      if (!discardInterim) {
        if (type === 2) { if (cp < 0x80) startPos--; else target[size++] = cp }
        else if (type === 3) { if (!(cp < 0x0800 || (cp >= 0xD800 && cp <= 0xDFFF) || cp === 0xFEFF)) target[size++] = cp }
        else if (!(cp < 0x010000 || cp > 0x10FFFF)) target[size++] = cp
      }
      this.interim.fill(0)
    }
    let i = startPos
    while (i < length) {
      byte1 = input[i++]!
      if (byte1 < 0x80) target[size++] = byte1
      else if ((byte1 & 0xE0) === 0xC0) {
        if (i >= length) { this.interim[0] = byte1; return size }
        byte2 = input[i++]!
        if ((byte2 & 0xC0) !== 0x80) { i--; continue }
        codepoint = (byte1 & 0x1F) << 6 | (byte2 & 0x3F)
        if (codepoint < 0x80) { i--; continue }
        target[size++] = codepoint
      } else if ((byte1 & 0xF0) === 0xE0) {
        if (i >= length) { this.interim[0] = byte1; return size }
        byte2 = input[i++]!
        if ((byte2 & 0xC0) !== 0x80) { i--; continue }
        if (i >= length) { this.interim[0] = byte1; this.interim[1] = byte2; return size }
        byte3 = input[i++]!
        if ((byte3 & 0xC0) !== 0x80) { i--; continue }
        codepoint = (byte1 & 0x0F) << 12 | (byte2 & 0x3F) << 6 | (byte3 & 0x3F)
        if (codepoint < 0x0800 || (codepoint >= 0xD800 && codepoint <= 0xDFFF) || codepoint === 0xFEFF) continue
        target[size++] = codepoint
      } else if ((byte1 & 0xF8) === 0xF0) {
        if (i >= length) { this.interim[0] = byte1; return size }
        byte2 = input[i++]!
        if ((byte2 & 0xC0) !== 0x80) { i--; continue }
        if (i >= length) { this.interim[0] = byte1; this.interim[1] = byte2; return size }
        byte3 = input[i++]!
        if ((byte3 & 0xC0) !== 0x80) { i--; continue }
        if (i >= length) { this.interim[0] = byte1; this.interim[1] = byte2; this.interim[2] = byte3; return size }
        byte4 = input[i++]!
        if ((byte4 & 0xC0) !== 0x80) { i--; continue }
        codepoint = (byte1 & 0x07) << 18 | (byte2 & 0x3F) << 12 | (byte3 & 0x3F) << 6 | (byte4 & 0x3F)
        if (codepoint < 0x010000 || codepoint > 0x10FFFF) continue
        target[size++] = codepoint
      }
      // Any other byte is illegal and skipped.
    }
    return size
  }
}
