/** The parts of a navigation action the sheet's deferred removal looks at. */
export type RemovalAction = {
  type: string;
  payload?: object;
  source?: string;
  target?: string;
};

/**
 * The action an Android sheet replays once its close animation ends, bound to
 * the sheet's own route. `router.back()` queues a bare GO_BACK, which pops
 * whatever is on top when it finally runs: after "close the sheet, then push a
 * thread" that is the new thread, so it opened and closed at once. With the
 * sheet's route as source and its stack as target, the pop removes the sheet
 * and keeps anything pushed above it.
 */
export function boundRemoval<A extends RemovalAction>(action: A, routeKey: string, stackKey: string): A {
  if ((action.type !== "GO_BACK" && action.type !== "POP") || action.source) return action;
  return { ...action, source: routeKey, target: stackKey };
}
