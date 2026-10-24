import { router } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { groupRowLabel, isGroupProject, repoBadge } from "../../../packages/kybern-client/src/groups";
import { SpaceSwitcher } from "../src/features/Spaces";
import { setProjectOrder, useListState } from "../src/state/listState";
import { homeOf, shortPath } from "../src/state/projectList";
import { isFreeChatProject } from "../src/state/protocol";
import { currentClient, useApp } from "../src/state/runtime";
import { currentSpaceId, SPACE_COPY, useSpaceProjects, useSpaces } from "../src/state/spaces";
import { moveInOrder, orderProjects } from "../src/state/threadList";
import { projectMenuItems } from "../src/features/projectActions";
import { HeaderActions } from "../src/ui/ActionMenu";
import { ListRow, ListSeparator, SectionFooter } from "../src/ui/List";
import { Button, Empty, ErrorBanner } from "../src/ui/primitives";
import { CONTENT_MAX_WIDTH, space, useTheme } from "../src/ui/theme";

// Projects of the active space, in the reader's order. Tap for the project
// page; touch and hold to reorder, move to another space, rename or remove.
export default function Projects() {
  const app = useApp();
  const list = useListState();
  const spaces = useSpaces();
  const projects = useSpaceProjects();
  const { colors } = useTheme();
  const [error, setError] = useState("");
  const home = homeOf(currentClient()?.info?.data_dir);
  const recent = useMemo(() => {
    const at: Record<string, string> = {};
    for (const t of app.threads) if ((at[t.project_id] ?? "") < t.updated_at) at[t.project_id] = t.updated_at;
    return at;
  }, [app.threads]);
  const ordered = useMemo(
    () => orderProjects(projects.filter((p) => !isFreeChatProject(p.id)), list.projectOrder, recent),
    [projects, list.projectOrder, recent],
  );
  const ids = ordered.map((p) => p.id);
  const move = (id: string, offset: -1 | 1) => {
    // Keep projects of other spaces where they were; only this space's order changes.
    const others = list.projectOrder.filter((other) => !ids.includes(other));
    setProjectOrder([...moveInOrder(ids, id, offset), ...others]);
  };
  const activeSpace = spaces.spaces.find((s) => s.id === currentSpaceId(spaces));

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space["2xl"], maxWidth: CONTENT_MAX_WIDTH, width: "100%", alignSelf: "center", flexGrow: 1 }}
    >
      <HeaderActions
        buttons={[{ icon: "plus", label: "Add project", disabled: app.status !== "open", onPress: () => router.push("/add-project") }]}
      />
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm }}>
        {spaces.spaces.length > 1 ? (
          <View style={{ alignSelf: "flex-start" }}>
            <SpaceSwitcher />
          </View>
        ) : null}
        <ErrorBanner error={error} />
      </View>
      {ordered.map((project, index) => {
        const group = isGroupProject(project);
        const members = project.members?.length ?? 0;
        return (
          <View key={project.id}>
            <ListRow
              leading={group ? "square.stack.3d.up" : "folder"}
              title={project.name}
              subtitle={shortPath(project.path, home)}
              subtitleLines={1}
              subtitleEllipsize="middle"
              meta={group ? repoBadge(members) : undefined}
              label={group ? groupRowLabel(project.name, members) : undefined}
              chevron
              onPress={() => router.push({ pathname: "/project", params: { id: project.id } })}
              menu={projectMenuItems(project, {
                spaces,
                order: {
                  up: index > 0 ? () => move(project.id, -1) : undefined,
                  down: index < ordered.length - 1 ? () => move(project.id, 1) : undefined,
                },
                onError: setError,
              })}
            />
            {index < ordered.length - 1 ? <ListSeparator leading /> : null}
          </View>
        );
      })}
      {ordered.length ? (
        <View style={{ paddingHorizontal: space.lg }}>
          <SectionFooter>
            {activeSpace && spaces.spaces.length > 1
              ? `Projects in ${activeSpace.name}. Touch and hold a project to reorder it or move it to another space.`
              : "Touch and hold a project to reorder, rename or remove it."}
          </SectionFooter>
        </View>
      ) : (
        <Empty
          icon="folder"
          title={activeSpace && spaces.spaces.length > 1 ? `No projects in ${activeSpace.name}` : SPACE_COPY.emptyTitle}
          detail="Choose a folder on your computer to start working with an agent."
          action={
            <Button size="medium" icon="plus" disabled={app.status !== "open"} onPress={() => router.push("/add-project")}>
              Add project
            </Button>
          }
        />
      )}
    </ScrollView>
  );
}
