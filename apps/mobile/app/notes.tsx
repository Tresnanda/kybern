import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Platform, RefreshControl, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { noteMenu, attempt } from "../src/features/noteActions";
import {
  dismissUndo,
  loadNotes,
  restoreNote,
  searchNotes,
  useNotes,
} from "../src/state/notes";
import {
  checklistBadge,
  daysLeft,
  filterNotes,
  groupNotes,
  noteTitle,
  type SearchHit,
} from "../src/state/notesModel";
import { isFreeChatProject, type NoteSummary } from "../src/state/protocol";
import { activeEnvironment, useApp } from "../src/state/runtime";
import { relativeTime } from "../src/state/threadList";
import {
  Button,
  Empty,
  Icon,
  IconButton,
  styles,
  T,
  Tap,
} from "../src/ui/primitives";
import { type, useTheme } from "../src/ui/theme";

type Row =
  | { key: string; kind: "header"; title: string; subtitle?: string; count?: number; onAdd?: () => void; addLabel?: string; onToggle?: () => void; open?: boolean }
  | { key: string; kind: "note"; note: NoteSummary; first: boolean; context?: string; snippet?: string }
  | { key: string; kind: "disclosure"; label: string; open: boolean; onToggle: () => void }
  | { key: string; kind: "footnote"; text: string };

function NoteRow({
  note,
  first,
  context,
  snippet,
}: {
  note: NoteSummary;
  first: boolean;
  context?: string;
  snippet?: string;
}) {
  const { colors } = useTheme();
  const badge = checklistBadge(note);
  const deleted = !!note.deleted_at;
  const preview = snippet ?? note.preview;
  const when = deleted
    ? `${daysLeft(note.deleted_at!)}d left`
    : relativeTime(note.updated_at);
  const detail = deleted ? note.origin || context : context;
  return (
    <Tap
      label={`${noteTitle(note)}${badge ? `, ${badge} done` : ""}${deleted ? ", deleted" : ""}`}
      onPress={() =>
        deleted
          ? noteMenu(note)
          : router.push({ pathname: "/note", params: { id: note.id } })
      }
      onLongPress={() => {
        void Haptics.selectionAsync();
        noteMenu(note);
      }}
      style={{
        paddingVertical: 14,
        borderTopWidth: first ? 0 : 0.5,
        borderColor: colors.line,
        gap: 4,
        opacity: deleted ? 0.8 : 1,
      }}
    >
      <View style={styles.spread}>
        <T
          variant="body"
          numberOfLines={1}
          tone={note.title.trim() ? "ink" : "muted"}
          style={{ flex: 1, fontWeight: "500" }}
        >
          {noteTitle(note)}
        </T>
        <View style={[styles.line, { gap: 8 }]}>
          {badge ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                backgroundColor: colors.raised,
                borderRadius: 10,
                paddingHorizontal: 8,
                paddingVertical: 2,
              }}
            >
              <Icon name="checkmark.square.fill" size={11} color={colors.secondary} />
              <T variant="caption" tone="secondary" style={{ fontVariant: ["tabular-nums"] }}>
                {badge}
              </T>
            </View>
          ) : null}
          {note.pinned && !deleted ? (
            <Icon name="pin.fill" size={12} color={colors.secondary} />
          ) : null}
          <T variant="caption" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
            {when}
          </T>
        </View>
      </View>
      {preview ? (
        <T variant="caption" tone="secondary" numberOfLines={1}>
          {preview}
        </T>
      ) : (
        <T variant="caption" tone="muted" numberOfLines={1}>
          No text yet
        </T>
      )}
      {detail ? (
        <T variant="caption" tone="muted" numberOfLines={1}>
          {detail}
        </T>
      ) : null}
    </Tap>
  );
}

function Header({ row }: { row: Extract<Row, { kind: "header" }> }) {
  const { colors } = useTheme();
  const body = (
    <View style={{ flex: 1, gap: 2 }}>
      <View style={[styles.line, { gap: 8 }]}>
        <T variant="label" tone="secondary" accessibilityRole="header">
          {row.title}
        </T>
        {row.count ? (
          <T variant="caption" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
            {row.count}
          </T>
        ) : null}
        {row.onToggle ? (
          <Icon
            name={row.open ? "chevron.down" : "chevron.right"}
            size={11}
            color={colors.muted}
          />
        ) : null}
      </View>
      {row.subtitle ? (
        <T variant="caption" tone="muted" numberOfLines={1}>
          {row.subtitle}
        </T>
      ) : null}
    </View>
  );
  return (
    <View style={[styles.spread, { marginTop: 24, marginBottom: 4, gap: 4 }]}>
      {row.onToggle ? (
        <Tap
          label={`${row.title}, ${row.open ? "expanded" : "collapsed"}`}
          expanded={row.open}
          static
          onPress={row.onToggle}
          style={{ flex: 1, justifyContent: "center" }}
        >
          {body}
        </Tap>
      ) : (
        <View style={{ flex: 1, minHeight: 44, justifyContent: "center" }}>{body}</View>
      )}
      {row.onAdd ? (
        <IconButton name="plus" label={row.addLabel ?? "New note"} onPress={row.onAdd} />
      ) : null}
    </View>
  );
}

