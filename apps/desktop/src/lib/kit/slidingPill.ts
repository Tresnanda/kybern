// FILE: slidingPill.ts
// Purpose: Measure the active tab in a segmented control and drive one sliding pill behind it.
// Layer: UI motion hook
// Exports: useSlidingPill

import { observeResizeFrame } from "@/lib/resizeObserver"
import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties } from "react";

/**
 * Pair with `.t-tabs` on the container and `.t-tabs-pill` on the pill element
 * (styles/motion.css). Tabs mark themselves with `data-tab-active="true"` and
 * must have the container as their offset parent (the container is
 * `position: relative`; keep tab wrappers static). The container ref is a
 * callback so late-mounting hosts (dialog content) still get measured. The
 * first measurement lands without a transition; later ones slide. The pill
 * follows the container and every `[data-tab-active]` tab when it resizes, so
 * a tab that grows (a badge, a longer label) never leaves it stale.
 */
export function useSlidingPill<T extends HTMLElement>(
  activeKey: string,
): [ref: (node: T | null) => void, pillStyle: CSSProperties, pillReady: boolean] {
  const [node, setNode] = useState<T | null>(null);
  const ref = useCallback((next: T | null) => setNode(next), []);
  const [pill, setPill] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    if (!node) return;
    const measure = () => {
      const el = node.querySelector<HTMLElement>('[data-tab-active="true"]');
      if (!el) return;
      const box = el.getBoundingClientRect();
      const root = node.getBoundingClientRect();
      const next = {
        x: box.left - root.left + node.scrollLeft,
        y: box.top - root.top + node.scrollTop,
        w: box.width,
        h: box.height,
      };
      setPill((p) => (p.x === next.x && p.y === next.y && p.w === next.w && p.h === next.h ? p : next));
    };
    measure();
    // Re-measure when the container resizes AND when any tab changes size
    // (a badge or count widening a tab moves the active pill). Tabs can be
    // added or removed without the active key changing, so a MutationObserver
    // keeps the observed set in step with the DOM.
    const stopTabs = new Map<Element, () => void>();
    const syncTabs = () => {
      const tabs = new Set(node.querySelectorAll("[data-tab-active]"));
      for (const [tab, stop] of stopTabs) {
        if (tabs.has(tab)) continue;
        stop();
        stopTabs.delete(tab);
      }
      // A new tab's first observation delivers an initial entry, which measures.
      for (const tab of tabs) if (!stopTabs.has(tab)) stopTabs.set(tab, observeResizeFrame(tab, measure));
    };
    syncTabs();
    const stopNode = observeResizeFrame(node, measure);
    const mutations = new MutationObserver(syncTabs);
    mutations.observe(node, { childList: true, subtree: true });
    return () => {
      stopNode();
      mutations.disconnect();
      for (const stop of stopTabs.values()) stop();
    };
  }, [node, activeKey]);

  // Mark ready one frame after the first real measurement so the pill snaps
  // into place invisibly and only slides for later changes.
  useEffect(() => {
    if (pill.w === 0 || ready) return;
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [pill.w, ready]);

  return [ref, { "--x": pill.x, "--y": pill.y, "--w": pill.w, "--h": pill.h } as CSSProperties, ready];
}
