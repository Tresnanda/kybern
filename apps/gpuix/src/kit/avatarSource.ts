// Pure part of `Avatar.tsx`, so tests can reach it.
/** Avatars are 40 px at most on screen; GitHub's CDN resizes on request. */
export function avatarSource(url: string, px: number): string {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return ''
    if (u.hostname.endsWith('githubusercontent.com') && !u.searchParams.has('s')) u.searchParams.set('s', String(px * 2))
    return u.toString()
  } catch { return '' }
}
