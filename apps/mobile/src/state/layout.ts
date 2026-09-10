import * as SecureStore from "expo-secure-store";
import { useCallback, useSyncExternalStore } from "react";
import { Platform, useWindowDimensions } from "react-native";

// Width tiers, in points. Below SPLIT the app is the single-column phone stack;
// at or above it a persistent sidebar sits beside the detail. The third
// (inspector) column only appears when the sidebar, a readable conversation, and
// the inspector genuinely fit at once — otherwise opening the inspector collapses
// the sidebar. Deriving the three-column threshold from the live sidebar width
// keeps the promise "three columns only when they fit."
export const SPLIT_MIN_WIDTH = 700;
export const SIDEBAR_DEFAULT_WIDTH = 300;
export const SIDEBAR_MIN_WIDTH = 248;
export const SIDEBAR_MAX_WIDTH = 440;
const INSPECTOR_MIN = 380;
const INSPECTOR_MAX = 560;
const CONVERSATION_MIN = 480;

export type InspectorTab = "changes" | "files" | "terminal" | "tasks";

type LayoutState = {
  sidebarOpen: boolean;
  sidebarWidth: number;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  // True when opening the inspector collapsed the sidebar for us, so closing it
  // can restore the sidebar without clobbering a deliberate manual collapse.
  sidebarAutoCollapsed: boolean;
};

let state: LayoutState = {
  sidebarOpen: true,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  inspectorOpen: false,
  inspectorTab: "changes",
  sidebarAutoCollapsed: false,
};
const listeners = new Set<() => void>();
const OPEN_KEY = "kybern.ink.sidebarOpen";
const WIDTH_KEY = "kybern.ink.sidebarWidth";

function set(patch: Partial<LayoutState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}
function getSnapshot() {
  return state;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

// Restore the remembered sidebar preferences once at startup, mirroring the way
// theme.tsx hydrates the appearance choice.
let hydrated = false;
export function hydrateLayout() {
  if (hydrated || Platform.OS === "web") return;
  hydrated = true;
  void SecureStore.getItemAsync(OPEN_KEY)
    .then((value) => {
      if (value === "0" || value === "1") set({ sidebarOpen: value === "1" });
    })
    .catch(() => {});
  void SecureStore.getItemAsync(WIDTH_KEY)
    .then((value) => {
      const w = value ? Number(value) : NaN;
      if (Number.isFinite(w))
        set({ sidebarWidth: clamp(w, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH) });
    })
    .catch(() => {});
}
function persist(key: string, value: string) {
  if (Platform.OS !== "web")
    void SecureStore.setItemAsync(key, value).catch(() => {});
}

export function useLayout() {
  const { width } = useWindowDimensions();
  const s = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getSnapshot,
    getSnapshot,
  );
  const sidebarWidth = s.sidebarWidth;
  const regular = width >= SPLIT_MIN_WIDTH;
  const threeColumn =
    width >= sidebarWidth + INSPECTOR_MIN + CONVERSATION_MIN;

  // In three-column mode the sidebar and conversation both stay, so the inspector
  // is bounded to leave the conversation a readable width. When it is not three-
  // column the sidebar is collapsed away, so the inspector only shares with the
  // conversation and can grow a little wider.
  const inspectorCeiling = threeColumn
    ? Math.min(INSPECTOR_MAX, width - sidebarWidth - CONVERSATION_MIN)
    : Math.min(INSPECTOR_MAX, width - CONVERSATION_MIN);
  const inspectorWidth = Math.round(
    clamp(
      width * (threeColumn ? 0.4 : 0.42),
      INSPECTOR_MIN,
      Math.max(INSPECTOR_MIN, inspectorCeiling),
    ),
  );

  const toggleSidebar = useCallback(() => {
    const open = !getSnapshot().sidebarOpen;
    set({ sidebarOpen: open, sidebarAutoCollapsed: false });
    persist(OPEN_KEY, open ? "1" : "0");
  }, []);
  const setSidebarOpen = useCallback((open: boolean) => {
    set({ sidebarOpen: open, sidebarAutoCollapsed: false });
    persist(OPEN_KEY, open ? "1" : "0");
  }, []);
  const setSidebarWidth = useCallback((next: number) => {
    const w = clamp(Math.round(next), SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
    set({ sidebarWidth: w });
    persist(WIDTH_KEY, String(w));
  }, []);
  const openInspector = useCallback(
    (tab: InspectorTab) => {
      const current = getSnapshot();
      const collapse = !threeColumn && current.sidebarOpen;
      set({
        inspectorOpen: true,
        inspectorTab: tab,
        ...(collapse ? { sidebarOpen: false, sidebarAutoCollapsed: true } : {}),
      });
    },
    [threeColumn],
  );
  const closeInspector = useCallback(() => {
    const current = getSnapshot();
    set({
      inspectorOpen: false,
      ...(current.sidebarAutoCollapsed
        ? { sidebarOpen: true, sidebarAutoCollapsed: false }
        : {}),
    });
  }, []);
  const toggleInspector = useCallback(
    (tab: InspectorTab) => {
      if (getSnapshot().inspectorOpen) closeInspector();
      else openInspector(tab);
    },
    [openInspector, closeInspector],
  );
  const setInspectorTab = useCallback((tab: InspectorTab) => {
    set({ inspectorTab: tab });
  }, []);

  return {
    regular,
    threeColumn,
    width,
    sidebarWidth,
    inspectorWidth,
    sidebarOpen: s.sidebarOpen,
    inspectorOpen: s.inspectorOpen,
    inspectorTab: s.inspectorTab,
    toggleSidebar,
    setSidebarOpen,
    setSidebarWidth,
    openInspector,
    closeInspector,
    toggleInspector,
    setInspectorTab,
  };
}
