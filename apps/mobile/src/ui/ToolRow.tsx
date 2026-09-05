// One-line tool call ("Ran git status") that unfolds in place.

import React, { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeIn, LinearTransition, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import type { TranscriptEntry } from "@/protocol";
import { Icon } from "./Icon";
import { Txt } from "./Screen";
import { StatusGlyph } from "./StatusGlyph";
import { Tap } from "./Tap";
import { radius, space, useTheme } from "./theme";

type ToolEntry = Extract<TranscriptEntry, { role: "tool_call" }>;

/** Verb-first summary of a tool call from its provider-native input. */
export function describeTool(name: string, input: unknown, complete: boolean): { verb: string; object: string; mono: boolean } {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string) : undefined);
  const n = name.toLowerCase();
  const past = complete;
  if (n === "bash" || n === "shell" || n === "execute") {
    const cmd = str("command") ?? str("cmd");
    return { verb: past ? "Ran" : "Running", object: cmd ? truncate(cmd, 80) : "a command", mono: Boolean(cmd) };
  }
  if (n === "read" || n === "read_file") return { verb: past ? "Read" : "Reading", object: short(str("file_path") ?? str("path")), mono: true };
  if (n === "write" || n === "write_file") return { verb: past ? "Wrote" : "Writing", object: short(str("file_path") ?? str("path")), mono: true };
  if (n === "edit" || n === "multiedit" || n === "edit_file") return { verb: past ? "Edited" : "Editing", object: short(str("file_path") ?? str("path")), mono: true };
  if (n === "glob" || n === "grep" || n === "search") {
    const q = str("pattern") ?? str("query");
    return { verb: past ? "Searched" : "Searching", object: q ? truncate(q, 60) : "", mono: Boolean(q) };
  }
  if (n === "webfetch" || n === "web_fetch") return { verb: past ? "Fetched" : "Fetching", object: truncate(str("url") ?? "", 60), mono: false };
  if (n === "task" || n === "agent") return { verb: past ? "Delegated" : "Delegating", object: truncate(str("description") ?? str("prompt") ?? "", 60), mono: false };
  return { verb: past ? "Used" : "Using", object: name, mono: false };
}

function short(path: string | undefined): string {
  if (!path) return "a file";
  const parts = path.split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function ToolRow({ entry }: { entry: ToolEntry }) {
  const th = useTheme();
  const [open, setOpen] = useState(false);
  const { verb, object, mono } = describeTool(entry.call.name, entry.call.input, entry.complete);
  const output = stringify(entry.output);
  const rotate = useSharedValue(0);
  const chevron = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotate.get() * 90}deg` }] }));

  const toggle = () => {
    const next = !open;
    rotate.set(withSpring(next ? 1 : 0, { duration: 220, dampingRatio: 1 }));
    setOpen(next);
  };

  return (
    <Animated.View layout={LinearTransition.springify().damping(20).stiffness(220)}>
      <Tap scale={1} onPress={toggle} accessibilityState={{ expanded: open }} style={styles.row} hitSlop={4}>
        <Animated.View style={[styles.chev, chevron]}>
          <Icon name="chevronRight" size={11} color={th.textTertiary} weight="bold" />
        </Animated.View>
        <Txt variant="subhead" tone="secondary" color={entry.is_error ? th.failed : undefined} style={styles.label} numberOfLines={open ? undefined : 1}>
          {verb}{" "}
          <Txt variant={mono ? "mono" : "subhead"} tone="secondary" color={entry.is_error ? th.failed : undefined} style={mono ? { fontSize: 13.5 } : undefined}>
            {object}
          </Txt>
        </Txt>
        {!entry.complete ? <StatusGlyph status="running" size={7} /> : null}
      </Tap>
      {open ? (
        <Animated.View entering={FadeIn.duration(160)} style={[styles.detail, { backgroundColor: th.codeFill, borderRadius: radius.md }]}>
          <Txt variant="caption" tone="tertiary" style={styles.sectionLabel}>
            Input
          </Txt>
          <ScrollView horizontal bounces={false}>
            <Txt variant="monoSmall" selectable>
              {stringify(entry.call.input)}
            </Txt>
          </ScrollView>
          {output ? (
            <>
              <Txt variant="caption" tone="tertiary" style={[styles.sectionLabel, { marginTop: space.sm }]}>
                {entry.is_error ? "Error" : "Output"}
              </Txt>
              <ScrollView horizontal bounces={false}>
                <Txt variant="monoSmall" color={entry.is_error ? th.failed : undefined} selectable>
                  {truncateLines(output, 160)}
                </Txt>
              </ScrollView>
            </>
          ) : null}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

function truncateLines(s: string, max: number): string {
  const lines = s.split("\n");
  return lines.length > max ? `${lines.slice(0, max).join("\n")}\n… ${lines.length - max} more lines` : s;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 5, minHeight: 30 },
  chev: { width: 12, alignItems: "center" },
  label: { flex: 1 },
  detail: { marginTop: space.xs, marginBottom: space.xs, padding: space.md },
  sectionLabel: { textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 },
});
