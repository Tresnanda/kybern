/** Chat destinations are resolved on the connected computer, never by the OS URL opener. */
export type ChatLink =
  | { kind: "external"; url: string }
  | { kind: "file"; path: string; line?: number }
  | { kind: "anchor"; id: string }
  | { kind: "kybern"; target: KybernRefTarget; id: string }
  | { kind: "unsupported" };

/** What a `kybern://<target>/<id>` reference points at: a note or a task of the connected computer. */
export type KybernRefTarget = "note" | "task";
export interface KybernRef { target: KybernRefTarget; id: string }

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KYBERN_REF_HREF = new RegExp(`^kybern://(note|task)/(${UUID})/?$`, "i");
// A URI written in running text. It must not continue a word, path or URL, and
// it ends where the id ends, so trailing punctuation stays outside.
const KYBERN_REF_TEXT = new RegExp(`(?<![\\w/:.@-])kybern://(note|task)/(${UUID})/?(?![\\w-])`, "gi");

/** The note or task a `kybern://note/<id>` / `kybern://task/<id>` href names, or null. Ids are UUIDs; nothing else passes. */
export function kybernRef(href: string): KybernRef | null {
  let value = href.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  const match = KYBERN_REF_HREF.exec(value);
  return match ? { target: match[1]!.toLowerCase() as KybernRefTarget, id: match[2]!.toLowerCase() } : null;
}

export const kybernRefKey = (ref: KybernRef): string => `${ref.target}:${ref.id}`;

/** Text split into plain runs and bare `kybern://…` references, in order. */
export function splitKybernRefs(text: string): ({ text: string } | { text: string; ref: KybernRef })[] {
  const parts: ({ text: string } | { text: string; ref: KybernRef })[] = [];
  let last = 0;
  for (const match of text.matchAll(KYBERN_REF_TEXT)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: text.slice(last, index) });
    parts.push({ text: match[0], ref: { target: match[1]!.toLowerCase() as KybernRefTarget, id: match[2]!.toLowerCase() } });
    last = index + match[0].length;
  }
  if (!parts.length) return [{ text }];
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/**
 * Every note or task a Markdown message references, as a Markdown link, a bare
 * URI or inline code. Fenced code blocks show source, not chips, so they do not count.
 */
export function kybernRefsIn(markdown: string | null | undefined): KybernRef[] {
  if (!markdown || !markdown.includes("kybern://")) return [];
  const outside: string[] = [];
  let fence: { char: string; size: number } | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.size && !line.slice(marker[0].length).trim()) fence = null;
      continue;
    }
    if (marker) { fence = { char: marker[1]![0]!, size: marker[1]!.length }; continue; }
    outside.push(line);
  }
  const found = new Map<string, KybernRef>();
  for (const match of outside.join("\n").matchAll(new RegExp(`(?<![\\w/:.@-])kybern://(note|task)/(${UUID})(?![0-9a-z-])`, "gi"))) {
    const ref = { target: match[1]!.toLowerCase() as KybernRefTarget, id: match[2]!.toLowerCase() };
    found.set(kybernRefKey(ref), ref);
  }
  return [...found.values()];
}

export function chatLink(href: string, basePath?: string): ChatLink {
  let value = href.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return { kind: "unsupported" };
  if (/^(https?:\/\/|mailto:)/i.test(value)) return { kind: "external", url: value };
  const reference = kybernRef(value);
  if (reference) return { kind: "kybern", ...reference };
  if (value.startsWith("#")) {
    try { return { kind: "anchor", id: decodeURIComponent(value.slice(1)) }; }
    catch { return { kind: "unsupported" }; }
  }
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== "localhost") return { kind: "unsupported" };
      value = url.pathname + url.hash;
      if (/^\/[a-z]:\//i.test(value)) value = value.slice(1);
    } catch { return { kind: "unsupported" }; }
  } else if ((!/^[a-z]:[\\/]/i.test(value) && /^[a-z][a-z0-9+.-]*:/i.test(value) && !/:\d+(?::\d+)?$/.test(value)) || value.startsWith("//")) {
    return { kind: "unsupported" };
  }
  const location = /(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/.exec(value);
  const line = location ? Number(location[1] ?? location[2]) : undefined;
  if (location) value = value.slice(0, location.index);
  try { value = decodeURIComponent(value); } catch { return { kind: "unsupported" }; }
  if (!value || /[\u0000-\u001f\u007f]/.test(value) || value.startsWith("//")) return { kind: "unsupported" };
  // A relative link in a file preview is relative to that file's directory.
  if (basePath && !/^(?:\/|[a-z]:[\\/])/i.test(value)) {
    const directory = basePath.replace(/\\/g, "/").replace(/[^/]*$/, "");
    value = directory + value;
  }
  return { kind: "file", path: value, ...(line && Number.isSafeInteger(line) && line > 0 ? { line } : {}) };
}
