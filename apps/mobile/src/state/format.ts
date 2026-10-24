// Whole-string plurals. Never build "1 helpers" from fragments; pick the form
// with the locale's plural rules and keep each phrase whole.

// Hermes may ship without Intl.PluralRules; English needs only one/other.
const rules: { select: (n: number) => string } =
  typeof Intl !== "undefined" && typeof Intl.PluralRules === "function"
    ? new Intl.PluralRules("en-US")
    : { select: (n) => (n === 1 ? "one" : "other") };
const grouped = (n: number) =>
  String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
  (n % 1 ? String(n % 1).slice(1) : "");

/** The forms of one phrase; `{n}` is replaced by the formatted count. */
export type PluralForms = { one: string; other: string };

/** `plural(3, { one: "{n} helper", other: "{n} helpers" })` → "3 helpers". */
export function plural(count: number, forms: PluralForms) {
  const form = rules.select(count) === "one" ? forms.one : forms.other;
  return form.replace("{n}", grouped(count));
}

/** Shorthand for nouns with a regular count phrase: `count(2, "agent")` → "2 agents". */
export function count(n: number, singular: string, pluralForm = `${singular}s`) {
  return plural(n, { one: `{n} ${singular}`, other: `{n} ${pluralForm}` });
}

/** A turn's reported cost: "$70.08", "<$0.01"; nothing for a missing, zero or nonsensical value. */
export function formatUsd(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  if (value < 0.005) return "<$0.01";
  const [whole, cents] = value.toFixed(2).split(".");
  return `$${grouped(Number(whole))}.${cents}`;
}

/**
 * The line under a finished turn: "12:51 · 3m 43s · $3.52". A turn that did not
 * complete says how it ended first. `clock` formats the time of day (the
 * device's convention); `duration` the time worked.
 */
export function turnFooterText(
  turn: { at: string; stopReason: string; durationMs: number | null | undefined; costUsd: number | null | undefined },
  clock: (date: Date) => string,
  duration: (ms: number) => string,
): string {
  const at = new Date(turn.at);
  const ending =
    turn.stopReason === "completed"
      ? null
      : turn.stopReason === "interrupted"
        ? "Stopped"
        : turn.stopReason === "error"
          ? "Failed"
          : "Turn limit reached";
  const worked = turn.durationMs != null && Number.isFinite(turn.durationMs) && turn.durationMs > 0 ? duration(turn.durationMs) : null;
  return [ending, Number.isNaN(at.getTime()) ? null : clock(at), worked, formatUsd(turn.costUsd)].filter(Boolean).join(" · ");
}

/** "Ann", "Ann and Bo", "Ann, Bo and Cy", "Ann, Bo and 2 others": distinct names, in order. */
export function nameList(names: readonly string[], max = 2): string {
  const unique = [...new Set(names)];
  if (unique.length <= max + 1) {
    if (unique.length < 2) return unique[0] ?? "";
    return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
  }
  return `${unique.slice(0, max).join(", ")} and ${plural(unique.length - max, { one: "{n} other", other: "{n} others" })}`;
}
