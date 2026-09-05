// Small dependency-free markdown renderer for assistant text: headings,
// paragraphs, fenced code, bullet / numbered lists, blockquotes, and inline
// code / bold / italic / links. Anything else renders as plain text.

import React, { useMemo } from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { radius, space, type as t, useTheme, type Theme } from "./theme";

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "rule" };

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push({ kind: "p", text: para.join("\n") });
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = /^\s*```\s*(\S*)\s*$/.exec(line);
    if (fence) {
      flush();
      const lang = fence[1] ?? "";
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? "")) {
        buf.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      blocks.push({ kind: "code", lang, text: buf.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: "h", level: h[1]?.length ?? 1, text: h[2] ?? "" });
      i += 1;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      flush();
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? "")) {
        rows.push(splitRow(lines[i] ?? ""));
        i += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      i += 1;
      continue;
    }
    const li = /^\s*(?:[-*+]|\d+[.)])\s+/.exec(line);
    if (li) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? "";
        const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(l);
        if (m) items.push(m[1] ?? "");
        else if (/^\s{2,}\S/.test(l) && items.length) items[items.length - 1] += " " + l.trim();
        else break;
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? "")) {
        buf.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", text: buf.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flush();
      i += 1;
      continue;
    }
    para.push(line);
    i += 1;
  }
  flush();
  return blocks;
}

type Span = { text: string; code?: boolean; bold?: boolean; italic?: boolean; href?: string };

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))/g;

function parseInline(text: string): Span[] {
  const out: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: text.slice(last, idx) });
    const raw = m[0];
    if (m[1]) out.push({ text: raw.slice(1, -1), code: true });
    else if (m[2] || m[3]) out.push({ text: raw.slice(2, -2), bold: true });
    else if (m[4] || m[5]) out.push({ text: raw.slice(1, -1), italic: true });
    else if (m[6]) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(raw);
      out.push({ text: lm?.[1] ?? raw, href: lm?.[2] });
    }
    last = idx + raw.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

function Inline({ text, th, base }: { text: string; th: Theme; base: object }) {
  const spans = useMemo(() => parseInline(text), [text]);
  return (
    <Text style={[base, { color: th.text }]} selectable>
      {spans.map((s, i) =>
        s.code ? (
          <Text key={i} style={[t.mono, { fontSize: 14.5, backgroundColor: th.codeFill, color: th.text }]}>
            {s.text}
          </Text>
        ) : s.href ? (
          <Text key={i} style={{ textDecorationLine: "underline", textDecorationColor: th.textTertiary }} onPress={() => void Linking.openURL(s.href ?? "")}>
            {s.text}
          </Text>
        ) : (
          <Text key={i} style={{ fontWeight: s.bold ? "600" : undefined, fontStyle: s.italic ? "italic" : undefined }}>
            {s.text}
          </Text>
        ),
      )}
    </Text>
  );
}

export function Markdown({ text }: { text: string }) {
  const th = useTheme();
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <View style={styles.root}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "p":
            return <Inline key={i} text={b.text} th={th} base={t.transcript} />;
          case "h":
            return <Inline key={i} text={b.text} th={th} base={b.level <= 2 ? t.title3 : t.headline} />;
          case "code":
            return (
              <ScrollView key={i} horizontal bounces={false} style={[styles.code, { backgroundColor: th.codeFill }]} contentContainerStyle={styles.codeInner}>
                <Text style={[t.mono, { color: th.text }]} selectable>
                  {b.text}
                </Text>
              </ScrollView>
            );
          case "list":
            return (
              <View key={i} style={styles.list}>
                {b.items.map((item, j) => (
                  <View key={j} style={styles.li}>
                    <Text style={[t.transcript, styles.bullet, { color: th.textTertiary }]}>{b.ordered ? `${j + 1}.` : "•"}</Text>
                    <View style={styles.liBody}>
                      <Inline text={item} th={th} base={t.transcript} />
                    </View>
                  </View>
                ))}
              </View>
            );
          case "quote":
            return (
              <View key={i} style={[styles.quote, { borderLeftColor: th.hairline }]}>
                <Inline text={b.text} th={th} base={t.transcript} />
              </View>
            );
          case "table": {
            const widths = b.header.map((_, j) => {
              const longest = Math.max(b.header[j]?.length ?? 0, ...b.rows.map((r) => r[j]?.length ?? 0));
              return Math.min(240, Math.max(88, longest * 7.2 + 24));
            });
            return (
              <ScrollView key={i} horizontal bounces={false} style={[styles.table, { borderColor: th.hairline }]}>
                <View>
                  <View style={[styles.tr, { borderBottomColor: th.hairline, backgroundColor: th.codeFill }]}>
                    {b.header.map((c, j) => (
                      <View key={j} style={[styles.td, { width: widths[j] }]}>
                        <Inline text={c} th={th} base={{ ...t.footnote, fontWeight: "600" }} />
                      </View>
                    ))}
                  </View>
                  {b.rows.map((r, k) => (
                    <View key={k} style={[styles.tr, k < b.rows.length - 1 ? { borderBottomColor: th.hairline } : { borderBottomWidth: 0 }]}>
                      {r.map((c, j) => (
                        <View key={j} style={[styles.td, { width: widths[j] }]}>
                          <Inline text={c} th={th} base={t.footnote} />
                        </View>
                      ))}
                    </View>
                  ))}
                </View>
              </ScrollView>
            );
          }
          case "rule":
            return <View key={i} style={[styles.rule, { backgroundColor: th.hairline }]} />;
          default:
            return null;
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: space.md },
  code: { borderRadius: radius.md },
  codeInner: { paddingHorizontal: space.md, paddingVertical: space.sm + 2 },
  list: { gap: space.xs },
  li: { flexDirection: "row", gap: space.sm },
  bullet: { minWidth: 20, textAlign: "right" },
  liBody: { flex: 1 },
  quote: { borderLeftWidth: 2, paddingLeft: space.md },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: space.sm },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: "hidden" },
  tr: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth },
  td: { paddingHorizontal: space.md, paddingVertical: 6, justifyContent: "center" },
});
