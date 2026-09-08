import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Linking, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
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
import { useTheme } from "../ui/theme";

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
  const { colors } = useTheme();
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
    <View
      style={{
        backgroundColor: colors.surface,
        padding: 18,
        borderRadius: 22,
        gap: 20,
      }}
    >
      <T variant="heading">A quick question</T>
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
    </View>
  );
}
export function ApprovalPanel({ approval }: { approval: ApprovalRequest }) {
  const { colors } = useTheme();
  const input = record(approval.input);
  const connector = connectorApproval(approval);
  const questions = questionsFor(approval);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
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
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(140)}
      style={{
        padding: 18,
        borderRadius: 22,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.line,
        gap: 16,
      }}
    >
      <View style={styles.line}>
        <Icon
          name={userInput ? "text.bubble" : "hand.raised"}
          size={19}
          color={colors.accent}
        />
        <T variant="heading">
          {userInput ? "Question from agent" : "Approval needed"}
        </T>
      </View>
      {(connector || approval.summary !== approval.tool_name) && (
        <T>
          {connector
            ? `${connector.connector} wants to use ${connector.app ?? "an app on your computer"}.`
            : approval.summary}
        </T>
      )}
      {connector?.subtitle && (
        <T variant="caption" tone="secondary">
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
                setSelected((s) => ({ ...s, [id]: answer.selected }));
                setCustom((c) => ({ ...c, [id]: answer.custom }));
              }}
              onSubmit={submit}
            />
          )}
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
              secondary
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
          <Tap
            label={details ? "Hide request details" : "View request details"}
            onPress={() => setDetails(!details)}
          >
            <T variant="caption" tone="secondary">
              {details ? "Hide details" : "View request details"}
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
            <Button
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
            secondary
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
                secondary
                disabled={busy}
                onPress={() => void respond({ decision: "deny" })}
              >
                Deny
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button
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
                variant="caption"
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
    </Animated.View>
  );
}
