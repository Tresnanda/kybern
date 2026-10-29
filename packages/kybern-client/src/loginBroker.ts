// The login broker, for clients (ADE-86 S4; design §9.4). Plain functions over the daemon's `login.broker.*` answers,
// shared by every client:
//
// - the words for where a harness' sign-in comes from ("Signs in through VPS", "VPS is offline · Sign in here instead");
// - the fallback "Sign in on all machines": each machine's own sign-in, one after another, through that machine's
//   `providers.accounts.login.*`, with a per-machine checklist. It is also what a user does when no broker is set.
//
// Nothing here sees a token: the daemons seal what they lend and the answers carry names, states and sentences.
import type {
  AccountLogin,
  AccountLoginMode,
  BrokerLoginState,
  BrokerProviderStatus,
  LendableAccount,
  LoginBrokerStatus,
  MachineId,
  ProviderKind,
  ProviderInstance,
} from "./types.ts";

/**
 * Harnesses with an account sign-in a broker can lend. omp, OpenCode and pi run on the model providers
 * configured in them and have no sign-in of their own, so they never get a sign-in row; their provider
 * keys are pushed to every machine instead (§9.3).
 */
export const BROKER_KINDS: readonly ProviderKind[] = ["claude-code", "codex"];

export const supportsBroker = (kind: ProviderKind): boolean => BROKER_KINDS.includes(kind);

// ---- words ----

/** What one harness' row says, and the one action it offers. */
export interface BrokerLine {
  /** Always shown. */
  text: string;
  /** The action the row offers, if any. */
  action?: "use_broker" | "sign_in_here" | "sign_in_on_broker";
  /** The label of that action. */
  actionLabel?: string;
  tone: "ok" | "wait" | "problem" | "quiet";
}

export function brokerLine(status: BrokerProviderStatus, brokerName: string | undefined, harness: string): BrokerLine {
  const broker = brokerName || "the login broker";
  switch (status.state) {
    case "borrowing":
      return { text: `Signs in through ${broker}`, tone: "ok" };
    case "lending":
      return { text: "Other machines sign in through this one", tone: "ok" };
    case "broker_offline":
      return status.message
        ? { text: status.message, action: "sign_in_here", actionLabel: "Sign in here instead", tone: "problem" }
        : { text: `${broker} is offline · Sign in here instead`, action: "sign_in_here", actionLabel: "Sign in here instead", tone: "problem" };
    case "broker_not_signed_in":
      return { text: status.message || `${harness} isn't signed in on ${broker} yet`, action: "sign_in_on_broker", actionLabel: `Sign in on ${broker}`, tone: "wait" };
    case "broker_unsupported":
      return { text: status.message || `${broker} needs a newer Kybern to share its ${harness} sign-in`, tone: "problem" };
    case "not_used":
      return status.lendable.length > 0
        ? { text: `${broker} is signed in to ${harness}`, action: "use_broker", actionLabel: `Use ${broker}'s sign-in`, tone: "quiet" }
        : { text: "Signs in on this machine", tone: "quiet" };
  }
}

/** "Mac (Max) · work@example.com", the line a lendable account gets in the picker. */
export function lendableLabel(account: LendableAccount): string {
  const detail = [account.plan, account.email].filter(Boolean).join(" · ");
  return detail ? `${account.name} · ${detail}` : account.name;
}

/** The status row of one harness, if the daemon listed it. */
export function providerStatus(status: LoginBrokerStatus | null | undefined, kind: ProviderKind): BrokerProviderStatus | undefined {
  return status?.providers.find((provider) => provider.provider === kind);
}

/** States in which the account's sign-in does not come from this machine's own harness. */
export const throughBroker = (state: BrokerLoginState | undefined): boolean => state === "borrowing" || state === "broker_offline" || state === "broker_not_signed_in" || state === "broker_unsupported";

/** A machine that can be picked as the broker: a member, online, and new enough to know the feature. */
export interface BrokerCandidate {
  machineId: MachineId;
  name: string;
  online: boolean;
  features: readonly string[];
}

export const LOGIN_BROKER_FEATURE = "login.broker.v1";

/** Why a machine cannot be the broker, or null when it can. */
export function brokerBlocker(machine: BrokerCandidate): string | null {
  if (!machine.online) return `${machine.name} is offline`;
  if (machine.features.length > 0 && !machine.features.includes(LOGIN_BROKER_FEATURE)) return `${machine.name} needs a newer Kybern`;
  return null;
}

// ---- Sign in on all machines ----

export type SignInAllState = "waiting" | "signing_in" | "signed_in" | "already" | "failed" | "skipped" | "canceled";

export interface SignInAllRow {
  machineId: MachineId;
  name: string;
  state: SignInAllState;
  /** Why the machine failed or was skipped. */
  detail?: string;
  /** The sign-in in progress on this machine: its link or code, for the one step the person does. */
  login?: AccountLogin;
}

export interface SignInAllMachine {
  machineId: MachineId;
  name: string;
  online: boolean;
  /** Whether the harness is signed in there; `undefined` when the machine did not say. */
  signedIn: boolean | undefined;
}

