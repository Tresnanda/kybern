import { Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, View } from "react-native";
import type {
  Integration,
  IntegrationAction,
  IntegrationsCatalog,
  ProviderKind,
} from "../src/state/protocol";
import { useTheme } from "../src/ui/theme";
import { errorText, rpc, useApp, useThread } from "../src/state/runtime";
import {
  Button,
  ErrorBanner,
  Field,
  Icon,
  IconButton,
  Tap,
  Page,
  T,
} from "../src/ui/primitives";

import { ProviderMark } from "../src/ui/ProviderMark";

const labels: Record<IntegrationAction, string> = {
  install: "Install",
  uninstall: "Uninstall",
  enable: "Enable",
  disable: "Disable",
  update: "Update",
};
export default function Integrations() {
  const params = useLocalSearchParams<{
    threadId?: string;
    projectId?: string;
    provider?: string;
  }>();
  const app = useApp();
  const { colors, dark } = useTheme();
  const snapshot = useThread(params.threadId ?? "");
  const thread =
    app.threads.find((t) => t.id === params.threadId) ?? snapshot.thread;
  const projectId =
    params.projectId ?? thread?.project_id ?? app.projects[0]?.id;
  const [provider, setProvider] = useState<ProviderKind>(
    (params.provider ?? thread?.provider.kind) === "codex"
      ? "codex"
      : "claude-code",
  );
  const [category, setCategory] = useState<"plugin" | "connector">("plugin");
  const [catalog, setCatalog] = useState<IntegrationsCatalog>({
    items: [],
    warnings: [],
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [warningsOpen, setWarningsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(40);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!projectId || app.status !== "open") return;
    let alive = true;
    setLoading(true);
    setError("");
    setCatalog({ items: [], warnings: [] });
    void rpc("integrations.list", { project_id: projectId, provider })
      .then((value) => {
        if (alive) setCatalog(value);
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
  }, [projectId, provider, refresh, app.status, app.activeId]);
  async function change(item: Integration, action: IntegrationAction) {
    if (!projectId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await rpc("integrations.change", {
        project_id: projectId,
        provider,
        id: item.id,
        kind: item.kind,
        scope: item.scope,
        action,
      });
      setNotice(result.message);
      if (result.connections.length) {
        setCategory("connector");
        setCatalog((c) => ({
          ...c,
          items: [
            ...result.connections,
            ...c.items.filter(
              (i) => !result.connections.some((a) => a.id === i.id),
            ),
          ],
        }));
      } else setRefresh((n) => n + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function login(item: Integration) {
    if (!thread) return;
    setBusy(true);
    setError("");
    try {
      const terminal = await rpc("integrations.login", {
        thread_id: thread.id,
        name: item.id,
      });
      router.push({
        pathname: "/workspace",
        params: {
          threadId: thread.id,
          tab: "Terminal",
          terminalId: terminal.id,
          login: "1",
        },
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const open = (url: string) =>
    void Linking.openURL(url).catch((e) => setError(errorText(e)));
  const items = catalog.items.filter(
    (i) =>
      i.kind === category &&
      `${i.name} ${i.description ?? ""} ${i.id}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <Page>
      <Stack.Screen options={{ title: "Integrations" }} />
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <View style={{ flex: 1, gap: 4 }}>
          <T variant="title">Connect your tools</T>
          <T variant="caption" tone="secondary">
            {app.projects.find((p) => p.id === projectId)?.name ??
              "Choose a project in your conversation"}
          </T>
        </View>
        <IconButton
          name="arrow.clockwise"
          label="Refresh integrations"
          disabled={loading || busy || !projectId || app.status !== "open"}
          onPress={() => setRefresh((n) => n + 1)}
        />
      </View>
      <View
        style={{
          flexDirection: "row",
          backgroundColor: dark ? colors.surface : colors.raised,
          borderRadius: 18,
          padding: 4,
          marginBottom: 20,
        }}
      >
        {(["claude-code", "codex"] as const).map((kind) => (
          <Tap
            key={kind}
            label={kind === "codex" ? "Codex" : "Claude Code"}
            selected={provider === kind}
            static
            disabled={busy}
            style={{
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              borderRadius: 14,
              paddingHorizontal: 10,
              backgroundColor:
                provider === kind
                  ? dark
                    ? colors.raised
                    : colors.surface
                  : undefined,
            }}
            onPress={() => {
              setProvider(kind);
              setNotice("");
              setExpanded(null);
            }}
          >
            <ProviderMark kind={kind} size={18} />
            <T variant="label" tone={provider === kind ? "ink" : "secondary"}>
              {kind === "codex" ? "Codex" : "Claude Code"}
            </T>
          </Tap>
        ))}
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: colors.raised,
          borderRadius: 16,
          paddingStart: 14,
          marginBottom: 16,
        }}
      >
        <Icon name="magnifyingglass" size={19} color={colors.muted} />
        <View style={{ flex: 1 }}>
          <Field
            label="Find integrations"
            hideLabel
            placeholder="Search integrations"
            value={query}
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              borderWidth: 0,
              backgroundColor: "transparent",
              padding: 12,
            }}
            onChangeText={(value) => {
              setQuery(value);
              setCount(40);
            }}
          />
        </View>
        {!!query && (
          <IconButton
            name="xmark"
            label="Clear search"
            onPress={() => setQuery("")}
          />
        )}
      </View>
      <View style={{ flexDirection: "row", gap: 24, marginBottom: 16 }}>
        {(["plugin", "connector"] as const).map((kind) => (
          <Tap
            key={kind}
            label={kind === "plugin" ? "Plugins" : "Connectors"}
            selected={category === kind}
            static
            style={{
              borderBottomWidth: 2,
              borderBottomColor: category === kind ? colors.ink : "transparent",
              paddingHorizontal: 2,
            }}
            onPress={() => {
              setCategory(kind);
              setCount(40);
              setExpanded(null);
            }}
          >
            <T variant="label" tone={category === kind ? "ink" : "secondary"}>
              {kind === "plugin" ? "Plugins" : "Connectors"}
            </T>
          </Tap>
        ))}
      </View>
      <ErrorBanner error={error} />
      {!!notice && (
        <T variant="caption" tone="secondary" style={{ marginBottom: 16 }}>
          {notice}
        </T>
      )}
      {provider === "claude-code" && category === "connector" && (
        <Tap
          label="Add a Claude connector"
          onPress={() => open("https://claude.ai/settings/connectors")}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            marginBottom: 12,
          }}
        >
          <Icon name="plus" size={18} />
          <T variant="label">Add connector</T>
        </Tap>
      )}
      {loading || !items.length ? (
        <View style={{ paddingVertical: 32, gap: 8 }}>
          <T variant="heading">
            {loading
              ? "Loading integrations…"
              : query
                ? "No matches"
                : "No integrations yet"}
          </T>
          {!loading && (
            <T tone="secondary">
              {!projectId
                ? "Open a project conversation to manage its integrations."
                : app.status !== "open"
                  ? "Connect your computer to load integrations."
                  : query
                    ? "Try another name or keyword."
                    : "Add one in your provider, then refresh here."}
            </T>
          )}
        </View>
      ) : (
        items.slice(0, count).map((item) => {
          const key = `${item.kind}:${item.id}:${item.scope}`;
          const isExpanded = expanded === key;
          const rawName = item.name.split("@")[0];
          const displayName = item.name.includes("@")
            ? rawName.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())
            : item.name;
          return (
            <View
              key={key}
              style={{
                marginBottom: 8,
                borderRadius: 20,
                backgroundColor: isExpanded
                  ? dark
                    ? colors.surface
                    : colors.raised
                  : undefined,
              }}
            >
              <Tap
                label={`${item.name}, ${item.status}`}
                expanded={isExpanded}
                static
                onPress={() => setExpanded(isExpanded ? null : key)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 14,
                  paddingVertical: 14,
                  paddingHorizontal: 12,
                }}
              >
                <View
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 14,
                    backgroundColor: colors.raised,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon
                    name={
                      item.kind === "plugin" ? "puzzlepiece.extension" : "link"
                    }
                    size={21}
                  />
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <T variant="label">{displayName}</T>
                  {!!item.description && (
                    <T
                      variant="caption"
                      tone="secondary"
                      numberOfLines={isExpanded ? undefined : 2}
                    >
                      {item.description}
                    </T>
                  )}
                  <T variant="caption" tone="secondary">
                    {item.status}
                    {item.scope ? ` · ${item.scope}` : ""}
                  </T>
                </View>
                <Icon
                  name={isExpanded ? "chevron.up" : "chevron.down"}
                  size={13}
                  color={colors.muted}
                />
              </Tap>
              {isExpanded && (
                <View
                  style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 12 }}
                >
                  {item.name.includes("@") && (
                    <T variant="caption" tone="secondary">
                      {item.name.split("@").slice(1).join("@")}
                    </T>
                  )}
                  <View
                    style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
                  >
                    {item.actions.map((action) => (
                      <Tap
                        key={action}
                        label={`${labels[action]} ${item.name}`}
                        disabled={busy || app.status !== "open"}
                        onPress={() => void change(item, action)}
                        style={{
                          paddingHorizontal: 16,
                          borderRadius: 14,
                          backgroundColor: colors.raised,
                        }}
                      >
                        <T
                          variant="label"
                          tone={action === "uninstall" ? "negative" : "ink"}
                        >
                          {labels[action]}
                        </T>
                      </Tap>
                    ))}
                    {item.connect_url && (
                      <Tap
                        label={item.installed ? "Manage connection" : "Connect"}
                        onPress={() => open(item.connect_url!)}
                        style={{
                          paddingHorizontal: 16,
                          borderRadius: 14,
                          backgroundColor: colors.raised,
                        }}
                      >
                        <T variant="label">
                          {item.installed ? "Manage connection" : "Connect"}
                        </T>
                      </Tap>
                    )}
                    {item.can_login && (
                      <Tap
                        label="Sign in"
                        disabled={
                          busy ||
                          app.status !== "open" ||
                          thread?.provider.kind !== provider ||
                          thread?.project_id !== projectId
                        }
                        onPress={() => void login(item)}
                        style={{
                          paddingHorizontal: 16,
                          borderRadius: 14,
                          backgroundColor: colors.raised,
                        }}
                      >
                        <T variant="label">Sign in</T>
                      </Tap>
                    )}
                  </View>
                  {item.can_login &&
                    (!thread ||
                      thread.provider.kind !== provider ||
                      thread.project_id !== projectId) && (
                      <T variant="caption" tone="secondary">
                        Open a Claude conversation in this project to sign in.
                      </T>
                    )}
                </View>
              )}
            </View>
          );
        })
      )}
      {items.length > count && (
        <Button secondary onPress={() => setCount((n) => n + 40)}>
          Show more
        </Button>
      )}
      <T variant="caption" tone="secondary" style={{ marginTop: 24 }}>
        {provider === "codex"
          ? "Use @ in a conversation to choose a plugin or connected app."
          : "Use / in a conversation to choose a plugin skill."}
      </T>
      {!!catalog.warnings.length && (
        <View style={{ marginTop: 12 }}>
          <Tap
            label="Catalog notices"
            expanded={warningsOpen}
            onPress={() => setWarningsOpen((v) => !v)}
            style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
          >
            <Icon
              name="exclamationmark.circle"
              size={16}
              color={colors.secondary}
            />
            <T variant="caption" tone="secondary">
              {catalog.warnings.length} catalog{" "}
              {catalog.warnings.length === 1 ? "notice" : "notices"}
            </T>
            <Icon
              name={warningsOpen ? "chevron.up" : "chevron.down"}
              size={12}
            />
          </Tap>
          {warningsOpen &&
            catalog.warnings.map((w) => (
              <T
                key={w}
                variant="caption"
                tone="secondary"
                style={{ marginBottom: 8 }}
              >
                {w}
              </T>
            ))}
        </View>
      )}
    </Page>
  );
}
