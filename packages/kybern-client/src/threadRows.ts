/** Flatten threads into sidebar rows nested under their parent. Collapsed branches never reappear as orphan roots; cycles remain reachable. */
export function nestedThreadRows<T extends { id: string; parent_thread_id?: string | null }>(
  threads: readonly T[], expanded: Readonly<Record<string, boolean>>, activeId?: string,
  /** Rows that start open when the reader has not chosen (a parent with working subagents). */
  defaultOpen?: (thread: T) => boolean,
): { thread: T; depth: number; childCount: number; open: boolean }[] {
  const byId = new Map(threads.map(thread => [thread.id, thread]));
  const children = new Map<string, T[]>();
  for (const thread of threads) {
    if (!thread.parent_thread_id || !byId.has(thread.parent_thread_id) || thread.parent_thread_id === thread.id) continue;
    const list = children.get(thread.parent_thread_id) ?? [];
    list.push(thread);
    children.set(thread.parent_thread_id, list);
  }
  const ancestors = new Set<string>();
  let parent = activeId ? byId.get(activeId)?.parent_thread_id : null;
  while (parent && !ancestors.has(parent)) {
    ancestors.add(parent);
    parent = byId.get(parent)?.parent_thread_id;
  }
  const rows: { thread: T; depth: number; childCount: number; open: boolean }[] = [];
  const visited = new Set<string>();
  const append = (thread: T, depth: number, visible: boolean) => {
    if (visited.has(thread.id)) return;
    visited.add(thread.id);
    const nested = children.get(thread.id) ?? [];
    const open = expanded[thread.id] ?? (ancestors.has(thread.id) || defaultOpen?.(thread) === true);
    if (visible) rows.push({ thread, depth, childCount: nested.length, open });
    for (const child of nested) append(child, depth + 1, visible && open);
  };
  for (const thread of threads) {
    if (!thread.parent_thread_id || !byId.has(thread.parent_thread_id) || thread.parent_thread_id === thread.id) append(thread, 0, true);
  }
  for (const thread of threads) if (!visited.has(thread.id)) append(thread, 0, true);
  return rows;
}
