// "A hook couldn't check this action": Claude Code reports each PreToolUse hook that gave no verdict once per session, so
// several failing hooks used to draw one identical row each. The Claude driver puts what it knows about each hook in the
// notice's `data.hook_no_verdict` (Claude Code's own fields, plus `hook_name`, `command` and `error` from the hook's failure
// when it was seen). The projection folds the hooks of one call into one notice row (`hooks` on the block); the title, the one
// sentence of help and the details text are worded here, so desktop and mobile say the same thing.
import type { JsonValue } from "./types.ts"

/** One hook that gave no answer. */
export interface HookWarning {
  /** The call it did not check. */
  toolUseId?: string
  timedOut: boolean
  /** The plugin's name, for a hook a plugin brought; absent for one in the person's own settings. */
  plugin?: string
  /** The hook's command, when Claude Code's error names it. */
  command?: string
  /** Claude Code's own text on why the hook failed. */
  error?: string
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined)

/** The hook a notice's `data` describes, or null for any other notice. */
export function hookWarningOf(data: JsonValue | null | undefined): HookWarning | null {
  const warning = data && typeof data === "object" ? (data as Record<string, unknown>).hook_no_verdict : undefined
  if (!warning || typeof warning !== "object") return null
  const w = warning as Record<string, unknown>
  const id = text(w.plugin_id)
  return {
    ...(text(w.tool_use_id) ? { toolUseId: text(w.tool_use_id) } : {}),
    timedOut: w.timed_out === true,
    ...(id ? { plugin: id.split("@")[0] } : {}),
    ...(text(w.command) ? { command: text(w.command) } : {}),
    ...(text(w.error) ? { error: text(w.error) } : {}),
  }
}

/** The row's headline. */
export function hookWarningTitle(count: number): string {
  return count > 1 ? `${count} hooks couldn't check this action` : "A hook couldn't check this action"
}

/** A hook from the person's own Claude settings that uses `${CLAUDE_PLUGIN_ROOT}`, which only a plugin's hooks have. */
const pluginOnlyVariable = (hook: HookWarning) => !hook.plugin && !!hook.error?.includes("CLAUDE_PLUGIN_ROOT")

/** One sentence on the fix, when the cause is one we recognise; otherwise null. Nothing here edits settings. */
export function hookWarningHelp(hooks: readonly HookWarning[]): string | null {
  const n = hooks.filter(pluginOnlyVariable).length
  if (n === 0) return null
  if (n === hooks.length) {
    return n === 1
      ? "This hook is in your Claude settings but uses a plugin-only variable. Remove it from settings.json."
      : "These hooks are in your Claude settings but use a plugin-only variable. Remove them from settings.json."
  }
  return "Some of these hooks are in your Claude settings but use a plugin-only variable. Remove them from settings.json."
}

/** What "Show details" lists: each hook's source, command, whether it timed out, and Claude Code's own error text. */
export function hookWarningDetails(hooks: readonly HookWarning[]): string {
  return hooks
    .map((hook, i) => {
      const lines = [`${hooks.length > 1 ? `${i + 1}. ` : ""}${hook.plugin ? `${hook.plugin} plugin` : "Your settings"}`]
      // Claude Code's error usually ends with the command; do not say it twice.
      if (hook.command && !hook.error?.includes(hook.command)) lines.push(`Command: ${hook.command}`)
      if (hook.timedOut) lines.push("Timed out")
      if (hook.error) lines.push(hook.error)
      return lines.join("\n")
    })
    .join("\n\n")
}
