import * as Clipboard from "expo-clipboard";
import { createContext, memo, useContext, useMemo, useState, type ReactNode } from "react";
import { router } from "expo-router";
import { chatLink, kybernRef, splitKybernRefs, type KybernRef } from "../../../../packages/kybern-client/src/chatLinks";
import { ChatFileContext } from "../state/chatFileContext";
import { Alert } from "./Alert";
import { Image, Linking, ScrollView, Text, View } from "react-native";
import { httpBase } from "../state/protocol";
import { activeEnvironment } from "../state/runtime";
import { Lightbox } from "../features/Lightbox";
import { Icon, IconButton, T, Tap, styles } from "./primitives";
import {
  imagePlaceholderText,
  isRemoteImage,
  localImagePath,
  splitImages,
  tableCells,
  tableColumnWidths,
  type MarkdownImage,
} from "./markdownModel";
import { MONO, radius, useTheme } from "./theme";
import { MermaidBlock } from "./Mermaid";
import { taskLinkId } from "../state/tasksModel";
import { TaskRef } from "./TaskRef";
import { NoteRef } from "./NoteRef";

export function openLink(url: string) {
  if (/^(https?:|mailto:)/i.test(url))
    void Linking.openURL(url).catch(() => {});
}
/** In a chat message a task reference also reads its title and notices when it is deleted. */
const ChatRefs = createContext(false);

function RefChip({ reference, label, checklist }: { reference: KybernRef; label: string; checklist?: boolean }) {
  const chat = useContext(ChatRefs);
  return reference.target === "task" ? (
    <TaskRef id={reference.id} label={label} checklist={checklist} chat={chat} />
  ) : (
    <NoteRef id={reference.id} label={label} />
  );
}
/** Plain text, with any bare `kybern://note|task/<id>` in it drawn as a reference. */
function RefText({ text, checklist }: { text: string; checklist?: boolean }) {
  if (!text.includes("kybern://")) return <>{text}</>;
  return (
    <>
      {splitKybernRefs(text).map((part, i): ReactNode =>
        "ref" in part ? (
          <RefChip key={i} reference={part.ref} label={part.text} checklist={checklist} />
        ) : (
          part.text
        ),
      )}
    </>
  );
}
function Inline({ text, checklist }: { text: string; checklist?: boolean }) {
  const { colors } = useTheme();
  const fileContext = useContext(ChatFileContext);
  return (
    <>
      {text
        .split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g)
        .map((part, i) => {
          if (part.startsWith("**") && part.endsWith("**"))
            return (
              <Text key={i} style={{ fontWeight: "600" }}>
                {<Inline text={part.slice(2, -2)} checklist={checklist} />}
              </Text>
            );
          const codeRef =
            part.startsWith("`") && part.endsWith("`")
              ? kybernRef(part.slice(1, -1))
              : null;
          if (codeRef)
            return (
              <RefChip
                key={i}
                reference={codeRef}
                label=""
                checklist={checklist}
              />
            );
          if (part.startsWith("`") && part.endsWith("`"))
            return (
              <Text
                key={i}
                style={{
                  fontFamily: MONO,
                  // 0.88 em of the 17 pt reading text, on the code fill; nested text cannot pad, so thin spaces do.
                  fontSize: 15,
                  backgroundColor: colors.code,
                  color: colors.ink,
                }}
              >
                {`\u2009${part.slice(1, -1)}\u2009`}
              </Text>
            );
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
          const linked = link ? kybernRef(link[2]!) : null;
          const taskId = link ? taskLinkId(link[2]!) : null;
          if (link && (linked || taskId))
            return (
              <RefChip
                key={i}
                reference={linked ?? { target: "task", id: taskId! }}
                label={link[1]!}
                checklist={checklist}
              />
            );
          if (link)
            return (
              <Text
                key={i}
                accessibilityRole="link"
                onPress={() => {
                  const target = chatLink(link[2]!, fileContext?.basePath);
                  if (target.kind === "external") openLink(target.url);
                  else if (target.kind === "file" && fileContext) router.push({
                    pathname: "/file",
                    params: { threadId: fileContext.threadId, projectId: fileContext.projectId, path: target.path, scope: fileContext.scope ?? "thread", ...(target.line ? { line: String(target.line) } : {}) },
                  });
                  else if (target.kind !== "anchor") Alert.alert("Unable to open link", target.kind === "file" ? "Open this file from its conversation." : "This link cannot be opened.");
                }}
                style={{
                  textDecorationLine: "underline",
                  color: colors.accent,
                }}
              >
                {link[1]}
              </Text>
            );
          if (part.startsWith("*") && part.endsWith("*"))
            return (
              <Text key={i} style={{ fontStyle: "italic" }}>
                {part.slice(1, -1)}
              </Text>
            );
          return <RefText key={i} text={part} checklist={checklist} />;
        })}
    </>
  );
}
export const Code = memo(function Code({
  text,
  language = "",
  diff = false,
}: {
  text: string;
  language?: string;
  diff?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        backgroundColor: colors.code,
        borderRadius: radius.md,
        borderCurve: "continuous",
        overflow: "hidden",
      }}
    >
      <View style={[styles.spread, { paddingStart: 15, paddingEnd: 4 }]}>
        <T variant="footnote" tone="secondary">
          {language || (diff ? "Changes" : "Code")}
        </T>
        <IconButton
          name="doc.on.doc"
          label="Copy code"
          onPress={() => void Clipboard.setStringAsync(text)}
        />
      </View>
      <ScrollView
        horizontal
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 18 }}
      >
        <Text
          selectable
          style={{
            fontFamily: MONO,
            fontSize: 13,
            lineHeight: 21,
            color: colors.ink,
          }}
        >
          {diff
            ? text.split("\n").map((line, i) => (
                <Text
                  key={i}
                  style={{
                    color: line.startsWith("+")
                      ? colors.positive
                      : line.startsWith("-")
                        ? colors.negative
                        : line.startsWith("@@")
                          ? colors.accent
                          : colors.ink,
                  }}
                >
                  {line}
                  {"\n"}
                </Text>
              ))
            : text}
        </Text>
      </ScrollView>
    </View>
  );
});
export const Markdown = memo(function Markdown({
  text,
  chat = false,
}: {
  text: string;
  /** A message in a conversation: references read their title and notice deletions. */
  chat?: boolean;
}) {
  const sections = useMemo(() => text.split(/(```[\s\S]*?(?:```|$))/g), [text]);
  return (
    <ChatRefs value={chat}>
      <View style={{ gap: 10 }}>
        {sections.filter(Boolean).map((section, s) => {
          if (section.startsWith("```")) {
            const first = section.indexOf("\n");
            const language = section.slice(3, first < 0 ? undefined : first).trim();
            // A finished mermaid fence is drawn; one still streaming stays code.
            if (language === "mermaid" && first >= 0 && section.trimEnd().endsWith("```")) {
              const source = section.slice(first + 1).replace(/```\s*$/, "").trim();
              return <MermaidBlock key={`mermaid:${s}`} source={source} code={<Code text={source} language="mermaid" />} />;
            }
            return (
              <Code
                key={`code:${s}`}
                language={language}
                text={
                  first < 0
                    ? ""
                    : section
                        .slice(first + 1)
                        .replace(/```$/, "")
                        .trimEnd()
                }
              />
            );
          }
          return section
            .replace(/^(#{1,6} .+)$/gm, "\n\n$1\n\n")
            .trim()
            .split(/\n\s*\n/)
            .filter(Boolean)
            .map((para, p) => (
              <MarkdownParagraph key={`${s}-${p}`} para={para} />
            ));
        })}
      </View>
    </ChatRefs>
  );
});
function imageSource(image: MarkdownImage, threadId?: string) {
  if (isRemoteImage(image.target)) return { uri: image.target };
  const path = localImagePath(image.target);
  const env = activeEnvironment();
  if (!path || !env || !threadId) return undefined;
  // The daemon resolves the path against the thread's folder and refuses protected ones.
  return {
    uri: `${httpBase(env.url)}/threads/${encodeURIComponent(threadId)}/image?path=${encodeURIComponent(path)}`,
    headers: { authorization: `Bearer ${env.token}` },
  };
}

