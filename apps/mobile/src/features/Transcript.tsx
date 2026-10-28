import * as Clipboard from "expo-clipboard";
import { useViewability } from "@legendapp/list/react-native";
import { router } from "expo-router";
import { memo, useCallback, useMemo, useState } from "react";
import { Image, Share, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { GROUP_COPY, outsideChangeText } from "../../../../packages/kybern-client/src/groups";
import { forkNotice, forkNoticeText } from "../../../../packages/kybern-client/src/forkMachine";
import { coordinatorCardLine } from "../../../../packages/kybern-client/src/coordinatorCards";
import { secretRequestInput } from "../../../../packages/kybern-client/src/secretRequest";
import { agentResultItems, threadMessagePart } from "../../../../packages/kybern-client/src/delegations";
import {
  chosenAnswers,
  expiredQuestion,
  replyInChatMessage,
  requestRecord,
} from "../../../../packages/kybern-client/src/requestCards";
import { pickRecordText, pickRequestInput } from "../../../../packages/kybern-client/src/pickRequest";
import { answerRowText, visualAnswerInput } from "../../../../packages/kybern-client/src/visualAnswer";
import { questionsFor } from "../../../../packages/kybern-client/src/userInput";
import { toolLine } from "../../../../packages/kybern-client/src/toolActivity";
import { displayCommand } from "../../../../packages/kybern-client/src/displayCommand";
import { commandOf } from "../../../../packages/kybern-client/src/signIn";
import type { LoginRecipe } from "../../../../packages/kybern-client/src/loginRecipes";
import { sendFollowUp } from "../state/followUp";
import { createNote } from "../state/notes";
import { httpBase, type ApprovalDecision, type ApprovalRequest } from "../state/protocol";
import { activeEnvironment, errorText, getState } from "../state/runtime";
import { type Block } from "../state/transcript";
import type { TurnRow } from "../state/turnRows";
import { turnFooterText } from "../state/format";
import { workDuration } from "../state/turnRows";
import { ContextMenu, type MenuItem } from "../ui/ActionMenu";
import { Markdown } from "../ui/Markdown";
import { Button, Icon, T, Tap, styles } from "../ui/primitives";
import { showToast } from "../ui/Toast";
import { useStreamedText } from "../ui/useStreamedText";
import { radius, space, useTheme } from "../ui/theme";
import { ApprovalPanel } from "./Approvals";
import { CoordinatorCardLine, RotationRow, SystemRowLine } from "./CoordinatorCards";
import { EditedFilesCard, confirmRewind } from "./EditedFiles";
import { Lightbox } from "./Lightbox";
import { LongPressArea } from "./LongPressArea";
import { MessagePart } from "./MessagePart";
import { RequestRecordLine, SettledLine } from "./RequestCards";
import { SecretRequestLine } from "./SecretRequest";
import { UserMessageBubble } from "./UserMessageBubble";
import { InlineVisual } from "./Visual";
import { AgentsGroupRow, ProcessesRow, TaskWorkRow, ToolWorkRow, WorkSummaryRow, orchestrationRowFor } from "./WorkRow";

/** Quiet warning after a group worktree turn: a left-out repository's own checkout changed. Never reverted. */
function OutsideChangeRow({ block, threadId }: { block: Extract<Block, { kind: "outside_repo_changed" }>; threadId: string }) {
  const { colors } = useTheme();
  const text = outsideChangeText(block.repos.map((repo) => repo.name));
  const open = () => {
    const projectId = getState().threads.find((thread) => thread.id === threadId)?.project_id;
    if (projectId) router.push({ pathname: "/workspace", params: { projectId, tab: "Files", reveal: block.repos[0]?.repo } });
  };
  return (
    <View style={[styles.line, { gap: space.sm }]} accessibilityRole="alert">
      <Icon name="exclamationmark.triangle" size={14} color={colors.warning} />
      <T variant="footnote" tone="secondary" style={{ flex: 1 }}>
        {text}
      </T>
      <Tap label={`${GROUP_COPY.outsideChangeOpen} ${block.repos.map((repo) => repo.name).join(", ")}`} onPress={open}>
        <T variant="footnote" tone="accent" style={{ fontWeight: "500" }}>
          {GROUP_COPY.outsideChangeOpen}
        </T>
      </Tap>
    </View>
  );
}

/** Kybern's own row ("Setup started") above the user's words, which keep their bubble. */
function SystemRowMessage({ block, threadId }: { block: Extract<Block, { kind: "user" }>; threadId: string }) {
  const rows = block.message.parts.flatMap((part) => (part.type === "system_row" ? [part] : []));
  const own = useMemo(() => ({ ...block, message: { ...block.message, parts: block.message.parts.filter((part) => part.type !== "system_row") } }), [block]);
  return (
    <View>
      {rows.map((row, index) => <SystemRowLine key={index} text={row.text} />)}
      {own.message.parts.length > 0 && <UserMessageBubble block={own} threadId={threadId} />}
    </View>
  );
}

const threadLive = (threadId: string) =>
  ["running", "awaiting-approval"].includes(getState().threads.find((thread) => thread.id === threadId)?.status ?? "");

/** Space above a row: 32 between turns, 12 within one, work lines packed (ux-thread M1). */
function rowGap(row: Extract<TurnRow, { kind: "block" }>) {
  const kind = row.block.kind;
  if (row.nested) return kind === "tool" || kind === "runtime_task" ? 0 : space.sm;
  if (kind === "rotation") return 0;
  if (kind === "user") return row.first ? space["2xl"] : space.md;
  if (kind === "turn_end") return space.xs;
  if (kind === "tool" || kind === "runtime_task") return space.xs;
  return space.md;
}

/** One virtual row of the conversation. */
export const TranscriptRow = memo(function TranscriptRow({
  row,
  threadId,
  focused,
  expansions,
  onToggleWork,
}: {
  row: TurnRow;
  threadId: string;
  focused: boolean;
  expansions: Map<string, boolean>;
  onToggleWork: (turnId: string) => void;
}) {
  const { colors } = useTheme();
  const [visible, setVisible] = useState(false);
  useViewability(
    useCallback((token) => setVisible(token.isViewable), []),
    "transcript",
  );
  if (row.kind === "work")
    return (
      <View style={{ paddingTop: space.md }}>
        <WorkSummaryRow label={row.label} failed={row.failed} expanded={row.expanded} onPress={() => onToggleWork(row.turnId)} />
      </View>
    );
  if (row.kind === "agents")
    return (
      <View style={{ paddingTop: space.md }}>
        <AgentsGroupRow launches={row.launches} expanded={row.expanded} onPress={() => onToggleWork(row.turnId)} />
      </View>
    );
  if (row.kind === "processes")
    return (
      <View style={{ paddingTop: space.xs }}>
        <ProcessesRow threadId={row.threadId} tasks={row.tasks} />
      </View>
    );
  if (row.kind === "files")
    return (
      <View style={{ paddingTop: space.md }}>
        <EditedFilesCard threadId={row.threadId} turnId={row.turnId} />
      </View>
    );
  return (
    <View
      style={[
        { paddingTop: rowGap(row) },
        row.nested && {
          marginStart: space.xs,
          paddingStart: space.md,
          borderStartWidth: StyleSheet.hairlineWidth,
          borderColor: colors.line,
        },
      ]}
    >
      <TranscriptBlock
        block={row.block}
        threadId={threadId}
        active={focused && visible}
        expansions={expansions}
        grouped
        thinking={row.thinking}
        signIn={row.signIn}
      />
    </View>
  );
});

/** "12:51 · 3m 43s · $3.52" in the phone's own clock convention; see `turnFooterText`. */
const clockTime = (date: Date) => date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function turnFooter(block: Extract<Block, { kind: "turn_end" }>) {
  return turnFooterText(block, clockTime, workDuration);
}

/** What a settled approval leaves in the transcript: the shared record when there is one, else one plain line. */
function SettledApproval({
  approval,
  decision,
  auto,
  answeredBy,
  threadId,
}: {
  approval: ApprovalRequest;
  decision: ApprovalDecision | null;
  auto?: boolean;
  answeredBy?: Extract<Block, { kind: "approval" }>["answeredBy"];
  threadId: string;
}) {
  const live = threadLive(threadId);
  const secret = secretRequestInput(approval);
  if (secret) return <SecretRequestLine input={secret} decision={decision} />;
  const card = decision ? coordinatorCardLine(approval, decision) : null;
  if (card) return <CoordinatorCardLine parts={card} decision={decision} />;
  const record = requestRecord(approval, decision, live, undefined, answeredBy);
  if (record)
    return (
      <RequestRecordLine record={record}>
        {expiredQuestion(approval, decision) && <ReplyInChat approval={approval} threadId={threadId} />}
      </RequestRecordLine>
    );
  const pick = pickRequestInput(approval);
  if (pick) return <SettledLine icon="viewfinder" text={pickRecordText(pick, decision, live)} tone={decision?.decision === "submit" ? "positive" : "secondary"} />;
  const visual = visualAnswerInput(approval);
  if (visual) return <SettledLine icon="viewfinder" text={answerRowText(visual.title, decision)} />;
  const denied = decision?.decision === "deny";
  const chosen = chosenAnswers(approval, decision);
  if (chosen.length)
    return <SettledLine icon="checkmark.circle" tone="positive" text={`You chose ${chosen.map((answer) => `“${answer}”`).join(", ")}`} />;
  if (questionsFor(approval).length)
    return <SettledLine icon={denied ? "xmark.circle" : "checkmark.circle"} text={denied ? "You declined the question" : "You answered the question"} />;
  const activity = toolLine({ id: approval.id, name: approval.tool_name, input: approval.input }, true);
  const target = activity.kind === "command" ? displayCommand(commandOf(approval.input) || activity.detail, { max: 120 }).text : activity.detail;
  const what = `${activity.verb.toLowerCase()}${target ? ` ${target}` : ""}`;
  return (
    <SettledLine
      icon={denied ? "xmark.circle" : "checkmark.circle"}
      tone={denied ? "secondary" : "positive"}
      text={denied ? `Declined: ${what}` : auto ? `Allowed automatically: ${what}` : `Allowed: ${what}`}
    />
  );
}

/** A question a restart cut off: its options go back as a message instead. */
function ReplyInChat({ approval, threadId }: { approval: ApprovalRequest; threadId: string }) {
  const [sent, setSent] = useState("");
  const question = questionsFor(approval).find((q) => q.options.length && !q.secret);
  if (!question) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, paddingStart: 22 }}>
      {question.options.slice(0, 4).map((option) => (
        <Button
          key={option.label}
          size="medium"
          disabled={!!sent}
          onPress={() => {
            setSent(option.label);
            void sendFollowUp(threadId, replyInChatMessage(question.title, option.label)).catch((e) => {
              setSent("");
              showToast(errorText(e));
            });
          }}
        >
          {sent === option.label ? "Sent" : option.label}
        </Button>
      ))}
    </View>
  );
}

