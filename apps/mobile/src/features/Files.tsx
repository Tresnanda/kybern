import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import Animated, {
  LinearTransition,
  ReduceMotion,
} from "react-native-reanimated";
import type { FileEntry, Project } from "../state/protocol";
import { errorText, rpc } from "../state/runtime";
import { Empty, ErrorBanner, Field } from "../ui/primitives";
import { Working } from "../ui/Working";
import { FileTreeRow, flattenItems } from "../components/beui/FileTree";

export function Files({
  project,
  threadId,
}: {
  project: Project;
  threadId?: string;
}) {
  const [folders, setFolders] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
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
      contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
      data={rows}
      keyExtractor={(r) => r.item.path}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={{ gap: 12, paddingBottom: 14 }}>
          <Field
            label="Find a file"
            placeholder="Search by filename"
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <ErrorBanner error={error} onRetry={() => void load("")} />
        </View>
      }
      ListEmptyComponent={
        loading.has("") ? (
          <Working label="Loading files" />
        ) : (
          <Empty
            detail={
              query ? "Try another filename." : "No files in this folder yet."
            }
            title={query ? "No matching files" : "This folder is empty"}
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
