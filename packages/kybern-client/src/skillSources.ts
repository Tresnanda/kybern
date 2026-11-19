import type { SkillInfo } from './types.ts';

type SkillSourceFields = Pick<SkillInfo, 'scope' | 'plugin'>;

const SCOPE_LABELS: Record<string, string> = {
  project: 'Project',
  repo: 'Repo',
  user: 'Personal',
  app: 'App',
  plugin: 'Plugin',
  system: 'System',
  admin: 'System',
};

/**
 * Where a skill comes from, as the slash menu says it. A plugin's own skill (scope "app" with `plugin` set) is "Plugin";
 * a standalone skill the plugin also ships an identical copy of is "Plugin · Personal" (its own label after the dot).
 */
export function skillSourceLabel(skill: SkillSourceFields): string {
  const own = SCOPE_LABELS[skill.scope] ?? 'Provider';
  if (!skill.plugin) return own;
  return skill.scope === 'app' ? 'Plugin' : `Plugin · ${own}`;
}

/**
 * One row per skill. A current daemon already lists each skill once; an older one repeats a plugin's skill for every
 * cached version or scope it is installed in, so the same scope and name keep their first row.
 */
export function uniqueSkills<T extends Pick<SkillInfo, 'name' | 'scope' | 'home'>>(skills: readonly T[]): T[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = `${skill.scope}\0${skill.home ?? ''}\0${skill.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