/** The reasoning disclosure: a one-line preview while live, the full text (capped) when opened. */
function Reasoning({ text, thinking, expanded, onToggle }: { text: string; thinking: boolean; expanded: boolean; onToggle: (open: boolean) => void }) {
  const { colors } = useTheme();
  const [all, setAll] = useState(false);
  const last = useMemo(() => text.trim().split("\n").filter(Boolean).at(-1) ?? "", [text]);
  return (
    <View style={{ gap: space.xs }}>
      <Tap
        label={expanded ? "Hide reasoning" : "Show reasoning"}
        expanded={expanded}
        onPress={() => onToggle(!expanded)}
        style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32, alignSelf: "flex-start" }}
        hitSlop={{ top: 6, bottom: 6 }}
      >
        <Icon name="sparkle" size={14} color={colors.muted} />
        <T variant="footnote" tone="secondary" style={{ fontWeight: "500" }}>
          {thinking ? "Thinking" : "Thought process"}
        </T>
        <Icon name={expanded ? "chevron.up" : "chevron.down"} size={12} color={colors.muted} />
      </Tap>
      {!expanded && thinking && !!last && (
        <T variant="footnote" tone="muted" numberOfLines={1} style={{ paddingStart: 22 }}>
          {last}
        </T>
      )}
      {expanded && (
        <Animated.View
          entering={FadeIn.duration(160)}
          exiting={FadeOut.duration(120)}
          style={{ marginStart: space.xs + 2, paddingStart: space.md, borderStartWidth: StyleSheet.hairlineWidth, borderColor: colors.line, gap: space.xs }}
        >
          <T variant="subhead" tone="secondary" style={{ lineHeight: 22 }} selectable numberOfLines={all ? undefined : 12}>
            {text}
          </T>
          {!all && text.split("\n").length > 12 && (
            <Tap label="Show all reasoning" onPress={() => setAll(true)} style={{ alignSelf: "flex-start", minHeight: 36, justifyContent: "center" }}>
              <T variant="footnote" tone="accent">
                Show all
              </T>
            </Tap>
          )}
        </Animated.View>
      )}
    </View>
  );
}

