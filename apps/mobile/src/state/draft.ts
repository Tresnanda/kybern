import { useSyncExternalStore } from "react";
import type { PermissionMode, ProviderKind } from "./protocol";
export interface DraftOptions {
  projectId: string;
  provider: ProviderKind;
  instance: string;
  model: string;
  effort: string;
  permission: PermissionMode;
  worktree: boolean;
  baseBranch: string;
}
let draft: DraftOptions = {
  projectId: "",
  provider: "claude-code",
  instance: "default",
  model: "",
  effort: "",
  permission: "supervised",
  worktree: true,
  baseBranch: "",
};
const listeners = new Set<() => void>();
export function setDraft(patch: Partial<DraftOptions>) {
  draft = { ...draft, ...patch };
  listeners.forEach((fn) => fn());
}
export function getDraft() {
  return draft;
}
export function useDraft() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getDraft,
    getDraft,
  );
}

import type { ContentPart } from "./protocol";
const context = new Map<string, ContentPart[]>();
const noParts: ContentPart[] = [];
export function addContext(key: string, part: ContentPart) {
  context.set(key, [...(context.get(key) ?? []), part]);
  listeners.forEach((fn) => fn());
}
export function clearContext(key: string) {
  context.delete(key);
  listeners.forEach((fn) => fn());
}
export function useContextParts(key: string) {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => context.get(key) ?? noParts,
    () => noParts,
  );
}
