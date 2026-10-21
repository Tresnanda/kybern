//! `kybern spaces` and the space flags of `kybern projects`.

use std::io::{IsTerminal, Write};

use anyhow::{Result, anyhow};
use clap::Subcommand;
use kybern_client::Client;
use kybern_protocol::methods::*;
use kybern_protocol::*;

#[derive(Subcommand)]
pub enum SpacesCmd {
    /// List spaces in rail order.
    List,
    /// Create a space.
    Create {
        name: String,
        /// blue, green, purple, pink, teal, amber, red or graphite. Defaults to the first colour no space uses.
        #[arg(long)]
        color: Option<String>,
        /// An icon slug from the app's set, such as briefcase or rocket. Defaults to the name's initials.
        #[arg(long)]
        icon: Option<String>,
    },
    /// Rename a space or change its colour or icon.
    Update {
        /// A space id or name.
        space: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        color: Option<String>,
        #[arg(long, conflicts_with = "initials")]
        icon: Option<String>,
        /// Draw the name's initials instead of an icon or image.
        #[arg(long)]
        initials: bool,
    },
    /// Delete a space. Its projects move to the space above it.
    Delete {
        /// A space id or name.
        space: String,
        /// Delete without asking.
        #[arg(long)]
        yes: bool,
    },
    /// Put the spaces in this order. List every space.
    Reorder {
        /// Space ids or names, in the new order.
        #[arg(required = true)]
        spaces: Vec<String>,
    },
}

/// Find a space by id, or by name ignoring case. An ambiguous or unknown key is an error.
pub fn resolve_space(spaces: &[Space], key: &str) -> Result<SpaceId> {
    let unknown = || anyhow!("No space named \"{key}\". Run kybern spaces list to see them.");
    if let Ok(id) = key.parse::<SpaceId>() {
        return spaces.iter().find(|space| space.id == id).map(|space| space.id).ok_or_else(unknown);
    }
    let exact: Vec<_> = spaces.iter().filter(|space| space.name == key).collect();
    if let [only] = exact.as_slice() {
        return Ok(only.id);
    }
    let lowered = key.to_lowercase();
    let loose: Vec<_> = spaces.iter().filter(|space| space.name.to_lowercase() == lowered).collect();
    match loose.as_slice() {
        [only] => Ok(only.id),
        _ => Err(unknown()),
    }
}

pub async fn list(client: &Client) -> Result<Vec<Space>> {
    Ok(client.call::<SpacesList>(Empty {}).await?.spaces)
}

fn parse_color(value: &str) -> Result<SpaceColor> {
    serde_json::from_value(serde_json::Value::String(value.to_lowercase()))
        .map_err(|_| anyhow!("Colors are blue, green, purple, pink, teal, amber, red and graphite."))
}

fn logo_text(logo: &SpaceLogo) -> String {
    match logo {
        SpaceLogo::Initials => "initials".into(),
        SpaceLogo::Icon { icon } => format!("icon:{icon}"),
        SpaceLogo::Image { .. } => "image".into(),
    }
}

pub fn render(spaces: &[Space], projects: &[Project]) {
    for space in spaces {
        let count = projects.iter().filter(|project| project.space_id == Some(space.id)).count();
        println!(
            "{}  {:<3} {:<20} {:<9} {:<18} {} project{}",
            space.id,
            space.position,
            space.name,
            space.color.as_str(),
            logo_text(&space.logo),
            count,
            if count == 1 { "" } else { "s" }
        );
    }
}

fn confirmed(prompt: &str) -> Result<bool> {
    eprint!("{prompt} [y/N] ");
    std::io::stderr().flush()?;
    let mut answer = String::new();
    std::io::stdin().read_line(&mut answer)?;
    Ok(matches!(answer.trim().to_lowercase().as_str(), "y" | "yes"))
}

