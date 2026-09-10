import { partToken } from "../../../../packages/kybern-client/src/composerTokens.ts";
import type { ContentPart, SkillInfo } from "./protocol";

export function isInlinePart(part: ContentPart) {
  return part.type === "text" || partToken(part) !== null;
}

/** Text and mentions share a native text paragraph; files keep their own tiles. */
export function groupInlineParts(
  entries: { part: ContentPart; index: number }[],
) {
  const groups: { inline: boolean; entries: typeof entries }[] = [];
  for (const entry of entries) {
    const inline = isInlinePart(entry.part);
    const last = groups.at(-1);
    if (inline && last?.inline) last.entries.push(entry);
    else groups.push({ inline, entries: [entry] });
  }
  return groups;
}

export function inlineTextRuns(parts: readonly ContentPart[]) {
  const runs: { text: string; highlighted: boolean }[] = [];
  for (const part of parts) {
    const token = partToken(part);
    const text = part.type === "text" ? part.text : token;
    if (!text) continue;
    const previous = runs.at(-1);
    // Older clients appended context parts without surrounding text spaces.
    if (
      previous &&
      (previous.highlighted || token !== null) &&
      !/\s$/.test(previous.text) &&
      !/^[\s,.;:!?)}\]]/.test(text) &&
      !/[({\[]$/.test(previous.text)
    )
      runs.push({ text: " ", highlighted: false });
    runs.push({ text, highlighted: token !== null });
  }
  return runs;
}

/** Keep selected native identities available after the suggestion sheet closes. */
export function inlineTokenSources(parts: readonly ContentPart[]) {
  const mentions = new Set<string>();
  const skills: SkillInfo[] = [];
  for (const part of parts) {
    if (part.type === "file_mention") mentions.add(part.path);
    if (part.type === "skill" || part.type === "mention")
      skills.push({
        name: part.name,
        path: part.path,
        enabled: true,
        scope: part.type === "mention" ? "plugin" : "other",
        ...(part.type === "mention" ? { display_name: part.display_name } : {}),
      });
  }
  return { mentions, skills };
}
