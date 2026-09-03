// FILE: fileIcons.ts
// Purpose: Map file paths and attachments to Synara's Central icon names.
// Layer: Shared desktop UI utility.

const DEFAULT_FILE_ICON = "code-brackets"
const DEFAULT_ATTACHMENT_ICON = "file-text"

// Lookup keys come from file and chat content, so Maps avoid inherited-object
// keys such as `constructor` and `__proto__` becoming accidental icon names.
function createIconTable(entries: Record<string, string>): ReadonlyMap<string, string> {
  return new Map(Object.entries(entries))
}

const FILE_ICON_BY_BASENAME = createIconTable({
  "package.json": "npm",
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  ".npmrc": "npm",
  ".npmignore": "npm",
  "yarn.lock": "npm",
  ".yarnrc": "npm",
  ".yarnrc.yml": "npm",
  "pnpm-lock.yaml": "npm",
  "pnpm-workspace.yaml": "npm",
  "bun.lockb": "bun",
  "bun.lock": "bun",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  ".gitkeep": "git",
  ".gitconfig": "git",
  "tsconfig.json": "typescript",
  "tsconfig.base.json": "typescript",
  "tsconfig.build.json": "typescript",
  "tsconfig.node.json": "typescript",
  "tsconfig.eslint.json": "typescript",
  "cargo.toml": "rust",
  "cargo.lock": "rust",
  "requirements.txt": "phyton",
  pipfile: "phyton",
  "pyproject.toml": "phyton",
  "setup.py": "phyton",
  "setup.cfg": "phyton",
  "readme.md": "markdown",
  license: "file-text",
  "license.md": "file-text",
  "license.txt": "file-text",
  "vercel.json": "vercel",
  ".env": "settings-gear-1",
  ".env.local": "settings-gear-1",
  ".env.development": "settings-gear-1",
  ".env.production": "settings-gear-1",
  ".env.test": "settings-gear-1",
  ".env.example": "settings-gear-1",
})

// Compound extensions are tested before their shorter suffixes.
// The Python Central asset is misspelled upstream as `phyton.svg`.
const FILE_ICON_BY_EXTENSION = createIconTable({
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  "d.ts": "typescript",
  tsx: "react",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "react",
  json: "json",
  json5: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  mdc: "markdown",
  markdown: "markdown",
  py: "phyton",
  pyi: "phyton",
  pyc: "phyton",
  pyw: "phyton",
  rs: "rust",
  php: "php",
  phtml: "php",
  java: "java",
  c: "c",
  h: "c",
  vue: "vue",
  svelte: "svelte",
  yml: "settings-gear-1",
  yaml: "settings-gear-1",
  toml: "settings-gear-1",
  ini: "settings-gear-1",
  conf: "settings-gear-1",
  cfg: "settings-gear-1",
  env: "settings-gear-1",
  txt: "file-text",
  log: "file-text",
  csv: "file-chart",
  tsv: "file-chart",
  rtf: "page-text",
  doc: "page-text",
  docx: "page-text",
  odt: "page-text",
  xls: "file-chart",
  xlsx: "file-chart",
  ods: "file-chart",
  ppt: "page-text",
  pptx: "page-text",
  odp: "page-text",
  ics: "calendar-days",
  ifb: "calendar-days",
  vcs: "calendar-days",
  sh: "cmd",
  bash: "cmd",
  zsh: "cmd",
  fish: "cmd",
  bat: "cmd",
  ps1: "cmd",
  psm1: "cmd",
  psd1: "cmd",
  lock: "lock",
  png: "file-png",
  jpg: "file-jpg",
  jpeg: "file-jpg",
  gif: "image-alt-text",
  webp: "image-alt-text",
  bmp: "image-alt-text",
  tiff: "image-alt-text",
  avif: "image-alt-text",
  ico: "image-alt-text",
  svg: "image-alt-text",
  pdf: "file-pdf",
  zip: "file-zip",
  tar: "file-zip",
  gz: "file-zip",
  tgz: "file-zip",
  rar: "file-zip",
  "7z": "file-zip",
  bz2: "file-zip",
  xz: "file-zip",
  mp4: "video",
  m4v: "video",
  mov: "video",
  webm: "video",
  mkv: "video",
  avi: "video",
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  ogg: "audio",
  m4a: "audio",
  aac: "audio",
})

