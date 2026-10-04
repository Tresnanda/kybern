import { useState } from "react";
import { View } from "react-native";
import { useNoteSession } from "../state/useNoteSession";
import { styles, T } from "../ui/primitives";
import { ModeToggle, NoteView } from "./NoteView";

/**
 * A conversation's note, shared with the Notes list and the desktop. Opens
 * rendered; Edit switches to the Markdown text. Changes save on their own.
 */
export function ThreadNotes({ threadId }: { threadId: string }) {
  const s = useNoteSession({ kind: "thread", threadId });
  const [editing, setEditing] = useState(false);
  return (
    <View style={{ gap: 16 }}>
      <View style={styles.spread}>
        <T variant="caption" tone="secondary" style={{ flex: 1 }}>
          Ideas, reminders and things to do in this conversation. Changes save on their own.
        </T>
        <ModeToggle
          editing={editing}
          disabled={!s.loaded}
          onChange={(next) => {
            if (!next) void s.session.flush();
            setEditing(next);
          }}
        />
      </View>
      <NoteView s={s} editing={editing} showTitle={false} maxEditorHeight={440} />
    </View>
  );
}
