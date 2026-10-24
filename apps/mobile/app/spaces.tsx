import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, useWindowDimensions } from "react-native";
import { count } from "../src/state/format";
import { errorText, useApp } from "../src/state/runtime";
import {
  canDeleteSpace,
  currentSpaceId,
  deleteSpace,
  moveSpace,
  setCurrentSpace,
  SPACE_COPY,
  useSpaces,
} from "../src/state/spaces";
import { HeaderActions } from "../src/ui/ActionMenu";
import { confirm } from "../src/ui/Alert";
import { InsetGroup, ListRow, SectionFooter, SectionHeader } from "../src/ui/List";
import type { MenuItem } from "../src/ui/menuModel";
import { Empty, ErrorBanner } from "../src/ui/primitives";
import { SpaceTile } from "../src/ui/SpaceTile";
import { CONTENT_MAX_WIDTH, gutter, space as spacing, useTheme } from "../src/ui/theme";
import { showToast } from "../src/ui/Toast";
import { deleteTarget } from "../../../packages/kybern-client/src/spaces";

// Spaces group projects. Tap a space to show it; long-press to edit, reorder or delete it.
export default function SpacesScreen() {
  const app = useApp();
  const s = useSpaces();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const [error, setError] = useState("");
  const active = currentSpaceId(s);
  const projectsIn = (id: string) => app.projects.filter((p) => p.space_id === id);

  const remove = (id: string) => {
    const space = s.spaces.find((x) => x.id === id);
    if (!space) return;
    const target = deleteTarget(s.spaces, id);
    const projects = projectsIn(id);
    confirm({
      title: SPACE_COPY.deleteTitle(space.name),
      message: !target
        ? undefined
        : projects.length === 0
          ? SPACE_COPY.deleteNone
          : projects.length === 1
            ? SPACE_COPY.deleteOne(projects[0].name, target.name)
            : SPACE_COPY.deleteMany(projects.length, target.name),
      confirm: SPACE_COPY.deleteConfirm,
      onConfirm: () => {
        void deleteSpace(id)
          .then(() => showToast(SPACE_COPY.deletedToast(space.name)))
          .catch((e) => setError(errorText(e) || SPACE_COPY.deleteFailure));
      },
    });
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        paddingHorizontal: gutter(width),
        paddingBottom: spacing["2xl"],
        maxWidth: CONTENT_MAX_WIDTH,
        width: "100%",
        alignSelf: "center",
      }}
    >
      <HeaderActions
        buttons={[{ icon: "plus", label: SPACE_COPY.newSpaceTooltip, onPress: () => router.push("/space-edit") }]}
      />
      <ErrorBanner error={error} />
      {s.supported === false ? (
        <Empty
          icon="square.stack.3d.up"
          title="Spaces need a newer Kybern"
          detail="Update Kybern on your computer to group projects into spaces."
        />
      ) : (
        <>
          <SectionHeader title="Spaces" inset />
          <InsetGroup>
            {s.spaces.map((space, index) => {
              const projects = projectsIn(space.id);
              const menu: MenuItem[] = [
                { title: SPACE_COPY.menuEdit, icon: "pencil", onPress: () => router.push({ pathname: "/space-edit", params: { id: space.id } }) },
                {
                  title: SPACE_COPY.menuMoveUp,
                  icon: "arrow.up",
                  disabled: index === 0,
                  onPress: () => void moveSpace(space.id, -1).catch((e) => setError(errorText(e))),
                },
                {
                  title: SPACE_COPY.menuMoveDown,
                  icon: "arrow.down",
                  disabled: index === s.spaces.length - 1,
                  onPress: () => void moveSpace(space.id, 1).catch((e) => setError(errorText(e))),
                },
                canDeleteSpace(space)
                  ? { title: SPACE_COPY.menuDelete, icon: "trash", destructive: true, onPress: () => remove(space.id) }
                  : { title: SPACE_COPY.menuDelete, icon: "trash", disabled: true, subtitle: SPACE_COPY.defaultCantDelete },
              ];
              return (
                <ListRow
                  key={space.id}
                  leading={<SpaceTile space={space} size={28} />}
                  title={space.name}
                  subtitle={
                    projects.length
                      ? `${count(projects.length, "project")} · ${projects.slice(0, 3).map((p) => p.name).join(", ")}${projects.length > 3 ? "…" : ""}`
                      : "No projects yet"
                  }
                  subtitleLines={1}
                  meta={space.is_default ? "Default" : undefined}
                  checked={space.id === active}
                  onPress={() => {
                    setCurrentSpace(space.id);
                    router.back();
                  }}
                  menu={menu}
                />
              );
            })}
          </InsetGroup>
          <SectionFooter inset>
            {"Projects, threads, notes and tasks show in their space. Move a project from its menu on the Projects page. Touch and hold a space to edit it."}
          </SectionFooter>
        </>
      )}
    </ScrollView>
  );
}
