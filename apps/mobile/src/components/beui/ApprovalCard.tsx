// Native adaptation of BeUI ApprovalCard (MIT): https://beui.dev/r/approval-card/raw
// Controlled answers, clamped step navigation, selection semantics, and progress.
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { Button, Field, Icon, T, Tap, styles } from "../../ui/primitives";
import { useTheme } from "../../ui/theme";
export function QuestionChoices({
  title,
  options,
  selected,
  multiple = false,
  onChange,
  disabled = false,
}: {
  disabled?: boolean;
  title: string;
  options: { label: string; description?: string }[];
  selected: string[];
  multiple?: boolean;
  onChange: (values: string[]) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <T variant="label">{title}</T>
      {multiple && (
        <T variant="caption" tone="secondary">
          Select all that apply.
        </T>
      )}
      {options.map((option) => (
        <Tap
          disabled={disabled}
          key={option.label}
          selected={selected.includes(option.label)}
          label={option.label}
          onPress={() => {
            onChange(
              multiple
                ? selected.includes(option.label)
                  ? selected.filter((v) => v !== option.label)
                  : [...selected, option.label]
                : [option.label],
            );
            void Haptics.selectionAsync();
          }}
          style={[
            styles.line,
            {
              alignItems: "flex-start",
              padding: 14,
              borderRadius: 15,
              borderWidth: 1,
              borderColor: selected.includes(option.label)
                ? colors.accent
                : colors.line,
              backgroundColor: selected.includes(option.label)
                ? colors.accentSoft
                : undefined,
            },
          ]}
        >
          <Icon
            name={
              selected.includes(option.label)
                ? multiple
                  ? "checkmark.square.fill"
                  : "checkmark.circle.fill"
                : multiple
                  ? "square"
                  : "circle"
            }
            size={18}
            color={
              selected.includes(option.label) ? colors.accent : colors.muted
            }
          />
          <View style={{ flex: 1, gap: 4 }}>
            <T variant="label">{option.label}</T>
            {option.description && (
              <T variant="caption" tone="secondary">
                {option.description}
              </T>
            )}
          </View>
        </Tap>
      ))}
    </View>
  );
}

export type CardQuestion = {
  id: string;
  title: string;
  options: { label: string; description?: string }[];
  multiple?: boolean;
  custom?: boolean;
  secret?: boolean;
};
export type CardAnswer = { selected: string[]; custom: string };
export function ApprovalCard({
  questions,
  answers,
  onChange,
  onSubmit,
  busy,
}: {
  questions: CardQuestion[];
  answers: Record<string, CardAnswer>;
  onChange: (id: string, answer: CardAnswer) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  const [step, setStep] = useState(0);
  const current = Math.min(step, questions.length);
  const question = questions[current];
  const answer = question
    ? (answers[question.id] ?? { selected: [], custom: "" })
    : null;
  const complete = (q: CardQuestion) =>
    !!answers[q.id]?.selected.length || !!answers[q.id]?.custom.trim();
  const { colors } = useTheme();
  return (
    <View style={{ gap: 16 }}>
      <View style={styles.spread}>
        <T variant="caption" tone="secondary">
          {question
            ? `Question ${current + 1} of ${questions.length}`
            : "Review your answers"}
        </T>
        <View style={[styles.line, { gap: 4 }]}>
          {questions.map((q, i) => (
            <View
              key={q.id}
              style={{
                width: i === current ? 16 : 5,
                height: 5,
                borderRadius: 3,
                backgroundColor:
                  complete(q) || i === current ? colors.accent : colors.line,
              }}
            />
          ))}
        </View>
      </View>
      <Animated.View
        key={question?.id ?? "review"}
        entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
        style={{ gap: 12 }}
      >
        {question && answer ? (
          <>
            <QuestionChoices
              disabled={busy}
              title={question.title}
              options={question.options}
              multiple={question.multiple}
              selected={answer.selected}
              onChange={(selected) =>
                onChange(question.id, {
                  selected,
                  custom: question.multiple ? answer.custom : "",
                })
              }
            />
            {(question.custom || !question.options.length) && (
              <Field
                label={
                  question.options.length ? "Or write an answer" : "Your answer"
                }
                value={answer.custom}
                editable={!busy}
                secureTextEntry={question.secret}
                multiline={!question.secret}
                onChangeText={(custom) =>
                  onChange(question.id, {
                    selected: question.multiple ? answer.selected : [],
                    custom,
                  })
                }
              />
            )}
          </>
        ) : (
          questions.map((q, i) => (
            <Tap
              key={q.id}
              label={`Edit answer: ${q.title}`}
              disabled={busy}
              onPress={() => setStep(i)}
              style={{ paddingVertical: 8, gap: 5 }}
            >
              <T variant="label">{q.title}</T>
              <T variant="caption" tone="secondary">
                {q.secret
                  ? "Answer hidden"
                  : [
                      ...(answers[q.id]?.selected ?? []),
                      answers[q.id]?.custom ?? "",
                    ]
                      .filter(Boolean)
                      .join(", ")}
              </T>
              <T variant="caption" tone="accent">
                Edit answer
              </T>
            </Tap>
          ))
        )}
      </Animated.View>
      <View style={[styles.line, { gap: 12 }]}>
        {current > 0 && (
          <Button
            secondary
            disabled={busy}
            onPress={() => setStep(current - 1)}
          >
            Back
          </Button>
        )}
        <View style={{ flex: 1 }}>
          <Button
            busy={busy}
            disabled={
              question ? !complete(question) : !questions.every(complete)
            }
            onPress={() => (question ? setStep(current + 1) : onSubmit())}
          >
            {question
              ? current === questions.length - 1
                ? "Review answers"
                : "Continue"
              : "Send answers"}
          </Button>
        </View>
      </View>
    </View>
  );
}