function UndoBar() {
  const { undo } = useNotes();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  if (!undo) return null;
  return (
    <Animated.View
      key={undo.id}
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(120)}
      accessibilityLiveRegion="polite"
      style={{
        position: "absolute",
        start: 16,
        end: 16,
        bottom: insets.bottom + 12,
        alignSelf: "center",
        width: "100%",
        maxWidth: 520,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        paddingStart: 18,
        paddingEnd: 6,
        borderRadius: 18,
        backgroundColor: colors.ink,
      }}
    >
      <T variant="label" tone="inverse" numberOfLines={1} style={{ flex: 1 }}>
        Note deleted
      </T>
      <Tap
        label="Undo delete"
        onPress={() => attempt(() => restoreNote(undo.id), dismissUndo)}
        style={[styles.line, { gap: 6, paddingHorizontal: 12 }]}
      >
        <Icon name="arrow.uturn.backward" size={15} color={colors.inverse} />
        <T variant="label" tone="inverse">
          Undo
        </T>
      </Tap>
    </Animated.View>
  );
}

export default function Notes() {
  const { projectId } = useLocalSearchParams<{ projectId?: string }>();
  const app = useApp();
  const { notes, loaded, unsupported, error } = useNotes();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const connected = app.status === "open";
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const computer = activeEnvironment()?.name ?? "your computer";
  const searching = query.trim().length > 0;
  const scoped = projectId ? app.projects.find((p) => p.id === projectId) : undefined;

  // The daemon also searches note bodies; titles and previews match instantly.
  const lastQuery = useRef("");
  useEffect(() => {
    const text = query.trim();
    lastQuery.current = text;
    if (text.length < 2 || !connected) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      void searchNotes(text)
        .then((results) => {
          if (lastQuery.current === text) setHits(results);
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [query, connected]);

  const reload = useCallback(async () => {
    setRefreshing(true);
    await loadNotes();
    setRefreshing(false);
  }, []);

  const newNote = useCallback(
    (project?: string) =>
      router.push({
        pathname: "/note",
        params: { new: "1", ...(project ? { projectId: project } : {}) },
      }),
    [],
  );

  const rows = useMemo<Row[]>(() => {
    const scopedNotes = projectId ? notes.filter((n) => n.project_id === projectId) : notes;
    if (!scopedNotes.length) return [];
    const { notes: visible, snippets } = filterNotes(scopedNotes, query, hits);
    const groups = groupNotes(visible, app.projects, isFreeChatProject);
    const out: Row[] = [];
    const list = (
      prefix: string,
      items: NoteSummary[],
      context?: (n: NoteSummary) => string | undefined,
    ) =>
      items.forEach((note, i) =>
        out.push({
          key: `${prefix}:${note.id}`,
          kind: "note",
          note,
          first: i === 0,
          context: context?.(note),
          snippet: snippets.get(note.id),
        }),
      );
    const placeOf = (n: NoteSummary) =>
      n.scope === "global"
        ? `Global · on ${computer}`
        : (app.projects.find((p) => p.id === n.project_id)?.name ??
          (n.project_id && isFreeChatProject(n.project_id) ? "Chats" : "Project")) +
          (n.scope === "thread" ? " · Thread note" : "");
    if (groups.pinned.length) {
      out.push({ key: "h:pinned", kind: "header", title: "Pinned", count: groups.pinned.length });
      list("pin", groups.pinned, placeOf);
    }
    // Always offer Global (and the scoped project) so there is somewhere obvious to add a note.
    if (!projectId && (groups.global.length || !searching)) {
      out.push({
        key: "h:global",
        kind: "header",
        title: "Global",
        subtitle: `On ${computer}`,
        onAdd: connected ? () => newNote() : undefined,
        addLabel: "New global note",
      });
      list("global", groups.global);
      if (!groups.global.length && !searching)
        out.push({ key: "e:global", kind: "footnote", text: "No global notes yet." });
    }
    for (const group of groups.projects) {
      out.push({
        key: `h:${group.projectId}`,
        kind: "header",
        title: group.name,
        onAdd: connected ? () => newNote(group.projectId) : undefined,
        addLabel: `New note in ${group.name}`,
      });
      list(`p:${group.projectId}`, group.notes);
      if (group.threadNotes.length) {
        const expanded = searching || !!open[`t:${group.projectId}`];
        out.push({
          key: `d:${group.projectId}`,
          kind: "disclosure",
          label: `Thread notes (${group.threadNotes.length})`,
          open: expanded,
          onToggle: () =>
            setOpen((v) => ({ ...v, [`t:${group.projectId}`]: !expanded })),
        });
        if (expanded) list(`t:${group.projectId}`, group.threadNotes);
      }
    }
    if (groups.chats.length) {
      const expanded = searching || !!open.chats;
      out.push({
        key: "h:chats",
        kind: "header",
        title: "Chats",
        count: groups.chats.length,
        open: expanded,
        onToggle: () => setOpen((v) => ({ ...v, chats: !expanded })),
      });
      if (expanded) list("chat", groups.chats);
    }
    if (groups.deleted.length) {
      const expanded = searching || !!open.deleted;
      out.push({
        key: "h:deleted",
        kind: "header",
        title: "Recently deleted",
        count: groups.deleted.length,
        open: expanded,
        onToggle: () => setOpen((v) => ({ ...v, deleted: !expanded })),
      });
      if (expanded) {
        list("del", groups.deleted);
        out.push({
          key: "f:deleted",
          kind: "footnote",
          text: "Deleted notes are removed for good after 30 days. Tap a note to restore it or delete it now.",
        });
      }
    }
    return out;
  }, [notes, hits, query, open, app.projects, projectId, computer, connected, searching, newNote]);

  const hasNotes = projectId ? notes.some((n) => n.project_id === projectId) : notes.length > 0;
  const nothing = loaded && !unsupported && !hasNotes;
  const noMatch = searching && !rows.some((r) => r.kind === "note");

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: scoped ? `${scoped.name} notes` : "Notes",
          headerLargeTitleEnabled: !scoped,
          headerRight: () => (
            <View style={styles.line}>
              {Platform.OS === "android" && (
                <IconButton
                  name="arrow.clockwise"
                  label="Refresh notes"
                  disabled={refreshing || !connected}
                  onPress={() => void reload()}
                />
              )}
              <IconButton
                name="square.and.pencil"
                label="New note"
                disabled={!connected || unsupported}
                onPress={() => newNote(projectId)}
              />
            </View>
          ),
        }}
      />
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 24,
          paddingBottom: insets.bottom + 96,
          maxWidth: 760,
          width: "100%",
          alignSelf: "center",
        }}
        refreshControl={
          Platform.OS === "ios" ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void reload()}
              tintColor={colors.ink}
            />
          ) : undefined
        }
        ListHeaderComponent={
          <View
            style={{
              ...styles.line,
              backgroundColor: colors.raised,
              borderRadius: 15,
              paddingHorizontal: 13,
              marginVertical: 16,
            }}
          >
            <Icon name="magnifyingglass" size={18} color={colors.secondary} />
            <TextInput
              underlineColorAndroid="transparent"
              accessibilityLabel="Search notes"
              placeholder="Search notes"
              value={query}
              onChangeText={setQuery}
              placeholderTextColor={colors.muted}
              selectionColor={colors.accent}
              autoCorrect={false}
              returnKeyType="search"
              clearButtonMode="while-editing"
              style={[type.body, { color: colors.ink, flex: 1, minHeight: 48 }]}
            />
          </View>
        }
        renderItem={({ item }) => {
          switch (item.kind) {
            case "header":
              return <Header row={item} />;
            case "note":
              return (
                <NoteRow
                  note={item.note}
                  first={item.first}
                  context={item.context}
                  snippet={item.snippet}
                />
              );
            case "disclosure":
              return (
                <Tap
                  label={item.label}
                  expanded={item.open}
                  static
                  onPress={item.onToggle}
                  style={[styles.line, { gap: 8, borderTopWidth: 0.5, borderColor: colors.line }]}
                >
                  <Icon
                    name={item.open ? "chevron.down" : "chevron.right"}
                    size={11}
                    color={colors.muted}
                  />
                  <T variant="caption" tone="secondary">
                    {item.label}
                  </T>
                </Tap>
              );
            case "footnote":
              return (
                <T variant="caption" tone="muted" style={{ paddingVertical: 10 }}>
                  {item.text}
                </T>
              );
          }
        }}
        ListEmptyComponent={
          !connected && !loaded ? (
            <Empty
              icon="doc.text"
              title="Connect your computer"
              detail="Notes live on your computer and sync with this phone."
              action={
                <Button onPress={() => router.push(app.activeId ? "/settings" : "/connect")}>
                  {app.activeId ? "Open connections" : "Connect your computer"}
                </Button>
              }
            />
          ) : unsupported ? (
            <Empty
              icon="doc.text"
              title="Update Kybern on your computer"
              detail="This computer’s Kybern is too old to keep notes. Update it, then open Notes again."
            />
          ) : !loaded ? (
            <T variant="caption" tone="secondary" style={{ paddingVertical: 24 }}>
              Loading notes…
            </T>
          ) : null
        }
        ListFooterComponent={
          <View>
            {error ? (
              <T variant="caption" tone="negative" style={{ paddingVertical: 12 }}>
                {error}
              </T>
            ) : null}
            {nothing && (
              <Empty
                icon="doc.text"
                title="Your notes, across every project"
                detail="Jot down ideas, checklists and reminders. Start a line with - [ ] to make a checklist."
                action={
                  <Button icon="plus" onPress={() => newNote(projectId)}>
                    New note
                  </Button>
                }
              />
            )}
            {noMatch && !nothing && loaded && (
              <T tone="secondary" style={{ paddingVertical: 24 }}>
                No notes match “{query.trim()}”. Try another word.
              </T>
            )}
          </View>
        }
      />
      <UndoBar />
    </View>
  );
}
