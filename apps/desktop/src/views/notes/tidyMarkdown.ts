// Tiptap's Markdown serializer writes `>`, `<` and `&` in text as HTML entities.
// They read back correctly in the editor, but they make a stored note ugly in
// the CLI, in the mobile text editor, and for anything else that reads the
// Markdown. This puts back the plain characters where that is unambiguous, and
// leaves code untouched.

const CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g

function tidyText(text: string): string {
  return (
    text
      // `&gt;` stays when it begins a line, where a plain `>` would start a quote.
      .replace(/(^|\n)([ \t]*)&gt;/g, "$1$2\uE000")
      .replace(/&gt;/g, ">")
      .replace(/\uE000/g, "&gt;")
      // `&lt;` stays before anything that could open an HTML tag or comment.
      .replace(/&lt;(?![A-Za-z/!?])/g, "<")
      // `&amp;` stays before anything that could read as an entity.
      .replace(/&amp;(?![A-Za-z0-9#]+;)/g, "&")
  )
}

export function tidyMarkdown(markdown: string): string {
  return markdown
    .split(CODE)
    .map((part, index) => (index % 2 === 1 ? part : tidyText(part)))
    .join("")
}
