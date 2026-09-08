import { threadHasActivity } from "../src/state/runtime";
import * as Haptics from "expo-haptics";
import { router, Stack } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, FlatList, RefreshControl, TextInput, View } from "react-native";
import { type Thread, PROVIDER_DISPLAY_NAME } from "../src/state/protocol";
import { errorText, refresh, rpc, useApp } from "../src/state/runtime";
import {
  Empty,
  ErrorBanner,
  Icon,
  IconButton,
  Row,
  styles,
  T,
  Tap,
} from "../src/ui/primitives";
import { ProviderMark } from "../src/ui/ProviderMark";
import { type, useTheme } from "../src/ui/theme";

function relativeTime(at: string) {
  const minutes = Math.max(0, (Date.now() - Date.parse(at)) / 60000);
  return minutes < 1
    ? "Now"
    : minutes < 60
      ? `${Math.floor(minutes)}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`;
}
export default function Library() {
  const app = useApp();
  const { colors } = useTheme();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const rows = useMemo(
    () =>
      app.threads
        .filter(
          (t) =>
            (filter === "Archived"
              ? t.status === "archived"
              : t.status !== "archived") &&
            (filter !== "Working" || threadHasActivity(t, app.activity)) &&
            (filter !== "Pinned" || t.pinned) &&
            `${t.title} ${app.projects.find((p) => p.id === t.project_id)?.name}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort(
          (a, b) =>
            Number(b.pinned) - Number(a.pinned) ||
            b.updated_at.localeCompare(a.updated_at),
        ),
    [app.threads, app.projects, app.activity, query, filter],
  );
  async function reload() {
    setRefreshing(true);
    try {
      await refresh();
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRefreshing(false);
    }
  }
  function options(t: Thread) {
    Alert.alert(t.title || "Thread", undefined, [
      {
        text: t.pinned ? "Unpin thread" : "Pin thread",
        onPress: () => {
          void rpc("threads.update", { thread_id: t.id, pinned: !t.pinned })
            .then(refresh)
            .catch((e) => setError(errorText(e)));
        },
      },
      ...(t.status !== "archived"
        ? [
            {
              text: "Archive thread",
              onPress: () => {
                void rpc("threads.archive", { thread_id: t.id })
                  .then(refresh)
                  .catch((e) => setError(errorText(e)));
              },
            },
          ]
        : []),
      { text: "Cancel", style: "cancel" },
    ]);
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <IconButton
              name="square.and.pencil"
              label="Start a thread"
              onPress={() => router.dismissTo("/")}
            />
          ),
        }}
      />
      <FlatList
        data={rows}
        keyExtractor={(t) => t.id}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 24,
          paddingBottom: 40,
          maxWidth: 760,
          width: "100%",
          alignSelf: "center",
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void reload()}
            tintColor={colors.ink}
          />
        }
        ListHeaderComponent={
          <>
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
                accessibilityLabel="Search threads"
                placeholder="Search your threads"
                value={query}
                onChangeText={setQuery}
                placeholderTextColor={colors.muted}
                style={[
                  type.body,
                  { color: colors.ink, flex: 1, minHeight: 48 },
                ]}
              />
            </View>
            <View
              style={{
                flexDirection: "row",
                gap: 7,
                marginBottom: 18,
                flexWrap: "wrap",
              }}
            >
              {["All", "Working", "Pinned", "Archived"].map((f) => (
                <Tap
                  key={f}
                  label={f}
                  selected={f === filter}
                  onPress={() => {
                    setFilter(f);
                    void Haptics.selectionAsync();
                  }}
                  style={{
                    backgroundColor: filter === f ? colors.ink : undefined,
                    paddingHorizontal: 14,
                    borderRadius: 22,
                  }}
                >
                  <T
                    variant="caption"
                    tone={filter === f ? "inverse" : "secondary"}
                  >
                    {f}
                  </T>
                </Tap>
              ))}
            </View>
            <ErrorBanner error={error} />
          </>
        }
        renderItem={({ item, index }) => {
          const project = app.projects.find((p) => p.id === item.project_id);
          const running = threadHasActivity(item, app.activity);
          return (
            <Tap
              label={`${item.title || "Untitled thread"}, ${running ? "Working" : item.status}`}
              onPress={() =>
                router.push({
                  pathname: "/thread/[id]",
                  params: { id: item.id },
                })
              }
              onLongPress={() => options(item)}
              style={{
                paddingVertical: 18,
                borderTopWidth: index ? 0.5 : 0,
                borderColor: colors.line,
                gap: 8,
              }}
            >
              <View style={styles.spread}>
                <T
                  variant="body"
                  style={{ flex: 1, fontWeight: "500" }}
                  numberOfLines={2}
                >
                  {item.title || "Untitled thread"}
                </T>
                {item.pinned ? (
                  <Icon name="pin.fill" size={12} color={colors.secondary} />
                ) : (
                  <T variant="caption" tone="muted">
                    {relativeTime(item.updated_at)}
                  </T>
                )}
              </View>
              <View style={styles.spread}>
                <ProviderMark kind={item.provider.kind} size={16} />
                <T variant="caption" tone="secondary" style={{ flex: 1 }}>
                  {project?.name ?? "Project"} ·{" "}
                  {PROVIDER_DISPLAY_NAME[item.provider.kind]}
                </T>
                <T
                  variant="caption"
                  tone={
                    running
                      ? "accent"
                      : item.status === "failed"
                        ? "negative"
                        : "muted"
                  }
                >
                  {running
                    ? "◌ Working"
                    : item.status === "failed"
                      ? "Failed"
                      : ""}
                </T>
              </View>
            </Tap>
          );
        }}
        ListEmptyComponent={
          <Empty
            title={
              query
                ? "No matching threads"
                : filter === "All"
                  ? "A fresh page."
                  : `No ${filter.toLowerCase()} threads`
            }
            detail={
              query
                ? `Nothing matches “${query}”. Try another search.`
                : "Start a conversation and your work will appear here."
            }
          />
        }
        ListFooterComponent={
          <View
            style={{
              paddingTop: 24,
              marginTop: 20,
              borderTopWidth: 0.5,
              borderColor: colors.line,
            }}
          >
            <Row
              title="Projects"
              icon="folder"
              onPress={() => router.push("/projects")}
            />
            <Row
              title="Activity"
              icon="waveform.path"
              detail={
                app.approvals.length
                  ? `${app.approvals.length} waiting for you`
                  : undefined
              }
              onPress={() => router.push("/activity")}
            />
            <Row
              title="Resume a session"
              icon="clock.arrow.circlepath"
              onPress={() => router.push("/sessions")}
            />
            <Row
              title="Settings"
              icon="gearshape"
              onPress={() => router.push("/settings")}
            />
          </View>
        }
      />
    </View>
  );
}
