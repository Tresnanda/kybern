// What text-lab.tsx draws and text-check.ts measures (WP8).

/** The kit's weights, the in-between ones (450, 550, 650) included. */
export const WEIGHTS = [300, 400, 450, 500, 550, 600, 650, 700] as const
/** Font size and line height pairs the kit uses. */
export const SIZES = [[11, 16], [11.5, 17], [12, 16], [12.5, 18], [13, 18], [14, 20], [15, 22], [16.15, 25.85], [17, 22.1], [20, 28]] as const
/** Long enough that one weight step moves the (whole-pixel) bounds by more than a pixel. */
export const LADDER = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.'
/** Flat tops and no descenders: the ink's first and last rows are the cap height and the baseline. */
export const CAPS = 'HHHHHHHH'
export const MONO = 'const answer = compute(42) // ok'
export const MONO_SIZE = 13
/** 40 characters at 24 px: JetBrains Mono (0.6 em) and Menlo or DejaVu Sans Mono (0.602 em) differ by 2 px. */
export const MONO_PROBE = 'abcdefghijklmnopqrstuvwxyz0123456789{}()'
export const MONO_PROBE_SIZE = 24
/** One paragraph of inline code, which the rich editor draws at 0.833 of its size (`kszl`). */
export const INLINE = 'M'.repeat(20)
/** `.note-prose`'s reading size (RichEditor's `READ`). */
export const EDITOR_SIZE = 16.1538
export const INLINE_SCALE = 0.833
export const EMOJI = '😀👍🏽🚀❤️🇯🇵'
/** Emoji presentation asked for by U+FE0F (and a keycap) on characters a text font covers too. */
export const EMOJI_VS16 = '❤️⚠️☀️1️⃣'
/** A task chip (drawn at 0.867, `kszl`) and an ordered list (its numbers in the same font with `tnum`, sharing the face). */
export const CHIP = `[${'M'.repeat(12)}](kybern://task/11111111-1111-4111-8111-111111111111)`
export const ORDERED = '1. One\n2. Two'
/** An emoji outside and inside inline code: the code's fallback glyph is drawn at 0.833 too. */
export const CODE_EMOJI = '😀 `😀`'
export const CJK = '漢字かなカナ한국어中文'
export const WRAP = 'Kybern drives coding agents. Long agent replies wrap across several lines at the chat column width, so every line box has to match.'
export const WRAP_WIDTH = 260
export const BACKGROUND = [0x18, 0x18, 0x18] as const
export const FOREGROUND = [0xfc, 0xfc, 0xfc] as const
