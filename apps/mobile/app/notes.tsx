import { LinearGradient } from "expo-linear-gradient";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, RefreshControl, View } from "react-native";
import Animated, {
  useAnimatedScrollHandler,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { attempt, noteMenuItems } from "../src/features/noteActions";
import { confirm } from "../src/ui/Alert";
import { HeaderActions } from "../src/ui/ActionMenu";
import {
  deleteNote,
  deleteNotes,
  dismissUndo,
  loadNotes,
  pinNote,
  purgeNote,
  restoreNote,
  restoreNotes,
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
import { count } from "../src/state/format";
import { isFreeChatProject, type NoteSummary } from "../src/state/protocol";
import { activeEnvironment, useApp } from "../src/state/runtime";
import { useInSpace } from "../src/state/spaces";
import { relativeTime } from "../src/state/threadList";
import {
  DisclosureRow,
  ListRow,
  SectionFooter,
  SectionHeader,
  type SwipeAction,
} from "../src/ui/List";
import { Button, Empty, T } from "../src/ui/primitives";
import { PullRefresh } from "../src/ui/PullRefresh";
import { ListSearch } from "../src/ui/Search";
import { CONTENT_MAX_WIDTH, space, useTheme } from "../src/ui/theme";
import { Toast } from "../src/ui/Toast";

type Row =
  | {
      key: string;
      kind: "header";
      title: string;
      count?: number;
      first: boolean;
      action?: { title: string; label: string; onPress: () => void };
      open?: boolean;
      onToggle?: () => void;
    }
  | {
      key: string;
      kind: "note";
      note: NoteSummary;
      /** Draw the inset hairline under it (not after a section's last row). */
      separator: boolean;
      context?: string;
      snippet?: string;
      /** A thread note inside its project's disclosure. */
      nested?: boolean;
    }
  | { key: string; kind: "disclosure"; title: string; count: number; open: boolean; onToggle: () => void }
  | { key: string; kind: "empty"; ids: string[] }
  | { key: string; kind: "footnote"; text: string };

/** Swipes: Pin on the leading edge, Delete (full swipe) on the trailing one; Restore and Delete forever once deleted. */
function swipeFor(note: NoteSummary): { leading: SwipeAction[]; trailing: SwipeAction[] } {
  const title = noteTitle(note);
  if (note.deleted_at)
    return {
      leading: [
        {
          title: "Restore",
          icon: "arrow.uturn.backward",
          tone: "accent",
          full: true,
          onPress: () => attempt(() => restoreNote(note.id)),
        },
      ],
      trailing: [
        {
          title: "Delete",
          icon: "trash",
          tone: "negative",
          onPress: () =>
            confirm({
              title: `Delete “${title}” forever?`,
              message: "This can’t be undone.",
              confirm: "Delete forever",
              destructive: true,
              onConfirm: () => attempt(() => purgeNote(note.id)),
            }),
        },
      ],
    };
  return {
    leading: [
      {
        title: note.pinned ? "Unpin" : "Pin",
        icon: note.pinned ? "pin.slash" : "pin",
        tone: "accent",
        full: true,
        onPress: () => attempt(() => pinNote(note.id, !note.pinned)),
      },
    ],
    trailing: [
      {
        title: "Delete",
        icon: "trash",
        tone: "negative",
        full: true,
        onPress: () => attempt(() => deleteNote(note.id)),
      },
    ],
  };
}

const NoteRow = memo(function NoteRow({
  note,
  separator,
  context,
  snippet,
  nested,
}: Omit<Extract<Row, { kind: "note" }>, "key" | "kind">) {
  const badge = checklistBadge(note);
  const deleted = !!note.deleted_at;
  const preview = (snippet ?? note.preview).replace(/\s+/g, " ").trim();
  const title = noteTitle(note);
  // An untitled note borrows its first line as the title: don't repeat it underneath.
  const body = note.title.trim() ? preview : "";
  const where = deleted ? note.origin || context : context;
  const subtitle = [where, badge ? `${badge} done` : "", body].filter(Boolean).join(" · ");
  return (
    <ListRow
      title={title}
      subtitle={subtitle || undefined}
      subtitleLines={1}
      leading={nested ? "text.bubble" : undefined}
      meta={deleted ? `${daysLeft(note.deleted_at!)}d left` : relativeTime(note.updated_at)}
      label={[title, subtitle, deleted ? "deleted" : note.pinned ? "pinned" : ""].filter(Boolean).join(", ")}
      onPress={() => router.push({ pathname: "/note", params: { id: note.id } })}
      menu={noteMenuItems(note)}
      menuTitle={title}
      swipe={swipeFor(note)}
      separator={separator}
    />
  );
});

function EmptyNotes({ ids }: { ids: string[] }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        minHeight: 44,
        paddingHorizontal: space.lg,
        marginTop: space.lg,
      }}
    >
      <T variant="subhead" tone="secondary" style={{ flex: 1 }}>
        {count(ids.length, "empty note")}
      </T>
      <Button
        role="plain"
        size="medium"
        label={`Delete ${count(ids.length, "empty note")}`}
        onPress={() => attempt(() => deleteNotes(ids))}
      >
        Delete
      </Button>
    </View>
  );
}

