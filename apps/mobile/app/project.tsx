import { router, Stack, useLocalSearchParams } from "expo-router";
import { randomUUID } from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { Linking, ScrollView, useWindowDimensions, View } from "react-native";
import { createCoordinatorStarter } from "../../../packages/kybern-client/src/coordinator";
import { isGroupProject } from "../../../packages/kybern-client/src/groups";
import { GroupRepositories } from "../src/features/GroupRepositories";
import { projectMenuItems } from "../src/features/projectActions";
import { setDraft, useDraft } from "../src/state/draft";
import { homeOf, REMOVE_PROJECT_BODY, removeProjectTitle, shortPath } from "../src/state/projectList";
import type { PullRequest, Thread } from "../src/state/protocol";
import {
  activeConnectionEpoch,
  activeEnvironment,
  currentClient,
  ensureThread,
  errorText,
  refresh,
  rpc,
  useApp,
} from "../src/state/runtime";
import { moveProjectToSpace, SPACE_COPY, useSpaces } from "../src/state/spaces";
import { HeaderActions } from "../src/ui/ActionMenu";
import { confirm } from "../src/ui/Alert";
import { InsetGroup, ListRow, SectionFooter, SectionHeader } from "../src/ui/List";
import type { MenuItem } from "../src/ui/menuModel";
import { Busy } from "../src/ui/Busy";
import { Empty, ErrorBanner, T } from "../src/ui/primitives";
import { SpaceTile } from "../src/ui/SpaceTile";
import { CONTENT_MAX_WIDTH, gutter, space, useTheme } from "../src/ui/theme";
import { showToast } from "../src/ui/Toast";

