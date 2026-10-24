// Pure helpers for the Projects screens: short paths and the reader's order.

/** The daemon host's home folder, read off its data dir (`/Users/me/.kybern` → `/Users/me`). */
export function homeOf(dataDir: string | null | undefined): string | null {
  if (!dataDir) return null;
  const match = /^(.*)[/\\]\.kybern[/\\]?$/.exec(dataDir);
  return match?.[1] || null;
}

/** `/Users/me/projects/ade` → `~/projects/ade` on the host whose home is `/Users/me`. */
export function shortPath(path: string, home: string | null): string {
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** “Remove “kybern” from Kybern?” — the confirmation names the project. */
export const removeProjectTitle = (name: string) => `Remove “${name}” from Kybern?`;
export const REMOVE_PROJECT_BODY = "The project disappears from Kybern. Files on your computer are kept.";
