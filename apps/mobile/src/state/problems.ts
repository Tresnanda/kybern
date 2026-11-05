// Actionable errors on the phone: any failure, in plain words, with the fix this phone can offer. The words come from the shared
// `describeProblem` (`packages/kybern-client/src/problems.ts`); this layer adds what only the phone knows. It never installs,
// signs in or updates anything on a computer, so a fix that needs the computer says so and names it ("Install it on SatyaMas,
// then check again"), and the button is the check. Pure: `ui/Problem.tsx` draws the model, `runtime.errorText` flattens it to a
// sentence for the places that still hold a string.
import { describeProblem, plainSentence, toolLabel, type ProblemView } from "../../../../packages/kybern-client/src/problems.ts";
import { ghProblem } from "../../../../packages/kybern-client/src/prReview.ts";
import { errorMessage, problemOf } from "../../../../packages/kybern-client/src/problem.ts";
import { shortMachineName } from "../../../../packages/kybern-client/src/forkMachine.ts";
import type { ProblemKind } from "../../../../packages/kybern-client/src/types.ts";
import type { IconName } from "../ui/icons.ts";

export type ProblemTone = "info" | "warning" | "danger" | "neutral";

/** What the phone itself can do about a problem. A fix that runs on the computer is words, not a button. */
export type ProblemActionId = "retry" | "open_machines";

export interface ProblemButton {
  id: ProblemActionId;
  label: string;
}

export interface ProblemModel {
  kind: ProblemKind;
  /** What it is about, when the kind alone does not say: "gh", "github_remote", "machine". */
  subject?: string;
  tone: ProblemTone;
  icon: IconName;
  /** The outcome or the fix, sentence case, no final period. */
  title: string;
  /** One sentence on what to do next. */
  body: string;
  /** At most two, in order: the first leads. Only the ones this phone can run. */
  actions: ProblemButton[];
  /** The technical text, verbatim, behind Show details and Copy. */
  detail: string;
}

export interface PhoneContext {
  /** A verb phrase for "Couldn't …": "send your message", "load the changes". */
  action: string;
  /** What a setup fix unlocks, for "Install GitHub CLI to …"; defaults to `action`. */
  goal?: string;
  /** The computer the call ran on. Unset: "your computer". */
  machine?: string;
  /** Said last when the person's work is safe: "Your message is saved." */
  note?: string;
}

/** The tone and glyph a kind of problem wears. */
export function problemLook(kind: ProblemKind): { tone: ProblemTone; icon: IconName } {
  switch (kind) {
    case "tool_missing": return { tone: "info", icon: "terminal" };
    case "update_needed": return { tone: "info", icon: "arrow.down.circle" };
    case "signed_out":
    case "permission": return { tone: "warning", icon: "lock" };
    case "conflict":
    case "invalid_input": return { tone: "warning", icon: "exclamationmark.triangle" };
    case "offline": return { tone: "neutral", icon: "wifi.slash" };
    case "not_found": return { tone: "neutral", icon: "questionmark.circle" };
    default: return { tone: "danger", icon: "exclamationmark.triangle" };
  }
}

const MACHINES: ProblemButton = { id: "open_machines", label: "Open machines" };

/** Appends `note` (the person's work is safe) to a sentence that already ends with a period. */
const withNote = (body: string, note?: string) => (note ? `${body} ${note}` : body);

/** A request that never got an answer (the phone's fetch failing, a timeout, a blocked connection) is the computer being out of reach. */
const TRANSPORT = /network request failed|fetch failed|app transport security|abort|timed? ?out|failed to connect|connection (?:was )?(?:lost|reset)/i;

function sortedTransport(error: unknown): unknown {
  if (problemOf(error)) return error;
  const message = errorMessage(error);
  if (!TRANSPORT.test(message)) return error;
  return Object.assign(new Error(message), { data: { problem: { kind: "offline", detail: message, retryable: true } } });
}

