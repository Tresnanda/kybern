//! Durable offline edits. The owner remains authoritative; stale edits never overwrite it.
use crate::orchestrator::remote_delegation::{CallFailure, Delivery};
use crate::state::AppState;
use kybern_protocol::{methods::*, *};
use serde_json::Value;

pub fn validate(edit: &PeerItemEditParams) -> Result<(), RpcError> {
    match edit.method.as_str() {
        "notes.update" => {
            let _: NotesUpdateParams = serde_json::from_value(edit.params.clone()).map_err(RpcError::invalid_params)?;
        }
        "tasks.items.update" => {
            let _: TaskItemsUpdateParams = serde_json::from_value(edit.params.clone()).map_err(RpcError::invalid_params)?;
        }
        _ => return Err(RpcError::invalid_params("Queue a note or task update. Other operations need an online machine.")),
    }
    Ok(())
}

pub fn serve(state: &AppState, actor: &str, edit: PeerItemEditParams) -> Result<Value, RpcError> {
    validate(&edit)?;
    if let Some(value) = state.store.operation_receipt(edit.operation_id, actor, PeerItemEdit::NAME, &edit).map_err(RpcError::internal)? {
        return Ok(value);
    }
    state.store.operation_begin(edit.operation_id, actor, PeerItemEdit::NAME, &edit).map_err(RpcError::internal)?;
    let result = match edit.method.as_str() {
        "notes.update" => {
            let params = serde_json::from_value(edit.params.clone()).map_err(RpcError::invalid_params)?;
            state
                .orchestrator
                .note_update(params)
                .map_err(crate::rpc::note_err)
                .and_then(|v| serde_json::to_value(v).map_err(RpcError::internal))
        }
        _ => {
            let params = serde_json::from_value(edit.params.clone()).map_err(RpcError::invalid_params)?;
            state
                .orchestrator
                .task_item_update_if(params, Some(edit.expected_updated_at))
                .map_err(crate::rpc::task_err)
                .and_then(|v| serde_json::to_value(v).map_err(RpcError::internal))
        }
    };
    // Persist both success and conflict: retries never apply an operation twice.
    let receipt = serde_json::json!({"result": result.as_ref().ok(), "error": result.as_ref().err()});
    state.store.operation_complete(edit.operation_id, &receipt).map_err(RpcError::internal)?;
    Ok(receipt)
}

pub async fn deliver(state: &AppState, item: &OutboxItem) -> Delivery {
    let Some(hub) = state.orchestrator.remote_hub() else {
        return Delivery::Failed("Reconnect to your network and retry the edit.".into());
    };
    match hub.call(&item.target, PeerItemEdit::NAME, item.payload.clone()).await {
        Ok(value) if !value["error"].is_null() => Delivery::Failed(
            "The owner could not apply this edit. Open the latest note or task, compare your pending edit, and save again.".into(),
        ),
        Ok(value) => Delivery::Delivered(value["result"].clone()),
        Err(CallFailure::Offline(reason)) => Delivery::Retry(reason),
        Err(CallFailure::Gone(reason)) => Delivery::Failed(reason),
        Err(CallFailure::Remote(error)) if error.code == codes::METHOD_NOT_FOUND => {
            Delivery::Retry("Update the owner machine to deliver this edit.".into())
        }
        Err(CallFailure::Remote(error)) => Delivery::Failed(error.message),
    }
}
