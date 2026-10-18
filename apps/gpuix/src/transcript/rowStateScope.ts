import {createContext} from 'react'

/** Owned by one transcript, so disclosure state outlives disposable bodies
 * without keeping those bodies mounted or leaking into another thread. */
export const TranscriptRowStateScope = createContext<Map<string, unknown> | null>(null)
