export const DEFAULT_CHAT_FONT_SIZE_PX = 14
export const MIN_CHAT_FONT_SIZE_PX = 11
export const MAX_CHAT_FONT_SIZE_PX = 18

export function normalizeChatFontSizePx(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CHAT_FONT_SIZE_PX
  return Math.min(MAX_CHAT_FONT_SIZE_PX, Math.max(MIN_CHAT_FONT_SIZE_PX, Math.round(value)))
}
