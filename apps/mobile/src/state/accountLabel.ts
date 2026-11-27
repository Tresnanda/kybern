/**
 * "Default", "Work": an account instance as a row value. The instance `default` is the computer's own login. For a new chat
 * choosing it follows the defaults; a thread that already ran keeps that login whatever the default is now, so it is
 * named for what it is.
 */
export const accountLabel = (instance: string, ran = false): string =>
  instance === "default" ? (ran ? "CLI account" : "Default") : instance.charAt(0).toUpperCase() + instance.slice(1);
