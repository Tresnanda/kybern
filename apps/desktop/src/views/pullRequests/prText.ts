// Text roles for the pull request surfaces. Always the app font variables, never fixed px.
export const PR_TITLE_TEXT =
  "text-[length:calc(var(--app-font-size-ui-lg,13px)*1.6)] leading-[1.2] font-semibold tracking-[-0.01em] [text-wrap:balance]"
export const PR_SECTION_TEXT =
  "text-[length:var(--app-font-size-ui-sm,11px)] font-medium text-muted-foreground"
export const PR_BODY_TEXT = "text-[length:var(--app-font-size-ui-lg,13px)]"
export const PR_META_TEXT = "text-[length:var(--app-font-size-ui,12px)]"
export const PR_FINE_TEXT = "text-[length:var(--app-font-size-ui-sm,11px)]"
// Measured in the real light theme, /70 rendered ink at 0.42 alpha on white (2.7:1).
// /80 keeps quiet metadata at 3.2:1 light and 4.3:1 dark (AC18 asks for 3:1).
export const PR_QUIET_INK = "text-muted-foreground/80"
