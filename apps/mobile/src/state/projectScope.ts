// The project filter each list screen shows (Notes, Tasks), remembered per
// computer like the active space. A link that names a project overrides it on
// that screen without changing what is remembered.
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { isFreeChatProject } from "./protocol";
import { useApp } from "./runtime";
import { resolveScope, type ProjectScope } from "./scopeModel";
import { currentSpaceId, useSpaceProjects, useSpaces } from "./spaces";

export type ScopeScreen = "notes" | "tasks";

const values = new Map<string, ProjectScope>();
const listeners = new Set<() => void>();
let version = 0;
function publish() {
  version++;
  listeners.forEach((fn) => fn());
}
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
const read = () => version;

// SecureStore keys allow [A-Za-z0-9._-].
const keyOf = (screen: ScopeScreen, environmentId: string) =>
  `kybern.ink.scope.${screen}.${environmentId.replace(/[^A-Za-z0-9._-]/g, "")}`;

function save(key: string, value: ProjectScope) {
  values.set(key, value);
  publish();
  if (Platform.OS !== "web") void SecureStore.setItemAsync(key, value).catch(() => {});
}

/**
 * The screen's project filter, resolved against the active space, and a setter.
 * `linked` is a project a deep link asked for (`?projectId=`): it is shown until
 * the person picks another filter. Switching to a space without the remembered
 * project resets the filter to All projects.
 */
export function useProjectScope(screen: ScopeScreen, linked?: string) {
  useSyncExternalStore(subscribe, read, read);
  const environmentId = useApp().activeId;
  const key = keyOf(screen, environmentId ?? "local");
  const projects = useSpaceProjects();
  const spaceId = currentSpaceId(useSpaces());
  const [override, setOverride] = useState(linked);
  useEffect(() => setOverride(linked), [linked]);

  useEffect(() => {
    if (values.has(key) || Platform.OS === "web") return;
    void SecureStore.getItemAsync(key)
      .then((value) => {
        // A choice made while this was loading wins.
        if (value && !values.has(key)) {
          values.set(key, value);
          publish();
        }
      })
      .catch(() => {});
  }, [key]);

  const stored: ProjectScope = values.get(key) ?? "all";
  const ids = projects.filter((p) => !isFreeChatProject(p.id)).map((p) => p.id);

  // A space switch forgets a project the new space doesn't have.
  const lastSpace = useRef(spaceId);
  useEffect(() => {
    const previous = lastSpace.current;
    lastSpace.current = spaceId;
    if (previous === spaceId || previous === null || spaceId === null) return;
    setOverride(undefined);
    if (resolveScope(stored, ids) !== stored) save(key, "all");
  });

  const scope = override ?? resolveScope(stored, ids);
  const setScope = useCallback(
    (value: ProjectScope) => {
      setOverride(undefined);
      save(key, value);
    },
    [key],
  );
  return [scope, setScope] as const;
}
