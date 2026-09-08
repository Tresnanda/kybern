import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import {
  advanceReveal,
  revealBoundary,
  REVEAL_INTERVAL_MS,
} from "../lib/streamPacing";

export function useStreamedText(
  text: string,
  complete: boolean,
  active: boolean,
) {
  const reduced = useReducedMotion();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const [shown, setShown] = useState(text);
  const state = useRef({
    target: text,
    position: text.length,
    committed: text.length,
    frame: 0,
    last: 0,
    commitAt: 0,
  });
  const animate = active && foreground && !reduced && !complete;
  useEffect(() => {
    const sub = AppState.addEventListener("change", (value) =>
      setForeground(value === "active"),
    );
    return () => sub.remove();
  }, []);
  useEffect(() => {
    const s = state.current;
    const replaced = !text.startsWith(s.target);
    s.target = text;
    if (!animate || replaced) {
      cancelAnimationFrame(s.frame);
      s.frame = 0;
      s.position = s.committed = text.length;
      setShown(text);
      return;
    }
    if (s.frame || s.position >= text.length) return;
    s.last = s.commitAt = performance.now();
    function tick(now: number) {
      s.frame = 0;
      s.position = advanceReveal(s.position, s.target.length, now - s.last);
      s.last = now;
      const end = revealBoundary(s.target, s.position);
      if (
        end !== s.committed &&
        (end >= s.target.length || now - s.commitAt >= REVEAL_INTERVAL_MS)
      ) {
        s.committed = end;
        s.commitAt = now;
        setShown(s.target.slice(0, end));
      }
      if (s.position < s.target.length) s.frame = requestAnimationFrame(tick);
    }
    s.frame = requestAnimationFrame(tick);
  }, [text, animate]);
  useEffect(() => () => cancelAnimationFrame(state.current.frame), []);
  return !animate || !text.startsWith(shown) ? text : shown;
}
