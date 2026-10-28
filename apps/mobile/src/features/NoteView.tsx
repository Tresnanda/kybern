import { useRef, type ReactNode } from "react";
import { TextInput, View } from "react-native";
import { relativeTime } from "../state/threadList";
import { restoreNote } from "../state/notes";
import { saveStatusText } from "../state/notesModel";
import type { useNoteSession } from "../state/useNoteSession";
import { Markdown } from "../ui/Markdown";
import { Button, ErrorBanner, T } from "../ui/primitives";
import { radius, space, useType, useTheme } from "../ui/theme";
import { attempt } from "./noteActions";

type Session = ReturnType<typeof useNoteSession>;

export function editedLabel(updatedAt?: string) {
  if (!updatedAt) return "";
  const ago = relativeTime(updatedAt);
  return ago === "Now" ? "Edited just now" : `Edited ${ago} ago`;
}

/**
 * @deprecated Use `Button` (`role="tinted"` for the primary choice, `"plain"`
 * otherwise). Kept for pages that still import it.
 */
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
  return (
    <Button role={primary ? "tinted" : "plain"} size="medium" disabled={disabled} onPress={onPress}>
      {label}
    </Button>
  );
}

/** Switches between the rendered note and its Markdown text: a plain "Edit" / "Done". */
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
    <Button role="plain" size="medium" disabled={disabled} onPress={() => onChange(!editing)}>
      {editing ? "Done" : "Edit"}
    </Button>
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
        padding: space.lg,
        borderRadius: radius.md,
        backgroundColor: colors.warningSoft,
        gap: space.md,
        marginBottom: space.lg,
      }}
    >
      <View style={{ gap: space.xs }}>
        <T variant="headline" tone="warning">
          {title}
        </T>
        <T variant="footnote" tone="warning">
          {detail}
        </T>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg, flexWrap: "wrap" }}>
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
  placeholder,
  emptyText,
  saveFailedText,
}: {
  s: Session;
  editing: boolean;
  showTitle: boolean;
  fill?: boolean;
  autoFocusBody?: boolean;
  maxEditorHeight?: number;
  /** The editor's hint while the text is empty. */
  placeholder?: string;
  /** What an empty note says when read. */
  emptyText?: string;
  /** What a failed save says, instead of the generic note message. */
  saveFailedText?: string;
}) {
  const { colors } = useTheme();
  const type = useType();
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
          <Button size="medium" onPress={() => void s.session.keepMine()}>
            Keep mine
          </Button>
          <Button role="plain" size="medium" onPress={() => void s.session.loadTheirs()}>
            Load theirs
          </Button>
        </Banner>
      )}
      {s.status === "error" && (
        <ErrorBanner
          error={saveFailedText ?? "Unable to save your changes. Check your connection. They stay on this phone."}
          onRetry={() => void s.session.retry()}
        />
      )}
      {s.deleted && s.note && (
        <Banner
          title="In Recently deleted"
          detail="Restore this note to edit it. It is removed for good 30 days after deleting."
        >
          <Button
            size="medium"
            icon="arrow.uturn.backward"
            onPress={() =>
              attempt(async () => {
                await restoreNote(s.note!.id);
                await s.session.sync();
              })
            }
          >
            Restore note
          </Button>
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
                style={[type.title, { letterSpacing: 0, color: colors.ink, padding: 0 }]}
              />
            ))}
          <TextInput
            ref={body}
            underlineColorAndroid="transparent"
            accessibilityLabel="Note text, Markdown"
            placeholder={placeholder ?? "Write something. Use - [ ] for a checklist."}
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
              { letterSpacing: 0,
                color: colors.ink,
                padding: 0,
                minHeight: fill ? undefined : 220,
                flex: fill ? 1 : undefined,
                maxHeight: maxEditorHeight,
              },
            ]}
          />
          <T
            variant="footnote"
            tone={s.status === "saved" ? "positive" : "muted"}
            accessibilityLiveRegion="polite"
            style={{ minHeight: 19 }}
          >
            {!s.connected ? "Offline. Changes stay on this phone." : status}
          </T>
        </View>
      ) : (
        <View style={{ gap: space.md }}>
          {showTitle && (
            <T variant="title" selectable>
              {s.title.trim() || "Untitled"}
            </T>
          )}
          {!s.loaded && !s.loadError ? (
            <T variant="footnote" tone="secondary">
              Loading note…
            </T>
          ) : s.body.trim() ? (
            <Markdown text={s.body} />
          ) : (
            <T tone="muted">
              {s.deleted ? "This note is empty." : emptyText ?? "Nothing here yet. Tap Edit to start writing."}
            </T>
          )}
          {/* A page with a title says when it was edited in its location line. */}
          {s.note && !showTitle && (
            <T variant="footnote" tone="muted">
              {editedLabel(s.note.updated_at)}
            </T>
          )}
        </View>
      )}
    </View>
  );
}
