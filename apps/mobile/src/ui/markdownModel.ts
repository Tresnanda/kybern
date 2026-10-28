// Pure Markdown helpers: images in a reply and table geometry. Kept free of React Native so the
// node tests can import them.

export type MarkdownImage = { alt: string; target: string };
export type ParagraphPart = { text: string } | { image: MarkdownImage };

// `![alt](dest "title")`; a destination with spaces or parentheses is written `<dest>`.
const IMAGE = /!\[([^\]]*)\]\(\s*(<[^>\n]*>|[^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/** The destination as the daemon should read it: brackets off, otherwise as written. */
function destination(raw: string): string {
  const inner = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
  return inner.trim();
}

export function isRemoteImage(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

/**
 * A local image path the daemon may serve: relative, absolute, `~/`, or `file://`. Other schemes
 * (`data:`, `javascript:`, `ftp:`...) are not paths and return null. A Windows drive letter is a path.
 */
export function localImagePath(target: string): string | null {
  const path = target.trim();
  if (!path) return null;
  if (/^file:\/\//i.test(path)) return path.length > "file://".length ? path : null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(path);
  if (scheme && scheme[1]!.length > 1) return null;
  return path;
}

/** Splits a paragraph into text and images, in order. Text parts are trimmed and never empty. */
export function splitImages(para: string): ParagraphPart[] {
  const parts: ParagraphPart[] = [];
  let last = 0;
  for (const match of para.matchAll(IMAGE)) {
    const target = destination(match[2]!);
    if (!target) continue;
    const before = para.slice(last, match.index).trim();
    if (before) parts.push({ text: before });
    parts.push({ image: { alt: match[1]!.trim(), target } });
    last = match.index + match[0].length;
  }
  if (!parts.length) return [];
  const rest = para.slice(last).trim();
  if (rest) parts.push({ text: rest });
  return parts;
}

/** The image when the whole paragraph is one image on its own. */
export function matchImageParagraph(para: string): MarkdownImage | null {
  const parts = splitImages(para.trim());
  return parts.length === 1 && "image" in parts[0]! ? parts[0].image : null;
}

/** What a failed or blocked image shows: its caption, or a plain name for it. */
export function imagePlaceholderText(image: MarkdownImage): string {
  if (image.alt) return image.alt;
  const name = image.target.split(/[\\/]/).at(-1)?.split("?")[0];
  return name || "Image";
}

/** Table cells of one row, without the outer pipes. A `\|` stays inside its cell. */
export function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  const body = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (body[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += body[i];
  }
  cells.push(cell.trim());
  return cells;
}

export const TABLE_MIN_COLUMN = 180;
export const TABLE_MAX_COLUMN = 260;
const CHAR_WIDTH = 8;
const CELL_PADDING = 24;

/** Column widths: 180 pt at least so a cell wraps readably, wider only for a long unbreakable word. */
export function tableColumnWidths(rows: string[][]): number[] {
  const columns = Math.max(0, ...rows.map((row) => row.length));
  return Array.from({ length: columns }, (_, c) => {
    const longest = Math.max(0, ...rows.map((row) => Math.max(0, ...(row[c] ?? "").split(/\s+/).map((word) => word.length))));
    return Math.min(TABLE_MAX_COLUMN, Math.max(TABLE_MIN_COLUMN, longest * CHAR_WIDTH + CELL_PADDING));
  });
}
