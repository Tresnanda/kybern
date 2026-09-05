/**
 * Transcript, composer and the draft landing share this gutter so their
 * centered 46rem columns line up edge to edge. A split pane overrides the
 * variable with the compact 12/20px surface gutter; the single-thread
 * view keeps the wider reading gutter needed by the message rail.
 */
export const CHAT_COLUMN_GUTTER = "px-[var(--thread-chat-gutter,3.5rem)]"
export const CHAT_COLUMN_GUTTER_PX = 56
