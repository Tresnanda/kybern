/** Chat destinations are resolved on the connected computer, never by the OS URL opener. */
export type ChatLink =
  | { kind: "external"; url: string }
  | { kind: "file"; path: string; line?: number }
  | { kind: "anchor"; id: string }
  | { kind: "unsupported" };

export function chatLink(href: string, basePath?: string): ChatLink {
  let value = href.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return { kind: "unsupported" };
  if (/^(https?:\/\/|mailto:)/i.test(value)) return { kind: "external", url: value };
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
