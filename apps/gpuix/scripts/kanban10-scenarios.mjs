// Drag cases for the tall/short card gap check, shared by kanban10-ghost.ts (GPUIX) and kanban10-ghost-tauri.mjs (desktop).
// `over` is the card the pointer ends on; `edge` which end of it (inside its rect, past its middle).
// Each scenario starts from the kanban10-seed.ts order; drops are reverted between runs.
export const SCENARIOS = {
  'board-tall-down': { view: 'board', drag: 'Gap tall B', over: 'Gap short C', edge: 'bottom' },
  'board-short-up': { view: 'board', drag: 'Gap short C', over: 'Gap tall B', edge: 'top' },
  'board-short-down': { view: 'board', drag: 'Gap short A', over: 'Gap tall B', edge: 'bottom' },
  'board-tall-up': { view: 'board', drag: 'Gap tall D', over: 'Gap short C', edge: 'top' },
  'board-cross': { view: 'board', drag: 'Gap tall B', over: 'Gap tall G', edge: 'top' },
  'board-cross-last': { view: 'board', drag: 'Gap short E', over: 'Gap short F', edge: 'top' },
  'list-down': { view: 'list', drag: 'Gap tall B', over: 'Gap short C', edge: 'bottom' },
  'list-cross-last': { view: 'list', drag: 'Gap short E', over: 'Gap tall G', edge: 'top' },
}