pub async fn run(client: &Client, cmd: SpacesCmd, json: bool) -> Result<()> {
    match cmd {
        SpacesCmd::List => {
            let spaces = list(client).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&SpacesListResult { spaces })?);
            } else {
                let projects = client.call::<ProjectsList>(ProjectsListParams { refresh_git: Some(false) }).await?.projects;
                render(&spaces, &projects);
            }
        }
        SpacesCmd::Create { name, color, icon } => {
            let space = client
                .call::<SpacesCreate>(SpacesCreateParams {
                    name,
                    color: color.as_deref().map(parse_color).transpose()?,
                    logo: icon.map(|icon| SpaceLogo::Icon { icon }),
                })
                .await?;
            if json { println!("{}", serde_json::to_string_pretty(&space)?) } else { println!("{}  {}", space.id, space.name) }
        }
        SpacesCmd::Update { space, name, color, icon, initials } => {
            let space_id = resolve_space(&list(client).await?, &space)?;
            let updated = client
                .call::<SpacesUpdate>(SpacesUpdateParams {
                    space_id,
                    name,
                    color: color.as_deref().map(parse_color).transpose()?,
                    logo: if initials { Some(SpaceLogo::Initials) } else { icon.map(|icon| SpaceLogo::Icon { icon }) },
                })
                .await?;
            if json { println!("{}", serde_json::to_string_pretty(&updated)?) } else { println!("{}  {}", updated.id, updated.name) }
        }
        SpacesCmd::Delete { space, yes } => {
            let spaces = list(client).await?;
            let space_id = resolve_space(&spaces, &space)?;
            if !yes {
                if !std::io::stdin().is_terminal() {
                    return Err(anyhow!("Pass --yes to delete a space without a prompt."));
                }
                let projects = client.call::<ProjectsList>(ProjectsListParams { refresh_git: Some(false) }).await?.projects;
                let count = projects.iter().filter(|project| project.space_id == Some(space_id)).count();
                let name = spaces.iter().find(|s| s.id == space_id).map(|s| s.name.clone()).unwrap_or_default();
                let target = target_name(&spaces, space_id);
                if !confirmed(&format!("Delete \"{name}\"? Its {count} projects move to {target}."))? {
                    return Ok(());
                }
            }
            let result = client.call::<SpacesDelete>(SpacesDeleteParams { space_id }).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!("deleted; {} projects moved to {}", result.moved_projects, result.moved_to);
            }
        }
        SpacesCmd::Reorder { spaces } => {
            let existing = list(client).await?;
            let space_ids = spaces.iter().map(|key| resolve_space(&existing, key)).collect::<Result<Vec<_>>>()?;
            let result = client.call::<SpacesReorder>(SpacesReorderParams { space_ids }).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                let projects = client.call::<ProjectsList>(ProjectsListParams { refresh_git: Some(false) }).await?.projects;
                render(&result.spaces, &projects);
            }
        }
    }
    Ok(())
}

/// The name of the space a deleted space's projects move to (above it, or the next for the first).
fn target_name(spaces: &[Space], deleted: SpaceId) -> String {
    let index = spaces.iter().position(|space| space.id == deleted).unwrap_or(0);
    let target = if index == 0 { spaces.get(1) } else { spaces.get(index - 1) };
    target.map(|space| space.name.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use uuid::Uuid;

    fn space(name: &str) -> Space {
        let now = Utc::now();
        Space {
            id: Uuid::now_v7(),
            name: name.into(),
            color: SpaceColor::Blue,
            logo: SpaceLogo::Initials,
            position: 0,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn spaces_resolve_by_id_exact_name_and_loose_name() {
        let spaces = [space("Work"), space("Side projects"), space("work")];
        assert_eq!(resolve_space(&spaces, &spaces[1].id.to_string()).unwrap(), spaces[1].id);
        assert_eq!(resolve_space(&spaces, "Side projects").unwrap(), spaces[1].id);
        assert_eq!(resolve_space(&spaces, "SIDE PROJECTS").unwrap(), spaces[1].id);
        // An exact name beats a case-insensitive twin.
        assert_eq!(resolve_space(&spaces, "Work").unwrap(), spaces[0].id);
        assert_eq!(resolve_space(&spaces, "work").unwrap(), spaces[2].id);
        // "WORK" matches two names ignoring case: ambiguous.
        let ambiguous = resolve_space(&spaces, "WORK").unwrap_err().to_string();
        assert_eq!(ambiguous, "No space named \"WORK\". Run kybern spaces list to see them.");
        assert!(resolve_space(&spaces, "Nope").is_err());
        assert!(resolve_space(&spaces, &Uuid::now_v7().to_string()).is_err());
    }

    #[test]
    fn colors_parse_in_any_case_and_reject_others() {
        assert_eq!(parse_color("Amber").unwrap(), SpaceColor::Amber);
        assert!(parse_color("chartreuse").is_err());
    }

    #[test]
    fn delete_targets_the_space_above_or_the_next() {
        let spaces = [space("A"), space("B"), space("C")];
        assert_eq!(target_name(&spaces, spaces[0].id), "B");
        assert_eq!(target_name(&spaces, spaces[2].id), "B");
        assert_eq!(target_name(&spaces, spaces[1].id), "A");
    }
}
