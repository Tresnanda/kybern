// Antigravity (`agy`) copy and commands the clients share (ADE-111). Words are fixed by the spec so every surface says the same thing.

/** Under a locked permission picker. */
export const ANTIGRAVITY_FULL_ACCESS_NOTE = "Antigravity only runs in Full access";

/** Before the first Google sign-in on a device. */
export const ANTIGRAVITY_SIGN_IN_NOTICE = "Google says using Antigravity through other apps on a personal plan may get your account suspended.";

/** The terminal command that signs Antigravity in. */
export const ANTIGRAVITY_LOGIN_COMMAND = "agy";

/** The one-line installer a terminal sheet types and never runs. `platform` is Node's `process.platform`. */
export function antigravityInstallCommand(platform: string): string {
  return platform === "win32"
    ? "irm https://antigravity.google/cli/install.ps1 | iex"
    : "curl -fsSL https://antigravity.google/cli/install.sh | bash";
}

/** The environment variable that signs Antigravity in with a Gemini API key. */
export const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";