/** Long-press actions on an answer: Copy, Share, Save to note and, on a finished turn, Rewind. */
function answerMenu(text: string, threadId: string, turnId: string | null): MenuItem[] {
  return [
    {
      title: "Copy",
      icon: "doc.on.doc",
      onPress: () => void Clipboard.setStringAsync(text).then(() => showToast("Copied")),
    },
    { title: "Share…", icon: "square.and.arrow.up", onPress: () => void Share.share({ message: text }) },
    {
      title: "Save to note",
      icon: "doc.badge.plus",
      onPress: () => {
        const projectId = getState().threads.find((thread) => thread.id === threadId)?.project_id ?? null;
        void createNote({ projectId, body: text })
          .then((note) =>
            showToast("Saved to a new note", {
              title: "Open",
              onPress: () => router.push({ pathname: "/note", params: { id: note.id } }),
            }),
          )
          .catch((e) => showToast(errorText(e) || "Unable to save the note. Try again."));
      },
    },
    ...(turnId
      ? [{ title: "Rewind to before this turn", icon: "clock.arrow.circlepath" as const, destructive: true, onPress: () => confirmRewind(threadId, turnId) }]
      : []),
  ];
}

function agentImageUri(threadId: string, source: string) {
  const env = activeEnvironment();
  return env
    ? {
        uri: `${httpBase(env.url)}/threads/${encodeURIComponent(threadId)}/image?path=${encodeURIComponent(source)}`,
        headers: { authorization: `Bearer ${env.token}` },
      }
    : undefined;
}

