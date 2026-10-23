// The batch composer's rules that do not touch the screen: what it does to the selection when a task leaves the run, and which
// parts of the page's foot show while it is open.

/** The composer and selection after `id` leaves the run: the last task closes the composer; the selection loses it too. */
export function removeFromRun(composer: readonly string[], selected: ReadonlySet<string>, id: string): { composer: string[] | null; selected: Set<string> } {
  const rest = composer.filter((other) => other !== id)
  return { composer: rest.length ? rest : null, selected: new Set([...selected].filter((other) => other !== id)) }
}

/** The selection bar and the key hints give way to the composer, and come back when it is put away. */
export function footVisible({ selected, composer, showHints }: { selected: number; composer: boolean; showHints: boolean }): { bar: boolean; hints: boolean } {
  return { bar: selected > 0 && !composer, hints: showHints && !composer }
}
