// One compact row under a list's search: the space chip and a project filter
// (All projects / Global / one project). Notes and Tasks share it. Changing the
// filter swaps the list without motion.
import { View } from "react-native";
import { isGroupProject } from "../../../../packages/kybern-client/src/groups";
import { isFreeChatProject, type Project } from "../state/protocol";
import { useProjects } from "../state/runtime";
import { scopeLabel, type ProjectScope } from "../state/scopeModel";
import { useSpaceProjects } from "../state/spaces";
import { MenuButton } from "../ui/ActionMenu";
import type { MenuItem } from "../ui/menuModel";
import { ProjectDot } from "../ui/TaskGlyphs";
import { radius, space } from "../ui/theme";
import { SpaceSwitcher, ValueCapsule } from "./Spaces";

/** All projects, then Global and the space's projects, the current one checked. */
export function scopeMenuItems(
  scope: ProjectScope,
  projects: readonly Project[],
  onChange: (scope: ProjectScope) => void,
): MenuItem[] {
  return [
    {
      title: "All",
      inline: true,
      children: [
        { title: "All projects", icon: "square.grid.2x2", checked: scope === "all", onPress: () => onChange("all") },
      ],
    },
    {
      title: "Projects",
      inline: true,
      children: [
        { title: "Global", icon: "globe", checked: scope === "global", onPress: () => onChange("global") },
        ...projects.map<MenuItem>((p) => ({
          title: p.name,
          icon: isGroupProject(p) ? "square.stack.3d.up" : "folder",
          checked: scope === p.id,
          onPress: () => onChange(p.id),
        })),
      ],
    },
  ];
}

export function ScopeBar({
  scope,
  onChange,
}: {
  scope: ProjectScope;
  onChange: (scope: ProjectScope) => void;
}) {
  const all = useProjects();
  const inSpace = useSpaceProjects().filter((p) => !isFreeChatProject(p.id));
  // A project a link asked for stays listed even when it lives in another space.
  const linked = scope !== "all" && scope !== "global" && !inSpace.some((p) => p.id === scope)
    ? all.find((p) => p.id === scope)
    : undefined;
  const projects = linked ? [...inSpace, linked] : inSpace;
  const label = scopeLabel(scope, all);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingHorizontal: space.lg,
        paddingTop: space.sm,
        paddingBottom: space.xs,
      }}
    >
      <SpaceSwitcher compact always />
      <MenuButton
        items={scopeMenuItems(scope, projects, onChange)}
        title="Show"
        label={`Showing ${label}. Change project`}
        radius={radius.full}
        style={{ flexShrink: 1 }}
      >
        <ValueCapsule
          compact
          label={label}
          leading={
            scope === "all" ? undefined : (
              <View style={{ width: 20, alignItems: "center" }}>
                <ProjectDot projectId={scope === "global" ? null : scope} />
              </View>
            )
          }
        />
      </MenuButton>
    </View>
  );
}