function UndoBar({ bottom }: { bottom: number }) {
  const { undo } = useNotes();
  if (!undo) return null;
  return (
    <Toast
      key={undo.ids.join(",")}
      text={undo.ids.length > 1 ? `${count(undo.ids.length, "note")} deleted` : "Note deleted"}
      bottom={bottom}
      onDismiss={dismissUndo}
      action={{
        title: "Undo",
        icon: "arrow.uturn.backward",
        onPress: () => attempt(() => restoreNotes(undo.ids)),
      }}
    />
  );
}

export default function Notes() {
  const { projectId } = useLocalSearchParams<{ projectId?: string }>();
  const app = useApp();
  const { notes, loaded, unsupported, error, undo } = useNotes();
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
  // Global notes show in every space; project notes in their project's space.
  const inSpace = useInSpace();
  const offset = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      offset.set(event.contentOffset.y);
    },
  });

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
    const scopedNotes = projectId
      ? notes.filter((n) => n.project_id === projectId)
      : notes.filter((n) => inSpace(n.project_id));
    if (!scopedNotes.length) return [];
    const { notes: visible, snippets } = filterNotes(scopedNotes, query, hits);
    const groups = groupNotes(visible, app.projects, isFreeChatProject);
    const out: Row[] = [];
    const header = (row: Omit<Extract<Row, { kind: "header" }>, "kind" | "first">) =>
      out.push({ ...row, kind: "header", first: out.length === 0 });
    const list = (
      prefix: string,
      items: NoteSummary[],
      options: { context?: (n: NoteSummary) => string | undefined; nested?: boolean } = {},
    ) =>
      items.forEach((note, i) =>
        out.push({
          key: `${prefix}:${note.id}`,
          kind: "note",
          note,
          separator: i < items.length - 1,
          context: options.context?.(note),
          snippet: snippets.get(note.id),
          nested: options.nested,
        }),
      );
    const placeOf = (n: NoteSummary) =>
      n.scope === "global"
        ? "Global"
        : (app.projects.find((p) => p.id === n.project_id)?.name ??
          (n.project_id && isFreeChatProject(n.project_id) ? "Chats" : "Project"));
    const add = (title: string, project?: string) =>
      connected
        ? { title: "New", label: `New note in ${title}`, onPress: () => newNote(project) }
        : undefined;
    if (groups.pinned.length) {
      header({ key: "h:pinned", title: "Pinned", count: groups.pinned.length });
      list("pin", groups.pinned, { context: projectId ? undefined : placeOf });
    }
    // Always offer Global (and the scoped project) so there is somewhere obvious to add a note.
    if (!projectId && (groups.global.length || !searching)) {
      header({
        key: "h:global",
        title: "Global",
        count: groups.global.length || undefined,
        action: add("Global"),
      });
      list("global", groups.global);
      if (!groups.global.length && !searching)
        out.push({ key: "e:global", kind: "footnote", text: "No global notes yet." });
    }
    for (const group of groups.projects) {
      header({
        key: `h:${group.projectId}`,
        title: group.name,
        count: group.notes.length || undefined,
        action: add(group.name, group.projectId),
      });
      list(`p:${group.projectId}`, group.notes);
      if (group.threadNotes.length) {
        const expanded = searching || !!open[`t:${group.projectId}`];
        out.push({
          key: `d:${group.projectId}`,
          kind: "disclosure",
          title: "Thread notes",
          count: group.threadNotes.length,
          open: expanded,
          onToggle: () => setOpen((v) => ({ ...v, [`t:${group.projectId}`]: !expanded })),
        });
        if (expanded) list(`t:${group.projectId}`, group.threadNotes, { nested: true });
      }
    }
    if (groups.empty.length && !searching)
      out.push({ key: "empty", kind: "empty", ids: groups.empty.map((n) => n.id) });
    if (groups.chats.length) {
      const expanded = searching || !!open.chats;
      header({
        key: "h:chats",
        title: "Chats",
        count: groups.chats.length,
        open: expanded,
        onToggle: () => setOpen((v) => ({ ...v, chats: !expanded })),
      });
      if (expanded) list("chat", groups.chats);
    }
    if (groups.deleted.length) {
      const expanded = searching || !!open.deleted;
      header({
        key: "h:deleted",
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
          text: "Deleted notes are removed for good after 30 days.",
        });
      }
    }
    return out;
  }, [notes, hits, query, open, app.projects, projectId, connected, searching, newNote, inSpace]);

  const hasNotes = projectId
    ? notes.some((n) => n.project_id === projectId)
    : notes.some((n) => inSpace(n.project_id));
  const nothing = loaded && !unsupported && !hasNotes;
  const noMatch = searching && !rows.some((r) => r.kind === "note");
  // Android draws edge to edge: keep the last row clear of the gesture bar and fade what scrolls under it.
  const edge = Platform.OS === "android" ? 24 : 0;
  // iOS 26 puts the header search bar at the bottom: the toast sits above it.
  const toastLift = Platform.OS === "ios" ? 56 : 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: scoped ? `${scoped.name} notes` : "Notes",
          headerLargeTitleEnabled: !scoped,
        }}
      />
      <HeaderActions
        buttons={[
          {
            icon: "square.and.pencil",
            label: "New note",
            disabled: !connected || unsupported,
            onPress: () => newNote(projectId),
          },
        ]}
      />
      {Platform.OS === "ios" ? (
        <ListSearch value={query} onChangeText={setQuery} placeholder="Search notes" />
      ) : hasNotes ? (
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xs }}>
          <ListSearch value={query} onChangeText={setQuery} placeholder="Search notes" />
        </View>
      ) : null}
      <PullRefresh offset={offset} refreshing={refreshing} onRefresh={reload} label="Refreshing notes">
        <Animated.FlatList
          data={rows}
          onScroll={onScroll}
          scrollEventThrottle={16}
          keyExtractor={(row) => row.key}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            paddingBottom: insets.bottom + space.xl + edge + (undo ? 72 : 0),
            maxWidth: CONTENT_MAX_WIDTH,
            width: "100%",
            alignSelf: "center",
          }}
          refreshControl={
            Platform.OS === "ios" ? (
              <RefreshControl refreshing={refreshing} onRefresh={() => void reload()} />
            ) : undefined
          }
          renderItem={({ item }) => {
            switch (item.kind) {
              case "header":
                return (
                  <SectionHeader
                    title={item.title}
                    count={item.count}
                    action={item.action}
                    open={item.open}
                    onToggle={item.onToggle}
                    first={item.first}
                    inset
                  />
                );
              case "note":
                return (
                  <NoteRow
                    note={item.note}
                    separator={item.separator}
                    context={item.context}
                    snippet={item.snippet}
                    nested={item.nested}
                  />
                );
              case "disclosure":
                return (
                  <DisclosureRow
                    title={item.title}
                    count={item.count}
                    open={item.open}
                    onToggle={item.onToggle}
                  />
                );
              case "empty":
                return <EmptyNotes ids={item.ids} />;
              case "footnote":
                return <Empty variant="inline" title={item.text} />;
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
              <Empty variant="inline" title="Loading notes…" />
            ) : null
          }
          ListFooterComponent={
            <View>
              {error ? (
                <T variant="footnote" tone="negative" style={{ paddingVertical: space.md, paddingHorizontal: space.lg }}>
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
                <Empty variant="inline" title={`No notes match “${query.trim()}”.`} />
              )}
              {hasNotes && !searching && (
                <View style={{ marginTop: space.xl }}>
                  <SectionFooter inset>{`Notes live on ${computer} and sync with this phone.`}</SectionFooter>
                </View>
              )}
            </View>
          }
        />
      </PullRefresh>
      {edge > 0 && (
        <LinearGradient
          pointerEvents="none"
          colors={[`${colors.background}00`, colors.background]}
          style={{ position: "absolute", start: 0, end: 0, bottom: 0, height: insets.bottom + edge }}
        />
      )}
      <UndoBar bottom={toastLift} />
    </View>
  );
}