// One project: start work in it, open its Coordinator, tasks, notes and files,
// its repositories (groups), open pull requests, and where it lives.
export default function ProjectPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const app = useApp();
  const draft = useDraft();
  const spaces = useSpaces();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const project = app.projects.find((p) => p.id === id);
  const [error, setError] = useState("");
  const [coordinator, setCoordinator] = useState<Thread | null>();
  const [opening, setOpening] = useState(false);
  const starter = useRef<ReturnType<typeof createCoordinatorStarter> | null>(null);
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  const [loadingPrs, setLoadingPrs] = useState(false);
  const home = homeOf(currentClient()?.info?.data_dir);

  useEffect(() => {
    let alive = true;
    if (!id) return;
    setCoordinator(undefined);
    void rpc("coordinator.get", { project_id: id })
      .then((result) => alive && setCoordinator(result ?? null))
      .catch((cause) => alive && setError(errorText(cause)));
    return () => {
      alive = false;
    };
  }, [id, app.activeId]);

  if (!project)
    return (
      <View style={{ flex: 1, backgroundColor: colors.grouped }}>
        <Empty icon="folder" title="Project not found" detail="It may have been removed on your computer." />
      </View>
    );

  /** Open the project's Coordinator, creating it with the draft's agent when the project has none. */
  async function openCoordinator() {
    if (opening || !project) return;
    if (coordinator) {
      router.push({ pathname: "/thread/[id]", params: { id: coordinator.id } });
      return;
    }
    const provider =
      app.providers.find((item) => item.kind === draft.provider && item.available) ?? app.providers.find((item) => item.available);
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
      const same = provider.kind === draft.provider;
      const result = await starter.current.start({
        projectId: project.id,
        provider,
        instance: same ? draft.instance : undefined,
        model: same ? draft.model || undefined : undefined,
        effort: same ? draft.effort || undefined : undefined,
        permissionMode: same ? draft.permission : undefined,
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
    if (!project) return;
    setLoadingPrs(true);
    setError("");
    try {
      const result = await rpc("github.pr.list", { project_id: project.id, state: "open", limit: 30 });
      setPrs(result.pull_requests);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoadingPrs(false);
    }
  }

  const projectSpace = spaces.spaces.find((s) => s.id === project.space_id);
  const spaceMenu: MenuItem[] = spaces.spaces.map((target) => ({
    title: target.name,
    checked: target.id === project.space_id,
    onPress: () => {
      if (target.id === project.space_id) return;
      void moveProjectToSpace(project.id, target.id)
        .then(() => showToast(SPACE_COPY.movedToast(project.name, target.name)))
        .catch(() => setError(SPACE_COPY.moveFailure(project.name)));
    },
  }));
  const remove = () =>
    confirm({
      title: removeProjectTitle(project.name),
      message: REMOVE_PROJECT_BODY,
      confirm: "Remove project",
      onConfirm: () => {
        void rpc("projects.remove", { project_id: project.id })
          .then(async () => {
            await refresh();
            router.back();
          })
          .catch((e) => setError(errorText(e)));
      },
    });

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        paddingHorizontal: gutter(width),
        paddingBottom: space["3xl"],
        maxWidth: CONTENT_MAX_WIDTH,
        width: "100%",
        alignSelf: "center",
      }}
    >
      <Stack.Screen options={{ title: project.name, headerStyle: { backgroundColor: colors.grouped } }} />
      <HeaderActions
        menu={{
          label: "Project options",
          title: project.name,
          items: projectMenuItems(project, { spaces, onError: setError, onRemoved: () => router.back() }).filter(
            (item) => !item.destructive,
          ),
        }}
      />
      <T variant="footnote" tone="secondary" selectable numberOfLines={2} ellipsizeMode="middle" style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>
        {shortPath(project.path, home)}
      </T>
      <ErrorBanner error={error} />
      <View style={{ height: space.lg }} />
      <InsetGroup>
        <ListRow
          title="Start a thread"
          leading="square.and.pencil"
          onPress={() => {
            setDraft({ projectId: project.id });
            router.dismissTo("/");
          }}
        />
        <ListRow
          title={coordinator ? "Open Coordinator" : coordinator === null ? "Create Coordinator" : "Coordinator"}
          subtitle={
            coordinator === undefined
              ? "Checking this project…"
              : coordinator
                ? coordinator.title
                : "A persistent chat that plans the work and delegates it to other agents."
          }
          leading="person.2"
          trailing={opening ? <Busy /> : undefined}
          chevron={!!coordinator}
          disabled={coordinator === undefined || opening}
          onPress={() => void openCoordinator()}
        />
        <ListRow title="Tasks" leading="checklist" chevron onPress={() => router.push({ pathname: "/todo", params: { projectId: project.id } })} />
        <ListRow title="Notes" leading="doc.text" chevron onPress={() => router.push({ pathname: "/notes", params: { projectId: project.id } })} />
        <ListRow
          title="Browse files"
          leading="folder"
          chevron
          onPress={() => router.push({ pathname: "/workspace", params: { projectId: project.id, tab: "Files" } })}
        />
      </InsetGroup>

      {spaces.supported && spaces.spaces.length ? (
        <>
          <SectionHeader title="Space" inset />
          <InsetGroup>
            <ListRow
              title={projectSpace?.name ?? "No space"}
              leading={projectSpace ? <SpaceTile space={projectSpace} size={24} /> : "square.stack.3d.up"}
              value={spaces.spaces.length > 1 ? "Move" : undefined}
              valueMenu={spaces.spaces.length > 1 ? spaceMenu : undefined}
              meta={projectSpace?.is_default ? "Default" : undefined}
            />
          </InsetGroup>
          <SectionFooter inset>{"Its threads, notes and tasks show in this space."}</SectionFooter>
        </>
      ) : null}

      {isGroupProject(project) ? <GroupRepositories project={project} onChanged={() => void refresh()} /> : null}

      <SectionHeader title="Open pull requests" inset count={prs?.length} />
      <InsetGroup>
        {prs === null ? (
          <ListRow
            title={loadingPrs ? "Loading pull requests…" : "Load pull requests"}
            leading="arrow.triangle.pull"
            trailing={loadingPrs ? <Busy /> : undefined}
            disabled={loadingPrs}
            onPress={() => void loadPullRequests()}
          />
        ) : prs.length ? (
          prs.map((pr) => (
            <ListRow
              key={pr.number}
              title={pr.title}
              subtitle={`#${pr.number} · ${pr.head} → ${pr.base}${pr.is_draft ? " · Draft" : ""}`}
              subtitleLines={1}
              leading="arrow.triangle.pull"
              onPress={() => void Linking.openURL(pr.url)}
            />
          ))
        ) : (
          <Empty variant="inline" title="No open pull requests." />
        )}
      </InsetGroup>

      <View style={{ height: space["2xl"] }} />
      <InsetGroup>
        <ListRow title="Remove project" leading="minus.circle" destructive onPress={remove} />
      </InsetGroup>
      <SectionFooter inset>{REMOVE_PROJECT_BODY}</SectionFooter>
    </ScrollView>
  );
}
