// An issue's or a pull request's Markdown as GitHub writes it, split into text and images. Native Markdown paints a Markdown
// image as a link and raw HTML as text, so GitHub's own `<img width="512" height="687" alt="Image" src="…/user-attachments/…" />`
// showed as a line of HTML. Images that stand on their own lines (Markdown, linked Markdown, or HTML `<img>` with the `<a>`,
// `<p>` and `<picture>` around it) become image segments; an HTML `<img>` inside a sentence is lifted out of it. Fenced code is
// left as it is. Other inline HTML stays text, as before.

export type GithubSegment =
  | { kind: 'text'; text: string }
  | { kind: 'image'; source: string; alt: string; width?: number; height?: number }

// As in `transcript/markdown.tsx`: bare destinations may hold spaces and one level of parentheses.
const DEST = String.raw`(?:<([^>\n]+)>|([^()\s](?:[^()\n]*?(?:\([^()\n]*\))?)*?))(?:\s+"[^"\n]*")?\s*`
const IMAGE = String.raw`!\[([^\]\n]*)\]\(${DEST}\)`
/** `![alt](src)` or `[![alt](src)](link)`. */
const MARKDOWN_IMAGE = new RegExp(String.raw`\[${IMAGE}\]\([^)\n]*\)|${IMAGE}`, 'g')
const MARKDOWN_IMAGE_LINE = new RegExp(String.raw`^ {0,3}(?:(?:\[${IMAGE}\]\([^)\n]*\)|${IMAGE})\s*)+$`)
const HTML_IMAGE = /<img\b[^>]*>/gi
/** Tags that only wrap an image and would otherwise be left behind as text. */
const WRAPPER = /<\/?(?:a|p|picture|div|span|center)\b[^>]*>|<source\b[^>]*>|<br\s*\/?>/gi

/** One attribute of an HTML tag, unquoted or quoted either way. */
function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(String.raw`\s${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))`, 'i').exec(tag)
  const value = match ? (match[1] ?? match[2] ?? match[3]) : undefined
  return value === undefined ? undefined : decodeEntities(value)
}

const decodeEntities = (value: string) => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')

/** A width or height attribute in pixels ("512", "512px"); percentages and nonsense are ignored. */
function pixels(value: string | undefined): number | undefined {
  const match = value && /^\s*(\d{1,5})(?:px)?\s*$/i.exec(value)
  const n = match ? Number(match[1]) : NaN
  return n > 0 ? n : undefined
}

/** An `<img>` tag as an image segment. One without a source is still an image (its caption shows where it would be). */
function htmlImage(tag: string): GithubSegment {
  const source = attribute(tag, 'src')?.trim() ?? ''
  const width = pixels(attribute(tag, 'width')), height = pixels(attribute(tag, 'height'))
  return { kind: 'image', source, alt: (attribute(tag, 'alt') ?? '').trim(), ...(width ? { width } : {}), ...(height ? { height } : {}) }
}

/** The images of a line that holds nothing else. */
function markdownImages(line: string): GithubSegment[] {
  return [...line.matchAll(MARKDOWN_IMAGE)].map(m => {
    const alt = (m[1] ?? m[4] ?? '').trim()
    const source = (m[2] ?? m[3] ?? m[5] ?? m[6] ?? '').trim()
    return { kind: 'image' as const, source, alt }
  }).filter(image => image.source)
}

/** Split `text` into text and image segments, in order. Text that holds no image comes back as one segment. */
export function githubSegments(text: string): GithubSegment[] {
  const source = text.replace(/<!--[\s\S]*?-->/g, '')
  if (!/!\[|<img\b/i.test(source)) return [{ kind: 'text', text: source.trim() }]
  // A tag written over several lines reads as one.
  const lines = source.replace(HTML_IMAGE, tag => tag.replace(/\s+/g, ' ')).split('\n')
  const out: GithubSegment[] = []
  let held: string[] = [], fence = ''
  const flush = () => {
    const joined = held.join('\n')
    if (joined.trim()) out.push({ kind: 'text', text: joined })
    held = []
  }
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) { if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length) fence = ''; held.push(line); continue }
    if (marker) { fence = marker[1]!; held.push(line); continue }
    if (MARKDOWN_IMAGE_LINE.test(line)) { flush(); out.push(...markdownImages(line)); continue }
    // A line of wrapper tags only (`<picture>`, `<source …>`, `<p align="center">`) holds the images around it.
    if (!/<img\b/i.test(line)) { if (!line.trim() || line.replace(WRAPPER, '').trim()) held.push(line); continue }
    // HTML images: each one its own segment, with what is between them kept as text unless it only wrapped the image.
    let last = 0
    for (const m of line.matchAll(HTML_IMAGE)) {
      const before = line.slice(last, m.index)
      if (before.replace(WRAPPER, '').trim()) held.push(before.replace(WRAPPER, '').trimEnd())
      flush()
      out.push(htmlImage(m[0]))
      last = m.index! + m[0].length
    }
    const after = line.slice(last).replace(WRAPPER, '')
    if (after.trim()) held.push(after.trim())
  }
  flush()
  return out.length ? out : [{ kind: 'text', text: source.trim() }]
}
