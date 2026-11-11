// How many calls one connection keeps in flight, and which calls may jump the line.
//
// The daemon allows each connection a bounded number of calls per lane (crates/kybern-daemon/src/ws_lanes.rs). A
// client that sends everything at once (startup, navigation) trips that cap, and a few slow calls (git, GitHub, a
// live usage read) used to starve the cheap reads a page needs. Here the client stays below the daemon's caps by
// queueing the rest, keeps slow calls from taking the budget of cheap ones, and lets control calls (subscribe,
// interrupt, answer, approve, cancel) go straight out. The lists mirror the daemon's; a test keeps them equal.

export type CallLane = "control" | "standard" | "slow";

/** Methods that must answer while every read is stuck. */
export const CONTROL_METHODS: readonly string[] = [
  "daemon.info",
  "daemon.activity",
  "events.subscribe",
  "events.unsubscribe",
  "threads.send",
  "threads.steer",
  "threads.answer",
  "threads.interrupt",
  "threads.release",
  "subagents.send",
  "subagents.send_to_parent",
  "approvals.respond",
  "approvals.list",
  "requests.act",
  "tasks.stop",
  "tasks.background",
  "terminals.resize",
  "terminals.close",
  "terminals.subscribe",
  "terminals.unsubscribe",
  "previews.close",
  "ports.stop",
];

/** Methods that run a subprocess, probe the network or wait on another machine. */
export const SLOW_METHODS: readonly string[] = [
  "usage.summary",
  "providers.list",
  "providers.accounts.usage",
  "providers.accounts.catalog",
  "git.status",
  "git.branches",
  "git.commit",
  "threads.diff",
  "threads.checkpoints",
  "threads.revert",
  "threads.worktree.inspect",
  "threads.worktree.remove",
  "files.search",
  "previews.probe",
  "previews.servers.list",
  "projects.scan_repos",
  "projects.map",
  "machines.info",
  "cursor.status",
  "cursor.setup",
  "computer.status",
  "computer.setup",
  "network.doctor",
  "network.update_all",
  "network.join",
  "network.add",
  "network.rejoin",
  "network.merge",
  "skills.list",
  "projects.members.status",
  "threads.fork_to_machine",
  "threads.move_to_machine",
  "threads.move_abandon",
];

/** Every method with one of these prefixes is slow. */
export const SLOW_PREFIXES: readonly string[] = [
  "github.",
  "peer.",
  "plugins.",
  "skills.inventory",
  "skills.network",
  "skills.copy",
  "integrations.",
  "harness_updates.",
  "daemon_update.",
  "sessions.",
  "projects.provision",
  "login.broker.",
];

/** Lists that also ask other machines when the call names one. */
export const FEDERATED_LISTS: readonly string[] = ["tasks.items.list", "notes.list", "notes.search", "threads.list"];

export function laneFor(method: string, params?: unknown): CallLane {
  if (CONTROL_METHODS.includes(method) || method.endsWith("cancel")) return "control";
  const input = params && typeof params === "object" ? (params as { machine?: unknown; cached?: unknown }) : {};
  if (method === "usage.limits") return input.cached === true ? "standard" : "slow";
  if (FEDERATED_LISTS.includes(method)) return input.machine != null ? "slow" : "standard";
  if (SLOW_METHODS.includes(method) || SLOW_PREFIXES.some((prefix) => method.startsWith(prefix))) return "slow";
  return "standard";
}

export interface CallBudget {
  /** Calls in flight at once for everything that is not slow or control. The daemon allows 16. */
  standard: number;
  /** Calls in flight at once for slow work. The daemon allows 8. */
  slow: number;
}

export const DEFAULT_CALL_BUDGET: CallBudget = { standard: 12, slow: 6 };

/** How long a refused call keeps trying, and how many times, however long its own deadline is. */
export const BUSY_RETRY_WINDOW_MS = 5_000;
export const BUSY_RETRY_ATTEMPTS = 6;
const BUSY_RETRY_CAP_MS = 4_000;
const BUSY_RETRY_DEFAULT_MS = 400;

/** Wait before retry number `attempt` (0-based): the daemon's hint, doubled each time, capped, with jitter. */
export function busyDelay(attempt: number, hintMs: number | undefined, random: () => number = Math.random): number {
  const hint = hintMs && hintMs > 0 ? hintMs : BUSY_RETRY_DEFAULT_MS;
  return Math.min(BUSY_RETRY_CAP_MS, hint * 2 ** attempt) * (0.75 + random() * 0.5);
}

interface Waiter {
  start: (release: () => void) => void;
  fail: (error: Error) => void;
  deadline: number;
  onTimeout: () => Error;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Admits calls up to a limit per lane and queues the rest in arrival order. A call that waits past its deadline
 * fails without ever having been sent. Control calls are never queued.
 */
export class CallScheduler {
  private readonly limits: Record<Exclude<CallLane, "control">, number>;
  private readonly active = { standard: 0, slow: 0 };
  private readonly queues: Record<Exclude<CallLane, "control">, Waiter[]> = { standard: [], slow: [] };

  constructor(budget: CallBudget = DEFAULT_CALL_BUDGET) {
    this.limits = { standard: Math.max(1, budget.standard), slow: Math.max(1, budget.slow) };
  }

  /**
   * Runs `start` once the lane has room (at once, when it does), passing the `release` to call when the call has
   * settled. `fail` receives `onTimeout()` if `deadline` passes first, or the error given to `abortAll`.
   */
  admit(
    lane: CallLane,
    deadline: number,
    start: (release: () => void) => void,
    fail: (error: Error) => void,
    onTimeout: () => Error,
  ): void {
    if (lane === "control") {
      start(() => {});
      return;
    }
    if (this.active[lane] < this.limits[lane]) {
      this.active[lane]++;
      start(this.releaser(lane));
      return;
    }
    const waiter: Waiter = {
      start,
      fail,
      deadline,
      onTimeout,
      timer: setTimeout(() => {
        const queue = this.queues[lane];
        const at = queue.indexOf(waiter);
        if (at >= 0) queue.splice(at, 1);
        fail(onTimeout());
      }, Math.max(0, deadline - Date.now())),
    };
    this.queues[lane].push(waiter);
  }

  /** Fails everything still queued (the connection dropped). Calls already sent settle on their own. */
  abortAll(error: Error): void {
    for (const lane of ["standard", "slow"] as const) {
      const queue = this.queues[lane].splice(0);
      for (const waiter of queue) {
        clearTimeout(waiter.timer);
        waiter.fail(error);
      }
    }
  }

  /** For tests and diagnostics: calls in flight and waiting. */
  stats(lane: Exclude<CallLane, "control">): { active: number; queued: number } {
    return { active: this.active[lane], queued: this.queues[lane].length };
  }

  private releaser(lane: Exclude<CallLane, "control">): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active[lane]--;
      for (let next = this.queues[lane].shift(); next; next = this.queues[lane].shift()) {
        clearTimeout(next.timer);
        // Its own timer may be about to fire: a call past its deadline is failed, never sent.
        if (Date.now() >= next.deadline) {
          next.fail(next.onTimeout());
          continue;
        }
        this.active[lane]++;
        next.start(this.releaser(lane));
        return;
      }
    };
  }
}
