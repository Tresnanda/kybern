// The pull request page's status glyphs: 16 px outlines at a 1.4 stroke, drawn for the design (`.kybern-artifacts/ade-85/mockups`)
// because Hugeicons has no skipped, queued or auto-merge mark. Same serialization as `icons.tsx`: a black stroke the `<svg>` tints.
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

export const G = {
  checkCircle: svg('<circle cx="8" cy="8" r="6.25"/><path d="M5.4 8.2l1.8 1.8 3.4-3.7"/>'),
  xCircle: svg('<circle cx="8" cy="8" r="6.25"/><path d="M6 6l4 4M10 6l-4 4"/>'),
  /** The running mark: a quarter arc on a faint ring. Still on check rows, spinning on the verdict card only. */
  running: svg('<circle cx="8" cy="8" r="6.25" stroke-opacity="0.32"/><path d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25"/>'),
  skip: svg('<circle cx="8" cy="8" r="6.25"/><path d="M5.6 8h4.8"/>'),
  queued: svg('<circle cx="8" cy="8" r="6.25" stroke-dasharray="2.2 2.2"/>'),
  merge: svg('<circle cx="4.5" cy="3.75" r="1.6"/><circle cx="4.5" cy="12.25" r="1.6"/><circle cx="11.5" cy="8.5" r="1.6"/><path d="M4.5 5.35v5.3M4.5 5.4c0 2.4 2.2 3.1 5.4 3.1"/>'),
  draft: svg('<circle cx="4.5" cy="3.75" r="1.6"/><circle cx="4.5" cy="12.25" r="1.6"/><path d="M4.5 5.35v5.3"/><path d="M11.5 4v1.2M11.5 7.4v1.2M11.5 10.8v.1"/>'),
  conflict: svg('<path d="M5 2.5v4.5M11 2.5v2M11 9v4.5M5 11v2.5"/><circle cx="5" cy="9" r="1.75"/><circle cx="11" cy="7" r="1.75"/>'),
  update: svg('<path d="M8 13.5V5.25M4.75 8.5L8 5.25l3.25 3.25M3.5 2.5h9"/>'),
  /** Auto-merge: a bolt in a ring. */
  auto: svg('<circle cx="8" cy="8" r="6.25"/><path d="M8.6 4.5L6.4 8.4h3.2L7.4 11.5"/>'),
  /** A sparkle: the agent actions. */
  agent: svg('<path d="M8 2.25l1.25 3.5 3.5 1.25-3.5 1.25L8 11.75 6.75 8.25 3.25 7l3.5-1.25z"/><path d="M12.5 10.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z"/>'),
  reviewX: svg('<path d="M2.75 4.25c0-.83.67-1.5 1.5-1.5h7.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5H7.4l-2.9 2.25v-2.25h-.25c-.83 0-1.5-.67-1.5-1.5z"/><path d="M6.4 5.4l3.2 3.2M9.6 5.4L6.4 8.6"/>'),
  reviewOk: svg('<path d="M2.75 4.25c0-.83.67-1.5 1.5-1.5h7.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5H7.4l-2.9 2.25v-2.25h-.25c-.83 0-1.5-.67-1.5-1.5z"/><path d="M5.9 7.1l1.4 1.4 2.8-3"/>'),
  message: svg('<path d="M2.75 4.25c0-.83.67-1.5 1.5-1.5h7.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5H7.4l-2.9 2.25v-2.25h-.25c-.83 0-1.5-.67-1.5-1.5z"/>'),
  clock: svg('<circle cx="8" cy="8" r="6.25"/><path d="M8 4.9v3.35l2.1 1.3"/>'),
  pr: svg('<circle cx="4.5" cy="3.75" r="1.6"/><circle cx="4.5" cy="12.25" r="1.6"/><circle cx="11.5" cy="12.25" r="1.6"/><path d="M4.5 5.35v5.3M11.5 10.65V6.5a2 2 0 0 0-2-2H7.4M8.9 3l-1.5 1.5L8.9 6"/>'),
  alert: svg('<path d="M8 2.6l5.9 10.2H2.1z"/><path d="M8 6.6v2.8M8 11.1v.05"/>'),
}
