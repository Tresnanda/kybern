//! Translate pre-SDK model IDs only when the account's cached catalog proves
//! the exact model and effort still exist. Never substitute a newer model.
use base64::Engine;
use kybern_protocol::ProviderModel;
use serde_json::{Value, json};

pub fn legacy_model_selection(selected: &str, models: &[ProviderModel]) -> Option<(String, Option<String>)> {
    let legacy = selected.strip_prefix("cursor-")?;
    let mut candidates: Vec<_> = models
        .iter()
        .filter_map(|model| {
            let id = model.resolved_id.as_deref().unwrap_or(&model.id);
            (legacy == id || legacy.strip_prefix(id).is_some_and(|suffix| suffix.starts_with('-'))).then_some((id, model))
        })
        .collect();
    candidates.sort_by_key(|(id, _)| std::cmp::Reverse(id.len()));
    let (id, model) = candidates.first()?;
    let suffix = legacy.strip_prefix(id)?.trim_start_matches('-');
    let effort = if suffix.is_empty() {
        None
    } else {
        model
            .efforts
            .iter()
            .chain(model.variants.iter().flat_map(|variant| &variant.efforts))
            .find(|effort| effort.as_str() == suffix)
            .cloned()
    };
    if !suffix.is_empty() && effort.is_none() {
        return None;
    }
    let mut selection = if let Some(encoded) = model.id.strip_prefix("cursor-model:") {
        serde_json::from_slice::<Value>(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?
    } else {
        json!({"id": id, "params": []})
    };
    // The old ID contains no context or fast choice. Do not copy native defaults.
    selection["params"] = json!([]);
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&selection).ok()?);
    Some((format!("cursor-model:{encoded}"), effort))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_ids_keep_the_same_model_and_only_the_chosen_effort() {
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "id":"grok-4.5", "params":[{"id":"fast","value":"true"}], "effortParam":"effort", "effortValues":["low","high"]
            }))
            .unwrap(),
        );
        let model: ProviderModel = serde_json::from_value(
            json!({"id":format!("cursor-model:{encoded}"),"resolved_id":"grok-4.5","display_name":"Grok 4.5","efforts":["low","high"]}),
        )
        .unwrap();
        let (selection, effort) = legacy_model_selection("cursor-grok-4.5-high", std::slice::from_ref(&model)).unwrap();
        assert_eq!(effort.as_deref(), Some("high"));
        let selection: Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(selection.strip_prefix("cursor-model:").unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(selection["id"], "grok-4.5");
        assert_eq!(selection["params"], json!([]));
        for id in ["cursor-grok-4.5-max", "cursor-grok-4.7-high", "cursor-grok-4.5-high-fast", "grok-4.5-high"] {
            assert!(legacy_model_selection(id, std::slice::from_ref(&model)).is_none(), "{id}");
        }
    }
}
