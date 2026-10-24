// Actions on a project: reorder, move to another space, rename, remove. Shared by
// the Projects list (long-press) and the project page ("…").
import { REMOVE_PROJECT_BODY, removeProjectTitle } from "../state/projectList";
import type { Project } from "../state/protocol";
import { errorText, refresh, rpc } from "../state/runtime";
import { moveProjectToSpace, SPACE_COPY, type useSpaces } from "../state/spaces";
import { Alert, confirm } from "../ui/Alert";
import type { MenuItem } from "../ui/menuModel";
import { showToast } from "../ui/Toast";

/** Menu actions shared by the list row and the project page. */
export function projectMenuItems(
  project: Project,
  options: {
    spaces: ReturnType<typeof useSpaces>;
    order?: { up?: () => void; down?: () => void };
    onError: (message: string) => void;
    onRemoved?: () => void;
  },
): MenuItem[] {
  const fail = (e: unknown) => options.onError(errorText(e));
  const items: MenuItem[] = [];
  if (options.order)
    items.push(
      { title: "Move up", icon: "arrow.up", disabled: !options.order.up, onPress: options.order.up },
      { title: "Move down", icon: "arrow.down", disabled: !options.order.down, onPress: options.order.down },
    );
  if (options.spaces.supported && options.spaces.spaces.length > 1)
    items.push({
      title: SPACE_COPY.moveToSpace,
      icon: "square.stack.3d.up",
      children: options.spaces.spaces.map<MenuItem>((target) => ({
        title: target.name,
        checked: target.id === project.space_id,
        onPress: () => {
          if (target.id === project.space_id) return;
          void moveProjectToSpace(project.id, target.id)
            .then(() => showToast(SPACE_COPY.movedToast(project.name, target.name)))
            .catch(() => options.onError(SPACE_COPY.moveFailure(project.name)));
        },
      })),
    });
  items.push(
    {
      title: "Rename…",
      icon: "pencil",
      onPress: () =>
        Alert.prompt(
          "Rename project",
          undefined,
          (value) => {
            const name = value?.trim();
            if (name && name !== project.name)
              void rpc("projects.update", { project_id: project.id, name }).then(refresh).catch(fail);
          },
          "plain-text",
          project.name,
        ),
    },
    {
      title: "Remove project…",
      icon: "minus.circle",
      destructive: true,
      onPress: () =>
        confirm({
          title: removeProjectTitle(project.name),
          message: REMOVE_PROJECT_BODY,
          confirm: "Remove project",
          onConfirm: () => {
            void rpc("projects.remove", { project_id: project.id })
              .then(async () => {
                await refresh();
                options.onRemoved?.();
              })
              .catch(fail);
          },
        }),
    },
  );
  return items;
}

