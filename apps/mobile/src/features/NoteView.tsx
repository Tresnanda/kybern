import { useRef, type ReactNode } from "react";
import { TextInput, View } from "react-native";
import { relativeTime } from "../state/threadList";
import { restoreNote } from "../state/notes";
import { saveStatusText } from "../state/notesModel";
import type { useNoteSession } from "../state/useNoteSession";
import { Markdown } from "../ui/Markdown";
import { ErrorBanner, T, Tap } from "../ui/primitives";
import { type, useTheme } from "../ui/theme";
import { attempt } from "./noteActions";

type Session = ReturnType<typeof useNoteSession>;

export function editedLabel(updatedAt?: string) {
  if (!updatedAt) return "";
  const ago = relativeTime(updatedAt);
  return ago === "Now" ? "Edited just now" : `Edited ${ago} ago`;
}

/** A compact filled or quiet pill used for the note's inline actions. */
export function Pill({
  label,
  onPress,
  primary,
  disabled,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Tap
      label={label}
      onPress={onPress}
      disabled={disabled}
      style={{
        minHeight: 44,
        paddingHorizontal: 18,
        borderRadius: 22,
        alignItems: "center",
        backgroundColor: primary ? colors.ink : colors.raised,
      }}
    >
      <T variant="label" tone={primary ? "inverse" : "ink"}>
        {label}
      </T>
    </Tap>
  );
}

/** Switches between the rendered note and its Markdown text. */
export function ModeToggle({
  editing,
  onChange,
  disabled,
}: {
  editing: boolean;
  onChange: (editing: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Pill
      label={editing ? "Done" : "Edit"}
      primary={editing}
      disabled={disabled}
      onPress={() => onChange(!editing)}
    />
  );
}

function Banner({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        padding: 16,
        borderRadius: 16,
        backgroundColor: colors.warningSoft,
        gap: 12,
        marginBottom: 16,
      }}
    >
      <View style={{ gap: 4 }}>
        <T variant="label" tone="warning">
          {title}
        </T>
        <T variant="caption" tone="warning">
          {detail}
        </T>
      </View>
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        {children}
      </View>
    </View>
  );
}

/**
 * The note itself: rendered Markdown, or a plain text editor, plus the
 * conflict, error and deleted notices. The parent owns the Edit/Done choice.
 * With `fill`, the editor takes the remaining height and scrolls on its own;
 * otherwise it grows inside the parent's scroll view.
 */
export function NoteView({
  s,
  editing,
  showTitle,
  fill,
  autoFocusBody,
  maxEditorHeight,
}: {
  s: Session;
  editing: boolean;
  showTitle: boolean;
  fill?: boolean;
  autoFocusBody?: boolean;
  maxEditorHeight?: number;
}) {
  const { colors } = useTheme();
  const body = useRef<TextInput>(null);
  const editable = s.connected && s.loaded && !s.deleted;
  const readOnlyTitle = s.note?.scope === "thread";
  const status = saveStatusText(s.status);
  return (
    <View style={fill ? { flex: 1 } : undefined}>
      {s.loadError ? (
        <ErrorBanner
          error={s.loadError}
          onRetry={() => void s.session.sync()}
        />
      ) : null}
      {s.conflict && (
        <Banner
          title="Edited on another device"
          detail="Your changes are kept on this phone. Keep mine replaces the other version. Load theirs discards your changes."
        >
          <Pill primary label="Keep mine" onPress={() => void s.session.keepMine()} />
          <Pill label="Load theirs" onPress={() => void s.session.loadTheirs()} />
        </Banner>
      )}
      {s.status === "error" && (
        <ErrorBanner
          error="Unable to save your changes. Check your connection. They stay on this phone."
          onRetry={() => void s.session.retry()}
        />
      )}
      {s.deleted && s.note && (
        <Banner
          title="In Recently deleted"
          detail="Restore this note to edit it. It is removed for good 30 days after deleting."
        >
          <Pill
            primary
            label="Restore note"
            onPress={() =>
              attempt(async () => {
                await restoreNote(s.note!.id);
                await s.session.sync();
              })
            }
          />
        </Banner>
      )}
      {editing && !s.deleted ? (
        <View style={fill ? { flex: 1, gap: 12 } : { gap: 12 }}>
          {showTitle &&
            (readOnlyTitle ? (
              <T variant="title" numberOfLines={2}>
                {s.title.trim() || "Untitled"}
              </T>
            ) : (
              <TextInput
                underlineColorAndroid="transparent"
                accessibilityLabel="Title"
                placeholder="Untitled"
                placeholderTextColor={colors.muted}
                selectionColor={colors.accent}
                value={s.title}
                editable={editable}
                onChangeText={s.session.setTitle.bind(s.session)}
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => body.current?.focus()}
                maxLength={300}
                multiline
                style={[type.title, { color: colors.ink, padding: 0 }]}
              />
            ))}
          <TextInput
            ref={body}
            underlineColorAndroid="transparent"
            accessibilityLabel="Note text, Markdown"
            placeholder="Write something. Use - [ ] for a checklist."
            placeholderTextColor={colors.muted}
            selectionColor={colors.accent}
            multiline
            autoFocus={autoFocusBody}
            textAlignVertical="top"
            scrollEnabled={!!fill || maxEditorHeight !== undefined}
            value={s.body}
            editable={editable}
            onChangeText={s.session.setBody.bind(s.session)}
            style={[
              type.body,
              {
                color: colors.ink,
                padding: 0,
                minHeight: fill ? undefined : 220,
                flex: fill ? 1 : undefined,
                maxHeight: maxEditorHeight,
              },
            ]}
          />
          <T
            variant="caption"
            tone={s.status === "saved" ? "positive" : "muted"}
            accessibilityLiveRegion="polite"
            style={{ minHeight: 19 }}
          >
            {!s.connected ? "Offline. Changes stay on this phone." : status}
          </T>
        </View>
      ) : (
        <View style={{ gap: 12 }}>
          {showTitle && (
            <T variant="title" tone={s.title.trim() ? "ink" : "muted"}>
              {s.title.trim() || "Untitled"}
            </T>
          )}
          {!s.loaded && !s.loadError ? (
            <T variant="caption" tone="secondary">
              Loading note…
            </T>
          ) : s.body.trim() ? (
            <Markdown text={s.body} />
          ) : (
            <T tone="muted">
              {s.deleted ? "This note is empty." : "Nothing here yet. Tap Edit to start writing."}
            </T>
          )}
          {s.note && (
            <T variant="caption" tone="muted">
              {editedLabel(s.note.updated_at)}
            </T>
          )}
        </View>
      )}
    </View>
  );
}
