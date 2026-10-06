import { router } from "expo-router";
import { Text, View } from "react-native";
import { useNote, useNotesKnown } from "../state/notes";
import { Icon } from "./primitives";
import { writtenRefLabel } from "./TaskRef";
import { useTheme } from "./theme";

/**
 * A `kybern://note/<id>` link in a message, drawn as a live reference: a note
 * icon and the note's title, which follows a rename and opens the note on tap.
 * Before the list arrives it shows the link's own label; a note that is gone
 * reads "Deleted note" and stops being a link.
 */
export function NoteRef({ id, label }: { id: string; label: string }) {
  const note = useNote(id);
  const known = useNotesKnown();
  const { colors } = useTheme();
  const written = writtenRefLabel(label);
  if ((!note || note.deleted_at) && known)
    return <Text style={{ color: colors.muted }}>Deleted note</Text>;
  const title = note?.title.trim() || written || (note ? "Untitled note" : "Note");
  return (
    <Text
      accessibilityRole="link"
      accessibilityLabel={`${title}. Open note`}
      suppressHighlighting={false}
      onPress={() => router.push({ pathname: "/note", params: { id } })}
      style={{ color: colors.ink, fontWeight: "500", textDecorationLine: "none" }}
    >
      {/* The icon sits with the first word so a long title wraps after it. */}
      <View style={{ width: 18, height: 14, transform: [{ translateY: 2 }] }}>
        <Icon name="doc.text" size={14} color={colors.ink} />
      </View>
      {title}
    </Text>
  );
}
