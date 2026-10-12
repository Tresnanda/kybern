// `kybern_agent_capabilities` answering from the last saved catalog. Included into
// `orchestrator::tests` so it can use its fixture and tool helpers.

/// A driver whose probe can be made to hang, like a harness still starting up.
struct CatalogDriver {
    slow: Arc<AtomicBool>,
}

#[async_trait::async_trait]
impl kybern_drivers::AgentDriver for CatalogDriver {
    fn kind(&self) -> ProviderKind {
        ProviderKind::ClaudeCode
    }

    async fn probe(&self, _binary: Option<&PathBuf>) -> ProviderStatus {
        if self.slow.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
        ProviderStatus {
            kind: ProviderKind::ClaudeCode,
            display_name: "Claude Code".into(),
            available: true,
            binary_path: None,
            version: None,
            unavailable_reason: None,
            supported_permission_modes: PermissionMode::ALL.to_vec(),
            supports_fork: false,
            supports_model_switch: false,
            supports_effort_switch: false,
            supported_efforts: vec![],
            models: vec![
                serde_json::from_value(json!({"id": "opus", "display_name": "Opus", "efforts": ["low", "high"], "is_default": true})).unwrap(),
            ],
            instances: vec![],
        }
    }

    async fn spawn(&self, _config: kybern_drivers::SessionConfig) -> kybern_drivers::Result<kybern_drivers::SpawnedSession> {
        Err(kybern_drivers::DriverError::Unsupported("not used here".into()))
    }
}

fn catalog_fixture() -> (Fixture, Arc<AtomicBool>) {
    let slow = Arc::new(AtomicBool::new(false));
    let mut drivers = DriverRegistry::default();
    drivers.register(Arc::new(CatalogDriver { slow: slow.clone() }));
    let fixture = Fixture::with_drivers(drivers);
    std::fs::create_dir_all(&fixture.root).unwrap();
    fixture.orchestrator.set_catalog_budget(Duration::from_millis(100));
    (fixture, slow)
}

fn claude_entry(caps: &serde_json::Value) -> &serde_json::Value {
    caps["harnesses"].as_array().unwrap().iter().find(|harness| harness["provider"] == "claude-code").expect("claude-code listed")
}

#[tokio::test]
async fn capabilities_serve_the_last_saved_catalog_while_a_fresh_one_loads() {
    let (fixture, slow) = catalog_fixture();
    let (thread, live) = fixture.tool_thread(PermissionMode::FullAccess).await;

    // The first answer waits for the probe and saves what it finds.
    let first = fixture.tool(&thread, &live, "caps-1", "kybern_agent_capabilities", json!({})).await.unwrap();
    assert_eq!(first["catalog_state"], json!("fresh"));
    assert_eq!(claude_entry(&first)["models"][0]["id"], json!("opus"));
    assert!(first["catalog_note"].is_null());
    let saved = fixture.root.join("cache").join("provider-catalogs.json");
    eventually(|| async { std::fs::read_to_string(&saved).ok().filter(|text| text.contains("\"opus\"")) }).await;

    // The in-memory catalog goes stale and the next probe hangs: the saved one answers.
    fixture.orchestrator.provider_catalog_cache().invalidate().await;
    slow.store(true, Ordering::SeqCst);
    let started = Instant::now();
    let cached = fixture.tool(&thread, &live, "caps-2", "kybern_agent_capabilities", json!({})).await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(5), "the call gave up waiting after its budget");
    assert_eq!(cached["catalog_state"], json!("cached"));
    let entry = claude_entry(&cached);
    assert_eq!((entry["available"].clone(), entry["models"][0]["id"].clone()), (json!(true), json!("opus")));
    assert!(cached["catalog_note"].as_str().unwrap().contains("last one Kybern saved"), "{cached}");
    assert_eq!(cached["limits"]["max_active_children"], 4, "the rest of the answer is unchanged");
}

#[tokio::test]
async fn capabilities_say_so_when_no_catalog_was_ever_saved() {
    let (fixture, slow) = catalog_fixture();
    slow.store(true, Ordering::SeqCst);
    let (thread, live) = fixture.tool_thread(PermissionMode::FullAccess).await;
    let caps = fixture.tool(&thread, &live, "caps-empty", "kybern_agent_capabilities", json!({})).await.unwrap();
    assert_eq!(caps["catalog_state"], json!("loading"));
    assert!(caps["catalog_note"].as_str().unwrap().contains("No harness catalog has been loaded yet"));
    let entry = claude_entry(&caps);
    assert_eq!((entry["available"].clone(), entry["models"].clone()), (json!(null), json!([])));
    assert!(entry["unavailable_reason"].as_str().unwrap().contains("not loaded yet"));
}

#[tokio::test]
async fn a_catalog_with_no_models_never_replaces_a_saved_one() {
    let cache = crate::state::ProviderCatalogCache::default();
    let status = |available: bool, models: usize| -> ProviderStatus {
        ProviderStatus {
            kind: ProviderKind::ClaudeCode,
            display_name: "Claude Code".into(),
            available,
            binary_path: None,
            version: None,
            unavailable_reason: None,
            supported_permission_modes: vec![],
            supports_fork: false,
            supports_model_switch: false,
            supports_effort_switch: false,
            supported_efforts: vec![],
            models: (0..models)
                .map(|index| serde_json::from_value(json!({"id": format!("m{index}"), "display_name": "M"})).unwrap())
                .collect(),
            instances: vec![],
        }
    };
    cache.remember("p", &[status(true, 2)]);
    cache.remember("p", &[status(true, 0)]);
    cache.remember("p", &[status(false, 3)]);
    assert_eq!(cache.last_known("p").unwrap().0[0].models.len(), 2);
    assert!(cache.last_known("other").is_none());
}

#[tokio::test]
async fn the_saved_catalog_survives_a_restart() {
    let dir = std::env::temp_dir().join(format!("kybern-catalog-test-{}", Uuid::now_v7()));
    let file = dir.join("cache").join("provider-catalogs.json");
    let (fixture, _) = catalog_fixture();
    let first = crate::state::ProviderCatalogCache::with_disk(file.clone());
    let statuses = fixture.orchestrator.refresh_provider_statuses(fixture.project.id).await.unwrap();
    first.remember("project-1", &statuses);
    eventually(|| async { file.exists().then_some(()) }).await;
    assert_eq!(std::fs::read_dir(file.parent().unwrap()).unwrap().count(), 1, "no temporary file is left behind");

    let second = crate::state::ProviderCatalogCache::with_disk(file.clone());
    let (restored, saved_at) = second.last_known("project-1").expect("the catalog was reloaded");
    assert_eq!(restored[0].models[0].id, "opus");
    assert!(saved_at <= chrono::Utc::now());
    // A damaged file is ignored rather than breaking the tool.
    std::fs::write(&file, "{ not json").unwrap();
    assert!(crate::state::ProviderCatalogCache::with_disk(file).last_known("project-1").is_none());
    let _ = std::fs::remove_dir_all(dir);
}
