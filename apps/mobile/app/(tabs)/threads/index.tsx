// Threads, grouped by project. Large title, native search, compose in the
// toolbar, long-press for pin and archive.

import React, { useCallback, useMemo, useState } from "react";
import { Platform, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Link, Stack, useRouter } from "expo-router";
import { useConnection } from "@/connection/ConnectionContext";
import { relativeTime } from "@/lib/time";
import { PROVIDER_DISPLAY_NAME, type Project, type Thread } from "@/protocol";
import { patchThread, refreshDaemon, useDaemon } from "@/state/daemon";
import { ConnectionBanner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { Glass } from "@/ui/Glass";
import { Icon } from "@/ui/Icon";
import { ActionSheet, type MenuItem } from "@/ui/NativeMenu";
import { EmptyState, Screen, Txt } from "@/ui/Screen";
import { StatusGlyph, statusLabel } from "@/ui/StatusGlyph";
import { Tap, fireHaptic } from "@/ui/Tap";
import { GUTTER, radius, space, useTheme } from "@/ui/theme";

type Section = { project: Project; data: Thread[] };

export default function ThreadsScreen() {
  const th = useTheme();
  const router = useRouter();
  const { client, status, statusDetail } = useConnection();
  const { projects, threads, loaded, error } = useDaemon();
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!client) return;
    setRefreshing(true);
    await refreshDaemon(client);
    setRefreshing(false);
  }, [client]);

  const sections = useMemo<Section[]>(() => {
    const q = query.trim().toLowerCase();
    const byProject = new Map<string, Thread[]>();
    for (const t of threads.values()) {
      if (t.status === "archived") continue;
      if (q && !`${t.title} ${t.worktree?.branch ?? ""}`.toLowerCase().includes(q)) continue;
      const list = byProject.get(t.project_id) ?? [];
      list.push(t);
      byProject.set(t.project_id, list);
    }
    const rank = (x: Thread) => (x.status === "awaiting-approval" ? 0 : x.pinned ? 1 : 2);
    return projects
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((project) => ({
        project,
        data: (byProject.get(project.id) ?? []).sort((a, b) => rank(a) - rank(b) || b.updated_at.localeCompare(a.updated_at)),
      }))
      .filter((s) => s.data.length > 0 || !q);
  }, [projects, threads, query]);

  return (
    <Screen>
      <Stack.Screen options={{ title: "Threads", headerLargeTitleEnabled: true }} />
      <Stack.SearchBar placeholder="Search threads" hideWhenScrolling autoCapitalize="none" onChangeText={(e) => setQuery(e.nativeEvent.text)} onCancelButtonPress={() => setQuery("")} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="square.and.pencil" accessibilityLabel="New thread" onPress={() => router.push("/thread/new")} />
      </Stack.Toolbar>
      <ConnectionBanner status={status} detail={statusDetail} error={error} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.list, sections.length === 0 ? { flexGrow: 1 } : null]}
        keyboardDismissMode="on-drag"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={th.textSecondary} />}
      >
        {sections.map((section) => (
          <View key={section.project.id} style={styles.section}>
            <View style={styles.sectionHeader}>
              <Txt variant="headline" numberOfLines={1}>
                {section.project.name}
              </Txt>
              <Txt variant="footnote" tone="tertiary" numberOfLines={1}>
                {section.project.path.replace(/^\/(?:private\/)?Users\/[^/]+/, "~")}
              </Txt>
            </View>
            <Glass radius={radius.lg}>
              <View>
                {section.data.length === 0 ? (
                  <View style={styles.emptyCard}>
                    <Txt variant="subhead" tone="secondary">
                      No threads yet.
                    </Txt>
                    <Txt variant="subhead" onPress={() => router.push({ pathname: "/thread/new", params: { project: section.project.id } })} suppressHighlighting style={{ fontWeight: "600" }}>
                      Start one
                    </Txt>
                  </View>
                ) : (
                  section.data.map((item, index) => <ThreadRow key={item.id} thread={item} project={section.project} last={index === section.data.length - 1} />)
                )}
              </View>
            </Glass>
          </View>
        ))}
        {loaded && sections.length === 0 ? (
          query ? (
            <EmptyState title={`No results for “${query}”`} hint="Try another word from the title or branch." />
          ) : (
            <EmptyState
              title="No projects yet"
              hint="Add a project on the machine running the daemon, then start a thread from here."
              action={<Button title="New thread" variant="ink" onPress={() => router.push("/thread/new")} />}
            />
          )
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function ThreadRow({ thread, project, last }: { thread: Thread; project: Project; last: boolean }) {
  const th = useTheme();
  const { client } = useConnection();
  const [sheet, setSheet] = useState(false);
  const label = statusLabel(thread.status);
  const needsYou = thread.status === "awaiting-approval";
  const meta = [PROVIDER_DISPLAY_NAME[thread.provider.kind] ?? thread.provider.kind, thread.worktree?.branch ?? null, relativeTime(thread.updated_at)]
    .filter(Boolean)
    .join(" · ");

  const togglePin = async () => {
    if (!client) return;
    const next = await client.call("threads.update", { thread_id: thread.id, pinned: !thread.pinned });
    patchThread(next);
  };
  const archive = async () => {
    if (!client) return;
    await client.call("threads.archive", { thread_id: thread.id });
    patchThread({ ...thread, status: "archived" });
  };
  const items: MenuItem[] = [
    { title: thread.pinned ? "Unpin" : "Pin", icon: thread.pinned ? "unpin" : "pin", onPress: () => void togglePin() },
    { title: "Archive", icon: "archive", destructive: true, onPress: () => void archive() },
  ];

  const body = (
    <View style={[styles.row, !last ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: th.hairline } : null]}>
      <View style={styles.rowBody}>
        <Txt variant="body" numberOfLines={1} style={needsYou ? { fontWeight: "600" } : undefined}>
          {thread.title || "Untitled"}
        </Txt>
        <Txt variant="footnote" tone="secondary" numberOfLines={1}>
          {meta}
        </Txt>
      </View>
      {thread.pinned ? <Icon name="pinFill" size={12} color={th.textTertiary} /> : null}
      {label && thread.status !== "archived" ? (
        <View style={styles.status}>
          <StatusGlyph status={thread.status} size={8} />
          <Txt variant="footnote" color={needsYou ? th.waiting : thread.status === "failed" ? th.failed : th.running} style={{ fontWeight: "600" }}>
            {label}
          </Txt>
        </View>
      ) : null}
      <Icon name="chevronRight" size={13} color={th.textTertiary} weight="semibold" />
    </View>
  );

  if (Platform.OS === "ios") {
    return (
      <Link href={{ pathname: "/thread/[id]", params: { id: thread.id } }} asChild>
        <Link.Trigger>
          <Tap scale={0.99} onPress={() => fireHaptic("light")}>
            {body}
          </Tap>
        </Link.Trigger>
        <Link.Preview />
        <Link.Menu title={project.name}>
          {items.map((it) => (
            <Link.MenuAction key={it.title} title={it.title} icon={it.icon === "unpin" ? "pin.slash" : it.icon === "pin" ? "pin" : "archivebox"} destructive={it.destructive} onPress={it.onPress} />
          ))}
        </Link.Menu>
      </Link>
    );
  }

  return (
    <>
      <Link href={{ pathname: "/thread/[id]", params: { id: thread.id } }} asChild>
        <Tap scale={0.99} onLongPress={() => setSheet(true)} delayLongPress={350}>
          {body}
        </Tap>
      </Link>
      <ActionSheet visible={sheet} onClose={() => setSheet(false)} items={items} title={thread.title || "Untitled"} />
    </>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: GUTTER, paddingTop: space.sm, paddingBottom: 120, gap: space.xl },
  section: { gap: space.sm },
  sectionHeader: { paddingHorizontal: 4, gap: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 64, paddingVertical: 10, marginLeft: space.lg, paddingRight: space.md },
  status: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowBody: { flex: 1, gap: 2 },
  emptyCard: { flexDirection: "row", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
});
