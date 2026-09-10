import { partToken } from "../../../../packages/kybern-client/src/composerTokens.ts";
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

/** Picker choices occupy editable text at the caret, retaining the suffix. */
export function insertComposerPart(
  text: string,
  selection: { start: number; end: number },
  part: ContentPart,
  replaceTrigger = true,
) {
  const literal = part.type === "text" ? part.text : partToken(part);
  if (literal === null) return { text, caret: selection.end };
  const trigger = replaceTrigger ? composerTrigger(text, selection) : null;
  const start = Math.min(trigger?.start ?? selection.start, text.length);
  const end = Math.min(trigger?.end ?? selection.end, text.length);
  const before = text.slice(0, start);
  const after = text.slice(end);
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const suffix = /\s$/.test(literal) || /^\s/.test(after) ? "" : " ";
  const insertion = prefix + literal + suffix;
  return {
    text: before + insertion + after,
    caret:
      before.length + insertion.length + (!suffix && /^ /.test(after) ? 1 : 0),
  };
}
