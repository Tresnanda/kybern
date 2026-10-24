// Plugins and connectors of an agent in a project. Claude Code and Codex have a
// native catalog; other agents say how they manage theirs.
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, View } from "react-native";
import type { Integration, IntegrationAction, IntegrationsCatalog, ProviderKind, Thread } from "../../state/protocol";
import { isFreeChatProject, PROVIDER_DISPLAY_NAME } from "../../state/protocol";
import { count } from "../../state/format";
import { errorText, rpc, useApp } from "../../state/runtime";
import { ListRow } from "../../ui/List";
import type { MenuItem } from "../../ui/menuModel";
import { Button, Empty, ErrorBanner, T } from "../../ui/primitives";
import { ProviderMark } from "../../ui/ProviderMark";
import { SearchField } from "../../ui/Search";
import { Segmented } from "../../ui/Segmented";
import { showToast } from "../../ui/Toast";
import { space } from "../../ui/theme";
import { Section } from "./common";

const ACTIONS: Record<IntegrationAction, string> = {
  install: "Install",
  uninstall: "Uninstall",
  enable: "Turn on",
  disable: "Turn off",
  update: "Update",
};

/** "github@claude-plugins" → "Github". */
function displayName(item: Integration) {
  if (!item.name.includes("@")) return item.name;
  const raw = item.name.split("@")[0] ?? item.name;
  return raw.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function stateLabel(item: Integration) {
  if (!item.installed) return item.kind === "connector" ? "Not connected" : "Not installed";
  if (!item.enabled) return "Off";
  return item.kind === "connector" ? "Connected" : "On";
}

export function IntegrationsSettings({
  thread,
  projectId: initialProject,
  provider: initialProvider,
}: {
  thread?: Thread;
  projectId?: string;
  provider?: ProviderKind;
}) {
  const app = useApp();
  const projects = app.projects.filter((p) => !isFreeChatProject(p.id));
  const [projectId, setProjectId] = useState(initialProject ?? thread?.project_id ?? projects[0]?.id);
  const available = app.providers.filter((p) => p.available);
  const [provider, setProvider] = useState<ProviderKind>(initialProvider ?? thread?.provider.kind ?? "claude-code");
  const [category, setCategory] = useState<"plugin" | "connector">("plugin");
  const [catalog, setCatalog] = useState<IntegrationsCatalog>({ items: [], warnings: [] });
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(40);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!projectId || app.status !== "open") return;
    let live = true;
    setLoading(true);
    setError("");
    setCatalog({ items: [], warnings: [] });
    rpc("integrations.list", { project_id: projectId, provider })
      .then((value) => live && setCatalog(value))
      .catch((e) => live && setError(errorText(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [projectId, provider, reload, app.status, app.activeId]);
  const change = async (item: Integration, action: IntegrationAction) => {
    if (!projectId) return;
    setBusy(true);
    setError("");
    try {
      const result = await rpc("integrations.change", { project_id: projectId, provider, id: item.id, kind: item.kind, scope: item.scope, action });
      if (result.message) showToast(result.message);
      if (result.connections.length) {
        setCategory("connector");
        setCatalog((c) => ({
          ...c,
          items: [...result.connections, ...c.items.filter((i) => !result.connections.some((a) => a.id === i.id))],
        }));
      } else setReload((n) => n + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const login = async (item: Integration) => {
    if (!thread) return;
    setBusy(true);
    try {
      const terminal = await rpc("integrations.login", { thread_id: thread.id, name: item.id });
      router.push({ pathname: "/workspace", params: { threadId: thread.id, tab: "Terminal", terminalId: terminal.id, login: "1" } });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const open = (url: string) => void Linking.openURL(url).catch((e) => setError(errorText(e)));
  const canLogin = !!thread && thread.provider.kind === provider && thread.project_id === projectId;
  const actions = (item: Integration): MenuItem[] => [
    ...item.actions.map((action) => ({
      title: ACTIONS[action],
      destructive: action === "uninstall",
      disabled: busy || app.status !== "open",
      onPress: () => void change(item, action),
    })),
    ...(item.connect_url ? [{ title: item.installed ? "Manage connection" : "Connect", icon: "link" as const, onPress: () => open(item.connect_url!) }] : []),
    ...(item.can_login
      ? [{ title: "Sign in", icon: "key" as const, disabled: !canLogin || busy, subtitle: canLogin ? undefined : "Open a Claude Code conversation in this project first", onPress: () => void login(item) }]
      : []),
  ];
  const needle = query.trim().toLowerCase();
  const items = catalog.items.filter(
    (i) => i.kind === category && `${i.name} ${i.description ?? ""} ${i.id}`.toLowerCase().includes(needle),
  );
  const project = app.projects.find((p) => p.id === projectId);
  const native = provider === "claude-code" || provider === "codex";
  return (
    <>
      <Section first>
        <ListRow
          title="Agent"
          leading={<ProviderMark kind={provider} size={20} />}
          value={PROVIDER_DISPLAY_NAME[provider]}
          valueMenu={(available.length ? available : app.providers).map((p) => ({
            title: p.display_name,
            checked: p.kind === provider,
            onPress: () => {
              setProvider(p.kind);
              setShown(40);
            },
          }))}
        />
        <ListRow
          title="Project"
          leading="folder"
          value={project?.name ?? "Choose a project"}
          valueMenu={projects.map((p) => ({ title: p.name, checked: p.id === projectId, onPress: () => setProjectId(p.id) }))}
        />
      </Section>
      {native ? (
        <View style={{ marginTop: space.xl, gap: space.md }}>
          <Segmented
            compact
            label="Show"
            value={category}
            onChange={(value) => {
              setCategory(value);
              setShown(40);
            }}
            options={[
              { value: "plugin", label: "Plugins" },
              { value: "connector", label: "Connectors" },
            ]}
          />
          <SearchField
            value={query}
            onChangeText={(value) => {
              setQuery(value);
              setShown(40);
            }}
            placeholder={category === "plugin" ? "Find a plugin" : "Find a connector"}
          />
        </View>
      ) : null}
      <ErrorBanner error={error} onRetry={() => setReload((n) => n + 1)} />
      {!projectId ? (
        <Empty icon="folder" title="No projects yet" detail="Add a project to manage its plugins and connectors." />
      ) : loading ? (
        <Empty variant="inline" title="Loading integrations…" />
      ) : items.length === 0 ? (
        native ? (
          <Empty
            icon="puzzlepiece.extension"
            title={needle ? `No matches for “${query.trim()}”` : category === "plugin" ? "No plugins yet" : "No connectors yet"}
            detail={needle ? "Try another name." : `Add one in ${PROVIDER_DISPLAY_NAME[provider]}, then refresh.`}
            action={
              needle ? (
                <Button role="plain" onPress={() => setQuery("")}>
                  Clear search
                </Button>
              ) : (
                <Button icon="arrow.clockwise" size="medium" onPress={() => setReload((n) => n + 1)}>
                  Refresh
                </Button>
              )
            }
          />
        ) : (
          <Section footer={catalog.warnings[0] ?? `${PROVIDER_DISPLAY_NAME[provider]} manages integrations through its own configuration.`}>
            <ListRow title="No catalog for this agent" leading="puzzlepiece.extension" />
          </Section>
        )
      ) : (
        <Section
          title={count(items.length, category === "plugin" ? "plugin" : "connector")}
          action={provider === "claude-code" && category === "connector" ? { title: "Add", onPress: () => open("https://claude.ai/settings/connectors"), label: "Add a Claude connector" } : { title: "Refresh", onPress: () => setReload((n) => n + 1) }}
          footer={provider === "codex" ? "Use @ in a conversation to choose a plugin or connected app." : "Use / in a conversation to choose a plugin skill."}
        >
          {items.slice(0, shown).map((item) => (
            <ListRow
              key={`${item.kind}:${item.id}:${item.scope}`}
              title={displayName(item)}
              subtitle={[item.description, item.scope].filter(Boolean).join(" · ") || undefined}
              leading={item.kind === "plugin" ? "puzzlepiece.extension" : "link"}
              value={stateLabel(item)}
              valueMenu={actions(item)}
            />
          ))}
        </Section>
      )}
      {items.length > shown ? (
        <View style={{ marginTop: space.md }}>
          <Button role="plain" onPress={() => setShown((n) => n + 40)}>
            Show more
          </Button>
        </View>
      ) : null}
      {native && catalog.warnings.length ? (
        <View style={{ marginTop: space.lg }}>
          <T variant="footnote" tone="muted">
            {catalog.warnings.join(" ")}
          </T>
        </View>
      ) : null}
    </>
  );
}

