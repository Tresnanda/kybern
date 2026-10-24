import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { Linking, View } from "react-native";
import {
  array,
  connectorApproval,
  connectorApprovalResponse,
  isUserInput,
  questionResponse,
  questionsFor,
  record,
  string,
} from "../../../../packages/kybern-client/src/userInput";
import {
  type ApprovalDecision,
  type ApprovalRequest,
  type AsyncQuestionRequest,
} from "../state/protocol";
import { errorText, loadThread, refresh, rpc } from "../state/runtime";
import { ApprovalCard, QuestionChoices } from "../components/beui/ApprovalCard";
import { secretRequestInput } from "../../../../packages/kybern-client/src/secretRequest";
import { SecretRequestCard } from "./SecretRequest";
import { briefProposalInput, leadGitCardInput, settingsProposalInput } from "../../../../packages/kybern-client/src/coordinatorCards";
import { BriefProposalCard, GitApprovalCard, SettingsProposalCard } from "./CoordinatorCards";
import {
  deadlineState,
  defaultOption,
  formatCountdown,
  loginRequestInput,
  permissionRequestInput,
  promptRequestInput,
  questionDeadline,
} from "../../../../packages/kybern-client/src/requestCards";
import { pickRequestInput } from "../../../../packages/kybern-client/src/pickRequest";
import { answerKind, answerStubTitle, visualAnswerInput, ANSWER_COPY } from "../../../../packages/kybern-client/src/visualAnswer";
import { displayCommand } from "../../../../packages/kybern-client/src/displayCommand";
import { commandOf } from "../../../../packages/kybern-client/src/signIn";
import { toolLine, unwrapShellCommand } from "../../../../packages/kybern-client/src/toolActivity";
import type { QuestionDeadline } from "../state/protocol";
import { actOnRequest, useRequestProgress } from "../state/requestProgress";
import {
  agentFor,
  LoginRequestCard,
  PermissionRequestCard,
  PickRequestCard,
  PromptRequestCard,
  RequestCardShell,
  RequestHeader,
  respondApproval,
} from "./RequestCards";
export { QuestionChoices } from "../components/beui/ApprovalCard";
import { Code } from "../ui/Markdown";
import {
  Button,
  ErrorBanner,
  Field,
  Icon,
  T,
  Tap,
  styles,
} from "../ui/primitives";
import { radius, space, useTheme } from "../ui/theme";

