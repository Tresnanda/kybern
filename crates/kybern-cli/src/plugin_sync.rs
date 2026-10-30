//! Explicit plugin copies. Without --yes print the reviewed declarations and do nothing.
use anyhow::{Result, anyhow, bail};
use clap::Subcommand;
use kybern_client::Client;
use kybern_protocol::methods::*;
use kybern_protocol::*;

#[derive(Subcommand)]
pub enum PluginsCmd {
    /// Show plugins, marketplaces, differences, missing declarations, and recent install results.
    Machines,
    /// Review plugin contents, then use --yes to install with the target harness. Offline targets queue.
    Copy {
        id: Option<String>,
        #[arg(long)]
        provider: Option<String>,
        #[arg(long)]
        from: Option<String>,
        #[arg(long,required=true,num_args=1..,value_delimiter=',')]
        to: Vec<String>,
        /// Copy all installable declarations the targets are known to lack.
        #[arg(long, conflicts_with = "id")]
        missing: bool,
        /// Replace only the target declarations shown in this inventory.
        #[arg(long)]
        replace: bool,
        /// Confirm installation of executable plugin code and displayed marketplace sources.
        #[arg(long)]
        yes: bool,
    },
}
fn machine<'a>(view: &'a PluginsNetworkView, q: &str) -> Result<&'a PluginsMachineView> {
    let found: Vec<_> = view.machines.iter().filter(|m| m.id == q || m.name.eq_ignore_ascii_case(q)).collect();
    match found.as_slice() {
        [m] => Ok(*m),
        _ => bail!("Machine {q} is missing or ambiguous; use its id"),
    }
}
fn detail(p: &MachinePlugin) -> String {
    let c = &p.contents;
    format!(
        "{} · {} · {} · {} · {} hooks, {} MCP servers, {} commands, {} agents, {} skills, {} extensions · npm: {}{}",
        p.provider.as_str(),
        p.source.as_deref().unwrap_or("no portable source"),
        p.version.as_deref().unwrap_or("unknown version"),
        match p.enabled {
            Some(true) => "Enabled",
            Some(false) => "Disabled",
            None => "State unknown",
        },
        c.hooks,
        c.mcp_servers,
        c.commands,
        c.agents,
        c.skills,
        c.extensions,
        c.npm_packages.join(", "),
        p.problem.as_ref().map(|s| format!(" · {s}")).unwrap_or_default()
    )
}
pub async fn run(client: &Client, cmd: PluginsCmd, json_output: bool) -> Result<()> {
    let view = client.call::<PluginsNetworkViewMethod>(Empty {}).await?;
    match cmd {
        PluginsCmd::Machines => {
            if json_output {
                println!("{}", serde_json::to_string_pretty(&view)?);
                return Ok(());
            }
            for m in &view.machines {
                println!("{}{} · {:?}", m.name, if m.is_self { " (this machine)" } else { "" }, m.state);
                if let Some(i) = &m.inventory {
                    for warning in &i.warnings {
                        println!("  Warning: {warning}");
                    }
                    for p in &i.plugins {
                        let different = view
                            .machines
                            .iter()
                            .filter_map(|m| m.inventory.as_ref())
                            .flat_map(|i| &i.plugins)
                            .any(|other| other.provider == p.provider && other.id == p.id && other.fingerprint != p.fingerprint);
                        let missing: Vec<_> = view
                            .machines
                            .iter()
                            .filter(|m| {
                                m.state == SkillsMachineState::Reported
                                    && m.inventory.as_ref().is_some_and(|i| {
                                        !i.warnings.iter().any(|w| w.starts_with(p.provider.as_str()))
                                            && !i.plugins.iter().any(|v| v.id == p.id && v.provider == p.provider)
                                    })
                            })
                            .map(|m| m.name.as_str())
                            .collect();
                        println!(
                            "  {} · {} · {}",
                            p.id,
                            if different { "Different" } else { "Same" },
                            match p.enabled {
                                Some(true) => "Enabled",
                                Some(false) => "Disabled",
                                None => "State unknown",
                            }
                        );
                        println!("    {}", detail(p));
                        if !missing.is_empty() {
                            println!("    Missing on {}", missing.join(", "));
                        }
                    }
                    for j in &i.jobs {
                        println!(
                            "  {} → {}: {}",
                            j.plugin_id,
                            j.target,
                            j.result.as_ref().map(|r| r.message.clone()).or(j.error.clone()).unwrap_or_else(|| format!("{:?}", j.state))
                        );
                    }
                }
            }
        }
        PluginsCmd::Copy { id, provider, from, to, missing, replace, yes } => {
            let provider = provider
                .map(|q| ProviderKind::ALL.into_iter().find(|p| p.as_str() == q).ok_or_else(|| anyhow!("Unknown provider {q}")))
                .transpose()?;
            if !missing && (id.is_none() || provider.is_none()) {
                bail!("Name a plugin and --provider, or use --missing");
            }
            let source = from.as_ref().map(|q| machine(&view, q)).transpose()?;
            let targets: Vec<_> = if to.iter().any(|q| q == "all") {
                view.machines.iter().filter(|m| source.map(|s| s.id != m.id).unwrap_or(!m.is_self)).collect()
            } else {
                to.iter().map(|q| machine(&view, q)).collect::<Result<_>>()?
            };
            let mut plans = Vec::new();
            for target in targets {
                if missing && target.state != SkillsMachineState::Reported {
                    continue;
                }
                let sources: Vec<_> =
                    source.map(|s| vec![s]).unwrap_or_else(|| view.machines.iter().filter(|m| missing || m.is_self).collect());
                for src in sources {
                    if src.id == target.id || src.state != SkillsMachineState::Reported {
                        continue;
                    }
                    for p in src.inventory.iter().flat_map(|i| &i.plugins) {
                        if provider.is_some_and(|k| p.provider != k) || id.as_ref().is_some_and(|id| p.id != *id) {
                            continue;
                        }
                        let existing =
                            target.inventory.as_ref().and_then(|i| i.plugins.iter().find(|v| v.provider == p.provider && v.id == p.id));
                        if missing
                            && (existing.is_some()
                                || target.inventory.as_ref().is_some_and(|i| i.warnings.iter().any(|w| w.starts_with(p.provider.as_str()))))
                        {
                            continue;
                        }
                        if let Some(problem) = &p.problem {
                            if !missing {
                                bail!("{problem}");
                            }
                            continue;
                        }
                        if missing
                            && source.is_none()
                            && view
                                .machines
                                .iter()
                                .filter_map(|m| m.inventory.as_ref())
                                .flat_map(|i| &i.plugins)
                                .any(|v| v.provider == p.provider && v.id == p.id && v.fingerprint != p.fingerprint)
                        {
                            continue;
                        }
                        let request = PluginsCopyParams {
                            provider: p.provider,
                            id: p.id.clone(),
                            from: Some(src.id.clone()),
                            to: vec![PluginCopyTarget {
                                machine: target.id.clone(),
                                replaces: if replace { existing.map(|p| p.fingerprint.clone()) } else { None },
                            }],
                            confirmed: p.fingerprint.clone(),
                        };
                        if !plans.iter().any(|r: &PluginsCopyParams| {
                            r.provider == request.provider && r.id == request.id && r.to[0].machine == request.to[0].machine
                        }) {
                            eprintln!("{} → {}: {}\n  {}", p.id, target.name, detail(p), p.contents.notes.join("; "));
                            if !p.resources.is_empty() {
                                eprintln!("  Resource filters: {}", serde_json::to_string(&p.resources)?);
                            }
                            if let Some(existing) = existing.filter(|v| v.fingerprint != p.fingerprint) {
                                eprintln!(
                                    "  Target differs: {}\n  {}",
                                    detail(existing),
                                    if replace { "Replace this reviewed declaration" } else { "Add --replace to authorize replacement" }
                                );
                            }
                            plans.push(request);
                        }
                    }
                }
            }
            if plans.is_empty() {
                bail!("Nothing copyable matched. Check source, provider, missing state and marketplace support.");
            }
            if !yes {
                println!(
                    "Reviewed {} copies. No changes made. Add --yes to confirm these installs{}.",
                    plans.len(),
                    if replace { " and replacements" } else { "" }
                );
                return Ok(());
            }
            let mut failed = false;
            for plan in plans {
                let r = client.call::<PluginsCopy>(plan).await?;
                if json_output {
                    println!("{}", serde_json::to_string_pretty(&r)?);
                } else {
                    for target in &r.targets {
                        println!(
                            "{}: {}",
                            target.name,
                            target
                                .result
                                .as_ref()
                                .map(|r| r.message.clone())
                                .or(target.error.clone())
                                .unwrap_or_else(|| format!("Queued ({}) · see plugins machines for results", target.outbox_id.unwrap()))
                        );
                    }
                }
                failed |=
                    r.targets.iter().any(|t| t.error.is_some() || t.result.as_ref().is_some_and(|r| r.state == PluginInstallState::Failed));
            }
            if failed {
                bail!("Some plugins could not be installed; inspect the per-machine results");
            }
        }
    }
    Ok(())
}
