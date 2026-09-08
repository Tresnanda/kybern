import type { ContentPart, SkillInfo } from "./protocol";
/** Preserve the provider's native skill/plugin distinction on the wire. */
export function capabilityPart(skill: SkillInfo): ContentPart {
  if (skill.scope === "plugin")
    return {
      type: "mention",
      name: skill.name,
      path: skill.path,
      ...(skill.display_name ? { display_name: skill.display_name } : {}),
    };
  return { type: "skill", name: skill.name, path: skill.path };
}
export function commandText(name: string) {
  return `/${name.replace(/^\/+/, "")} `;
}

export interface ComposerTrigger {
  marker: "$" | "@" | "/";
  query: string;
  start: number;
  end: number;
}
/** Match the token at the caret, never email addresses or a selected range. */
export function composerTrigger(
  text: string,
  selection: { start: number; end: number },
): ComposerTrigger | null {
  if (selection.start !== selection.end) return null;
  const match = /(?:^|\s)([$@/])([^\s$@]*)$/.exec(
    text.slice(0, selection.start),
  );
  if (!match) return null;
  return {
    marker: match[1] as ComposerTrigger["marker"],
    query: match[2]!,
    start: selection.start - match[2]!.length - 1,
    end: selection.start,
  };
}
export function replaceComposerTrigger(
  text: string,
  trigger: ComposerTrigger,
  insertion = "",
) {
  const next =
    text.slice(0, trigger.start) + insertion + text.slice(trigger.end);
  return { text: next, caret: trigger.start + insertion.length };
}
