/**
 * Links to files by absolute path. Most name a file in the thread's workspace; some name a file outside it (an agent's
 * scratchpad), which only the desktop on the daemon's machine can open (`threads.files.outside`). A client that cannot
 * open one shows its link as plain text instead of failing after the click.
 */
import { chatLink } from "./chatLinks.ts";

const LINK = /(?<!!)\[([^\]\n]*)\]\((<[^>\n]+>|[^)\s]+)\)/g;
const ABSOLUTE = /^(?:\/|[a-z]:[\/])/i;
const MAX_PATHS = 20;

/** Rewrite each Markdown link outside fenced code whose destination is an absolute file path; `rewrite` returns the replacement or null. */
function eachFileLink(markdown: string, rewrite: (text: string, path: string) => string | null): string {
  let fence: string | null = null;
  return markdown.split("\n").map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length) fence = null;
      return line;
    }
    if (marker) { fence = marker[1]!; return line; }
    if (!line.includes("](")) return line;
    return line.replace(LINK, (whole, text: string, destination: string) => {
      const link = chatLink(destination);
      return link.kind === "file" && ABSOLUTE.test(link.path) ? rewrite(text, link.path) ?? whole : whole;
    });
  }).join("\n");
}

/** The distinct absolute file paths the answer links to, at most 20, in order. */
export function absoluteFileLinks(markdown: string): string[] {
  if (!markdown.includes("](")) return [];
  const paths = new Set<string>();
  eachFileLink(markdown, (_, path) => { if (paths.size < MAX_PATHS) paths.add(path); return null; });
  return [...paths];
}

/** The answer with each link to one of `paths` shown as its text alone. */
export function unlinkFileLinks(markdown: string, paths: ReadonlySet<string>): string {
  if (!paths.size || !markdown.includes("](")) return markdown;
  return eachFileLink(markdown, (text, path) => (paths.has(path) ? text : null));
}
