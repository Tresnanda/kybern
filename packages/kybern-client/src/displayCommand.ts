// A shell command as a row shows it: the part that says what ran. Agents wrap commands in `cd <path> &&`, the `rtk`
// proxy and `2>&1 | tail -n 40`, and the drivers cut runtime-task titles at a fixed length; none of that helps a reader
// scanning a list of processes. Display only: the full command stays on the task, in a selectable block.
import { unwrapShellCommand } from "./toolActivity.ts";

/** Where the drivers cut a runtime task's title (first line, `chars().take(120)`): a source this long was probably cut. */
export const COMMAND_TITLE_LIMIT = 120;

export interface DisplayCommand {
  /** One line, whitespace collapsed; ends in "…" when the source was cut (by the driver, or by `max`). */
  text: string;
  /** The source was cut: the text is a prefix of the real command. */
  truncated: boolean;
}

export interface DisplayCommandOptions {
  /** Cut the text to this many characters. */
  max?: number;
  /** A source this long counts as cut by the driver; defaults to `COMMAND_TITLE_LIMIT`. */
  sourceLimit?: number;
}

// `cd /repo &&`, `cd "/a b";` and `pushd` hops before the real command.
const LEADING_CD = /^(?:cd|pushd)\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/;
// `2>&1 | tail -n 40`, `| head -50`, `2>&1 | tail`: output trimming the agent added, not part of the task.
const TRAILING_TRIM = /\s*(?:2>&1\s*)?\|\s*(?:tail|head)\b[^|;&]*$/;
// The same tail cut off mid-way by the driver (`… 2>&1 | ta`).
const TRAILING_TRIM_PARTIAL = /\s*2>&1\s*\|?\s*(?:t|ta|tai|h|he|hea)?$/;

/** The command a row names: wrappers, `rtk`, a leading `cd … &&` and a trailing `2>&1 | tail …` removed, whitespace collapsed. */
export function displayCommand(source: string, options: DisplayCommandOptions = {}): DisplayCommand {
  const { max, sourceLimit = COMMAND_TITLE_LIMIT } = options;
  const flat = unwrapShellCommand(source).replace(/\s+/g, " ").trim();
  const cutBySource = source.length >= sourceLimit;
  let text = flat;
  for (let pass = 0; pass < 4 && LEADING_CD.test(text); pass += 1) {
    const rest = text.replace(LEADING_CD, "");
    if (!rest) break;
    text = rest;
  }
  text = text.replace(/^rtk\s+/, "");
  const trimmed = text.replace(TRAILING_TRIM, "");
  text = trimmed || text;
  if (cutBySource) text = text.replace(TRAILING_TRIM_PARTIAL, "") || text;
  let truncated = cutBySource;
  if (max !== undefined && text.length > max) {
    text = `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
    truncated = true;
  } else if (cutBySource && !text.endsWith("…")) {
    text = `${text}…`;
  }
  return { text, truncated };
}