export function AsyncQuestions({
  request,
  threadId,
}: {
  request: AsyncQuestionRequest;
  threadId: string;
}) {
  const [answers, setAnswers] = useState<string[]>(
    request.questions.map(() => ""),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function send() {
    setBusy(true);
    try {
      await rpc("threads.answer", {
        thread_id: threadId,
        request_id: request.id,
        answers,
      });
      await loadThread(threadId);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <RequestCardShell label="A quick question">
      <RequestHeader icon="text.bubble" title="A quick question" />
      <ApprovalCard
        busy={busy}
        questions={request.questions.map((q, i) => ({
          id: String(i),
          title: q.title,
          options: q.options.map((label) => ({ label })),
          custom: true,
        }))}
        answers={Object.fromEntries(
          answers.map((value, i) => [
            String(i),
            request.questions[i]?.options.includes(value)
              ? { selected: [value], custom: "" }
              : { selected: [], custom: value },
          ]),
        )}
        onChange={(id, answer) =>
          setAnswers((prev) =>
            prev.map((v, i) =>
              String(i) === id ? answer.custom || answer.selected[0] || "" : v,
            ),
          )
        }
        onSubmit={() => void send()}
      />
      <ErrorBanner error={error} />
    </RequestCardShell>
  );
}
export function ApprovalPanel({ approval }: { approval: ApprovalRequest }) {
  // A secret request has its own card: a masked field, and the value never stays here.
  const secret = secretRequestInput(approval);
  if (secret) return <SecretRequestCard approval={approval} input={secret} />;
  // The Coordinator's own cards: the brief and settings proposals, and git approvals.
  const brief = briefProposalInput(approval);
  if (brief) return <BriefProposalCard approval={approval} input={brief} />;
  const settings = settingsProposalInput(approval);
  if (settings) return <SettingsProposalCard approval={approval} input={settings} />;
  const git = leadGitCardInput(approval);
  if (git) return <GitApprovalCard approval={approval} input={git} />;
  // The daemon's summoned cards (sign-in, password prompt, macOS permission, point for me).
  const login = loginRequestInput(approval);
  if (login) return <LoginRequestCard approval={approval} input={login} />;
  const prompt = promptRequestInput(approval);
  if (prompt) return <PromptRequestCard approval={approval} input={prompt} />;
  const permission = permissionRequestInput(approval);
  if (permission) return <PermissionRequestCard approval={approval} input={permission} />;
  const pick = pickRequestInput(approval);
  if (pick) return <PickRequestCard approval={approval} input={pick} />;
  // A visual that asks is answered under the visual; this stub stands in when it is not loaded.
  if (visualAnswerInput(approval)) return <VisualAnswerStub approval={approval} />;
  return <DecisionPanel approval={approval} />;
}

function VisualAnswerStub({ approval }: { approval: ApprovalRequest }) {
  const input = visualAnswerInput(approval)!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <RequestCardShell>
      <RequestHeader icon="viewfinder" title={answerStubTitle(answerKind(input.schema ?? null), agentFor(approval.thread_id), input.title)} meta="Scroll up to the visual to choose, or skip it." />
      <ErrorBanner error={error} />
      <Button
        busy={busy}
        onPress={() => {
          setBusy(true);
          respondApproval(approval, { decision: "deny" }).catch((e) => {
            setError(errorText(e) || ANSWER_COPY.sendError);
            setBusy(false);
          });
        }}
      >
        {ANSWER_COPY.skip}
      </Button>
    </RequestCardShell>
  );
}

/** Pause the daemon's countdown while the reader interacts; resume 5 s after the last touch. */
function usePauseController(approvalId: string, enabled: boolean) {
  const paused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const send = (action: "pause" | "resume") => void actOnRequest(approvalId, action).catch(() => {});
  const resume = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (paused.current) {
      paused.current = false;
      send("resume");
    }
  };
  const latest = useRef(resume);
  latest.current = resume;
  // A card that leaves while paused must not hold the deadline forever.
  useEffect(() => () => latest.current(), []);
  return () => {
    if (!enabled) return;
    if (!paused.current) {
      paused.current = true;
      send("pause");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current(), 5000);
  };
}