/** The words, look and phone buttons for `error`, whatever it is. */
export function problemModel(rawError: unknown, context: PhoneContext): ProblemModel {
  const error = sortedTransport(rawError);
  const name = context.machine ? shortMachineName(context.machine) : undefined;
  const where = name || "your computer";
  const view = describeProblem(error, { action: context.action, goal: context.goal, ...(name ? { machine: name } : {}) });
  const retry = [view.action, view.secondary].find((action) => action?.id === "retry");
  const retryButton: ProblemButton[] = retry ? [{ id: "retry", label: retry.label }] : [];
  const make = (title: string, body: string, actions: ProblemButton[], kind: ProblemKind = view.kind): ProblemModel => ({
    kind,
    ...(view.subject ? { subject: view.subject } : {}),
    ...problemLook(kind),
    title,
    body: withNote(body, context.note),
    actions: actions.slice(0, 2),
    detail: view.detail,
  });

  switch (view.kind) {
    case "tool_missing":
      // Mobile never installs remotely: the fix is on the computer, and the button checks again.
      if (view.subject) return make(view.title, `Install it on ${where}, then check again.`, retryButton);
      break;
    case "signed_out":
      if (view.subject === "machine") return make(`Pair ${name ?? "this computer"} again`, `${name ?? "That computer"} no longer recognizes this phone. Pair it again.`, [MACHINES]);
      if (view.subject === "gh") return make(view.title, `Sign in to GitHub on ${where}, then check again.`, retryButton);
      return make(view.title, `Sign in on ${where}, then try again.`, retryButton);
    case "permission":
      if (view.subject === "machine") return make(`This phone can't verify ${name ?? "that computer"}`, "Its secure identity changed or isn't trusted yet. Check it before connecting.", [MACHINES]);
      break;
    case "not_found":
      if (view.subject === "github_remote") return make(view.title, `Add a GitHub remote to this project on ${where}, then check again.`, retryButton);
      break;
    case "update_needed":
      return make(view.title, `Update Kybern on ${where}, then try again.`, [{ id: "retry", label: "Try again" }]);
    case "offline":
      if (!view.subject && !name) return make("Can't reach your computer", "Check your connection and that it is awake. Kybern keeps trying.", [...retryButton, MACHINES]);
      return make(view.title, view.body, [...retryButton, MACHINES]);
    case "internal":
      if (view.subject === "clock") return make("Check this phone's clock", `This phone and ${where} disagree about the time. Turn on automatic time on both, then try again.`, retryButton);
      break;
  }
  return make(view.title, view.body, retryButton);
}

/** The model as one or two plain sentences, for text that cannot hold buttons. */
export function problemText(model: ProblemModel): string {
  // The "copy the details" advice only makes sense where Show details is.
  const body = model.body.replace(/^Try again\. If it keeps happening, copy the details and report them\.?/, "Try again.");
  return `${model.title}. ${body}`.replace(/\.+$/, ".");
}

/** A pull request or Actions failure, sorted by `ghProblem`: a missing gh, a signed-out gh and a project with no GitHub remote read the same everywhere. */
export function prProblemModel(error: unknown, context: PhoneContext): ProblemModel {
  const problem = ghProblem(error);
  return problemModel(Object.assign(new Error(errorMessage(error)), { data: { problem } }), context);
}

/** A string is the action alone: `errorText(e, "send your message")`. */
export function contextOf(context: string | PhoneContext | undefined): PhoneContext {
  return typeof context === "string" ? { action: context } : (context ?? { action: "finish that" });
}

/** An error's text, or a model's, as a sentence. */
export function sentenceOf(error: unknown, context?: string | PhoneContext): string {
  return problemText(problemModel(error, contextOf(context)));
}

/** A stored reason (an outbox item's last error) when it already reads as a plain sentence; else nothing, never the raw text. */
export function plainReason(text: string | null | undefined): string | undefined {
  return text && plainSentence(text) ? text.trim() : undefined;
}

export { toolLabel };
export type { ProblemView };
