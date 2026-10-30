//! `kybern skills machines` and `kybern skills copy`: your user skills on every machine (ADE-86).

use std::collections::BTreeMap;

use anyhow::{Result, anyhow, bail};
use clap::Subcommand;
use kybern_client::Client;
use kybern_protocol::methods::*;
use kybern_protocol::*;

#[derive(Subcommand)]
pub enum SkillsCmd {
    /// List your user skills on every machine: who has each one, and whether the copies match.
    Machines {
        /// Only skills whose name or description contains this.
        #[arg(long)]
        filter: Option<String>,
    },
    /// Copy a skill to other machines (or to more harness folders). A machine that is offline gets it when it returns.
    Copy {
        /// The skill's folder name, as `kybern skills machines` lists it. Left out with `--missing`.
        name: Option<String>,
        /// The machines to copy it to: names or ids. `all` means every other machine.
        #[arg(long, required = true, num_args = 1.., value_delimiter = ',')]
        to: Vec<String>,
        /// The machine that sends it. This machine when left out.
        #[arg(long)]
        from: Option<String>,
        /// Which copy on the sending machine, when its copies differ (agents, claude, codex, cursor, opencode, pi, omp).
        #[arg(long)]
        from_home: Option<String>,
        /// The harness folders it goes to. The folders it is in on the sending machine when left out.
        #[arg(long = "home", value_delimiter = ',')]
        homes: Vec<String>,
        /// Replace a different version the target has. The old folder is kept in Kybern's data folder there.
        #[arg(long)]
        replace: bool,
        /// Copy every skill the target lacks, each from a machine that has it.
        #[arg(long, conflicts_with = "name")]
        missing: bool,
    },
}

fn home(value: &str) -> Result<SkillHome> {
    SkillHome::parse(value).ok_or_else(|| anyhow!("{value} is not a skill folder; use agents, claude, codex, cursor, opencode, pi or omp"))
}

fn short(hash: Option<&str>) -> String {
    hash.map(|hash| hash[..hash.len().min(8)].to_string()).unwrap_or_else(|| "-".into())
}

fn resolve<'a>(view: &'a SkillsNetworkView, query: &str) -> Result<&'a SkillsMachineView> {
    view.machines
        .iter()
        .find(|machine| machine.id == query)
        .or_else(|| view.machines.iter().find(|machine| machine.name.eq_ignore_ascii_case(query)))
        .ok_or_else(|| anyhow!("No machine called {query} in your network."))
}

