// "Couldn't …" as a toast, for a command or background job that failed (never for a page that failed to load). One call: the error,
// what the person was doing, and optionally how to try again. The computer it ran on is named from the call's params.
import { problemFor } from "../state/runtime";
import type { PhoneContext } from "../state/problems";
import type { MachineId } from "../state/protocol";
import { showProblemToast } from "./Problem";

export function failedToast(
  error: unknown,
  action: string | PhoneContext,
  options: { retry?: () => void; params?: unknown; machineId?: MachineId } = {},
) {
  showProblemToast(problemFor(error, action, options), options.retry);
}
