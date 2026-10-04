import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { Share } from "react-native";
import { Alert } from "../ui/Alert";
import { deleteNote, pinNote, purgeNote, restoreNote } from "../state/notes";
import { noteMarkdown, noteTitle } from "../state/notesModel";
import type { NoteSummary } from "../state/protocol";
import { errorText, rpc } from "../state/runtime";

function fail(e: unknown) {
  Alert.alert("Unable to update the note", errorText(e), [{ text: "OK" }]);
}
/** Run an action and tell the reader what to do if it fails. */
export function attempt(work: () => Promise<unknown>, after?: () => void) {
  void work().then(() => after?.(), fail);
}

async function markdownOf(note: NoteSummary, live?: () => string) {
  if (live) return live();
  const { note: full } = await rpc("notes.get", { id: note.id });
  return noteMarkdown(note.title, full?.body ?? "");
}

export function moveNoteTo(note: NoteSummary) {
  router.push({ pathname: "/note-move", params: { id: note.id } });
}

/**
 * The menu behind a note's long-press and its "…" button. `markdown` gives the
 * live text of an open note; the list fetches the saved body instead.
 */
export function noteMenu(
  note: NoteSummary,
  options: { markdown?: () => string; afterDelete?: () => void } = {},
) {
  const title = noteTitle(note);
  if (note.deleted_at) {
    Alert.alert(title, undefined, [
      {
        text: "Restore",
        onPress: () => attempt(() => restoreNote(note.id)),
      },
      {
        text: "Delete forever",
        style: "destructive",
        onPress: () =>
          Alert.alert(
            "Delete this note forever?",
            "This can’t be undone.",
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Delete forever",
                style: "destructive",
                onPress: () => attempt(() => purgeNote(note.id), options.afterDelete),
              },
            ],
          ),
      },
      { text: "Cancel", style: "cancel" },
    ]);
    return;
  }
  Alert.alert(title, undefined, [
    {
      text: note.pinned ? "Unpin" : "Pin",
      onPress: () => attempt(() => pinNote(note.id, !note.pinned)),
    },
    ...(note.scope === "thread"
      ? []
      : [{ text: "Move to…", onPress: () => moveNoteTo(note) }]),
    {
      text: "Copy as Markdown",
      onPress: () =>
        attempt(async () => {
          await Clipboard.setStringAsync(await markdownOf(note, options.markdown));
        }),
    },
    {
      text: "Share…",
      onPress: () =>
        attempt(async () => {
          await Share.share({
            title,
            message: await markdownOf(note, options.markdown),
          });
        }),
    },
    {
      text: "Delete",
      style: "destructive" as const,
      onPress: () => attempt(() => deleteNote(note.id), options.afterDelete),
    },
    { text: "Cancel", style: "cancel" as const },
  ]);
}
