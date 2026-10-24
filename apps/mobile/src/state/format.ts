// Whole-string plurals. Never build "1 helpers" from fragments; pick the form
// with the locale's plural rules and keep each phrase whole.

const rules = new Intl.PluralRules("en-US");

/** The forms of one phrase; `{n}` is replaced by the formatted count. */
export type PluralForms = { one: string; other: string };

/** `plural(3, { one: "{n} helper", other: "{n} helpers" })` → "3 helpers". */
export function plural(count: number, forms: PluralForms) {
  const form = rules.select(count) === "one" ? forms.one : forms.other;
  return form.replace("{n}", count.toLocaleString("en-US"));
}

/** Shorthand for nouns with a regular count phrase: `count(2, "agent")` → "2 agents". */
export function count(n: number, singular: string, pluralForm = `${singular}s`) {
  return plural(n, { one: `{n} ${singular}`, other: `{n} ${pluralForm}` });
}
