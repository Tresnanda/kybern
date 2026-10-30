//! `machine: "all"` on `kybern_notes_search` and `kybern_tasks_list` (ADE-86 M5 / S2, design §9.2).
//!
//! The call runs here and, in parallel, on every online member through `peer.tool.call`, the same audited
//! path as any forwarded read (§6.3), each member within five seconds. `network::federated` merges the
//! rows, labels each with its machine and names the machines it could not read. Any other tool with
//! `machine: "all"` is refused with the reason: a note or task is written only where it lives.

use std::time::Duration;

use anyhow::{Result, anyhow};
use kybern_protocol::methods::{Method, PeerToolCall};
use kybern_protocol::*;
use serde_json::Value;
use uuid::Uuid;

use super::Orchestrator;
use crate::network::federated::{self, ToolPart};

const MEMBER_BUDGET: Duration = federated::MEMBER_BUDGET;

impl Orchestrator {
    /// A tool call whose `machine` is `"all"`.
    pub(super) fn federated_tool_call<'a>(
        &'a self,
        thread_id: ThreadId,
        session_instance_id: Uuid,
        name: &'a str,
        mut arguments: Value,
    ) -> futures::future::BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            if !federated::is_federated_read(name) {
                return Err(anyhow!("{}", federated::refuse_all(name)));
            }
            if arguments.get("project_id").is_some_and(|value| !value.is_null()) {
                return Err(anyhow!(
                    "project_id names a project on one machine. With machine \"all\" search without it, or name the machine that has the project."
                ));
            }
            let thread = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("native tool caller thread no longer exists"))?;
            // Work another machine started here may not reach a third machine (§6.3: hops == 1).
            anyhow::ensure!(
                thread.origin.is_none() && thread.inbound.is_none(),
                "Another machine started this thread, so it cannot read the other machines' notes and tasks. Use the tools on this machine."
            );
            let hub = self.forward_hub()?.clone();
            if let Some(object) = arguments.as_object_mut() {
                object.remove(crate::network::forward::MACHINE_ARG);
                object.remove(crate::network::forward::PROJECT_ARG);
            }
            let limit = arguments.get("limit").and_then(Value::as_u64).map(|limit| limit as usize);
            let limit = match name {
                "kybern_notes_search" => limit.unwrap_or(20).clamp(1, 50),
                _ => limit.unwrap_or(50).clamp(1, 200),
            };
            let (ask, mut skipped) = federated::tool_targets(&*hub).map_err(|error| anyhow!("{}", error.message))?;
            let remote = ask.iter().map(|member| {
                let (hub, thread, arguments) = (hub.clone(), thread.clone(), arguments.clone());
                async move {
                    let params = self.tool_call_params(&thread, &hub, name, arguments, Uuid::now_v7(), None).await;
                    let call = hub.call(&member.id, PeerToolCall::NAME, serde_json::to_value(&params).unwrap_or(Value::Null));
                    match tokio::time::timeout(MEMBER_BUDGET, call).await {
                        Err(_) => Err(FederationSkipped {
                            machine_id: member.id.clone(),
                            machine_name: member.name.clone(),
                            reason: SkipReason::TimedOut,
                        }),
                        Ok(Err(failure)) => Err(federated::tool_skip(member, &failure)),
                        Ok(Ok(value)) => match serde_json::from_value::<PeerToolCallResult>(value) {
                            Ok(result) => Ok(ToolPart {
                                machine_id: member.id.clone(),
                                machine_name: member.name.clone(),
                                is_self: false,
                                value: result.result,
                            }),
                            Err(_) => Err(FederationSkipped {
                                machine_id: member.id.clone(),
                                machine_name: member.name.clone(),
                                reason: SkipReason::Failed,
                            }),
                        },
                    }
                }
            });
            let (here, others) = tokio::join!(
                self.execute_native_app_tool(thread_id, session_instance_id, name, arguments.clone()),
                futures::future::join_all(remote)
            );
            let mut parts = vec![ToolPart { machine_id: hub.self_id(), machine_name: hub.self_name(), is_self: true, value: here? }];
            for outcome in others {
                match outcome {
                    Ok(part) => {
                        self.remember_forwarded(thread_id, &part.machine_id);
                        parts.push(part);
                    }
                    Err(skip) => skipped.push(skip),
                }
            }
            Ok(federated::merge_tool(name, parts, &skipped, limit))
        })
    }
}
