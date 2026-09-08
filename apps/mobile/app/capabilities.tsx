import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { capabilityPart, commandText } from "../src/state/capabilities";
import { addContext, useDraft } from "../src/state/draft";
import type { SkillInfo } from "../src/state/protocol";
import { errorText, rpc, useApp, useThread } from "../src/state/runtime";
import {
  Empty,
  ErrorBanner,
  Field,
  Page,
  Row,
  T,
  Tap,
} from "../src/ui/primitives";
import { useTheme } from "../src/ui/theme";
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
  const [tab, setTab] = useState(category ?? "Skills");
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
  return (
    <Page>
      <Field
        label="Search"
        placeholder={
          tab === "Commands" ? "Find a command" : `Find ${tab.toLowerCase()}`
        }
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          marginVertical: 18,
        }}
      >
        {["Skills", "Plugins", "Commands"].map((name) => (
          <Tap
            key={name}
            label={name}
            selected={tab === name}
            onPress={() => {
              setTab(name);
              setQuery("");
            }}
            style={{
              paddingHorizontal: 14,
              borderRadius: 22,
              backgroundColor: tab === name ? colors.ink : colors.raised,
            }}
          >
            <T variant="caption" tone={tab === name ? "inverse" : "ink"}>
              {name}
            </T>
          </Tap>
        ))}
      </View>
      <ErrorBanner error={error} />
      <T variant="caption" tone="secondary" style={{ marginBottom: 12 }}>
        {tab === "Commands"
          ? "Choose a command to add it to your message before sending."
          : "Choose an installed capability to include with your next message."}
      </T>
      {tab === "Commands"
        ? commands.map((c) => (
            <Row
              key={c.name}
              title={commandText(c.name).trim()}
              detail={c.description}
              detailLines={2}
              icon="command"
              onPress={() => {
                addContext(threadId ?? "new", {
                  type: "text",
                  text: commandText(c.name),
                });
                router.back();
              }}
            />
          ))
        : items.map((s) => (
            <Row
              key={`${s.scope}:${s.path}`}
              title={s.display_name || s.name}
              detail={s.description || s.scope}
              detailLines={2}
              icon={tab === "Plugins" ? "puzzlepiece.extension" : "sparkles"}
              onPress={() => {
                addContext(threadId ?? "new", capabilityPart(s));
                router.back();
              }}
            />
          ))}
      {(tab === "Commands" ? !commands.length : !items.length && !loading) && (
        <Empty
          icon={tab === "Commands" ? "command" : "sparkles"}
          title={query ? "No matches" : `No ${tab.toLowerCase()} available`}
          detail={
            query
              ? "Try another name or description."
              : tab === "Commands"
                ? "Commands appear after this agent starts a session, when supported by the harness."
                : `Install ${tab.toLowerCase()} for this agent on your computer to use them here.`
          }
        />
      )}
      {loading && tab !== "Commands" && (
        <T tone="secondary">Loading capabilities…</T>
      )}
    </Page>
  );
}
