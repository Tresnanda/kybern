// FILE: slidingPill.ts
// Purpose: Measure the active tab in a segmented control and drive one sliding pill behind it.
// Layer: UI motion hook
// Exports: useSlidingPill

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

/**
 * Pair with `.t-tabs` on the container and `.t-tabs-pill` on the pill element
 * (styles/motion.css). Tabs mark themselves with `data-tab-active="true"`.
 * The first measurement lands without a transition; later ones slide.
 */
export function useSlidingPill<T extends HTMLElement>(
  activeKey: string,
): [ref: RefObject<T | null>, pillStyle: CSSProperties, pillReady: boolean] {
  const ref = useRef<T>(null);
  const [pill, setPill] = useState({ x: 0, w: 0 });
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const measure = () => {
      const el = root.querySelector<HTMLElement>('[data-tab-active="true"]');
      if (!el) return;
      const next = { x: el.offsetLeft, w: el.offsetWidth };
      setPill((p) => (p.x === next.x && p.w === next.w ? p : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [activeKey]);

  // Mark ready one frame after the first real measurement so the pill snaps
  // into place invisibly and only slides for later changes.
  useEffect(() => {
    if (pill.w === 0 || ready) return;
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [pill.w, ready]);

  return [ref, { "--x": pill.x, "--w": pill.w } as CSSProperties, ready];
}
