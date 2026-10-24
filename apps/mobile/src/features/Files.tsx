import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { View, useWindowDimensions } from "react-native";
import Animated, {
  LinearTransition,
  ReduceMotion,
} from "react-native-reanimated";
import type { FileEntry, Project } from "../state/protocol";
import { errorText, rpc } from "../state/runtime";
import { Empty, ErrorBanner, T } from "../ui/primitives";
import { SearchField } from "../ui/Search";
import { gutter, space } from "../ui/theme";
import { Working } from "../ui/Working";
import { FileTreeRow, flattenItems } from "../components/beui/FileTree";

export function Files({
  project,
  threadId,
  reveal,
}: {
  project: Project;
  threadId?: string;
  reveal?: string;
}) {
  const [folders, setFolders] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const { width } = useWindowDimensions();
  async function load(path: string) {
    setLoading((s) => new Set(s).add(path));
    setError("");
    try {
      const result = await rpc("files.list", { project_id: project.id, path });
      setFolders((s) => ({ ...s, [path]: result.entries }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading((s) => {
        const n = new Set(s);
        n.delete(path);
        return n;
      });
    }
  }
  useEffect(() => {
    void load("");
    if (reveal) {
      setExpanded(new Set([reveal]));
      setSelected(reveal);
      void load(reveal);
    }
  }, [project.id]);
  useEffect(() => {
    let alive = true;
    if (!query.trim()) return;
    const timer = setTimeout(() => {
      void rpc("files.search", {
        project_id: project.id,
        query: query.trim(),
        limit: 100,
      })
        .then((r) => {
          if (alive)
            setMatches(
              r.files.map((path) => ({ path, name: path, kind: "file" })),
            );
        })
        .catch((e) => {
          if (alive) setError(errorText(e));
        });
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, project.id]);
  const rows = useMemo(
    () =>
      flattenItems(
        query.trim() ? matches : (folders[""] ?? []),
        expanded,
        folders,
      ),
    [query, matches, folders, expanded],
  );
  return (
    <Animated.FlatList
      itemLayoutAnimation={LinearTransition.springify()
        .duration(250)
        .dampingRatio(1)
        .reduceMotion(ReduceMotion.System)}
      style={{ flex: 1 }}
      contentContainerStyle={{ flexGrow: 1, paddingHorizontal: gutter(width) - space.md, paddingBottom: space["2xl"] }}
      keyboardDismissMode="on-drag"
      data={rows}
      keyExtractor={(r) => r.item.path}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={{ gap: space.sm, paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.md }}>
          <SearchField placeholder="Find a file" value={query} onChangeText={setQuery} />
          <T variant="code" tone="muted" numberOfLines={1} ellipsizeMode="middle">
            {query.trim() ? `Matches in ${project.name}` : project.name}
          </T>
          <ErrorBanner error={error} onRetry={() => void load("")} />
        </View>
      }
      ListEmptyComponent={
        loading.has("") ? (
          <Working label="Loading files" />
        ) : (
          <Empty
            icon={query ? "magnifyingglass" : "folder"}
            title={query ? `No files match “${query.trim()}”` : "This folder is empty"}
            detail={query ? "Try part of the file name." : undefined}
          />
        )
      }
      renderItem={({ item: row }) => (
        <FileTreeRow
          row={row}
          expanded={expanded.has(row.item.path)}
          selected={selected === row.item.path}
          loading={loading.has(row.item.path)}
          onPress={() => {
            const entry = row.item;
            setSelected(entry.path);
            if (entry.kind === "directory") {
              setExpanded((s) => {
                const n = new Set(s);
                n.has(entry.path) ? n.delete(entry.path) : n.add(entry.path);
                return n;
              });
              if (!folders[entry.path] && !loading.has(entry.path))
                void load(entry.path);
            } else
              router.push({
                pathname: "/file",
                params: {
                  projectId: project.id,
                  path: entry.path,
                  ...(threadId ? { threadId } : {}),
                },
              });
          }}
        />
      )}
    />
  );
}