/** "Going with “Option A” in 9:41 unless you pick", or paused, or held. Calm to the end: no red. */
function DeadlineLine({ approvalId, deadline, chosen }: { approvalId: string; deadline: QuestionDeadline; chosen: string | null }) {
  const { colors } = useTheme();
  const progress = useRequestProgress(approvalId);
  const [now, setNow] = useState(Date.now());
  const [holding, setHolding] = useState(false);
  useEffect(() => {
    if (progress?.phase === "held") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [progress?.phase]);
  const state = deadlineState(deadline, progress, now);
  if (state.phase === "held")
    return (
      <T variant="footnote" tone="muted">
        Kybern waits for your answer.
      </T>
    );
  const time = formatCountdown(state.remainingMs);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }} accessibilityRole="timer" accessibilityLiveRegion="none">
      <Icon name={state.phase === "paused" ? "pause.circle" : "clock"} size={14} color={colors.secondary} />
      <T variant="footnote" tone="secondary" style={{ flex: 1, fontVariant: ["tabular-nums"] }}>
        {state.phase === "paused"
          ? `Paused while you choose. ${time} left`
          : `Going with ${chosen ? `“${chosen}”` : "the defaults"} in ${time} unless you pick`}
      </T>
      <Tap
        label="Wait for me"
        disabled={holding}
        onPress={() => {
          setHolding(true);
          void actOnRequest(approvalId, "hold").catch(() => setHolding(false));
        }}
        style={{ alignItems: "center", justifyContent: "center" }}
      >
        <T variant="footnote" tone="accent">
          Wait for me
        </T>
      </Tap>
    </View>
  );
}
function DecisionPanel({ approval }: { approval: ApprovalRequest }) {
  const { colors } = useTheme();
  const input = record(approval.input);
  const connector = connectorApproval(approval);
  const questions = questionsFor(approval);
  const deadline = questionDeadline(approval);
  // A question with a deadline starts on the option it falls back to.
  const [selected, setSelected] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      questions.flatMap((q) => {
        const index = defaultOption(deadline, q);
        return index >= 0 ? [[q.id, [q.options[index]!.label]]] : [];
      }),
    ),
  );
  const touch = usePauseController(approval.id, !!deadline);
  const chosenDefault = deadline && questions.length === 1 ? (deadline.defaults[questions[0]!.title] ?? null) : null;
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [value, setValue] = useState(string(input.prefill ?? input.value));
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [details, setDetails] = useState(false);
  const [urlOpened, setUrlOpened] = useState(false);
  const userInput = isUserInput(approval) && !connector;
  const elicitation = approval.tool_name === "mcp_elicitation";
  const isUrl = elicitation && input.mode === "url";
  const schema = record(input.requestedSchema ?? input.requested_schema);
  const properties = record(schema.properties);
  async function respond(decision: ApprovalDecision) {
    setBusy(true);
    setError("");
    try {
      await rpc("approvals.respond", { approval_id: approval.id, ...decision });
      await Promise.all([refresh(), loadThread(approval.thread_id)]);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function submit() {
    try {
      let response: unknown;
      if (questions.length)
        response = questionResponse(
          approval,
          questions.map((q) =>
            custom[q.id]?.trim()
              ? [
                  ...(q.multiple ? (selected[q.id] ?? []) : []),
                  custom[q.id]!.trim(),
                ]
              : (selected[q.id] ?? []),
          ),
        );
      else if (elicitation) {
        const content: Record<string, unknown> = {};
        for (const [key, raw] of Object.entries(properties)) {
          const spec = record(raw);
          const v =
            fields[key] ??
            (spec.default === undefined
              ? ""
              : typeof spec.default === "object"
                ? JSON.stringify(spec.default)
                : String(spec.default));
          if (!v && array(schema.required).includes(key))
            throw new Error(`Enter ${string(spec.title) || key} to continue.`);
          if (!v) continue;
          if (spec.type === "boolean") content[key] = v === "true";
          else if (spec.type === "number" || spec.type === "integer") {
            const n = Number(v);
            if (
              !Number.isFinite(n) ||
              (spec.type === "integer" && !Number.isInteger(n))
            )
              throw new Error(`Enter a valid number for ${key}.`);
            content[key] = n;
          } else if (spec.type === "object" || spec.type === "array")
            content[key] = JSON.parse(v);
          else content[key] = v;
        }
        response = { action: "accept", ...(isUrl ? {} : { content }) };
      } else response = { value };
      void respond({ decision: "submit", response });
    } catch (e) {
      setError(errorText(e));
    }
  }
  const activity = toolLine({ id: approval.id, name: approval.tool_name, input: approval.input }, false);
  const command = activity.kind === "command" ? unwrapShellCommand(commandOf(approval.input)) : "";
  return (
    <RequestCardShell label={userInput ? "Question from agent" : "Approval needed"}>
      <RequestHeader
        icon={userInput ? "text.bubble" : "hand.raised"}
        title={userInput ? "Question from agent" : "Approval needed"}
      />
      {(connector || approval.summary !== approval.tool_name) && (
        <T>
          {connector
            ? `${connector.connector} wants to use ${connector.app ?? "an app on your computer"}.`
            : approval.summary}
        </T>
      )}
      {connector?.subtitle && (
        <T variant="footnote" tone="secondary">
          {connector.subtitle}
        </T>
      )}
      {userInput ? (
        <>
          {questions.length > 0 && (
            <ApprovalCard
              questions={questions}
              busy={busy}
              answers={Object.fromEntries(
                questions.map((q) => [
                  q.id,
                  {
                    selected: selected[q.id] ?? [],
                    custom: custom[q.id] ?? "",
                  },
                ]),
              )}
              onChange={(id, answer) => {
                touch();
                setSelected((s) => ({ ...s, [id]: answer.selected }));
                setCustom((c) => ({ ...c, [id]: answer.custom }));
              }}
              onSubmit={submit}
            />
          )}
          {deadline && <DeadlineLine approvalId={approval.id} deadline={deadline} chosen={chosenDefault} />}
          {approval.tool_name === "ui_select" && (
            <QuestionChoices
              title="Choose an option"
              options={array(input.options).map((o) => ({ label: String(o) }))}
              selected={[value]}
              onChange={(v) => setValue(v[0] ?? "")}
            />
          )}
          {(approval.tool_name === "ui_input" ||
            approval.tool_name === "ui_editor") && (
            <Field
              label="Your answer"
              value={value}
              onChangeText={setValue}
              multiline
              placeholder={string(input.placeholder)}
            />
          )}
          {elicitation &&
            !isUrl &&
            Object.entries(properties).map(([key, raw]) => {
              const spec = record(raw);
              const v =
                fields[key] ??
                (spec.default === undefined
                  ? ""
                  : typeof spec.default === "object"
                    ? JSON.stringify(spec.default)
                    : String(spec.default));
              const opts =
                spec.type === "boolean"
                  ? ["true", "false"]
                  : array(spec.enum).map(String);
              return opts.length ? (
                <QuestionChoices
                  key={key}
                  title={string(spec.title) || key}
                  options={opts.map((label) => ({ label }))}
                  selected={[v]}
                  onChange={(values) =>
                    setFields((f) => ({ ...f, [key]: values[0] ?? "" }))
                  }
                />
              ) : (
                <Field
                  key={key}
                  label={`${string(spec.title) || key}${array(schema.required).includes(key) ? "" : " (optional)"}`}
                  value={v}
                  onChangeText={(text) =>
                    setFields((f) => ({ ...f, [key]: text }))
                  }
                  multiline={spec.type === "array" || spec.type === "object"}
                  keyboardType={
                    spec.type === "number" || spec.type === "integer"
                      ? "numeric"
                      : "default"
                  }
                  placeholder={string(spec.description) || undefined}
                />
              );
            })}
          {isUrl && (
            <Button
              onPress={() => {
                const url = string(input.url);
                if (/^https?:\/\//i.test(url))
                  void Linking.openURL(url)
                    .then(() => setUrlOpened(true))
                    .catch((e) => setError(errorText(e)));
              }}
            >
              Open in browser
            </Button>
          )}
        </>
      ) : (
        <>
          {(command || activity.detail) && (
            <View style={{ borderRadius: radius.md, backgroundColor: colors.raised, paddingHorizontal: space.md, paddingVertical: space.sm, gap: space.xs }}>
              <T variant="footnote" tone="secondary" style={{ fontWeight: "500" }}>
                {command ? "Command" : activity.verb}
              </T>
              <T variant="code" selectable numberOfLines={details ? undefined : 6}>
                {command ? displayCommand(command).text : activity.detail}
              </T>
            </View>
          )}
          <Tap
            label={details ? "Hide input" : "Show input"}
            onPress={() => setDetails(!details)}
            expanded={details}
            style={{ alignSelf: "flex-start", justifyContent: "center", minHeight: 36 }}
          >
            <T variant="footnote" tone="accent">
              {details ? "Hide input" : "Show input"}
            </T>
          </Tap>
          {details && (
            <Code
              text={JSON.stringify(approval.input, null, 2)}
              language={approval.tool_name}
            />
          )}
        </>
      )}
      <ErrorBanner error={error} />
      {userInput ? (
        <>
          {!questions.length && (
            <Button role="prominent"
              busy={busy}
              disabled={isUrl && !urlOpened}
              onPress={() =>
                approval.tool_name === "ui_confirm"
                  ? void respond({
                      decision: "submit",
                      response: { confirmed: true },
                    })
                  : submit()
              }
            >
              {approval.tool_name === "ui_confirm" ? "Confirm" : "Send answer"}
            </Button>
          )}
          <Button
            disabled={busy}
            onPress={() => void respond({ decision: "deny" })}
          >
            Decline
          </Button>
        </>
      ) : (
        <>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Button
                disabled={busy}
                onPress={() => void respond({ decision: "deny" })}
              >
                Deny
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button role="prominent"
                busy={busy}
                onPress={() =>
                  void respond(
                    connector
                      ? {
                          decision: "submit",
                          response: connectorApprovalResponse(null),
                        }
                      : { decision: "allow_once" },
                  )
                }
              >
                Allow once
              </Button>
            </View>
          </View>
          {(!connector || connector.persist.includes("session")) && (
            <Tap
              label={
                connector
                  ? "Allow for this session"
                  : "Always allow this action"
              }
              disabled={busy}
              onPress={() =>
                void respond(
                  connector
                    ? {
                        decision: "submit",
                        response: connectorApprovalResponse("session"),
                      }
                    : { decision: "allow_always" },
                )
              }
            >
              <T
                variant="footnote"
                tone="secondary"
                style={{ textAlign: "center" }}
              >
                {connector
                  ? "Allow for this session"
                  : "Always allow this action"}
              </T>
            </Tap>
          )}
        </>
      )}
    </RequestCardShell>
  );
}
