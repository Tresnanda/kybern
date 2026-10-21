// Spaces group projects (work, personal…). Pure helpers and copy shared by the
// clients; the active space is client state, the daemon only stores the groups.
import { isFreeChatProject, type Project, type ProjectId, type Space, type SpaceColor, type SpaceId } from "./types.ts";

/** Swatches in the order a new space picks its default colour. */
export const SPACE_COLORS: readonly SpaceColor[] = ["blue", "green", "purple", "pink", "teal", "amber", "red", "graphite"];
export const SPACE_NAME_MAX = 32;
export const SPACE_LIMIT = 50;
export const SPACE_LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const SPACE_LOGO_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];

/** Icon slugs, in the editor's grid order (8 per row, after the "Initials" cell). */
export const SPACE_ICONS: readonly string[] = [
  "briefcase", "building", "team", "user", "rocket", "target", "idea",
  "code", "terminal", "cpu", "server", "database", "robot", "atom", "lab",
  "book", "pen", "paint", "camera", "music", "game", "puzzle", "package",
  "globe", "leaf", "coffee", "heart", "star", "flash", "shield", "wallet",
];

const WORD_BREAKS = /[\s\-_.]+/u;
const STARTS_WITH_LETTER_OR_NUMBER = /^[\p{L}\p{N}]/u;
const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

function firstGrapheme(word: string): string {
  if (segmenter) {
    for (const part of segmenter.segment(word)) return part.segment;
    return "";
  }
  return Array.from(word)[0] ?? "";
}

/**
 * The tile text for a name: `Side Projects` → `SP`, `Work` → `W`. Words that do
 * not start with a letter or number (emoji, punctuation) are skipped; `''` when
 * none is left, which the tile draws as a star.
 */
export function spaceInitials(name: string): string {
  const words = name
    .trim()
    .split(WORD_BREAKS)
    .map(firstGrapheme)
    .filter((grapheme) => STARTS_WITH_LETTER_OR_NUMBER.test(grapheme));
  return words.slice(0, 2).join("").toLocaleUpperCase();
}

/** The space a project is in; null for free chat or a project this client does not know. */
export function spaceOfProject(projects: readonly Project[], projectId: ProjectId): SpaceId | null {
  if (isFreeChatProject(projectId)) return null;
  return projects.find((project) => project.id === projectId)?.space_id ?? null;
}

/**
 * Whether a project's items show in `spaceId`. True when the feature is off
 * (`spaceId` null), for items without a project, free chat, and projects this
 * client has not loaded yet.
 */
export function inSpace(projectId: string | null | undefined, projects: readonly Project[], spaceId: SpaceId | null): boolean {
  if (spaceId === null) return true;
  if (!projectId || isFreeChatProject(projectId)) return true;
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) return true;
  return project.space_id === spaceId;
}

/** The space a deleted space's projects move to: the one above it, or the next for the first. */
export function deleteTarget(spaces: readonly Space[], id: SpaceId): Space | null {
  const index = spaces.findIndex((space) => space.id === id);
  if (index < 0 || spaces.length < 2) return null;
  return index === 0 ? spaces[1]! : spaces[index - 1]!;
}

/** The first swatch no space uses, else the next in rotation. */
export function nextSpaceColor(spaces: readonly Space[]): SpaceColor {
  const used = new Set(spaces.map((space) => space.color));
  return SPACE_COLORS.find((color) => !used.has(color)) ?? SPACE_COLORS[spaces.length % SPACE_COLORS.length]!;
}

export const SPACE_COPY = {
  newSpaceTooltip: "New space",
  limitTooltip: "You can have up to 50 spaces.",
  dropTooltip: (name: string) => `Move to ${name}`,
  editorNewTitle: "New space",
  editorEditTitle: "Edit space",
  namePlaceholder: "Name",
  nameLabel: "Space name",
  uploadImage: "Upload image",
  replaceImage: "Replace image",
  removeImage: "Remove",
  imageHint: "PNG, JPEG or WebP, up to 2 MB",
  imageError: "Use a PNG, JPEG or WebP image up to 2 MB.",
  uploadFailure: "Unable to upload the image. Check the connection and try again.",
  saveFailure: "Unable to save the space. Check the connection and try again.",
  cancel: "Cancel",
  create: "Create space",
  save: "Save",
  menuEdit: "Edit space…",
  menuMoveUp: "Move up",
  menuMoveDown: "Move down",
  menuDelete: "Delete space…",
  deleteTitle: (name: string) => `Delete “${name}”?`,
  deleteNone: "This space has no projects.",
  deleteOne: (project: string, target: string) => `${project} moves to ${target}, with its threads, notes and tasks.`,
  deleteMany: (count: number, target: string) => `Its ${count} projects move to ${target}, with their threads, notes and tasks.`,
  deleteConfirm: "Delete space",
  deletedToast: (name: string) => `Deleted ${name}`,
  deleteFailure: "Unable to delete the space. Check the connection and try again.",
  moveToSpace: "Move to space",
  newSpaceMenu: "New space…",
  movedToast: (project: string, space: string) => `Moved ${project} to ${space}`,
  undo: "Undo",
  moveFailure: (project: string) => `Unable to move ${project}. Check the connection and try again.`,
  alreadyIn: (name: string, space: string) => `${name} is already in ${space}.`,
  moveHere: "Move here",
  emptyTitle: "No projects yet",
  emptyDescription: "Drag a project onto this space in the rail to move it.",
  emptyAction: "Add project",
  switchTo: (name: string) => `Switch to ${name}`,
  paletteNew: "New space…",
  defaultName: "Personal",
} as const;