/** An image in a reply: shown at the column width with its caption below; a caption card when it can't load. */
function MarkdownPicture({ image }: { image: MarkdownImage }) {
  const { colors } = useTheme();
  const threadId = useContext(ChatFileContext)?.threadId;
  const source = useMemo(() => imageSource(image, threadId), [image.target, threadId]);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const label = imagePlaceholderText(image);
  if (!source || failed)
    return (
      <View
        accessible
        accessibilityLabel={`Image unavailable: ${label}`}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          padding: 12,
          borderRadius: radius.md,
          borderCurve: "continuous",
          backgroundColor: colors.card,
        }}
      >
        <Icon name="photo" size={20} color={colors.secondary} />
        <View style={{ flex: 1 }}>
          <T variant="footnote">{label}</T>
          <T variant="footnote" tone="secondary">
            Image unavailable
          </T>
        </View>
      </View>
    );
  return (
    <View style={{ gap: 6 }}>
      <Tap label={`${label}. Open full screen`} onPress={() => setOpen(true)} feedback="none">
        <Image
          source={source}
          accessibilityIgnoresInvertColors
          onError={() => setFailed(true)}
          style={{ width: "100%", height: 240, borderRadius: 14, backgroundColor: colors.card }}
          resizeMode="contain"
        />
      </Tap>
      {!!image.alt && (
        <T variant="footnote" tone="secondary">
          {image.alt}
        </T>
      )}
      {open && <Lightbox source={source} label={label} onClose={() => setOpen(false)} />}
    </View>
  );
}
// Completed paragraphs retain native text, selection and table scroll state while
// the current paragraph grows. Only its changed string crosses this memo boundary.
const MarkdownParagraph = memo(function MarkdownParagraph({
  para,
}: {
  para: string;
}) {
  const { colors } = useTheme();
  const pictures = splitImages(para);
  if (pictures.length)
    return (
      <View style={{ gap: 10 }}>
        {pictures.map((part, i) =>
          "image" in part ? (
            <MarkdownPicture key={i} image={part.image} />
          ) : (
            <MarkdownParagraph key={i} para={part.text} />
          ),
        )}
      </View>
    );
  const lines = para.split("\n");
  if (
    lines.length > 1 &&
    /^\s*\|?\s*:?-{3,}/.test(lines[1]!) &&
    lines[0]!.includes("|")
  ) {
    const rows = [tableCells(lines[0]!), ...lines.slice(2).map(tableCells)];
    const widths = tableColumnWidths(rows);
    return (
      // The scroll view owns horizontal drags that start on the table, and the content width is set
      // outright so it is never clamped to the column. Vertical drags still reach the transcript.
      <ScrollView
        horizontal
        nestedScrollEnabled
        directionalLockEnabled
        showsHorizontalScrollIndicator={false}
        style={{ marginVertical: 8, flexGrow: 0 }}
      >
        <View
          style={{
            width: widths.reduce((sum, w) => sum + w, 0) + 2,
            borderWidth: 1,
            borderColor: colors.line,
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
          {rows.map((row, r) => (
            <View
              key={r}
              style={{
                flexDirection: "row",
                backgroundColor: r === 0 ? colors.raised : undefined,
                borderBottomWidth: r < rows.length - 1 ? 1 : 0,
                borderBottomColor: colors.line,
              }}
            >
              {widths.map((width, c) => (
                <View key={c} style={{ width, padding: 12 }}>
                  <T selectable variant={r === 0 ? "label" : "footnote"}>
                    <Inline text={row[c] ?? ""} />
                  </T>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    );
  }
  if (/^#{1,6}\s/.test(para)) {
    // Headings step down with their level (ux-app M17): h1 22, h2 19, h3 17,
    // h4–h6 15 in `secondary`. A screen's own title stays the only larger line.
    const level = para.indexOf(" ");
    return (
      <T
        variant={level === 1 ? "title" : level <= 3 ? "headline" : "label"}
        tone={level >= 4 ? "secondary" : "ink"}
        style={[
          { marginTop: 12 },
          level === 2 ? { fontSize: 19, lineHeight: 24 } : null,
          level >= 4 ? { fontWeight: "600" } : null,
        ]}
      >
        <Inline text={para.replace(/^#{1,6}\s/, "")} />
      </T>
    );
  }
  if (/^[-*_]{3,}$/.test(para))
    return (
      <View
        style={{
          height: 1,
          backgroundColor: colors.line,
          marginVertical: 8,
        }}
      />
    );
  if (/^>/.test(para))
    return (
      <View
        style={{
          borderStartWidth: 2,
          borderColor: colors.line,
          paddingStart: 16,
        }}
      >
        <T variant="prose" tone="secondary" selectable>
          <Inline text={para.replace(/^> ?/gm, "")} />
        </T>
      </View>
    );
  if (/^(?:[-*+] |\d+\. )/m.test(para))
    return (
      <View style={{ gap: 8 }}>
        {para.split("\n").map((line, i) => {
          const match = /^(\s*)([-*+]|\d+\.)\s(.*)$/.exec(line);
          // Checklist items (`- [ ] item`) show a checkbox instead of a bullet.
          const task = match ? /^\[( |x|X)\]\s+(.*)$/.exec(match[3]!) : null;
          const checked = task ? task[1] !== " " : false;
          return (
            <View
              key={i}
              style={{
                flexDirection: "row",
                paddingStart: match ? Math.min(match[1]!.length * 4, 32) : 0,
                gap: 10,
              }}
            >
              {task ? (
                <View
                  accessible
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  style={{ minWidth: 15, paddingTop: 3 }}
                >
                  <Icon
                    name={checked ? "checkmark.square.fill" : "square"}
                    size={19}
                    color={checked ? colors.accent : colors.secondary}
                  />
                </View>
              ) : (
                match && (
                  <T variant="prose" tone="secondary" style={{ minWidth: 15 }}>
                    {/\d/.test(match[2]!) ? match[2] : "•"}
                  </T>
                )
              )}
              <T
                variant="prose"
                selectable
                tone={checked ? "secondary" : "ink"}
                style={{
                  flex: 1,
                  textDecorationLine: checked ? "line-through" : "none",
                }}
              >
                <Inline text={task ? task[2]! : (match?.[3] ?? line)} checklist={!!task} />
              </T>
            </View>
          );
        })}
      </View>
    );
  return (
    <T variant="prose" selectable>
      <Inline text={para} />
    </T>
  );
});
