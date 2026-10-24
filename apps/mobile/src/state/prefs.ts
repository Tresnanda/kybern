// The reader's list preferences for one computer, kept across launches in a small
// JSON file (unread marks, dismissed attention, project order). Losing it is
// harmless: every field falls back to "nothing marked".
import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";

export type ListPrefs = {
  /** Threads whose turn finished while nobody was looking. */
  unread: Record<string, true>;
  /** `last_seq` at which the reader waved a blocked or failed thread off. */
  attentionDismissals: Record<string, number>;
  /** Project ids in the reader's order; projects not listed follow by name. */
  projectOrder: string[];
};

export const EMPTY_PREFS: ListPrefs = { unread: {}, attentionDismissals: {}, projectOrder: [] };

const fileFor = (environmentId: string) =>
  new File(Paths.document, `kybern-list-${environmentId.replace(/[^A-Za-z0-9-]/g, "")}.json`);

export function readPrefs(environmentId: string): ListPrefs {
  if (Platform.OS === "web") return EMPTY_PREFS;
  try {
    const file = fileFor(environmentId);
    if (!file.exists) return EMPTY_PREFS;
    const value = JSON.parse(file.textSync()) as Partial<ListPrefs>;
    return {
      unread: value.unread && typeof value.unread === "object" ? value.unread : {},
      attentionDismissals:
        value.attentionDismissals && typeof value.attentionDismissals === "object" ? value.attentionDismissals : {},
      projectOrder: Array.isArray(value.projectOrder) ? value.projectOrder.filter((id) => typeof id === "string") : [],
    };
  } catch {
    return EMPTY_PREFS;
  }
}

let pending: ReturnType<typeof setTimeout> | undefined;
/** Writes soon after the last change, once. */
export function writePrefs(environmentId: string, prefs: ListPrefs) {
  if (Platform.OS === "web") return;
  clearTimeout(pending);
  pending = setTimeout(() => {
    try {
      const file = fileFor(environmentId);
      if (!file.exists) file.create();
      file.write(JSON.stringify(prefs));
    } catch {
      // Preferences are a convenience; the next change tries again.
    }
  }, 400);
}