function AgentImage({ block, threadId }: { block: Extract<Block, { kind: "image" }>; threadId: string }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const source = agentImageUri(threadId, block.source);
  return (
    <>
      <Tap label="Image from the agent. Open full screen" onPress={() => setOpen(true)} feedback="none">
        <Image
          source={source}
          accessibilityIgnoresInvertColors
          style={{ width: "100%", height: 240, borderRadius: radius.md, backgroundColor: colors.card }}
          resizeMode="contain"
        />
      </Tap>
      {open && <Lightbox source={source} label="Image from the agent" onClose={() => setOpen(false)} />}
    </>
  );
}

export const TranscriptBlock = memo(function TranscriptBlock({
  block,
  threadId,
  active = true,
  expansions,
  grouped = false,
  thinking = block.kind === "assistant" && !block.complete,
  signIn,
}: {
  block: Block;
  threadId: string;
  active?: boolean;
  expansions?: Map<string, boolean>;
  grouped?: boolean;
  /** Still receiving reasoning; a turn's transcript knows this from its tail. */
  thinking?: boolean;
  signIn?: LoginRecipe;
}) {
  const { colors } = useTheme();
  const expansionKey = `${block.kind}:${block.id}`;
  const [expanded, setExpandedValue] = useState(() => expansions?.get(expansionKey) ?? false);
  const setExpanded = (value: boolean) => {
    expansions?.set(expansionKey, value);
    setExpandedValue(value);
  };
  switch (block.kind) {
    case "user": {
      // Messages between agents and delegated results read as notices, not as the user's own bubble.
      if (threadMessagePart(block.message.parts) || agentResultItems(block.message.parts))
        return (
          <View style={{ gap: space.sm }}>
            {block.message.parts.map((part, index) => (
              <MessagePart key={index} part={part} />
            ))}
          </View>
        );
      if (block.message.parts.some((part) => part.type === "system_row")) return <SystemRowMessage block={block} threadId={threadId} />;
      return <UserMessageBubble block={block} threadId={threadId} />;
    }
    case "assistant": {
      const finalAnswer = grouped && block.complete && block.id.startsWith("answer:");
      const body = (
        <View style={{ gap: space.sm }}>
          {!!block.thinking && <Reasoning text={block.thinking} thinking={thinking} expanded={expanded} onToggle={setExpanded} />}
          {!!block.text && <StreamedMarkdown text={block.text} complete={block.complete} active={active} />}
        </View>
      );
      if (!block.complete || !block.text) return body;
      return (
        <ContextMenu items={answerMenu(block.text, threadId, finalAnswer ? block.turnId : null)} title="Response">
          {({ onLongPress }) => (
            <LongPressArea onLongPress={onLongPress} hint="Long-press for Copy, Share and more">
              {body}
            </LongPressArea>
          )}
        </ContextMenu>
      );
    }
    case "tool":
      return orchestrationRowFor(block) ?? <ToolWorkRow block={block} threadId={threadId} signIn={signIn} expanded={expanded} onToggle={setExpanded} />;
    case "approval": {
      // A summoned card whose turn ended unanswered reads as its record ("ended with the turn").
      const ended = !block.decision && !threadLive(threadId) && !!requestRecord(block.approval, null, false);
      if (block.decision || ended)
        return <SettledApproval approval={block.approval} decision={block.decision} auto={block.auto} answeredBy={block.answeredBy} threadId={threadId} />;
      return <ApprovalPanel approval={block.approval} />;
    }
    case "notice": {
      // A fork notice ("Forked to satyamas") offers the new thread, on the machine that holds it.
      const fork = block.data ? forkNotice(block.data) : null;
      const open = fork?.threadId ?? null;
      return (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <T variant="footnote" tone={block.level === "error" ? "negative" : "secondary"} style={{ flexShrink: 1 }}>
            {fork ? forkNoticeText(fork, block.text) : block.text}
          </T>
          {open ? (
            <Tap label={`Open the thread on ${fork!.machineName}`} onPress={() => router.push({ pathname: "/thread/[id]", params: { id: open } })} style={{ minHeight: 36, justifyContent: "center" }}>
              <T variant="footnote" tone="accent">Open</T>
            </Tap>
          ) : null}
        </View>
      );
    }
    case "runtime_task":
      return <TaskWorkRow task={block.task} />;
    case "turn_end":
      return (
        <View style={{ gap: space.xs }}>
          {block.error && (
            <T variant="footnote" tone="negative">
              {block.error}
            </T>
          )}
          <T variant="caption" tone="muted" style={{ fontVariant: ["tabular-nums"], lineHeight: 28 }}>
            {turnFooter(block)}
          </T>
        </View>
      );
    case "outside_repo_changed":
      return <OutsideChangeRow block={block} threadId={threadId} />;
    case "rotation":
      return <RotationRow block={block} threadId={threadId} />;
    case "reverted":
      return <SettledLine icon="arrow.uturn.backward" text={`Rewound to checkpoint ${block.commit.slice(0, 7)}`} />;
    case "visual":
      return <InlineVisual block={block} threadId={threadId} />;
    case "image":
      return <AgentImage block={block} threadId={threadId} />;
  }
});

const StreamedMarkdown = memo(function StreamedMarkdown({
  text,
  complete,
  active,
}: {
  text: string;
  complete: boolean;
  active: boolean;
}) {
  const shown = useStreamedText(text, complete, active);
  return <Markdown chat text={shown} />;
});
