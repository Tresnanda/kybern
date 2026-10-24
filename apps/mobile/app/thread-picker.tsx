import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";
import { threadReferencePart } from "../../../packages/kybern-client/src/threadReferences";
import { addContext } from "../src/state/draft";
import type { Thread, ThreadSearchHit } from "../src/state/protocol";
import {
  isFreeChatProject,
  PROVIDER_DISPLAY_NAME,
} from "../src/state/protocol";
import { errorText, rpc, useApp } from "../src/state/runtime";
import { relativeTime } from "../src/state/threadList";
import { InsetGroup, ListRow, SectionFooter, SectionHeader } from "../src/ui/List";
import { Button, Empty, ErrorBanner } from "../src/ui/primitives";
import { ProviderMark } from "../src/ui/ProviderMark";
import { SearchField } from "../src/ui/Search";
import { Segmented } from "../src/ui/Segmented";
import { gutter, space, useTheme } from "../src/ui/theme";
import { Working } from "../src/ui/Working";

export default function ThreadPicker() {
  const { threadId, projectId } = useLocalSearchParams<{
    threadId?: string;
    projectId?: string;
  }>();
  const app = useApp();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
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

  const scopeName = initialProjectId
    ? isFreeChatProject(initialProjectId)
      ? "Free chat"
      : app.projects.find((project) => project.id === initialProjectId)?.name ?? "This project"
    : "This project";
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
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.grouped }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{ padding: gutter(width), paddingBottom: space["2xl"], flexGrow: 1 }}
    >
      <View style={{ gap: space.md }}>
        <SearchField value={query} onChangeText={setQuery} placeholder="Title or message text" />
        {initialProjectId ? (
          <Segmented
            compact
            label="Search in"
            options={[
              { value: "project", label: scopeName },
              { value: "all", label: "All projects" },
            ]}
            value={scopeProjectId ? "project" : "all"}
            onChange={(value) => setScopeProjectId(value === "project" ? initialProjectId : "")}
          />
        ) : null}
        <SectionFooter>
          {"The reference adds the conversation’s stable ID to your message. It doesn’t start or wake that conversation."}
        </SectionFooter>
      </View>
      <ErrorBanner error={error} />
      {loading ? (
        <View style={{ paddingTop: space.xl }}>
          <Working label="Finding conversations" />
        </View>
      ) : grouped.length ? (
        grouped.map(([groupProjectId, items]) => (
          <View key={groupProjectId}>
            <SectionHeader
              inset
              title={
                isFreeChatProject(groupProjectId)
                  ? "Free chat"
                  : app.projects.find((project) => project.id === groupProjectId)?.name ?? "Project"
              }
            />
            <InsetGroup>
              {items.map(({ thread, snippet, matched_at: matchedAt }) => (
                <ListRow
                  key={thread.id}
                  title={thread.title || "Untitled conversation"}
                  subtitle={[
                    PROVIDER_DISPLAY_NAME[thread.provider.kind],
                    thread.status === "archived" ? "Archived" : "",
                    snippet?.replace(/\s+/g, " ").trim(),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  subtitleLines={2}
                  meta={relativeTime(matchedAt ?? thread.updated_at)}
                  leading={<ProviderMark kind={thread.provider.kind} size={20} />}
                  onPress={() => choose(thread)}
                />
              ))}
            </InsetGroup>
          </View>
        ))
      ) : (
        <Empty
          icon="text.bubble"
          title={query.trim() ? `No conversations match “${query.trim()}”` : "No other conversations"}
          detail={scopeProjectId ? "Search all projects or start another conversation first." : "Try another title or message phrase."}
        />
      )}
      {nextCursor && !loading ? (
        <View style={{ paddingTop: space.lg, alignItems: "center" }}>
          <Button role="plain" size="medium" busy={loadingMore} onPress={() => void loadMore()}>
            Load older conversations
          </Button>
        </View>
      ) : null}
    </ScrollView>
  );
}