/** One row per machine: those already signed in and those that are offline are settled before anything runs. */
export function planSignInAll(machines: readonly SignInAllMachine[]): SignInAllRow[] {
  return machines.map((machine) => {
    if (machine.signedIn === true) return { machineId: machine.machineId, name: machine.name, state: "already" };
    if (!machine.online) return { machineId: machine.machineId, name: machine.name, state: "skipped", detail: `${machine.name} is offline. Sign in there when it is back.` };
    return { machineId: machine.machineId, name: machine.name, state: "waiting" };
  });
}

export interface SignInOutcome {
  ok: boolean;
  detail?: string;
}

/** Signs one machine in. It reports each step of the person's part through `update`. */
export type SignInMachine = (row: SignInAllRow, update: (login: AccountLogin) => void) => Promise<SignInOutcome>;

export interface RunOptions {
  signal?: AbortSignal;
  /** Called with a fresh copy of the rows after every change. */
  onChange?: (rows: SignInAllRow[]) => void;
}

/**
 * Sign in on each waiting machine, one after another. A machine that fails does not stop the rest, and
 * cancelling leaves the finished ones as they are and marks the others canceled.
 */
export async function runSignInAll(initial: readonly SignInAllRow[], signIn: SignInMachine, options: RunOptions = {}): Promise<SignInAllRow[]> {
  const rows = initial.map((row) => ({ ...row }));
  const emit = () => options.onChange?.(rows.map((row) => ({ ...row })));
  const canceled = () => options.signal?.aborted === true;
  emit();
  for (const row of rows) {
    if (row.state !== "waiting") continue;
    if (canceled()) {
      row.state = "canceled";
      emit();
      continue;
    }
    row.state = "signing_in";
    emit();
    try {
      const outcome = await signIn(row, (login) => {
        row.login = login;
        emit();
      });
      row.state = outcome.ok ? "signed_in" : canceled() ? "canceled" : "failed";
      if (!outcome.ok && outcome.detail) row.detail = outcome.detail;
    } catch (error) {
      row.state = canceled() ? "canceled" : "failed";
      row.detail = error instanceof Error ? error.message : String(error);
    }
    delete row.login;
    emit();
  }
  return rows.map((row) => ({ ...row }));
}

/** "Signed in on 2 of 3 machines · pc needs another try". */
export function signInAllSummary(rows: readonly SignInAllRow[]): string {
  const done = rows.filter((row) => row.state === "signed_in" || row.state === "already").length;
  const parts = [`Signed in on ${done} of ${rows.length} ${rows.length === 1 ? "machine" : "machines"}`];
  const failed = rows.filter((row) => row.state === "failed").map((row) => row.name);
  const offline = rows.filter((row) => row.state === "skipped").map((row) => row.name);
  if (failed.length) parts.push(`${list(failed)} ${failed.length === 1 ? "needs" : "need"} another try`);
  if (offline.length) parts.push(`${list(offline)} ${offline.length === 1 ? "was" : "were"} offline`);
  return parts.join(" · ");
}

function list(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ---- one machine's sign-in, through its own daemon ----

/** The part of a client `driveLogin` needs. `KybernClient` and the per-machine proxies fit. */
export interface LoginClient {
  call(method: "providers.accounts.login.start", params: { kind: ProviderKind; instance?: string; mode: AccountLoginMode }): Promise<AccountLogin>;
  call(method: "providers.accounts.login.get", params: { id: string }): Promise<AccountLogin>;
  call(method: "providers.accounts.login.cancel", params: { id: string }): Promise<AccountLogin>;
  call(method: "providers.accounts.login.finish", params: { id: string; name: string; color?: string | null; make_default?: boolean }): Promise<ProviderInstance>;
}

export interface DriveOptions {
  kind: ProviderKind;
  mode: AccountLoginMode;
  /** What to call the account the sign-in makes. */
  accountName: string;
  signal?: AbortSignal;
  /** How long between reads of the sign-in. */
  pollMs?: number;
  /** Give up waiting for the person after this long. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const FINAL = new Set<AccountLogin["phase"]>(["signed_in", "failed", "canceled"]);

/**
 * Start the machine's own sign-in, tell the caller its link or code, and wait until it ends. A success is
 * finished as a named account so the machine can use it. The daemon enforces its own sign-in timeout.
 */
export async function driveLogin(client: LoginClient, options: DriveOptions, update: (login: AccountLogin) => void): Promise<SignInOutcome> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? 1000;
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60 * 1000);
  let login = await client.call("providers.accounts.login.start", { kind: options.kind, mode: options.mode });
  update(login);
  while (!FINAL.has(login.phase)) {
    if (options.signal?.aborted) {
      await client.call("providers.accounts.login.cancel", { id: login.id }).catch(() => undefined);
      return { ok: false, detail: "Canceled" };
    }
    if (Date.now() > deadline) {
      await client.call("providers.accounts.login.cancel", { id: login.id }).catch(() => undefined);
      return { ok: false, detail: "The sign-in took too long. Try again." };
    }
    await sleep(pollMs);
    const next = await client.call("providers.accounts.login.get", { id: login.id });
    if (next.phase !== login.phase || next.url !== login.url || next.user_code !== login.user_code) update(next);
    login = next;
  }
  if (login.phase !== "signed_in") return { ok: false, detail: login.error || (login.phase === "canceled" ? "Canceled" : "The sign-in did not finish.") };
  await client.call("providers.accounts.login.finish", { id: login.id, name: options.accountName, make_default: true });
  return { ok: true };
}
