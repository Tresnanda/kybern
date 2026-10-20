/**
 * File references an agent writes as inline code (`src/main.rs`, `lib.rs:42`,
 * `app.ts#L10`) read as file links once the daemon confirms the file exists in
 * the thread's workspace (`threads.files.resolve`). A bare `http(s)://` URL in
 * a code span is a link straight away, as a bare URL in running text is.
 */

/** One inline code span that might name a file. */
export interface FileRefCandidate {
  /** The span's text as written. */
  text: string;
  /** The path to resolve, without its line suffix. */
  path: string;
  line?: number;
}

// No spaces, no scheme; a letter somewhere; a directory or an extension.
const PATH = /^(?![a-z][a-z0-9+.-]*:\/\/)(?=[^\s`]*[A-Za-z])[^\s`<>"'|*?]{1,300}$/i;
const LOCATION = /(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/;
const URL_ONLY = /^https?:\/\/[^\s`<>]+$/i;
const CODE_SPAN = /(`+)([^`\n]+?)\1(?!`)/g;

/** The path and line an inline code span names, or null when it cannot be a file reference. */
export function fileRefCandidate(text: string): FileRefCandidate | null {
  const value = text.trim();
  if (value !== text || !PATH.test(value)) return null;
  const location = LOCATION.exec(value);
  const path = location ? value.slice(0, location.index) : value;
  const line = location ? Number(location[1] ?? location[2]) : undefined;
  // A directory or an extension; trailing dots and slashes are prose or folders.
  if (!path || /[./]$/.test(path) || !(/\//.test(path) || /\.[A-Za-z0-9]{1,12}$/.test(path))) return null;
  // `1.2.3`, `v2.0` and `e.g.` are not files.
  if (!/\//.test(path) && /^v?\d+(\.\d+)+$/i.test(path)) return null;
  return { text, path, ...(line && Number.isSafeInteger(line) && line > 0 ? { line } : {}) };
}

/**
 * Rewrite each line outside fenced code with `rewrite(span)` for every inline
 * code span that is not already inside a link's text. `rewrite` returns the
 * replacement Markdown or null to keep the span.
 */
function eachCodeSpan(markdown: string, rewrite: (span: string, ticks: string) => string | null): string {
  let fence: string | null = null;
  return markdown.split("\n").map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length) fence = null;
      return line;
    }
    if (marker) { fence = marker[1]!; return line; }
    if (!line.includes("`")) return line;
    let out = "", last = 0, depth = 0;
    for (const match of line.matchAll(CODE_SPAN)) {
      const index = match.index ?? 0;
      const before = line.slice(last, index);
      // An open `[` means this span is (part of) a link's text already.
      for (const char of before.replace(/\\./g, "")) depth = char === "[" ? depth + 1 : char === "]" ? Math.max(0, depth - 1) : depth;
      const replaced = depth === 0 ? rewrite(match[2]!, match[1]!) : null;
      out += before + (replaced ?? match[0]);
      last = index + match[0].length;
    }
    return out + line.slice(last);
  }).join("\n");
}

/** Every distinct path the answer's inline code might name, in order, for one resolve call. */
export function fileRefCandidates(markdown: string): string[] {
  if (!markdown.includes("`")) return [];
  const paths = new Set<string>();
  eachCodeSpan(markdown, (span) => {
    const candidate = URL_ONLY.test(span) ? null : fileRefCandidate(span);
    if (candidate) paths.add(candidate.path);
    return null;
  });
  return [...paths];
}

const destination = (target: string) => `<${target.replace(/%/g, "%25").replace(/[<>]/g, encodeURIComponent)}>`;

/**
 * The answer with each inline code span that names a resolved file (or holds
 * only a bare `http(s)://` URL) turned into a link around the same code span.
 * `resolved(path)` returns the workspace path the daemon confirmed, or
 * null/undefined to leave the span as code.
 */
export function linkifyFileRefs(markdown: string, resolved: (path: string) => string | null | undefined): string {
  if (!markdown.includes("`")) return markdown;
  return eachCodeSpan(markdown, (span, ticks) => {
    const code = `${ticks}${span}${ticks}`;
    if (URL_ONLY.test(span)) return `[${code}](<${span}>)`;
    const candidate = fileRefCandidate(span);
    const file = candidate && resolved(candidate.path);
    if (!candidate || !file) return null;
    return `[${code}](${destination(candidate.line ? `${file}#L${candidate.line}` : file)})`;
  });
}