pub async fn run(client: &Client, cmd: SkillsCmd, json: bool) -> Result<()> {
    match cmd {
        SkillsCmd::Machines { filter } => {
            let view = client.call::<SkillsNetworkViewMethod>(Empty {}).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&view)?);
                return Ok(());
            }
            let names: BTreeMap<&str, &str> = view.machines.iter().map(|machine| (machine.id.as_str(), machine.name.as_str())).collect();
            for machine in &view.machines {
                let state = match machine.state {
                    SkillsMachineState::Reported => "reported".to_string(),
                    SkillsMachineState::Offline => "offline".to_string(),
                    SkillsMachineState::Unsupported => "needs a newer Kybern".to_string(),
                    SkillsMachineState::Unreachable => format!("unreachable: {}", machine.detail.as_deref().unwrap_or("no answer")),
                };
                println!("{}{}  {state}", machine.name, if machine.is_self { " (this machine)" } else { "" });
            }
            println!();
            let needle = filter.map(|filter| filter.to_lowercase());
            for skill in &view.skills {
                if let Some(needle) = &needle
                    && !skill.name.to_lowercase().contains(needle)
                    && !skill.description.as_deref().unwrap_or("").to_lowercase().contains(needle)
                {
                    continue;
                }
                let status = if skill.differs { "differs" } else { "same" };
                println!("{:<32} {status}", skill.name);
                for on in &skill.machines {
                    let copies: Vec<String> = on
                        .copies
                        .iter()
                        .map(|copy| match copy.linked_to {
                            Some(target) => format!("{}→{}", copy.home, target),
                            None => format!("{} {}", copy.home, short(copy.hash.as_deref())),
                        })
                        .collect();
                    println!("    {:<20} {}", names.get(on.machine_id.as_str()).copied().unwrap_or(&on.machine_id), copies.join(", "));
                }
                let missing: Vec<&str> = view
                    .machines
                    .iter()
                    .filter(|machine| {
                        machine.state == SkillsMachineState::Reported && !skill.machines.iter().any(|on| on.machine_id == machine.id)
                    })
                    .map(|machine| machine.name.as_str())
                    .collect();
                if !missing.is_empty() {
                    println!("    missing on {}", missing.join(", "));
                }
                for pending in &skill.pending {
                    println!("    waiting for {}", names.get(pending.machine_id.as_str()).copied().unwrap_or(&pending.machine_id));
                }
            }
        }
        SkillsCmd::Copy { name, to, from, from_home, homes, replace, missing } => {
            let view = client.call::<SkillsNetworkViewMethod>(Empty {}).await?;
            let homes = homes.iter().map(|value| home(value)).collect::<Result<Vec<_>>>()?;
            let from_home = from_home.as_deref().map(home).transpose()?;
            let targets: Vec<&SkillsMachineView> = if to.iter().any(|target| target == "all") {
                let source = from.as_deref().map(|from| resolve(&view, from)).transpose()?.map(|machine| machine.id.clone());
                view.machines
                    .iter()
                    .filter(|machine| Some(&machine.id) != source.as_ref() && !(source.is_none() && machine.is_self))
                    .collect()
            } else {
                to.iter().map(|target| resolve(&view, target)).collect::<Result<_>>()?
            };
            // Which skills, and from where.
            let mut plans: Vec<(String, Option<String>, Vec<&SkillsMachineView>)> = Vec::new();
            if missing {
                for target in &targets {
                    for skill in view.skills.iter().filter(|skill| !skill.machines.iter().any(|on| on.machine_id == target.id)) {
                        let source = match &from {
                            Some(from) => {
                                Some(resolve(&view, from)?.id.clone()).filter(|id| skill.machines.iter().any(|on| &on.machine_id == id))
                            }
                            None if skill.differs => None,
                            None => skill.machines.first().map(|on| on.machine_id.clone()),
                        };
                        match source {
                            Some(source) => plans.push((skill.name.clone(), Some(source), vec![*target])),
                            None => eprintln!("skipped {}: its copies differ; copy it by name with --from", skill.name),
                        }
                    }
                }
            } else {
                let name = name.ok_or_else(|| anyhow!("Name a skill, or use --missing."))?;
                plans.push((name, from.clone(), targets.clone()));
            }
            if plans.is_empty() {
                println!("Nothing to copy: every machine has every skill.");
                return Ok(());
            }
            for (name, source, machines) in plans {
                let skill = view.skills.iter().find(|skill| skill.name == name);
                let to = machines
                    .iter()
                    .map(|machine| {
                        let theirs: Vec<String> = skill
                            .and_then(|skill| skill.machines.iter().find(|on| on.machine_id == machine.id))
                            .map(|on| on.copies.iter().filter_map(|copy| copy.hash.clone()).collect())
                            .unwrap_or_default();
                        SkillCopyTarget {
                            machine: machine.id.clone(),
                            homes: homes.clone(),
                            replaces: if replace { theirs } else { Vec::new() },
                        }
                    })
                    .collect();
                let result = client.call::<SkillsCopy>(SkillsCopyParams { name: name.clone(), from: source, from_home, to }).await?;
                if json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                    continue;
                }
                if !result.skipped.is_empty() {
                    println!("{name}: leaves out {}", result.skipped.join(", "));
                }
                for target in &result.targets {
                    let what = match target.state {
                        SkillCopyState::Queued => "queued (it lands when the machine is reachable)".to_string(),
                        SkillCopyState::Done => target
                            .placed
                            .iter()
                            .map(|placed| format!("{:?} {}", placed.action, placed.path).to_lowercase())
                            .collect::<Vec<_>>()
                            .join("; "),
                        SkillCopyState::Unsupported => "needs a newer Kybern".to_string(),
                        SkillCopyState::Failed => target.error.clone().unwrap_or_else(|| "failed".into()),
                    };
                    println!("{name} → {}: {what}", target.name);
                }
                if result.targets.iter().any(|target| target.state == SkillCopyState::Failed) && !replace {
                    bail!("Some machines keep a different version. Add --replace to copy over it (the old one is backed up there).");
                }
            }
        }
    }
    Ok(())
}
