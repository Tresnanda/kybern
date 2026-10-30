//! Explicit plugin declaration copies. Files capability, version negotiation, frozen outbox payloads.
use crate::orchestrator::remote_delegation::{CallFailure, Delivery};
use crate::state::AppState;
use kybern_protocol::methods::*;
use kybern_protocol::*;
use serde_json::Value;
use std::time::Duration;
use uuid::Uuid;

pub async fn network_view(state: &AppState) -> Result<PluginsNetworkView, RpcError> {
    let local = crate::plugins::inventory(state).await?;
    let hub = state.orchestrator.remote_hub().cloned();
    let members = hub.as_ref().map(|h| h.members()).unwrap_or_default();
    let Some(hub) = hub.filter(|_| !members.is_empty()) else {
        return Ok(PluginsNetworkView {
            machines: vec![PluginsMachineView {
                id: state.environment_id.clone(),
                name: crate::rpc::hostname(),
                is_self: true,
                state: SkillsMachineState::Reported,
                inventory: Some(local),
                detail: None,
            }],
        });
    };
    let asked = members.into_iter().map(|m| {
        let local = local.clone();
        let hub = hub.clone();
        async move {
            let mut v = PluginsMachineView {
                id: m.id.clone(),
                name: m.name,
                is_self: m.is_self,
                state: SkillsMachineState::Reported,
                inventory: None,
                detail: None,
            };
            if m.is_self {
                v.inventory = Some(local);
                return v;
            }
            if m.status != "online" {
                v.state = SkillsMachineState::Offline;
                return v;
            }
            if !m.features.is_empty() && !m.features.iter().any(|f| f == features::PLUGINS_SYNC_V1) {
                v.state = SkillsMachineState::Unsupported;
                return v;
            }
            match tokio::time::timeout(Duration::from_secs(5), hub.call(&m.id, PeerPluginsInventory::NAME, Value::Null)).await {
                Ok(Ok(answer)) => match serde_json::from_value(answer) {
                    Ok(i) => v.inventory = Some(i),
                    Err(_) => {
                        v.state = SkillsMachineState::Unreachable;
                        v.detail = Some("Unreadable plugin inventory".into());
                    }
                },
                Ok(Err(CallFailure::Remote(e))) if e.code == codes::METHOD_NOT_FOUND => v.state = SkillsMachineState::Unsupported,
                Ok(Err(CallFailure::Remote(e))) => {
                    v.state = SkillsMachineState::Unreachable;
                    v.detail = Some(e.message);
                }
                _ => {
                    v.state = SkillsMachineState::Unreachable;
                    v.detail = Some("Could not read plugins; check Files access in Machines".into());
                }
            }
            v
        }
    });
    let mut machines = futures::future::join_all(asked).await;
    machines.sort_by(|a, b| b.is_self.cmp(&a.is_self).then(a.name.cmp(&b.name)));
    Ok(PluginsNetworkView { machines })
}
pub async fn copy(state: &AppState, mut params: PluginsCopyParams) -> Result<PluginsCopyResult, RpcError> {
    if let Some(from) = params.from.take().filter(|f| f != &state.environment_id) {
        let hub = state.orchestrator.remote_hub().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "Machine network is unavailable"))?;
        let source = hub.resolve(&from).map_err(RpcError::invalid_params)?;
        return match hub.call(&source.id, PeerPluginsCopy::NAME, serde_json::to_value(params).map_err(RpcError::internal)?).await {
            Ok(v) => serde_json::from_value(v).map_err(RpcError::internal),
            Err(CallFailure::Remote(e)) => Err(e),
            Err(_) => Err(RpcError::new(codes::NOT_AVAILABLE, "Source machine is offline; choose an online source")),
        };
    }
    serve_copy(state, params).await
}
pub async fn serve_copy(state: &AppState, params: PluginsCopyParams) -> Result<PluginsCopyResult, RpcError> {
    if params.to.is_empty() || params.to.len() > 64 {
        return Err(RpcError::invalid_params("Choose between 1 and 64 targets"));
    }
    let plugin = crate::plugins::inventory(state)
        .await?
        .plugins
        .into_iter()
        .find(|p| p.id == params.id && p.provider == params.provider)
        .ok_or_else(|| RpcError::new(codes::NOT_FOUND, "Plugin is no longer present; refresh the inventory"))?;
    if plugin.fingerprint != params.confirmed {
        return Err(RpcError::new(codes::CONFLICT, "Plugin changed after review. Refresh, inspect its contents and confirm again."));
    }
    if let Some(problem) = &plugin.problem {
        return Err(RpcError::invalid_params(problem));
    }
    let hub = state.orchestrator.remote_hub().cloned();
    let mut chosen = Vec::new();
    for target in params.to {
        let (id, name) = if target.machine == state.environment_id {
            (state.environment_id.clone(), crate::rpc::hostname())
        } else {
            let h = hub.as_ref().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "Machine network is unavailable"))?;
            let t = h.resolve(&target.machine).map_err(RpcError::invalid_params)?;
            (t.id, t.name)
        };
        if !chosen.iter().any(|(known, _, _): &(String, String, Option<String>)| known == &id) {
            chosen.push((id, name, target.replaces));
        }
    }
    let mut targets = Vec::new();
    for (id, name, replaces) in chosen {
        let mut outcome = PluginCopyOutcome { machine: id.clone(), name, outbox_id: None, result: None, error: None };
        let request = PluginInstallRequest { operation_id: Uuid::now_v7(), plugin: plugin.clone(), replaces };
        if id == state.environment_id {
            outcome.result = Some(crate::plugins::install(state, &state.environment_id, request).await?);
        } else if hub
            .as_ref()
            .and_then(|h| h.target(&id))
            .and_then(|t| t.features)
            .is_some_and(|f| !f.is_empty() && !f.iter().any(|v| v == features::PLUGINS_SYNC_V1))
        {
            outcome.error = Some("Update Kybern on the target to copy plugins".into());
        } else {
            let item = super::outbox::queue(
                state,
                &id,
                OutboxKind::PluginInstall,
                request.operation_id,
                serde_json::to_value(request).map_err(RpcError::internal)?,
            )?;
            outcome.outbox_id = Some(item.id);
        }
        targets.push(outcome);
    }
    Ok(PluginsCopyResult { targets })
}
pub async fn deliver(state: &AppState, item: &OutboxItem) -> Delivery {
    let Some(hub) = state.orchestrator.remote_hub() else {
        return Delivery::Failed("Machine network unavailable".into());
    };
    match hub.call(&item.target, PeerPluginsInstall::NAME, item.payload.clone()).await {
        Ok(v) => Delivery::Delivered(v),
        Err(CallFailure::Offline(s)) => Delivery::Retry(s),
        Err(CallFailure::Gone(s)) => Delivery::Failed(s),
        Err(CallFailure::Remote(e)) => Delivery::Failed(e.message),
    }
}
