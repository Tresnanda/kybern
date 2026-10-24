import { router } from "expo-router";
import { randomUUID } from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { Linking, View } from "react-native";
import { Alert } from "../src/ui/Alert";
import { setDraft, useDraft } from "../src/state/draft";
import { createCoordinatorStarter } from "../../../packages/kybern-client/src/coordinator";
import { type Project, type PullRequest, type Thread } from "../src/state/protocol";
import { activeEnvironment, activeConnectionEpoch, ensureThread, errorText, refresh, rpc, useApp } from "../src/state/runtime";
import {
  Button,
  Empty,
  ErrorBanner,
  Group,
  Icon,
  Page,
  Row,
  T,
} from "../src/ui/primitives";
import { useTheme } from "../src/ui/theme";
import { GroupRepositories, RepoBadge } from "../src/features/GroupRepositories";
import { groupRowLabel, isGroupProject } from "../../../packages/kybern-client/src/groups";

export default function Projects() {
  const app = useApp();
  const draft = useDraft();
  const [opening, setOpening] = useState(false);
  const starter = useRef<ReturnType<typeof createCoordinatorStarter> | null>(null);
  const { colors } = useTheme();
  const [selected, setSelected] = useState<Project>();
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [prsLoaded, setPrsLoaded] = useState(false);
  const [loadingPrs, setLoadingPrs] = useState(false);
  const [error, setError] = useState("");
  const [coordinator, setCoordinator] = useState<Thread | null>();
  function choose(project: Project) {
    setSelected(project);
    setPrs([]);
    setError("");
    setPrsLoaded(false);
  }
  useEffect(() => {
    let alive = true;
    if (!selected) {
      setCoordinator(undefined);
      return;
    }
    setCoordinator(undefined);
    void rpc("coordinator.get", { project_id: selected.id })
      .then((result) => {
        if (alive) setCoordinator(result ?? null);
      })
      .catch((cause) => {
        if (alive) setError(errorText(cause));
      });
    return () => {
      alive = false;
    };
  }, [selected?.id, app.activeId]);
  /** Open the project's Coordinator, creating it with the draft's harness when the project has none. */
  async function openCoordinator(project: Project) {
    if (opening) return;
    if (coordinator) {
      router.push({ pathname: "/thread/[id]", params: { id: coordinator.id } });
      return;
    }
    const provider = app.providers.find((item) => item.kind === draft.provider && item.available)
      ?? app.providers.find((item) => item.available);
    if (!provider) {
      setError("Install a coding agent on your computer, then try again.");
      return;
    }
    const environmentId = activeEnvironment()?.id;
    const epoch = activeConnectionEpoch();
    const changed = () => activeEnvironment()?.id !== environmentId || activeConnectionEpoch() !== epoch;
    setOpening(true);
    setError("");
    try {
      starter.current ??= createCoordinatorStarter((method, params) => rpc(method, params), randomUUID);
      const result = await starter.current.start({
        projectId: project.id,
        provider,
        instance: provider.kind === draft.provider ? draft.instance : undefined,
        model: provider.kind === draft.provider ? draft.model || undefined : undefined,
        effort: provider.kind === draft.provider ? draft.effort || undefined : undefined,
        permissionMode: provider.kind === draft.provider ? draft.permission : undefined,
      });
      if (changed()) throw new Error("The connected computer changed. Open the Coordinator from that project again.");
      setCoordinator(result.thread);
      void refresh();
      await ensureThread(result.thread.id).catch(() => {});
      router.push({ pathname: "/thread/[id]", params: { id: result.thread.id } });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setOpening(false);
    }
  }
  async function loadPullRequests() {
    if (!selected) return;
    setLoadingPrs(true);
    setError("");
    try {
      const r = await rpc("github.pr.list", {
        project_id: selected.id,
        state: "open",
        limit: 30,
      });
      setPrs(r.pull_requests);
      setPrsLoaded(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoadingPrs(false);
    }
  }
  return (
    <Page>
      <ErrorBanner error={error} />
      {selected ? (
        <>
          <Row
            title="All projects"
            icon="arrow.left"
            onPress={() => {
              setSelected(undefined);
              setError("");
            }}
          />
          <T variant="title">{selected.name}</T>
          <T
            variant="caption"
            tone="secondary"
            selectable
            style={{ marginVertical: 10 }}
          >
            {selected.path}
          </T>
          <Group>
            <Row
              title="Start a thread"
              icon="square.and.pencil"
              onPress={() => {
                setDraft({ projectId: selected.id });
                router.dismissTo("/");
              }}
            />
            <Row
              title={
                coordinator === undefined
                  ? "Coordinator"
                  : coordinator
                    ? "Open Coordinator"
                    : "Create Coordinator"
              }
              detail={
                coordinator === undefined
                  ? "Checking this project…"
                  : coordinator
                  ? coordinator.title
                  : "A persistent chat that plans the work and delegates it to other agents."
              }
              icon="person.2"
              onPress={coordinator === undefined || opening ? undefined : () => void openCoordinator(selected)}
            />
            <Row
              title="Tasks"
              icon="checklist"
              onPress={() =>
                router.push({
                  pathname: "/todo",
                  params: { projectId: selected.id },
                })
              }
            />
            <Row
              title="Notes"
              icon="doc.text"
              onPress={() =>
                router.push({
                  pathname: "/notes",
                  params: { projectId: selected.id },
                })
              }
            />
            <Row
              title="Browse files"
              icon="folder"
              onPress={() =>
                router.push({
                  pathname: "/workspace",
                  params: { projectId: selected.id, tab: "Files" },
                })
              }
            />
            <Row
              title="Rename project"
              icon="pencil"
              onPress={() =>
                Alert.prompt(
                  "Rename project",
                  undefined,
                  (value) => {
                    if (value?.trim())
                      void rpc("projects.update", {
                        project_id: selected.id,
                        name: value.trim(),
                      })
                        .then((p) => {
                          setSelected(p);
                          return refresh();
                        })
                        .catch((e) => setError(errorText(e)));
                  },
                  "plain-text",
                  selected.name,
                )
              }
            />
            <Row
              title="Remove project"
              icon="minus.circle"
              danger
              onPress={() =>
                Alert.alert(
                  "Remove this project?",
                  "The project disappears from Kybern. Files on your computer are kept.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Remove project",
                      style: "destructive",
                      onPress: () => {
                        void rpc("projects.remove", { project_id: selected.id })
                          .then(async () => {
                            await refresh();
                            setSelected(undefined);
                          })
                          .catch((e) => setError(errorText(e)));
                      },
                    },
                  ],
                )
              }
            />
          </Group>
          {isGroupProject(selected) && <GroupRepositories project={selected} onChanged={setSelected} />}
          <Group title="Open pull requests">
            {!prsLoaded ? (
              <Button
                secondary
                busy={loadingPrs}
                onPress={() => void loadPullRequests()}
              >
                Load pull requests
              </Button>
            ) : prs.length ? (
              prs.map((pr) => (
                <Row
                  key={pr.number}
                  title={pr.title}
                  detail={`#${pr.number} · ${pr.head} → ${pr.base}${pr.is_draft ? " · Draft" : ""}`}
                  icon="arrow.triangle.pull"
                  onPress={() => void Linking.openURL(pr.url)}
                />
              ))
            ) : (
              <T tone="secondary">No open pull requests.</T>
            )}
          </Group>
        </>
      ) : (
        <>
          <T tone="secondary" style={{ marginBottom: 24 }}>
            Projects on your connected computer.
          </T>
          {app.projects.map((p) => {
            const group = isGroupProject(p);
            return (
              <Row
                key={p.id}
                title={p.name}
                label={group ? groupRowLabel(p.name, p.members?.length ?? 0) : undefined}
                detail={p.path}
                icon={group ? "square.stack.3d.up" : "folder"}
                onPress={() => void choose(p)}
                trailing={
                  group ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <RepoBadge count={p.members?.length ?? 0} />
                      <Icon name="chevron.right" size={13} color={colors.muted} />
                    </View>
                  ) : undefined
                }
              />
            );
          })}
          {!app.projects.length && (
            <Empty
              icon="folder"
              title="Bring a project along."
              detail="Choose a folder on your connected computer to start working with an agent."
            />
          )}
          <View style={{ marginTop: 24 }}>
            <Button
              secondary
              icon="plus"
              disabled={app.status !== "open"}
              onPress={() => router.push("/add-project")}
            >
              Add project
            </Button>
          </View>
        </>
      )}
    </Page>
  );
}
