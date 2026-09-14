import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { threadReferencePart } from "../../../packages/kybern-client/src/threadReferences";
import { addContext } from "../src/state/draft";
import type { Thread, ThreadSearchHit } from "../src/state/protocol";
import { PROVIDER_DISPLAY_NAME } from "../src/state/protocol";
import { errorText, rpc, useApp } from "../src/state/runtime";
import {
  Empty,
  ErrorBanner,
  Field,
  Group,
  Icon,
  Page,
  Row,
  T,
  Tap,
  styles,
} from "../src/ui/primitives";
import { useTheme } from "../src/ui/theme";
import { Working } from "../src/ui/Working";

export default function ThreadPicker() {
  const { threadId, projectId } = useLocalSearchParams<{
    threadId?: string;
    projectId?: string;
  }>();
  const app = useApp();
  const { colors } = useTheme();
  const current = app.threads.find((thread) => thread.id === threadId);
  const initialProjectId = projectId ?? current?.project_id ?? "";
  const [scopeProjectId, setScopeProjectId] = useState(initialProjectId);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ThreadSearchHit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const searchGeneration = useRef(0);

  useEffect(() => {
    let alive = true;
    const generation = ++searchGeneration.current;
    setLoadingMore(false);
    const timer = setTimeout(() => {
      setLoading(true);
      setError("");
      void rpc("threads.search", {
        ...(scopeProjectId ? { project_id: scopeProjectId } : {}),
        ...(!scopeProjectId ? { all_projects: true } : {}),
        ...(query.trim() ? { query: query.trim() } : {}),
        include_archived: true,
        limit: 100,
      })
        .then((result) => {
          if (alive && generation === searchGeneration.current)
            setHits(
              result.threads
                .filter((item) => item.thread.id !== threadId),
            );
          if (alive && generation === searchGeneration.current)
            setNextCursor(result.next_cursor ?? null);
        })
        .catch((cause) => {
          if (alive && generation === searchGeneration.current)
            setError(errorText(cause));
        })
        .finally(() => {
          if (alive && generation === searchGeneration.current)
            setLoading(false);
        });
    }, query ? 180 : 0);
    return () => {
      alive = false;
      if (searchGeneration.current === generation) searchGeneration.current++;
      clearTimeout(timer);
    };
  }, [query, scopeProjectId, threadId, app.activeId]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const generation = searchGeneration.current;
    setLoadingMore(true);
    setError("");
    try {
      const result = await rpc("threads.search", {
        ...(scopeProjectId ? { project_id: scopeProjectId } : {}),
        ...(!scopeProjectId ? { all_projects: true } : {}),
        ...(query.trim() ? { query: query.trim() } : {}),
        include_archived: true,
        cursor: nextCursor,
        limit: 100,
      });
      if (generation !== searchGeneration.current) return;
      setHits((current) => [
        ...current,
        ...result.threads.filter(
          (item) =>
            item.thread.id !== threadId &&
            !current.some(
              (existing) => existing.thread.id === item.thread.id,
            ),
        ),
      ]);
      setNextCursor(result.next_cursor ?? null);
    } catch (cause) {
      if (generation === searchGeneration.current) setError(errorText(cause));
    } finally {
      if (generation === searchGeneration.current) setLoadingMore(false);
    }
  }

  const scopeName = scopeProjectId
    ? app.projects.find((project) => project.id === scopeProjectId)?.name ??
      "This project"
    : "All projects";
  const grouped = useMemo(() => {
    const groups = new Map<string, ThreadSearchHit[]>();
    for (const hit of hits) {
      const list = groups.get(hit.thread.project_id);
      if (list) list.push(hit);
      else groups.set(hit.thread.project_id, [hit]);
    }
    return [...groups.entries()];
  }, [hits]);

  function choose(thread: Thread) {
    addContext(threadId ?? "new", threadReferencePart(thread));
    if (threadId)
      router.dismissTo({ pathname: "/thread/[id]", params: { id: threadId } });
    else router.dismissTo("/");
  }

  return (
    <Page>
      <View style={{ gap: 14, marginBottom: 22 }}>
        <Field
          label="Find a conversation"
          placeholder="Title or message text"
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={[styles.line, { gap: 8, flexWrap: "wrap" }]}>
          <T variant="caption" tone="secondary">
            Search in
          </T>
          <Tap
            label={`Search in ${scopeName}`}
            onPress={() =>
              setScopeProjectId(scopeProjectId ? "" : initialProjectId)
            }
            style={[
              styles.line,
              {
                minHeight: 44,
                paddingHorizontal: 13,
                borderRadius: 22,
                backgroundColor: colors.raised,
                gap: 7,
              },
            ]}
          >
            <Icon name={scopeProjectId ? "folder" : "person.2"} size={15} />
            <T variant="caption">{scopeName}</T>
            <Icon
              name="arrow.triangle.swap"
              size={12}
              color={colors.secondary}
            />
          </Tap>
        </View>
        <T variant="caption" tone="secondary">
          The reference adds the conversation’s stable ID to your message. It
          does not start or wake that conversation.
        </T>
      </View>
      <ErrorBanner error={error} />
      {loading ? (
        <Working label="Finding conversations" />
      ) : grouped.length ? (
        grouped.map(([groupProjectId, items]) => (
          <Group
            key={groupProjectId}
            title={
              app.projects.find((project) => project.id === groupProjectId)
                ?.name ?? "Project"
            }
          >
            {items.map(({ thread, snippet, matched_at: matchedAt }) => (
              <Row
                key={thread.id}
                title={thread.title || "Untitled conversation"}
                detail={[
                  PROVIDER_DISPLAY_NAME[thread.provider.kind],
                  thread.status === "archived" ? "Archived" : "",
                  new Date(matchedAt ?? thread.updated_at).toLocaleString(),
                  snippet?.replace(/\s+/g, " ").trim(),
                ]
                  .filter(Boolean)
                  .join(" · ")}
                detailLines={2}
                icon="text.bubble"
                onPress={() => choose(thread)}
              />
            ))}
          </Group>
        ))
      ) : (
        <Empty
          icon="text.bubble"
          title={
            query ? "No matching conversations" : "No other conversations"
          }
          detail={
            scopeProjectId
              ? "Search all projects or start another conversation first."
              : "Try another title or message phrase."
          }
        />
      )}
      {nextCursor && !loading && (
        <View style={{ marginTop: 8 }}>
          <Tap
            label="Load older conversations"
            disabled={loadingMore}
            onPress={() => void loadMore()}
            style={{ minHeight: 48, alignItems: "center" }}
          >
            <T variant="label" tone="accent">
              {loadingMore ? "Loading…" : "Load older conversations"}
            </T>
          </Tap>
        </View>
      )}
    </Page>
  );
}
