import type { ChildPhase } from "../../../../../packages/kybern-client/src/delegations.ts"

/** The word beside a glyph. A failure and a wait take a tint; every other state stays neutral. */
export function phaseWordClass(phase: ChildPhase): string {
  switch (phase) {
    case "failed":
      return "text-destructive"
    case "waiting":
      return "text-amber-700 dark:text-amber-300/90"
    default:
      return "text-foreground/55"
  }
}
