/** The row above a pull request list when some projects or repositories did not list: which ones, and whether the rest are shown. */
export function partialCopy(names: readonly string[], anyLoaded: boolean): { title: string; body: string } {
  const list = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '')
  return anyLoaded
    ? { title: 'Some pull requests didn’t load', body: `Couldn’t read ${list}. The rest are listed below.` }
    : { title: 'Pull requests didn’t load', body: `Couldn’t read ${list}. Try again in a moment.` }
}
