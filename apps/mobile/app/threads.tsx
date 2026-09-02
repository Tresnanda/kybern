import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { Link, Stack, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnection } from "@/connection/ConnectionContext";
import type { Project, Thread } from "@/protocol";
import { Button } from "@/ui/Button";
import { Caption, EmptyState, Screen } from "@/ui/Screen";
import { StatusDot, statusLabel } from "@/ui/StatusDot";
import { space, type as t, useTheme } from "@/ui/theme";

type Section = { project: Project; data: Thread[] };

export default function ThreadsScreen() {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { client, status, statusDetail, disconnect } = useConnection();
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<Map<string, Thread>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setError(null);
    try {
      const [p, tl] = await Promise.all([client.call("projects.list", {}), client.call("threads.list", {})]);
      setProjects(p.projects);
      setThreads(new Map(tl.threads.map((x) => [x.id, x])));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (!client) return;
    if (client.status === "open") void load();
    const off = client.onStatus((s) => {
      if (s === "open") void load();
    });
    // Live only: thread rows change on thread_created / thread_updated / archived.
    const sub = client.subscribeEvents(
      {},
      (ev) => {
        if (ev.kind === "thread_created" || ev.kind === "thread_updated") {
          setThreads((m) => new Map(m).set(ev.thread.id, ev.thread));
        } else if (ev.kind === "thread_archived") {
          setThreads((m) => {
            const next = new Map(m);
            next.delete(ev.thread_id);
            return next;
          });
        }
      },
      () => void load(),
    );
    return () => {
      off();
      sub.unsubscribe();
    };
  }, [client, load]);

  const sections = useMemo<Section[]>(() => {
    const byProject = new Map<string, Thread[]>();
    for (const thr of threads.values()) {
      if (thr.status === "archived") continue;
      const list = byProject.get(thr.project_id) ?? [];
      list.push(thr);
      byProject.set(thr.project_id, list);
    }
    const rank = (x: Thread) => (x.pinned ? 0 : 1);
    return projects
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((project) => ({
        project,
        data: (byProject.get(project.id) ?? []).sort((a, b) => rank(a) - rank(b) || b.updated_at.localeCompare(a.updated_at)),
      }));
  }, [projects, threads]);

  if (!client) {
    return (
      <Screen>
        <EmptyState title="Not connected" action={<Button title="Connect" variant="primary" onPress={() => router.replace("/connect")} />} />
      </Screen>
    );
  }

  const banner = status !== "open" ? connectionBanner(status, statusDetail) : null;

  return (
    <Screen>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              onPress={() => void disconnect().then(() => router.replace("/connect"))}
              hitSlop={8}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Text style={[t.body, { color: th.textSecondary }]}>Disconnect</Text>
            </Pressable>
          ),
        }}
      />
      {banner ? (
        <View style={[styles.banner, { backgroundColor: th.surface }]}>
          <Caption>{banner}</Caption>
        </View>
      ) : null}
      {error ? (
        <View style={[styles.banner, { backgroundColor: th.surface }]}>
          <Caption color={th.failed}>{error}</Caption>
        </View>
      ) : null}
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + space.xl }]}
        stickySectionHeadersEnabled={false}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={th.textSecondary} />}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitle}>
              <Text style={[t.heading, { color: th.text }]} numberOfLines={1}>
                {section.project.name}
              </Text>
              <Caption color={th.textTertiary}>{section.project.path}</Caption>
            </View>
            <Link href={{ pathname: "/thread/new", params: { project: section.project.id } }} asChild>
              <Pressable accessibilityRole="button" hitSlop={8} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
                <Text style={[t.body, { color: th.textSecondary }]}>New thread</Text>
              </Pressable>
            </Link>
          </View>
        )}
        renderSectionFooter={({ section }) =>
          section.data.length === 0 ? <Caption style={styles.sectionEmpty} color={th.textTertiary}>No threads yet</Caption> : null
        }
        renderItem={({ item }) => <ThreadRow thread={item} />}
        ListEmptyComponent={
          loading ? null : (
            <EmptyState
              title="No projects"
              hint="Add one on the machine running the daemon: kybern new -p . 'explain this repo' creates the project and its first thread."
            />
          )
        }
      />
    </Screen>
  );
}

function ThreadRow({ thread }: { thread: Thread }) {
  const th = useTheme();
  const label = statusLabel(thread.status);
  return (
    <Link href={{ pathname: "/thread/[id]", params: { id: thread.id } }} asChild>
      <Pressable
        accessibilityRole="button"
        style={({ pressed }) => [styles.row, { backgroundColor: pressed ? th.surface : "transparent" }]}
      >
        <StatusDot status={thread.status} />
        <View style={styles.rowBody}>
          <Text style={[t.sidebar, { color: th.text }]} numberOfLines={1}>
            {thread.title || "Untitled"}
          </Text>
          <Caption color={th.textTertiary}>
            {[thread.pinned ? "Pinned" : null, label, thread.worktree?.branch ?? null].filter(Boolean).join(" · ") || " "}
          </Caption>
        </View>
      </Pressable>
    </Link>
  );
}

function connectionBanner(status: string, detail?: string): string {
  switch (status) {
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return detail ? `Reconnecting… (${detail})` : "Reconnecting…";
    case "closed":
      return "Disconnected";
    default:
      return "";
  }
}

const styles = StyleSheet.create({
  list: { paddingVertical: space.sm },
  banner: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.sm,
  },
  sectionTitle: { flex: 1, gap: 2 },
  sectionEmpty: { paddingHorizontal: space.lg + 8 + space.md, paddingVertical: space.sm },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  rowBody: { flex: 1, gap: 2 },
});
