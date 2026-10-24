import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { capabilityPart, commandText } from "../src/state/capabilities";
import { addContext, useDraft } from "../src/state/draft";
import type { SkillInfo } from "../src/state/protocol";
import { errorText, rpc, useApp, useThread } from "../src/state/runtime";
import { Button, Empty, ErrorBanner, T } from "../src/ui/primitives";
import { InsetGroup, ListRow } from "../src/ui/List";
import { SearchField } from "../src/ui/Search";
import { Segmented } from "../src/ui/Segmented";
import { space, useTheme } from "../src/ui/theme";
export default function Capabilities() {
  const { threadId, category } = useLocalSearchParams<{
    threadId?: string;
    category?: string;
  }>();
  const app = useApp();
  const draft = useDraft();
  const snapshot = useThread(threadId ?? "");
  const thread = app.threads.find((t) => t.id === threadId) ?? snapshot.thread;
  const { colors } = useTheme();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"Skills" | "Plugins" | "Commands">(
    category === "Plugins" || category === "Commands" ? category : "Skills",
  );
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const projectId = thread?.project_id ?? draft.projectId;
  const provider = thread?.provider.kind ?? draft.provider;
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setSkills([]);
    setError("");
    if (!projectId) {
      setLoading(false);
      return;
    }
    void rpc("skills.list", { project_id: projectId, provider })
      .then((r) => {
        if (alive) setSkills(r.skills.filter((s) => s.enabled));
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId, provider]);
  const match = (text: string) =>
    text.toLowerCase().includes(query.toLowerCase().replace(/^[$@/]/, ""));
  const items = skills.filter(
    (s) =>
      (tab === "Plugins" ? s.scope === "plugin" : s.scope !== "plugin") &&
      match(`${s.name} ${s.display_name ?? ""} ${s.description}`),
  );
  const commands = (snapshot.providerCommands ?? []).filter((c) =>
    match(`${c.name} ${c.description}`),
  );
  const empty = tab === "Commands" ? !commands.length : !items.length && !loading;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1, backgroundColor: colors.grouped }}
      contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space["3xl"], gap: space.md }}
    >
      <Stack.Screen options={{ headerStyle: { backgroundColor: colors.grouped } }} />
      <Segmented
        label="Show"
        value={tab}
        onChange={(next) => {
          setTab(next);
          setQuery("");
        }}
        options={[
          { value: "Skills", label: "Skills" },
          { value: "Plugins", label: "Plugins" },
          { value: "Commands", label: "Commands" },
        ]}
      />
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder={tab === "Commands" ? "Search commands" : `Search ${tab.toLowerCase()}`}
        fill={colors.surface}
      />
      <ErrorBanner error={error} />
      {!empty && (
        <InsetGroup>
          {tab === "Commands"
            ? commands.map((c) => (
                <ListRow
                  key={c.name}
                  title={commandText(c.name).trim()}
                  mono
                  subtitle={c.description}
                  leading="command"
                  onPress={() => {
                    addContext(threadId ?? "new", { type: "text", text: commandText(c.name) });
                    router.back();
                  }}
                />
              ))
            : items.map((s) => (
                <ListRow
                  key={`${s.scope}:${s.path}`}
                  title={s.display_name || s.name}
                  subtitle={s.description || s.scope}
                  leading={tab === "Plugins" ? "puzzlepiece.extension" : "sparkles"}
                  onPress={() => {
                    addContext(threadId ?? "new", capabilityPart(s));
                    router.back();
                  }}
                />
              ))}
        </InsetGroup>
      )}
      {loading && tab !== "Commands" && <T variant="footnote" tone="secondary">Loading…</T>}
      {empty && (
        <Empty
          icon={tab === "Commands" ? "command" : "sparkles"}
          title={query ? `No ${tab.toLowerCase()} match “${query}”` : `No ${tab.toLowerCase()} yet`}
          detail={
            query
              ? undefined
              : tab === "Commands"
                ? "Commands appear once this agent starts a session, when its harness supports them."
                : `Install ${tab.toLowerCase()} for this agent on your computer to use them here.`
          }
          action={query ? <Button role="plain" onPress={() => setQuery("")}>Clear search</Button> : undefined}
        />
      )}
      <InsetGroup>
        <ListRow
          title="Manage connectors and plugins"
          leading="puzzlepiece.extension"
          chevron
          onPress={() => router.push({ pathname: "/integrations", params: { threadId, projectId, provider } })}
        />
      </InsetGroup>
    </ScrollView>
  );
}
