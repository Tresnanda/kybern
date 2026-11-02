// Setting up a project on a machine that lacks it, from the phone (ADE-99 §2.3). The calls go to the machine that sends the
// project (`projects.provision_plan`, `projects.provision`, `projects.provision.status`), as on desktop; the target is named in
// the call. Progress arrives as `projects.provision.changed` and is also polled, so a dropped notification cannot leave the
// sheet waiting.
import { PROVISION_CHANGED_NOTIFICATION, type MachineId, type ProjectId, type ProvisionPlan, type ProvisionStatus } from "../../../../packages/kybern-client/src/types";
import { provisionSettled } from "../../../../packages/kybern-client/src/provision";
import { machineHub } from "./runtime";

export interface ProvisionRoute {
  /** The machine that holds the project and sends it. */
  source: MachineId;
  /** Its id for the project. */
  projectId: ProjectId;
  /** The machine that gets it. */
  target: MachineId;
}

export function planProvision(route: ProvisionRoute, path?: string | null): Promise<ProvisionPlan> {
  return machineHub().clientFor(route.source).call("projects.provision_plan", { project_id: route.projectId, machine: route.target, ...(path ? { path } : {}) });
}

export function startProvision(route: ProvisionRoute, choice: { path?: string | null; env_files?: string[] | null }): Promise<ProvisionStatus> {
  return machineHub().clientFor(route.source).call("projects.provision", { project_id: route.projectId, machine: route.target, ...choice });
}

/** Follows one provisioning until it settles. Returns a stop function; `onStatus` gets every change, the settled one last. */
export function followProvision(route: ProvisionRoute, first: ProvisionStatus, onStatus: (status: ProvisionStatus) => void, intervalMs = 2000): () => void {
  const client = machineHub().clientFor(route.source);
  let stopped = false;
  let current = first;
  const push = (status: ProvisionStatus) => {
    if (stopped || status.operation_id !== first.operation_id) return;
    current = status;
    onStatus(status);
    if (provisionSettled(status)) stop();
  };
  const off = client.onNotification(PROVISION_CHANGED_NOTIFICATION, (params) => params && push(params as ProvisionStatus));
  const timer = setInterval(() => {
    if (stopped) return;
    client.call("projects.provision.status", { operation_id: first.operation_id }).then(push, () => {});
  }, intervalMs);
  function stop() {
    if (stopped) return;
    stopped = true;
    off();
    clearInterval(timer);
  }
  push(current);
  return stop;
}

/** The target's own lists, read again so a project that arrived becomes a choice. */
export async function refreshTarget(target: MachineId): Promise<void> {
  await machineHub().refreshMachine(target).catch(() => {});
}
