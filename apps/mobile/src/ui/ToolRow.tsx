// One-line tool call row ("Ran `git status`") that expands on tap.

import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { TranscriptEntry } from "@/protocol";
import { radius, space, type as t, useTheme } from "./theme";

type ToolEntry = Extract<TranscriptEntry, { role: "tool_call" }>;

/** Verb-first summary of a tool call from its provider-native input. */
export function describeTool(name: string, input: unknown, complete: boolean): string {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string) : undefined);
  const n = name.toLowerCase();
  const past = complete;
  if (n === "bash" || n === "shell" || n === "execute") {
    const cmd = str("command") ?? str("cmd");
    return cmd ? `${past ? "Ran" : "Running"} \`${truncate(cmd, 80)}\`` : past ? "Ran a command" : "Running a command";
  }
  if (n === "read" || n === "read_file") return `${past ? "Read" : "Reading"} ${short(str("file_path") ?? str("path"))}`;
  if (n === "write" || n === "write_file") return `${past ? "Wrote" : "Writing"} ${short(str("file_path") ?? str("path"))}`;
  if (n === "edit" || n === "multiedit" || n === "edit_file") return `${past ? "Edited" : "Editing"} ${short(str("file_path") ?? str("path"))}`;
  if (n === "glob" || n === "grep" || n === "search") {
    const q = str("pattern") ?? str("query");
    return `${past ? "Searched" : "Searching"}${q ? ` for \`${truncate(q, 60)}\`` : ""}`;
  }
  if (n === "webfetch" || n === "web_fetch") return `${past ? "Fetched" : "Fetching"} ${truncate(str("url") ?? "", 60)}`;
  return `${past ? "Used" : "Using"} ${name}`;
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
  const label = describeTool(entry.call.name, entry.call.input, entry.complete);
  const color = entry.is_error ? th.failed : th.textSecondary;
  const output = stringify(entry.output);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        style={styles.row}
        hitSlop={6}
      >
        <Text style={[t.caption, styles.chevron, { color: th.textTertiary }]}>{open ? "▾" : "▸"}</Text>
        <Text style={[t.body, { color, flex: 1 }]} numberOfLines={open ? undefined : 1}>
          {label}
        </Text>
        {!entry.complete ? <Text style={[t.caption, { color: th.running }]}>Working</Text> : null}
      </Pressable>
      {open ? (
        <View style={[styles.detail, { backgroundColor: th.surface }]}>
          <Text style={[t.caption, { color: th.textTertiary }]}>Input</Text>
          <ScrollView horizontal bounces={false}>
            <Text style={[t.mono, { color: th.text }]} selectable>
              {stringify(entry.call.input)}
            </Text>
          </ScrollView>
          {output ? (
            <>
              <Text style={[t.caption, { color: th.textTertiary, marginTop: space.sm }]}>{entry.is_error ? "Error" : "Output"}</Text>
              <ScrollView horizontal bounces={false}>
                <Text style={[t.mono, { color: entry.is_error ? th.failed : th.text }]} selectable>
                  {truncateLines(output, 200)}
                </Text>
              </ScrollView>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function truncateLines(s: string, max: number): string {
  const lines = s.split("\n");
  return lines.length > max ? `${lines.slice(0, max).join("\n")}\n… (${lines.length - max} more lines)` : s;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.xs },
  chevron: { width: 12 },
  detail: { marginTop: space.xs, borderRadius: radius.md, padding: space.md, gap: space.xs },
});