const FILE_ICON_BY_MIME_TYPE = createIconTable({
  "application/pdf": "file-pdf",
  "application/json": "json",
  "application/xml": "code-brackets",
  "application/zip": "file-zip",
  "application/gzip": "file-zip",
  "application/x-tar": "file-zip",
  "application/x-7z-compressed": "file-zip",
  "application/vnd.ms-excel": "file-chart",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "file-chart",
  "application/vnd.oasis.opendocument.spreadsheet": "file-chart",
  "application/msword": "page-text",
  "application/vnd.ms-word": "page-text",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "page-text",
  "application/vnd.oasis.opendocument.text": "page-text",
  "application/vnd.ms-powerpoint": "page-text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "page-text",
  "application/vnd.oasis.opendocument.presentation": "page-text",
  "application/rtf": "page-text",
  "text/calendar": "calendar-days",
  "text/csv": "file-chart",
  "text/tab-separated-values": "file-chart",
  "text/markdown": "markdown",
  "text/html": "code-brackets",
  "text/xml": "code-brackets",
})

export function basenameOfPath(pathValue: string): string {
  const slashIndex = Math.max(pathValue.lastIndexOf("/"), pathValue.lastIndexOf("\\"))
  return slashIndex === -1 ? pathValue : pathValue.slice(slashIndex + 1)
}

function extensionCandidates(fileName: string): string[] {
  const candidates: string[] = []
  let dotIndex = fileName.indexOf(".")
  while (dotIndex !== -1 && dotIndex < fileName.length - 1) {
    const candidate = fileName.slice(dotIndex + 1)
    if (candidate) candidates.push(candidate)
    dotIndex = fileName.indexOf(".", dotIndex + 1)
  }
  return candidates
}

export function pathLooksLikeKnownFile(pathValue: string): boolean {
  const basename = basenameOfPath(pathValue).toLowerCase()
  return FILE_ICON_BY_BASENAME.has(basename) || extensionCandidates(basename).some((candidate) => FILE_ICON_BY_EXTENSION.has(candidate))
}

export function inferEntryKindFromPath(pathValue: string): "file" | "directory" {
  const basename = basenameOfPath(pathValue)
  if (pathLooksLikeKnownFile(pathValue)) return "file"
  if (basename.startsWith(".") && !basename.slice(1).includes(".")) return "directory"
  return basename.includes(".") ? "file" : "directory"
}

export function getFileIconName(pathValue: string): string {
  const basename = basenameOfPath(pathValue).toLowerCase()
  const byName = FILE_ICON_BY_BASENAME.get(basename)
  if (byName) return byName
  for (const candidate of extensionCandidates(basename)) {
    const byExtension = FILE_ICON_BY_EXTENSION.get(candidate)
    if (byExtension) return byExtension
  }
  return DEFAULT_FILE_ICON
}

export function getAttachmentIconName(attachment: { name: string; mimeType?: string | null }): string {
  const basename = basenameOfPath(attachment.name).toLowerCase()
  const byName = FILE_ICON_BY_BASENAME.get(basename)
  if (byName) return byName
  for (const candidate of extensionCandidates(basename)) {
    const byExtension = FILE_ICON_BY_EXTENSION.get(candidate)
    if (byExtension) return byExtension
  }

  const mimeType = attachment.mimeType?.trim().toLowerCase() ?? ""
  const byMime = FILE_ICON_BY_MIME_TYPE.get(mimeType)
  if (byMime) return byMime
  const family = mimeType.split("/")[0]
  if (family === "image") return "image-alt-text"
  if (family === "audio") return "audio"
  if (family === "video") return "video"
  if (family === "text") return "file-text"
  return DEFAULT_ATTACHMENT_ICON
}
